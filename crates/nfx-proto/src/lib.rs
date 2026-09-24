//! NFX wire formats (`spec/`): namespaces and the `n` tag (NFX-01), kind-38504
//! manifests (NFX-02), kind-20464 beacons (NFX-03), hash lists and playlists (NFX-05),
//! gossip envelopes (NFX-06), vouchers (NFX-08) and canonical JSON (NFX-11 §9).
//!
//! Everything here is pure: no I/O, no clock (callers pass `now`), no RNG. The same
//! code is built natively and for `wasm32-unknown-unknown`, so browsers and native
//! peers verify with one implementation. Cryptography comes from RustCrypto (`k256`
//! BIP-340 Schnorr, `sha2`); nothing is hand-rolled.

pub mod beacon;
pub mod canon;
pub mod deletion;
mod error;
pub mod event;
pub mod gossip;
pub mod hashlist;
mod hex32;
pub mod manifest;
pub mod namespace;
pub mod pay;
mod verified;
pub mod voucher;

pub use error::{Error, Result};
pub use verified::Verified;

use sha2::{Digest, Sha256};

/// Kind of the addressable video manifest (NFX-02).
pub const KIND_MANIFEST: u16 = 38504;
/// Kind of the ephemeral availability beacon (NFX-03).
pub const KIND_BEACON: u16 = 20464;
/// Kind of a NIP-09 deletion request; NFX admits only manifest deletions (NFX-02 §6).
pub const KIND_DELETION: u16 = 5;
/// Largest `|now - created_at|` accepted for beacons and gossip envelopes, in seconds.
pub const MAX_CLOCK_SKEW: u64 = 15 * 60;

/// `sha256(bytes)`.
#[must_use]
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
