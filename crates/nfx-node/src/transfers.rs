//! Where a node's video bytes came from, for a viewer's "stats for nerds" (nfx #99): per video
//! and per iroh seeder, the payload bytes and blobs fetched from it, when last, and whether a
//! connection to it is still open; and the path its bytes took (direct, with the seeder's
//! address, or through a relay) with the round-trip time: the open connection's path now, or
//! the one seen when its last blob arrived (a node's connections close after each pull).
//!
//! It counts bytes iroh read from the network ([`iroh_blobs`]' request counters), before they
//! are checked against the hash list: a blob that fails its sha256 still cost those bytes.
//! Blobs already held are not fetched and not counted.
//!
//! Nothing here is logged, announced or sent anywhere, and the paths stay in memory beside
//! what iroh itself holds: the desktop viewer reads the counters when its user opens the
//! panel, and the paths only when the user asks to see addresses. A
//! connection is held weakly ([`WeakConnectionHandle`]): keeping its counters never keeps
//! it open. Bounded: at most [`MAX_ENTRIES`] (video, seeder) pairs; past it, the one idle
//! longest goes.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use iroh::endpoint::{Connection, WeakConnectionHandle};
use iroh::{EndpointId, TransportAddr};

/// At most this many (video, seeder) pairs are kept.
pub const MAX_ENTRIES: usize = 1024;

/// One seeder of one video, as [`TransferLog::peers`] reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerTransfer {
    /// The seeder's iroh endpoint id (hex): its transport key, not its Nostr key.
    pub peer: String,
    /// Payload bytes read from it.
    pub bytes: u64,
    /// Blobs fetched from it (files, hash lists, collections).
    pub blobs: u64,
    /// When bytes last came from it, in milliseconds since the Unix epoch.
    pub last_ms: u64,
    /// Whether a connection to it is open now.
    pub open: bool,
}

/// The path a connection takes now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerPath {
    /// Straight to the seeder, at this address.
    Direct(SocketAddr),
    /// Through this iroh relay (its host).
    Relay(String),
    /// No path selected, or one of a kind this build does not name.
    Unknown,
}

impl PeerPath {
    /// `direct`, `relay` or `unknown`.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Direct(_) => "direct",
            Self::Relay(_) => "relay",
            Self::Unknown => "unknown",
        }
    }

    /// The seeder's address for a direct path, the relay's host for a relayed one.
    pub fn address(&self) -> Option<String> {
        match self {
            Self::Direct(addr) => Some(addr.to_string()),
            Self::Relay(host) => Some(host.clone()),
            Self::Unknown => None,
        }
    }
}

/// A seeder's path, as [`TransferLog::routes`] reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoute {
    pub peer: String,
    pub path: PeerPath,
    /// The selected path's round-trip time, in milliseconds.
    pub rtt_ms: Option<u64>,
    /// `path` is the open connection's now; false: as seen when its last blob arrived.
    pub open: bool,
}

struct Entry {
    bytes: u64,
    blobs: u64,
    last_ms: u64,
    conn: WeakConnectionHandle,
    path: PeerPath,
    rtt_ms: Option<u64>,
}

/// Per video and seeder transfer counters. Shared by a node's fetches.
#[derive(Default)]
pub struct TransferLog {
    entries: Mutex<HashMap<(String, EndpointId), Entry>>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// The connection behind `weak`, if it is still open.
fn open(weak: &WeakConnectionHandle) -> Option<Connection> {
    weak.upgrade().filter(|c| c.close_reason().is_none())
}

/// The path `conn` has selected now, and its round-trip time.
fn selected(conn: &Connection) -> (PeerPath, Option<u64>) {
    let paths = conn.paths();
    let Some(p) = paths.iter().find(|p| p.is_selected()) else {
        return (PeerPath::Unknown, None);
    };
    let path = match p.remote_addr() {
        TransportAddr::Ip(addr) => PeerPath::Direct(*addr),
        TransportAddr::Relay(url) => PeerPath::Relay(url.host_str().unwrap_or("relay").to_owned()),
        _ => PeerPath::Unknown,
    };
    (path, u64::try_from(p.rtt().as_millis()).ok())
}

impl TransferLog {
    /// `bytes` of payload read from `conn`'s seeder for the video `root`, in one blob.
    pub fn record(&self, root: &str, conn: &Connection, bytes: u64) {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let key = (root.to_owned(), conn.remote_id());
        if !entries.contains_key(&key) && entries.len() >= MAX_ENTRIES {
            let oldest = entries
                .iter()
                .min_by_key(|(_, e)| e.last_ms)
                .map(|(k, _)| k.clone());
            if let Some(oldest) = oldest {
                entries.remove(&oldest);
            }
        }
        let (path, rtt_ms) = selected(conn);
        let e = entries.entry(key).or_insert_with(|| Entry {
            bytes: 0,
            blobs: 0,
            last_ms: 0,
            conn: conn.weak_handle(),
            path: PeerPath::Unknown,
            rtt_ms: None,
        });
        e.bytes = e.bytes.saturating_add(bytes);
        e.blobs = e.blobs.saturating_add(1);
        e.last_ms = now_ms();
        e.conn = conn.weak_handle();
        e.path = path;
        e.rtt_ms = rtt_ms;
    }

    /// The seeders of `root`: open connections first, then most bytes.
    pub fn peers(&self, root: &str) -> Vec<PeerTransfer> {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let mut out: Vec<PeerTransfer> = entries
            .iter()
            .filter(|((r, _), _)| r == root)
            .map(|((_, peer), e)| PeerTransfer {
                peer: peer.to_string(),
                bytes: e.bytes,
                blobs: e.blobs,
                last_ms: e.last_ms,
                open: open(&e.conn).is_some(),
            })
            .collect();
        out.sort_by(|a, b| b.open.cmp(&a.open).then(b.bytes.cmp(&a.bytes)));
        out
    }

    /// The path to each seeder of `root`: an open connection's now, else the one its last
    /// blob took. Read only when the user asks: these are other hosts' addresses.
    pub fn routes(&self, root: &str) -> Vec<PeerRoute> {
        let entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        entries
            .iter()
            .filter(|((r, _), _)| r == root)
            .map(|((_, peer), e)| {
                let live = open(&e.conn).map(|c| selected(&c));
                let open = live.is_some();
                let (path, rtt_ms) = live.unwrap_or_else(|| (e.path.clone(), e.rtt_ms));
                PeerRoute {
                    peer: peer.to_string(),
                    path,
                    rtt_ms,
                    open,
                }
            })
            .collect()
    }
}
