//! Known mail providers and server auto-detection.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Implicit TLS (IMAP 993, SMTP 465).
    Tls,
    /// Plain connection upgraded with STARTTLS (IMAP 143, SMTP 587).
    StartTls,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Server {
    pub host: String,
    pub port: u16,
    pub security: Security,
}

impl Server {
    pub fn new(host: &str, port: u16, security: Security) -> Self {
        Server { host: host.to_string(), port, security }
    }
}

/// How an account signs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Password,
    Microsoft,
    Google,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    /// icloud | gmail | yahoo | outlook | aol | fastmail | zoho | gmx | other
    pub provider: String,
    pub display: String,
    pub imap: Server,
    pub smtp: Server,
    /// Sign-in methods this provider supports, preferred first.
    pub auth: Vec<AuthKind>,
    /// Where to create an app password (if the provider uses them).
    pub app_password_url: Option<String>,
    /// Provider stores a copy of sent mail itself (don't APPEND to Sent).
    pub saves_sent: bool,
}

fn preset(provider: &str, display: &str, imap: Server, smtp: Server, auth: Vec<AuthKind>, url: Option<&str>, saves_sent: bool) -> Preset {
    Preset {
        provider: provider.into(),
        display: display.into(),
        imap,
        smtp,
        auth,
        app_password_url: url.map(|s| s.into()),
        saves_sent,
    }
}

/// Built-in settings for well-known providers, by provider id.
pub fn by_provider(provider: &str) -> Option<Preset> {
    use AuthKind::*;
    use Security::*;
    Some(match provider {
        "icloud" => preset(
            "icloud",
            "iCloud",
            Server::new("imap.mail.me.com", 993, Tls),
            Server::new("smtp.mail.me.com", 587, StartTls),
            vec![Password],
            Some("https://account.apple.com/account/manage"),
            false,
        ),
        "gmail" => preset(
            "gmail",
            "Gmail",
            Server::new("imap.gmail.com", 993, Tls),
            Server::new("smtp.gmail.com", 465, Tls),
            vec![Password, Google],
            Some("https://myaccount.google.com/apppasswords"),
            true,
        ),
        "yahoo" => preset(
            "yahoo",
            "Yahoo",
            Server::new("imap.mail.yahoo.com", 993, Tls),
            Server::new("smtp.mail.yahoo.com", 465, Tls),
            vec![Password],
            Some("https://login.yahoo.com/account/security/app-passwords"),
            false,
        ),
        "outlook" => preset(
            "outlook",
            "Outlook.com",
            Server::new("outlook.office365.com", 993, Tls),
            Server::new("smtp-mail.outlook.com", 587, StartTls),
            vec![Microsoft],
            None,
            true,
        ),
        "aol" => preset(
            "aol",
            "AOL",
            Server::new("imap.aol.com", 993, Tls),
            Server::new("smtp.aol.com", 465, Tls),
            vec![Password],
            Some("https://login.aol.com/account/security/app-passwords"),
            false,
        ),
        "fastmail" => preset(
            "fastmail",
            "Fastmail",
            Server::new("imap.fastmail.com", 993, Tls),
            Server::new("smtp.fastmail.com", 465, Tls),
            vec![Password],
            Some("https://app.fastmail.com/settings/security/apps"),
            false,
        ),
        "zoho" => preset(
            "zoho",
            "Zoho Mail",
            Server::new("imap.zoho.com", 993, Tls),
            Server::new("smtp.zoho.com", 465, Tls),
            vec![Password],
            Some("https://accounts.zoho.com/home#security/app_password"),
            false,
        ),
        "gmx" => preset(
            "gmx",
            "GMX",
            Server::new("imap.gmx.com", 993, Tls),
            Server::new("mail.gmx.com", 587, StartTls),
            vec![Password],
            None,
            false,
        ),
        _ => return None,
    })
}

/// Provider id for an email address, from its domain.
pub fn provider_for_email(email: &str) -> Option<&'static str> {
    let domain = email.rsplit('@').next()?.trim().to_lowercase();
    Some(match domain.as_str() {
        "icloud.com" | "me.com" | "mac.com" => "icloud",
        "gmail.com" | "googlemail.com" => "gmail",
        "yahoo.com" | "ymail.com" | "rocketmail.com" | "yahoo.co.uk" | "yahoo.ca" | "yahoo.fr" | "yahoo.de" | "yahoo.com.au" => "yahoo",
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.co.uk" | "hotmail.co.uk" | "live.co.uk" | "hotmail.fr" | "outlook.fr" | "hotmail.de" | "outlook.de" => "outlook",
        "aol.com" | "aim.com" => "aol",
        "fastmail.com" | "fastmail.fm" => "fastmail",
        "zoho.com" | "zohomail.com" => "zoho",
        "gmx.com" | "gmx.net" | "gmx.de" | "gmx.us" => "gmx",
        _ => return None,
    })
}

