//! Self-update from GitHub Releases (Pear Mail is a single portable exe).
//!
//! Check `releases/latest`, download `pearmail.exe` + `pearmail.exe.sig`, and accept it only
//! if its SHA-256 matches GitHub's digest **and** it carries a valid Ed25519 signature from the
//! release key (public half below; the private key never leaves the developer's PC, see
//! examples/release_key.rs). The verified exe replaces the running one on restart or quit:
//! Windows lets a running exe be renamed, so it's moved aside to pearmail.old.exe.

use anyhow::{anyhow, bail, Context, Result};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// Public half of the release signing key (hex).
const RELEASE_PUBLIC_KEY: &str = "b7c274727e45a1d2b5ade70d127a719a72d0a76340d9771575d1564b513adbeb";
const LATEST_URL: &str = "https://api.github.com/repos/romanmgelman/pearmail/releases/latest";
const ASSET: &str = "pearmail.exe";
const SIG_ASSET: &str = "pearmail.exe.sig";
/// Far bigger than the app (~22 MB); anything larger is refused.
const MAX_EXE: usize = 120 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes_url: String,
    #[serde(skip)]
    asset_url: String,
    #[serde(skip)]
    sig_url: String,
    /// "sha256:<hex>" as GitHub reports it ("" if it didn't).
    #[serde(skip)]
    digest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    /// A newer version that has been downloaded and verified.
    pub ready: Option<UpdateInfo>,
    /// Pear Mail can replace its own exe (not e.g. in a protected folder).
    pub can_apply: bool,
}

/// The verified update waiting to be installed, and where it was saved.
static READY: Mutex<Option<(UpdateInfo, PathBuf, String)>> = Mutex::new(None);

/// (major, minor, patch) of "v1.2.3" / "1.2.3". Pre-releases ("1.2.3-beta") are not offered.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    if s.contains('-') || s.contains('+') {
        return None;
    }
    let mut it = s.split('.').map(|p| p.parse::<u64>().ok());
    let v = (it.next()??, it.next()??, it.next()??);
    if it.next().is_some() {
        return None;
    }
    Some(v)
}

pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// Only GitHub over HTTPS (API, release pages, and the download CDN).
fn allowed_url(u: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(u) else { return false };
    #[cfg(debug_assertions)]
    if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") {
        return true; // local end-to-end test server (debug builds only)
    }
    if url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host == "github.com" || host == "api.github.com" || host.ends_with(".githubusercontent.com")
}

fn http() -> Result<reqwest::Client> {
    let policy = reqwest::redirect::Policy::custom(|a| if a.previous().len() < 5 && allowed_url(a.url().as_str()) { a.follow() } else { a.stop() });
    Ok(reqwest::Client::builder()
        .user_agent(concat!("PearMail/", env!("CARGO_PKG_VERSION")))
        .redirect(policy)
        .timeout(Duration::from_secs(300))
        .build()?)
}

async fn get(client: &reqwest::Client, url: &str, max: usize) -> Result<Vec<u8>> {
    if !allowed_url(url) {
        bail!("refusing to download from {url}");
    }
    let r = client.get(url).header("Accept", "application/octet-stream, application/vnd.github+json").send().await?;
    if !r.status().is_success() {
        bail!("{url}: HTTP {}", r.status());
    }
    if r.content_length().is_some_and(|n| n as usize > max) {
        bail!("{url}: too large");
    }
    let b = r.bytes().await?;
    if b.len() > max {
        bail!("{url}: too large");
    }
    Ok(b.to_vec())
}

fn latest_url() -> String {
    #[cfg(debug_assertions)]
    if let Ok(u) = std::env::var("PEARMAIL_UPDATE_URL") {
        return u;
    }
    LATEST_URL.to_string()
}

