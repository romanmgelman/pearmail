//! Browser sign-in (OAuth 2.0 authorization code + PKCE, loopback redirect) for
//! Microsoft (Outlook.com / Hotmail) and Google (Gmail), plus token refresh.
//!
//! Pear Mail's own app registrations are built in, so signing in is just a click.

use crate::providers::AuthKind;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::Deserialize;
use sha2::Digest;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Pear Mail's app registration with Microsoft (Entra ID; personal and work accounts).
const MICROSOFT_CLIENT_ID: &str = "a9cbfa8c-ca3e-40b9-9063-fe7c495632f9";
/// Pear Mail's Google "Desktop app" client, compiled in from `oauth.local` (or the
/// environment) by build.rs, so it isn't in the public source. Google issues a "secret"
/// for desktop apps too; it isn't confidential (PKCE protects the sign-in), but the token
/// endpoint requires it.
const GOOGLE_CLIENT_ID: &str = match option_env!("PEARMAIL_GOOGLE_CLIENT_ID") { Some(v) => v, None => "" };
const GOOGLE_CLIENT_SECRET: &str = match option_env!("PEARMAIL_GOOGLE_CLIENT_SECRET") { Some(v) => v, None => "" };

struct Endpoints {
    authorize: &'static str,
    token: &'static str,
    scope: &'static str,
}

fn endpoints(kind: AuthKind) -> Result<Endpoints> {
    Ok(match kind {
        AuthKind::Microsoft => Endpoints {
            authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scope: "openid email profile offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
        },
        AuthKind::Google => Endpoints {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth",
            token: "https://oauth2.googleapis.com/token",
            scope: "openid email profile https://mail.google.com/",
        },
        AuthKind::Password => bail!("not an OAuth provider"),
    })
}

fn client_id(kind: AuthKind) -> Result<&'static str> {
    let ready = match kind {
        AuthKind::Microsoft => !MICROSOFT_CLIENT_ID.is_empty(),
        AuthKind::Google => !GOOGLE_CLIENT_ID.is_empty() && !GOOGLE_CLIENT_SECRET.is_empty(),
        AuthKind::Password => bail!("not an OAuth provider"),
    };
    if !ready {
        bail!("Sign in with {} isn't set up in this build yet.", if kind == AuthKind::Microsoft { "Microsoft" } else { "Google" });
    }
    Ok(if kind == AuthKind::Microsoft { MICROSOFT_CLIENT_ID } else { GOOGLE_CLIENT_ID })
}

/// Who signed in: the email address and name from the ID token's payload. (No signature
/// check needed: the token came straight from the provider's token endpoint over TLS.)
fn id_token_identity(id_token: &str) -> Option<(String, String)> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|x| !x.is_empty()).map(str::to_string);
    // Microsoft personal accounts may omit "email"; "preferred_username" is the address.
    let email = s("email").or_else(|| s("preferred_username").filter(|u| u.contains('@')))?;
    Some((email.to_lowercase(), s("name").unwrap_or_default()))
}

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::getrandom(&mut buf).expect("OS random number generator");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// PKCE S256 challenge for a verifier.
pub fn pkce_challenge(verifier: &str) -> String {
    let hash = sha2::Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash)
}

