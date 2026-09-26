//! The contracts of NFX-07 open-mode payments.
//!
//! **One [`SeederEngine`] is one seeder**: every video it serves, every peer's accounts,
//! its bans and its global cap (NFX-07 §3).
//! - **Accounts.** An account is (peer, video). It numbers that peer's chunks of the video
//!   and outlives its sessions.
//! - **Admission.** Every request for a file of the session's video is admitted, or not,
//!   as one chunk: whole, ranged or aborted alike, counted at admission. A pre-paid chunk
//!   is always served.
//! - **Limits.** Uncovered chunks are admitted only while the account owes fewer than
//!   `window`, and while the unpaid chunks admitted in the last `debt_ttl`, across all
//!   peers and videos, stay under the global cap.
//! - **Payment.** A payment is swapped before it is acknowledged, so an ack is
//!   confirmation and no mint delay widens either bound. Every `pay` is answered within
//!   60 s of its arrival; a swap still unanswered then is abandoned, and settled when its
//!   outcome comes: credited if it claimed the proofs, never banned on.

use std::time::Duration;

use nfx_pay_wire::pay::{Ack, Hello, Pay, Quote, Rej};

/// A payer's identity as the transport gives it (the iroh endpoint id).
pub type PeerId = [u8; 32];

/// A seeder's payment engine. Implementations: the real engine (locked until the M2
/// security stage) and [`crate::mock::MockEngine`].
#[allow(async_fn_in_trait)]
pub trait SeederEngine {
    type Session: SeederSession + Send;

    /// A `hello` from `peer`. The session continues the peer's account for the video, and
    /// its quote carries the account's position. A `hello` creates no account. It waits
    /// while a payment holds the account's turn (each until it is answered, or dropped
    /// before its swap is sent, when it is abandoned unswapped, at most to its own
    /// deadline, 60 s from its arrival, and one arriving meanwhile may take the turn next),
    /// so its quote never misses an acknowledged one; while it waits it counts toward the
    /// peer's session cap. It then reads its account's own unknown swaps, if any, which
    /// adds their time, a swap it abandoned by taking the turn over included. After a wait,
    /// only a read sent after the turn was last freed before it found the turn free serves
    /// it; a turn held to a deadline was freed as that second began, however late the
    /// payment's answer goes out, its swap's outcome comes, or an entry takes the turn
    /// over, and a `hello` that comes after that deadline did not wait (NFX-07 §3).
    ///
    /// Refused with:
    /// - `banned` for a banned peer, whatever else it names (a video not served, an open
    ///   session's id, one past the cap), checked as it arrives, before any wait or read, and
    ///   again as it answers, after its wait and its reads;
    /// - `unknown-video` for a video this seeder does not serve;
    /// - `bad-session` for a session id that is open, on any video, or beyond the per-peer
    ///   cap on open and waiting sessions, counted across all videos.
    ///
    /// A refused `hello` leaves nothing: no account, no place under the cap, and its
    /// session id not open.
    async fn hello(&self, peer: &PeerId, hello: &Hello) -> Result<Self::Session, Rej>;

    /// Learn the outcome of every swap left unknown, every account's, as a seeder's
    /// background task does periodically (NFX-07 §3). An account's own `hello` and `pay`
    /// learn its own; this is what learns the rest, and what completes a swap whose
    /// inputs stayed unspent past `account_ttl`. The suite calls it where that time would
    /// pass, so:
    /// - the engine under test sweeps only when called, never on a timer of its own;
    /// - a sweep that finds another one running returns, or runs alongside it: it never
    ///   waits for it ([`Harness::sweep_during_next_read`] runs one inside another's read).
    async fn sweep(&self);
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
    ///
    /// A refused request counts nowhere and creates no account.
    fn admit(&mut self, sha256: &str) -> bool;

