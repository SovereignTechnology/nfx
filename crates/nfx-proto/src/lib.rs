//! NFX wire formats (`spec/`): namespaces and the `n` tag (NFX-01), kind-38504
//! manifests (NFX-02), kind-20464 beacons (NFX-03), hash lists and playlists (NFX-05),
//! gossip envelopes (NFX-06), vouchers (NFX-08), mesh signaling over Nostr (NFX-10 §6,
//! with NIP-44 v2), canonical JSON (NFX-11 §9) and seeder ratings (NFX-16).
//!
//! Everything here is pure: no I/O, no clock (callers pass `now`), no RNG (callers pass
//! keys and nonces). The same code is built natively and for `wasm32-unknown-unknown`, so
//! browsers and native peers verify with one implementation. Cryptography comes from
//! RustCrypto (`k256` BIP-340 Schnorr and ECDH arithmetic, `sha2`, `chacha20`), except
//! NIP-44's HMAC and HKDF, written out over `sha2` in `nip44.rs` (why is said there).

pub mod beacon;
pub mod deletion;
pub mod event;
pub mod gossip;
pub mod hashlist;
pub mod manifest;
pub mod nip44;
pub mod rating;
pub mod signal;
mod verified;
pub mod voucher;

// The pay/1 wire and the modules it rests on live in `nfx-pay-wire`, which the lock
// pins whole (ADR 0008 §4); they are re-exported here unchanged.
use nfx_pay_wire::hex32;
pub use nfx_pay_wire::{Error, Result, canon, namespace, pay, sha256};
pub use verified::Verified;

/// Kind of the addressable video manifest (NFX-02).
pub const KIND_MANIFEST: u16 = 38504;
/// Kind of the ephemeral availability beacon (NFX-03).
pub const KIND_BEACON: u16 = 20464;
/// Kind of a mesh signaling event (NFX-10 §6; the NIP-DC draft's kind, `i` = `nfx-mesh/1`).
pub const KIND_SIGNAL: u16 = signal::KIND_SIGNAL;
/// Kind of a NIP-09 deletion request; NFX admits only manifest deletions (NFX-02 §6).
pub const KIND_DELETION: u16 = 5;
/// Kind of a seeder rating: nostr-identity's fact op, profiled by NFX-16 (not ours).
pub const KIND_RATING: u16 = 7368;
/// Largest `|now - created_at|` accepted for beacons and gossip envelopes, in seconds.
pub const MAX_CLOCK_SKEW: u64 = 15 * 60;
