//! Kind-20464 availability beacons (NFX-03). Beacon content is untrusted: endpoints
//! come from it, trust never does. Every byte fetched through an endpoint is still
//! verified against the hash list (NFX-05 §4).

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::event::Event;
use crate::hex32::{is_https_url, is_lower_hex, parse_u64_strict};
use crate::manifest::Manifest;
use crate::namespace::{Namespace, VideoAddr};
use crate::{Error, KIND_BEACON, KIND_MANIFEST, MAX_CLOCK_SKEW, Result, Verified};

/// Allowed `expiration - created_at`, in seconds (NFX-03 §1).
pub const TTL_RANGE: core::ops::RangeInclusive<u64> = 60..=120;

/// Where a seeder serves the video. Serializes back to the NFX-03 §4 wire form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Endpoint {
    /// NFX-06.
    Iroh {
        node: String,
        relay: String,
        addrs: Vec<String>,
        tickets: BTreeMap<String, String>,
    },
    /// NFX-05 §6.
    Https { url: String },
    /// NFX-10 §2: a bridge. Swarm ids and infohashes are derived per rendition, never carried.
    Webrtc {
        tracker_urls: Vec<String>,
        /// Renditions whose swarms the bridge joins; empty means every rendition.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        renditions: Vec<String>,
    },
    /// NFX-12 (optional).
    Hyper { drive: String },
}

/// How much of the hash list a seeder holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chunks {
    All,
    Count(u64),
}

impl Serialize for Chunks {
    fn serialize<S: serde::Serializer>(&self, s: S) -> core::result::Result<S::Ok, S::Error> {
        match self {
            Self::All => s.serialize_str("all"),
            Self::Count(n) => s.serialize_u64(*n),
        }
    }
}

/// Beacon content (NFX-03 §4). Field order is the wire order of the test vectors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BeaconContent {
    pub v: u8,
    #[serde(serialize_with = "display")]
    pub video: VideoAddr,
    pub endpoints: Vec<Endpoint>,
    /// `t` values of endpoints this implementation skipped as unknown (NFX-03 §4).
    #[serde(skip)]
    pub skipped: Vec<String>,
    pub chunks: Chunks,
    pub price_hint: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub accepts_mints: Vec<String>,
    pub free: bool,
}

fn display<T: core::fmt::Display, S: serde::Serializer>(
    v: &T,
    s: S,
) -> core::result::Result<S::Ok, S::Error> {
    s.collect_str(v)
}

impl BeaconContent {
    /// Parse and check content. Unknown endpoint types are skipped, known ones must be
    /// well formed, and at least one endpoint of any type must be present.
    pub fn from_json(value: &Value) -> Result<Self> {
        let obj = value
            .as_object()
            .ok_or_else(|| bad("content is not an object"))?;
        if obj.get("v").and_then(Value::as_u64) != Some(1) {
            return Err(bad("`v` must be 1"));
        }
        let video = VideoAddr::parse(str_field(obj, "video")?)?;
        let raw_endpoints = obj
            .get("endpoints")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("`endpoints` must be an array"))?;
        if raw_endpoints.is_empty() {
            return Err(bad("`endpoints` must not be empty"));
        }
        let mut endpoints = Vec::new();
        let mut skipped = Vec::new();
        for raw in raw_endpoints {
            match parse_endpoint(raw)? {
                Parsed::Known(e) => endpoints.push(e),
                Parsed::Unknown(t) => skipped.push(t),
            }
        }
        let chunks = match obj.get("chunks") {
            Some(Value::String(s)) if s == "all" => Chunks::All,
            Some(Value::Number(n)) => {
                Chunks::Count(n.as_u64().ok_or_else(|| bad("`chunks` is not a count"))?)
            }
            _ => return Err(bad("`chunks` must be \"all\" or a count")),
        };
        let price_hint = obj
            .get("price_hint")
            .and_then(Value::as_u64)
            .ok_or_else(|| bad("`price_hint` must be a non-negative integer"))?;
        let accepts_mints = match obj.get("accepts_mints") {
            None => Vec::new(),
            Some(v) => strings(v, "accepts_mints", is_https_url)?,
        };
        let free = match obj.get("free") {
            None => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(bad("`free` must be a boolean")),
        };
        // NFX-03 §4: a paying seeder names its mints; there is no "any mint".
        if !free && accepts_mints.is_empty() {
            return Err(bad(
                "`accepts_mints` is required and non-empty unless `free`",
            ));
        }
        Ok(Self {
            v: 1,
            video,
            endpoints,
            skipped,
            chunks,
            price_hint,
            accepts_mints,
            free,
        })
    }

    /// Compact JSON for the event `content` (the publisher side).
    #[must_use]
    pub fn to_content(&self) -> String {
        serde_json::to_string(self).expect("beacon content always serializes")
    }
}

