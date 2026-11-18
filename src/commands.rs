//! Tauri commands invoked from the web UI.
//!
//! Every mail command takes an optional `account` id; when omitted, the first
//! account is used (keeps single-account callers working).

use crate::accounts::{self, AccountConfig, Credentials, Secret};
use crate::cache::Cache;
use crate::imap::{self, Imap};
use crate::model::*;
use crate::oauth;
use crate::providers::{self, AuthKind, Preset, Server};
use crate::smtp;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

/// One signed-in account and its background tasks.
pub struct AccountRuntime {
    pub cfg: Mutex<AccountConfig>,
    pub imap: Arc<Imap>,
    creds: Credentials,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    /// The new-mail watcher (restarted after sleep / network changes).
    idle: Mutex<Option<JoinHandle<()>>>,
}

impl AccountRuntime {
    fn id(&self) -> String {
        self.cfg.lock().unwrap().id.clone()
    }
    fn info(&self) -> AccountInfo {
        let c = self.cfg.lock().unwrap();
        AccountInfo {
            id: c.id.clone(),
            email: c.email.clone(),
            name: c.name.clone(),
            sender_name: c.sender_name.clone().unwrap_or_default(),
            provider: c.provider.clone(),
            auth: format!("{:?}", c.auth).to_lowercase(),
        }
    }
    fn stop(&self) {
        for t in self.tasks.lock().unwrap().drain(..) {
            t.abort();
        }
        if let Some(t) = self.idle.lock().unwrap().take() {
            t.abort();
        }
    }
    /// (Re)start the new-mail watcher.
    fn restart_idle(&self, app: &AppHandle) {
        let cfg = self.cfg.lock().unwrap().clone();
        let fresh = spawn_idle(app, cfg, self.creds.clone());
        if let Some(old) = self.idle.lock().unwrap().replace(fresh) {
            old.abort();
        }
    }
}

/// New-mail watcher (IMAP IDLE on INBOX) for one account.
fn spawn_idle(app: &AppHandle, cfg: AccountConfig, creds: Credentials) -> JoinHandle<()> {
    let (app2, id2) = (app.clone(), cfg.id.clone());
    let (app_a, id_a) = (app.clone(), cfg.id.clone());
    tauri::async_runtime::spawn(imap::idle_loop(
        cfg,
        creds,
        move || {
            let _ = app2.emit("mail-changed", id2.clone());
        },
        move || {
            let _ = app_a.emit("auth-required", id_a.clone());
        },
    ))
}

type PreviewKey = (String, String, u32, usize, u32);

#[derive(Default)]
pub struct AppState {
    accounts: Mutex<Vec<Arc<AccountRuntime>>>,
    /// Recently generated image previews: (account, folder, uid, index, max) -> data URL.
    previews: Mutex<VecDeque<(PreviewKey, String)>>,
    /// Contact photo thumbnails by account id, then lowercase email.
    photos: Arc<Mutex<HashMap<String, crate::contacts::PhotoMap>>>,
    /// Closing the window hides it to the notification area instead of quitting.
    pub run_in_background: std::sync::atomic::AtomicBool,
    /// Launched at Windows sign-in with "open in the background" (no window until asked).
    started_hidden: bool,
}

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    let s = format!("{e:#}");
    crate::applog::log("error", &s);
    s.strip_prefix("AUTH: ").unwrap_or(&s).to_string()
}

impl AppState {
    pub fn new(started_hidden: bool) -> Self {
        Self { started_hidden, ..Self::default() }
    }

    fn acct(&self, id: &Option<String>) -> CmdResult<Arc<AccountRuntime>> {
        let list = self.accounts.lock().unwrap();
        match id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => list.iter().find(|a| a.id() == id).cloned().ok_or_else(|| "That account is no longer available.".to_string()),
            None => list.first().cloned().ok_or_else(|| "Not signed in".to_string()),
        }
    }

    fn imap(&self, id: &Option<String>) -> CmdResult<Arc<Imap>> {
        Ok(self.acct(id)?.imap.clone())
    }

    fn infos(&self) -> Vec<AccountInfo> {
        self.accounts.lock().unwrap().iter().map(|a| a.info()).collect()
    }

    /// Start background work for an account and add it to the running list.
    fn start(&self, app: &AppHandle, cfg: AccountConfig, creds: Credentials) -> CmdResult<Arc<AccountRuntime>> {
        let cache = Arc::new(Cache::open(&cfg.email).map_err(err)?);
        let imap = Arc::new(Imap::new(cfg.clone(), creds.clone(), cache));
        let mut tasks = vec![];
        let idle = spawn_idle(app, cfg.clone(), creds.clone());
        // Contact photos (iCloud Contacts over CardDAV, password accounts only).
        if cfg.provider == "icloud" {
            if let Some(pw) = creds.password().map(|s| s.to_string()) {
                self.photos.lock().unwrap().insert(cfg.id.clone(), crate::contacts::load(&cfg.email));
                let (photos, app3, id3, email) = (self.photos.clone(), app.clone(), cfg.id.clone(), cfg.email.clone());
                tasks.push(tauri::async_runtime::spawn(async move {
                    loop {
                        if let Ok((map, _)) = crate::contacts::sync(&email, &pw).await {
                            photos.lock().unwrap().insert(id3.clone(), map);
                            let _ = app3.emit("contacts-updated", ());
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                    }
                }));
            }
        }
        let lookup = cfg.sender_name.is_none() && !cfg.sender_set_by_user;
        let rt = Arc::new(AccountRuntime { cfg: Mutex::new(cfg), imap, creds, tasks: Mutex::new(tasks), idle: Mutex::new(Some(idle)) });
        if lookup {
            spawn_sender_lookup(app, rt.clone(), std::time::Duration::from_secs(5));
        }
        let mut list = self.accounts.lock().unwrap();
        if let Some(pos) = list.iter().position(|a| a.id() == rt.id()) {
            list[pos].stop();
            list[pos] = rt.clone();
        } else {
            list.push(rt.clone());
        }
        Ok(rt)
    }
}

