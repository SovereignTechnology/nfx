//! How a verified hash list maps onto iroh collections (NFX-06 §2).
//!
//! - **meta**: the hash list itself, then every playlist, thumb and subtitle file in
//!   `files` order (NFX-06 §2).
//! - **per rendition**: its init, then its segments in playlist order. The hash list does
//!   not record which files belong to which rendition; the rendition's playlist does, so
//!   membership is read from the playlist, never guessed from file order.
//! - **held renditions**: a node may hold only some renditions of a video ([`held_files`]).
//!   It still holds the hash list and the whole meta collection (every playlist included),
//!   and of the renditions only the inits and segments of those it holds.

use std::collections::BTreeSet;

use nfx_proto::hashlist::{HashList, Role};

use crate::store::ContentStore;
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

/// Check that each of `ids` names a rendition of `list`, once. The error names the ids the
/// hash list has.
pub fn check_held(list: &HashList, ids: &[String]) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        if ids[..i].contains(id) {
            return Err(NodeError::Collection(format!("rendition {id} named twice")));
        }
        if !list.renditions.iter().any(|r| &r.id == id) {
            let has: Vec<&str> = list.renditions.iter().map(|r| r.id.as_str()).collect();
            return Err(NodeError::Collection(format!(
                "no rendition {id:?} in the hash list (it has {})",
                has.join(", ")
            )));
        }
    }
    Ok(())
}

/// `ids` as the renditions a holder of them holds, in hash-list order, or `None` when they
/// are every rendition of `list` (a holder of everything says nothing about renditions).
/// Checked first ([`check_held`]), and refused when empty: a beacon writes an empty list
/// as no list, which means every rendition (NFX-03 §4), so holding none must never get
/// this far.
pub fn held_renditions(list: &HashList, ids: &[String]) -> Result<Option<Vec<String>>> {
    if ids.is_empty() {
        return Err(NodeError::Collection("no rendition named".into()));
    }
    check_held(list, ids)?;
    if list.renditions.iter().all(|r| ids.contains(&r.id)) {
        return Ok(None);
    }
    Ok(Some(
        list.renditions
            .iter()
            .filter(|r| ids.contains(&r.id))
            .map(|r| r.id.clone())
            .collect(),
    ))
}

/// The sha256 values of the files a holder of `only` renditions (every one when `None`)
/// holds: every file that is no init or segment (the meta collection's), then each held
/// rendition's init and segments, read from its playlist in `store`.
pub fn held_files(
    list: &HashList,
    store: &dyn ContentStore,
    only: Option<&[String]>,
) -> Result<BTreeSet<String>> {
    let mut out: BTreeSet<String> = list
        .files
        .iter()
        .filter(|f| !matches!(f.role, Role::Init | Role::Segment))
        .map(|f| f.sha256.clone())
        .collect();
    for r in &list.renditions {
        if only.is_some_and(|ids| !ids.contains(&r.id)) {
            continue;
        }
        let playlist = list
            .files
            .iter()
            .find(|f| f.name == r.playlist)
            .ok_or_else(|| NodeError::Collection(format!("no playlist for {}", r.id)))?;
        out.extend(rendition_members(list, &store.get(&playlist.sha256)?)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use nfx_proto::hashlist::Rendition;

    use super::*;

    fn list(ids: &[&str]) -> HashList {
        HashList {
            v: 1,
            video: "nfx:testnet:1:held-renditions".into(),
            files: vec![],
            renditions: ids
                .iter()
                .map(|id| Rendition {
                    id: (*id).into(),
                    playlist: format!("r{id}.m3u8"),
                    bandwidth: 1,
                    codecs: None,
                    resolution: None,
                })
                .collect(),
        }
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn held_renditions_are_checked_put_in_hash_list_order_and_all_is_none() {
        let l = list(&["1080p", "720p", "360p"]);
        assert_eq!(
            held_renditions(&l, &ids(&["360p", "1080p"])).unwrap(),
            Some(ids(&["1080p", "360p"]))
        );
        assert_eq!(
            held_renditions(&l, &ids(&["360p", "720p", "1080p"])).unwrap(),
            None
        );
        let err = held_renditions(&l, &ids(&["480p"]))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("\"480p\"") && err.contains("1080p, 720p, 360p"),
            "{err}"
        );
        let err = held_renditions(&l, &ids(&["720p", "720p"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("named twice"), "{err}");
        // None held is refused here: a beacon would read an empty list as every rendition.
        let err = held_renditions(&l, &[]).unwrap_err().to_string();
        assert!(err.contains("no rendition named"), "{err}");
        // check_held alone accepts none: the meta collection only.
        assert!(check_held(&l, &[]).is_ok());
    }
}
