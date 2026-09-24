//! `nfx-proto` for browsers. JS gets the same verification native peers run: manifests
//! (NFX-02), beacons (NFX-03), hash lists, playlists and files (NFX-05), with sha256
//! from RustCrypto, so verification does not depend on WebCrypto and its secure-context
//! rule (spike S3).
//!
//! The logic lives in plain functions returning `Result<_, String>` (tested natively);
//! the `#[wasm_bindgen]` wrappers only convert errors to `JsError`. Integers cross as
//! JS numbers and must be safe integers (≤ 2^53 − 1). Structured results cross as JSON
//! strings.

use nfx_proto::beacon::Beacon;
use nfx_proto::event::Event;
use nfx_proto::hashlist::{HashList, Role};
use nfx_proto::manifest::{License, Manifest};
use nfx_proto::namespace::VideoAddr;
use serde_json::json;
use wasm_bindgen::prelude::*;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A JS number that must be a non-negative safe integer.
pub fn safe_u64(n: f64, what: &str) -> Result<u64, String> {
    if (0.0..=MAX_SAFE).contains(&n) && n.fract() == 0.0 {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(n as u64)
    } else {
        Err(format!("{what} must be a non-negative safe integer"))
    }
}

fn parse_event(event_json: &str) -> Result<Event, String> {
    serde_json::from_str(event_json).map_err(|e| format!("not an event: {e}"))
}

/// Lowercase hex sha256 of `bytes`.
#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(nfx_proto::sha256(bytes))
}

/// NFX-02 §4 on a kind-38504 event (JSON); returns the manifest as JSON.
pub fn manifest_json(event_json: &str) -> Result<String, String> {
    let m = Manifest::from_event(&parse_event(event_json)?).map_err(|e| e.to_string())?;
    let license = match &m.license {
        License::Open => json!({ "mode": "open" }),
        License::Licensed(t) => json!({
            "mode": "licensed",
            "key_price": t.key_price,
            "split_bps": t.split_bps,
            "mint": t.mint,
            "cashu_key": hex::encode(t.cashu_key),
            "free_seeders": t.free_seeders,
        }),
    };
    Ok(json!({
        "author": m.author,
        "created_at": m.created_at,
        "a": m.a_tag(),
        "video": m.addr.to_string(),
        "namespace": m.addr.namespace().to_string(),
        "title": m.title,
        "published_at": m.published_at,
        "root": m.root_hex(),
        "segs": m.segs,
        "duration": m.duration,
        "thumb": m.thumb.as_ref().map(|t| json!({ "sha256": t.sha256, "mime": t.mime })),
        "price_hint": m.price_hint,
        "license": license,
        "hashtags": m.hashtags,
        "alt": m.alt,
        "description": m.description,
    })
    .to_string())
}

/// NFX-03 on a kind-20464 event (JSON) at `now`; returns the beacon as JSON.
pub fn beacon_json(event_json: &str, now: u64) -> Result<String, String> {
    let b = Beacon::from_event(&parse_event(event_json)?, now).map_err(|e| e.to_string())?;
    let content: serde_json::Value =
        serde_json::from_str(&b.content.to_content()).map_err(|e| e.to_string())?;
    Ok(json!({
        "seeder": b.seeder,
        "creator": b.creator,
        "created_at": b.created_at,
        "expiration": b.expiration,
        "a": format!("{}:{}:{}", nfx_proto::KIND_MANIFEST, b.creator, b.content.video),
        "content": content,
    })
    .to_string())
}

/// A hash list that passed NFX-05 §4.
#[wasm_bindgen]
pub struct VerifiedHashList {
    list: HashList,
    root: String,
}

impl VerifiedHashList {
    /// Verify against a manifest's `root`, address and `segs`.
    pub fn verify(bytes: &[u8], root: &str, video: &str, segs: u64) -> Result<Self, String> {
        let mut r = [0u8; 32];
        hex::decode_to_slice(root, &mut r).map_err(|_| "root is not 64 hex".to_owned())?;
        let video = VideoAddr::parse(video).map_err(|e| e.to_string())?;
        let list = HashList::verify(bytes, &r, &video, segs).map_err(|e| e.to_string())?;
        Ok(Self {
            list,
            root: root.to_owned(),
        })
    }

