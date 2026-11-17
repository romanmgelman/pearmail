//! IMAP access (any provider) using async-imap over native TLS, backed by the
//! on-disk cache in `cache.rs`.

use crate::accounts::{AccountConfig, Credentials, Secret};
use crate::providers::Security;
use crate::cache::{Cache, MAX_CACHED_BODY};
use crate::mime;
use crate::model::*;
use anyhow::{anyhow, bail, Context, Result};
use async_imap::imap_proto::types::{BodyStructure, NameAttribute};
use async_imap::types::{Fetch, Flag};
use futures::future::BoxFuture;
use futures::TryStreamExt;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;

pub type Tls = tokio_native_tls::TlsStream<TcpStream>;
pub type Session = async_imap::Session<Tls>;

pub const VIRTUAL_FLAGGED: &str = "__flagged__";
pub const VIRTUAL_VIP: &str = "__vip__";

// Note: no BODYSTRUCTURE. iCloud returns NIL encodings for some messages, which the
// IMAP parser rejects and which would break the whole list.
const SUMMARY_QUERY: &str = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.16384>)";
/// How much of a message SUMMARY_QUERY downloads.
const PREVIEW_BYTES: usize = 16384;

/// Upgrade a plain IMAP connection with STARTTLS (servers on port 143).
async fn starttls(tcp: &mut TcpStream) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (r, mut w) = tcp.split();
    let mut r = BufReader::new(r);
    let mut line = String::new();
    r.read_line(&mut line).await?; // greeting
    if !line.starts_with("* OK") {
        bail!("Unexpected server greeting");
    }
    w.write_all(b"a0 STARTTLS\r\n").await?;
    loop {
        line.clear();
        if r.read_line(&mut line).await? == 0 {
            bail!("Server closed the connection during STARTTLS");
        }
        if line.starts_with("a0 ") {
            if !line.starts_with("a0 OK") {
                bail!("This server doesn't support STARTTLS");
            }
            return Ok(());
        }
    }
}

/// How long the TLS handshake + greeting + sign-in may take before we give up.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Open an authenticated IMAP session for an account (TLS or STARTTLS; password or XOAUTH2).
pub async fn connect(cfg: &AccountConfig, creds: &Credentials) -> Result<Session> {
    let started = std::time::Instant::now();
    let r = connect_within(cfg, creds, HANDSHAKE_TIMEOUT).await;
    let who = format!("{} account {}", cfg.provider, cfg.id);
    match &r {
        Ok(_) => crate::applog::log("imap", format!("{who}: connected in {} ms", started.elapsed().as_millis())),
        Err(e) => crate::applog::log("imap", format!("{who}: connect failed after {} ms: {e:#}", started.elapsed().as_millis())),
    }
    r
}

async fn connect_within(cfg: &AccountConfig, creds: &Credentials, limit: Duration) -> Result<Session> {
    let host = cfg.imap.host.as_str();
    let tcp = tokio::time::timeout(Duration::from_secs(20), TcpStream::connect((host, cfg.imap.port)))
        .await
        .with_context(|| format!("Timed out connecting to {host}"))?
        .with_context(|| format!("Could not reach {host}. Check your internet connection."))?;
    // Keepalive probes notice a connection the network silently dropped (sleep, Wi-Fi
    // change, a router forgetting an idle connection) instead of waiting on it forever.
    let ka = socket2::TcpKeepalive::new().with_time(Duration::from_secs(60)).with_interval(Duration::from_secs(15));
    let _ = socket2::SockRef::from(&tcp).set_tcp_keepalive(&ka);
    // A server (or network) that accepts the connection but then goes quiet must not
    // hang the account: the whole handshake and sign-in has a time limit.
    tokio::time::timeout(limit, handshake(cfg, creds, tcp))
        .await
        .map_err(|_| anyhow!("The mail server ({host}) is not responding. Check your internet connection."))?
}

async fn handshake(cfg: &AccountConfig, creds: &Credentials, mut tcp: TcpStream) -> Result<Session> {
    let host = cfg.imap.host.as_str();
    let starttls_used = cfg.imap.security == Security::StartTls;
    if starttls_used {
        starttls(&mut tcp).await?;
    }
    let cx = tokio_native_tls::TlsConnector::from(native_tls::TlsConnector::new()?);
    let tls = cx.connect(host, tcp).await.with_context(|| format!("Secure connection to {host} failed"))?;
    let mut client = async_imap::Client::new(tls);
    if !starttls_used {
        client.read_response().await.ok_or_else(|| anyhow!("{host} closed the connection"))??;
    }
    let result = match &creds.secret {
        Secret::Password(pw) => client.login(&creds.email, pw).await,
        Secret::OAuth(ts) => {
            let token = ts.access_token().await?;
            client.authenticate("XOAUTH2", crate::oauth::XOAuth2::new(&creds.email, &token)).await
        }
    };
    match result {
        Ok(s) => Ok(s),
        Err((e, _)) => {
            if matches!(e, async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_))
                || e.to_string().contains("AUTHENTICATIONFAILED")
            {
                match creds.secret {
                    Secret::Password(_) => bail!("AUTH: The email address or app password for {} is incorrect.", creds.email),
                    Secret::OAuth(_) => bail!("AUTH: {} needs to be signed in again.", creds.email),
                }
            }
            Err(anyhow!(e).context("Sign in failed"))
        }
    }
}

pub struct Conn {
    pub session: Session,
    pub selected: Option<String>,
}

impl Conn {
    async fn select(&mut self, folder: &str) -> Result<async_imap::types::Mailbox> {
        let mb = self.session.select(folder).await.with_context(|| format!("Could not open mailbox {folder}"))?;
        self.selected = Some(folder.to_string());
        Ok(mb)
    }

    async fn ensure_selected(&mut self, folder: &str) -> Result<()> {
        if self.selected.as_deref() != Some(folder) {
            self.select(folder).await?;
        }
        Ok(())
    }

    fn drain_unsolicited(&mut self) {
        while self.session.unsolicited_responses.try_recv().is_ok() {}
    }
}

type Slot = tokio::sync::Mutex<Option<Conn>>;

pub struct Imap {
    pub cfg: AccountConfig,
    pub creds: Credentials,
    pub cache: Arc<Cache>,
    /// Interactive connection (everything the user clicks).
    conn: Slot,
    /// Background connection (prefetching bodies) so it never blocks the UI.
    bg: Slot,
    /// role -> folder path, filled by list_folders.
    roles: std::sync::Mutex<HashMap<String, String>>,
}

fn is_connection_error(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        if let Some(ie) = c.downcast_ref::<async_imap::error::Error>() {
            matches!(ie, async_imap::error::Error::Io(_) | async_imap::error::Error::ConnectionLost)
        } else {
            c.downcast_ref::<std::io::Error>().is_some()
        }
    })
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",")
}

fn role_for(path: &str, attrs: &[NameAttribute]) -> Option<&'static str> {
    for a in attrs {
        match a {
            NameAttribute::Drafts => return Some("drafts"),
            NameAttribute::Sent => return Some("sent"),
            NameAttribute::Junk => return Some("junk"),
            NameAttribute::Trash => return Some("trash"),
            NameAttribute::Archive => return Some("archive"),
            // Gmail system folders: All Mail doubles as "Archive"; Starred/Important are hidden.
            NameAttribute::All => return Some("allmail"),
            NameAttribute::Flagged => return Some("starred"),
            NameAttribute::Extension(x) if x.eq_ignore_ascii_case(r"\Important") => return Some("important"),
            _ => {}
        }
    }
    match path.to_lowercase().as_str() {
        "inbox" => Some("inbox"),
        "drafts" | "draft" => Some("drafts"),
        "sent messages" | "sent" | "sent items" | "sent mail" => Some("sent"),
        "junk" | "spam" | "bulk mail" | "junk email" | "junk e-mail" => Some("junk"),
        "deleted messages" | "trash" | "deleted items" | "deleted" => Some("trash"),
        "archive" => Some("archive"),
        _ => None,
    }
}

