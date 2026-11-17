//! Recovery from WebView2 page crashes. When the page's renderer process dies or hangs,
//! WebView2 shows its own "Something went wrong" page with a Refresh button. Instead, log
//! what happened (kind, reason, exit code) and reload the page automatically; the app comes
//! back on the last folder with mail from the local cache.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::ProcessFailedEventHandler;
use windows::core::Interface;

/// At most this many automatic reloads per minute, so a crash loop can't spin forever.
const MAX_RELOADS_PER_MINUTE: usize = 3;
static RECENT_RELOADS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());

/// Watch the main window's webview for process failures.
pub fn install(window: &tauri::WebviewWindow) {
    let res = window.with_webview(|w| unsafe {
        let Ok(core) = w.controller().CoreWebView2() else { return };
        let handler = ProcessFailedEventHandler::create(Box::new(|sender, args| {
            if let (Some(core), Some(args)) = (sender, args) {
                on_failed(&core, &args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = core.add_ProcessFailed(&handler, &mut token) {
            crate::applog::log("webview", format!("couldn't watch for page crashes: {e}"));
        }
    });
    if let Err(e) = res {
        crate::applog::log("webview", format!("couldn't reach the webview: {e}"));
    }
}

unsafe fn on_failed(core: &ICoreWebView2, args: &ICoreWebView2ProcessFailedEventArgs) {
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    let _ = args.ProcessFailedKind(&mut kind);
    // Reason and exit code need the newer args interface (WebView2 runtime 1.0.1108+).
    let (mut reason, mut exit) = (None, None);
    if let Ok(a2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
        let mut r = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
        if a2.Reason(&mut r).is_ok() {
            reason = Some(r);
        }
        let mut c = 0i32;
        if a2.ExitCode(&mut c).is_ok() {
            exit = Some(c);
        }
    }
    // Only a failure of the page itself takes the app down; the GPU, utility and frame
    // processes are restarted by WebView2 on its own.
    let page_failed = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
        || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE;
    let reload = page_failed && reload_allowed();
    crate::applog::log(
        "webview",
        format!(
            "{} process failed: reason={}, exit code={}{}",
            kind_name(kind),
            reason.map(reason_name).unwrap_or("unknown"),
            exit.map(|c| format!("{:#x}", c as u32)).unwrap_or_else(|| "unknown".into()),
            match (page_failed, reload) {
                (true, true) => "; reloading the page",
                (true, false) => "; too many crashes in a minute, not reloading",
                _ => "",
            }
        ),
    );
    if reload {
        if let Err(e) = core.Reload() {
            crate::applog::log("webview", format!("reload after crash failed: {e}"));
        }
    }
}

fn reload_allowed() -> bool {
    let mut recent = RECENT_RELOADS.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    recent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
    if recent.len() >= MAX_RELOADS_PER_MINUTE {
        return false;
    }
    recent.push(now);
    true
}

fn kind_name(k: COREWEBVIEW2_PROCESS_FAILED_KIND) -> &'static str {
    match k {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "renderer",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "renderer (unresponsive)",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame renderer",
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility",
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => "sandbox helper",
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "GPU",
        _ => "other",
    }
}

fn reason_name(r: COREWEBVIEW2_PROCESS_FAILED_REASON) -> &'static str {
    match r {
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "unexpected",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "terminated",
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "launch failed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out of memory",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reloads_are_rate_limited() {
        RECENT_RELOADS.lock().unwrap().clear();
        assert!((0..MAX_RELOADS_PER_MINUTE).all(|_| reload_allowed()));
        assert!(!reload_allowed());
    }
}
