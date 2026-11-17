//! MIME parsing / HTML sanitising helpers built on `mail-parser` and `ammonia`.

use crate::model::{AttachmentInfo, Person};
use base64::Engine;
use mail_parser::{Address, HeaderValue, Message, MessageParser, MimeHeaders};
use std::collections::HashMap;

pub fn parse(raw: &[u8]) -> Option<Message<'_>> {
    MessageParser::default().parse(raw)
}

pub fn people(addr: Option<&Address>) -> Vec<Person> {
    addr.map(|a| {
        a.iter()
            .map(|x| Person {
                name: x.name().unwrap_or_default().trim().trim_matches('"').to_string(),
                email: x.address().unwrap_or_default().to_string(),
            })
            .filter(|p| !p.email.is_empty() || !p.name.is_empty())
            .collect()
    })
    .unwrap_or_default()
}

pub fn first_person(addr: Option<&Address>) -> Person {
    people(addr).into_iter().next().unwrap_or(Person { name: String::new(), email: String::new() })
}

pub fn header_list(v: &HeaderValue) -> Vec<String> {
    match v {
        HeaderValue::Text(t) => vec![t.to_string()],
        HeaderValue::TextList(l) => l.iter().map(|s| s.to_string()).collect(),
        _ => vec![],
    }
}

/// Threading ids of a message: (Message-ID, In-Reply-To, References), bare (no angle brackets).
pub fn thread_ids(msg: &Message) -> (String, String, Vec<String>) {
    let clean = |s: &str| s.trim().trim_matches(|c| c == '<' || c == '>').trim().to_string();
    let mid = msg.message_id().map(clean).unwrap_or_default();
    let irt = header_list(msg.in_reply_to()).first().map(|s| clean(s)).unwrap_or_default();
    let refs = header_list(msg.references()).iter().map(|s| clean(s)).filter(|s| !s.is_empty()).collect();
    (mid, irt, refs)
}

pub fn date_ms(msg: &Message) -> Option<i64> {
    msg.date().map(|d| d.to_timestamp() * 1000)
}

/// The list preview: the first lines a person would read, without logos, links,
/// tracking spacers or quoted history. Taken from the HTML part when there is one
/// (plain-text parts made from HTML are full of "Logo [https://…]" leftovers).
pub fn preview_of(msg: &Message) -> String {
    let mut html = html_source(msg);
    let mut text = if text_is_real(msg) { msg.body_text(0).map(|t| unb64(t.into_owned())).unwrap_or_default() } else { String::new() };
    // Some senders put their HTML page in the text/plain part too (and the real HTML part
    // came after what the summary download got): read it as HTML.
    // (Also when only the start of the real HTML part was downloaded.)
    if let Some(t) = msg.body_text(0).map(|t| unb64(t.into_owned())).filter(|t| looks_html(t)) {
        if html.as_ref().map_or(true, |h| h.len() < t.len()) {
            text.clear();
            html = Some(if looks_qp(&t) { qp_decode(&t) } else { t });
        }
    }
    // First the message's own words; then, if that's nothing, quoted history (a bare
    // forward); finally links too (a message that is just a link shows the link).
    for (keep_quotes, keep_links) in [(false, false), (true, false), (true, true)] {
        let from_html = html.as_deref().map(|h| clean_preview(&html_to_text(h, keep_quotes), keep_quotes, keep_links)).unwrap_or_default();
        if from_html.chars().count() >= 12 {
            return from_html;
        }
        let from_text = clean_preview(&decode_entities(&strip_text_links(&text)), keep_quotes, keep_links);
        if !from_text.is_empty() {
            return from_text;
        }
        if !from_html.is_empty() {
            return from_html; // a picture email with just a word or two
        }
    }
    // Nothing usable in the HTML or text parts: what mail-parser makes of the body.
    let any = msg.body_text(0).map(|t| t.into_owned()).unwrap_or_default();
    clean_preview(&strip_text_links(&any), true, true)
}

/// Is the first text body a real text/plain part (not text mail-parser made from HTML)?
fn text_is_real(msg: &Message) -> bool {
    msg.text_body.first().and_then(|&i| msg.parts.get(i as usize)).map(|p| part_mime(p) == "text/plain").unwrap_or(false)
}

/// The message's HTML, also when the summary download cut its part off: the regular
/// HTML body, else any text/html part, else the raw text after the last text/html
/// part header. Quoted-printable that came back undecoded is decoded.
fn html_source(msg: &Message) -> Option<String> {
    let real = msg.html_body.first().and_then(|&i| msg.parts.get(i as usize)).map(|p| part_mime(p) == "text/html").unwrap_or(false);
    let found = if real {
        msg.body_html(0).map(|h| h.into_owned())
    } else if let Some(p) = msg.parts.iter().find(|p| part_mime(p) == "text/html") {
        p.text_contents().map(str::to_string)
    } else {
        raw_html_tail(&msg.raw_message)
    };
    found.filter(|h| !h.trim().is_empty()).map(unb64).map(|h| if looks_qp(&h) { qp_decode(&h) } else { h })
}

/// A part the summary download cut off mid-base64 comes back undecoded (mail-parser
/// can't decode a partial stream): decode what's there.
fn unb64(s: String) -> String {
    if looks_b64(&s) { b64_lenient(&s).unwrap_or(s) } else { s }
}