/// Folders the mail provider makes itself (besides the ones with a role). They can't be
/// renamed or deleted from the app; neither can anything inside them.
fn is_provider_folder(path: &str, delim: &str) -> bool {
    const NAMES: &[&str] = &[
        "outbox", // iCloud, Outlook, Yahoo
        "conversation history", "sync issues", "clutter", "rss feeds", "rss subscriptions", "scheduled", "archives", // Outlook / Exchange
        "[gmail]", "[google mail]",
    ];
    let lower = path.to_lowercase();
    let top = lower.split(delim).next().unwrap_or(&lower);
    NAMES.contains(&top)
}

fn role_order(role: Option<&str>) -> u8 {
    match role {
        Some("inbox") => 0,
        Some("drafts") => 1,
        Some("sent") => 2,
        Some("junk") => 3,
        Some("trash") => 4,
        Some("archive") => 5,
        _ => 10,
    }
}

pub fn real_folder(folder: &str) -> String {
    match folder {
        VIRTUAL_FLAGGED | VIRTUAL_VIP => "INBOX".to_string(),
        f => f.to_string(),
    }
}

fn flags_of(f: &Fetch) -> (bool, bool, bool) {
    let flags: Vec<Flag> = f.flags().collect();
    (
        flags.iter().any(|f| matches!(f, Flag::Seen)),
        flags.iter().any(|f| matches!(f, Flag::Flagged)),
        flags.iter().any(|f| matches!(f, Flag::Answered)),
    )
}

/// Attachment names from a message's BODYSTRUCTURE, by the same rules as the full
/// parse (`mime::attachments`): body text and inline pictures shown in the body don't count.
fn structure_attachments(b: &BodyStructure) -> Vec<String> {
    fn param<'a>(params: &'a Option<Vec<(std::borrow::Cow<'a, str>, std::borrow::Cow<'a, str>)>>, key: &str) -> Option<&'a str> {
        params.as_ref()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_ref())
    }
    fn walk(b: &BodyStructure, out: &mut Vec<String>) {
        let (common, other) = match b {
            BodyStructure::Multipart { bodies, .. } => return bodies.iter().for_each(|x| walk(x, out)),
            BodyStructure::Basic { common, other, .. } | BodyStructure::Text { common, other, .. } | BodyStructure::Message { common, other, .. } => (common, other),
        };
        let ty = common.ty.ty.to_ascii_lowercase();
        let mime = format!("{ty}/{}", common.ty.subtype.to_ascii_lowercase());
        let disp = common.disposition.as_ref();
        let is_att = disp.map(|d| d.ty.eq_ignore_ascii_case("attachment")).unwrap_or(false);
        let is_inline = disp.map(|d| d.ty.eq_ignore_ascii_case("inline")).unwrap_or(false);
        let name = disp
            .and_then(|d| param(&d.params, "filename"))
            .or_else(|| param(&common.ty.params, "name"))
            .map(mime::decode_header_text);
        // Body text, and pictures the body shows itself, aren't attachments.
        if ty == "text" && name.is_none() && !is_att {
            return;
        }
        if is_inline && other.id.is_some() && mime::web_renderable(&mime) {
            return;
        }
        let n = out.len() + 1;
        out.push(name.unwrap_or_else(|| if ty == "image" { format!("Image {n}") } else { format!("Attachment {n}") }));
    }
    let mut out = vec![];
    walk(b, &mut out);
    out
}

fn summary_from_fetch(f: &Fetch, folder: &str) -> Option<MessageSummary> {
    let uid = f.uid?;
    let (seen, flagged, answered) = flags_of(f);
    let raw = f.body().unwrap_or_default();
    let parsed = mime::parse(raw);
    let internal = f.internal_date().map(|d| d.timestamp_millis());
    let (message_id, in_reply_to, references) = parsed.as_ref().map(mime::thread_ids).unwrap_or_default();
    let (from, to, subject, preview, date, att_names) = match &parsed {
        Some(m) => (
            mime::first_person(m.from()),
            mime::people(m.to()),
            m.subject().unwrap_or_default().to_string(),
            mime::preview_of(m),
            mime::date_ms(m).or(internal).unwrap_or(0),
            // Only the start of a bigger message: ignore body text cut off mid-part.
            if (raw.len() as u32) < f.size.unwrap_or(0) { mime::attachments_partial(m, raw.len()) } else { mime::attachments(m) }
                .into_iter()
                .map(|a| a.name)
                .collect::<Vec<_>>(),
        ),
        None => (Person { name: String::new(), email: String::new() }, vec![], String::new(), String::new(), internal.unwrap_or(0), vec![]),
    };
    Some(MessageSummary {
        uid,
        folder: folder.to_string(),
        account: String::new(),
        id: String::new(),
        from,
        to,
        subject,
        preview,
        date,
        seen,
        flagged,
        answered,
        has_attachments: !att_names.is_empty(),
        attachment_names: att_names,
        size: f.size.unwrap_or(0),
        message_id,
        in_reply_to,
        references,
        thread_v: 1,
        preview_v: PREVIEW_V,
    })
}

impl Imap {
    pub fn new(cfg: AccountConfig, creds: Credentials, cache: Arc<Cache>) -> Self {
        Imap { cfg, creds, cache, conn: Default::default(), bg: Default::default(), roles: Default::default() }
    }

    /// Verify credentials by opening the primary connection.
    pub async fn open(&self) -> Result<()> {
        let s = connect(&self.cfg, &self.creds).await?;
        *self.conn.lock().await = Some(Conn { session: s, selected: None });
        Ok(())
    }

    pub async fn close(&self) {
        for slot in [&self.conn, &self.bg] {
            if let Some(mut c) = slot.lock().await.take() {
                let _ = tokio::time::timeout(Duration::from_secs(3), c.session.logout()).await;
            }
        }
    }

