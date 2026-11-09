//! `nfx-proto` for browsers. JS gets the same verification native peers run: manifests
//! (NFX-02), beacons (NFX-03), hash lists, playlists and files (NFX-05), with sha256
//! from RustCrypto, so verification does not depend on WebCrypto and its secure-context
//! rule (spike S3). The mesh's Nostr signaling (NFX-10 §6) is built and read here too:
//! [`MeshRoom`] and [`MeshSession`].
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
use nfx_proto::signal::{self, Parsed, Received, Room, Session, Signal};
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

/// NFX-02 §4 on a kind-38504 event (JSON); returns the manifest as JSON, with the event
/// `id` for the revision tie-break (NFX-02 §4 "Revisions").
pub fn manifest_json(event_json: &str) -> Result<String, String> {
    let event = parse_event(event_json)?;
    let m = Manifest::from_event(&event).map_err(|e| e.to_string())?;
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
        "id": event.id,
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

/// An NFX deletion (NFX-02 §6) as JSON: `{author, created_at, addresses}`.
pub fn deletion_json(event_json: &str) -> Result<String, String> {
    let d = nfx_proto::deletion::Deletion::from_event(&parse_event(event_json)?)
        .map_err(|e| e.to_string())?;
    Ok(json!({
        "author": d.author,
        "created_at": d.created_at,
        "addresses": d.addresses.iter().map(ToString::to_string).collect::<Vec<_>>(),
    })
    .to_string())
}

/// A manifest address `38504:<creator>:<namespace>:<video-id>`, checked by the NFX grammar;
/// returns `{creator, video, namespace}` as JSON.
pub fn a_tag_json(a: &str) -> Result<String, String> {
    let (creator, video) = nfx_proto::beacon::parse_a_tag(a).map_err(|e| e.to_string())?;
    Ok(json!({
        "creator": creator,
        "video": video.to_string(),
        "namespace": video.namespace().to_string(),
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
    /// (`…/<sha256>[.<ext>]`), or the master playlist for `…/<root>/master.m3u8`. An origin
    /// may sit under a path prefix (NFX-03's `https://seed.example/nfx`), so only the last
    /// two path elements count.
    pub fn expected_for_path(&self, path: &str) -> Result<String, String> {
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        let last = parts.last().copied().unwrap_or("");
        let parent = parts
            .len()
            .checked_sub(2)
            .and_then(|i| parts.get(i))
            .copied();
        if parent == Some(self.root.as_str()) && last == "master.m3u8" {
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

    /// The browser-mesh stream swarm ID (NFX-10 §2) of the stream whose playlist is at
    /// `path`: its last path element is the playlist's content name, which names exactly
    /// one rendition. `None` when it maps to no rendition; such a stream joins no swarm.
    #[must_use]
    pub fn stream_swarm_id(&self, path: &str) -> Option<String> {
        let last = path.split('/').rfind(|p| !p.is_empty())?;
        let rendition = self.list.rendition_for_playlist(last)?;
        let video = VideoAddr::parse(&self.list.video).ok()?;
        Some(video.web_stream_swarm_id(&rendition.id))
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
    /// NFX-10 §2 stream swarm ID for a playlist path, or `undefined`.
    #[wasm_bindgen(js_name = streamSwarmId)]
    pub fn js_stream_swarm_id(&self, path: &str) -> Option<String> {
        self.stream_swarm_id(path)
    }

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

/// `verifyDeletion(eventJson)`: `{author, created_at, addresses}` as JSON, or a thrown error.
#[wasm_bindgen(js_name = verifyDeletion)]
pub fn js_verify_deletion(event_json: &str) -> Result<String, JsError> {
    deletion_json(event_json).map_err(|e| JsError::new(&e))
}

/// `parseATag(a)`: `{creator, video, namespace}` as JSON, or a thrown error.
#[wasm_bindgen(js_name = parseATag)]
pub fn js_parse_a_tag(a: &str) -> Result<String, JsError> {
    a_tag_json(a).map_err(|e| JsError::new(&e))
}

/// `verifyBeacon(eventJson, now)`: the beacon as JSON, or a thrown error.
#[wasm_bindgen(js_name = verifyBeacon)]
pub fn js_verify_beacon(event_json: &str, now: f64) -> Result<String, JsError> {
    let now = safe_u64(now, "now").map_err(|e| JsError::new(&e))?;
    beacon_json(event_json, now).map_err(|e| JsError::new(&e))
}

/// A mesh room (NFX-10 §6.1): one stream swarm's key pair.
#[wasm_bindgen]
pub struct MeshRoom {
    room: Room,
}

#[wasm_bindgen]
impl MeshRoom {
    /// `new MeshRoom(streamSwarmId)`.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(stream_swarm_id: &str) -> Self {
        Self {
            room: Room::derive(stream_swarm_id),
        }
    }

    /// The room key (the `P` tag), 64 lowercase hex.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn pubkey(&self) -> String {
        self.room.pubkey().to_owned()
    }
}

/// A mesh session (NFX-10 §6.4): a random key and id, made by the page and held here.
#[wasm_bindgen]
pub struct MeshSession {
    session: Session,
}

fn bytes<const N: usize>(b: &[u8], what: &str) -> Result<[u8; N], String> {
    b.try_into()
        .map_err(|_| format!("{what} must be {N} bytes"))
}

impl MeshSession {
    /// A session from 32 random bytes (a secret key) and 16 random bytes (its id).
    pub fn create(secret: &[u8], id: &[u8]) -> Result<Self, String> {
        let session = Session::new(bytes(secret, "the secret")?, bytes(id, "the session id")?)
            .map_err(|e| e.to_string())?;
        Ok(Self { session })
    }

    fn json(ev: nfx_proto::Result<Event>) -> Result<String, String> {
        let ev = ev.map_err(|e| e.to_string())?;
        serde_json::to_string(&ev).map_err(|e| e.to_string())
    }

    pub fn connect_json(&self, room: &MeshRoom, created_at: u64) -> Result<String, String> {
        Self::json(self.session.connect(&room.room, created_at))
    }

    pub fn disconnect_json(&self, room: &MeshRoom, created_at: u64) -> Result<String, String> {
        Self::json(self.session.disconnect(&room.room, created_at))
    }

    pub fn offer_json(
        &self,
        room: &MeshRoom,
        to: &str,
        sdp: &str,
        nonce: &[u8],
        created_at: u64,
    ) -> Result<String, String> {
        let nonce = bytes(nonce, "the nonce")?;
        Self::json(self.session.offer(&room.room, to, sdp, &nonce, created_at))
    }

    pub fn answer_json(
        &self,
        room: &MeshRoom,
        to: &str,
        offer_id: &str,
        sdp: &str,
        nonce: &[u8],
        created_at: u64,
    ) -> Result<String, String> {
        let nonce = bytes(nonce, "the nonce")?;
        Self::json(
            self.session
                .answer(&room.room, to, offer_id, sdp, &nonce, created_at),
        )
    }

    /// [`signal::read`] for this session in `room` at `now`, as JSON: `{"ignored": why}`, or
    /// `{"type", "id", "sender", "session", "created_at"}` with `expiration` (connect),
    /// `content` (offer, answer) and `offer` (answer).
    pub fn read_json(&self, room: &MeshRoom, event_json: &str, now: u64) -> Result<String, String> {
        let ev = parse_event(event_json)?;
        let parsed = signal::read(&ev, room.room.pubkey(), self.session.pubkey(), now)
            .map_err(|e| e.to_string())?;
        let r = match parsed {
            Parsed::Ignored(why) => return Ok(json!({ "ignored": why }).to_string()),
            Parsed::Ours(r) => r,
        };
        let mut out = json!({
            "id": r.id,
            "sender": r.sender,
            "session": r.session,
            "created_at": r.created_at,
        });
        match r.signal {
            Signal::Connect { expiration } => {
                out["type"] = "connect".into();
                out["expiration"] = expiration.into();
            }
            Signal::Disconnect => out["type"] = "disconnect".into(),
            Signal::Offer { content } => {
                out["type"] = "offer".into();
                out["content"] = content.into();
            }
            Signal::Answer { offer, content } => {
                out["type"] = "answer".into();
                out["offer"] = offer.into();
                out["content"] = content.into();
            }
        }
        Ok(out.to_string())
    }

    /// The SDP of an offer or answer `read_json` accepted: `content` from `sender`.
    pub fn open_sdp(&self, sender: &str, content: &str) -> Result<String, String> {
        let received = Received {
            id: String::new(),
            sender: sender.to_owned(),
            session: String::new(),
            created_at: 0,
            signal: Signal::Offer {
                content: content.to_owned(),
            },
        };
        self.session.open(&received).map_err(|e| e.to_string())
    }
}

#[wasm_bindgen]
impl MeshSession {
    /// `new MeshSession(secret, id)`: 32 random bytes (a valid secret key) and 16 random
    /// bytes. The page must not reuse or keep them.
    #[wasm_bindgen(constructor)]
    pub fn js_new(secret: &[u8], id: &[u8]) -> Result<MeshSession, JsError> {
        Self::create(secret, id).map_err(|e| JsError::new(&e))
    }

    /// The session key, 64 lowercase hex.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn pubkey(&self) -> String {
        self.session.pubkey().to_owned()
    }

    /// The session id, 32 lowercase hex.
    #[wasm_bindgen(getter)]
    #[must_use]
    pub fn id(&self) -> String {
        self.session.id().to_owned()
    }

    /// `connect(room, createdAt)`: the signed presence event, as JSON.
    #[wasm_bindgen(js_name = connect)]
    pub fn js_connect(&self, room: &MeshRoom, created_at: f64) -> Result<String, JsError> {
        let t = safe_u64(created_at, "createdAt").map_err(|e| JsError::new(&e))?;
        self.connect_json(room, t).map_err(|e| JsError::new(&e))
    }

    /// `disconnect(room, createdAt)`: the signed leave event, as JSON.
    #[wasm_bindgen(js_name = disconnect)]
    pub fn js_disconnect(&self, room: &MeshRoom, created_at: f64) -> Result<String, JsError> {
        let t = safe_u64(created_at, "createdAt").map_err(|e| JsError::new(&e))?;
        self.disconnect_json(room, t).map_err(|e| JsError::new(&e))
    }

    /// `offer(room, to, sdp, nonce, createdAt)`: the signed, encrypted offer, as JSON.
    #[wasm_bindgen(js_name = offer)]
    pub fn js_offer(
        &self,
        room: &MeshRoom,
        to: &str,
        sdp: &str,
        nonce: &[u8],
        created_at: f64,
    ) -> Result<String, JsError> {
        let t = safe_u64(created_at, "createdAt").map_err(|e| JsError::new(&e))?;
        self.offer_json(room, to, sdp, nonce, t)
            .map_err(|e| JsError::new(&e))
    }

    /// `answer(room, to, offerId, sdp, nonce, createdAt)`: the signed, encrypted answer.
    #[wasm_bindgen(js_name = answer)]
    pub fn js_answer(
        &self,
        room: &MeshRoom,
        to: &str,
        offer_id: &str,
        sdp: &str,
        nonce: &[u8],
        created_at: f64,
    ) -> Result<String, JsError> {
        let t = safe_u64(created_at, "createdAt").map_err(|e| JsError::new(&e))?;
        self.answer_json(room, to, offer_id, sdp, nonce, t)
            .map_err(|e| JsError::new(&e))
    }

    /// `read(room, eventJson, now)`: see `read_json`; throws for an event to drop.
    #[wasm_bindgen(js_name = read)]
    pub fn js_read(&self, room: &MeshRoom, event_json: &str, now: f64) -> Result<String, JsError> {
        let now = safe_u64(now, "now").map_err(|e| JsError::new(&e))?;
        self.read_json(room, event_json, now)
            .map_err(|e| JsError::new(&e))
    }

    /// `open(sender, content)`: the SDP, or a thrown error.
    #[wasm_bindgen(js_name = open)]
    pub fn js_open(&self, sender: &str, content: &str) -> Result<String, JsError> {
        self.open_sdp(sender, content).map_err(|e| JsError::new(&e))
    }
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
        assert_eq!(out["id"], m["event"]["id"]);
        let a: Value =
            serde_json::from_str(&a_tag_json(out["a"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(a["creator"], out["author"]);
        assert_eq!(a["video"], out["video"]);
        assert_eq!(a["namespace"], "nfx:mainnet:1");
        for bad in [
            "30023:ab:nfx:mainnet:1:x",
            "38504:AB:nfx:mainnet:1:salt-flats-dusk",
            "",
        ] {
            assert!(a_tag_json(bad).is_err(), "{bad}");
        }
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
    fn deletions_verify_and_summarise() {
        let v: Value =
            serde_json::from_str(include_str!("../../../spec/test-vectors/deletion.json")).unwrap();
        let out: Value =
            serde_json::from_str(&deletion_json(&v["event"].to_string()).unwrap()).unwrap();
        assert_eq!(out["addresses"][0], "nfx:mainnet:1:salt-flats-dusk");
        for case in v["cases"].as_array().unwrap() {
            assert!(deletion_json(&case["event"].to_string()).is_err());
        }
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
            v.check(&format!("/nfx/{root}/master.m3u8"), text).unwrap(),
            master.sha256,
            "an origin under a path prefix"
        );
        assert!(v.expected_for_path("/master.m3u8").is_err());
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

        // NFX-10 §2: a stream maps to its rendition by its playlist's content name.
        let playlist = list
            .files
            .iter()
            .find(|f| f.role == Role::Playlist)
            .unwrap();
        let id = "nfx/1/web/nfx:mainnet:1:salt-flats-dusk/720p";
        for path in [
            format!("/{}.m3u8", playlist.sha256),
            format!("/nfx/{root}/{}.m3u8", playlist.sha256),
        ] {
            assert_eq!(v.stream_swarm_id(&path).as_deref(), Some(id), "{path}");
        }
        for unmapped in [
            format!("/{}.m3u8", master.sha256),
            format!("/{root}/master.m3u8"),
            format!("/{}.m3u8", "a".repeat(64)),
            format!("/{}", playlist.sha256),
            String::new(),
        ] {
            assert_eq!(v.stream_swarm_id(&unmapped), None, "{unmapped}");
        }
    }

    #[test]
    fn mesh_signals_round_trip_against_the_vector() {
        let v: Value =
            serde_json::from_str(include_str!("../../../spec/test-vectors/mesh-signal.json"))
                .unwrap();
        let hex32 =
            |key: &str| hex::decode(v["secret_keys_DO_NOT_USE"][key].as_str().unwrap()).unwrap();
        let id =
            |role: &str| hex::decode(v["sessions"][role]["session_id"].as_str().unwrap()).unwrap();
        let room = MeshRoom::new(v["room"]["stream_swarm_id"].as_str().unwrap());
        assert_eq!(room.pubkey(), v["room"]["pubkey"].as_str().unwrap());
        let off = MeshSession::create(&hex32("offerer"), &id("offerer")).unwrap();
        let ans = MeshSession::create(&hex32("answerer"), &id("answerer")).unwrap();
        let evs = &v["events"];
        let at = evs["connect"]["created_at"].as_u64().unwrap();
        let now = v["now"].as_u64().unwrap();
        let connect: Value = serde_json::from_str(&off.connect_json(&room, at).unwrap()).unwrap();
        assert_eq!(connect, evs["connect"]);
        let nonce = hex::decode(v["nip44"]["offer_nonce"].as_str().unwrap()).unwrap();
        let sdp = v["sdp"]["offer"].as_str().unwrap();
        let offer = off
            .offer_json(&room, &ans.pubkey(), sdp, &nonce, at)
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&offer).unwrap(), evs["offer"]);
        let read: Value =
            serde_json::from_str(&ans.read_json(&room, &offer, now).unwrap()).unwrap();
        assert_eq!(read["type"], "offer");
        assert_eq!(read["sender"], off.pubkey().as_str());
        assert_eq!(
            ans.open_sdp(
                read["sender"].as_str().unwrap(),
                read["content"].as_str().unwrap()
            )
            .unwrap(),
            sdp
        );
        let ignored: Value =
            serde_json::from_str(&off.read_json(&room, &offer, now).unwrap()).unwrap();
        assert!(ignored["ignored"].is_string());
        let presence: Value = serde_json::from_str(
            &ans.read_json(&room, &evs["connect"].to_string(), now)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(presence["expiration"], at + 90);
        assert!(
            ans.read_json(&room, &evs["connect"].to_string(), now + 1000)
                .is_err()
        );
        assert!(
            MeshSession::create(&[0; 32], &[0; 16]).is_err(),
            "zero is no key"
        );
        assert!(MeshSession::create(&[1; 31], &[0; 16]).is_err());
        assert!(
            off.offer_json(&room, &ans.pubkey(), sdp, &[0; 31], at)
                .is_err()
        );
    }

    #[test]
    fn js_numbers_must_be_safe_integers() {
        assert_eq!(safe_u64(7.0, "n").unwrap(), 7);
        for bad in [-1.0, 1.5, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
            assert!(safe_u64(bad, "n").is_err(), "{bad}");
        }
    }
}
