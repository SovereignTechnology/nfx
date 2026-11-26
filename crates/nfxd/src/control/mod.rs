//! The control socket: how a local program asks a running node what it holds and tells it
//! what to change (ADR 0113, `docs/nfx/control.md`).
//!
//! [`proto`] is the protocol itself: messages, limits and framing, with no I/O.

pub mod proto;