    /// Handle a `pay` (NFX-07 §3), one at a time per account; bans are checked when its
    /// turn comes, a turn it takes over included, before any other check: a banned peer's
    /// payment is refused `banned`, whatever it offers.
    ///
    /// The checks run in this order: structure (`bad-token`), quoted mint (`bad-mint`),
    /// DLEQ (`bad-token`), exact face value (`underpaid`/`overpaid`), then the swap. A
    /// completed swap gives the `ack`. The swap can also end as:
    /// - `spent` or invalid proofs: refused, and the peer is banned;
    /// - an unreachable mint: `mint-unavailable`, which is not a ban.
    ///
    /// A refusal changes no accounting, creates no account and claims nothing.
    ///
    /// Once its checks pass, and just before its swap, it reads its account's own unknown
    /// swaps (NFX-07 §3), and the account's watermark is read again: a payment it no
    /// longer fits (a late outcome moved it) is refused, `stale` or by amount, and nothing
    /// is swapped; while an earlier outcome stays unknown, it is refused `mint-unavailable`.
    ///
    /// **The deadline:** answered within 60 s of its arrival (the transport's receipt, not
    /// this call's), the wait for the account's turn, any key fetch and its own reads
    /// included. A payment whose outcome is known by then is answered with it; otherwise
    /// with `mint-unavailable`, however its checks would have ended, and its swap is
    /// abandoned: no further request is sent for those proofs, and the account is
    /// released. Deadlines count whole seconds, and what comes in the deadline's second
    /// came after it: keys that come then or later are not used, a swap's outcome settled
    /// then is late, and a payment whose swap is not sent by then is not rechecked. Its
    /// turn is freed at the deadline, however late this answer goes out, the swap's
    /// outcome comes, or another entry takes the turn over. A payment that takes a turn
    /// over reads the abandoned swap, as above.
    ///
    /// **Late outcomes:** an abandoned swap is settled when its outcome comes. A claim is
    /// credited (the next quote shows it); a spent or invalid outcome bans nobody.
    ///
    /// **Cancel-safe:** once the swap is sent it completes, and is credited or banned on,
    /// even if this future is dropped (the connection closed). The account's turn is held
    /// until then, or until the deadline. Dropped before its swap is sent, the payment is
    /// abandoned unswapped, and its turn is freed then.
    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej>;

    /// Whether this session's peer is banned.
    fn banned(&self) -> bool;
}

/// The watcher's side, for one seeder and one video: its ledger lasts across sessions.
/// Its **standing** with the seeder is shared with every [`Viewer::sibling`], its ledgers
/// for the seeder's other videos: whether the watcher has stopped paying the seeder,
/// reclaims not yet complete, payments awaiting a quote, the one payment in flight toward
/// the seeder (a payment left unsettled by a closed session included), and the count of
/// `mint-unavailable` answers in a row. Implementations: the real wallet-backed viewer (locked until the M2
/// security stage) and [`crate::mock::MockViewer`]. It keeps time on the harness's clock.
#[allow(async_fn_in_trait)]
pub trait Viewer {
    /// A ledger for another video of the same seeder, sharing this one's standing: one made
    /// after a stop is stopped too. Making it changes nothing in the standing: it restores
    /// no `mint-unavailable` tries.
    fn sibling(&self) -> Self
    where
        Self: Sized;

    /// Start a session on its quote. A quote whose position equals the ledger plus a
    /// payment still unsettled, one awaiting a quote, or one whose reclaim is incomplete,
    /// settles it as accepted (and cancels that reclaim); one equal to the ledger settles
    /// nothing, and leaves such a reclaim incomplete. `Err`,
    /// and the viewer stops, when the quote is not honest about the account:
    /// - it claims more chunks than were requested;
    /// - its `accepted_upto` or `spent_total` is anything else, below the ledger included.
    ///
    /// Also `Err`, without stopping: a price over this viewer's cap, a `window` over its
    /// ceiling or no mint it holds tokens from, by the mint's exact URL (on every session, a
    /// resumed one included), or a session already open: a second quote on it is refused
    /// unread, whatever it claims.
    ///
    /// A quote does not undo a stop: taken or not, it leaves a viewer that has stopped
    /// paying the seeder paying it nothing, on this session and every later one.
    fn quote(&mut self, quote: &Quote) -> Result<(), String>;

    /// The seeder refused this ledger's `hello`, so no session opened. `banned` stops the
    /// viewer; any other code changes nothing. It never touches a payment.
    fn hello_refused(&mut self, rej: &Rej);

    /// A request was sent. It is owed unless the seeder refuses it.
    fn requested(&mut self);

    /// The seeder answered a request with `refuse`. It is not owed, and if it was already
    /// paid for, that payment becomes credit. The next [`Viewer::due`] may pay ahead, up
    /// to half a window less the credit already held.
    fn refused(&mut self);