// ---------------------------------------------------------------- reliability & diagnostics

/// The PC woke up or the network came back: replace the new-mail watchers (their
/// connections are probably dead) and drop stale interactive connections.
#[tauri::command]
pub async fn restart_watchers(app: AppHandle, state: State<'_, AppState>, reason: Option<String>) -> CmdResult<()> {
    let list = state.accounts.lock().unwrap().clone();
    crate::applog::log("app", format!("restarting watchers ({})", reason.as_deref().unwrap_or("requested")));
    for a in list {
        a.restart_idle(&app);
        a.imap.reset_connections();
    }
    Ok(())
}

/// Something the UI wants in the diagnostic log (errors, refresh problems).
#[tauri::command]
pub fn log_event(kind: String, message: String) {
    let kind: String = kind.chars().filter(|c| c.is_ascii_alphanumeric()).take(16).collect();
    crate::applog::log(&format!("ui-{kind}"), message.chars().take(2000).collect::<String>());
}

/// Open Explorer with the diagnostic log selected.
#[tauri::command]
pub fn show_log_file() -> CmdResult<()> {
    let p = crate::applog::path().ok_or("No log folder")?;
    crate::applog::log("app", "log file opened from Settings");
    tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------- accounts

/// Start every saved account (connections are made lazily on first use).
#[tauri::command]
pub async fn restore_session(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Vec<AccountInfo>> {
    let store = accounts::load();
    for cfg in store.accounts {
        if state.accounts.lock().unwrap().iter().any(|a| a.id() == cfg.id) {
            continue;
        }
        let Some(secret) = accounts::get_secret(&cfg.id) else { continue };
        let creds = Credentials::for_account(&cfg, secret);
        state.start(&app, cfg, creds)?;
    }
    Ok(state.infos())
}

#[tauri::command]
pub async fn list_accounts(state: State<'_, AppState>) -> CmdResult<Vec<AccountInfo>> {
    Ok(state.infos())
}

/// Suggested settings for an email address (`None`: enter servers manually).
#[tauri::command]
pub async fn detect_provider(email: String) -> CmdResult<Option<Preset>> {
    Ok(providers::detect(&accounts::normalize_email(&email)).await)
}

/// Add an account. Password accounts are verified by logging in. Google / Microsoft
/// accounts sign in in the browser first, and the address comes from that sign-in (no
/// email needed). `imap`/`smtp` override auto-detected servers ("Other" provider).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn add_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: Option<String>,
    password: Option<String>,
    name: Option<String>,
    sender_name: Option<String>,
    auth: Option<AuthKind>,
    imap: Option<Server>,
    smtp: Option<Server>,
) -> CmdResult<AccountInfo> {
    let kind_asked = auth.unwrap_or(AuthKind::Password);
    // Browser sign-in: sign in first, to learn who signed in.
    let signed = if kind_asked != AuthKind::Password { Some(browser_sign_in(&app, kind_asked, None).await?) } else { None };
    let email = match &signed {
        Some(s) => s.email.clone(),
        None => accounts::normalize_email(&email.unwrap_or_default()),
    };
    if email.is_empty() {
        return Err("Enter your email address.".into());
    }
    let mut store = accounts::load();
    if store.accounts.iter().any(|a| a.email.eq_ignore_ascii_case(&email)) {
        return Err(format!("{email} is already added."));
    }
    // Google Workspace / Microsoft 365 addresses on their own domains use Gmail's / Outlook's servers.
    let fallback = || match kind_asked {
        AuthKind::Google => providers::by_provider("gmail"),
        AuthKind::Microsoft => providers::by_provider("outlook"),
        AuthKind::Password => None,
    };
    let preset = match (imap, smtp) {
        (Some(i), Some(s)) => Preset {
            provider: "other".into(),
            display: email.rsplit('@').next().unwrap_or("").into(),
            imap: i,
            smtp: s,
            auth: vec![AuthKind::Password],
            app_password_url: None,
            saves_sent: false,
        },
        _ => match providers::detect(&email).await.filter(|p| kind_asked == AuthKind::Password || p.auth.contains(&kind_asked)).or_else(fallback) {
            Some(p) => p,
            None => return Err("MANUAL: Enter the mail server settings for this account.".to_string()),
        },
    };
    let kind = auth.unwrap_or(preset.auth[0]);
    let label = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| accounts::provider_label(&preset.provider, &email));
    let mut cfg = accounts::from_preset(&email, &label, &preset, kind);
    // A typed sender name wins; otherwise it's looked up in the account's Sent mail.
    if let Some(s) = sender_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        cfg.sender_name = Some(s);
        cfg.sender_set_by_user = true;
    } else if let Some(n) = signed.as_ref().map(|s| s.name.clone()).filter(|n| !n.is_empty()) {
        cfg.sender_name = Some(n); // from the sign-in; Sent mail can still refine it
    }

    let (secret, creds) = match signed {
        Some(s) => oauth_creds(&cfg, s),
        None => sign_in_creds(&app, &cfg, password).await?,
    };
    // Verify the login before saving anything.
    verify_login(&cfg, &creds).await?;

    accounts::set_secret(&cfg.id, &secret).map_err(err)?;
    store.accounts.push(cfg.clone());
    accounts::save(&store).map_err(err)?;
    let rt = state.start(&app, cfg, creds)?;
    Ok(rt.info())
}

