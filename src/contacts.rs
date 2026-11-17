//! Contact photos from iCloud Contacts (CardDAV at contacts.icloud.com).
//!
//! Signs in with the same iCloud address + app-specific password, downloads the
//! vCards, and keeps a small rounded-square-ready thumbnail per email address on
//! disk (`%APPDATA%\PearMail\contact-photos-<account>.json`).

use anyhow::{bail, Context, Result};
use base64::Engine;
use reqwest::{Client, Method};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

const ROOT: &str = "https://contacts.icloud.com/";
/// Thumbnail edge in pixels (shown at up to ~48 CSS px on high-DPI screens).
const THUMB: u32 = 128;

pub type PhotoMap = HashMap<String, String>;

fn store_path(account: &str) -> PathBuf {
    let safe: String = account.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '@' { c } else { '_' }).collect();
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("PearMail").join(format!("contact-photos-{safe}.json"))
}

pub fn load(account: &str) -> PhotoMap {
    std::fs::read_to_string(store_path(account)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save(account: &str, map: &PhotoMap) {
    let p = store_path(account);
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(s) = serde_json::to_string(map) {
        let _ = std::fs::write(p, s);
    }
}

pub fn clear(account: &str) {
    let _ = std::fs::remove_file(store_path(account));
}

// ---------------------------------------------------------------- XML helpers

fn unescape(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("<![CDATA[").and_then(|x| x.strip_suffix("]]>")).unwrap_or(s);
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';') else { break };
        let ent = &rest[1..end];
        let rep = match ent {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if ent.starts_with("#x") || ent.starts_with("#X") => u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32),
            _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match rep {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Text contents of every element with the given local name (any namespace prefix).
pub(crate) fn elements(xml: &str, local: &str) -> Vec<String> {
    let mut out = vec![];
    let mut pos = 0;
    while let Some(off) = xml[pos..].find('<') {
        let start = pos + off;
        let tag_end = match xml[start..].find('>') {
            Some(e) => start + e,
            None => break,
        };
        let tag = &xml[start + 1..tag_end];
        pos = tag_end + 1;
        if tag.starts_with('/') || tag.starts_with('?') || tag.starts_with('!') {
            continue;
        }
        let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        let lname = name.rsplit(':').next().unwrap_or(name);
        if !lname.eq_ignore_ascii_case(local) {
            continue;
        }
        if tag.ends_with('/') {
            out.push(String::new());
            continue;
        }
        let close = format!("</{name}>");
        if let Some(c) = xml[pos..].find(&close) {
            out.push(unescape(&xml[pos..pos + c]));
            pos += c + close.len();
        }
    }
    out
}

/// (href, inner xml) for each <response> in a multistatus document.
fn responses(xml: &str) -> Vec<(String, String)> {
    elements_raw(xml, "response")
        .into_iter()
        .map(|r| (elements(&r, "href").into_iter().next().unwrap_or_default(), r))
        .collect()
}

/// Like `elements`, but returns the raw inner XML (not unescaped).
pub(crate) fn elements_raw(xml: &str, local: &str) -> Vec<String> {
    let mut out = vec![];
    let mut pos = 0;
    while let Some(off) = xml[pos..].find('<') {
        let start = pos + off;
        let Some(e) = xml[start..].find('>') else { break };
        let tag_end = start + e;
        let tag = &xml[start + 1..tag_end];
        pos = tag_end + 1;
        if tag.starts_with('/') {
            continue;
        }
        let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        if !name.rsplit(':').next().unwrap_or(name).eq_ignore_ascii_case(local) {
            continue;
        }
        let close = format!("</{name}>");
        if let Some(c) = xml[pos..].find(&close) {
            out.push(xml[pos..pos + c].to_string());
            pos += c + close.len();
        }
    }
    out
}

// ---------------------------------------------------------------- vCard

#[derive(Debug, Default, PartialEq)]
pub struct Card {
    pub emails: Vec<String>,
    /// Inline photo bytes, or a URL to fetch.
    pub photo: Option<PhotoSrc>,
}

#[derive(Debug, PartialEq)]
pub enum PhotoSrc {
    Inline(Vec<u8>),
    Url(String),
}

pub fn parse_vcard(text: &str) -> Card {
    // Unfold continuation lines (RFC 6350 §3.2).
    let unfolded = text.replace("\r\n ", "").replace("\r\n\t", "").replace("\n ", "").replace("\n\t", "");
    let mut card = Card::default();
    for line in unfolded.lines() {
        let Some((head, value)) = line.split_once(':') else { continue };
        let mut parts = head.split(';');
        let prop = parts.next().unwrap_or("");
        // Strip group prefix like "item1.EMAIL".
        let prop = prop.rsplit('.').next().unwrap_or(prop).to_ascii_uppercase();
        let params: Vec<String> = parts.map(|p| p.to_ascii_uppercase()).collect();
        match prop.as_str() {
            "EMAIL" => {
                let e = value.trim().trim_start_matches("mailto:").to_lowercase();
                if e.contains('@') {
                    card.emails.push(e);
                }
            }
            "PHOTO" if card.photo.is_none() => {
                let v = value.trim();
                let b64 = params.iter().any(|p| p == "ENCODING=B" || p == "ENCODING=BASE64");
                if let Some(rest) = v.strip_prefix("data:") {
                    if let Some((_, data)) = rest.split_once("base64,") {
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data.trim()) {
                            card.photo = Some(PhotoSrc::Inline(bytes));
                        }
                    }
                } else if b64 || !v.starts_with("http") {
                    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(v.replace(' ', "")) {
                        card.photo = Some(PhotoSrc::Inline(bytes));
                    }
                } else {
                    card.photo = Some(PhotoSrc::Url(v.to_string()));
                }
            }
            _ => {}
        }
    }
    // Note: `split_once(':')` splits "PHOTO;VALUE=uri:https://..." after the params, so
    // URL values arrive intact.
    card
}

/// Square, centered, scaled thumbnail as a JPEG data URL.
fn thumbnail(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let side = img.width().min(img.height());
    let x = (img.width() - side) / 2;
    let y = (img.height() - side) / 2;
    let sq = img.crop_imm(x, y, side, side).resize_exact(THUMB, THUMB, image::imageops::FilterType::Lanczos3);
    let mut out = std::io::Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86).encode_image(&sq.to_rgb8()).ok()?;
    Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(out.into_inner())))
}

