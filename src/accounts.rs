//! Accounts: settings in `%APPDATA%\PearMail\accounts.json`, secrets (passwords or
//! OAuth refresh tokens) only in Windows Credential Manager.
//!
//! The single-account iCloud setup from earlier versions (`account.json` + the
//! "PearMail iCloud" credential) is migrated automatically on first run.

use crate::oauth::{OAuthApps, TokenSource};
use crate::providers::{self, AuthKind, Server};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

const SECRET_SERVICE: &str = "Pear Mail";
const LEGACY_SECRET_SERVICE: &str = "PearMail iCloud";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountConfig {
    pub id: String,
    pub email: String,
    /// The account's name inside Pear Mail (sidebar, menus). Not shown to anyone else.
    pub name: String,
    /// The name people see when you email them. `None`: not known yet (it's looked up
    /// in the account's Sent mail); mail goes out with the bare address until then.
    #[serde(default)]
    pub sender_name: Option<String>,
    /// The sender name was typed by the user: never replace it with the one from Sent mail.
    #[serde(default)]
    pub sender_set_by_user: bool,
    /// Set once `name` means "account name" (before, it was also the sender name).
    #[serde(default)]
    pub names_v2: bool,
    /// icloud | gmail | yahoo | outlook | aol | ... | other
    pub provider: String,
    pub imap: Server,
    pub smtp: Server,
    pub auth: AuthKind,
    /// Provider keeps its own copy of sent mail, so don't APPEND one.
    #[serde(default)]
    pub saves_sent: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    #[serde(default)]
    pub accounts: Vec<AccountConfig>,
    #[serde(default)]
    pub oauth_apps: OAuthApps,
}