enum Parsed {
    Known(Endpoint),
    Unknown(String),
}

fn parse_endpoint(raw: &Value) -> Result<Parsed> {
    let obj = raw
        .as_object()
        .ok_or_else(|| bad("endpoint is not an object"))?;
    let t = str_field(obj, "t")?;
    let endpoint = match t {
        "iroh" => {
            let node = str_field(obj, "node")?;
            if !is_lower_hex(node, 64) {
                return Err(bad("iroh `node` must be 64 lowercase hex"));
            }
            let tickets = match obj.get("tickets") {
                None => BTreeMap::new(),
                Some(Value::Object(map)) => map
                    .iter()
                    .map(|(k, v)| match v.as_str() {
                        Some(s) if s.len() >= 8 => Ok((k.clone(), s.to_owned())),
                        _ => Err(bad("iroh tickets must be strings of 8+ chars")),
                    })
                    .collect::<Result<_>>()?,
                Some(_) => return Err(bad("iroh `tickets` must be an object")),
            };
            Endpoint::Iroh {
                node: node.to_owned(),
                relay: obj
                    .get("relay")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                addrs: match obj.get("addrs") {
                    None => Vec::new(),
                    Some(v) => strings(v, "addrs", |_| true)?,
                },
                tickets,
            }
        }
        "https" => {
            let url = str_field(obj, "url")?;
            if !is_https_url(url) {
                return Err(bad("https endpoint `url` must be an https URL"));
            }
            Endpoint::Https {
                url: url.to_owned(),
            }
        }
        "webrtc" => {
            let tracker_urls = strings(
                obj.get("tracker_urls")
                    .ok_or_else(|| bad("webrtc endpoint needs `tracker_urls`"))?,
                "tracker_urls",
                |u| u.starts_with("wss://") || u.starts_with("ws://"),
            )?;
            let renditions = match obj.get("renditions") {
                None => Vec::new(),
                Some(v) => strings(v, "renditions", |r| {
                    !r.is_empty() && r != crate::hashlist::RESERVED_RENDITION_ID
                })?,
            };
            Endpoint::Webrtc {
                tracker_urls,
                renditions,
            }
        }
        "hyper" => {
            let drive = str_field(obj, "drive")?;
            if !is_lower_hex(drive, 64) {
                return Err(bad("hyper `drive` must be 64 lowercase hex"));
            }
            Endpoint::Hyper {
                drive: drive.to_owned(),
            }
        }
        other => return Ok(Parsed::Unknown(other.to_owned())),
    };
    Ok(Parsed::Known(endpoint))
}

/// A beacon event that passed NFX-03 in full at time `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Beacon {
    pub seeder: String,
    pub created_at: u64,
    pub expiration: u64,
    /// Author of the manifest this beacon serves (from the `a` tag).
    pub creator: String,
    pub content: BeaconContent,
}

