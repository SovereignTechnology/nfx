//! The contracts of a pay/1 session (NFX-07): one watcher, one seeder, one video.
//!
//! Chunks are counted from 1 in delivery order; one chunk is one NFX-05 file, delivered
//! whole (NFX-10 §3.2). A `pay` covers the chunks after the last acknowledged one, up to
//! `upto_chunk`. The seeder serves at most `window` chunks it has not been paid for.

use nfx_proto::pay::{Ack, Pay, Quote, Rej};

/// The seeder's side of a session (NFX-07 §3). Implementations: the real engine (locked
/// until the M2 security stage) and [`crate::mock::MockSeeder`].
#[allow(async_fn_in_trait)]
pub trait Seeder {
    /// The quote sent after `hello`, binding for the whole session.
    fn quote(&self) -> &Quote;

    /// Whether the next chunk may be served: fewer than `window` delivered chunks are
    /// unpaid, and the session is not banned.
    fn may_serve(&self) -> bool;

    /// A chunk was delivered whole.
    fn delivered(&mut self);

    /// Handle a `pay`, checking in the NFX-07 §3 order: the exact amount, then the mint,
    /// then that the proofs are unspent. `Err` is sent as `rej`. Any refusal leaves the
    /// accounting untouched and the token unclaimed, except `spent`, which also bans the
    /// session. An engine that swaps asynchronously may acknowledge first and ban later;
    /// the loss is bounded by `window`.
    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej>;

    /// Whether the session is banned. A banned session never serves again.
    fn banned(&self) -> bool;
}

/// The viewer's side of a session. Implementations: the real wallet-backed viewer (locked
/// until the M2 security stage) and [`crate::mock::MockViewer`].
#[allow(async_fn_in_trait)]
pub trait Viewer {
    /// Take a quote, or refuse it under this viewer's policy (a price cap, the mints it
    /// holds tokens from).
    fn quote(&mut self, quote: &Quote) -> Result<(), String>;

    /// A chunk arrived whole and verified.
    fn received(&mut self);

    /// The payment due now, if any. It pays only for chunks received, never ahead, and
    /// pays before the unpaid count reaches the window, so the seeder need not stall.
    async fn due(&mut self) -> Result<Option<Pay>, String>;

    /// The seeder's `ack`. An `Err` means the seeder acknowledged something other than
    /// what was paid: the viewer stops paying it.
    fn ack(&mut self, ack: &Ack) -> Result<(), String>;

    /// The payment for every chunk received and not yet paid, when the session ends.
    async fn last_pay(&mut self) -> Result<Option<Pay>, String>;

    /// The seeder's `rej`: the viewer stops paying it.
    fn rej(&mut self, rej: &Rej);

    /// Whether the viewer has stopped paying this seeder.
    fn stopped(&self) -> bool;
}

/// What the adversary suite needs from an engine under test: the mock now, and the real
/// engine with an in-process mint in the M2 security stage.
#[allow(async_fn_in_trait)]
pub trait Harness {
    type Seeder: Seeder;
    type Viewer: Viewer;

    /// A seeder session quoting `price` per chunk and `window`, accepting only this
    /// harness's mint.
    fn seeder(&self, price: u64, window: u64) -> Self::Seeder;

    /// A viewer holding tokens from this harness's mint, paying at most `max_price`.
    fn viewer(&self, max_price: u64) -> Self::Viewer;

    /// A fresh token worth exactly `amount` from this harness's mint.
    async fn token(&self, amount: u64) -> String;

    /// A fresh token worth exactly `amount` from a mint no seeder here quotes.
    async fn foreign_token(&self, amount: u64) -> String;

    /// Whether `token`'s proofs have been claimed (swapped) at their mint.
    async fn claimed(&self, token: &str) -> bool;

    /// Let engines finish their background work (asynchronous swaps and the bans they
    /// cause) before the suite looks at the outcome.
    async fn settle(&self);
}
