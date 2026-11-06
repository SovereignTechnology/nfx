//! The node's Nostr identity on disk: one line of hex, mode 0600.
//!
//! The secret never reaches stdout, stderr or an error message; callers print the public
//! key only. A key file readable by group or others is refused, as ssh refuses one.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::Path;

use nostr_sdk::prelude::{Keys, PublicKey, ToBech32 as _};

use crate::{Error, Result};

/// Generate a key and write it to `path`, which must not exist yet.
pub fn create(path: &Path) -> Result<Keys> {
    let keys = Keys::generate();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(keys.secret_key().to_secret_hex().as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(keys)
}

/// Load the key at `path`.
pub fn load(path: &Path) -> Result<Keys> {
    let mode = std::fs::metadata(path)?.permissions().mode();
    if mode & 0o077 != 0 {
        return Err(Error::Config(format!(
            "{}: key file is readable by group or others (mode {:o}); chmod 600 it",
            path.display(),
            mode & 0o777
        )));
    }
    let text = std::fs::read_to_string(path)?;
    Keys::parse(text.trim())
        .map_err(|_| Error::Config(format!("{}: not a secret key", path.display())))
}

/// A public key a user gave (an npub, or 64 hex digits) as 64 lowercase hex. The refusal
/// never repeats the input: it may be a secret key pasted by mistake, and an nsec is named
/// as one.
pub fn public_hex(v: &str) -> core::result::Result<String, &'static str> {
    let v = v.trim();
    let bare = v.strip_prefix("nostr:").unwrap_or(v);
    if bare.starts_with("nsec1") || bare.starts_with("ncryptsec1") {
        return Err("that is a secret key (nsec): give the npub, and keep the nsec to yourself");
    }
    PublicKey::parse(v)
        .map(|k| k.to_hex())
        .map_err(|_| "not an npub or a 64-hex public key")
}

/// The npub of a public key held as 64 hex digits.
pub fn npub(hex: &str) -> Option<String> {
    PublicKey::from_hex(hex).ok()?.to_bech32().ok()
}