    /// The payment due now, if any. It covers requested chunks at the quoted price, made
    /// before the unpaid count reaches the window, or pays ahead after a refusal. One is
    /// in flight toward the seeder at a time, across its videos, and none is made:
    /// - once the viewer has stopped, ahead after a refusal included;
    /// - while a reclaim is incomplete or a payment awaits a quote;
    /// - after three `mint-unavailable` answers in a row, until a new session's quote.
    ///
    /// It first finishes incomplete reclaims, and reclaims a payment a closed session left
    /// unsettled once it is 180 s old, whichever of the seeder's videos it was for. It
    /// does so even when the viewer has stopped: reclaiming is not paying.
    async fn due(&mut self) -> Result<Option<Pay>, String>;

    /// The payment for every chunk still owed, when the session ends.
    async fn last_pay(&mut self) -> Result<Option<Pay>, String>;

    /// The seeder's `ack`. `Err`: it is unsolicited, or does not match the payment
    /// (`accepted_upto`, `spent_total`), one at or below the ledger included; the viewer
    /// stops paying this seeder. An ack that matches does not undo a stop.
    fn ack(&mut self, ack: &Ack) -> Result<(), String>;

    /// The seeder's `rej` answering this ledger's payment, sent on this session, whatever
    /// its code: the viewer reclaims the payment's proofs. A `rej` with no such payment is
    /// unsolicited, and the viewer stops paying the seeder. (A `hello`'s refusal goes to
    /// [`Viewer::hello_refused`].)
    /// - If any proof is found spent, the payment **awaits a quote**: nothing more is paid
    ///   to the seeder until a quote shows it accepted ([`Viewer::awaiting_quote`]). A mint
    ///   refuses a swap holding a spent proof whole, so the reclaim checks the proofs'
    ///   states first (NUT-07) and takes back the proofs left, every one unspent (after a
    ///   12003, those not lost to the expiry), in a reclaim of their own. While any of them
    ///   is pending, the reclaim is incomplete, until the mint finishes or rolls back the
    ///   request that reserved it, and the payment awaits a quote once it completes.
    /// - After `mint-unavailable` with every proof reclaimed, it may pay again, unless it
    ///   has stopped: nothing undoes a stop.
    /// - After any other code, it stops.
    ///
    /// A reclaim the mint cannot serve yet blocks every payment until it completes.
    async fn rej(&mut self, rej: &Rej);

    /// No answer has come on this live session to the payment sent on it. Before 180 s
    /// from sending this does nothing. From then, the viewer reclaims the proofs and stops.
    /// A payment an earlier session left unsettled is not this call's.
    async fn timeout(&mut self);

    /// The session ended (its connection closed). The ledger stays, and a payment in
    /// flight stays unsettled, still the standing's one payment in flight. This ledger's
    /// quote settles it if both its fields match. Failing that, any ledger of the standing
    /// reclaims it once it is 180 s old, and proofs found spent leave it awaiting a quote.
    fn end(&mut self);

    /// Whether the viewer pays this seeder nothing: it has stopped, or a payment awaits a
    /// quote.
    fn stopped(&self) -> bool;

    /// Whether paying waits for a new session: this ledger holds a payment whose proofs
    /// were found spent, awaiting a quote that shows it accepted (the watcher opens a new
    /// session for this video), or the standing has used its three `mint-unavailable`
    /// tries (any new session's quote restores them). A quote equal to the ledger leaves a
    /// payment waiting, and the watcher paying nothing. A viewer whose standing has stopped
    /// paying the seeder (not merely awaiting a quote) awaits no quote, whatever it holds:
    /// no new session makes it pay.
    fn awaiting_quote(&self) -> bool;
}

