//! The NFX content store: a directory of files named by their lowercase-hex sha256.
//!
//! Content-addressed files never change, so the store is append-only and a file's name
//! is its integrity check. The Blossom rule is enforced by the trait itself: an
//! implementation supplies only raw reads and writes, and the provided [`ContentStore::get`]
//! and [`ContentStore::put_verified`] hash every byte on the way in and on the way out.
//! A new backend cannot forget to verify.

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use nfx_proto::hashlist::verify_file;
use nfx_proto::sha256;

use crate::{NodeError, Result};

/// Whether `s` can name a file: 64 lowercase hex.
#[must_use]
pub fn is_sha256_name(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A content-addressed store. Swappable (spike S1): iroh-blobs is transport, not storage.
///
/// Implement the `raw_*` methods; call the provided ones. The provided methods are the
/// verification boundary and must not be overridden.
pub trait ContentStore: Send + Sync {
    /// Whether a file named `sha256` is present (not whether it is intact).
    fn has(&self, sha256: &str) -> bool;
    /// The stored bytes, unchecked. `sha256` has already been validated as a name.
    fn raw_read(&self, sha256: &str) -> Result<Vec<u8>>;
    /// Store bytes under `sha256` atomically. The bytes have already been verified.
    fn raw_write(&self, sha256: &str, bytes: &[u8]) -> Result<()>;
    /// Remove a file (used to drop one that no longer verifies). Absent is not an error.
    fn remove(&self, sha256: &str) -> Result<()>;
    /// A filesystem path for the file, when the store has one (for import by reference).
    fn path_of(&self, sha256: &str) -> Option<PathBuf>;

    /// Read a file and check it against its name before returning it.
    fn get(&self, sha256: &str) -> Result<Vec<u8>> {
        if !is_sha256_name(sha256) {
            return Err(NodeError::Collection(format!("not a sha256: {sha256:?}")));
        }
        let bytes = self.raw_read(sha256)?;
        verify_file(sha256, &bytes)?;
        Ok(bytes)
    }

    /// Store bytes only if they hash to `expected`.
    fn put_verified(&self, expected: &str, bytes: &[u8]) -> Result<()> {
        if !is_sha256_name(expected) {
            return Err(NodeError::Collection(format!("not a sha256: {expected:?}")));
        }
        let got = hex::encode(sha256(bytes));
        if got != expected {
            return Err(NodeError::Poisoned {
                what: "store ingest".into(),
                expected: expected.into(),
                got,
            });
        }
        if self.has(expected) && self.get(expected).is_ok() {
            return Ok(());
        }
        self.raw_write(expected, bytes)
    }

    /// Store bytes under their own sha256; returns it.
    fn put(&self, bytes: &[u8]) -> Result<String> {
        let sha = hex::encode(sha256(bytes));
        self.put_verified(&sha, bytes)?;
        Ok(sha)
    }
}

/// The store layout `nfx-package` writes: `<dir>/<sha256>`.
#[derive(Debug, Clone)]
pub struct FsStore {
    dir: PathBuf,
}

impl FsStore {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        fs::create_dir_all(dir.as_ref())?;
        Ok(Self {
            dir: dir.as_ref().canonicalize()?,
        })
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn file(&self, sha256: &str) -> Option<PathBuf> {
        is_sha256_name(sha256).then(|| self.dir.join(sha256))
    }
}

/// Distinguishes temp files written concurrently by one process.
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

impl ContentStore for FsStore {
    fn has(&self, sha256: &str) -> bool {
        self.file(sha256).is_some_and(|p| p.is_file())
    }

    fn raw_read(&self, sha256: &str) -> Result<Vec<u8>> {
        let path = self
            .file(sha256)
            .ok_or_else(|| NodeError::Collection(format!("not a sha256: {sha256:?}")))?;
        Ok(fs::read(path)?)
    }

    /// A fresh temp file per write (created exclusively, never shared between writers),
    /// synced, then renamed over the final name: readers see the old file or the whole
    /// new one, and concurrent writers of one sha256 cannot truncate each other.
    fn raw_write(&self, sha256: &str, bytes: &[u8]) -> Result<()> {
        let path = self
            .file(sha256)
            .ok_or_else(|| NodeError::Collection(format!("not a sha256: {sha256:?}")))?;
        let tmp = self.dir.join(format!(
            ".tmp-{sha256}-{}-{}",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let written = (|| {
            let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&tmp, &path)?;
            File::open(&self.dir)?.sync_all()
        })();
        if written.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        Ok(written?)
    }

    fn remove(&self, sha256: &str) -> Result<()> {
        let Some(path) = self.file(sha256) else {
            return Ok(());
        };
        match fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }

    fn path_of(&self, sha256: &str) -> Option<PathBuf> {
        self.file(sha256).filter(|p| p.is_file())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::sync::Arc;

    use super::*;

    #[test]
    fn concurrent_writers_of_one_file_never_leave_a_bad_copy() {
        let dir = std::env::temp_dir().join(format!("nfx-store-race-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = Arc::new(FsStore::open(&dir).unwrap());
        let bytes: Arc<Vec<u8>> = Arc::new((0..1_000_000u32).map(|i| i as u8).collect());
        let sha = hex::encode(sha256(&bytes));
        let writers: Vec<_> = (0..8)
            .map(|_| {
                let (store, bytes, sha) = (store.clone(), bytes.clone(), sha.clone());
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        store.raw_write(&sha, &bytes).unwrap();
                        store.get(&sha).unwrap();
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        assert_eq!(store.get(&sha).unwrap(), *bytes);
        let leftovers = fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1, "no temp files left behind");
        store.remove(&sha).unwrap();
        store.remove(&sha).unwrap();
        assert!(!store.has(&sha));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_and_contents_are_checked_by_the_trait() {
        let dir = std::env::temp_dir().join(format!("nfx-store-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = FsStore::open(&dir).unwrap();
        assert!(store.get("../etc/passwd").is_err());
        assert!(store.put_verified(&"0".repeat(64), b"x").is_err());
        let sha = store.put(b"hello").unwrap();
        fs::write(dir.join(&sha), b"jello").unwrap();
        assert!(store.get(&sha).is_err(), "a rotted file fails verification");
        let _ = fs::remove_dir_all(&dir);
    }
}