/// Normalise an app password: they're often shown as "abcd efgh ijkl mnop", and the
/// spaces are just a paste artefact.
pub(crate) fn clean_password(pw: Option<String>) -> Result<String, String> {
    let pw: String = pw.unwrap_or_default().chars().filter(|c| !c.is_whitespace()).collect();
    if pw.is_empty() {
        return Err("Enter your app password.".into());
    }
    Ok(pw)
}

/// Browser sign-in with Google / Microsoft (opens the system browser).
async fn browser_sign_in(app: &AppHandle, kind: AuthKind, login_hint: Option<&str>) -> CmdResult<oauth::SignInResult> {
    let app2 = app.clone();
    oauth::sign_in(kind, login_hint, move |url| {
        use tauri_plugin_opener::OpenerExt;
        app2.opener().open_url(url, None::<&str>).map_err(|e| anyhow::anyhow!("{e}"))
    })
    .await
    .map_err(err)
}

/// Runtime credentials from a browser sign-in. Returns (secret to store, credentials).
fn oauth_creds(cfg: &AccountConfig, signed: oauth::SignInResult) -> (String, Credentials) {
    let creds = Credentials::for_account(cfg, signed.refresh_token.clone());
    if let Secret::OAuth(ts) = &creds.secret {
        ts.seed(signed.access_token, signed.expires_in);
    }
    (signed.refresh_token, creds)
}

/// Obtain credentials for an account: the given app password, or a fresh browser sign-in
/// (as this account) for Microsoft / Google accounts. Returns (secret to store, credentials).
async fn sign_in_creds(app: &AppHandle, cfg: &AccountConfig, password: Option<String>) -> CmdResult<(String, Credentials)> {
    match cfg.auth {
        AuthKind::Password => {
            let pw = clean_password(password)?;
            Ok((pw.clone(), Credentials { email: cfg.email.clone(), secret: Secret::Password(pw) }))
        }
        kind => {
            let signed = browser_sign_in(app, kind, Some(&cfg.email)).await?;
            if !signed.email.eq_ignore_ascii_case(&cfg.email) {
                return Err(format!("You signed in as {}, but this account is {}. Sign in as {} instead.", signed.email, cfg.email, cfg.email));
            }
            Ok(oauth_creds(cfg, signed))
        }
    }
}

/// Check credentials with a real IMAP login (nothing is saved).
async fn verify_login(cfg: &AccountConfig, creds: &Credentials) -> CmdResult<()> {
    let probe = Imap::new(cfg.clone(), creds.clone(), Arc::new(Cache::in_memory().map_err(err)?));
    probe.open().await.map_err(err)?;
    probe.close().await;
    Ok(())
}

/// One-click re-sign-in for an account whose password or sign-in stopped working:
/// browser sign-in again (OAuth) or a new app password; then the account restarts.
#[tauri::command]
pub async fn reauth_account(app: AppHandle, state: State<'_, AppState>, account: String, password: Option<String>) -> CmdResult<AccountInfo> {
    let store = accounts::load();
    let cfg = store.accounts.iter().find(|a| a.id == account).cloned().ok_or("That account is no longer available.")?;
    let (secret, creds) = sign_in_creds(&app, &cfg, password).await?;
    verify_login(&cfg, &creds).await?;
    accounts::set_secret(&cfg.id, &secret).map_err(err)?;
    let rt = state.start(&app, cfg, creds)?;
    Ok(rt.info())
}