/// What can happen at the mint just before a swap request reaches it
/// ([`Harness::before_next_swap`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MintEvent {
    /// The requests whose client gave up are processed.
    ProcessTimedOut,
    /// The requests whose client gave up start processing: their inputs are reserved
    /// (`PENDING`) until [`Harness::release_swaps`] finishes them.
    ReserveTimedOut,
    /// The mint goes down ([`Harness::mint_outage`] brings it back).
    Down,
    /// Its restores stop answering ([`Harness::restore_outage`] brings them back).
    RestoresDown,
    /// It rotates its keyset, as [`Harness::rotate_keyset`]: after the seeder derived the
    /// request's outputs from the old one, as a seeder with stale keys does.
    RotateKeyset,
    /// The mint's keyset expires (NUT-02 `final_expiry`): every proof issued and every
    /// output set derived so far, the seeder's included, while proofs of older keysets
    /// ([`Harness::fund_older_keyset`]) stay valid. A request spending such a proof, or with
    /// such outputs, is refused (CDK 12003); a request whose inputs the mint had reserved is
    /// refused too, when it signs, if its outputs' keyset has expired; and a restore no
    /// longer shows such outputs.
    ExpireKeyset,
    /// The keyset of the next request's inputs expires: an older one, the payer's, while
    /// the mint's current keyset (the seeder's outputs) does not. A request spending them
    /// is refused (12003), except one whose inputs the mint had already reserved: that one
    /// still signs.
    ExpireInputKeyset,
    /// The mint reserves the next request's inputs, as [`Harness::hold_next_swap_reserving`]
    /// asks, and then their keyset expires (an older one, the payer's): that request still
    /// signs when it is released, while a retry or a reclaim of those inputs is refused
    /// (12003). A mint refuses an already-expired input before reserving it (CDK checks
    /// before it reserves), so this is the only order in which such a request signs.
    ExpireInputKeysetOnceReserved,
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
    pub ban_ttl: Duration,
    /// How many mints it quotes: the harness's own first, then made-up ones.
    pub mints: usize,
    /// One more mint URL to quote, exactly as given.
    pub extra_mint: Option<&'static str>,
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
    /// How many per-identity records `engine` holds: what a flood of free identities costs
    /// it. It counts **every** record the engine keeps for a peer identity or its
    /// accounts: accounts, bans, open and waiting sessions, their ids and their counters,
    /// turns held and their waiters, payments whose swaps are unsettled, the global
    /// count's entries for unpaid chunks, the record of an account's recent reads of its
    /// swaps, and any cache keyed by peer. A count that leaves a kind out hides exactly the
    /// growth the suite looks for.
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

    /// A viewer's ledger for one seeder and video, with a standing of its own (a seeder
    /// not met before). It holds tokens from this harness's mint and pays at most
    /// `max_price`.
    fn viewer(&self, max_price: u64) -> Self::Viewer;
    /// The largest `window` a viewer accepts in a quote: its own ceiling on what one
    /// refusal can make it pay ahead.
    fn window_ceiling(&self) -> u64;

    /// The quoted mint's URL.
    fn mint(&self) -> String;
    /// A fresh token worth exactly `amount` sat from the quoted mint, split into
    /// power-of-two proofs as a real mint issues them. The suite asks for up to 2^53 + 1
    /// sat, so the mint's keyset holds every power of two to 2^53 (a default CDK keyset
    /// stops at 2^31).
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
    /// `token`'s proofs are still unclaimed, in swaps at the mint: whether it got any. As at
    /// a real mint, it takes no proof the mint holds reserved (CDK 11002), lists under an
    /// expired keyset (12003) or refuses as invalid. Its swaps reach the mint and are
    /// processed at once, while the seeder's own are held ([`Harness::hold_swaps`] and the
    /// like hold only the seeder's).
    async fn steal(&self, token: &str) -> bool;
    /// The same for one proof of `token` only (a seeder keeping part of a payment): the
    /// token's first unclaimed proof, in the token's order, in a swap of that proof alone,
    /// processed at once while the seeder's swaps are held. Whether it got it: not if the
    /// mint holds it reserved, lists it expired or refuses it as invalid.
    async fn steal_one(&self, token: &str) -> bool;
    /// A third party sends a request spending `token`'s unclaimed proofs (a melt, say),
    /// which reaches the mint at once, while the seeder's swaps are held, and which the mint
    /// reserves (NUT-07 `PENDING`) and does not finish: any other request of them, a
    /// reclaim included, is refused as pending (CDK 11002) until
    /// [`Harness::roll_back_reserved`] abandons it. Whether it reserved them: a mint refuses
    /// the whole request if any is reserved already, listed expired or invalid.
    async fn reserve_rest(&self, token: &str) -> bool;
    /// Whether anything (keys, a swap) has been fetched from the mint at `url`.
    fn dialled(&self, url: &str) -> bool;

    /// Hold the seeder's swap requests until [`Harness::release_swaps`], on a slow link
    /// between the seeder and the mint: none reaches the mint, and a `pay` waits. Only its
    /// swap requests are held: its reads of swap state (NUT-07, NUT-09) go through, and so
    /// do its key requests unless [`Harness::hold_key_fetches`] holds them. The mint is not
    /// held: a third party's claim ([`Harness::steal`]) and a watcher's reclaim reach it and
    /// are processed at once.
    fn hold_swaps(&self);
    /// The seeder's swap requests reach the mint and are processed at once, but their
    /// responses are held on the link back until [`Harness::release_swaps`]: processed, and
    /// not yet answered.
    fn hold_swap_responses(&self);
    /// Hold only the seeder's next swap request (a black hole for one request, on its link
    /// to the mint), and let the ones after it through at once.
    fn hold_next_swap(&self);
    /// The seeder's key requests go unanswered until [`Harness::release_swaps`], on a slow
    /// link between the seeder and the mint (keys it has already fetched may be cached by
    /// the engine). Its swap requests and its reads of swap state go through, unless
    /// something else holds them.
    fn hold_key_fetches(&self);
    /// Run the oldest held swap, or deliver the oldest held response, and keep holding
    /// the rest.
    async fn release_oldest_swap(&self);
    /// Run the held swaps, deliver the held responses and answer held key requests, in
    /// order, and hold no more.
    async fn release_swaps(&self);
    /// Make the mint unreachable (`true`) or reachable again.
    fn mint_outage(&self, down: bool);
    /// The mint processes the next swap that reaches it (held or not), and its response
    /// is lost on the way back: the seeder sees no answer, though the proofs are now its
    /// own. A retry is answered by the mint as usual, and the swap's outputs can be
    /// restored (NUT-09). A swap sent while the mint is down never reaches it, and loses
    /// nothing.
    fn lose_next_swap_response(&self);
    /// The mint processes a watcher's next reclaim, and its response is lost: the watcher
    /// sees no answer, though it has its proofs back. A retry finds them spent, by the
    /// watcher itself, which a restore of its outputs (NUT-09) shows.
    fn lose_next_reclaim_response(&self);
    /// The mint answers swaps but no restore (`true`), or restores again: its restore
    /// endpoint alone is unreachable.
    fn restore_outage(&self, down: bool);
    /// The seeder's client gives up on its next swap at once, with no answer, while the
    /// request stays queued at the mint: [`Harness::release_swaps`] processes it, and no
    /// answer ever reaches the seeder. Only a read of the swap's state (NUT-07, NUT-09)
    /// can show what happened.
    fn time_out_next_swap(&self);
    /// The mint processes the requests the seeder's client gave up on right after the
    /// next read of a swap's state (a NUT-07 check or a NUT-09 restore): between the
    /// seeder's two reads of that swap.
    fn process_timed_out_mid_read(&self);
    /// The mint delivers the swap responses [`Harness::hold_swap_responses`] held right
    /// after the next read of a swap's state: an answer that lands while the seeder reads.
    fn deliver_responses_mid_read(&self);
    /// The mint answers swaps and restores but no NUT-07 state check (`true`), or checks
    /// again.
    fn state_check_outage(&self, down: bool);
    /// The mint accepts the next swap and reserves its inputs (NUT-07 `PENDING`, as CDK
    /// does before it signs) without finishing it: [`Harness::release_swaps`] finishes
    /// it. Meanwhile any other swap of those proofs, a retry or a reclaim, is refused as
    /// pending (CDK 11002).
    fn hold_next_swap_reserving(&self);
    /// The mint abandons every request that reserved inputs (CDK's recovery at startup):
    /// the inputs are unspent again, those requests are never processed, and a client
    /// still waiting for one gets no answer.
    fn roll_back_reserved(&self);
    /// Reads of swap state the mint has served (NUT-07 checks and NUT-09 restores), one
    /// per request, however many swaps it covers.
    fn state_reads(&self) -> u64;
    /// The mint refuses, at once, a NUT-07 check or a NUT-09 restore that covers more than
    /// `max` proofs or outputs (CDK's `max_inputs` and `max_outputs`: 11014 for a check,
    /// 11015 for a restore), or reads any size again (`None`).
    fn limit_state_reads(&self, max: Option<usize>);
    /// A read the mint leaves unanswered costs its client `wait`, its timeout, on the
    /// harness's clock.
    fn unanswered_reads_take(&self, wait: Duration);
    /// Each read of swap state the mint serves waits, in real time and at most `wait`,
    /// until `n` reads have reached it (`n` 0: none waits): entries on threads then meet
    /// at the mint, as a real engine's can.
    fn gather_state_reads(&self, n: usize, wait: Duration);
    /// The clock moves by `by` between the next swap outcome's arrival and its settlement:
    /// an outcome arriving just before its payment's deadline and settled just after, as on
    /// another thread. Asking moves nothing yet.
    fn advance_during_next_land(&self, by: Duration);
    /// Whether the clock move [`Harness::advance_during_next_land`] asked for has been made
    /// (an outcome settled since). A real engine's harness needs a seam in its settlement to
    /// make it. One that ignores the request, or moves the clock as it is asked, fails the
    /// scenario that asks, rather than passing it untested. One that moves the clock
    /// elsewhere before the outcome arrives (as it releases the swaps, say) cannot be told
    /// from outside: an engine that judges lateness at arrival is caught deterministically
    /// only where the harness makes the move at that seam (the mock's does).
    fn advanced_during_land(&self) -> bool;
    /// An engine that admits in two steps (a check, then a count) has its admissions wait
    /// between the steps, in real time and at most `wait`, until `n` have checked (`n` 0:
    /// none waits): admissions on threads then meet there. An engine that admits in one step
    /// has nowhere to wait, and ignores it. So the catch of a split admission is
    /// deterministic only where the harness reaches the point between the check and the
    /// count (the mock's does); elsewhere the scenario is a stress of threads at once.
    fn gather_admissions(&self, n: usize, wait: Duration);
    /// `engine`'s sweep runs, to its end, during the next read of a swap's state: two
    /// learners at once.
    fn sweep_during_next_read(&self, engine: &Self::Engine);
    /// The mint rotates its active keyset: every output set made so far belongs to the
    /// old one, and a swap to one of them is refused for good (CDK 12002), whatever its
    /// inputs.
    fn rotate_keyset(&self);
    /// The mint's keyset expires now, as [`MintEvent::ExpireKeyset`] does before a swap:
    /// proofs of older keysets ([`Harness::fund_older_keyset`]) stay valid.
    fn expire_keyset(&self);
    /// The mint's active keyset lists a `final_expiry` (NUT-02) `after` from now, or none.
    fn keyset_expires_in(&self, after: Option<Duration>);
    /// The mint's active keyset expires, and stays active (CDK does not rotate an expired
    /// keyset): outputs derived from it, and every proof it issued since the last rotation
    /// (those a wallet already holds included), are refused (12003), while proofs of older
    /// keysets stay valid, until [`Harness::rotate_keyset`].
    fn expire_active_keyset(&self);
    /// The watchers' wallets hold `amount` sat (0: none) in proofs of an older keyset than
    /// the active one, which a wallet spends first (CDK selects an inactive keyset's proofs
    /// first): their next payments draw on them. After [`Harness::expire_older_keyset`], the
    /// proofs are of another older keyset, not expired.
    fn fund_older_keyset(&self, amount: u64);
    /// The older keyset of [`Harness::fund_older_keyset`] reaches its own `final_expiry`
    /// (NUT-02), while the mint's active keyset stays current: every proof of it, those the
    /// wallets still hold included, is refused (12003) and listed expired.
    fn expire_older_keyset(&self);
    /// The keyset of the first `proofs` of `token`'s proofs expires: an older keyset, whose
    /// proofs a wallet spends first, while the rest of the token's are of one that stays
    /// good. Any other proof of the expired keyset expires with them, those the wallets
    /// still hold included.
    fn expire_keyset_of(&self, token: &str, proofs: usize);
    /// `event` happens at the mint just before the next swap request reaches it: a
    /// seeder's first attempt, retry or completion alike. Several happen in the order
    /// given.
    fn before_next_swap(&self, event: MintEvent);
    /// The harness's clock, in whole seconds.
    fn clock_secs(&self) -> u64;

    /// Move the clock the seeder and the viewers keep forward.
    fn advance(&self, by: Duration);
    /// How long an unpaid chunk counts toward the global cap.
    fn debt_ttl(&self) -> Duration;
    /// How long a never-paid account with no open session is kept.
    fn account_ttl(&self) -> Duration;
    /// How long a ban lasts.
    fn ban_ttl(&self) -> Duration;
}