/// Text that is an HTML page (starts with a doctype or <html> tag).
pub fn looks_html(s: &str) -> bool {
    let head: String = s.trim_start().chars().take(14).collect::<String>().to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

/// Text that is still base64: only base64 characters (and line breaks), no markup.
pub fn looks_b64(s: &str) -> bool {
    let mut n = 0;
    for c in s.chars() {
        if c.is_whitespace() { continue; }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=') { return false; }
        n += 1;
    }
    n >= 40
}

/// Decode base64 up to the last complete 4-character group (the rest was cut off).
fn b64_lenient(s: &str) -> Option<String> {
    let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let clean = clean.trim_end_matches('=');
    let usable = clean.len() / 4 * 4;
    let mut bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(&clean[..usable]).ok()?;
    // Also the 2-3 trailing characters of a group, when they decode.
    if let Ok(tail) = base64::engine::general_purpose::STANDARD_NO_PAD.decode(&clean[usable..]) { bytes.extend(tail); }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// HTML that is still quoted-printable encoded (soft line breaks, encoded "=" in attributes).
fn looks_qp(s: &str) -> bool {
    s.contains("=3D\"") || s.contains("=3D'") || s.contains("=3d\"") || (s.contains("=\r\n") && s.contains("=3D"))
}

/// The body of the last text/html part in raw message bytes (which may be cut off).
fn raw_html_tail(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    let lower = text.to_ascii_lowercase(); // same byte offsets as `text`
    let at = lower.rfind("content-type: text/html").or_else(|| lower.rfind("content-type:text/html"))?;
    let body_start = lower[at..].find("\r\n\r\n").map(|e| at + e + 4).or_else(|| lower[at..].find("\n\n").map(|e| at + e + 2))?;
    let headers = &lower[at..body_start];
    let mut body = text[body_start..].to_string();
    if let Some(end) = body.find("\r\n--").or_else(|| body.find("\n--")) {
        body.truncate(end);
    }
    if headers.contains("quoted-printable") {
        body = qp_decode(&body);
    } else if headers.contains("base64") {
        body = b64_lenient(&body)?;
    }
    Some(body)
}

/// Readable text of an email's HTML: no head/styles/scripts/images, no quoted history,
/// blocks on their own lines, entities decoded.
fn html_to_text(html: &str, keep_quotes: bool) -> String {
    use lol_html::html_content::ContentType;
    use lol_html::{element, rewrite_str, RewriteStrSettings};
    // Not "head" as a whole: a head the download cut off before its end would swallow everything.
    const MEDIA: &str = "title, style, script, noscript, img, svg, picture, video, audio, meta, link";
    const QUOTES: &str = "title, style, script, noscript, img, svg, picture, video, audio, meta, link, blockquote, .gmail_quote, #divRplyFwdMsg, #appendonsend, .yahoo_quoted, .moz-cite-prefix";
    let drop = if keep_quotes { MEDIA } else { QUOTES };
    const BLOCKS: &str = "p, div, br, tr, li, h1, h2, h3, h4, h5, h6, table, td, th, ul, ol, section, article, header, footer, hr";
    let stripped = rewrite_str(
        html,
        RewriteStrSettings::new()
            .append_element_content_handler(element!(drop, |el| {
                el.remove();
                Ok(())
            }))
            .append_element_content_handler(element!(BLOCKS, |el| {
                if !el.removed() {
                    el.before("\n", ContentType::Text);
                    if el.can_have_content() {
                        el.after("\n", ContentType::Text);
                    }
                }
                Ok(())
            })),
    )
    .unwrap_or_else(|_| html.to_string());
    // Style and script blocks left over (unparseable HTML) aren't text either.
    let stripped = drop_blocks(&drop_blocks(&stripped, "style"), "script");
    // Remove the remaining tags and comments.
    let mut out = String::with_capacity(stripped.len() / 2);
    let mut rest = stripped.as_str();
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = if rest.starts_with("<!--") { rest.find("-->").map(|e| e + 3) } else { rest.find('>').map(|e| e + 1) };
        match end {
            Some(e) => rest = &rest[e..],
            None => { rest = ""; }
        }
    }
    out.push_str(rest);
    decode_entities(&out)
}

/// Remove every <tag …>…</tag> block (case-insensitive); an unclosed one runs to the end.
fn drop_blocks(s: &str, tag: &str) -> String {
    let lower = s.to_ascii_lowercase(); // same byte offsets as `s`
    let (open, close) = (format!("<{tag}"), format!("</{tag}>"));
    let mut out = String::with_capacity(s.len());
    let mut pos = 0;
    while let Some(i) = lower[pos..].find(&open).map(|i| pos + i) {
        out.push_str(&s[pos..i]);
        pos = lower[i..].find(&close).map(|e| i + e + close.len()).unwrap_or(s.len());
    }
    out.push_str(&s[pos..]);
    out
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // An entity is short: look for its ';' within the next few characters (not bytes,
        // so a multi-byte character right after the '&' can't be cut in half).
        let semi = rest.char_indices().take(12).find(|&(_, c)| c == ';').map(|(i, _)| i);
        let decoded = semi.and_then(|e| {
            let name = &rest[1..e];
            let ch = if let Some(num) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(num, 16).ok().and_then(char::from_u32)
            } else if let Some(num) = name.strip_prefix('#') {
                num.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                match name {
                    "nbsp" | "ensp" | "emsp" | "thinsp" => Some(' '),
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "lsquo" => Some('\u{2018}'),
                    "rsquo" => Some('\u{2019}'),
                    "ldquo" => Some('\u{201c}'),
                    "rdquo" => Some('\u{201d}'),
                    "ndash" => Some('\u{2013}'),
                    "mdash" => Some('\u{2014}'),
                    "hellip" => Some('\u{2026}'),
                    "bull" => Some('\u{2022}'),
                    "middot" => Some('\u{b7}'),
                    "copy" => Some('\u{a9}'),
                    "reg" => Some('\u{ae}'),
                    "trade" => Some('\u{2122}'),
                    "euro" => Some('\u{20ac}'),
                    "pound" => Some('\u{a3}'),
                    "zwnj" | "zwj" | "shy" => Some('\u{200c}'),
                    _ => None,
                }
            };
            ch.map(|c| (c, e + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
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

/// Plain text made from HTML: drop "[https://…]" / "<https://…>" link leftovers,
/// "[image: …]" placeholders, and short labels that belonged to those links
/// ("Jira logo", "View online").
fn strip_text_links(text: &str) -> String {
    // A part cut off by the summary download comes back still quoted-printable encoded.
    let decoded;
    let text = if text.contains("=\r\n") || text.contains("=\n") || text.contains("=3D") {
        decoded = qp_decode(text);
        decoded.as_str()
    } else {
        text
    };
    let short_label = |s: &str| {
        let words = s.split_whitespace().count();
        (1..=3).contains(&words) && !s.trim_end().ends_with(['.', '!', '?', ':', ','])
    };
    let mut lines: Vec<String> = Vec::new();
    for line in text.lines() {
        let (kept, removed) = drop_links(line);
        if removed {
            let rest = kept.trim();
            if rest.is_empty() {
                // Link on its own line: a short line just before it was its label.
                if let Some(prev) = lines.iter().rposition(|l| !l.trim().is_empty()) {
                    if prev == lines.len() - 1 && short_label(&lines[prev]) {
                        lines.pop();
                    }
                }
                continue;
            }
            if short_label(rest) {
                continue; // "Jira logo [https://…]"
            }
        }
        lines.push(kept);
    }
    lines.join("\n")
}

/// Remove link-like bracketed parts from one line. Returns (line, whether any were removed).
fn drop_links(line: &str) -> (String, bool) {
    let mut out = String::with_capacity(line.len());
    let mut removed = false;
    let mut rest = line;
    while let Some(i) = rest.find(['[', '<']) {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let close = if rest.starts_with('[') { ']' } else { '>' };
        let drop = rest[1..].find(close).map(|e| e + 1).and_then(|e| {
            let inner = rest[1..e].trim().to_lowercase();
            let junk = inner.starts_with("http") || inner.starts_with("mailto:") || inner.starts_with("cid:") || inner.starts_with("image:") || inner.starts_with("www.");
            junk.then_some(e + 1)
        });
        match drop {
            Some(len) => {
                rest = &rest[len..];
                removed = true;
            }
            None => {
                out.push_str(&rest[..1]);
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    (out, removed)
}

/// Decode quoted-printable text (soft line breaks and =XX bytes, as UTF-8).
fn qp_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'=' {
            if b.get(i + 1) == Some(&b'\r') && b.get(i + 2) == Some(&b'\n') {
                i += 3;
                continue;
            }
            if b.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (b.get(i + 1).and_then(|&c| hex(c)), b.get(i + 2).and_then(|&c| hex(c))) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Collapse a text into one preview line: skip quotes, signatures, bare links,
/// invisible spacers and lines of only punctuation; at most 240 characters.
fn clean_preview(text: &str, keep_quotes: bool, keep_links: bool) -> String {
    let invisible = |c: char| matches!(c, '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}' | '\u{ad}' | '\u{34f}' | '\u{180e}');
    let mut out = String::with_capacity(300);
    for line in text.lines() {
        let line: String = line.chars().filter(|c| !invisible(*c)).map(|c| if c.is_whitespace() { ' ' } else { c }).collect();
        let l = line.trim();
        if l == "--" || l == "-- " {
            break; // signature
        }
        if l.starts_with('>') && !keep_quotes {
            continue;
        }
        let l = l.trim_start_matches(['>', ' ']);
        if l.is_empty() || !l.chars().any(|c| c.is_alphanumeric()) {
            continue;
        }
        let words: Vec<&str> = l
            .split_whitespace()
            .filter(|w| {
                let w = w.to_lowercase();
                keep_links || !(w.starts_with("http://") || w.starts_with("https://") || w.starts_with("www.") || w.starts_with("mailto:"))
            })
            .collect();
        if words.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&words.join(" "));
        if out.len() > 400 {
            break;
        }
    }
    let cut: String = out.chars().take(240).collect();
    // Never end on half an entity ("&zw…") or a lone "&".
    let cut = match cut.rfind('&') { Some(i) if !cut[i..].contains([';', ' ']) => cut[..i].to_string(), _ => cut };
    cut.trim().to_string()
}

fn part_mime(a: &mail_parser::MessagePart) -> String {
    a.content_type()
        .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("octet-stream")).to_lowercase())
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// Image types the WebView can display natively.
pub fn web_renderable(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/jpg" | "image/pjpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/svg+xml" | "image/x-icon" | "image/vnd.microsoft.icon" | "image/avif"
    )
}

/// Images we can decode in Rust (to convert or thumbnail).
pub fn decodable_image(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/jpg" | "image/pjpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/tiff" | "image/tif" | "image/x-tiff")
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/tiff" | "image/tif" | "image/x-tiff" => "tif",
        "image/png" => "png",
        "image/jpeg" | "image/jpg" | "image/pjpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/calendar" => "ics",
        _ => "",
    }
}

fn display_name(a: &mail_parser::MessagePart, i: usize, mime: &str) -> String {
    let mut name = a.attachment_name().map(|s| s.to_string()).unwrap_or_else(|| {
        if mime.starts_with("image/") { format!("Image {}", i + 1) } else { format!("Attachment {}", i + 1) }
    });
    let ext = ext_for(mime);
    if !ext.is_empty() && !name.contains('.') {
        name.push('.');
        name.push_str(ext);
    }
    name
}

/// Decode a header value that may hold RFC 2047 encoded words (=?utf-8?...?=).
pub fn decode_header_text(s: &str) -> String {
    if !s.contains("=?") {
        return s.to_string();
    }
    let raw = format!("Subject: {s}\r\n\r\n");
    parse(raw.as_bytes()).and_then(|m| m.subject().map(|x| x.to_string())).unwrap_or_else(|| s.to_string())
}

/// How an attachment can be previewed in the app. Generic types (octet-stream, which
/// many senders use for PDFs) are judged by the file extension.
pub fn preview_kind(mime: &str, name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let by_ext = || -> &'static str {
        match ext.as_str() {
            "pdf" => "pdf",
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" => "image",
            "htm" | "html" => "html",
            "mp4" | "m4v" | "webm" | "mov" => "video",
            "mp3" | "m4a" | "aac" | "wav" | "ogg" | "oga" | "opus" | "flac" => "audio",
            "txt" | "text" | "log" | "csv" | "tsv" | "md" | "json" | "xml" | "yaml" | "yml" | "ini" | "cfg" | "conf" | "ics" | "vcf" | "eml"
            | "js" | "mjs" | "ts" | "css" | "py" | "rs" | "java" | "c" | "h" | "cpp" | "cs" | "go" | "rb" | "php" | "sh" | "ps1" | "bat" | "sql" | "toml" => "text",
            _ => "none",
        }
    };
    match mime {
        "application/pdf" | "application/x-pdf" => "pdf",
        "text/html" => "html",
        m if decodable_image(m) || web_renderable(m) => "image",
        m if m.starts_with("video/") => "video",
        m if m.starts_with("audio/") => "audio",
        m if m.starts_with("text/") || matches!(m, "application/json" | "application/xml" | "message/rfc822") => "text",
        _ => by_ext(),
    }
}

/// Attachments of a message of which only the first `raw_len` bytes were downloaded
/// (list summaries). A part that runs to the end of the data is unfinished: body text
/// cut off there can look like an unnamed attachment, so an unfinished text part only
/// counts when its headers name a file or mark it as an attachment. Other unfinished
/// parts (images, PDFs, ...) are real attachments whose data is still to come.
pub fn attachments_partial(msg: &Message, raw_len: usize) -> Vec<AttachmentInfo> {
    let parts: Vec<_> = msg.attachments().collect();
    attachments(msg)
        .into_iter()
        .filter(|info| {
            let Some(a) = parts.get(info.index) else { return false };
            let unfinished = a.offset_end as usize + 2 >= raw_len;
            let declared = a.attachment_name().is_some()
                || a.content_disposition().map(|d| d.ctype().eq_ignore_ascii_case("attachment")).unwrap_or(false);
            !unfinished || declared || !info.mime.starts_with("text/")
        })
        .collect()
}

pub fn attachments(msg: &Message) -> Vec<AttachmentInfo> {
    msg.attachments()
        .enumerate()
        .filter(|(_, a)| {
            // Inline images shown in the body are hidden from the list, unless the
            // WebView can't display them natively (e.g. TIFF), like Outlook.
            let inline = a.content_disposition().map(|d| d.ctype().eq_ignore_ascii_case("inline")).unwrap_or(false);
            !(inline && a.content_id().is_some() && web_renderable(&part_mime(a)))
        })
        .map(|(i, a)| {
            let mime = part_mime(a);
            let name = display_name(a, i, &mime);
            AttachmentInfo { index: i, kind: preview_kind(&mime, &name), size: a.contents().len(), name, mime }
        })
        .collect()
}

/// (file name, mime, bytes) of attachment `index`.
pub fn attachment_bytes(msg: &Message, index: usize) -> Option<(String, String, Vec<u8>)> {
    let a = msg.attachments().nth(index)?;
    let mime = part_mime(a);
    Some((display_name(a, index, &mime), mime, a.contents().to_vec()))
}

/// Decode an image and re-encode it as PNG, scaled down to fit `max` pixels if given.
pub fn image_to_png(bytes: &[u8], max: Option<u32>) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = match max {
        Some(m) if img.width() > m || img.height() > m => img.thumbnail(m, m),
        _ => img,
    };
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).ok()?;
    Some(out.into_inner())
}

const TRANSPARENT_GIF: &str = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/// Encode a preview: JPEG for opaque images (small, fast), PNG when there is transparency.
pub fn image_preview(bytes: &[u8], max: u32) -> Option<(&'static str, Vec<u8>)> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = if img.width() > max || img.height() > max { img.thumbnail(max, max) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    if img.color().has_alpha() {
        img.write_to(&mut out, image::ImageFormat::Png).ok()?;
        Some(("image/png", out.into_inner()))
    } else {
        let rgb = img.to_rgb8();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88).encode_image(&rgb).ok()?;
        Some(("image/jpeg", out.into_inner()))
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Plain text to HTML with clickable links and quote styling.
pub fn text_to_html(text: &str) -> String {
    let mut out = String::from("<div class=\"pm-plain\">");
    for line in text.lines() {
        let quoted = line.trim_start().starts_with('>');
        let mut l = String::new();
        for (i, word) in line.split(' ').enumerate() {
            if i > 0 {
                l.push(' ');
            }
            if word.starts_with("http://") || word.starts_with("https://") {
                let e = escape(word);
                l.push_str(&format!("<a href=\"{e}\">{e}</a>"));
            } else {
                l.push_str(&escape(word));
            }
        }
        if quoted {
            out.push_str(&format!("<span class=\"pm-quote\">{l}</span><br>"));
        } else {
            out.push_str(&l);
            out.push_str("<br>");
        }
    }
    out.push_str("</div>");
    out
}

/// Make email HTML safe while keeping its original markup and styling intact
/// (Outlook-style fidelity). It is additionally rendered in a sandboxed,
/// script-less iframe with a strict CSP. Inline `cid:` images become data URLs.
/// Returns (html, has_remote_content).
pub fn sanitize_html(html: &str, msg: &Message) -> (String, bool) {
    use lol_html::{element, rewrite_str, RewriteStrSettings};
    use std::cell::Cell;

    let lower = html.to_lowercase();
    // cid -> data URL (web images) or "pm-part:<attachment index>" for images the WebView
    // can't display (TIFF): those are converted lazily by the UI so the email shows instantly.
    let mut cids: HashMap<String, String> = HashMap::new();
    for (pid, part) in msg.parts.iter().enumerate() {
        if let Some(cid) = part.content_id() {
            let mime = part_mime(part);
            let key = cid.trim_matches(|c| c == '<' || c == '>').to_lowercase();
            if !mime.starts_with("image/") || !lower.contains(&format!("cid:{key}")) {
                continue;
            }
            // All embedded images load lazily through the app (and TIFF etc. get converted).
            if let Some(idx) = msg.attachments.iter().position(|&a| a as usize == pid) {
                cids.insert(key, format!("pm-part:{idx}"));
            }
        }
    }

    let remote = Cell::new(
        lower.contains("url(http") || lower.contains("url('http") || lower.contains("url(\"http") || lower.contains("@import"),
    );
    const URL_ATTRS: [&str; 7] = ["href", "src", "action", "formaction", "background", "poster", "xlink:href"];

    let result = rewrite_str(
        html,
        RewriteStrSettings::new()
            .append_element_content_handler(element!("script, iframe, frame, frameset, object, embed, applet, base, portal, meta[http-equiv]", |el| {
                    el.remove();
                    Ok(())
                }))
            .append_element_content_handler(element!("*", |el| {
                    if el.removed() {
                        return Ok(());
                    }
                    let attrs: Vec<(String, String)> = el.attributes().iter().map(|a| (a.name(), a.value())).collect();
                    for (name, value) in attrs {
                        let v = value.trim().to_lowercase();
                        if name.starts_with("on") {
                            el.remove_attribute(&name);
                            continue;
                        }
                        if URL_ATTRS.contains(&name.as_str()) && (v.starts_with("javascript:") || v.starts_with("vbscript:") || v.starts_with("data:text/html")) {
                            el.remove_attribute(&name);
                            continue;
                        }
                        if name == "src" && v.starts_with("cid:") {
                            if let Some(data) = cids.get(&v[4..]) {
                                if let Some(idx) = data.strip_prefix("pm-part:") {
                                    let _ = el.set_attribute("data-pm-part", idx);
                                    let _ = el.set_attribute("src", TRANSPARENT_GIF);
                                } else {
                                    let _ = el.set_attribute("src", data);
                                }
                            }
                            continue;
                        }
                        // Lazy-load remote pictures: the UI swaps them in as they scroll into view.
                        if (name == "src" || name == "srcset") && el.tag_name() == "img" && (v.starts_with("http") || v.starts_with("//")) {
                            remote.set(true);
                            let _ = el.set_attribute(&format!("data-pm-{name}"), &value);
                            if name == "src" {
                                let _ = el.set_attribute("src", TRANSPARENT_GIF);
                            } else {
                                el.remove_attribute("srcset");
                            }
                            continue;
                        }
                        let is_fetch = matches!(name.as_str(), "src" | "srcset" | "background" | "poster")
                            || (name == "href" && el.tag_name() == "link");
                        if (is_fetch && (v.starts_with("http") || v.starts_with("//")))
                            || (name == "style" && v.contains("url(") && v.contains("http"))
                        {
                            remote.set(true);
                        }
                    }
                    Ok(())
                })),
    );
    match result {
        Ok(out) => (out, remote.get()),
        // Fallback: show as text if the HTML is too malformed to rewrite.
        Err(_) => (text_to_html(&html2text_lite(html)), false),
    }
}

fn html2text_lite(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Decode an IMAP modified-UTF-7 mailbox name (RFC 3501 §5.1.3).
pub fn decode_mutf7(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.split('&');
    if let Some(first) = chars.next() {
        out.push_str(first);
    }
    for chunk in chars {
        match chunk.find('-') {
            Some(0) => {
                out.push('&');
                out.push_str(&chunk[1..]);
            }
            Some(end) => {
                let b64 = chunk[..end].replace(',', "/");
                let decoded = base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64.trim_end_matches('='));
                match decoded {
                    Ok(bytes) => {
                        let units: Vec<u16> = bytes.chunks(2).filter(|c| c.len() == 2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                        out.push_str(&String::from_utf16_lossy(&units));
                    }
                    Err(_) => {
                        out.push('&');
                        out.push_str(&chunk[..end]);
                    }
                }
                out.push_str(&chunk[end + 1..]);
            }
            None => {
                out.push('&');
                out.push_str(chunk);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MULTI: &str = "From: \"Jane Doe\" <jane@example.com>\r\nTo: bob@icloud.com\r\nSubject: =?UTF-8?B?SGVsbG8g8J+Ri4==?=\r\nDate: Tue, 10 Nov 2026 09:30:00 +0000\r\nMessage-ID: <abc@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"XX\"\r\n\r\n--XX\r\nContent-Type: multipart/alternative; boundary=\"YY\"\r\n\r\n--YY\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHi Bob,\r\n\r\nSee attached.\r\n> old quoted\r\n--YY\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p style=\"color:red\">Hi <b>Bob</b></p><script>alert(1)</script><img src=\"https://t.example/x.png\">\r\n--YY--\r\n--XX\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--XX--\r\n";

    fn mail(parts: &str) -> String {
        format!("From: a@b.c\r\nTo: d@e.f\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"B\"\r\n\r\n{parts}--B--\r\n")
    }

    #[test]
    fn preview_skips_logo_and_links() {
        let raw = mail("--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nJira logo [https://post-office.example/logo]\r\n\r\nMark Garcia assigned this work item to you\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><head><style>p{color:red}</style><title>Jira</title></head><body><table><tr><td><a href=\"https://jira.example\"><img alt=\"Jira logo\" src=\"https://x/logo.png\"></a></td></tr><tr><td><p>Mark Garcia <b>assigned</b> this work item to you</p></td></tr></table></body></html>\r\n");
        let m = parse(raw.as_bytes()).unwrap();
        assert!(preview_of(&m).starts_with("Mark Garcia assigned this work item to you"), "{}", preview_of(&m));
    }

    #[test]
    fn preview_handles_cut_off_quoted_printable_text() {
        // The summary download stops inside the text part: it may come back undecoded,
        // with a soft line break in the middle of the logo's link.
        let url = format!("https://post-office.example/{}", "a".repeat(50));
        let text = format!("Jira logo\r\n[{url}=\r\n/rest-of-the-link]\r\n\r\nMark Garcia assigned this work item to you\r\nMore text that gets cut o");
        let raw = format!("From: a@b.c\r\nTo: d@e.f\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n{text}");
        let m = parse(raw.as_bytes()).unwrap();
        assert!(preview_of(&m).starts_with("Mark Garcia assigned this work item to you"), "{}", preview_of(&m));
        // And the cleanup itself, on text that was never decoded.
        assert!(clean_preview(&strip_text_links(&text), false, false).starts_with("Mark Garcia"));
    }

    #[test]
    fn preview_of_a_bare_forward_shows_the_forwarded_text() {
        let raw = mail("--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<div id=\"divRplyFwdMsg\"><b>From:</b> Sam</div><blockquote><p>The meeting moved to Thursday.</p></blockquote>\r\n");
        let m = parse(raw.as_bytes()).unwrap();
        assert!(preview_of(&m).contains("The meeting moved to Thursday."), "{}", preview_of(&m));
    }

    /// The first 16 KB of a message, as the list summary downloads it.
    fn cut(raw: String) -> String {
        let mut r = raw;
        if r.len() > 16384 {
            let mut n = 16384;
            while !r.is_char_boundary(n) {
                n -= 1;
            }
            r.truncate(n);
        }
        r
    }

    /// Wrap text as quoted-printable with 76-character lines (soft breaks fall anywhere).
    fn qp(s: &str) -> String {
        let enc = s.replace('=', "=3D");
        let mut out = String::new();
        let mut line = 0;
        for ch in enc.chars() {
            if line >= 75 {
                out.push_str("=\r\n");
                line = 0;
            }
            out.push(ch);
            line += 1;
        }
        out
    }

    #[test]
    fn preview_of_cut_off_quoted_printable_html() {
        // multipart/mixed, quoted-printable HTML, lots of layout markup before the text;
        // the download stops inside the part (here after the text).
        let filler = "<table width=\"100%\" style=\"border:0;padding:0\"><tr><td class=\"spacer\" height=\"12\"></td></tr></table>".repeat(60);
        let html = format!("<html><head><meta charset=\"utf-8\"><style>td {{ font-family: Arial; }}</style></head><body>{filler}<p style=\"margin:0\">Welcome on board Turkish Airlines! Your boarding pass is ready for download. We wish you a pleasant flight.</p>{filler}</body></html>");
        let raw = format!("From: a@b.c\r\nTo: d@e.f\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"M\"\r\n\r\n--M\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n{}\r\n--M\r\nContent-Type: application/pdf; name=\"pass.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n--M--\r\n", qp(&html), "QUJD".repeat(5000));
        let full = parse(raw.as_bytes()).unwrap();
        assert!(preview_of(&full).starts_with("Welcome on board Turkish Airlines! Your boarding pass is ready for download. We"), "{}", preview_of(&full));
        let raw = cut(raw);
        let m = parse(raw.as_bytes()).unwrap();
        assert!(preview_of(&m).starts_with("Welcome on board Turkish Airlines! Your boarding pass is ready for download. We"), "{}", preview_of(&m));
    }

    #[test]
    fn preview_of_cut_off_base64_html() {
        // multipart/alternative, both parts base64; the HTML part is cut off mid-stream.
        let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s).as_bytes().chunks(76).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("
");
        let filler = "<div style=\"margin:0;padding:0\"></div>".repeat(600);
        let html = format!("<html>
<head><meta charset=\"utf-8\"></head><body><p>Thank you, the translation looks great.</p>{filler}</body></html>");
        let raw = format!("From: a@b.c
To: d@e.f
Subject: x
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary=\"M\"

--M
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

{}
--M
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

{}
--M--
", b64("Thank you, the translation looks great."), b64(&html));
        let raw = cut(raw);
        let m = parse(raw.as_bytes()).unwrap();
        let p = preview_of(&m);
        assert!(p.starts_with("Thank you, the translation looks great."), "{p}");
        assert!(!looks_b64("Thank you, the translation looks great.") && looks_b64(&b64(&html)));
    }

    #[test]
    fn preview_of_html_in_text_plain_part() {
        // The text/plain part holds the HTML page; the real HTML part is past the cut.
        let css = ".c { color: #333; } ".repeat(150);
        let filler = "<div style=\"margin:0;padding:0\"></div>".repeat(600);
        let html = format!("<!doctype html><html><head><title></title><!--[if !mso]><!--><meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\"><!--<![endif]--><style>{css}</style></head><body><div style=\"display:none\">Review the updated Fee Schedule</div><h1>Upcoming changes to limit orders</h1>{filler}</body></html>");
        let raw = format!("From: a@b.c\r\nTo: d@e.f\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=\"M\"\r\n\r\n--M\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n{}\r\n--M\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n{}\r\n--M--\r\n", qp(&html), qp(&html));
        let raw = cut(raw);
        let m = parse(raw.as_bytes()).unwrap();
        let p = preview_of(&m);
        assert!(p.starts_with("Review the updated Fee Schedule Upcoming changes to limit orders"), "{p}");
        assert!(looks_html(&html) && !looks_html("Hello <b>there</b>"));
    }

    #[test]
    fn preview_of_cut_off_nested_html_with_preheader() {
        // multipart/mixed > multipart/related > 7-bit HTML, cut off mid-part.
        let css = ".c { color: #333; } ".repeat(250);
        let html = format!("<html><head><style>{css}</style></head><body><div style=\"display:none;max-height:0\">Eligible for our Defensive Driver discount?</div><table><tr><td><a href=\"https://x.example/web\">View this email in your browser</a></td></tr><tr><td><img alt=\"GEICO\" src=\"cid:logo\"></td></tr><tr><td>Policy: 1234-56-78-90</td></tr><tr><td>{}</td></tr></table></body></html>", "More details follow here. ".repeat(800));
        let raw = cut(format!("From: a@b.c\r\nTo: d@e.f\r\nSubject: x\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"M\"\r\n\r\n--M\r\nContent-Type: multipart/related; boundary=\"R\"\r\n\r\n--R\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n{html}\r\n--R--\r\n--M--\r\n"));
        let m = parse(raw.as_bytes()).unwrap();
        assert!(preview_of(&m).starts_with("Eligible for our Defensive Driver discount? View this email in your browser Policy:"), "{}", preview_of(&m));
    }

    #[test]
    fn preview_of_a_link_only_message_is_the_link() {
        let url = "https://www.wayfair.com/furniture/pdp/some-chair-w001234567.html";
        let raw = mail(&format!("--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{url}\r\n--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><head></head><body><div dir=\"ltr\"><a href=\"{url}\">{url}</a></div></body></html>\r\n"));
        let m = parse(raw.as_bytes()).unwrap();
        assert_eq!(preview_of(&m), url);
    }

    #[test]
    fn preview_survives_multibyte_text_near_markup() {
        // An "&" right before a wide space, and a capital dotted I (longer when lowercased).
        let raw = mail("--B
Content-Type: text/html; charset=utf-8

<p>Fish & chips at İstanbul café</p><STYLE>x{}</STYLE><p>İİ done</p>
");
        let m = parse(raw.as_bytes()).unwrap();
        assert!(preview_of(&m).starts_with("Fish &"), "{}", preview_of(&m));
        assert!(!preview_of(&m).contains("x{}"));
        assert!(raw_html_tail("Content-Type: text/html

<p>İİİ ok</p>".as_bytes()).unwrap().contains("ok"));
    }

    #[test]
    fn preview_has_no_entity_leftovers() {
        let spacers = "&zwnj;&nbsp;".repeat(60);
        let raw = mail(&format!("--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nView your itinerary details {spacers}\r\nBooking 12345\r\n"));
        let m = parse(raw.as_bytes()).unwrap();
        let p = preview_of(&m);
        assert!(p.starts_with("View your itinerary details") && !p.contains('&'), "{p}");
    }

    #[test]
    fn preview_cleans_plain_text() {
        let raw = mail("--B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n[image: Acme]\r\nhttps://acme.example/track?id=1\r\nYour order <https://acme.example/o/1> has shipped [https://acme.example/s].\r\n> quoted\r\n");
        let m = parse(raw.as_bytes()).unwrap();
        assert_eq!(preview_of(&m), "Your order has shipped .");
    }

    #[test]
    fn preview_decodes_entities_and_drops_spacers() {
        let raw = mail("--B\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<style>.a{x:1}</style><div style=\"display:none\">Big sale &amp; more&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div><p>Hi &ldquo;Sam&rdquo; &#8212; it&#39;s here</p><blockquote>old reply</blockquote>\r\n");
        let m = parse(raw.as_bytes()).unwrap();
        assert_eq!(preview_of(&m), "Big sale & more Hi \u{201c}Sam\u{201d} \u{2014} it's here");
    }

    #[test]
    fn preview_kinds() {
        assert_eq!(preview_kind("application/octet-stream", "Policy.PDF"), "pdf");
        assert_eq!(preview_kind("text/csv", "data.csv"), "text");
        assert_eq!(preview_kind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), "none");
        assert_eq!(preview_kind("image/tiff", "scan.tif"), "image");
        assert_eq!(preview_kind("audio/mpeg", "a.mp3"), "audio");
    }

    #[test]
    fn truncated_body_is_not_an_attachment() {
        let html = "<p>".to_string() + &"Hello there. ".repeat(400);
        let full = format!("From: a@x
Subject: s
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary=\"M\"

--M
Content-Type: multipart/related; boundary=\"R\"

--R
Content-Type: text/html; charset=utf-8

{html}
--R--
--M--
");
        let cut = &full.as_bytes()[..2000];
        let m = parse(cut).unwrap();
        eprintln!("raw attachments: {:?}", attachments(&m).iter().map(|a| &a.name).collect::<Vec<_>>());
        assert!(attachments_partial(&m, cut.len()).is_empty());
        // A real attachment whose data is cut off still counts.
        let pdf = format!("From: a@x
Subject: s
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary=\"M\"

--M
Content-Type: text/plain

Hi
--M
Content-Type: application/pdf; name=\"file.pdf\"
Content-Disposition: attachment; filename=\"file.pdf\"
Content-Transfer-Encoding: base64

{}", "QUJD".repeat(2000));
        let cut = &pdf.as_bytes()[..3000];
        let m = parse(cut).unwrap();
        let names: Vec<_> = attachments_partial(&m, cut.len()).into_iter().map(|a| a.name).collect();
        assert_eq!(names, vec!["file.pdf".to_string()]);
        // An unnamed image cut off mid-data is still an attachment.
        let img = format!("From: a@x
Subject: s
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary=\"M\"

--M
Content-Type: text/plain

Hi
--M
Content-Type: image/png
Content-Transfer-Encoding: base64

{}", "QUJD".repeat(2000));
        let cut = &img.as_bytes()[..3000];
        let m = parse(cut).unwrap();
        assert_eq!(attachments_partial(&m, cut.len()).len(), 1);
    }

    #[test]
    fn parses_multipart() {
        let m = parse(MULTI.as_bytes()).unwrap();
        assert_eq!(m.subject(), Some("Hello 👋"));
        let f = first_person(m.from());
        assert_eq!(f.name, "Jane Doe");
        assert_eq!(f.email, "jane@example.com");
        assert_eq!(preview_of(&m), "Hi Bob, See attached."); // the HTML text alone is too short
        assert!(!attachments(&m).is_empty());
        let a = attachments(&m);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "report.pdf");
        assert_eq!(attachment_bytes(&m, a[0].index).unwrap().2, b"%PDF-1.4\n");
        assert_eq!(date_ms(&m), Some(1794303000000));
    }

    #[test]
    fn sanitizes() {
        let m = parse(MULTI.as_bytes()).unwrap();
        let html = m.body_html(0).unwrap();
        let (clean, remote) = sanitize_html(&html, &m);
        assert!(!clean.contains("<script"));
        assert!(clean.contains("color:red"));
        assert!(remote);
        // Remote pictures are deferred until scrolled into view.
        assert!(clean.contains("data-pm-src=\"https://t.example/x.png\""), "{clean}");
        assert!(!clean.contains(" src=\"https://"), "{clean}");
    }

    #[test]
    fn keeps_markup_strips_active_content() {
        let raw = "From: a@b.c
Content-Type: multipart/related; boundary=\"B\"

--B
Content-Type: text/html

<html><head><style>td > p { color: red; }</style></head><body bgcolor=\"#eee\"><a href=\"javascript:alert(1)\" onclick=\"x()\">x</a><img src=\"cid:logo@x\"><iframe src=\"https://e.vil\"></iframe><table align=\"center\" width=\"600\"><tr><td><p>hi</p></td></tr></table></body></html>
--B
Content-Type: image/png
Content-ID: <logo@x>
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--B--
";
        let m = parse(raw.as_bytes()).unwrap();
        let (clean, remote) = sanitize_html(&m.body_html(0).unwrap(), &m);
        assert!(clean.contains("td > p { color: red; }"), "{clean}");
        assert!(clean.contains("bgcolor=\"#eee\""));
        assert!(clean.contains("width=\"600\""));
        assert!(!clean.contains("onclick"));
        assert!(!clean.contains("javascript:"));
        assert!(!clean.contains("<iframe"));
        assert!(clean.contains("data-pm-part=\"0\""), "{clean}");
        assert!(!remote);
    }

    #[test]
    fn inline_tiff_is_listed_and_converted() {
        let img = image::RgbImage::from_pixel(4, 3, image::Rgb([200, 30, 30]));
        let mut tif = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img).write_to(&mut tif, image::ImageFormat::Tiff).unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(tif.into_inner());
        let raw = format!("From: a@b.c
Content-Type: multipart/related; boundary=\"B\"

--B
Content-Type: text/html

<p>Shot:</p><img src=\"cid:shot1\">
--B
Content-Type: image/tiff
Content-Disposition: inline; filename=\"shot1\"
Content-ID: <shot1>
Content-Transfer-Encoding: base64

{b64}
--B--
");
        let m = parse(raw.as_bytes()).unwrap();
        let atts = attachments(&m);
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0].name, "shot1.tif");
        assert_eq!(atts[0].mime, "image/tiff");
        let (clean, _) = sanitize_html(&m.body_html(0).unwrap(), &m);
        assert!(clean.contains(&format!("data-pm-part=\"{}\"", atts[0].index)), "{clean}");
        let (_, _, bytes) = attachment_bytes(&m, atts[0].index).unwrap();
        let (mime, out) = image_preview(&bytes, 100).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert!(!out.is_empty());
    }

    #[test]
    fn extracts_thread_ids() {
        let raw = "Message-ID: <c@z.com>
In-Reply-To: <b@y.com>
References: <a@x.com>
 <b@y.com>
Subject: Re: hi

body";
        let m = parse(raw.as_bytes()).unwrap();
        let (mid, irt, refs) = thread_ids(&m);
        assert_eq!(mid, "c@z.com");
        assert_eq!(irt, "b@y.com");
        assert_eq!(refs, vec!["a@x.com".to_string(), "b@y.com".to_string()]);
        let none = parse(b"Subject: x

body").unwrap();
        assert_eq!(thread_ids(&none), (String::new(), String::new(), vec![]));
    }

    #[test]
    fn mutf7() {
        assert_eq!(decode_mutf7("Entw&APw-rfe"), "Entwürfe");
        assert_eq!(decode_mutf7("A&-B"), "A&B");
        assert_eq!(decode_mutf7("INBOX"), "INBOX");
    }

    #[test]
    fn plain_to_html() {
        let h = text_to_html("hello <you>\n> quoted\nhttps://x.y/z");
        assert!(h.contains("&lt;you&gt;"));
        assert!(h.contains("pm-quote"));
        assert!(h.contains("<a href=\"https://x.y/z\">"));
    }
}
