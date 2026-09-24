//! The contracts of NFX-07 open-mode payments.
//!
//! **Accounting is per (peer, video), not per session** (NFX-07 §3). A peer is the
//! transport's authenticated identity; its account for a video outlives its sessions, and
//! bans are per peer. Every request for a file of the session's video is admitted, or
//! not, as one chunk: whole, ranged or aborted alike, counted at admission. Service stops
//! at `window` chunks beyond the last **confirmed** payment (a completed swap), and a
//! global cap bounds unpaid service across all peers. So the seeder's loss is at most
//! `window` per peer and the cap in total, however swaps are delayed.

use nfx_proto::pay::{Ack, Hello, Pay, Quote, Rej};

/// A payer's identity as the transport authenticates it (the iroh endpoint id).
pub type PeerId = [u8; 32];

/// The seeder's payment engine for one video: every peer's sessions and accounts.
/// Implementations: the real engine (locked until the M2 security stage) and
/// [`crate::mock::MockEngine`].
pub trait SeederEngine {
    type Session: SeederSession;

    /// A `hello` from `peer`. The session continues the peer's account for the video; it
    /// never opens a fresh window. Refused with `banned` for a banned peer, with
    /// `bad-session` for a session id another peer holds or beyond the per-peer cap, and
    /// with `unknown-video` for a video this engine does not serve.
    fn hello(&self, peer: &PeerId, hello: &Hello) -> Result<Self::Session, Rej>;
}

/// One session: one peer, one video.
#[allow(async_fn_in_trait)]
pub trait SeederSession {
    /// The binding quote.
    fn quote(&self) -> &Quote;

    /// Admit one request for the file `sha256`, counting it at once, whole, ranged or
    /// aborted alike. `false` means do not serve: the request is outside `window` over
    /// confirmed payment, the global cap is reached, the file is not this video's, or the
    /// peer is banned.
    fn admit(&mut self, sha256: &str) -> bool;

    /// Handle a `pay` (NFX-07 §3): decode (`bad-token`), mint (`bad-mint`), exact face
    /// value (`underpaid`/`overpaid`), then acknowledge and swap. A refusal changes no
    /// accounting and claims nothing. A spent proof bans the peer.
    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej>;

    /// Whether this session's peer is banned.
    fn banned(&self) -> bool;
}

/// The viewer's side of a session. Implementations: the real wallet-backed viewer
/// (locked until the M2 security stage) and [`crate::mock::MockViewer`].
#[allow(async_fn_in_trait)]
pub trait Viewer {
    /// Take the session's quote, or refuse it: over this viewer's price cap, naming no
    /// mint it holds tokens from, or a second quote in the same session.
    fn quote(&mut self, quote: &Quote) -> Result<(), String>;

    /// A chunk was requested (whole or not): the viewer owes it.
    fn requested(&mut self);

    /// The payment due now, if any. It covers requested chunks only, never ahead, and is
    /// made before the unpaid count reaches the window.
    async fn due(&mut self) -> Result<Option<Pay>, String>;

    /// The payment for every requested chunk not yet paid, when the session ends.
    async fn last_pay(&mut self) -> Result<Option<Pay>, String>;

    /// The seeder's `ack`. `Err`: it is unsolicited, or does not match the payment
    /// (`accepted_upto`, `spent_total`); the viewer stops paying this seeder.
    fn ack(&mut self, ack: &Ack) -> Result<(), String>;

    /// The seeder's `rej`: the viewer reclaims the refused payment's proofs and stops.
    async fn rej(&mut self, rej: &Rej);

    /// No `ack` came in time: the viewer reclaims the pending payment's proofs and stops.
    async fn timeout(&mut self);

    /// Whether the viewer has stopped paying this seeder.
    fn stopped(&self) -> bool;
}

/// Token shapes a seeder must refuse as `bad-token` (NFX-07 §3 step 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadToken {
    /// Not `sat`.
    WrongUnit,
    /// Proofs of more than one mint.
    TwoMints,
    /// Proofs locked to a spending condition (NUT-10/11/14).
    Locked,
    /// An invalid DLEQ proof (NUT-12).
    BadDleq,
    /// Not a token at all.
    Garbage,
}

/// What the adversary suite needs from an engine under test: the mock now, and the real
/// engine with an in-process mint in the M2 security stage.
#[allow(async_fn_in_trait)]
pub trait Harness {
    type Engine: SeederEngine;
    type Viewer: Viewer;

    /// An engine for [`Harness::hello`]'s video, quoting `price` and `window` with this
    /// harness's mint only, with a global unpaid cap of `global_cap` chunks.
    fn engine(&self, price: u64, window: u64, global_cap: u64) -> Self::Engine;
    /// A `hello` for the engine's video under a fresh session id.
    fn hello(&self) -> Hello;
    /// A distinct peer for each `n`.
    fn peer(&self, n: u8) -> PeerId;
    /// A file of the engine's video (distinct for each `n`).
    fn chunk(&self, n: u16) -> String;
    /// A file of another video.
    fn foreign_chunk(&self) -> String;

    /// A viewer holding tokens from this harness's mint, paying at most `max_price`.
    fn viewer(&self, max_price: u64) -> Self::Viewer;

    /// The quoted mint's URL.
    fn mint(&self) -> String;
    /// A fresh token worth exactly `amount` sat from the quoted mint.
    async fn token(&self, amount: u64) -> String;
    /// A fresh token worth `amount` sat from the mint at `url`, quoted or not.
    async fn token_at(&self, url: &str, amount: u64) -> String;
    /// A token of the given bad shape, face value `amount`.
    async fn bad_token(&self, kind: BadToken, amount: u64) -> String;
    /// The same proofs as `token` in a different string.
    async fn reencode(&self, token: &str) -> String;
    /// One token holding both tokens' proofs.
    async fn combine(&self, a: &str, b: &str) -> String;

    /// Whether `token`'s proofs have been claimed (swapped) at their mint, by anyone.
    async fn claimed(&self, token: &str) -> bool;
    /// A third party (a seeder keeping a refused payment) tries to claim `token`; whether
    /// it got the proofs.
    async fn steal(&self, token: &str) -> bool;

    /// Hold every swap until [`Harness::release_swaps`]: payments are acknowledged but not
    /// confirmed.
    fn hold_swaps(&self);
    /// Run the held swaps (and hold no more).
    async fn release_swaps(&self);
    /// Make the mint unreachable (`true`) or reachable again.
    fn mint_outage(&self, down: bool);
}