/// Remove an account: stops its background work and deletes its saved mail, photos and secret.
#[tauri::command]
pub async fn remove_account(state: State<'_, AppState>, account: String) -> CmdResult<()> {
    let rt = {
        let mut list = state.accounts.lock().unwrap();
        list.iter().position(|a| a.id() == account).map(|p| list.remove(p))
    };
    let mut store = accounts::load();
    let email = store.accounts.iter().find(|a| a.id == account).map(|a| a.email.clone());
    store.accounts.retain(|a| a.id != account);
    accounts::save(&store).map_err(err)?;
    state.photos.lock().unwrap().remove(&account);
    if let Some(rt) = rt {
        rt.stop();
        rt.imap.close().await;
        let email = rt.cfg.lock().unwrap().email.clone();
        crate::contacts::clear(&email);
        let cache = rt.imap.cache.clone();
        drop(rt);
        match Arc::try_unwrap(cache) {
            Ok(c) => c.destroy(),
            Err(_) => {
                let _ = std::fs::remove_file(crate::cache::path_for(&email));
            }
        }
    }
    if let Some(e) = email {
        accounts::delete_secret(&account, &e);
    }
    Ok(())
}

/// Sign out of every account (used by the single-account "Sign Out").
#[tauri::command]
pub async fn sign_out(state: State<'_, AppState>) -> CmdResult<()> {
    let ids: Vec<String> = state.accounts.lock().unwrap().iter().map(|a| a.id()).collect();
    for id in ids {
        remove_account(state.clone(), id).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_display_name(state: State<'_, AppState>, name: String, account: Option<String>) -> CmdResult<()> {
    let rt = state.acct(&account)?;
    let id = {
        let mut c = rt.cfg.lock().unwrap();
        c.name = name.trim().to_string();
        c.id.clone()
    };
    let mut store = accounts::load();
    if let Some(a) = store.accounts.iter_mut().find(|a| a.id == id) {
        a.name = name.trim().to_string();
    }
    accounts::save(&store).map_err(err)
}

/// Sort items by where their id appears in `order`; ids not in it keep their order at the end.
fn sort_by_order<T>(items: &mut [T], order: &[String], id: impl Fn(&T) -> String) {
    items.sort_by_key(|x| order.iter().position(|o| *o == id(x)).unwrap_or(usize::MAX));
}

/// The user dragged the accounts into a new order (sidebar / Settings).
#[tauri::command]
pub async fn reorder_accounts(state: State<'_, AppState>, order: Vec<String>) -> CmdResult<Vec<AccountInfo>> {
    let mut store = accounts::load();
    sort_by_order(&mut store.accounts, &order, |a| a.id.clone());
    accounts::save(&store).map_err(err)?;
    sort_by_order(&mut state.accounts.lock().unwrap(), &order, |a| a.id());
    Ok(state.infos())
}

#[cfg(test)]
mod order_tests {
    #[test]
    fn sorts_by_given_order_unknown_last() {
        let mut v = vec!["a", "b", "c", "d"];
        let order = vec!["c".to_string(), "a".to_string()];
        super::sort_by_order(&mut v, &order, |s| s.to_string());
        assert_eq!(v, ["c", "a", "b", "d"]);
    }
}

/// The name people see when you email them. Blank: look it up in Sent mail again.
#[tauri::command]
pub async fn set_sender_name(app: AppHandle, state: State<'_, AppState>, name: String, account: Option<String>) -> CmdResult<()> {
    let rt = state.acct(&account)?;
    let name = name.trim().to_string();
    let (sender, by_user) = if name.is_empty() { (None, false) } else { (Some(name), true) };
    let id = {
        let mut c = rt.cfg.lock().unwrap();
        c.sender_name = sender.clone();
        c.sender_set_by_user = by_user;
        c.id.clone()
    };
    let mut store = accounts::load();
    if let Some(a) = store.accounts.iter_mut().find(|a| a.id == id) {
        a.sender_name = sender.clone();
        a.sender_set_by_user = by_user;
    }
    accounts::save(&store).map_err(err)?;
    if sender.is_none() {
        spawn_sender_lookup(&app, rt.clone(), std::time::Duration::from_secs(0));
    }
    Ok(())
}

/// Find the sender name the provider uses (the From name on the account's own Sent
/// mail) and remember it, unless the user typed one.
fn spawn_sender_lookup(app: &AppHandle, rt: Arc<AccountRuntime>, delay: std::time::Duration) {
    let app = app.clone();
    let rt2 = rt.clone();
    let task = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let Ok(Some(name)) = rt2.imap.sent_name().await else { return };
        let id = {
            let mut c = rt2.cfg.lock().unwrap();
            if c.sender_name.is_some() || c.sender_set_by_user {
                return;
            }
            c.sender_name = Some(name.clone());
            c.id.clone()
        };
        let mut store = accounts::load();
        if let Some(a) = store.accounts.iter_mut().find(|a| a.id == id && a.sender_name.is_none() && !a.sender_set_by_user) {
            a.sender_name = Some(name);
            let _ = accounts::save(&store);
        }
        crate::applog::log("app", format!("account {id}: sender name found in Sent mail"));
        let _ = app.emit("accounts-updated", ());
    });
    rt.tasks.lock().unwrap().push(task);
}

