//! "Open Pear Mail when I sign in to Windows": a per-user entry in
//! HKCU\Software\Microsoft\Windows\CurrentVersion\Run (no admin rights; it also shows in
//! Task Manager → Startup apps). The registry is the source of truth for the setting.

use serde::Serialize;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Where Task Manager / Settings → Startup apps record "disabled" for a Run entry.
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const VALUE: &str = "Pear Mail";
/// Launched by Windows at sign-in.
pub const STARTUP_FLAG: &str = "--startup";
/// ...and should stay in the notification area (no window).
pub const BACKGROUND_FLAG: &str = "--background";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OpenAtLogin {
    pub on: bool,
    pub background: bool,
}

/// The command line Windows runs at sign-in.
pub fn command_line(exe: &str, background: bool) -> String {
    let mut s = format!("\"{exe}\" {STARTUP_FLAG}");
    if background {
        s += " ";
        s += BACKGROUND_FLAG;
    }
    s
}

/// Whether a saved command line asks for a background start.
pub fn is_background(cmd: &str) -> bool {
    // Look only past the (quoted) exe path, so a folder named "--background" can't count.
    let args = match cmd.strip_prefix('"').and_then(|r| r.split_once('"')) {
        Some((_, rest)) => rest,
        None => cmd,
    };
    args.split_whitespace().any(|a| a == BACKGROUND_FLAG)
}

fn current_exe() -> Option<String> {
    Some(std::env::current_exe().ok()?.to_string_lossy().into_owned())
}

#[cfg(windows)]
mod imp {
    use super::*;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    fn saved_command() -> Option<String> {
        hkcu().open_subkey_with_flags(RUN_KEY, KEY_READ).ok()?.get_value::<String, _>(VALUE).ok()
    }

    /// Task Manager stores 12 bytes per entry; an odd first byte (0x03) means disabled.
    fn disabled_by_windows() -> bool {
        let Ok(k) = hkcu().open_subkey_with_flags(APPROVED_KEY, KEY_READ) else { return false };
        match k.get_raw_value(VALUE) {
            Ok(v) => v.bytes.first().is_some_and(|b| b & 1 == 1),
            Err(_) => false,
        }
    }

    pub fn get() -> OpenAtLogin {
        match saved_command() {
            Some(cmd) if !disabled_by_windows() => OpenAtLogin { on: true, background: is_background(&cmd) },
            Some(cmd) => OpenAtLogin { on: false, background: is_background(&cmd) },
            None => OpenAtLogin { on: false, background: false },
        }
    }

    pub fn set(on: bool, background: bool) -> Result<(), String> {
        let (run, _) = hkcu().create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        if !on {
            match run.delete_value(VALUE) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        } else {
            let exe = current_exe().ok_or("Couldn't find Pear Mail's own location.")?;
            run.set_value(VALUE, &command_line(&exe, background)).map_err(|e| e.to_string())?;
        }
        // Either way, drop a "disabled" mark from Task Manager so the switch means what it says.
        if let Ok(k) = hkcu().open_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE) {
            let _ = k.delete_value(VALUE);
        }
        Ok(())
    }

    /// At launch: point an existing entry at this exe (it may have been moved or replaced),
    /// keeping its mode. Leaves entries Windows disabled alone.
    pub fn refresh() {
        let Some(cmd) = saved_command() else { return };
        let Some(exe) = current_exe() else { return };
        let want = command_line(&exe, is_background(&cmd));
        if cmd != want {
            if let Ok(k) = hkcu().open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE) {
                let _ = k.set_value(VALUE, &want);
                crate::applog::log("startup", "updated the sign-in entry to this copy of Pear Mail");
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn get() -> OpenAtLogin {
        OpenAtLogin { on: false, background: false }
    }
    pub fn set(_on: bool, _background: bool) -> Result<(), String> {
        Err("Not supported on this system.".into())
    }
    pub fn refresh() {}
}

pub use imp::{get, refresh, set};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_and_reads_command_lines() {
        let exe = r"C:\Program Files\Pear Mail\pearmail.exe";
        let fg = command_line(exe, false);
        let bg = command_line(exe, true);
        assert_eq!(fg, r#""C:\Program Files\Pear Mail\pearmail.exe" --startup"#);
        assert_eq!(bg, r#""C:\Program Files\Pear Mail\pearmail.exe" --startup --background"#);
        assert!(!is_background(&fg));
        assert!(is_background(&bg));
        // A folder that happens to be called --background is part of the path, not a flag.
        assert!(!is_background(r#""C:\--background\pearmail.exe" --startup"#));
    }
}
