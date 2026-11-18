//! Release signing for the auto-updater (not part of the app).
//!
//!   cargo run --release --example release_key -- gen
//!       Makes the private key at %USERPROFILE%\.pearmail-release-key (once) and prints the
//!       public key to paste into src/updater.rs (RELEASE_PUBLIC_KEY).
//!   cargo run --release --example release_key -- sign target\release\pearmail.exe
//!       Writes pearmail.exe.sig next to it; upload both to the GitHub release.
//!
//! Keep the private key safe and out of the repository. Without it, published copies of
//! Pear Mail can't be updated automatically (a one-time manual download fixes that).

use ed25519_dalek::{Signer, SigningKey};
use std::path::PathBuf;

fn key_path() -> PathBuf {
    dirs::home_dir().expect("no home folder").join(".pearmail-release-key")
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn load() -> SigningKey {
    let text = std::fs::read_to_string(key_path()).expect("no release key: run `gen` first");
    let bytes: Vec<u8> = (0..64).step_by(2).map(|i| u8::from_str_radix(&text.trim()[i..i + 2], 16).expect("bad key file")).collect();
    SigningKey::from_bytes(&bytes.try_into().expect("bad key length"))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("gen") => {
            let path = key_path();
            if path.exists() {
                eprintln!("A key already exists at {} (not replaced).", path.display());
            } else {
                let mut secret = [0u8; 32];
                getrandom::getrandom(&mut secret).expect("random");
                std::fs::write(&path, hex(&secret)).expect("write key");
                eprintln!("Private key written to {}", path.display());
            }
            println!("{}", hex(load().verifying_key().as_bytes()));
        }
        Some("sign") => {
            let exe = PathBuf::from(args.get(2).expect("usage: sign <exe>"));
            let data = std::fs::read(&exe).expect("read exe");
            let sig = load().sign(&data);
            let out = PathBuf::from(format!("{}.sig", exe.display()));
            std::fs::write(&out, hex(&sig.to_bytes())).expect("write sig");
            println!("{}", out.display());
        }
        _ => eprintln!("usage: release_key gen | sign <exe>"),
    }
}