    /// Verify against `root` alone, when no manifest is at hand: the bytes must hash to
    /// `root` and the list must be well formed for its own `video` and file count.
    pub fn verify_root(bytes: &[u8], root: &str) -> Result<Self, String> {
        let mut r = [0u8; 32];
        hex::decode_to_slice(root, &mut r).map_err(|_| "root is not 64 hex".to_owned())?;
        if nfx_proto::sha256(bytes) != r {
            return Err("sha256(bytes) does not equal root".into());
        }
        let peek: HashList =
            serde_json::from_slice(bytes).map_err(|e| format!("not a hash list: {e}"))?;
        let segs = u64::try_from(peek.files.len()).map_err(|e| e.to_string())?;
        Self::verify(bytes, root, &peek.video, segs)
    }

    /// The sha256 a request path's bytes must have: a listed content name
    /// (`…/<sha256>[.<ext>]`), or the master playlist for `/<root>/master.m3u8`.
    pub fn expected_for_path(&self, path: &str) -> Result<String, String> {
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        let last = parts.last().copied().unwrap_or("");
        if parts.len() == 2 && parts[0] == self.root && last == "master.m3u8" {
            return self
                .list
                .files
                .iter()
                .find(|f| f.role == Role::PlaylistMaster)
                .map(|f| f.sha256.clone())
                .ok_or_else(|| "no master playlist".into());
        }
        let sha = last.split_once('.').map_or(last, |(s, _)| s);
        self.list
            .files
            .iter()
            .find(|f| f.sha256 == sha)
            .map(|f| f.sha256.clone())
            .ok_or_else(|| format!("{last:?} is not a content name in this hash list"))
    }

    /// Check `bytes` fetched from `path`: the right sha256 and, for playlists, the
    /// content-name rule (NFX-05 §3). Returns the sha256.
    pub fn check(&self, path: &str, bytes: &[u8]) -> Result<String, String> {
        let want = self.expected_for_path(path)?;
        let got = sha256_hex(bytes);
        if got != want {
            return Err(format!("sha256 mismatch for {want}: got {got}"));
        }
        let role = self
            .list
            .files
            .iter()
            .find(|f| f.sha256 == want)
            .map(|f| f.role);
        if matches!(role, Some(Role::PlaylistMaster | Role::Playlist)) {
            self.list.check_playlist(bytes).map_err(|e| e.to_string())?;
        }
        Ok(want)
    }
}

#[wasm_bindgen]
impl VerifiedHashList {
    /// `new VerifiedHashList(bytes, root, video, segs)`: verify against a manifest.
    #[wasm_bindgen(constructor)]
    pub fn js_new(bytes: &[u8], root: &str, video: &str, segs: f64) -> Result<Self, JsError> {
        let segs = safe_u64(segs, "segs").map_err(|e| JsError::new(&e))?;
        Self::verify(bytes, root, video, segs).map_err(|e| JsError::new(&e))
    }

