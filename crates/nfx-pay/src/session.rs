//! The contracts of NFX-07 open-mode payments.
//!
//! **One [`SeederEngine`] is one seeder**: every video it serves, every peer's accounts,
//! its bans and its global cap (NFX-07 §3).
//! - **Accounts.** An account is (peer, video). It numbers that peer's chunks of the video
//!   and outlives its sessions.
//! - **Admission.** Every request for a file of the session's video is admitted, or not,
//!   as one chunk: whole, ranged or aborted alike, counted at admission. A pre-paid chunk
//!   is always served.
//! - **Limits.** Uncovered chunks are admitted only while the peer owes fewer than
//!   `window` across its videos, and while the unpaid chunks admitted in the last
//!   `debt_ttl`, across all peers, stay under the global cap.
//! - **Payment.** A payment is swapped before it is acknowledged, so an ack is
//!   confirmation and no mint delay widens either bound.

use std::time::Duration;

use nfx_proto::pay::{Ack, Hello, Pay, Quote, Rej};

/// A payer's identity as the transport gives it (the iroh endpoint id).
pub type PeerId = [u8; 32];

/// A seeder's payment engine. Implementations: the real engine (locked until the M2
/// security stage) and [`crate::mock::MockEngine`].
#[allow(async_fn_in_trait)]
pub trait SeederEngine {
    type Session: SeederSession + Send;

    /// A `hello` from `peer`. The session continues the peer's account for the video, and
    /// its quote carries the account's position. A `hello` creates no account, and waits
    /// for a payment in progress on the account (at most the seeder's 60 s), so its quote
    /// never misses one.
    ///
    /// Refused with:
    /// - `banned` for a banned peer;
    /// - `unknown-video` for a video this seeder does not serve;
    /// - `bad-session` for a session id that is open, or beyond the per-peer cap on open
    ///   sessions, counted across all videos.
    async fn hello(&self, peer: &PeerId, hello: &Hello) -> Result<Self::Session, Rej>;
}

/// One open session: one peer, one video. **Dropping it closes it.**
#[allow(async_fn_in_trait)]
pub trait SeederSession {
    /// The binding quote, with the account's position as of the `hello`.
    fn quote(&self) -> &Quote;

    /// Admit one request for the file `sha256`, counting it at once, whole, ranged or
    /// aborted alike. `false` means answer it with `refuse` and serve not one byte.
    /// That happens when:
    /// - the peer is banned;
    /// - the file is not this video's;
    /// - the chunk is not pre-paid and the account's window or the global cap is full.
    fn admit(&mut self, sha256: &str) -> bool;

    /// Handle a `pay` (NFX-07 §3), one at a time per account; bans are checked when its
    /// turn comes.
    ///
    /// The checks run in this order: structure (`bad-token`), quoted mint (`bad-mint`),
    /// DLEQ (`bad-token`), exact face value (`underpaid`/`overpaid`), then the swap. A
    /// completed swap gives the `ack`. The swap can also end as:
    /// - `spent` or invalid proofs: refused, and the peer is banned;
    /// - an unreachable mint: `mint-unavailable`, which is not a ban.
    ///
    /// A refusal changes no accounting and claims nothing.
    ///
    /// **Cancel-safe:** once the swap is sent it completes, and is credited or banned on,
    /// even if this future is dropped (the connection closed). The account's turn is held
    /// until then, or until the 60 s deadline: then the swap is abandoned, and a late
    /// outcome is neither credited nor banned on.
    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej>;

    /// Whether this session's peer is banned.
    fn banned(&self) -> bool;
}

/// The watcher's side, for one seeder and one video: its ledger lasts across sessions.
/// Implementations: the real wallet-backed viewer (locked until the M2 security stage)
/// and [`crate::mock::MockViewer`]. It keeps time on the harness's clock.
#[allow(async_fn_in_trait)]
pub trait Viewer {
    /// Start a session on its quote. A quote whose position equals the ledger plus a
    /// payment still unsettled settles it as accepted. `Err`, and the viewer stops, when
    /// the quote is not honest about the account:
    /// - it claims more chunks than were requested;
    /// - its `accepted_upto` or `spent_total` is anything else, below the ledger included.
    ///
    /// Also `Err`, without stopping: a price over this viewer's cap (on every session), no
    /// mint it holds tokens from, or a session already open.
    fn quote(&mut self, quote: &Quote) -> Result<(), String>;

    /// A request was sent. It is owed unless the seeder refuses it.
    fn requested(&mut self);

    /// The seeder answered a request with `refuse`. It is not owed, and if it was already
    /// paid for, that payment becomes credit. The next [`Viewer::due`] may pay ahead, up
    /// to half a window less the credit already held.
    fn refused(&mut self);

    /// The payment due now, if any. It covers requested chunks at the quoted price, made
    /// before the unpaid count reaches the window, or pays ahead after a refusal. One is
    /// in flight at a time, and none while a reclaim is incomplete. It first settles an
    /// unanswered payment older than 120 s by reclaiming it.
    async fn due(&mut self) -> Result<Option<Pay>, String>;

    /// The payment for every chunk still owed, when the session ends.
    async fn last_pay(&mut self) -> Result<Option<Pay>, String>;

    /// The seeder's `ack`. `Err`: it is unsolicited, or does not match the payment
    /// (`accepted_upto`, `spent_total`); the viewer stops paying this seeder.
    fn ack(&mut self, ack: &Ack) -> Result<(), String>;

    /// The seeder's `rej`, whatever its code: the viewer reclaims the payment's proofs.
    /// - If any proof is found spent, the payment is lost, and the viewer stops.
    /// - After `mint-unavailable` with every proof reclaimed, it may pay again.
    /// - After any other code, it stops.
    ///
    /// A reclaim the mint cannot serve yet blocks every payment until it completes.
    async fn rej(&mut self, rej: &Rej);