/// The SASL XOAUTH2 initial response (before base64).
pub fn xoauth2_string(email: &str, access_token: &str) -> String {
    format!("user={email}\x01auth=Bearer {access_token}\x01\x01")
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn dec(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    id_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn token_request(kind: AuthKind, form: Vec<(&str, String)>) -> Result<TokenResponse> {
    let ep = endpoints(kind)?;
    let mut form = form;
    form.push(("client_id", client_id(kind)?.to_string()));
    if kind == AuthKind::Google {
        form.push(("client_secret", GOOGLE_CLIENT_SECRET.to_string()));
    }
    let body = form.iter().map(|(k, v)| format!("{}={}", k, enc(v))).collect::<Vec<_>>().join("&");
    let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?;
    let res = http
        .post(ep.token)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .context("Could not reach the sign-in server")?;
    let t: TokenResponse = serde_json::from_str(&res.text().await?).context("Unexpected sign-in server response")?;
    if let Some(e) = &t.error {
        bail!("Sign-in failed: {}", t.error_description.clone().unwrap_or_else(|| e.clone()));
    }
    Ok(t)
}

pub struct SignInResult {
    pub refresh_token: String,
    pub access_token: String,
    pub expires_in: u64,
    /// The signed-in address and name (from the ID token).
    pub email: String,
    pub name: String,
}

/// Run the browser sign-in. `open` opens a URL in the system browser.
/// Waits (up to 5 minutes) for the browser to come back to the loopback address.
/// `login_hint`: the address to sign in as (re-sign-in), if known.
pub async fn sign_in(kind: AuthKind, login_hint: Option<&str>, open: impl Fn(&str) -> Result<()>) -> Result<SignInResult> {
    let ep = endpoints(kind)?;
    let id = client_id(kind)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    // Microsoft and Google both accept any port for a registered loopback redirect.
    let redirect = if kind == AuthKind::Microsoft { format!("http://localhost:{port}") } else { format!("http://127.0.0.1:{port}") };
    let verifier = random_url_safe(48);
    let state = random_url_safe(16);
    let mut url = format!(
        "{}?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        ep.authorize,
        enc(id),
        enc(&redirect),
        enc(ep.scope),
        pkce_challenge(&verifier),
        state,
    );
    if let Some(h) = login_hint.filter(|h| !h.is_empty()) {
        url.push_str(&format!("&login_hint={}", enc(h)));
    }
    if kind == AuthKind::Google {
        url.push_str("&access_type=offline&prompt=consent");
    } else {
        url.push_str("&response_mode=query&prompt=select_account");
    }
    open(&url)?;

    // Wait for the redirect: GET /?code=...&state=...
    let code = tokio::time::timeout(Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
            let query = path.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
            let params: Vec<(String, String)> =
                query.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), dec(v))).collect();
            let get = |k: &str| params.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
            if get("code").is_none() && get("error").is_none() {
                // e.g. favicon request
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let ok = get("state").as_deref() == Some(state.as_str()) && get("code").is_some();
            let page = if ok {
                "<h2>Signed in to Pear Mail</h2><p>You can close this window and return to Pear Mail.</p>"
            } else {
                "<h2>Sign-in didn't complete</h2><p>Return to Pear Mail and try again.</p>"
            };
            let html = format!("<!doctype html><meta charset=utf-8><title>Pear Mail</title><body style=\"font-family:system-ui;text-align:center;padding-top:15vh\">{page}</body>");
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", html.len(), html);
            let _ = sock.write_all(resp.as_bytes()).await;
            if let Some(e) = get("error") {
                return Err(anyhow!("Sign-in was cancelled ({})", get("error_description").unwrap_or(e)));
            }
            if !ok {
                return Err(anyhow!("Sign-in response didn't match this request"));
            }
            return Ok::<String, anyhow::Error>(get("code").unwrap());
        }
    })
    .await
    .map_err(|_| anyhow!("Sign-in timed out"))??;

    let t = token_request(
        kind,
        vec![
            ("grant_type", "authorization_code".into()),
            ("code", code),
            ("redirect_uri", redirect),
            ("code_verifier", verifier),
            ("scope", ep.scope.into()),
        ],
    )
    .await?;
    let (email, name) = t.id_token.as_deref().and_then(id_token_identity).context("The sign-in server didn't say which account signed in")?;
    Ok(SignInResult {
        email,
        name,
        refresh_token: t.refresh_token.context("The sign-in server didn't return a refresh token")?,
        access_token: t.access_token.context("No access token")?,
        expires_in: t.expires_in.unwrap_or(3600),
    })
}

