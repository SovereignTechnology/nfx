//! The node's Nostr identity on disk: one line of hex, mode 0600.
//!
//! The secret never reaches stdout, stderr or an error message; callers print the public
//! key only. A key file readable by group or others is refused, as ssh refuses one.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::Path;

use nostr_sdk::prelude::Keys;

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
