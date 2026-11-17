// Hide the console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod applog;
mod cache;
mod commands;
mod contacts;
mod crash_guard;
mod imap;
mod mime;
mod notify;
mod model;
mod oauth;
mod providers;
mod smtp;

fn main() {
    // Let Windows show notifications as "Pear Mail" with our icon (not PowerShell).
    notify::register();
    applog::log("app", format!("Pear Mail {} started ({})", env!("CARGO_PKG_VERSION"), windows_build()));
    // Developer diagnostics (debug builds only, so release builds have no command-line
    // modes that read account data): `--diagnose <file>` runs the inbox sync with the saved
    // account and writes errors/counts (no message content, no password) to <file>.
    #[cfg(debug_assertions)]
    {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("--test-notification") {
        let r = notify::show("Pear Mail", "This is a test notification.
It should show the Pear Mail name and icon.", || {});
        std::thread::sleep(std::time::Duration::from_secs(6));
        if let Err(e) = r { eprintln!("{e}"); }
        return;
    }
    if args.get(1).map(|s| s.as_str()) == Some("--thread") {
        let who = args.get(2).cloned().unwrap_or_default().to_lowercase();
        let out = args.get(3).cloned().unwrap_or_else(|| "pearmail-thread.txt".into());
        let report = tauri::async_runtime::block_on(async {
            let Some((cfg, creds)) = first_account() else { return "no saved account".to_string() };
            let imap = imap::Imap::new(cfg, creds, std::sync::Arc::new(cache::Cache::in_memory().expect("cache")));
            let page = match imap.list_messages("INBOX", "all", "", &[], 0, 200).await { Ok(p) => p, Err(e) => return format!("list error {e:#}") };
            let with_thread: Vec<_> = page.messages.iter().filter(|m| m.thread_v == 1 && (!m.in_reply_to.is_empty() || !m.references.is_empty())).collect();
            let mut r = format!("inbox: {} messages, {} are replies (have In-Reply-To/References)
", page.messages.len(), with_thread.len());
            let deepest = page.messages.iter().max_by_key(|m| m.references.len());
            let Some(m) = (if who == "*" { deepest } else { None }).or_else(|| page.messages.iter().find(|m| m.from.name.to_lowercase().contains(&who) && !m.references.is_empty())).or_else(|| page.messages.iter().find(|m| m.from.name.to_lowercase().contains(&who))) else { return r + "sender not found" };
            let mut ids = vec![m.message_id.clone(), m.in_reply_to.clone()];
            ids.extend(m.references.iter().cloned());
            let mid = m.message_id.clone();
            let root = m.references.first().cloned().unwrap_or_default();
            r += &format!("seed: id len {}, refs {}, has irt {}
", mid.len(), m.references.len(), !m.in_reply_to.is_empty());
            for (label, q) in [
                ("msgid bare", format!("HEADER Message-ID \"{mid}\"")),
                ("msgid <>", format!("HEADER Message-ID \"<{mid}>\"")),
                ("refs root bare", format!("HEADER References \"{root}\"")),
                ("refs root <>", format!("HEADER References \"<{root}>\"")),
                ("full query", imap::thread_search_query(&ids).unwrap_or_default()),
            ] {
                match imap.search_count("INBOX", &q).await {
                    Ok(n) => r += &format!("  {label}: {n}
"),
                    Err(e) => r += &format!("  {label}: ERROR {}
", e.to_string().chars().take(160).collect::<String>()),
                }
            }
            if let Ok(folders) = imap.list_folders().await {
                let q = imap::thread_search_query(&ids).unwrap_or_default();
                for f in folders.iter().filter(|f| f.selectable) {
                    if let Ok(n) = imap.search_count(&f.path, &q).await {
                        r += &format!("  conversation in folder #{} (role {:?}): {n}
", folders.iter().position(|x| x.path == f.path).unwrap_or(0), f.role);
                    }
                }
                // How many multi-message conversations exist among recent Inbox + Sent mail?
                let sent = folders.iter().find(|f| f.role.as_deref() == Some("sent")).map(|f| f.path.clone());
                let mut all = page.messages.clone();
                if let Some(s) = sent { if let Ok(p) = imap.list_messages(&s, "all", "", &[], 0, 200).await { all.extend(p.messages); } }
                let mut parent: std::collections::HashMap<String, String> = Default::default();
                fn find(p: &mut std::collections::HashMap<String, String>, x: &str) -> String { let mut x = x.to_string(); while let Some(y) = p.get(&x).cloned() { if y == x { break; } x = y; } x }
                for m in &all { let ids: Vec<String> = std::iter::once(m.message_id.clone()).chain(std::iter::once(m.in_reply_to.clone())).chain(m.references.iter().cloned()).filter(|s| !s.is_empty()).collect(); if let Some(a) = ids.first() { for b in &ids[1..] { let (ra, rb) = (find(&mut parent, a), find(&mut parent, b)); if ra != rb { parent.insert(rb, ra); } } } }
                let mut groups: std::collections::HashMap<String, usize> = Default::default();
                for m in &all { if !m.message_id.is_empty() { *groups.entry(find(&mut parent, &m.message_id)).or_default() += 1; } }
                let mut sizes: Vec<usize> = groups.values().copied().filter(|n| *n > 1).collect();
                sizes.sort_unstable_by(|a, b| b.cmp(a));
                r += &format!("recent inbox+sent: {} messages, conversations with 2+ messages: {} (sizes {:?})
", all.len(), sizes.len(), sizes);
                // Compare: server-side get_thread on a member of the largest group.
                if let Some((root, n)) = groups.iter().max_by_key(|(_, n)| **n).map(|(k, n)| (k.clone(), *n)) {
                    let member = all.iter().find(|m| !m.message_id.is_empty() && find(&mut parent, &m.message_id) == root).cloned();
                    if let Some(mm) = member {
                        let mut seeds = vec![mm.message_id.clone(), mm.in_reply_to.clone()];
                        seeds.extend(mm.references.iter().cloned());
                        let t = std::time::Instant::now();
                        match imap.get_thread(&mm.folder, &seeds).await {
                            Ok(found) => {
                                let mut by = std::collections::BTreeMap::new();
                                for x in &found { *by.entry(if x.folder == "INBOX" { "inbox".to_string() } else { "other".to_string() }).or_insert(0) += 1; }
                                r += &format!("largest group: {n} by headers; get_thread found {} in {:?} {:?}
", found.len(), t.elapsed(), by);
                            }
                            Err(e) => r += &format!("largest group get_thread error {e:#}
"),
                        }
                    }
                }
            }
            let t = std::time::Instant::now();
            match imap.get_thread("INBOX", &ids).await {
                Ok(members) => {
                    r += &format!("thread: {} members in {:?}
", members.len(), t.elapsed());
                    let mut by_folder = std::collections::BTreeMap::new();
                    for x in &members { *by_folder.entry(x.folder.clone()).or_insert(0) += 1; }
                    r += &format!("by folder: {by_folder:?}
");
                }
                Err(e) => r += &format!("thread error {e:#}"),
            }
            r
        });
        let _ = std::fs::write(out, report);
        return;
    }
    if args.get(1).map(|s| s.as_str()) == Some("--contacts") {
        let out = args.get(2).cloned().unwrap_or_else(|| "pearmail-contacts.txt".into());
        let report = tauri::async_runtime::block_on(async {
            let Some((_, creds)) = first_account() else { return "no saved account".to_string() };
            let Some(pw) = creds.password().map(|s| s.to_string()) else { return "not a password account".to_string() };
            let t = std::time::Instant::now();
            match contacts::sync(&creds.email, &pw).await {
                Ok((map, s)) => format!("ok in {:?}: {} cards, {} with photo, {} emails with photo, map size {}", t.elapsed(), s.cards, s.with_photo, s.emails_with_photo, map.len()),
                Err(e) => format!("ERROR: {e:#}"),
            }
        });
        let _ = std::fs::write(out, report);
        return;
    }
    if args.get(1).map(|s| s.as_str()) == Some("--inspect") {
        let who = args.get(2).cloned().unwrap_or_default();
        let out = args.get(3).cloned().unwrap_or_else(|| "pearmail-inspect.txt".into());
        let report = tauri::async_runtime::block_on(inspect(&who));
        let _ = std::fs::write(out, report);
        return;
    }
    if args.get(1).map(|s| s.as_str()) == Some("--diagnose") {
        let out = args.get(2).cloned().unwrap_or_else(|| "pearmail-diagnose.txt".into());
        let report = tauri::async_runtime::block_on(diagnose());
        let _ = std::fs::write(out, report);
        return;
    }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| commands::show_main(app)))
        // "Keep running in the background": closing hides the window (tray icon stays).
        .on_window_event(|w, e| {
            use tauri::Manager;
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == "main" && w.state::<commands::AppState>().run_in_background.load(std::sync::atomic::Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        // Restore the saved size/position while the window is still hidden; it's shown once
        // the page has painted (no small default-size window flashing first).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .setup(|app| {
            std::thread::spawn(commands::clean_staging);
            // Safety net: show the window even if the page never signals it's ready.
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                // Reload by itself (and log why) if the page's process crashes.
                crash_guard::install(&w);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                });
            }
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::restore_session,
            commands::sign_out,
            commands::set_display_name,
            commands::reorder_accounts,
            commands::set_sender_name,
            commands::sync_recent,
            commands::list_accounts,
            commands::add_account,
            commands::remove_account,
            commands::reauth_account,
            commands::detect_provider,
            commands::list_folders,
            commands::list_messages,
            commands::get_message,
            commands::set_flag,
            commands::move_messages,
            commands::move_to_role,
            commands::delete_messages,
            commands::send_message,
            commands::save_draft,
            commands::discard_draft,
            commands::save_attachment,
            commands::open_attachment,
            commands::raw_source,
            commands::pick_files,
            commands::folder_op,
            commands::cached_folders,
            commands::cached_messages,
            commands::prefetch,
            commands::attachment_preview,
            commands::inline_image,
            commands::contact_photos,
            commands::show_notification,
            commands::restart_watchers,
            commands::log_event,
            commands::show_log_file,
            commands::get_thread,
            commands::save_attachment_png,
            commands::attachment_data,
            commands::stage_attachment,
            commands::stage_message_attachments,
            commands::set_run_in_background,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pear Mail");
}

/// "Windows 11 build 26100" style description for the diagnostic log.
fn windows_build() -> String {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        if let Ok(k) = winreg::RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion") {
            let build: String = k.get_value("CurrentBuild").unwrap_or_default();
            let name = if build.parse::<u32>().unwrap_or(0) >= 22000 { "Windows 11" } else { "Windows 10" };
            return format!("{name} build {build}");
        }
    }
    "unknown Windows".into()
}

#[cfg(debug_assertions)]
async fn diagnose() -> String {
    use std::fmt::Write;
    let mut r = String::new();
    let Some((cfg, creds)) = first_account() else { return "no saved account".into() };
    let _ = writeln!(r, "account loaded");
    let cache = std::sync::Arc::new(cache::Cache::in_memory().expect("cache"));
    let imap = imap::Imap::new(cfg, creds, cache);
    let mut paths = vec![];
    match imap.list_folders().await {
        Ok(f) => {
            let _ = writeln!(r, "folders: {}", f.len());
            paths = f.iter().filter(|x| x.selectable).map(|x| x.path.clone()).collect();
        }
        Err(e) => {
            let _ = writeln!(r, "folders ERROR: {e:#}");
        }
    }
    for folder in paths.iter() {
        let (folder, limit) = (folder.as_str(), 300);
        match imap.list_messages(folder, "all", "", &[], 0, limit).await {
            Ok(p) => {
                let _ = writeln!(r, "list {folder} limit {limit}: ok, {} messages, total {}", p.messages.len(), p.total);
            }
            Err(e) => {
                let _ = writeln!(r, "list {folder} limit {limit} ERROR: {}", e.to_string().chars().take(120).collect::<String>());
            }
        }
    }
    r
}

/// `--inspect <sender>`: structure/timing report for the newest INBOX message from a sender.
#[cfg(debug_assertions)]
async fn inspect(who: &str) -> String {
    use mail_parser::MimeHeaders;
    use std::fmt::Write;
    let mut r = String::new();
    let Some((cfg, creds)) = first_account() else { return "no saved account".into() };
    let cache = std::sync::Arc::new(cache::Cache::in_memory().expect("cache"));
    let imap = imap::Imap::new(cfg, creds, cache);
    let page = match imap.list_messages("INBOX", "all", "", &[], 0, 200).await {
        Ok(p) => p,
        Err(e) => return format!("list error: {e:#}"),
    };
    let w = who.to_lowercase();
    let Some(m) = page.messages.iter().find(|m| m.from.name.to_lowercase().contains(&w) || m.from.email.to_lowercase().contains(&w)) else {
        return "not found".into();
    };
    let _ = writeln!(r, "uid {} size {} attachments(list) {:?}", m.uid, m.size, m.attachment_names);
    let t = std::time::Instant::now();
    let raw = match imap.raw_message("INBOX", m.uid).await { Ok(x) => x, Err(e) => return format!("fetch error {e:#}") };
    let _ = writeln!(r, "fetch {} bytes in {:?}", raw.len(), t.elapsed());
    let t = std::time::Instant::now();
    let msg = mime::parse(&raw).unwrap();
    let _ = writeln!(r, "parse {:?}", t.elapsed());
    for (i, p) in msg.parts.iter().enumerate() {
        let ct = p.content_type().map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("?"))).unwrap_or_default();
        let disp = p.content_disposition().map(|d| d.ctype().to_string()).unwrap_or_default();
        let _ = writeln!(r, "part {i}: {ct} disp={disp} cid={:?} name={:?} len={}", p.content_id(), p.attachment_name(), p.contents().len());
    }
    let _ = writeln!(r, "html_body={:?} text_body={:?} attachments={:?}", msg.html_body, msg.text_body, msg.attachments);
    if let Some(h) = msg.body_html(0) {
        let t = std::time::Instant::now();
        let (clean, remote) = mime::sanitize_html(&h, &msg);
        let _ = writeln!(r, "html {} -> {} bytes, sanitize {:?}, remote={remote}", h.len(), clean.len(), t.elapsed());
        let lower = clean.to_lowercase();
        let imgs = lower.matches("<img").count();
        let mut hosts = std::collections::BTreeSet::new();
        for part in lower.split("src=\"").skip(1) {
            let url = part.split('"').next().unwrap_or("");
            if url.starts_with("http") {
                hosts.insert(url.split('/').nth(2).unwrap_or("").to_string());
            } else {
                hosts.insert(url.chars().take(20).collect::<String>());
            }
        }
        let _ = writeln!(r, "img tags {imgs}; src hosts/prefixes {:?}", hosts);
        let _ = writeln!(r, "cid refs {}", lower.matches("cid:").count());
    }
    let t = std::time::Instant::now();
    let d = imap.get_message("INBOX", m.uid, false, false).await;
    let _ = writeln!(r, "get_message {:?} ok={}", t.elapsed(), d.is_ok());
    if let Ok(d) = d {
        let _ = writeln!(r, "detail attachments: {:?}", d.attachments.iter().map(|a| (&a.name, &a.mime, a.size)).collect::<Vec<_>>());
        for a in d.attachments.iter().take(3) {
            let (_, _, bytes) = imap.attachment("INBOX", m.uid, a.index).await.unwrap();
            let t = std::time::Instant::now();
            let p = mime::image_preview(&bytes, 1600).map(|(m, b)| (m, b.len()));
            let t1 = t.elapsed();
            let t = std::time::Instant::now();
            let th = mime::image_preview(&bytes, 240).map(|(m, b)| (m, b.len()));
            let _ = writeln!(r, "preview 1600 {:?} in {t1:?}; thumb {:?} in {:?}", p, th, t.elapsed());
        }
    }
    r
}

/// First saved account with its credentials (diagnostic modes).
#[cfg(debug_assertions)]
fn first_account() -> Option<(accounts::AccountConfig, accounts::Credentials)> {
    let store = accounts::load();
    let cfg = store.accounts.first()?.clone();
    let secret = accounts::get_secret(&cfg.id)?;
    let creds = accounts::Credentials::for_account(&cfg, secret);
    Some((cfg, creds))
}