/// Hands out fresh access tokens for one account, refreshing when needed.
pub struct TokenSource {
    pub kind: AuthKind,
    refresh_token: std::sync::Mutex<String>,
    cached: tokio::sync::Mutex<Option<(String, Instant)>>,
    /// Called when the provider rotates the refresh token (so it can be persisted).
    on_rotate: Box<dyn Fn(&str) + Send + Sync>,
}

impl TokenSource {
    pub fn new(kind: AuthKind, refresh_token: String, on_rotate: Box<dyn Fn(&str) + Send + Sync>) -> Self {
        TokenSource { kind, refresh_token: std::sync::Mutex::new(refresh_token), cached: Default::default(), on_rotate }
    }

    pub fn seed(&self, access_token: String, expires_in: u64) {
        if let Ok(mut c) = self.cached.try_lock() {
            *c = Some((access_token, Instant::now() + Duration::from_secs(expires_in)));
        }
    }

    pub async fn access_token(&self) -> Result<String> {
        let mut cached = self.cached.lock().await;
        if let Some((tok, exp)) = cached.as_ref() {
            if *exp > Instant::now() + Duration::from_secs(90) {
                return Ok(tok.clone());
            }
        }
        let rt = self.refresh_token.lock().unwrap().clone();
        let ep = endpoints(self.kind)?;
        let t = token_request(self.kind, vec![("grant_type", "refresh_token".into()), ("refresh_token", rt), ("scope", ep.scope.into())])
            .await
            .map_err(|e| anyhow!("AUTH: {e:#}. Sign in to this account again."))?;
        if let Some(new_rt) = &t.refresh_token {
            *self.refresh_token.lock().unwrap() = new_rt.clone();
            (self.on_rotate)(new_rt);
        }
        let tok = t.access_token.context("No access token")?;
        *cached = Some((tok.clone(), Instant::now() + Duration::from_secs(t.expires_in.unwrap_or(3600))));
        Ok(tok)
    }
}

/// SASL XOAUTH2 for async-imap: first step sends the token string; if the server
/// replies with an error challenge, answer with an empty response so it can fail cleanly.
pub struct XOAuth2 {
    pub payload: String,
    sent: bool,
}

impl XOAuth2 {
    pub fn new(email: &str, token: &str) -> Self {
        XOAuth2 { payload: xoauth2_string(email, token), sent: false }
    }
}

impl async_imap::Authenticator for XOAuth2 {
    type Response = String;
    fn process(&mut self, _challenge: &[u8]) -> String {
        if self.sent {
            String::new()
        } else {
            self.sent = true;
            self.payload.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_rfc7636_vector() {
        // RFC 7636 Appendix B.
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn xoauth2_format() {
        assert_eq!(xoauth2_string("a@b.c", "tok"), "user=a@b.c\x01auth=Bearer tok\x01\x01");
        let mut x = XOAuth2::new("a@b.c", "tok");
        use async_imap::Authenticator;
        assert_eq!(x.process(b""), "user=a@b.c\x01auth=Bearer tok\x01\x01");
        assert_eq!(x.process(b"{\"status\":\"400\"}"), "");
    }

    #[test]
    fn url_coding() {
        assert_eq!(enc("a b/c"), "a%20b%2Fc");
        assert_eq!(dec("a%20b+c%2F"), "a b c/");
    }

    #[test]
    fn identity_from_id_token() {
        let b = |s: &str| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s);
        let tok = |claims: &str| format!("{}.{}.sig", b(r#"{"alg":"RS256"}"#), b(claims));
        assert_eq!(id_token_identity(&tok(r#"{"email":"Jane@Gmail.com","name":"Jane Doe"}"#)), Some(("jane@gmail.com".into(), "Jane Doe".into())));
        // Microsoft personal accounts: no "email", the address is the preferred_username.
        assert_eq!(id_token_identity(&tok(r#"{"preferred_username":"joe@outlook.com"}"#)), Some(("joe@outlook.com".into(), String::new())));
        assert_eq!(id_token_identity(&tok(r#"{"preferred_username":"not-an-address"}"#)), None);
        assert_eq!(id_token_identity("garbage"), None);
    }
}