    /// `VerifiedHashList.fromRoot(bytes, root)`: verify against `root` alone.
    #[wasm_bindgen(js_name = fromRoot)]
    pub fn js_from_root(bytes: &[u8], root: &str) -> Result<Self, JsError> {
        Self::verify_root(bytes, root).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(getter)]
    pub fn root(&self) -> String {
        self.root.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn video(&self) -> String {
        self.list.video.clone()
    }

    /// Number of files.
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> usize {
        self.list.files.len()
    }

    /// `check(path, bytes)`: the verified sha256, or a thrown error.
    #[wasm_bindgen(js_name = check)]
    pub fn js_check(&self, path: &str, bytes: &[u8]) -> Result<String, JsError> {
        self.check(path, bytes).map_err(|e| JsError::new(&e))
    }

    /// `expected(path)`: the sha256 that path must have, or a thrown error.
    #[wasm_bindgen(js_name = expected)]
    pub fn js_expected(&self, path: &str) -> Result<String, JsError> {
        self.expected_for_path(path).map_err(|e| JsError::new(&e))
    }

    /// The hash list as JSON (its canonical rendering).
    #[wasm_bindgen(js_name = toJSON)]
    pub fn to_json(&self) -> String {
        String::from_utf8_lossy(&self.list.render()).into_owned()
    }
}

/// `sha256Hex(bytes)`.
#[wasm_bindgen(js_name = sha256Hex)]
#[must_use]
pub fn js_sha256_hex(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

/// `verifyManifest(eventJson)`: the manifest as JSON, or a thrown error.
#[wasm_bindgen(js_name = verifyManifest)]
pub fn js_verify_manifest(event_json: &str) -> Result<String, JsError> {
    manifest_json(event_json).map_err(|e| JsError::new(&e))
}

/// `verifyBeacon(eventJson, now)`: the beacon as JSON, or a thrown error.
#[wasm_bindgen(js_name = verifyBeacon)]
pub fn js_verify_beacon(event_json: &str, now: f64) -> Result<String, JsError> {
    let now = safe_u64(now, "now").map_err(|e| JsError::new(&e))?;
    beacon_json(event_json, now).map_err(|e| JsError::new(&e))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use serde_json::Value;

    use super::*;

    fn vector(name: &str) -> Value {
        let text = match name {
            "manifest" => include_str!("../../../spec/test-vectors/manifest.json"),
            "beacon" => include_str!("../../../spec/test-vectors/beacon.json"),
            _ => include_str!("../../../spec/test-vectors/hashlist.json"),
        };
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn manifests_and_beacons_verify_and_summarise() {
        let m = vector("manifest");
        let out: Value =
            serde_json::from_str(&manifest_json(&m["event"].to_string()).unwrap()).unwrap();
        assert_eq!(out["video"], "nfx:mainnet:1:salt-flats-dusk");
        assert_eq!(out["license"]["mode"], "licensed");
        let mut forged = m["event"].clone();
        forged["content"] = "tampered".into();
        assert!(manifest_json(&forged.to_string()).is_err());

        let b = vector("beacon");
        let now = b["now"].as_u64().unwrap();
        let out: Value =
            serde_json::from_str(&beacon_json(&b["event"].to_string(), now).unwrap()).unwrap();
        assert_eq!(out["content"]["chunks"], "all");
        assert!(
            beacon_json(&b["event"].to_string(), now + 10_000).is_err(),
            "expired"
        );
    }

    #[test]
    fn hash_lists_paths_and_files() {
        let h = vector("hashlist");
        let m = vector("manifest");
        let list: HashList = serde_json::from_value(h["hashlist"].clone()).unwrap();
        let bytes = list.render();
        let root = sha256_hex(&bytes);
        let manifest: Value =
            serde_json::from_str(&manifest_json(&m["event"].to_string()).unwrap()).unwrap();
        assert_eq!(manifest["root"], root.as_str());
        let segs = manifest["segs"].as_u64().unwrap();
        let v = VerifiedHashList::verify(&bytes, &root, &list.video, segs).unwrap();
        assert!(VerifiedHashList::verify(&bytes, &root, &list.video, segs + 1).is_err());
        let r = VerifiedHashList::verify_root(&bytes, &root).unwrap();
        assert_eq!(r.list, v.list);
        assert!(VerifiedHashList::verify_root(&bytes, &"0".repeat(64)).is_err());

        let master = list
            .files
            .iter()
            .find(|f| f.role == Role::PlaylistMaster)
            .unwrap();
        let text = h["playlists"]["master.m3u8"].as_str().unwrap().as_bytes();
        assert_eq!(
            v.check(&format!("/{root}/master.m3u8"), text).unwrap(),
            master.sha256
        );
        assert_eq!(
            v.check(&format!("/x/{}.m3u8", master.sha256), text)
                .unwrap(),
            master.sha256
        );
        assert!(
            v.check(&format!("/{}", "a".repeat(64)), b"x").is_err(),
            "unlisted"
        );
        assert!(
            v.check(&format!("/{root}/master.m3u8"), b"#EXTM3U\n")
                .is_err(),
            "wrong bytes"
        );
        assert!(v.expected_for_path("/nope.m4s").is_err());
    }

    #[test]
    fn js_numbers_must_be_safe_integers() {
        assert_eq!(safe_u64(7.0, "n").unwrap(), 7);
        for bad in [-1.0, 1.5, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
            assert!(safe_u64(bad, "n").is_err(), "{bad}");
        }
    }
}
