//! Hash lists, content names and playlists (NFX-05 §§2–4).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::hex32::{decode, is_lower_hex};
use crate::manifest::Manifest;
use crate::namespace::VideoAddr;
use crate::{Error, Result, sha256};

/// Rendition id reserved for the metadata collection (NFX-03 §4, NFX-06 §2).
pub const RESERVED_RENDITION_ID: &str = "meta";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    PlaylistMaster,
    Playlist,
    Init,
    Segment,
    Thumb,
    Subtitle,
}

/// One content-addressed file. Field order is the wire order of the test vectors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub role: Role,
    pub sha256: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dur_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rendition {
    pub id: String,
    pub playlist: String,
    pub bandwidth: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codecs: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

/// The NFX-05 hash list: the only object a manifest anchors (by `root`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HashList {
    pub v: u64,
    pub video: String,
    pub files: Vec<FileEntry>,
    pub renditions: Vec<Rendition>,
}

impl HashList {
    /// Verify hash-list `bytes` against a manifest's `root`, address and `segs`.
    /// `root` commits to the exact bytes, so the hash is checked before anything is parsed.
    pub fn verify(bytes: &[u8], root: &[u8; 32], video: &VideoAddr, segs: u64) -> Result<Self> {
        if sha256(bytes) != *root {
            return Err(bad("sha256(bytes) does not equal the manifest root"));
        }
        let list: Self = serde_json::from_slice(bytes)
            .map_err(|e| Error::HashList(format!("not a hash list: {e}")))?;
        list.check(video, segs)?;
        Ok(list)
    }

    /// [`HashList::verify`] against the manifest that anchors it.
    pub fn verify_for(bytes: &[u8], manifest: &Manifest) -> Result<Self> {
        Self::verify(bytes, &manifest.root, &manifest.addr, manifest.segs)
    }

    fn check(&self, video: &VideoAddr, segs: u64) -> Result<()> {
        if self.v != 1 {
            return Err(bad("`v` must be 1"));
        }
        if self.video != video.to_string() {
            return Err(bad("`video` does not equal the manifest's address"));
        }
        if self.files.is_empty() {
            return Err(bad("`files` is empty"));
        }
        if u64::try_from(self.files.len()).ok() != Some(segs) {
            return Err(bad("manifest `segs` does not equal len(files)"));
        }
        for f in &self.files {
            if f.name.is_empty() {
                return Err(bad("file with an empty name"));
            }
            if !is_lower_hex(&f.sha256, 64) {
                return Err(bad("file sha256 is not 64 lowercase hex"));
            }
            if f.dur_ms == Some(0) {
                return Err(bad("`dur_ms` must be >= 1"));
            }
        }
        if self.renditions.is_empty() {
            return Err(bad("`renditions` is empty"));
        }
        let mut ids = BTreeSet::new();
        let mut playlist_names = BTreeSet::new();
        let mut playlist_hashes = BTreeSet::new();
        for r in &self.renditions {
            if r.id.is_empty() || r.id == RESERVED_RENDITION_ID || !ids.insert(r.id.as_str()) {
                return Err(bad(
                    "rendition ids must be unique, non-empty and not `meta`",
                ));
            }
            let Some(playlist) = self
                .files
                .iter()
                .find(|f| f.role == Role::Playlist && f.name == r.playlist)
            else {
                return Err(bad("rendition `playlist` does not name a playlist file"));
            };
            // NFX-05 §2: a playlist's content name identifies its rendition (NFX-10 §2).
            if !playlist_names.insert(r.playlist.as_str())
                || !playlist_hashes.insert(playlist.sha256.as_str())
            {
                return Err(bad("renditions must name distinct playlists"));
            }
            if r.bandwidth == 0 {
                return Err(bad("`bandwidth` must be >= 1"));
            }
            if let Some(res) = &r.resolution {
                let ok = res.split_once('x').is_some_and(|(w, h)| {
                    !w.is_empty()
                        && !h.is_empty()
                        && w.bytes().chain(h.bytes()).all(|b| b.is_ascii_digit())
                });
                if !ok {
                    return Err(bad("`resolution` must be <w>x<h>"));
                }
            }
        }
        Ok(())
    }

    /// The publisher's rendering: two-space indented JSON plus a trailing newline, the
    /// same bytes Python's `json.dumps(indent=2, ensure_ascii=False) + "\n"` produces for
    /// this structure. Only the root hash makes the bytes authoritative, not this layout.
    #[must_use]
    pub fn render(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let formatter = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut out, formatter);
        self.serialize(&mut ser)
            .expect("hash list always serializes");
        out.push(b'\n');
        out
    }

    /// Resolve a content name (`<sha256-hex>.<ext>`, NFX-05 §3) to its file entry.
    #[must_use]
    pub fn resolve(&self, content_name: &str) -> Option<&FileEntry> {
        let (hash, ext) = content_name.split_once('.')?;
        if ext.is_empty() || !is_lower_hex(hash, 64) {
            return None;
        }
        self.files.iter().find(|f| f.sha256 == hash)
    }

    /// The rendition whose playlist has this content name (`<sha256>.m3u8`): how a web
    /// player maps a stream to its swarm (NFX-10 §2). `None` for anything else.
    #[must_use]
    pub fn rendition_for_playlist(&self, content_name: &str) -> Option<&Rendition> {
        let (hash, ext) = content_name.split_once('.')?;
        if ext.is_empty() || !is_lower_hex(hash, 64) {
            return None;
        }
        let file = self
            .files
            .iter()
            .find(|f| f.role == Role::Playlist && f.sha256 == hash)?;
        self.renditions.iter().find(|r| r.playlist == file.name)
    }

    /// NFX-05 §3: every URI in a playlist is a content name listed in `files`.
    pub fn check_playlist(&self, bytes: &[u8]) -> Result<()> {
        let text = core::str::from_utf8(bytes).map_err(|_| Error::Playlist("not UTF-8".into()))?;
        for line in text.lines().map(|l| l.trim_end_matches('\r')) {
            let uri = if line.starts_with('#') {
                match line.split_once("URI=\"") {
                    Some((_, rest)) => rest.split('"').next().unwrap_or(""),
                    None => continue,
                }
            } else if line.trim().is_empty() {
                continue;
            } else {
                line
            };
            if self.resolve(uri).is_none() {
                return Err(Error::Playlist(format!(
                    "URI {uri:?} is not a listed content name"
                )));
            }
        }
        Ok(())
    }
}

/// The Blossom rule (NFX-05 §4): `sha256(bytes) == expected`, checked before use or storage.
pub fn verify_file(expected_sha256_hex: &str, bytes: &[u8]) -> Result<()> {
    let expected: [u8; 32] = decode(expected_sha256_hex)
        .ok_or_else(|| bad("expected sha256 is not 64 lowercase hex"))?;
    if sha256(bytes) == expected {
        Ok(())
    } else {
        Err(bad("file bytes do not match their sha256"))
    }
}

fn bad(reason: &str) -> Error {
    Error::HashList(reason.to_owned())
}