    async fn run<T, F>(&self, f: F) -> Result<T>
    where
        F: for<'a> Fn(&'a mut Conn) -> BoxFuture<'a, Result<T>>,
    {
        self.run_on(&self.conn, f).await
    }

    /// Run an operation on a connection slot, reconnecting (once) if the connection dropped.
    async fn run_on<T, F>(&self, slot: &Slot, f: F) -> Result<T>
    where
        F: for<'a> Fn(&'a mut Conn) -> BoxFuture<'a, Result<T>>,
    {
        let mut guard = slot.lock().await;
        for attempt in 0..2 {
            if guard.is_none() {
                let s = connect(&self.cfg, &self.creds).await?;
                *guard = Some(Conn { session: s, selected: None });
            }
            let conn = guard.as_mut().unwrap();
            let res = tokio::time::timeout(Duration::from_secs(90), f(conn)).await;
            match res {
                Ok(Ok(v)) => {
                    conn.drain_unsolicited();
                    return Ok(v);
                }
                Ok(Err(e)) if attempt == 0 && is_connection_error(&e) => {
                    *guard = None;
                }
                Ok(Err(e)) => {
                    if is_connection_error(&e) {
                        *guard = None;
                    }
                    return Err(e);
                }
                Err(_) => {
                    *guard = None;
                    if attempt == 1 {
                        bail!("The mail server ({}) is not responding. Try again.", self.cfg.imap.host);
                    }
                }
            }
        }
        bail!("Could not reach {}.", self.cfg.imap.host)
    }

    /// Forget open connections that may have died (sleep, network change); the next
    /// request reconnects. Connections busy right now are left alone.
    pub fn reset_connections(&self) {
        for slot in [&self.conn, &self.bg] {
            if let Ok(mut g) = slot.try_lock() {
                *g = None;
            }
        }
    }

    pub fn role_path(&self, role: &str) -> Option<String> {
        self.roles.lock().unwrap().get(role).cloned()
    }

    fn set_roles(&self, folders: &[Folder]) {
        let mut roles = self.roles.lock().unwrap();
        roles.clear();
        for f in folders {
            if let Some(r) = &f.role {
                roles.entry(r.clone()).or_insert_with(|| f.path.clone());
            }
        }
    }

    pub fn cached_folders(&self) -> Option<Vec<Folder>> {
        let mut f = self.cache.folders()?;
        for x in f.iter_mut() {
            x.account = self.cfg.id.clone();
        }
        if self.roles.lock().unwrap().is_empty() {
            self.set_roles(&f);
        }
        Some(f)
    }

    pub async fn list_folders(&self) -> Result<Vec<Folder>> {
        let mut folders = self
            .run(|c| {
                Box::pin(async move {
                    let names: Vec<_> = c.session.list(Some(""), Some("*")).await?.try_collect().await?;
                    let mut out = Vec::new();
                    for n in names.iter() {
                        let path = n.name().to_string();
                        if path.eq_ignore_ascii_case("notes") {
                            continue; // iCloud stores Notes here; the web app hides it.
                        }
                        let attrs = n.attributes();
                        let selectable = !attrs.iter().any(|a| matches!(a, NameAttribute::NoSelect));
                        let delim = n.delimiter().unwrap_or("/").to_string();
                        let segs: Vec<&str> = path.split(delim.as_str()).collect();
                        let role = role_for(&path, attrs).map(|s| s.to_string());
                        let (mut unread, mut total) = (0, 0);
                        if selectable {
                            if let Ok(st) = c.session.status(&path, "(MESSAGES UNSEEN)").await {
                                total = st.exists;
                                unread = st.unseen.unwrap_or(0);
                            }
                        }
                        let system = role.is_some() || is_provider_folder(&path, &delim);
                        out.push(Folder {
                            account: String::new(),
                            name: mime::decode_mutf7(segs.last().copied().unwrap_or(&path)),
                            depth: segs.len().saturating_sub(1),
                            path,
                            unread,
                            total,
                            selectable,
                            system,
                            role,
                        });
                    }
                    Ok(out)
                })
            })
            .await?;
        // Gmail: archiving means "remove from Inbox", i.e. All Mail. Use it as Archive if
        // there is no real Archive folder, and hide Gmail's other system folders.
        if !folders.iter().any(|f| f.role.as_deref() == Some("archive")) {
            if let Some(f) = folders.iter_mut().find(|f| f.role.as_deref() == Some("allmail")) {
                f.role = Some("archive".into());
            }
        }
        folders.retain(|f| {
            !matches!(f.role.as_deref(), Some("allmail" | "starred" | "important"))
                && !(!f.selectable && (f.path.eq_ignore_ascii_case("[Gmail]") || f.path.eq_ignore_ascii_case("[Google Mail]")))
        });
        folders.sort_by(|a, b| {
            role_order(a.role.as_deref())
                .cmp(&role_order(b.role.as_deref()))
                .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
        });
        for f in folders.iter_mut() {
            f.account = self.cfg.id.clone();
        }
        self.set_roles(&folders);
        self.cache.put_folders(&folders);
        Ok(folders)
    }

    /// Instant listing from the disk cache (no network).
    pub fn cached_messages(&self, folder: &str, filter: &str, vip: &[String], limit: usize) -> MessagePage {
        let real = real_folder(folder);
        let vip: HashSet<String> = vip.iter().map(|v| v.to_lowercase()).collect();
        let me = self.creds.email.to_lowercase();
        let all = self.cache.latest(&real, 2000);
        let mut msgs: Vec<MessageSummary> = all
            .into_iter()
            .filter(|m| match folder {
                VIRTUAL_FLAGGED => m.flagged,
                VIRTUAL_VIP => vip.contains(&m.from.email.to_lowercase()),
                _ => true,
            })
            .filter(|m| match filter {
                "unread" => !m.seen,
                "flagged" => m.flagged,
                "attachments" => m.has_attachments,
                "toMe" => m.to.iter().any(|p| p.email.to_lowercase() == me),
                _ => true,
            })
            .collect();
        let total = msgs.len();
        msgs.truncate(limit);
        for m in msgs.iter_mut() {
            m.folder = folder.to_string();
            m.account = self.cfg.id.clone();
            m.id = format!("{}:{}:{}", self.cfg.id, real, m.uid);
        }
        MessagePage { has_more: total > msgs.len(), messages: msgs, total }
    }

    pub async fn list_messages(
        &self,
        folder: &str,
        filter: &str,
        query: &str,
        vip: &[String],
        offset: usize,
        limit: usize,
        oldest_first: bool,
    ) -> Result<MessagePage> {
        if filter != "attachments" {
            return self.list_page(folder, filter, query, vip, offset, limit, oldest_first).await;
        }
        // Servers can't reliably search for attachments (iCloud finds none by header), so go
        // through the listing in order and keep the messages that have them. Summaries are
        // cached, so going over the same ground again for "load more" is cheap.
        const CHUNK: usize = 100;
        const MAX_SCAN: usize = 3000; // per request; "load more" continues past it
        let want = offset + limit;
        let mut matches: Vec<MessageSummary> = Vec::new();
        let mut scanned = 0;
        let mut exhausted = false;
        while matches.len() < want + 1 && scanned < MAX_SCAN {
            let page = self.list_page(folder, "all", query, vip, scanned, CHUNK, oldest_first).await?;
            scanned += page.messages.len();
            exhausted = !page.has_more || page.messages.is_empty();
            matches.extend(page.messages.into_iter().filter(|m| m.has_attachments));
            if exhausted {
                break;
            }
        }
        let has_more = matches.len() > want || !exhausted;
        let total = matches.len();
        let messages = matches.into_iter().skip(offset).take(limit).collect();
        Ok(MessagePage { messages, total, has_more })
    }

    /// One page of a mailbox listing (server search + cached or fetched summaries).
    #[allow(clippy::too_many_arguments)]
    async fn list_page(
        &self,
        folder: &str,
        filter: &str,
        query: &str,
        vip: &[String],
        offset: usize,
        limit: usize,
        oldest_first: bool,
    ) -> Result<MessagePage> {
        // Map virtual mailboxes onto the inbox.
        let real = real_folder(folder);
        let mut criteria: Vec<String> = match folder {
            VIRTUAL_FLAGGED => vec!["FLAGGED".to_string()],
            VIRTUAL_VIP => {
                if vip.is_empty() {
                    return Ok(MessagePage { messages: vec![], total: 0, has_more: false });
                }
                let mut c = format!("FROM {}", quote(&vip[0]));
                for v in &vip[1..] {
                    c = format!("OR FROM {} {}", quote(v), c);
                }
                vec![format!("({c})")]
            }
            _ => vec![],
        };
        match filter {
            "unread" => criteria.push("UNSEEN".into()),
            "flagged" => criteria.push("FLAGGED".into()),
            "toMe" => criteria.push(format!("TO {}", quote(&self.creds.email))),
            _ => {}
        }
        let q = query.trim();
        if !q.is_empty() {
            let qq = quote(q);
            criteria.push(format!("OR OR OR FROM {qq} SUBJECT {qq} TO {qq} BODY {qq}"));
        }
        let plain_listing = criteria.is_empty();
        let mut search = if plain_listing { "ALL".to_string() } else { criteria.join(" ") };
        if !q.is_ascii() {
            search = format!("CHARSET UTF-8 {search}");
        }

        let cache = self.cache.clone();
        let folder_label = folder.to_string();
        let real2 = real.clone();
        let step = self.run(move |c| {
            let (real, search, folder_label, cache) = (real.clone(), search.clone(), folder_label.clone(), cache.clone());
            Box::pin(async move {
                let mb = c.select(&real).await?;
                cache.check_validity(&real, mb.uid_validity);
                if mb.exists == 0 {
                    if plain_listing {
                        cache.retain(&real, &HashSet::new());
                    }
                    return Ok(None);
                }
                let found = c.session.uid_search(&search).await?;
                if plain_listing {
                    cache.retain(&real, &found);
                }
                let mut uids: Vec<u32> = found.into_iter().collect();
                // UIDs grow with arrival: descending = newest first. Paging works the same either way.
                if oldest_first {
                    uids.sort_unstable();
                } else {
                    uids.sort_unstable_by(|a, b| b.cmp(a));
                }
                let total = uids.len();
                let page: Vec<u32> = uids.into_iter().skip(offset).take(limit).collect();
                if page.is_empty() {
                    return Ok(Some((page, total, HashMap::new(), vec![])));
                }

                let mut have = cache.summaries(&real, &page);
                // Rows cached with an older preview are downloaded again (their preview improves).
                have.retain(|_, m| m.preview_v >= PREVIEW_V);
                let missing: Vec<u32> = page.iter().copied().filter(|u| !have.contains_key(u)).collect();
                let known: Vec<u32> = page.iter().copied().filter(|u| have.contains_key(u)).collect();

                // Refresh flags of already-cached messages (cheap).
                if !known.is_empty() {
                    let fetches: Vec<_> = c.session.uid_fetch(uid_set(&known), "(UID FLAGS)").await?.try_collect().await?;
                    let mut changed = vec![];
                    for f in &fetches {
                        let Some(uid) = f.uid else { continue };
                        if let Some(m) = have.get_mut(&uid) {
                            let (s, fl, a) = flags_of(f);
                            if (m.seen, m.flagged, m.answered) != (s, fl, a) {
                                (m.seen, m.flagged, m.answered) = (s, fl, a);
                                changed.push(m.clone());
                            }
                        }
                    }
                    cache.put_summaries(&real, &changed);
                }
                // One-time backfill: summaries cached before conversations existed lack the
                // threading headers. Fetch just the header block for those (a few KB each).
                let stale: Vec<u32> = known.iter().copied().filter(|u| have.get(u).map(|m| m.thread_v == 0).unwrap_or(false)).collect();
                if !stale.is_empty() {
                    let fetches: Vec<_> = c.session.uid_fetch(uid_set(&stale), "(UID BODY.PEEK[HEADER])").await?.try_collect().await?;
                    let mut fixed = vec![];
                    for f in &fetches {
                        let (Some(uid), Some(h)) = (f.uid, f.header()) else { continue };
                        if let (Some(m), Some(p)) = (have.get_mut(&uid), mime::parse(h)) {
                            (m.message_id, m.in_reply_to, m.references) = mime::thread_ids(&p);
                            m.thread_v = 1;
                            fixed.push(m.clone());
                        }
                    }
                    cache.put_summaries(&real, &fixed);
                }
                let _ = &folder_label;
                Ok(Some((page, total, have, missing)))
            })
        })
        .await;
        let (page, total, mut have, missing) = match step {
            Ok(Some(x)) => x,
            Ok(None) => return Ok(MessagePage { messages: vec![], total: 0, has_more: false }),
            Err(e) => return Err(e),
        };
        // Download summaries only for messages we haven't seen before.
        if !missing.is_empty() {
            for m in self.fetch_summaries(&real2, &missing).await? {
                have.insert(m.uid, m);
            }
        }
        let msgs: Vec<MessageSummary> = page
            .iter()
            .filter_map(|u| have.remove(u))
            .map(|mut m| {
                m.folder = folder.to_string();
                m.account = self.cfg.id.clone();
                m.id = format!("{}:{}:{}", self.cfg.id, real2, m.uid);
                m
            })
            .collect();
        Ok(MessagePage { has_more: offset + page.len() < total, messages: msgs, total })
    }

    /// Fetch list summaries for `uids`. A batch that the server answers with
    /// something unparseable is retried one message at a time, and a message
    /// that still fails gets a minimal placeholder instead of breaking the list.
    async fn fetch_summaries(&self, folder: &str, uids: &[u32]) -> Result<Vec<MessageSummary>> {
        let mut out = Vec::with_capacity(uids.len());
        for chunk in uids.chunks(25) {
            match self.fetch_summary_batch(folder, chunk).await {
                Ok(v) => out.extend(v),
                Err(e) if e.to_string().starts_with("AUTH:") => return Err(e),
                Err(_) => {
                    for &uid in chunk {
                        match self.fetch_summary_batch(folder, &[uid]).await {
                            Ok(v) => out.extend(v),
                            Err(e) if e.to_string().starts_with("AUTH:") => return Err(e),
                            Err(_) => out.push(self.placeholder_summary(folder, uid).await),
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    async fn fetch_summary_batch(&self, folder: &str, uids: &[u32]) -> Result<Vec<MessageSummary>> {
        let set = uid_set(uids);
        let f2 = folder.to_string();
        let new: Vec<MessageSummary> = self
            .run(move |c| {
                let (folder, set) = (f2.clone(), set.clone());
                Box::pin(async move {
                    c.ensure_selected(&folder).await?;
                    let fetches: Vec<_> = c.session.uid_fetch(&set, SUMMARY_QUERY).await?.try_collect().await?;
                    let mut out: Vec<MessageSummary> = fetches.iter().filter_map(|f| summary_from_fetch(f, &folder)).collect();
                    // Only the start of bigger emails was downloaded, and their attachments
                    // often come later: ask the server for their structure instead. (Asked
                    // separately: some servers send structures the parser rejects, which
                    // must not break the list. Those keep the guess from the partial parse.)
                    let big: Vec<u32> = out.iter().filter(|m| m.size as usize > PREVIEW_BYTES).map(|m| m.uid).collect();
                    if !big.is_empty() {
                        let mut found: HashMap<u32, Vec<String>> = HashMap::new();
                        let batch = match c.session.uid_fetch(uid_set(&big), "(UID BODYSTRUCTURE)").await {
                            Ok(stream) => stream.try_collect::<Vec<_>>().await.ok(),
                            Err(_) => None,
                        };
                        match batch {
                            Some(fs) => {
                                for f in &fs {
                                    if let (Some(uid), Some(b)) = (f.uid, f.bodystructure()) {
                                        found.insert(uid, structure_attachments(b));
                                    }
                                }
                            }
                            None if big.len() > 1 => {
                                for &uid in &big {
                                    let one = match c.session.uid_fetch(uid.to_string(), "(UID BODYSTRUCTURE)").await {
                                        Ok(stream) => stream.try_collect::<Vec<_>>().await.unwrap_or_default(),
                                        Err(_) => vec![],
                                    };
                                    for f in &one {
                                        if let (Some(uid), Some(b)) = (f.uid, f.bodystructure()) {
                                            found.insert(uid, structure_attachments(b));
                                        }
                                    }
                                }
                            }
                            None => {}
                        }
                        for m in out.iter_mut() {
                            if let Some(names) = found.remove(&m.uid) {
                                m.has_attachments = !names.is_empty();
                                m.attachment_names = names;
                            }
                        }
                    }
                    // Some emails have kilobytes of layout before their first words: when the
                    // first 16 KB gave no preview, or just a line of it, read further (64 KB)
                    // for just those.
                    let more: Vec<u32> = out.iter().filter(|m| m.preview.chars().count() < 80 && m.size as usize > PREVIEW_BYTES).map(|m| m.uid).collect();
                    if !more.is_empty() {
                        if let Ok(stream) = c.session.uid_fetch(uid_set(&more), "(UID BODY.PEEK[]<0.65536>)").await {
                            let longer: Vec<_> = stream.try_collect().await.unwrap_or_default();
                            for f in &longer {
                                let (Some(uid), Some(body)) = (f.uid, f.body()) else { continue };
                                if let (Some(m), Some(p)) = (out.iter_mut().find(|m| m.uid == uid), mime::parse(body)) {
                                    let longer = mime::preview_of(&p);
                                    if longer.chars().count() > m.preview.chars().count() {
                                        m.preview = longer;
                                    }
                                }
                            }
                        }
                    }
                    Ok(out)
                })
            })
            .await?;
        self.cache.put_summaries(folder, &new);
        Ok(new)
    }

    /// Last resort for a message whose summary can't be parsed: headers only.
    async fn placeholder_summary(&self, folder: &str, uid: u32) -> MessageSummary {
        let f2 = folder.to_string();
        let hdr: Option<(Vec<u8>, bool, bool, bool)> = self
            .run(move |c| {
                let folder = f2.clone();
                Box::pin(async move {
                    c.ensure_selected(&folder).await?;
                    let fetches: Vec<_> = c.session.uid_fetch(uid.to_string(), "(UID FLAGS BODY.PEEK[HEADER])").await?.try_collect().await?;
                    Ok(fetches.iter().find(|f| f.uid == Some(uid)).map(|f| {
                        let (s, fl, a) = flags_of(f);
                        (f.header().unwrap_or_default().to_vec(), s, fl, a)
                    }))
                })
            })
            .await
            .ok()
            .flatten();
        let (raw, seen, flagged, answered) = hdr.unwrap_or_default();
        let f3 = folder.to_string();
        let body: Option<Vec<u8>> = self
            .run(move |c| {
                let folder = f3.clone();
                Box::pin(async move {
                    c.ensure_selected(&folder).await?;
                    let fetches: Vec<_> = c.session.uid_fetch(uid.to_string(), "(UID BODY.PEEK[TEXT]<0.16384>)").await?.try_collect().await?;
                    Ok(fetches.iter().find(|f| f.uid == Some(uid)).and_then(|f| f.text().map(|t| t.to_vec())))
                })
            })
            .await
            .ok()
            .flatten();
        let mut whole = raw.clone();
        if let Some(b) = &body {
            whole.extend_from_slice(b);
        }
        let preview = mime::parse(&whole).map(|m| mime::preview_of(&m)).unwrap_or_default();
        let parsed = mime::parse(&raw);
        let (message_id, in_reply_to, references) = parsed.as_ref().map(mime::thread_ids).unwrap_or_default();
        MessageSummary {
            uid,
            folder: folder.to_string(),
            account: String::new(),
            id: String::new(),
            from: parsed.as_ref().map(|m| mime::first_person(m.from())).unwrap_or(Person { name: String::new(), email: String::new() }),
            to: parsed.as_ref().map(|m| mime::people(m.to())).unwrap_or_default(),
            subject: parsed.as_ref().and_then(|m| m.subject().map(|s| s.to_string())).unwrap_or_default(),
            preview,
            date: parsed.as_ref().and_then(mime::date_ms).unwrap_or(0),
            seen,
            flagged,
            answered,
            has_attachments: false,
            attachment_names: vec![],
            size: 0,
            message_id,
            in_reply_to,
            references,
            thread_v: 1,
        preview_v: PREVIEW_V,
        }
    }

    /// After a full message is downloaded, fill in attachment details the list
    /// summary (built from a partial download) may have missed.
    fn enrich_summary(&self, folder: &str, uid: u32, raw: &[u8]) {
        let mut found = self.cache.summaries(folder, &[uid]);
        let Some(m) = found.get_mut(&uid) else { return };
        let Some(parsed) = mime::parse(raw) else { return };
        let names: Vec<String> = mime::attachments(&parsed).into_iter().map(|a| a.name).collect();
        if names != m.attachment_names {
            m.has_attachments = !names.is_empty();
            m.attachment_names = names;
            let m = m.clone();
            self.cache.put_summaries(folder, &[m]);
        }
    }

    async fn fetch_raw(&self, folder: &str, uid: u32) -> Result<(Vec<u8>, bool, bool)> {
        let folder_s = folder.to_string();
        let (raw, seen, flagged) = self
            .run(move |c| {
                let folder = folder_s.clone();
                Box::pin(async move {
                    c.ensure_selected(&folder).await?;
                    let fetches: Vec<_> = c.session.uid_fetch(uid.to_string(), "(UID FLAGS BODY.PEEK[])").await?.try_collect().await?;
                    let f = fetches.iter().find(|f| f.uid == Some(uid)).context("The message no longer exists.")?;
                    let (seen, flagged, _) = flags_of(f);
                    Ok((f.body().unwrap_or_default().to_vec(), seen, flagged))
                })
            })
            .await?;
        self.cache.put_body(folder, uid, &raw);
        self.enrich_summary(folder, uid, &raw);
        Ok((raw, seen, flagged))
    }

    /// Raw message, from the disk cache when available.
    /// First `bytes` of a message (headers + text), used to show big emails before
    /// their attachments have downloaded. Not cached.
    async fn fetch_partial(&self, folder: &str, uid: u32, bytes: usize) -> Result<(Vec<u8>, bool, bool)> {
        let folder_s = folder.to_string();
        self.run(move |c| {
            let folder = folder_s.clone();
            Box::pin(async move {
                c.ensure_selected(&folder).await?;
                let q = format!("(UID FLAGS BODY.PEEK[]<0.{bytes}>)");
                let fetches: Vec<_> = c.session.uid_fetch(uid.to_string(), &q).await?.try_collect().await?;
                let f = fetches.iter().find(|f| f.uid == Some(uid)).context("The message no longer exists.")?;
                let (seen, flagged, _) = flags_of(f);
                Ok((f.body().unwrap_or_default().to_vec(), seen, flagged))
            })
        })
        .await
    }

    async fn raw(&self, folder: &str, uid: u32) -> Result<(Vec<u8>, Option<(bool, bool)>)> {
        if let Some(r) = self.cache.body(folder, uid) {
            let flags = self.cache.summaries(folder, &[uid]).get(&uid).map(|m| (m.seen, m.flagged));
            return Ok((r, flags));
        }
        let (r, s, f) = self.fetch_raw(folder, uid).await?;
        Ok((r, Some((s, f))))
    }

    /// With `allow_partial`, a large message that isn't on disk yet is first returned from a
    /// partial download (`partial: true`) so it shows instantly; the UI then asks for the full one.
    pub async fn get_message(&self, folder: &str, uid: u32, mark_seen: bool, allow_partial: bool) -> Result<MessageDetail> {
        const LARGE: u32 = 768 * 1024;
        const PARTIAL_BYTES: usize = 384 * 1024;
        let size = self.cache.summaries(folder, &[uid]).get(&uid).map(|m| m.size).unwrap_or(0);
        let mut partial = false;
        let (raw, flags) = if allow_partial && size > LARGE && self.cache.has_bodies(folder, &[uid]).is_empty() {
            partial = true;
            let (r, s, f) = self.fetch_partial(folder, uid, PARTIAL_BYTES).await?;
            (r, Some((s, f)))
        } else {
            self.raw(folder, uid).await?
        };
        let (seen, flagged) = flags.unwrap_or((false, false));
        if mark_seen && !seen {
            let _ = self.set_flag(folder, &[uid], "\\Seen", true).await;
        }
        let msg = mime::parse(&raw).context("Could not read this message")?;
        let text = msg.body_text(0).map(|t| t.into_owned()).unwrap_or_default();
        let has_html_part = msg
            .html_body
            .iter()
            .any(|&i| msg.parts.get(i as usize).map(|p| matches!(p.body, mail_parser::PartType::Html(_))).unwrap_or(false));
        let (html, remote) = match msg.body_html(0) {
            Some(h) if has_html_part => mime::sanitize_html(&h, &msg),
            _ => (mime::text_to_html(&text), false),
        };
        let header_end = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(raw.len().min(8192));
        Ok(MessageDetail {
            uid,
            folder: folder.to_string(),
            account: self.cfg.id.clone(),
            from: mime::first_person(msg.from()),
            reply_to: mime::people(msg.reply_to()),
            to: mime::people(msg.to()),
            cc: mime::people(msg.cc()),
            bcc: mime::people(msg.bcc()),
            subject: msg.subject().unwrap_or_default().to_string(),
            date: mime::date_ms(&msg).unwrap_or(0),
            in_reply_to: Some(mime::thread_ids(&msg).1).filter(|s| !s.is_empty()),
            html,
            text,
            has_remote_content: remote,
            attachments: mime::attachments(&msg),
            inline_images: mime::inline_images(&msg),
            message_id: msg.message_id().map(|s| s.to_string()),
            references: mime::header_list(msg.references()),
            seen: true,
            flagged,
            raw_headers: String::from_utf8_lossy(&raw[..header_end]).to_string(),
            partial,
        })
    }

    pub async fn attachment(&self, folder: &str, uid: u32, index: usize) -> Result<(String, String, Vec<u8>)> {
        let (raw, _) = self.raw(folder, uid).await?;
        let msg = mime::parse(&raw).context("Could not read this message")?;
        mime::attachment_bytes(&msg, index).context("Attachment not found")
    }

    pub async fn raw_message(&self, folder: &str, uid: u32) -> Result<Vec<u8>> {
        Ok(self.raw(folder, uid).await?.0)
    }

    /// Download full bodies of the given messages in the background so they open instantly.
    pub async fn prefetch(&self, folder: &str, uids: &[u32]) -> Result<usize> {
        let real = real_folder(folder);
        let have = self.cache.has_bodies(&real, uids);
        let sizes = self.cache.summaries(&real, uids);
        let todo: Vec<u32> = uids
            .iter()
            .copied()
            .filter(|u| !have.contains(u))
            .filter(|u| sizes.get(u).map(|m| (m.size as usize) < 8 * 1024 * 1024).unwrap_or(true))
            .collect();
        let mut done = 0;
        for chunk in todo.chunks(8) {
            let set = uid_set(chunk);
            let real2 = real.clone();
            let fetched: Vec<(u32, Vec<u8>)> = self
                .run_on(&self.bg, move |c| {
                    let (folder, set) = (real2.clone(), set.clone());
                    Box::pin(async move {
                        c.ensure_selected(&folder).await?;
                        let fetches: Vec<_> = c.session.uid_fetch(&set, "(UID BODY.PEEK[])").await?.try_collect().await?;
                        Ok(fetches.iter().filter_map(|f| Some((f.uid?, f.body()?.to_vec()))).collect())
                    })
                })
                .await?;
            for (uid, raw) in fetched {
                if raw.len() <= MAX_CACHED_BODY {
                    self.cache.put_body(&real, uid, &raw);
                    self.enrich_summary(&real, uid, &raw);
                    done += 1;
                }
            }
        }
        Ok(done)
    }

    pub async fn set_flag(&self, folder: &str, uids: &[u32], flag: &str, on: bool) -> Result<()> {
        if uids.is_empty() {
            return Ok(());
        }
        let folder = real_folder(folder);
        let cmd = format!("{}FLAGS.SILENT ({})", if on { "+" } else { "-" }, flag);
        let set = uid_set(uids);
        let f2 = folder.clone();
        self.run(move |c| {
            let (folder, cmd, set) = (f2.clone(), cmd.clone(), set.clone());
            Box::pin(async move {
                c.ensure_selected(&folder).await?;
                let _: Vec<_> = c.session.uid_store(&set, &cmd).await?.try_collect().await?;
                Ok(())
            })
        })
        .await?;
        self.cache.update_flag(&folder, uids, flag, on);
        Ok(())
    }

    pub async fn move_messages(&self, folder: &str, uids: &[u32], dest: &str) -> Result<()> {
        if uids.is_empty() {
            return Ok(());
        }
        let folder = real_folder(folder);
        let set = uid_set(uids);
        let dest = dest.to_string();
        let f2 = folder.clone();
        self.run(move |c| {
            let (folder, set, dest) = (f2.clone(), set.clone(), dest.clone());
            Box::pin(async move {
                c.ensure_selected(&folder).await?;
                if c.session.uid_mv(&set, &dest).await.is_err() {
                    // Fallback for servers without MOVE.
                    c.session.uid_copy(&set, &dest).await?;
                    let _: Vec<_> = c.session.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
                    let _: Vec<_> = c.session.uid_expunge(&set).await?.try_collect().await?;
                }
                Ok(())
            })
        })
        .await?;
        self.cache.remove(&folder, uids);
        Ok(())
    }

    pub async fn delete_messages(&self, folder: &str, uids: &[u32]) -> Result<()> {
        let real = real_folder(folder);
        let trash = self.role_path("trash").unwrap_or_else(|| "Deleted Messages".into());
        if real != trash {
            return self.move_messages(&real, uids, &trash).await;
        }
        self.purge(&real, uids).await
    }

    /// Permanently delete messages (flag \Deleted + UID EXPUNGE).
    pub async fn purge(&self, folder: &str, uids: &[u32]) -> Result<()> {
        let real = folder.to_string();
        let set = uid_set(uids);
        let r2 = real.clone();
        self.run(move |c| {
            let (folder, set) = (r2.clone(), set.clone());
            Box::pin(async move {
                c.ensure_selected(&folder).await?;
                let _: Vec<_> = c.session.uid_store(&set, "+FLAGS.SILENT (\\Deleted)").await?.try_collect().await?;
                let _: Vec<_> = c.session.uid_expunge(&set).await?.try_collect().await?;
                Ok(())
            })
        })
        .await?;
        self.cache.remove(&real, uids);
        Ok(())
    }

    /// Append a message and return its new UID. The message is found among the UIDs the
    /// folder hands out from UIDNEXT on (read just before the append), by comparing the
    /// Message-ID headers directly; that doesn't depend on the server's search index having
    /// caught up. Falls back to a Message-ID search.
    pub async fn append_and_find(&self, folder: &str, flags: &str, content: Vec<u8>, message_id: &str) -> Result<Option<u32>> {
        let (folder, flags) = (folder.to_string(), flags.to_string());
        let mid = message_id.trim().trim_matches(|c| c == '<' || c == '>').to_string();
        self.run(move |c| {
            let (folder, flags, content, mid) = (folder.clone(), flags.clone(), content.clone(), mid.clone());
            Box::pin(async move {
                let next = c.select(&folder).await?.uid_next;
                c.session.append(&folder, Some(&flags), None, &content).await?;
                // Re-select so the session sees the new message.
                c.select(&folder).await?;
                if let Some(next) = next {
                    let fetches: Vec<_> = c.session.uid_fetch(format!("{next}:*"), "(UID BODY.PEEK[HEADER])").await?.try_collect().await?;
                    let found = fetches.iter().filter_map(|f| {
                        let uid = f.uid.filter(|u| *u >= next)?;
                        let h = mime::parse(f.header()?)?;
                        (mime::thread_ids(&h).0 == mid).then_some(uid)
                    }).max();
                    if found.is_some() {
                        return Ok(found);
                    }
                }
                Ok(c.session.uid_search(format!("HEADER Message-ID {}", quote(&mid))).await?.into_iter().max())
            })
        })
        .await
    }

    pub async fn append(&self, folder: &str, flags: &str, content: Vec<u8>) -> Result<()> {
        let folder = folder.to_string();
        let flags = flags.to_string();
        self.run(move |c| {
            let (folder, flags, content) = (folder.clone(), flags.clone(), content.clone());
            Box::pin(async move {
                c.session.append(&folder, Some(&flags), None, &content).await?;
                Ok(())
            })
        })
        .await
    }

    /// Diagnostics: how many messages a raw SEARCH matches in a folder (or the error).
    #[cfg(debug_assertions)]
    pub async fn search_count(&self, folder: &str, query: &str) -> Result<usize> {
        let (f, q) = (folder.to_string(), query.to_string());
        self.run(move |c| {
            let (f, q) = (f.clone(), q.clone());
            Box::pin(async move {
                c.select(&f).await?;
                Ok(c.session.uid_search(&q).await?.len())
            })
        })
        .await
    }

    /// Every message of a conversation, across the folders a conversation normally spans
    /// (this folder, Inbox, Sent, Archive), the way Outlook includes your own replies.
    /// `seed_ids` are message ids known to belong to the conversation (own ids, In-Reply-To,
    /// References). Two search rounds: the second catches replies to replies.
    pub async fn get_thread(&self, folder: &str, seed_ids: &[String]) -> Result<Vec<MessageSummary>> {
        if self.roles.lock().unwrap().is_empty() {
            let _ = self.list_folders().await;
        }
        let current = real_folder(folder);
        let mut folders = vec![current.clone()];
        for f in [Some("INBOX".to_string()), self.role_path("sent"), self.role_path("archive")].into_iter().flatten() {
            if !folders.contains(&f) {
                folders.push(f);
            }
        }
        let mut ids: Vec<String> = vec![];
        for id in seed_ids.iter().map(|s| s.trim().trim_matches(|c| c == '<' || c == '>').to_string()) {
            if !id.is_empty() && !ids.contains(&id) {
                ids.push(id);
            }
        }
        // (folder, uid) -> summary
        let mut members: HashMap<(String, u32), MessageSummary> = HashMap::new();
        for _round in 0..2 {
            let Some(query) = thread_search_query(&ids) else { break };
            let before = ids.len();
            for fld in &folders {
                let (f2, q2) = (fld.clone(), query.clone());
                let uids: Vec<u32> = match self
                    .run(move |c| {
                        let (folder, q) = (f2.clone(), q2.clone());
                        Box::pin(async move {
                            c.select(&folder).await?;
                            let mut v: Vec<u32> = c.session.uid_search(&q).await?.into_iter().collect();
                            v.sort_unstable_by(|a, b| b.cmp(a));
                            v.truncate(100);
                            Ok(v)
                        })
                    })
                    .await
                {
                    Ok(v) => v,
                    Err(e) if e.to_string().starts_with("AUTH:") => return Err(e),
                    Err(_) => continue, // a folder that can't be searched shouldn't break the conversation
                };
                let todo: Vec<u32> = uids.iter().copied().filter(|u| !members.contains_key(&(fld.clone(), *u))).collect();
                if todo.is_empty() {
                    continue;
                }
                let mut have = self.cache.summaries(fld, &todo);
                let missing: Vec<u32> = todo.iter().copied().filter(|u| !have.contains_key(u)).collect();
                if !missing.is_empty() {
                    for m in self.fetch_summaries(fld, &missing).await? {
                        have.insert(m.uid, m);
                    }
                }
                for (uid, m) in have {
                    for id in std::iter::once(&m.message_id).chain(std::iter::once(&m.in_reply_to)).chain(m.references.iter()) {
                        if !id.is_empty() && !ids.contains(id) {
                            ids.push(id.clone());
                        }
                    }
                    members.insert((fld.clone(), uid), m);
                }
            }
            if ids.len() == before {
                break;
            }
        }
        // The same message can live in several folders (Gmail: Inbox + All Mail). Keep the
        // copy in the current folder, then Inbox, then Sent, then anything else.
        let rank = |f: &str| if f == current { 0 } else if f.eq_ignore_ascii_case("INBOX") { 1 } else if Some(f.to_string()) == self.role_path("sent") { 2 } else { 3 };
        let mut best: HashMap<String, (String, u32)> = HashMap::new();
        for (key, m) in &members {
            let k = if m.message_id.is_empty() { format!("{}:{}", key.0, key.1) } else { m.message_id.clone() };
            match best.get(&k) {
                Some(cur) if rank(&cur.0) <= rank(&key.0) => {}
                _ => {
                    best.insert(k, key.clone());
                }
            }
        }
        let mut out: Vec<MessageSummary> = best
            .into_values()
            .filter_map(|key| {
                let mut m = members.remove(&key)?;
                m.folder = key.0.clone();
                m.account = self.cfg.id.clone();
                m.id = format!("{}:{}:{}", self.cfg.id, key.0, key.1);
                Some(m)
            })
            .collect();
        out.sort_by_key(|m| m.date);
        Ok(out)
    }

    /// Make sure the newest `limit` messages of a special folder (e.g. Sent) are in the local
    /// cache, so conversations can find your replies instantly without a slow server
    /// search. Runs on the background connection. Returns how many were fetched.
    pub async fn sync_recent(&self, role: &str, limit: usize) -> Result<usize> {
        if self.roles.lock().unwrap().is_empty() {
            let _ = self.list_folders().await;
        }
        let Some(path) = self.role_path(role) else { return Ok(0) };
        let f = path.clone();
        let mut uids: Vec<u32> = self
            .run_on(&self.bg, move |c| {
                let f = f.clone();
                Box::pin(async move {
                    c.select(&f).await?;
                    Ok(c.session.uid_search("ALL").await?.into_iter().collect())
                })
            })
            .await?;
        uids.sort_unstable_by(|a, b| b.cmp(a));
        uids.truncate(limit);
        let have = self.cache.summaries(&path, &uids);
        let missing: Vec<u32> = uids.into_iter().filter(|u| !have.contains_key(u)).collect();
        for chunk in missing.chunks(50) {
            let (f, set) = (path.clone(), uid_set(chunk));
            let got: Vec<MessageSummary> = self
                .run_on(&self.bg, move |c| {
                    let (folder, set) = (f.clone(), set.clone());
                    Box::pin(async move {
                        c.ensure_selected(&folder).await?;
                        let fetches: Vec<_> = c.session.uid_fetch(&set, SUMMARY_QUERY).await?.try_collect().await?;
                        Ok(fetches.iter().filter_map(|x| summary_from_fetch(x, &folder)).collect())
                    })
                })
                .await?;
            self.cache.put_summaries(&path, &got);
        }
        Ok(missing.len())
    }

    /// The sender name on the account's own Sent mail (newest first), if any.
    pub async fn sent_name(&self) -> Result<Option<String>> {
        if self.roles.lock().unwrap().is_empty() {
            let _ = self.list_folders().await;
        }
        let Some(sent) = self.role_path("sent") else { return Ok(None) };
        let f = sent.clone();
        let mut uids: Vec<u32> = self
            .run(move |c| {
                let f = f.clone();
                Box::pin(async move {
                    c.select(&f).await?;
                    Ok(c.session.uid_search("ALL").await?.into_iter().collect())
                })
            })
            .await?;
        uids.sort_unstable_by(|a, b| b.cmp(a));
        uids.truncate(30);
        if uids.is_empty() {
            return Ok(None);
        }
        let mut have = self.cache.summaries(&sent, &uids);
        let missing: Vec<u32> = uids.iter().copied().filter(|u| !have.contains_key(u)).collect();
        if !missing.is_empty() {
            for m in self.fetch_summaries(&sent, &missing).await? {
                have.insert(m.uid, m);
            }
        }
        let newest_first: Vec<MessageSummary> = uids.iter().filter_map(|u| have.remove(u)).collect();
        Ok(pick_sent_name(&newest_first, &self.cfg.email))
    }

    pub async fn folder_op(&self, op: &str, path: &str, new_path: Option<&str>) -> Result<()> {
        let op = op.to_string();
        let path = path.to_string();
        let new_path = new_path.map(|s| s.to_string());
        let p2 = path.clone();
        let is_create = op == "create";
        self.run(move |c| {
            let (op, path, new_path) = (op.clone(), p2.clone(), new_path.clone());
            Box::pin(async move {
                if c.selected.as_deref() == Some(path.as_str()) {
                    let _ = c.session.close().await;
                    c.selected = None;
                }
                match op.as_str() {
                    "create" => c.session.create(&path).await?,
                    "delete" => c.session.delete(&path).await?,
                    "rename" => c.session.rename(&path, new_path.as_deref().unwrap_or(&path)).await?,
                    _ => bail!("unknown folder operation"),
                }
                Ok(())
            })
        })
        .await?;
        if !is_create {
            self.cache.clear_folder(&path);
        }
        Ok(())
    }
}

/// Background IMAP IDLE watcher on INBOX. Calls `notify` whenever the server
/// reports a change.
pub async fn idle_loop<F, A>(cfg: AccountConfig, creds: Credentials, notify: F, on_auth_fail: A)
where
    F: Fn() + Send + Sync + 'static,
    A: Fn() + Send + Sync + 'static,
{
    use tokio::time::timeout;
    // Servers drop IDLE after ~30 min, but home routers often forget idle connections
    // after 5-10, silently. Re-issue IDLE well before that, and put a time limit on every
    // step so a dead connection is noticed and replaced instead of hanging forever.
    const IDLE_FOR: Duration = Duration::from_secs(9 * 60);
    const STEP: Duration = Duration::from_secs(30);
    let who = format!("{} account {}", cfg.provider, cfg.id);
    let mut failures = 0u32;
    loop {
        let res: Result<()> = async {
            let mut session = connect(&cfg, &creds).await?;
            timeout(STEP, session.select("INBOX")).await.map_err(|_| anyhow!("timed out opening INBOX"))??;
            crate::applog::log("idle", format!("{who}: watching INBOX"));
            failures = 0;
            // Catch up on anything that arrived while we weren't connected.
            notify();
            loop {
                let mut idle = session.idle();
                timeout(STEP, idle.init()).await.map_err(|_| anyhow!("timed out starting IDLE"))??;
                let (fut, stop) = idle.wait_with_timeout(IDLE_FOR);
                let r = fut.await?;
                drop(stop);
                session = timeout(STEP, idle.done()).await.map_err(|_| anyhow!("timed out ending IDLE (connection lost)"))??;
                if let async_imap::extensions::idle::IdleResponse::NewData(_) = r {
                    while session.unsolicited_responses.try_recv().is_ok() {}
                    crate::applog::log("idle", format!("{who}: new data"));
                    notify();
                }
            }
        }
        .await;
        if let Err(e) = res {
            if e.to_string().starts_with("AUTH:") {
                // The password or sign-in no longer works: tell the UI, stop retrying.
                crate::applog::log("idle", format!("{who}: sign-in rejected, stopped watching"));
                on_auth_fail();
                return;
            }
            crate::applog::log("idle", format!("{who}: watcher stopped: {e:#}"));
        }
        failures += 1;
        // Reconnect quickly the first time (a blip), then back off.
        tokio::time::sleep(Duration::from_secs(if failures == 1 { 5 } else { 30 })).await;
    }
}

/// The first real name (not an address) the account itself sent mail under.
pub fn pick_sent_name(newest_first: &[MessageSummary], email: &str) -> Option<String> {
    newest_first
        .iter()
        .map(|m| &m.from)
        .find(|p| p.email.eq_ignore_ascii_case(email) && !p.name.trim().is_empty() && !p.name.contains('@'))
        .map(|p| p.name.trim().to_string())
}

/// IMAP SEARCH criteria matching any message whose Message-ID, References or In-Reply-To
/// contains one of `ids` (up to 8 ids; IMAP's OR is binary, so it's nested).
pub fn thread_search_query(ids: &[String]) -> Option<String> {
    let mut terms = vec![];
    for id in ids.iter().filter(|s| !s.is_empty()).take(8) {
        // With angle brackets: iCloud matches header values as whole ids, and "<id>" also
        // matches inside a References list.
        let q = quote(&format!("<{id}>"));
        terms.push(format!("HEADER Message-ID {q}"));
        terms.push(format!("HEADER References {q}"));
        terms.push(format!("HEADER In-Reply-To {q}"));
    }
    let mut q = terms.pop()?;
    while let Some(t) = terms.pop() {
        q = format!("OR {t} {q}");
    }
    Some(q)
}

#[cfg(test)]
mod tests {
    use super::thread_search_query;

    #[test]
    fn picks_own_sender_name_from_sent_mail() {
        let m = |name: &str, email: &str| -> crate::model::MessageSummary {
            serde_json::from_value(serde_json::json!({
                "uid": 1, "folder": "Sent", "from": { "name": name, "email": email }, "to": [], "subject": "", "preview": "",
                "date": 0, "seen": true, "flagged": false, "answered": false, "hasAttachments": false, "attachmentNames": [],
                "size": 0, "messageId": "", "inReplyTo": "", "references": [], "threadV": 0
            }))
            .unwrap()
        };
        let me = "jane@example.com";
        let sent = [m("", me), m("someone@else.com", me), m("Other Person", "other@example.com"), m(" Jane Doe ", "JANE@example.com"), m("Old Name", me)];
        assert_eq!(super::pick_sent_name(&sent, me).as_deref(), Some("Jane Doe"));
        assert_eq!(super::pick_sent_name(&sent[..3], me), None);
    }

    #[tokio::test]
    async fn connect_gives_up_on_a_silent_server() {
        // A "server" that accepts the connection and never says anything.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = vec![];
            while let Ok((s, _)) = listener.accept().await {
                held.push(s);
            }
        });
        let p = crate::providers::by_provider("gmail").unwrap();
        let mut cfg = crate::accounts::from_preset("x@example.com", "X", &p, crate::providers::AuthKind::Password);
        cfg.imap.host = "127.0.0.1".into();
        cfg.imap.port = port;
        let creds = crate::accounts::Credentials { email: "x@example.com".into(), secret: crate::accounts::Secret::Password("pw".into()) };
        let t = std::time::Instant::now();
        let r = super::connect_within(&cfg, &creds, std::time::Duration::from_millis(500)).await;
        assert!(r.is_err());
        assert!(format!("{:#}", r.err().unwrap()).contains("not responding"));
        assert!(t.elapsed() < std::time::Duration::from_secs(5));
    }

    #[test]
    fn thread_query_nests_ors() {
        assert_eq!(thread_search_query(&[]), None);
        assert_eq!(
            thread_search_query(&["a@x".into()]).unwrap(),
            r#"OR HEADER Message-ID "<a@x>" OR HEADER References "<a@x>" HEADER In-Reply-To "<a@x>""#
        );
        let q = thread_search_query(&(0..12).map(|i| format!("id{i}@x")).collect::<Vec<_>>()).unwrap();
        assert_eq!(q.matches("HEADER").count(), 24); // capped at 8 ids
        assert_eq!(q.matches("OR ").count(), 23);
    }
}

#[cfg(test)]
mod structure_tests {
    use super::*;
    use async_imap::imap_proto::{parser::parse_response, AttributeValue, Response};

    #[test]
    fn nil_encoding_structure_lists_attachments() {
        // iCloud style: NIL transfer encoding on the plain-text part.
        let line = b"* 1 FETCH (UID 7 BODYSTRUCTURE (((\"text\" \"plain\" (\"CHARSET\" \"UTF-8\") NIL NIL NIL 1372 20 NIL NIL NIL NIL)(\"text\" \"html\" (\"CHARSET\" \"UTF-8\") NIL NIL \"quoted-printable\" 1510 20 NIL NIL NIL NIL) \"alternative\" (\"BOUNDARY\" \"b1\") NIL NIL NIL)(\"application\" \"pdf\" (\"NAME\" \"pass.pdf\") \"<c1>\" NIL \"base64\" 111054 NIL (\"ATTACHMENT\" (\"FILENAME\" \"pass.pdf\")) NIL NIL) \"mixed\" (\"BOUNDARY\" \"b0\") NIL NIL NIL))\r\n";
        let (_, r) = parse_response(line).expect("parses");
        let Response::Fetch(_, attrs) = r else { panic!("not a fetch") };
        let b = attrs.iter().find_map(|a| if let AttributeValue::BodyStructure(b) = a { Some(b) } else { None }).unwrap();
        assert_eq!(structure_attachments(b), vec!["pass.pdf".to_string()]);
    }
}