// ---------------------------------------------------------------- mail

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>, account: Option<String>) -> CmdResult<Vec<Folder>> {
    state.imap(&account)?.list_folders().await.map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn list_messages(
    state: State<'_, AppState>,
    account: Option<String>,
    folder: String,
    filter: Option<String>,
    query: Option<String>,
    vip: Option<Vec<String>>,
    offset: Option<usize>,
    limit: Option<usize>,
    sort: Option<String>,
) -> CmdResult<MessagePage> {
    state
        .imap(&account)?
        .list_messages(
            &folder,
            filter.as_deref().unwrap_or("all"),
            query.as_deref().unwrap_or(""),
            &vip.unwrap_or_default(),
            offset.unwrap_or(0),
            limit.unwrap_or(50).clamp(1, 200),
            sort.as_deref() == Some("oldest"),
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_message(
    state: State<'_, AppState>,
    account: Option<String>,
    folder: String,
    uid: u32,
    mark_seen: Option<bool>,
    allow_partial: Option<bool>,
) -> CmdResult<MessageDetail> {
    let folder = imap::real_folder(&folder);
    state.imap(&account)?.get_message(&folder, uid, mark_seen.unwrap_or(true), allow_partial.unwrap_or(false)).await.map_err(err)
}

#[tauri::command]
pub async fn set_flag(state: State<'_, AppState>, account: Option<String>, folder: String, uids: Vec<u32>, flag: String, on: bool) -> CmdResult<()> {
    let f = match flag.as_str() {
        "seen" => "\\Seen",
        "flagged" => "\\Flagged",
        "answered" => "\\Answered",
        _ => return Err("unknown flag".into()),
    };
    state.imap(&account)?.set_flag(&folder, &uids, f, on).await.map_err(err)
}

#[tauri::command]
pub async fn move_messages(state: State<'_, AppState>, account: Option<String>, folder: String, uids: Vec<u32>, dest: String) -> CmdResult<()> {
    state.imap(&account)?.move_messages(&folder, &uids, &dest).await.map_err(err)
}

/// Move to a special folder by role (archive / junk / inbox).
#[tauri::command]
pub async fn move_to_role(state: State<'_, AppState>, account: Option<String>, folder: String, uids: Vec<u32>, role: String) -> CmdResult<()> {
    let imap = state.imap(&account)?;
    let dest = if role == "inbox" {
        "INBOX".to_string()
    } else {
        match imap.role_path(&role) {
            Some(p) => p,
            None => {
                let _ = imap.list_folders().await;
                imap.role_path(&role).ok_or_else(|| format!("No {role} mailbox found"))?
            }
        }
    };
    imap.move_messages(&folder, &uids, &dest).await.map_err(err)
}

#[tauri::command]
pub async fn delete_messages(state: State<'_, AppState>, account: Option<String>, folder: String, uids: Vec<u32>) -> CmdResult<()> {
    let imap = state.imap(&account)?;
    if imap.role_path("trash").is_none() {
        let _ = imap.list_folders().await;
    }
    imap.delete_messages(&folder, &uids).await.map_err(err)
}

async fn sent_or_drafts(imap: &Imap, role: &str, fallback: &str) -> String {
    if imap.role_path(role).is_none() {
        let _ = imap.list_folders().await;
    }
    imap.role_path(role).unwrap_or_else(|| fallback.to_string())
}

#[tauri::command]
/// Returns the Message-ID, so the app can show the sent message right away and match it later.
pub async fn send_message(app: AppHandle, state: State<'_, AppState>, account: Option<String>, message: OutgoingMessage) -> CmdResult<String> {
    let rt = state.acct(&account)?;
    let cfg = rt.cfg.lock().unwrap().clone();
    let imap = rt.imap.clone();
    let sender = cfg.sender_name.clone().unwrap_or_default();
    let (msg, mid) = smtp::build(&cfg.email, &sender, &message, false, None).map_err(err)?;
    // Same Message-ID on the copy kept in Sent as on what recipients get (threading).
    let (sent_copy, _) = smtp::build(&cfg.email, &sender, &message, true, Some(&mid)).map_err(err)?;
    if let Err(e) = smtp::send(&cfg, &imap.creds, msg).await {
        // Password or token turned down: show the "Sign in again" banner right away.
        if e.to_string().starts_with("AUTH:") {
            let _ = app.emit("auth-required", cfg.id.clone());
        }
        return Err(err(e));
    }
    // Gmail and Outlook file sent mail themselves; others need a copy in Sent.
    if !cfg.saves_sent {
        let sent = sent_or_drafts(&imap, "sent", "Sent Messages").await;
        let _ = imap.append(&sent, "(\\Seen)", sent_copy.formatted()).await;
    }
    if let Some(d) = message.draft_uid {
        let drafts = sent_or_drafts(&imap, "drafts", "Drafts").await;
        let _ = imap.purge(&drafts, &[d]).await;
    }
    Ok(mid)
}

/// Save (or replace) a draft. Returns the new draft UID if it can be found.
#[tauri::command]
pub async fn save_draft(state: State<'_, AppState>, account: Option<String>, message: OutgoingMessage) -> CmdResult<Option<u32>> {
    let rt = state.acct(&account)?;
    let cfg = rt.cfg.lock().unwrap().clone();
    let imap = rt.imap.clone();
    let (msg, mid) = smtp::build(&cfg.email, &cfg.sender_name.clone().unwrap_or_default(), &message, true, None).map_err(err)?;
    let drafts = sent_or_drafts(&imap, "drafts", "Drafts").await;
    let uid = imap.append_and_find(&drafts, "(\\Seen \\Draft)", msg.formatted(), &mid).await.map_err(err)?;
    if let Some(old) = message.draft_uid.filter(|old| Some(*old) != uid) {
        // Replace the older draft permanently rather than sending it to the trash.
        let _ = imap.purge(&drafts, &[old]).await;
    }
    if uid.is_none() {
        // The next save can't replace this copy, so it would be left behind in Drafts.
        crate::applog::log("draft", "saved, but its UID wasn't found");
    }
    Ok(uid)
}

/// Copy a message's attachments into the outgoing staging folder, so a resumed draft
/// keeps them when it's saved again or sent.
#[tauri::command]
pub async fn stage_message_attachments(state: State<'_, AppState>, account: Option<String>, folder: String, uid: u32) -> CmdResult<Vec<PickedFile>> {
    let folder = imap::real_folder(&folder);
    let imap = state.imap(&account)?;
    // Same list (and order) the UI shows; inline pictures stay in the body.
    let listed = imap.get_message(&folder, uid, false, false).await.map_err(err)?.attachments;
    let mut out = Vec::with_capacity(listed.len());
    for a in listed {
        let (_name, _mime, bytes) = imap.attachment(&folder, uid, a.index).await.map_err(err)?;
        out.push(stage_bytes(&a.name, &bytes)?);
    }
    Ok(out)
}

#[tauri::command]
pub async fn discard_draft(state: State<'_, AppState>, account: Option<String>, uid: u32) -> CmdResult<()> {
    let imap = state.imap(&account)?;
    let drafts = sent_or_drafts(&imap, "drafts", "Drafts").await;
    imap.delete_messages(&drafts, &[uid]).await.map_err(err)
}

async fn save_bytes_dialog(app: &AppHandle, name: &str, bytes: Vec<u8>) -> CmdResult<bool> {
    let path = app.dialog().file().set_file_name(name).set_directory(dirs::download_dir().unwrap_or_default()).blocking_save_file();
    match path.and_then(|p| p.into_path().ok()) {
        Some(p) => {
            std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub async fn save_attachment(app: AppHandle, state: State<'_, AppState>, account: Option<String>, folder: String, uid: u32, index: usize) -> CmdResult<bool> {
    let folder = imap::real_folder(&folder);
    let (name, _mime, bytes) = state.imap(&account)?.attachment(&folder, uid, index).await.map_err(err)?;
    save_bytes_dialog(&app, &name, bytes).await
}

/// A file name Windows accepts: reserved characters replaced, never empty.
fn safe_file_name(name: &str) -> String {
    let s: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() { "attachment".into() } else { s }
}

/// Decode a percent-encoded (encodeURIComponent) string.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Where files dropped into a compose window are copied until the message is sent.
fn staging_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("PearMail").join("outgoing")
}

/// Remove staged attachments older than a week (sent or abandoned long ago).
pub fn clean_staging() {
    let Ok(rd) = std::fs::read_dir(staging_dir()) else { return };
    let week = std::time::Duration::from_secs(7 * 24 * 3600);
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d > week).unwrap_or(false);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// A file dropped into the compose window: its bytes arrive as the raw request body,
/// its name in the x-name header. Saved to a private folder so it can be sent by path.
#[tauri::command]
pub async fn stage_attachment(request: tauri::ipc::Request<'_>) -> CmdResult<PickedFile> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("No file data.".into()) };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    stage_bytes(&name, bytes)
}

/// Write one file into its own new folder under the staging dir.
fn stage_bytes(name: &str, bytes: &[u8]) -> CmdResult<PickedFile> {
    let name = safe_file_name(name);
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = staging_dir().join(format!("{stamp:x}-{}", N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    std::fs::write(&path, bytes).map_err(|e| format!("Could not attach {name}: {e}"))?;
    Ok(PickedFile { name, size: bytes.len() as u64, path: path.to_string_lossy().to_string() })
}

#[cfg(test)]
mod stage_tests {
    #[test]
    fn names() {
        assert_eq!(super::percent_decode("R%C3%A9sum%C3%A9%20v2.pdf"), "Résumé v2.pdf");
        assert_eq!(super::percent_decode("100%"), "100%");
        assert_eq!(super::safe_file_name("a/b:c?.txt"), "a_b_c_.txt");
        assert_eq!(super::safe_file_name(" .. "), "attachment");
    }
}

#[tauri::command]
pub async fn open_attachment(app: AppHandle, state: State<'_, AppState>, account: Option<String>, folder: String, uid: u32, index: usize) -> CmdResult<String> {
    let folder = imap::real_folder(&folder);
    let (name, _mime, bytes) = state.imap(&account)?.attachment(&folder, uid, index).await.map_err(err)?;
    let dir = std::env::temp_dir().join("PearMail");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join(safe_file_name(&name));
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

/// An attachment's raw bytes, for previews in the app (arrive as an ArrayBuffer).
#[tauri::command]
pub async fn attachment_data(state: State<'_, AppState>, account: Option<String>, folder: String, uid: u32, index: usize) -> CmdResult<tauri::ipc::Response> {
    let folder = imap::real_folder(&folder);
    let (_name, _mime, bytes) = state.imap(&account)?.attachment(&folder, uid, index).await.map_err(err)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn raw_source(state: State<'_, AppState>, account: Option<String>, folder: String, uid: u32) -> CmdResult<String> {
    let raw = state.imap(&account)?.raw_message(&imap::real_folder(&folder), uid).await.map_err(err)?;
    Ok(String::from_utf8_lossy(&raw).to_string())
}

#[tauri::command]
pub async fn pick_files(app: AppHandle) -> CmdResult<Vec<PickedFile>> {
    let files = app.dialog().file().blocking_pick_files().unwrap_or_default();
    Ok(files
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| PickedFile {
            name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            size: std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0),
            path: p.to_string_lossy().to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn folder_op(state: State<'_, AppState>, account: Option<String>, op: String, path: String, new_path: Option<String>) -> CmdResult<()> {
    state.imap(&account)?.folder_op(&op, &path, new_path.as_deref()).await.map_err(err)
}

#[tauri::command]
pub async fn cached_folders(state: State<'_, AppState>, account: Option<String>) -> CmdResult<Option<Vec<Folder>>> {
    Ok(state.imap(&account)?.cached_folders())
}

#[tauri::command]
pub async fn cached_messages(
    state: State<'_, AppState>,
    account: Option<String>,
    folder: String,
    filter: Option<String>,
    vip: Option<Vec<String>>,
    limit: Option<usize>,
) -> CmdResult<MessagePage> {
    Ok(state.imap(&account)?.cached_messages(&folder, filter.as_deref().unwrap_or("all"), &vip.unwrap_or_default(), limit.unwrap_or(100)))
}

/// Download bodies in the background on a separate connection. Returns how many were fetched.
#[tauri::command]
pub async fn prefetch(state: State<'_, AppState>, account: Option<String>, folder: String, uids: Vec<u32>) -> CmdResult<usize> {
    state.imap(&account)?.prefetch(&folder, &uids).await.map_err(err)
}

fn cached_preview(state: &AppState, key: &PreviewKey) -> Option<String> {
    state.previews.lock().unwrap().iter().find(|(k, _)| k == key).map(|(_, u)| u.clone())
}

fn remember_preview(state: &AppState, key: PreviewKey, url: &str) {
    let mut p = state.previews.lock().unwrap();
    p.push_back((key, url.to_string()));
    while p.len() > 96 {
        p.pop_front();
    }
}

/// Preview of an image attachment (TIFF etc. converted), scaled to `max` px.
#[tauri::command]
pub async fn attachment_preview(
    state: State<'_, AppState>,
    account: Option<String>,
    folder: String,
    uid: u32,
    index: usize,
    max: Option<u32>,
) -> CmdResult<Option<String>> {
    use base64::Engine;
    let folder = imap::real_folder(&folder);
    let rt = state.acct(&account)?;
    let max = max.unwrap_or(400).clamp(64, 4096);
    let key = (rt.id(), folder.clone(), uid, index, max);
    if let Some(u) = cached_preview(&state, &key) {
        return Ok(Some(u));
    }
    let (_name, mime, bytes) = rt.imap.attachment(&folder, uid, index).await.map_err(err)?;
    if !crate::mime::decodable_image(&mime) {
        return Ok(None);
    }
    let enc = tauri::async_runtime::spawn_blocking(move || crate::mime::image_preview(&bytes, max)).await.map_err(|e| e.to_string())?;
    let url = enc.map(|(m, b)| format!("data:{m};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
    if let Some(u) = &url {
        remember_preview(&state, key, u);
    }
    Ok(url)
}

/// Save an image attachment converted to PNG (handy for TIFFs).
#[tauri::command]
pub async fn save_attachment_png(app: AppHandle, state: State<'_, AppState>, account: Option<String>, folder: String, uid: u32, index: usize) -> CmdResult<bool> {
    let folder = imap::real_folder(&folder);
    let (name, _mime, bytes) = state.imap(&account)?.attachment(&folder, uid, index).await.map_err(err)?;
    let png = tauri::async_runtime::spawn_blocking(move || crate::mime::image_to_png(&bytes, None))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("This image can't be converted.")?;
    let stem = name.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(name);
    save_bytes_dialog(&app, &format!("{stem}.png"), png).await
}

/// An embedded (cid) image for display in a message: the original data when the
/// WebView can show it, otherwise a converted copy.
#[tauri::command]
pub async fn inline_image(state: State<'_, AppState>, account: Option<String>, folder: String, uid: u32, index: usize) -> CmdResult<Option<String>> {
    use base64::Engine;
    let folder = imap::real_folder(&folder);
    let rt = state.acct(&account)?;
    let key = (rt.id(), folder.clone(), uid, index, 0u32);
    if let Some(u) = cached_preview(&state, &key) {
        return Ok(Some(u));
    }
    let (_name, mime, bytes) = rt.imap.attachment(&folder, uid, index).await.map_err(err)?;
    let url = if crate::mime::web_renderable(&mime) {
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
    } else if crate::mime::decodable_image(&mime) {
        tauri::async_runtime::spawn_blocking(move || crate::mime::image_preview(&bytes, 2000))
            .await
            .map_err(|e| e.to_string())?
            .map(|(m, b)| format!("data:{m};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
    } else {
        None
    };
    if let Some(u) = &url {
        remember_preview(&state, key, u);
    }
    Ok(url)
}

/// Contact photo thumbnails (data URLs) keyed by lowercase email, merged across accounts.
#[tauri::command]
pub async fn contact_photos(state: State<'_, AppState>) -> CmdResult<crate::contacts::PhotoMap> {
    let mut out = crate::contacts::PhotoMap::new();
    for m in state.photos.lock().unwrap().values() {
        out.extend(m.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::clean_password;

    #[test]
    fn app_passwords_are_normalised() {
        assert_eq!(clean_password(Some("abcd efgh ijkl mnop".into())).unwrap(), "abcdefghijklmnop");
        assert_eq!(clean_password(Some(" x-y\t".into())).unwrap(), "x-y");
        assert!(clean_password(Some("   ".into())).is_err());
        assert!(clean_password(None).is_err());
    }
}

/// New-mail notification shown as "Pear Mail" with the app icon. Clicking it brings the
/// window forward and tells the UI what to open (`target`: the message, or its inbox).
#[tauri::command]
pub async fn show_notification(app: AppHandle, title: String, body: String, target: Option<serde_json::Value>) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::notify::show(&title, &body, move || {
            show_main(&app);
            let _ = app.emit("notification-clicked", target.clone());
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// All messages of a conversation (this folder, Inbox, Sent, Archive), oldest first.
/// Cache the newest messages of a special folder (Sent) in the background.
#[tauri::command]
pub async fn sync_recent(state: State<'_, AppState>, account: Option<String>, role: String, limit: Option<usize>) -> CmdResult<usize> {
    state.imap(&account)?.sync_recent(&role, limit.unwrap_or(400).min(2000)).await.map_err(err)
}

#[tauri::command]
pub async fn get_thread(state: State<'_, AppState>, account: Option<String>, folder: String, ids: Vec<String>) -> CmdResult<Vec<MessageSummary>> {
    state.imap(&account)?.get_thread(&folder, &ids).await.map_err(err)
}

/// Bring the main window forward (from the tray, a toast or a second launch).
pub fn show_main(app: &AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Current version and any downloaded, verified update.
#[tauri::command]
pub fn update_status() -> crate::updater::UpdateStatus {
    crate::updater::status()
}

/// Look for a newer release on GitHub and download + verify it in the background.
#[tauri::command]
pub async fn check_for_update() -> CmdResult<crate::updater::UpdateStatus> {
    crate::updater::check_and_download().await.map_err(|e| {
        crate::applog::log("update", format!("check failed: {e:#}"));
        "Couldn't check for updates. Try again later.".to_string()
    })
}

/// Install the downloaded update and start it.
#[tauri::command]
pub fn restart_to_update(app: AppHandle) -> CmdResult<()> {
    crate::updater::apply_and_relaunch().map_err(|e| {
        crate::applog::log("update", format!("install failed: {e:#}"));
        format!("Couldn't install the update: {e}")
    })?;
    app.exit(0);
    Ok(())
}

/// Whether this launch should stay in the notification area (Windows sign-in, background mode).
#[tauri::command]
pub fn started_hidden(state: State<'_, AppState>) -> bool {
    state.started_hidden
}

/// "Open Pear Mail when I sign in to Windows" and whether it opens in the background.
#[tauri::command]
pub fn get_open_at_login() -> crate::startup::OpenAtLogin {
    crate::startup::get()
}

#[tauri::command]
pub fn set_open_at_login(on: bool, background: bool) -> CmdResult<()> {
    crate::startup::set(on, background)?;
    crate::applog::log("startup", if !on { "open at sign-in: off" } else if background { "open at sign-in: background" } else { "open at sign-in: window" });
    Ok(())
}

/// "Keep running in the background": with it on, closing the window leaves Pear Mail in
/// the notification area (double-click opens it, right-click → Exit Pear Mail quits).
#[tauri::command]
pub fn set_run_in_background(app: AppHandle, state: State<'_, AppState>, on: bool) -> CmdResult<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
    state.run_in_background.store(on, std::sync::atomic::Ordering::Relaxed);
    if !on {
        let _ = app.remove_tray_by_id("main");
        return Ok(());
    }
    if app.tray_by_id("main").is_some() {
        return Ok(());
    }
    let open = MenuItem::with_id(&app, "open", "Open Pear Mail", true, None::<&str>).map_err(|e| e.to_string())?;
    let exit = MenuItem::with_id(&app, "exit", "Exit Pear Mail", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&open, &exit]).map_err(|e| e.to_string())?;
    let mut b = TrayIconBuilder::with_id("main")
        .tooltip("Pear Mail")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show_main(app),
            "exit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = e {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(&app).map_err(|e| e.to_string())?;
    Ok(())
}
