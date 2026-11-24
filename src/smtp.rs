//! Building and sending outgoing mail through smtp.mail.me.com.

use crate::accounts::{AccountConfig, Credentials, Secret};
use crate::providers::Security;
use crate::model::OutgoingMessage;
use anyhow::{Context, Result};
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials as SmtpCreds;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "ics" => "text/calendar",
        _ => "application/octet-stream",
    }
}

fn parse_mailbox(s: &str) -> Result<Mailbox> {
    s.trim().parse::<Mailbox>().with_context(|| format!("\"{}\" is not a valid email address.", s.trim()))
}

/// Build an RFC 5322 message. Returns the message and its Message-ID.
/// `mid`: the Message-ID to use (so the Sent copy matches what went out), or None for a new one.
pub fn build(from_email: &str, from_name: &str, m: &OutgoingMessage, for_draft: bool, mid: Option<&str>) -> Result<(Message, String)> {
    let domain = from_email.split('@').nth(1).unwrap_or("icloud.com");
    let mid = mid.map(str::to_string).unwrap_or_else(|| format!("<{}.{}@{}>", chrono::Utc::now().timestamp_millis(), std::process::id(), domain));
    let mut b = Message::builder()
        .from(Mailbox::new(
            if from_name.is_empty() { None } else { Some(from_name.to_string()) },
            from_email.parse().context("invalid sender address")?,
        ))
        .subject(m.subject.clone())
        .message_id(Some(mid.clone()))
        .date_now();
    let mut any_rcpt = false;
    for t in m.to.iter().filter(|s| !s.trim().is_empty()) {
        b = b.to(parse_mailbox(t)?);
        any_rcpt = true;
    }
    for t in m.cc.iter().filter(|s| !s.trim().is_empty()) {
        b = b.cc(parse_mailbox(t)?);
        any_rcpt = true;
    }
    for t in m.bcc.iter().filter(|s| !s.trim().is_empty()) {
        b = b.bcc(parse_mailbox(t)?);
        any_rcpt = true;
    }
    if !any_rcpt {
        if for_draft {
            b = b.to(Mailbox::new(None, from_email.parse()?));
        } else {
            anyhow::bail!("Add at least one recipient.");
        }
    }
    if for_draft {
        b = b.keep_bcc();
    }
    if let Some(irt) = &m.in_reply_to {
        b = b.in_reply_to(irt.clone());
    }
    if !m.references.is_empty() {
        b = b.references(m.references.join(" "));
    }

    let (html, pictures) = embed_pictures(&m.html, &mid);
    let body = if pictures.is_empty() {
        MultiPart::alternative_plain_html(m.text.clone(), html)
    } else {
        // alternative[ text, related[ html, pictures… ] ]: the pictures travel with the
        // message as inline parts the HTML refers to by Content-ID.
        let mut related = MultiPart::related().singlepart(SinglePart::html(html));
        for (cid, mime, bytes) in pictures {
            related = related.singlepart(Attachment::new_inline(cid).body(bytes, mime));
        }
        MultiPart::alternative().singlepart(SinglePart::plain(m.text.clone())).multipart(related)
    };
    let msg = if m.attachments.is_empty() {
        b.multipart(body)?
    } else {
        let mut mixed = MultiPart::mixed().multipart(body);
        for a in &m.attachments {
            let bytes = std::fs::read(&a.path).with_context(|| format!("Could not read attachment {}", a.name))?;
            let part: SinglePart = Attachment::new(a.name.clone()).body(bytes, ContentType::parse(mime_for(&a.name)).unwrap());
            mixed = mixed.singlepart(part);
        }
        b.multipart(mixed)?
    };
    Ok((msg, mid))
}