// ---------------------------------------------------------------- CardDAV

struct Dav {
    http: Client,
    email: String,
    password: String,
}

impl Dav {
    async fn call(&self, method: &str, url: &str, depth: &str, body: &str) -> Result<String> {
        let res = self
            .http
            .request(Method::from_bytes(method.as_bytes())?, url)
            .basic_auth(&self.email, Some(&self.password))
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body.to_string())
            .send()
            .await
            .with_context(|| format!("{method} {url}"))?;
        let status = res.status();
        if status.as_u16() == 401 {
            bail!("iCloud Contacts rejected the app-specific password");
        }
        if !status.is_success() {
            bail!("{method} {url}: HTTP {status}");
        }
        Ok(res.text().await?)
    }

    fn absolute(base: &str, href: &str) -> String {
        if href.starts_with("http") {
            return href.to_string();
        }
        let origin_end = base.find("://").map(|i| i + 3).and_then(|i| base[i..].find('/').map(|j| i + j)).unwrap_or(base.len());
        format!("{}{}", &base[..origin_end], href)
    }
}

/// Stats from a sync (for diagnostics; no personal data).
#[derive(Debug, Default)]
pub struct SyncStats {
    pub cards: usize,
    pub with_photo: usize,
    pub emails_with_photo: usize,
}

