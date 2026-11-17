//! A small diagnostic log (%APPDATA%\PearMail\logs\pearmail.log) that users can send
//! when something doesn't work. It records connection and sync events and error text
//! only: never message subjects, bodies, email addresses, passwords or tokens.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: u64 = 1024 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

/// Where the log lives.
pub fn path() -> Option<PathBuf> {
    Some(dirs::config_dir()?.join("PearMail").join("logs").join("pearmail.log"))
}

/// Replace anything that looks like an email address (error texts can contain one).
fn redact(msg: &str) -> String {
    msg.split(' ')
        .map(|w| if w.contains('@') && w.contains('.') { "<address>" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
}

/// One log line: local time, kind, message (newlines flattened, addresses removed).
fn line(kind: &str, msg: &str) -> String {
    let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S");
    format!("{now} [{kind}] {}\n", redact(&msg.replace(['\r', '\n'], " ")))
}

/// Append to `file`, moving it to `<name>.1.log` once it grows past `max` bytes.
fn append(file: &Path, text: &str, max: u64) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(file).map(|m| m.len() >= max).unwrap_or(false) {
        let _ = std::fs::rename(file, file.with_extension("1.log"));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(file)?.write_all(text.as_bytes())
}

/// Record an event. Never fails (logging must not break the app).
pub fn log(kind: &str, msg: impl AsRef<str>) {
    let Some(p) = path() else { return };
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _ = append(&p, &line(kind, msg.as_ref()), MAX_BYTES);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_lines_and_rotates() {
        let dir = std::env::temp_dir().join(format!("pm-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let f = dir.join("pearmail.log");
        let l = line("imap", "first\nline");
        assert!(l.ends_with(" [imap] first line\n"));
        assert!(line("error", "password for bob@gmail.com is wrong").contains("for <address> is wrong"));
        append(&f, &l, 10).unwrap();
        append(&f, &line("imap", "second"), 10).unwrap(); // over 10 bytes: rotates first
        assert!(std::fs::read_to_string(dir.join("pearmail.1.log")).unwrap().contains("first line"));
        let cur = std::fs::read_to_string(&f).unwrap();
        assert!(cur.contains("second") && !cur.contains("first"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
