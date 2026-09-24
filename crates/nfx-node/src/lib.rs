//! An NFX peer (ADR 0008, A2): the content store, seeding and fetching over iroh
//! (NFX-06), gossip presence, and manifests and beacons over Nostr (NFX-02/03).
//!
//! The canonical store is NFX's own: files named by their sha256 ([`store::FsStore`]).
//! iroh-blobs is **transport only** (spike S1): a seeder imports store files by reference,
//! and a fetcher re-anchors every received file to the sha256 the signed hash list names
//! before it is stored (NFX-05 §4). A peer that serves bytes the hash list does not name
//! is reported as [`NodeError::Poisoned`].

mod error;
pub mod fetch;
pub mod gossip;
pub mod node;
pub mod nostr;
pub mod origin;
pub mod relay;
pub mod seed;
pub mod store;
pub mod video;

pub use error::{NodeError, Result};

/// ALPN of the NFX gossip swarm (NFX-06 §4).
pub const GOSSIP_ALPN: &[u8] = b"nfx/gossip/1";
/// ALPN of the payment channel (NFX-07; used from M2).
pub const PAY_ALPN: &[u8] = b"nfx/pay/1";

/// Unix seconds now. `nfx-proto` takes the clock as an argument; this crate supplies it.
#[must_use]
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