fn dir() -> Result<PathBuf> {
    let d = dirs::config_dir().context("no config dir")?.join("PearMail");
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

pub fn new_id() -> String {
    let mut b = [0u8; 5];
    getrandom::getrandom(&mut b).expect("random");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Build an account from a provider preset.
pub fn from_preset(email: &str, name: &str, p: &providers::Preset, auth: AuthKind) -> AccountConfig {
    AccountConfig {
        id: new_id(),
        email: email.to_string(),
        name: name.to_string(),
        provider: p.provider.clone(),
        imap: p.imap.clone(),
        smtp: p.smtp.clone(),
        auth,
        saves_sent: p.saves_sent,
        sender_name: None,
        sender_set_by_user: false,
        names_v2: true,
    }
}

/// Default account name: the provider ("iCloud", "Gmail"…), or the address's domain.
pub fn provider_label(provider: &str, email: &str) -> String {
    match provider {
        "icloud" => "iCloud",
        "gmail" => "Gmail",
        "outlook" => "Outlook.com",
        "yahoo" => "Yahoo",
        "aol" => "AOL",
        "fastmail" => "Fastmail",
        "zoho" => "Zoho",
        "gmx" => "GMX",
        _ => return email.rsplit('@').next().unwrap_or(email).to_string(),
    }
    .to_string()
}

/// Accounts from before account and sender names were separate: the old name was
/// (usually auto-made) sender name, so the account gets its provider's name and the
/// sender name is looked up in Sent mail again. Returns whether anything changed.
fn migrate_names(store: &mut Store) -> bool {
    let mut changed = false;
    for a in store.accounts.iter_mut().filter(|a| !a.names_v2) {
        a.name = provider_label(&a.provider, &a.email);
        a.sender_name = None;
        a.sender_set_by_user = false;
        a.names_v2 = true;
        changed = true;
    }
    changed
}

#[derive(Deserialize)]
struct LegacyConfig {
    email: Option<String>,
    display_name: Option<String>,
}

/// The pre-multi-account config → one iCloud account.
fn migrate_legacy(legacy_json: &str) -> Option<AccountConfig> {
    let l: LegacyConfig = serde_json::from_str(legacy_json).ok()?;
    let email = l.email?;
    let preset = providers::by_provider("icloud")?;
    let mut a = from_preset(&email, "iCloud", &preset, AuthKind::Password);
    // The old version had a real "your name" setting: keep it as the sender name.
    a.sender_name = Some(l.display_name.filter(|n| !n.is_empty()).unwrap_or_else(|| default_name(&email)));
    a.sender_set_by_user = true;
    Some(a)
}

pub fn load() -> Store {
    let Ok(d) = dir() else { return Store::default() };
    if let Some(mut s) = std::fs::read_to_string(d.join("accounts.json")).ok().and_then(|s| serde_json::from_str::<Store>(&s).ok()) {
        if migrate_names(&mut s) {
            let _ = save(&s);
        }
        return s;
    }
    // First run of the multi-account version: migrate the old single account.
    let mut store = Store::default();
    if let Some(acct) = std::fs::read_to_string(d.join("account.json")).ok().and_then(|s| migrate_legacy(&s)) {
        if let Ok(pw) = keyring::Entry::new(LEGACY_SECRET_SERVICE, &acct.email).and_then(|e| e.get_password()) {
            if set_secret(&acct.id, &pw).is_ok() {
                store.accounts.push(acct);
                let _ = save(&store);
            }
        }
    }
    store
}

pub fn save(store: &Store) -> Result<()> {
    std::fs::write(dir()?.join("accounts.json"), serde_json::to_string_pretty(store)?)?;
    Ok(())
}

pub fn get_secret(id: &str) -> Option<String> {
    keyring::Entry::new(SECRET_SERVICE, id).ok()?.get_password().ok()
}

pub fn set_secret(id: &str, secret: &str) -> Result<()> {
    keyring::Entry::new(SECRET_SERVICE, id)?.set_password(secret)?;
    Ok(())
}

pub fn delete_secret(id: &str, email: &str) {
    if let Ok(e) = keyring::Entry::new(SECRET_SERVICE, id) {
        let _ = e.delete_credential();
    }
    // Also tidy up a leftover credential from the single-account version.
    if let Ok(e) = keyring::Entry::new(LEGACY_SECRET_SERVICE, email) {
        let _ = e.delete_credential();
    }
}

/// What an account signs in with at runtime.
#[derive(Clone)]
pub enum Secret {
    Password(String),
    OAuth(Arc<TokenSource>),
}

/// Runtime credentials for one account.
#[derive(Clone)]
pub struct Credentials {
    pub email: String,
    pub secret: Secret,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials").field("email", &self.email).finish_non_exhaustive()
    }
}

impl Credentials {
    /// Password for password accounts (used by iCloud CardDAV).
    pub fn password(&self) -> Option<&str> {
        match &self.secret {
            Secret::Password(p) => Some(p),
            Secret::OAuth(_) => None,
        }
    }

    pub fn for_account(cfg: &AccountConfig, secret: String, apps: &OAuthApps) -> Credentials {
        let secret = match cfg.auth {
            AuthKind::Password => Secret::Password(secret),
            kind => {
                let id = cfg.id.clone();
                Secret::OAuth(Arc::new(TokenSource::new(
                    kind,
                    apps.clone(),
                    secret,
                    Box::new(move |rt| {
                        let _ = set_secret(&id, rt);
                    }),
                )))
            }
        };
        Credentials { email: cfg.email.clone(), secret }
    }
}

/// Normalise what the user typed: trims and lowercases; a bare name gets "@icloud.com".
pub fn normalize_email(input: &str) -> String {
    let t = input.trim().to_lowercase();
    if t.contains('@') {
        t
    } else {
        format!("{t}@icloud.com")
    }
}

/// Default display name derived from the address ("jane.doe@…" -> "Jane Doe").
pub fn default_name(email: &str) -> String {
    let local = email.split('@').next().unwrap_or(email);
    local
        .split(|c: char| c == '.' || c == '_' || c == '-')
        .filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separates_account_and_sender_names() {
        let json = r#"{"accounts":[{"id":"a","email":"jane.doe@gmail.com","name":"Jane Doe","provider":"gmail",
            "imap":{"host":"imap.gmail.com","port":993,"security":"tls"},"smtp":{"host":"smtp.gmail.com","port":587,"security":"starttls"},"auth":"password"}]}"#;
        let mut s: Store = serde_json::from_str(json).unwrap();
        assert!(migrate_names(&mut s));
        let a = &s.accounts[0];
        assert_eq!((a.name.as_str(), a.sender_name.clone(), a.names_v2), ("Gmail", None, true));
        assert!(!migrate_names(&mut s)); // only once
        assert_eq!(provider_label("other", "me@example.org"), "example.org");
        assert_eq!(provider_label("icloud", "x@me.com"), "iCloud");
    }

    #[test]
    fn normalizes() {
        assert_eq!(normalize_email(" Jane "), "jane@icloud.com");
        assert_eq!(normalize_email("a@me.com"), "a@me.com");
        assert_eq!(default_name("jane.doe@icloud.com"), "Jane Doe");
    }

    #[test]
    fn migrates_single_icloud_account() {
        let a = migrate_legacy(r#"{"email":"jane@icloud.com","display_name":"Jane D"}"#).unwrap();
        assert_eq!(a.email, "jane@icloud.com");
        assert_eq!(a.name, "iCloud");
        assert_eq!(a.sender_name.as_deref(), Some("Jane D"));
        assert_eq!(a.provider, "icloud");
        assert_eq!(a.imap.host, "imap.mail.me.com");
        assert_eq!(a.smtp.port, 587);
        assert_eq!(a.auth, AuthKind::Password);
        assert!(!a.saves_sent);
        assert_eq!(a.id.len(), 10);
        assert!(migrate_legacy(r#"{"email":null}"#).is_none());
        // Signed-out legacy config.
        assert!(migrate_legacy("{}").is_none());
    }

    #[test]
    fn store_roundtrip() {
        let p = providers::by_provider("gmail").unwrap();
        let s = Store { accounts: vec![from_preset("x@gmail.com", "X", &p, AuthKind::Google)], oauth_apps: OAuthApps::default() };
        let json = serde_json::to_string(&s).unwrap();
        let back: Store = serde_json::from_str(&json).unwrap();
        assert_eq!(back.accounts, s.accounts);
        assert!(json.contains("\"auth\":\"google\""));
    }
}
