//! The NFX content store: a directory of files named by their lowercase-hex sha256.
//!
//! Content-addressed files never change, so the store is append-only and a file's name
//! is its integrity check. Everything that enters goes through [`ContentStore::put_verified`]
//! (or [`ContentStore::put`], which names the bytes itself): the Blossom rule on ingest.

use std::fs;
use std::path::{Path, PathBuf};

use nfx_proto::hashlist::verify_file;
use nfx_proto::sha256;

use crate::{NodeError, Result};

/// A content-addressed store. Swappable (spike S1): iroh-blobs is transport, not storage.
pub trait ContentStore: Send + Sync {
    fn has(&self, sha256: &str) -> bool;
    /// Read a file and re-check it against its name before returning it.
    fn get(&self, sha256: &str) -> Result<Vec<u8>>;
    /// Store bytes under their own sha256; returns it.
    fn put(&self, bytes: &[u8]) -> Result<String>;
    /// Store bytes only if they hash to `expected`.
    fn put_verified(&self, expected: &str, bytes: &[u8]) -> Result<()>;
    /// A filesystem path for the file, when the store has one (for import by reference).
    fn path_of(&self, sha256: &str) -> Option<PathBuf>;
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
        let ok = sha256.len() == 64
            && sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        ok.then(|| self.dir.join(sha256))
    }
}

impl ContentStore for FsStore {
    fn has(&self, sha256: &str) -> bool {
        self.file(sha256).is_some_and(|p| p.is_file())
    }

    fn get(&self, sha256: &str) -> Result<Vec<u8>> {
        let path = self
            .file(sha256)
            .ok_or_else(|| NodeError::Collection(format!("not a sha256: {sha256:?}")))?;
        let bytes = fs::read(path)?;
        verify_file(sha256, &bytes)?;
        Ok(bytes)
    }

    fn put(&self, bytes: &[u8]) -> Result<String> {
        let sha = hex::encode(sha256(bytes));
        self.put_verified(&sha, bytes)?;
        Ok(sha)
    }

    fn put_verified(&self, expected: &str, bytes: &[u8]) -> Result<()> {
        let path = self
            .file(expected)
            .ok_or_else(|| NodeError::Collection(format!("not a sha256: {expected:?}")))?;
        let got = hex::encode(sha256(bytes));
        if got != expected {
            return Err(NodeError::Poisoned {
                what: "store ingest".into(),
                expected: expected.into(),
                got,
            });
        }
        if path.is_file() && self.get(expected).is_ok() {
            return Ok(());
        }
        let tmp = self
            .dir
            .join(format!(".tmp-{expected}-{}", std::process::id()));
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    fn path_of(&self, sha256: &str) -> Option<PathBuf> {
        self.file(sha256).filter(|p| p.is_file())
    }
}