/// Pictures written into the body as `data:` URLs (quoted pictures, pasted screenshots) become
/// inline parts: their `src` turns into `cid:…`, and each distinct picture is returned once as
/// (Content-ID, type, bytes). Mail apps block `data:` pictures, so they can't go out as they are.
/// Anything that isn't a well-formed base64 picture is left alone.
fn embed_pictures(html: &str, mid: &str) -> (String, Vec<(String, ContentType, Vec<u8>)>) {
    use base64::Engine;
    use lol_html::{element, rewrite_str, RewriteStrSettings};
    use std::cell::RefCell;
    use std::collections::HashMap;

    if !html.contains("data:image/") {
        return (html.to_string(), vec![]);
    }
    // Content-IDs share the Message-ID's unique part, so they're unique too.
    let id = mid.trim_matches(|c| c == '<' || c == '>');
    let seen: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    let parts: RefCell<Vec<(String, ContentType, Vec<u8>)>> = RefCell::new(vec![]);
    let out = rewrite_str(
        html,
        RewriteStrSettings::new().append_element_content_handler(element!("img[src]", |el| {
            let src = el.get_attribute("src").unwrap_or_default();
            let Some(rest) = src.trim().strip_prefix("data:") else { return Ok(()) };
            let Some((meta, data)) = rest.split_once(',') else { return Ok(()) };
            let Some(mime) = meta.strip_suffix(";base64") else { return Ok(()) };
            if !mime.to_ascii_lowercase().starts_with("image/") {
                return Ok(());
            }
            let known = seen.borrow().get(&src).cloned();
            let cid = if let Some(cid) = known {
                cid
            } else {
                let clean: String = data.chars().filter(|c| !c.is_whitespace()).collect();
                let (Ok(bytes), Ok(ctype)) = (base64::engine::general_purpose::STANDARD.decode(clean), ContentType::parse(mime)) else {
                    return Ok(());
                };
                let cid = format!("pm{}.{id}", parts.borrow().len() + 1);
                parts.borrow_mut().push((cid.clone(), ctype, bytes));
                seen.borrow_mut().insert(src.clone(), cid.clone());
                cid
            };
            el.set_attribute("src", &format!("cid:{cid}"))?;
            Ok(())
        })),
    );
    match out {
        Ok(out) => (out, parts.into_inner()),
        Err(_) => (html.to_string(), vec![]),
    }
}

pub async fn send(cfg: &AccountConfig, creds: &Credentials, msg: Message) -> Result<()> {
    use lettre::transport::smtp::authentication::Mechanism;
    let host = cfg.smtp.host.as_str();
    let builder = match cfg.smtp.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(host)?,
        Security::StartTls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)?,
    }
    .port(cfg.smtp.port)
    .timeout(Some(std::time::Duration::from_secs(60)));
    let builder = match &creds.secret {
        Secret::Password(pw) => builder.credentials(SmtpCreds::new(creds.email.clone(), pw.clone())),
        Secret::OAuth(ts) => {
            let token = ts.access_token().await?;
            builder.credentials(SmtpCreds::new(creds.email.clone(), token)).authentication(vec![Mechanism::Xoauth2])
        }
    };
    let transport = builder.build();
    if let Err(e) = transport.send(msg).await {
        // The server turned down the password or token: that's a sign-in problem (shows the
        // "Sign in again" banner), not a problem with this message.
        if e.is_permanent() && e.status().is_some_and(|c| is_auth_rejection(&c.to_string())) {
            match creds.secret {
                Secret::Password(_) => anyhow::bail!("AUTH: The email address or app password for {} is incorrect.", creds.email),
                Secret::OAuth(_) => anyhow::bail!("AUTH: {} needs to be signed in again.", creds.email),
            }
        }
        return Err(anyhow::Error::new(e).context(format!("{host} could not send this message")));
    }
    Ok(())
}