    /// No answer has come on a live connection. Before 120 s from sending this does
    /// nothing. From then, the viewer reclaims the proofs and stops; proofs found spent
    /// mean the payment is lost, never paid again.
    async fn timeout(&mut self);

    /// The session ended (its connection closed). The ledger stays, and a payment in
    /// flight stays unsettled. The next quote settles it if both its fields match; failing
    /// that, a reclaim after 120 s does.
    fn end(&mut self);

    /// Whether the viewer has stopped paying this seeder.
    fn stopped(&self) -> bool;
}

/// Token shapes a seeder must refuse as `bad-token` (NFX-07 §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BadToken {
    /// Not `sat`.
    WrongUnit,
    /// Proofs of more than one mint.
    TwoMints,
    /// Proofs locked to a spending condition (NUT-10/11/14).
    Locked,
    /// A proof without its DLEQ proof (NUT-12).
    NoDleq,
    /// An invalid DLEQ proof.
    BadDleq,
    /// Not a token at all.
    Garbage,
    /// More than 64 proofs (input fees grow with the proof count).
    TooManyProofs,
    /// Well formed, with valid DLEQs, but the mint refuses its proofs as invalid at the
    /// swap. This one also bans the peer.
    Forged,
}

/// A seeder's configuration, as the suite asks for one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineParams {
    pub price: u64,
    pub window: u64,
    pub global_cap: u64,
    pub debt_ttl: Duration,
    pub account_ttl: Duration,
}

/// What the adversary suite needs from an engine under test: the mock now, and the real
/// engine with an in-process mint in the M2 security stage.
#[allow(async_fn_in_trait)]
pub trait Harness {
    type Engine: SeederEngine + Send + Sync;
    type Viewer: Viewer;

    /// A seeder serving two videos (0 and 1) at `price`, quoting `window` (≥ 2) and this
    /// harness's mint only, with a global cap of `global_cap` unpaid chunks per
    /// [`Harness::debt_ttl`].
    fn engine(&self, price: u64, window: u64, global_cap: u64) -> Self::Engine;
    /// A seeder with exactly `params`, or its refusal to start (NFX-07 §3 configuration).
    fn engine_checked(&self, params: EngineParams) -> Result<Self::Engine, String>;
    /// How many per-identity records `engine` holds (accounts, open sessions and the
    /// like): what a flood of free identities costs it.
    fn identities_held(&self, engine: &Self::Engine) -> usize;
    /// A `hello` for video `v` (0 or 1), under a fresh session id.
    fn hello_for(&self, v: u8) -> Hello;
    /// A `hello` for video 0.
    fn hello(&self) -> Hello {
        self.hello_for(0)
    }
    /// A `hello` for a video the seeder does not serve.
    fn unknown_hello(&self) -> Hello;
    /// The most sessions one peer may hold open at once.
    fn session_cap(&self) -> usize;
    /// A distinct peer for each `n`.
    fn peer(&self, n: u8) -> PeerId;
    /// File `n` of video `v` (distinct for each pair).
    fn chunk_of(&self, v: u8, n: u16) -> String;
    /// File `n` of video 0.
    fn chunk(&self, n: u16) -> String {
        self.chunk_of(0, n)
    }
    /// A file of no video the seeder serves.
    fn foreign_chunk(&self) -> String;

    /// A viewer's ledger for one seeder and video. It holds tokens from this harness's
    /// mint and pays at most `max_price`.
    fn viewer(&self, max_price: u64) -> Self::Viewer;

    /// The quoted mint's URL.
    fn mint(&self) -> String;
    /// A fresh token worth exactly `amount` sat from the quoted mint, split into
    /// power-of-two proofs as a real mint issues them.
    async fn token(&self, amount: u64) -> String;
    /// The same from the mint at `url`, quoted or not.
    async fn token_at(&self, url: &str, amount: u64) -> String;
    /// A token of the given bad shape, face value `amount`.
    async fn bad_token(&self, kind: BadToken, amount: u64) -> String;
    /// The same proofs as `token` in a different string.
    async fn reencode(&self, token: &str) -> String;
    /// One token holding all the tokens' proofs, in the order given.
    async fn combine(&self, tokens: &[&str]) -> String;

    /// Whether any of `token`'s proofs has been claimed at its mint, by anyone.
    async fn claimed_any(&self, token: &str) -> bool;
    /// Whether all of them have.
    async fn claimed_all(&self, token: &str) -> bool;
    /// A third party (a seeder keeping a refused payment, say) claims whatever of
    /// `token`'s proofs are still unclaimed: whether it got any.
    async fn steal(&self, token: &str) -> bool;
    /// Whether anything (keys, a swap) has been fetched from the mint at `url`.
    fn dialled(&self, url: &str) -> bool;

    /// Hold every swap until [`Harness::release_swaps`]: the mint processes nothing, and a
    /// `pay` waits.
    fn hold_swaps(&self);
    /// The mint processes swaps at once, but holds their responses until
    /// [`Harness::release_swaps`]: processed, and not yet answered.
    fn hold_swap_responses(&self);
    /// Run the held swaps and deliver the held responses, and hold no more.
    async fn release_swaps(&self);
    /// Make the mint unreachable (`true`) or reachable again.
    fn mint_outage(&self, down: bool);

    /// Move the clock the seeder and the viewers keep forward.
    fn advance(&self, by: Duration);
    /// How long an unpaid chunk counts toward the global cap.
    fn debt_ttl(&self) -> Duration;
    /// How long a never-paid account with no open session is kept.
    fn account_ttl(&self) -> Duration;
}
