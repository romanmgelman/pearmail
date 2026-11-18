//! On-disk cache (SQLite) of folder lists, message summaries and full message
//! bodies, so the app starts instantly and opens already-seen mail offline.

use crate::model::{Folder, MessageSummary};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

/// Total size budget for cached message bodies.
const BODY_BUDGET: i64 = 768 * 1024 * 1024;
/// Messages larger than this are never cached.
pub const MAX_CACHED_BODY: usize = 40 * 1024 * 1024;

pub struct Cache {
    conn: Mutex<Connection>,
    path: PathBuf,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn path_for(account: &str) -> PathBuf {
    let safe: String = account.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '@' { c } else { '_' }).collect();
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("PearMail").join(format!("cache-{safe}.sqlite"))
}

impl Cache {
    pub fn open(account: &str) -> Result<Self> {
        let path = path_for(account);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(&path)?;
        Self::init(conn, path)
    }

    #[allow(dead_code)]
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?, PathBuf::new())
    }

    fn init(conn: Connection, path: PathBuf) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS messages (
                folder TEXT NOT NULL, uid INTEGER NOT NULL, date INTEGER NOT NULL, json TEXT NOT NULL,
                PRIMARY KEY (folder, uid));
             CREATE TABLE IF NOT EXISTS bodies (
                folder TEXT NOT NULL, uid INTEGER NOT NULL, raw BLOB NOT NULL, size INTEGER NOT NULL, accessed INTEGER NOT NULL,
                PRIMARY KEY (folder, uid));
             CREATE INDEX IF NOT EXISTS bodies_accessed ON bodies(accessed);",
        )?;
        let cache = Cache { conn: Mutex::new(conn), path };
        cache.drop_broken_previews();
        Ok(cache)
    }

    /// One-time repair: summaries saved with an unreadable preview (undecoded base64 from a
    /// part cut off by the summary download, or raw HTML from a text/plain part that holds
    /// HTML) are dropped, so they're fetched again with a readable one.
    fn drop_broken_previews(&self) {
        if self.meta_get("fix_previews_3").is_some() {
            return;
        }
        {
            let c = self.conn.lock().unwrap();
            let mut rows: Vec<(String, u32, String)> = vec![];
            if let Ok(mut st) = c.prepare("SELECT folder, uid, json FROM messages") {
                if let Ok(it) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?, r.get::<_, String>(2)?))) {
                    rows = it.filter_map(Result::ok).collect();
                }
            }
            let bad: Vec<(String, u32)> = rows
                .into_iter()
                .filter(|(_, _, j)| {
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(j) else { return false };
                    let p = v.get("preview").and_then(|p| p.as_str()).unwrap_or("");
                    // A short preview of a big email may have been cut short by the download.
                    let short = p.chars().count() < 80 && v.get("size").and_then(|s| s.as_u64()).unwrap_or(0) > 16384;
                    crate::mime::looks_b64(p) || crate::mime::looks_html(p) || short
                })
                .map(|(f, u, _)| (f, u))
                .collect();
            for (f, u) in &bad {
                let _ = c.execute("DELETE FROM messages WHERE folder=?1 AND uid=?2", rusqlite::params![f, u]);
            }
        }
        self.meta_set("fix_previews_3", "1");
    }

    fn meta_get(&self, key: &str) -> Option<String> {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT value FROM meta WHERE key=?1", [key], |r| r.get(0)).optional().ok().flatten()
    }

    fn meta_set(&self, key: &str, value: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute("INSERT INTO meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
    }

    pub fn folders(&self) -> Option<Vec<Folder>> {
        self.meta_get("folders").and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn put_folders(&self, folders: &[Folder]) {
        if let Ok(s) = serde_json::to_string(folders) {
            self.meta_set("folders", &s);
        }
    }

    /// Record the folder's UIDVALIDITY; if it changed, the cached UIDs are stale and are dropped.
    pub fn check_validity(&self, folder: &str, validity: Option<u32>) {
        let Some(v) = validity else { return };
        let key = format!("validity:{folder}");
        let old = self.meta_get(&key);
        if old.as_deref() != Some(&v.to_string()) {
            if old.is_some() {
                self.clear_folder(folder);
            }
            self.meta_set(&key, &v.to_string());
        }
    }

    pub fn clear_folder(&self, folder: &str) {
        let c = self.conn.lock().unwrap();
        let _ = c.execute("DELETE FROM messages WHERE folder=?1", [folder]);
        let _ = c.execute("DELETE FROM bodies WHERE folder=?1", [folder]);
    }

    pub fn summaries(&self, folder: &str, uids: &[u32]) -> HashMap<u32, MessageSummary> {
        let c = self.conn.lock().unwrap();
        let mut out = HashMap::new();
        let Ok(mut st) = c.prepare_cached("SELECT json FROM messages WHERE folder=?1 AND uid=?2") else { return out };
        for &u in uids {
            if let Ok(Some(json)) = st.query_row(params![folder, u], |r| r.get::<_, String>(0)).optional() {
                if let Ok(m) = serde_json::from_str::<MessageSummary>(&json) {
                    out.insert(u, m);
                }
            }
        }
        out
    }

    pub fn put_summaries(&self, folder: &str, msgs: &[MessageSummary]) {
        let mut c = self.conn.lock().unwrap();
        let Ok(tx) = c.transaction() else { return };
        {
            let Ok(mut st) = tx.prepare_cached(
                "INSERT INTO messages(folder,uid,date,json) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(folder,uid) DO UPDATE SET date=excluded.date, json=excluded.json",
            ) else { return };
            for m in msgs {
                if let Ok(json) = serde_json::to_string(m) {
                    let _ = st.execute(params![folder, m.uid, m.date, json]);
                }
            }
        }
        let _ = tx.commit();
    }

    /// Newest cached summaries of a folder (by UID), for instant display.
    pub fn latest(&self, folder: &str, limit: usize) -> Vec<MessageSummary> {
        let c = self.conn.lock().unwrap();
        let Ok(mut st) = c.prepare_cached("SELECT json FROM messages WHERE folder=?1 ORDER BY uid DESC LIMIT ?2") else { return vec![] };
        let rows = st.query_map(params![folder, limit as i64], |r| r.get::<_, String>(0));
        match rows {
            Ok(rows) => rows.filter_map(|r| r.ok()).filter_map(|j| serde_json::from_str(&j).ok()).collect(),
            Err(_) => vec![],
        }
    }

    #[allow(dead_code)]
    pub fn count(&self, folder: &str) -> usize {
        let c = self.conn.lock().unwrap();
        c.query_row("SELECT COUNT(*) FROM messages WHERE folder=?1", [folder], |r| r.get::<_, i64>(0)).unwrap_or(0) as usize
    }

    /// Drop cached messages of `folder` that are no longer on the server.
    pub fn retain(&self, folder: &str, keep: &HashSet<u32>) {
        let cached: Vec<u32> = {
            let c = self.conn.lock().unwrap();
            let Ok(mut st) = c.prepare("SELECT uid FROM messages WHERE folder=?1") else { return };
            let x = st.query_map([folder], |r| r.get::<_, u32>(0)).map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default();
            x
        };
        let gone: Vec<u32> = cached.into_iter().filter(|u| !keep.contains(u)).collect();
        self.remove(folder, &gone);
    }

    /// Like `retain`, but only for cached UIDs in `lo..=hi` (the part of the mailbox just
    /// listed), so huge mailboxes never need their full UID list.
    pub fn retain_range(&self, folder: &str, lo: u32, hi: u32, keep: &HashSet<u32>) {
        if lo > hi {
            return;
        }
        let cached: Vec<u32> = {
            let c = self.conn.lock().unwrap();
            let Ok(mut st) = c.prepare("SELECT uid FROM messages WHERE folder=?1 AND uid BETWEEN ?2 AND ?3") else { return };
            let x = st.query_map(params![folder, lo, hi], |r| r.get::<_, u32>(0)).map(|r| r.filter_map(|x| x.ok()).collect()).unwrap_or_default();
            x
        };
        let gone: Vec<u32> = cached.into_iter().filter(|u| !keep.contains(u)).collect();
        self.remove(folder, &gone);
    }

    pub fn remove(&self, folder: &str, uids: &[u32]) {
        if uids.is_empty() {
            return;
        }
        let mut c = self.conn.lock().unwrap();
        let Ok(tx) = c.transaction() else { return };
        for u in uids {
            let _ = tx.execute("DELETE FROM messages WHERE folder=?1 AND uid=?2", params![folder, u]);
            let _ = tx.execute("DELETE FROM bodies WHERE folder=?1 AND uid=?2", params![folder, u]);
        }
        let _ = tx.commit();
    }

    pub fn update_flag(&self, folder: &str, uids: &[u32], flag: &str, on: bool) {
        let mut found = self.summaries(folder, uids);
        for m in found.values_mut() {
            match flag {
                "\\Seen" => m.seen = on,
                "\\Flagged" => m.flagged = on,
                "\\Answered" => m.answered = on,
                _ => {}
            }
        }
        let list: Vec<_> = found.into_values().collect();
        self.put_summaries(folder, &list);
    }

    pub fn body(&self, folder: &str, uid: u32) -> Option<Vec<u8>> {
        let c = self.conn.lock().unwrap();
        let raw: Option<Vec<u8>> =
            c.query_row("SELECT raw FROM bodies WHERE folder=?1 AND uid=?2", params![folder, uid], |r| r.get(0)).optional().ok().flatten();
        if raw.is_some() {
            let _ = c.execute("UPDATE bodies SET accessed=?3 WHERE folder=?1 AND uid=?2", params![folder, uid, now()]);
        }
        raw
    }

    pub fn has_bodies(&self, folder: &str, uids: &[u32]) -> HashSet<u32> {
        let c = self.conn.lock().unwrap();
        let Ok(mut st) = c.prepare_cached("SELECT 1 FROM bodies WHERE folder=?1 AND uid=?2") else { return HashSet::new() };
        uids.iter().copied().filter(|&u| st.exists(params![folder, u]).unwrap_or(false)).collect()
    }

    pub fn put_body(&self, folder: &str, uid: u32, raw: &[u8]) {
        if raw.is_empty() || raw.len() > MAX_CACHED_BODY {
            return;
        }
        let c = self.conn.lock().unwrap();
        let _ = c.execute(
            "INSERT INTO bodies(folder,uid,raw,size,accessed) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(folder,uid) DO UPDATE SET raw=excluded.raw, size=excluded.size, accessed=excluded.accessed",
            params![folder, uid, raw, raw.len() as i64, now()],
        );
        // Evict least-recently-read bodies beyond the budget.
        let total: i64 = c.query_row("SELECT COALESCE(SUM(size),0) FROM bodies", [], |r| r.get(0)).unwrap_or(0);
        if total > BODY_BUDGET {
            let _ = c.execute(
                "DELETE FROM bodies WHERE rowid IN (SELECT rowid FROM bodies ORDER BY accessed ASC LIMIT
                   (SELECT MAX(1, COUNT(*)/5) FROM bodies))",
                [],
            );
        }
    }

    /// Delete the cache file entirely (used on sign out).
    pub fn destroy(self) {
        let path = self.path.clone();
        drop(self.conn);
        for suffix in ["", "-wal", "-shm"] {
            let mut p = path.clone().into_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Person;

    fn msg(uid: u32) -> MessageSummary {
        MessageSummary {
            uid,
            folder: "INBOX".into(),
            account: String::new(),
            id: String::new(),
            from: Person { name: "A".into(), email: "a@x.com".into() },
            to: vec![],
            subject: format!("s{uid}"),
            preview: String::new(),
            date: uid as i64,
            seen: false,
            flagged: false,
            answered: false,
            has_attachments: false,
            attachment_names: vec![],
            size: 0,
            message_id: format!("m{uid}"),
            in_reply_to: String::new(),
            references: vec![],
            thread_v: 1,
            preview_v: crate::model::PREVIEW_V,
        }
    }

    #[test]
    fn roundtrip() {
        let c = Cache::in_memory().unwrap();
        c.put_summaries("INBOX", &[msg(1), msg(2), msg(3)]);
        assert_eq!(c.latest("INBOX", 2).iter().map(|m| m.uid).collect::<Vec<_>>(), vec![3, 2]);
        c.update_flag("INBOX", &[2], "\\Seen", true);
        assert!(c.summaries("INBOX", &[2])[&2].seen);
        c.retain("INBOX", &[1, 2].into_iter().collect());
        assert_eq!(c.count("INBOX"), 2);
        c.put_body("INBOX", 1, b"hello");
        assert_eq!(c.body("INBOX", 1).unwrap(), b"hello");
        assert_eq!(c.has_bodies("INBOX", &[1, 2]), [1].into_iter().collect());
        c.check_validity("INBOX", Some(5));
        assert_eq!(c.count("INBOX"), 2);
        c.check_validity("INBOX", Some(6));
        assert_eq!(c.count("INBOX"), 0);
    }

    #[test]
    fn retain_range_only_touches_the_listed_window() {
        let c = Cache::in_memory().unwrap();
        c.put_summaries("INBOX", &[msg(1), msg(5), msg(6), msg(7), msg(9)]);
        // Listed 5..=9 and found 5 and 9: 6 and 7 are gone, 1 (outside) stays.
        c.retain_range("INBOX", 5, 9, &HashSet::from([5, 9]));
        let mut left: Vec<u32> = c.latest("INBOX", 10).into_iter().map(|m| m.uid).collect();
        left.sort();
        assert_eq!(left, vec![1, 5, 9]);
    }
}