/// Read GitHub's "latest release" answer. None: nothing usable (draft, pre-release, no
/// signed exe).
pub fn parse_release(json: &[u8]) -> Option<UpdateInfo> {
    let v: serde_json::Value = serde_json::from_slice(json).ok()?;
    if v["draft"].as_bool() == Some(true) || v["prerelease"].as_bool() == Some(true) {
        return None;
    }
    let version = v["tag_name"].as_str()?.trim_start_matches(['v', 'V']).to_string();
    parse_version(&version)?;
    let assets = v["assets"].as_array()?;
    let find = |name: &str| assets.iter().find(|a| a["name"].as_str() == Some(name));
    let exe = find(ASSET)?;
    let sig = find(SIG_ASSET)?;
    Some(UpdateInfo {
        version,
        notes_url: v["html_url"].as_str().unwrap_or("https://github.com/romanmgelman/pearmail/releases").to_string(),
        asset_url: exe["browser_download_url"].as_str()?.to_string(),
        sig_url: sig["browser_download_url"].as_str()?.to_string(),
        digest: exe["digest"].as_str().unwrap_or("").to_string(),
    })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// The exe is the one GitHub describes (digest) and was signed with the release key.
pub fn verify(exe: &[u8], sig_hex: &str, digest: &str, public_key_hex: &str) -> Result<()> {
    if let Some(want) = digest.strip_prefix("sha256:") {
        if !hex(&Sha256::digest(exe)).eq_ignore_ascii_case(want.trim()) {
            bail!("download doesn't match GitHub's checksum");
        }
    }
    let key: [u8; 32] = unhex(public_key_hex).and_then(|k| k.try_into().ok()).ok_or_else(|| anyhow!("bad public key"))?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| anyhow!("bad public key"))?;
    let sig: [u8; 64] = unhex(sig_hex).and_then(|k| k.try_into().ok()).ok_or_else(|| anyhow!("bad signature file"))?;
    key.verify(exe, &Signature::from_bytes(&sig)).map_err(|_| anyhow!("signature check failed"))
}

fn update_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("PearMail").join("update")
}

fn old_exe(cur: &Path) -> PathBuf {
    cur.with_file_name("pearmail.old.exe")
}

/// Whether Pear Mail may put a new file next to its own exe.
pub fn can_apply() -> bool {
    let Ok(cur) = std::env::current_exe() else { return false };
    let probe = cur.with_file_name(".pearmail-write-test");
    let ok = std::fs::write(&probe, b"x").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

pub fn status() -> UpdateStatus {
    UpdateStatus {
        current: env!("CARGO_PKG_VERSION").to_string(),
        ready: READY.lock().unwrap().as_ref().map(|(i, _, _)| i.clone()),
        can_apply: can_apply(),
    }
}

/// Look for a newer release; download and verify it. Ok(status) either way.
pub async fn check_and_download() -> Result<UpdateStatus> {
    if READY.lock().unwrap().is_some() {
        return Ok(status());
    }
    let client = http()?;
    let json = get(&client, &latest_url(), 2 * 1024 * 1024).await.context("update check")?;
    let Some(info) = parse_release(&json) else { return Ok(status()) };
    if !is_newer(&info.version, env!("CARGO_PKG_VERSION")) {
        return Ok(status());
    }
    let dir = update_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("pearmail-{}.exe", info.version));
    let sig = String::from_utf8_lossy(&get(&client, &info.sig_url, 4096).await?).to_string();
    // Already downloaded earlier (e.g. before a restart)? Check it again rather than re-fetch.
    let exe = match std::fs::read(&path) {
        Ok(b) if verify(&b, &sig, &info.digest, RELEASE_PUBLIC_KEY).is_ok() => b,
        _ => get(&client, &info.asset_url, MAX_EXE).await?,
    };
    if let Err(e) = verify(&exe, &sig, &info.digest, RELEASE_PUBLIC_KEY) {
        let _ = std::fs::remove_file(&path);
        crate::applog::log("update", format!("{} refused: {e}", info.version));
        return Err(e);
    }
    std::fs::write(&path, &exe)?;
    crate::applog::log("update", format!("{} downloaded and verified", info.version));
    *READY.lock().unwrap() = Some((info, path, sig));
    Ok(status())
}

/// Put the downloaded exe in place of the running one. Returns the exe path to start.
fn apply() -> Result<Option<PathBuf>> {
    let Some((info, new, sig)) = READY.lock().unwrap().take() else { return Ok(None) };
    let cur = std::env::current_exe()?;
    let old = old_exe(&cur);
    // Check once more: the file sat on disk since it was verified.
    let bytes = std::fs::read(&new).context("downloaded update is missing")?;
    verify(&bytes, &sig, &info.digest, RELEASE_PUBLIC_KEY)?;
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&cur, &old).context("couldn't move the current version aside")?;
    if let Err(e) = std::fs::write(&cur, &bytes) {
        let _ = std::fs::remove_file(&cur);
        let _ = std::fs::rename(&old, &cur);
        return Err(anyhow!(e).context("couldn't write the new version"));
    }
    let _ = std::fs::remove_file(&new);
    crate::applog::log("update", format!("installed {}", info.version));
    Ok(Some(cur))
}

