fn main() {
    // Pear Mail's Google sign-in client ID and secret aren't in the public source: they're
    // read from `oauth.local` (gitignored, KEY=VALUE lines) or the environment at build
    // time and compiled in. Without them, "Sign in with Google" says it isn't set up.
    println!("cargo:rerun-if-changed=oauth.local");
    for key in ["PEARMAIL_GOOGLE_CLIENT_ID", "PEARMAIL_GOOGLE_CLIENT_SECRET"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    if let Ok(text) = std::fs::read_to_string("oauth.local") {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let (k, v) = (k.trim(), v.trim());
                if k.starts_with("PEARMAIL_") && std::env::var(k).is_err() {
                    println!("cargo:rustc-env={k}={v}");
                }
            }
        }
    }
    tauri_build::build()
}