/// SMTP reply codes meaning "authentication required / too weak / failed".
fn is_auth_rejection(code: &str) -> bool {
    matches!(code, "530" | "534" | "535")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_message() {
        let m = OutgoingMessage {
            to: vec!["Bob <bob@example.com>".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Hi".into(),
            html: "<p>Hello</p>".into(),
            text: "Hello".into(),
            attachments: vec![],
            in_reply_to: Some("<a@b>".into()),
            references: vec!["<a@b>".into()],
            draft_uid: None,
        };
        let (msg, mid) = build("me@icloud.com", "Me", &m, false, None).unwrap();
        let s = String::from_utf8(msg.formatted()).unwrap();
        assert!(s.contains("Subject: Hi"));
        assert!(s.contains("In-Reply-To: <a@b>"));
        assert!(s.contains(&mid));
        assert!(build("me@icloud.com", "Me", &OutgoingMessage { to: vec![], ..m.clone() }, false, None).is_err());
    }

    /// A saved draft must hold everything needed to resume it: Bcc and the reply's threading.
    #[test]
    fn draft_keeps_bcc_and_threading() {
        let m = OutgoingMessage {
            to: vec!["Bob <bob@example.com>".into()],
            cc: vec![],
            bcc: vec!["secret@example.com".into()],
            subject: "Re: Hi".into(),
            html: "<p>Draft</p>".into(),
            text: "Draft".into(),
            attachments: vec![],
            in_reply_to: Some("<orig@example.com>".into()),
            references: vec!["<orig@example.com>".into()],
            draft_uid: Some(7),
        };
        let (msg, _) = build("me@icloud.com", "Me", &m, true, None).unwrap();
        let raw = msg.formatted();
        let parsed = crate::mime::parse(&raw).unwrap();
        assert_eq!(crate::mime::people(parsed.bcc())[0].email, "secret@example.com");
        assert_eq!(crate::mime::thread_ids(&parsed).1, "orig@example.com");
        // What actually goes out never carries Bcc.
        let (sent, _) = build("me@icloud.com", "Me", &m, false, None).unwrap();
        assert!(!String::from_utf8(sent.formatted()).unwrap().contains("secret@example.com"));
    }

    /// Pictures in the body (quoted or pasted) go out as inline parts, each distinct one once,
    /// and a saved draft reopens with them in the body, not as attachment chips.
    #[test]
    fn sends_body_pictures_as_inline_parts() {
        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        let m = OutgoingMessage {
            to: vec!["bob@example.com".into()],
            cc: vec![],
            bcc: vec![],
            subject: "Pics".into(),
            html: format!("<p>a</p><img src=\"{png}\"><img src=\"{png}\"><img src=\"{gif}\"><img src=\"data:image/png;base64,%%%\"><img src=\"https://x.example/a.png\">"),
            text: "a".into(),
            attachments: vec![],
            in_reply_to: None,
            references: vec![],
            draft_uid: None,
        };
        let (msg, _) = build("me@icloud.com", "Me", &m, true, None).unwrap();
        let raw = msg.formatted();
        let s = String::from_utf8_lossy(&raw);
        assert!(s.contains("multipart/related"), "{s}");
        let parsed = crate::mime::parse(&raw).unwrap();
        assert!(crate::mime::attachments(&parsed).is_empty());
        assert_eq!(crate::mime::inline_images(&parsed).len(), 2);
        let html = parsed.body_html(0).unwrap();
        assert_eq!(html.matches("src=\"cid:").count(), 3, "{html}");
        assert!(html.contains("https://x.example/a.png"));
        assert!(html.contains("base64,%%%"), "a broken picture is left as it was");

        // No pictures: the plain structure as before.
        let (plain, _) = build("me@icloud.com", "Me", &OutgoingMessage { html: "<p>x</p>".into(), ..m }, false, None).unwrap();
        assert!(!String::from_utf8(plain.formatted()).unwrap().contains("multipart/related"));
    }

    #[test]
    fn recognizes_sign_in_rejections() {
        assert!(is_auth_rejection("535"));
        assert!(is_auth_rejection("534"));
        assert!(is_auth_rejection("530"));
        assert!(!is_auth_rejection("550")); // mailbox unavailable: a problem with the message
        assert!(!is_auth_rejection("421")); // try again later
    }
}
