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

    let body = MultiPart::alternative_plain_html(m.text.clone(), m.html.clone());
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

    #[test]
    fn recognizes_sign_in_rejections() {
        assert!(is_auth_rejection("535"));
        assert!(is_auth_rejection("534"));
        assert!(is_auth_rejection("530"));
        assert!(!is_auth_rejection("550")); // mailbox unavailable: a problem with the message
        assert!(!is_auth_rejection("421")); // try again later
    }
}