/// Install now and start the new version (it waits for this process to exit).
pub fn apply_and_relaunch() -> Result<()> {
    let exe = apply()?.ok_or_else(|| anyhow!("No update is ready."))?;
    std::process::Command::new(&exe).arg("--after-update").arg(std::process::id().to_string()).spawn().context("couldn't start the new version")?;
    Ok(())
}

/// On quit: install a waiting update so the next launch is the new version.
pub fn apply_on_exit() {
    if let Err(e) = apply() {
        crate::applog::log("update", format!("not installed on quit: {e:#}"));
    }
}

/// At startup: remove the previous version and leftover downloads.
pub fn cleanup() {
    if let Ok(cur) = std::env::current_exe() {
        let old = old_exe(&cur);
        if old.exists() {
            let _ = std::fs::remove_file(&old);
        }
    }
    if let Ok(entries) = std::fs::read_dir(update_dir()) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let ver = name.strip_prefix("pearmail-").and_then(|n| n.strip_suffix(".exe")).unwrap_or("");
            if !is_newer(ver, env!("CARGO_PKG_VERSION")) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Started by an update: wait (briefly) for the old process to finish, so the single-instance
/// check doesn't hand this launch over to the copy that is closing.
pub fn wait_for_previous(pid: u32) {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(h, 15_000);
            let _ = CloseHandle(h);
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn versions_compare_and_skip_prereleases() {
        assert!(is_newer("0.1.6", "0.1.5"));
        assert!(is_newer("v0.2.0", "0.1.9"));
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(!is_newer("0.1.5", "0.1.5"));
        assert!(!is_newer("0.1.4", "0.1.5"));
        assert!(!is_newer("0.1.6-beta", "0.1.5"));
        assert!(!is_newer("garbage", "0.1.5"));
    }

    #[test]
    fn only_github_over_https() {
        assert!(allowed_url("https://api.github.com/repos/x/y/releases/latest"));
        assert!(allowed_url("https://github.com/romanmgelman/pearmail/releases/download/v0.1.6/pearmail.exe"));
        assert!(allowed_url("https://release-assets.githubusercontent.com/github-production-release-asset/1"));
        assert!(!allowed_url("http://github.com/x"));
        assert!(!allowed_url("https://github.com.evil.example/x"));
        assert!(!allowed_url("https://example.com/pearmail.exe"));
    }

    #[test]
    fn verifies_digest_and_signature() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let public = hex(key.verifying_key().as_bytes());
        let exe = b"pretend this is pearmail.exe".to_vec();
        let sig = hex(&key.sign(&exe).to_bytes());
        let digest = format!("sha256:{}", hex(&Sha256::digest(&exe)));
        assert!(verify(&exe, &sig, &digest, &public).is_ok());
        assert!(verify(&exe, &sig, "", &public).is_ok());
        // Tampered file: fails the checksum, and the signature without one.
        let mut bad = exe.clone();
        bad[0] ^= 1;
        assert!(verify(&bad, &sig, &digest, &public).is_err());
        assert!(verify(&bad, &sig, "", &public).is_err());
        // Signed by someone else.
        let other = SigningKey::from_bytes(&[9u8; 32]);
        assert!(verify(&exe, &hex(&other.sign(&exe).to_bytes()), &digest, &public).is_err());
    }

    #[test]
    fn reads_release_json() {
        let json = br#"{"tag_name":"v0.1.6","html_url":"https://github.com/romanmgelman/pearmail/releases/tag/v0.1.6","draft":false,"prerelease":false,
          "assets":[{"name":"pearmail.exe","browser_download_url":"https://github.com/a/pearmail.exe","digest":"sha256:ab"},
                    {"name":"pearmail.exe.sig","browser_download_url":"https://github.com/a/pearmail.exe.sig"}]}"#;
        let i = parse_release(json).unwrap();
        assert_eq!(i.version, "0.1.6");
        assert_eq!(i.digest, "sha256:ab");
        // No signature uploaded: not offered.
        let unsigned = br#"{"tag_name":"v0.1.6","assets":[{"name":"pearmail.exe","browser_download_url":"https://github.com/a/pearmail.exe"}]}"#;
        assert!(parse_release(unsigned).is_none());
    }
}