/// Parse a Mozilla ISPDB / autoconfig document (clientConfig XML).
pub fn parse_autoconfig(xml: &str, email: &str) -> Option<Preset> {
    use crate::contacts::elements;
    let local = email.split('@').next().unwrap_or("");
    let domain = email.rsplit('@').next().unwrap_or("");
    let server_of = |kind: &str, tag: &str| -> Option<Server> {
        // Each <incomingServer type="imap"> ... </incomingServer>
        let mut pos = 0;
        while let Some(off) = xml[pos..].find(&format!("<{tag}")) {
            let start = pos + off;
            let open_end = start + xml[start..].find('>')?;
            let open = &xml[start..open_end];
            let close = format!("</{tag}>");
            let body_end = open_end + xml[open_end..].find(&close)?;
            let body = &xml[open_end + 1..body_end];
            pos = body_end + close.len();
            if !open.contains(&format!("type=\"{kind}\"")) {
                continue;
            }
            let host = elements(body, "hostname").into_iter().next()?.replace("%EMAILDOMAIN%", domain).replace("%EMAILLOCALPART%", local);
            let port: u16 = elements(body, "port").into_iter().next()?.trim().parse().ok()?;
            let sock = elements(body, "socketType").into_iter().next().unwrap_or_default().to_uppercase();
            let security = match sock.as_str() {
                "SSL" | "TLS" => Security::Tls,
                "STARTTLS" => Security::StartTls,
                _ => continue, // never use plaintext
            };
            return Some(Server { host, port, security });
        }
        None
    };
    let imap = server_of("imap", "incomingServer")?;
    let smtp = server_of("smtp", "outgoingServer")?;
    let display = elements(xml, "displayShortName").into_iter().next().unwrap_or_else(|| domain.to_string());
    Some(Preset {
        provider: "other".into(),
        display,
        imap,
        smtp,
        auth: vec![AuthKind::Password],
        app_password_url: None,
        saves_sent: false,
    })
}

/// Best-effort settings for an email address: built-in presets, then Mozilla's ISPDB,
/// then the domain's own autoconfig. `None` means the user must enter servers manually.
pub async fn detect(email: &str) -> Option<Preset> {
    if let Some(p) = provider_for_email(email).and_then(by_provider) {
        return Some(p);
    }
    let domain = email.rsplit('@').next()?.trim().to_lowercase();
    if domain.is_empty() || !domain.contains('.') {
        return None;
    }
    let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(8)).build().ok()?;
    for url in [
        format!("https://autoconfig.thunderbird.net/v1.1/{domain}"),
        format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={email}"),
    ] {
        if let Ok(r) = http.get(&url).send().await {
            if r.status().is_success() {
                if let Ok(t) = r.text().await {
                    if let Some(p) = parse_autoconfig(&t, email) {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_known_providers() {
        assert_eq!(provider_for_email("a@me.com"), Some("icloud"));
        assert_eq!(provider_for_email("a@GMAIL.com"), Some("gmail"));
        assert_eq!(provider_for_email("a@hotmail.com"), Some("outlook"));
        assert_eq!(provider_for_email("a@ymail.com"), Some("yahoo"));
        assert_eq!(provider_for_email("a@example.org"), None);
        let o = by_provider("outlook").unwrap();
        assert_eq!(o.auth, vec![AuthKind::Microsoft]);
        assert!(o.saves_sent);
        assert!(!by_provider("icloud").unwrap().saves_sent);
    }

    #[test]
    fn parses_ispdb() {
        let xml = r#"<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="example.org">
          <displayShortName>Example</displayShortName>
          <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
          <incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
          <outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
        </emailProvider></clientConfig>"#;
        let p = parse_autoconfig(xml, "me@example.org").unwrap();
        assert_eq!(p.imap, Server::new("imap.example.org", 993, Security::Tls));
        assert_eq!(p.smtp, Server::new("smtp.example.org", 587, Security::StartTls));
        assert_eq!(p.display, "Example");
    }
}