/// Download all contacts and rebuild the email -> photo thumbnail map.
pub async fn sync(email: &str, password: &str) -> Result<(PhotoMap, SyncStats)> {
    let dav = Dav {
        http: Client::builder().timeout(Duration::from_secs(60)).user_agent("PearMail/0.1 (CardDAV)").build()?,
        email: email.to_string(),
        password: password.to_string(),
    };
    // 1. Principal.
    let xml = dav
        .call("PROPFIND", ROOT, "0", r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#)
        .await?;
    let principal = elements_raw(&xml, "current-user-principal")
        .first()
        .and_then(|p| elements(p, "href").into_iter().next())
        .context("no CardDAV principal")?;
    let principal = Dav::absolute(ROOT, &principal);
    // 2. Address book home (often on a different host, e.g. p42-contacts.icloud.com).
    let xml = dav
        .call(
            "PROPFIND",
            &principal,
            "0",
            r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:addressbook-home-set/></d:prop></d:propfind>"#,
        )
        .await?;
    let home = elements_raw(&xml, "addressbook-home-set")
        .first()
        .and_then(|p| elements(p, "href").into_iter().next())
        .context("no address book home")?;
    let home = Dav::absolute(&principal, &home);
    // 3. Address books.
    let xml = dav
        .call("PROPFIND", &home, "1", r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>"#)
        .await?;
    let books: Vec<String> = responses(&xml)
        .into_iter()
        .filter(|(_, r)| r.contains("addressbook"))
        .map(|(h, _)| Dav::absolute(&home, &h))
        .collect();
    // 4. All vCards.
    let mut map = PhotoMap::new();
    let mut stats = SyncStats::default();
    for book in books {
        let xml = dav
            .call(
                "REPORT",
                &book,
                "1",
                r#"<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>"#,
            )
            .await?;
        for vcard in elements(&xml, "address-data") {
            stats.cards += 1;
            let card = parse_vcard(&vcard);
            if card.emails.is_empty() {
                continue;
            }
            let bytes = match card.photo {
                Some(PhotoSrc::Inline(b)) => Some(b),
                Some(PhotoSrc::Url(u)) => {
                    let r = dav.http.get(&u).basic_auth(email, Some(password)).send().await;
                    match r {
                        Ok(r) if r.status().is_success() => r.bytes().await.ok().map(|b| b.to_vec()),
                        _ => None,
                    }
                }
                None => None,
            };
            let Some(bytes) = bytes else { continue };
            let Some(thumb) = tauri::async_runtime::spawn_blocking(move || thumbnail(&bytes)).await.ok().flatten() else { continue };
            stats.with_photo += 1;
            for e in card.emails {
                stats.emails_with_photo += 1;
                map.insert(e, thumb.clone());
            }
        }
    }
    save(email, &map);
    Ok((map, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_vcards() {
        let v = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane Doe\r\nitem1.EMAIL;type=INTERNET;type=pref:Jane@Example.com\r\nEMAIL;type=WORK:jd@work.org\r\nPHOTO;ENCODING=b;TYPE=JPEG:aGVs\r\n bG8=\r\nEND:VCARD\r\n";
        let c = parse_vcard(v);
        assert_eq!(c.emails, vec!["jane@example.com", "jd@work.org"]);
        assert_eq!(c.photo, Some(PhotoSrc::Inline(b"hello".to_vec())));
        let u = parse_vcard("BEGIN:VCARD\nEMAIL:a@b.c\nPHOTO;VALUE=uri:https://p1-contacts.icloud.com/x/photo\nEND:VCARD\n");
        assert_eq!(u.photo, Some(PhotoSrc::Url("https://p1-contacts.icloud.com/x/photo".into())));
        let d = parse_vcard("BEGIN:VCARD\nEMAIL:a@b.c\nPHOTO:data:image/png;base64,aGk=\nEND:VCARD\n");
        assert_eq!(d.photo, Some(PhotoSrc::Inline(b"hi".to_vec())));
    }

    #[test]
    fn extracts_multistatus() {
        let xml = r#"<?xml version="1.0"?><multistatus xmlns="DAV:"><response><href>/1/carddavhome/card/</href><propstat><prop><resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype></prop></propstat></response><response><href>/1/carddavhome/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response></multistatus>"#;
        let r = responses(xml);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].0, "/1/carddavhome/card/");
        assert!(r[0].1.contains("addressbook"));
        assert_eq!(elements("<C:address-data>A&amp;B&#13;</C:address-data>", "address-data"), vec!["A&B\r"]);
        assert_eq!(Dav::absolute("https://p1-contacts.icloud.com:443/1/principal/", "/1/carddavhome/"), "https://p1-contacts.icloud.com:443/1/carddavhome/");
    }
}
