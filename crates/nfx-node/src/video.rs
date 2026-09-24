//! How a verified hash list maps onto iroh collections (NFX-06 §2).
//!
//! - **meta**: the hash list itself, then every playlist, thumb and subtitle file in
//!   `files` order (NFX-06 §2).
//! - **per rendition**: its init, then its segments in playlist order. The hash list does
//!   not record which files belong to which rendition; the rendition's playlist does, so
//!   membership is read from the playlist, never guessed from file order.

use nfx_proto::hashlist::{HashList, Role};

use crate::{NodeError, Result};

/// The sha256 values of the meta collection, in order: root, then every playlist, thumb
/// and subtitle file in `files` order (everything that is not an init or a segment).
#[must_use]
pub fn meta_members(root_hex: &str, list: &HashList) -> Vec<String> {
    let mut out = vec![root_hex.to_owned()];
    out.extend(
        list.files
            .iter()
            .filter(|f| !matches!(f.role, Role::Init | Role::Segment))
            .map(|f| f.sha256.clone()),
    );
    out
}

/// The sha256 values of one rendition's collection: init, then segments in playlist
/// order, read from that rendition's (already verified) playlist bytes.
pub fn rendition_members(list: &HashList, playlist: &[u8]) -> Result<Vec<String>> {
    let text = std::str::from_utf8(playlist)
        .map_err(|_| NodeError::Collection("playlist is not UTF-8".into()))?;
    let mut init = None;
    let mut segments = Vec::new();
    for line in text.lines().map(|l| l.trim_end_matches('\r')) {
        if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            let uri = rest
                .split_once("URI=\"")
                .and_then(|(_, r)| r.split('"').next())
                .unwrap_or("");
            let f = list
                .resolve(uri)
                .ok_or_else(|| NodeError::Collection(format!("EXT-X-MAP {uri:?} not listed")))?;
            if f.role != Role::Init || init.replace(f.sha256.clone()).is_some() {
                return Err(NodeError::Collection(
                    "playlist must name exactly one init".into(),
                ));
            }
        } else if !line.is_empty() && !line.starts_with('#') {
            let f = list
                .resolve(line)
                .ok_or_else(|| NodeError::Collection(format!("segment {line:?} not listed")))?;
            if f.role != Role::Segment {
                return Err(NodeError::Collection(format!("{line:?} is not a segment")));
            }
            segments.push(f.sha256.clone());
        }
    }
    let init = init.ok_or_else(|| NodeError::Collection("playlist has no EXT-X-MAP".into()))?;
    if segments.is_empty() {
        return Err(NodeError::Collection("playlist has no segments".into()));
    }
    let mut out = vec![init];
    out.extend(segments);
    Ok(out)
}