impl Beacon {
    /// Verify a kind-20464 event at time `now` (unix seconds).
    pub fn from_event(event: &Event, now: u64) -> Result<Verified<Self>> {
        if event.kind != KIND_BEACON {
            return Err(bad("wrong kind"));
        }
        event.verify()?;
        let namespace = Namespace::parse(tag(event, "n")?)?;
        let (creator, addr) = parse_a_tag(tag(event, "a")?)?;
        if addr.namespace() != &namespace {
            return Err(bad("`a` names a different network than `n`"));
        }
        let expiration =
            parse_u64_strict(tag(event, "expiration")?).ok_or_else(|| bad("bad `expiration`"))?;
        let ttl = expiration
            .checked_sub(event.created_at)
            .ok_or_else(|| bad("`expiration` precedes `created_at`"))?;
        if !TTL_RANGE.contains(&ttl) {
            return Err(bad("TTL outside [60,120] s"));
        }
        if now.abs_diff(event.created_at) > MAX_CLOCK_SKEW {
            return Err(bad("`created_at` more than 15 min from now"));
        }
        if now >= expiration {
            return Err(bad("expired"));
        }
        let content: Value =
            serde_json::from_str(&event.content).map_err(|_| bad("content is not JSON"))?;
        let content = BeaconContent::from_json(&content)?;
        if content.video != addr {
            return Err(bad("content `video` does not equal the `a` tag's d"));
        }
        Ok(Verified::new(Self {
            seeder: event.pubkey.clone(),
            created_at: event.created_at,
            expiration,
            creator,
            content,
        }))
    }
}

impl Beacon {
    /// Whether this beacon announces `manifest` (same author and address). A client
    /// holding beacons from a broad REQ must check this before using the endpoints.
    #[must_use]
    pub fn serves(&self, manifest: &Manifest) -> bool {
        self.creator == manifest.author && self.content.video == manifest.addr
    }
}

/// The NFX-03 §1 tags for a beacon serving `manifest_a` (a [`Manifest::a_tag`]), emitted at
/// `created_at` with lifetime `ttl` seconds. The namespace is taken from the `a` tag, so the
/// `n`/`a` agreement rule holds by construction.
pub fn tags(manifest_a: &str, created_at: u64, ttl: u64) -> Result<Vec<Vec<String>>> {
    let (_, addr) = parse_a_tag(manifest_a)?;
    if !TTL_RANGE.contains(&ttl) {
        return Err(bad("TTL outside [60,120] s"));
    }
    let expiration = created_at
        .checked_add(ttl)
        .ok_or_else(|| bad("`expiration` overflows"))?;
    Ok(vec![
        vec!["n".into(), addr.namespace().to_string()],
        vec!["a".into(), manifest_a.to_owned()],
        vec!["expiration".into(), expiration.to_string()],
    ])
}

/// The single value of a required tag.
fn tag<'a>(event: &'a Event, name: &str) -> Result<&'a str> {
    match event.single_tag(name).map_err(Error::Beacon)? {
        Some(values) => Ok(values[0].as_str()),
        None => Err(Error::Beacon(format!("missing `{name}` tag"))),
    }
}

/// `38504:<creator>:<namespace>:<video-id>` → (creator, address).
pub fn parse_a_tag(a: &str) -> Result<(String, VideoAddr)> {
    let mut parts = a.splitn(3, ':');
    let (Some(kind), Some(creator), Some(d)) = (parts.next(), parts.next(), parts.next()) else {
        return Err(bad("malformed `a` tag"));
    };
    if kind != KIND_MANIFEST.to_string() {
        return Err(bad("`a` must address a kind-38504 manifest"));
    }
    if !is_lower_hex(creator, 64) {
        return Err(bad("`a` creator is not 64 lowercase hex"));
    }
    Ok((creator.to_owned(), VideoAddr::parse(d)?))
}

fn str_field<'a>(obj: &'a serde_json::Map<String, Value>, name: &str) -> Result<&'a str> {
    obj.get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Beacon(format!("`{name}` must be a string")))
}

fn strings(value: &Value, name: &str, ok: impl Fn(&str) -> bool) -> Result<Vec<String>> {
    value
        .as_array()
        .ok_or_else(|| Error::Beacon(format!("`{name}` must be an array")))?
        .iter()
        .map(|v| match v.as_str() {
            Some(s) if ok(s) => Ok(s.to_owned()),
            _ => Err(Error::Beacon(format!("bad entry in `{name}`"))),
        })
        .collect()
}

fn bad(reason: &str) -> Error {
    Error::Beacon(reason.to_owned())
}
