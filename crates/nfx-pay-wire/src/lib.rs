//! The pay/1 wire (NFX-07) and the pure modules it rests on: canonical JSON (NFX-11 §9),
//! namespaces and video addresses (NFX-01), and the NFX error type.
//!
//! A crate of its own, locked whole with the money code (ADR 0008 §4,
//! `crates/ci/check-locked.sh`): within one crate, a module can change how another
//! compiles (a macro in textual scope, an inherent method shadowing a derived one), so
//! the pinned parser lives where no unpinned module does. `nfx-proto` re-exports it
//! unchanged, and `nfx-pay` depends on it alone.
//!
//! Everything here is pure: no I/O, no clock, no RNG, built natively and for
//! `wasm32-unknown-unknown` alike.

pub mod canon;
mod error;
#[doc(hidden)]
pub mod hex32;
pub mod namespace;
pub mod pay;

pub use error::{Error, Result};

use sha2::{Digest, Sha256};

/// `sha256(bytes)`.
#[must_use]
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}
