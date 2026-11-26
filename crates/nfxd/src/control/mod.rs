//! The control socket: how a local program asks a running node what it holds and tells it
//! what to change (ADR 0113, `docs/nfx/control.md`).
//!
//! [`proto`] is the protocol itself: messages, limits and framing, with no I/O.
//! [`server`] is the node's end of the socket: who may connect, how frames are read,
//! and what is refused before a request reaches the node.

pub mod proto;
pub mod server;
