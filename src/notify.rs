//! Windows toast notifications under Pear Mail's own identity.
//!
//! Windows shows a toast's app name and icon from the sender's AppUserModelID (AUMID).
//! An app that isn't installed through an MSIX/Start-menu shortcut has to register that
//! AUMID itself (HKCU\Software\Classes\AppUserModelId\<id> with DisplayName/IconUri),
//! otherwise toasts are attributed to "Windows PowerShell" (the notification plugin's
//! fallback) or aren't shown at all.

use std::path::PathBuf;

pub const AUMID: &str = "PearMail.Mail";
const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");

/// The app icon as a file Windows can load for toasts (kept up to date).
fn icon_path() -> Option<PathBuf> {
    let p = dirs::config_dir()?.join("PearMail").join("notification-icon.png");
    if std::fs::read(&p).ok().as_deref() != Some(ICON_PNG) {
        std::fs::create_dir_all(p.parent()?).ok()?;
        std::fs::write(&p, ICON_PNG).ok()?;
    }
    Some(p)
}

/// Register "Pear Mail" + icon for our AUMID (per-user, no admin rights needed).
pub fn register() {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let path = format!(r"Software\Classes\AppUserModelId\{AUMID}");
        let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&path) else { return };
        let _ = key.set_value("DisplayName", &"Pear Mail");
        if let Some(icon) = icon_path() {
            let _ = key.set_value("IconUri", &icon.to_string_lossy().to_string());
        }
        let _ = key.set_value("IconBackgroundColor", &"0");
        let _ = key.set_value("ShowInSettings", &1u32);
    }
}

/// Escape text for the toast XML.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// The toast XML: a title and up to two lines of text, with the Mail sound.
fn toast_xml(title: &str, body: &str) -> String {
    let mut lines = body.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("");
    let rest: Vec<&str> = lines.collect();
    let mut texts = format!("<text>{}</text>", xml_escape(title));
    if !first.is_empty() {
        texts += &format!("<text>{}</text>", xml_escape(first));
    }
    if !rest.is_empty() {
        texts += &format!("<text>{}</text>", xml_escape(&rest.join(" · ")));
    }
    format!(r#"<toast><visual><binding template="ToastGeneric">{texts}</binding></visual><audio src="ms-winsoundevent:Notification.Mail"/></toast>"#)
}

/// A WinRT toast sent under our own AUMID (directly through the `windows` crate).
#[cfg(windows)]
fn show_toast(title: &str, body: &str, on_click: impl Fn() + Send + 'static) -> windows::core::Result<()> {
    use windows::core::{IInspectable, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, _| {
        on_click();
        Ok(())
    }))?;
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?.Show(&toast)
}

#[cfg(test)]
mod tests {
    #[test]
    fn toast_xml_escapes_and_splits_lines() {
        let x = super::toast_xml("A & B", "Hi <there>\n\nsecond\nthird");
        assert!(x.contains("<text>A &amp; B</text><text>Hi &lt;there&gt;</text><text>second · third</text>"));
        assert!(x.contains("Notification.Mail"));
    }
}

/// Show a toast. `on_click` runs when the user clicks it.
pub fn show(title: &str, body: &str, on_click: impl Fn() + Send + 'static) -> Result<(), String> {
    #[cfg(windows)]
    {
        show_toast(title, body, on_click).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body, on_click);
        Ok(())
    }
}
