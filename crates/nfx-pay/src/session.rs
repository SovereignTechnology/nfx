//! The contracts of NFX-07 open-mode payments.
//!
//! **One [`SeederEngine`] is one seeder**: one long-term identity, whatever endpoints it
//! announces, with every video it serves, every peer's accounts, its bans and its global
//! cap (NFX-07 §3).
//! - **Accounts.** An account is (peer, video). It numbers that peer's chunks of the video
//!   and outlives its sessions.
//! - **Admission.** Every request for a file of the session's video is admitted, or not,
//!   as one chunk: whole, ranged or aborted alike, counted at admission. A pre-paid chunk
//!   of a video the seeder serves is always served; one it no longer serves admits nothing.
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
///
/// The futures of [`SeederEngine::hello`], [`SeederEngine::sweep`] and
/// [`SeederSession::pay`] are `Send`: a connection's handler runs each on a task of a
/// runtime that may move it between threads, and the suite runs entries on tasks of their
/// own ([`Harness`]: how the suite waits). So such a future holds nothing bound to one
/// thread across a wait: no `Rc`, no borrow of a `RefCell`, no guard of a lock.
pub trait SeederEngine {
    /// A session owns what it needs: the suite may move one to a thread or a task of its
    /// own. So it borrows nothing from its engine, nor from anything else outside itself:
    /// what it shares with the engine it holds a handle to (an `Arc`, a channel).
    type Session: SeederSession + Send + 'static;

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
    /// - `unknown-video` for a video this seeder does not serve. A video it no longer serves
    ///   is answered as before for a peer it keeps an account for there, or a swap of one
    ///   whose outcome is unknown, an answer lost or a swap abandoned in flight alike: its
    ///   wait for a payment in progress (a dead turn taken over included), its reads after it,
    ///   its ban and session id checked as it arrives
    ///   and again as it answers (the ban as it then stands), and the cap, waiting hellos
    ///   counted, as ever; its session's payments verified as any others, and nothing of the
    ///   video admitted, pre-paid chunks included. So a payment there awaiting a quote is
    ///   still settled. Any other peer is refused `unknown-video`. This is judged as the
    ///   `hello` arrives, by what the seeder keeps then: one it answers stays answered
    ///   whatever its reads learn (a peer whose only record there was an unknown swap, learnt
    ///   as nothing, is quoted zeros, and its next `hello` is refused), and one it refuses
    ///   creates nothing. A peer with no account there whose first payment there is still in
    ///   progress has no account yet, and no unknown swap: it is refused `unknown-video`
    ///   while that payment holds its turn. From the payment's deadline its swap, still in
    ///   flight, is a swap whose outcome is unknown, and its `hello` is answered as above;
    ///   once the swap lands as a claim it has an account;
    /// - `bad-session` for a session id that is open, on any video, or beyond the per-peer
    ///   cap on open and waiting sessions, counted across all videos.
    ///
    /// A refused `hello` leaves nothing: no account, no place under the cap, and its
    /// session id not open.
    fn hello(
        &self,
        peer: &PeerId,
        hello: &Hello,
    ) -> impl Future<Output = Result<Self::Session, Rej>> + Send;

    /// Learn the outcome of every swap left unknown, every account's, as a seeder's
    /// background task does periodically (NFX-07 §3). An account's own `hello` and `pay`
    /// learn its own; this is what learns the rest, and what completes a swap whose
    /// inputs stayed unspent past `account_ttl`. The suite calls it where that time would
    /// pass, so:
    /// - the engine under test sweeps only when called, never on a timer of its own;
    /// - a sweep that finds another one running returns, or runs alongside it: it never
    ///   waits for it ([`Harness::sweep_during_next_read`] runs one inside another's read).
    fn sweep(&self) -> impl Future<Output = ()> + Send;
}

/// One open session: one peer, one video. **Dropping it closes it.**
pub trait SeederSession {
    /// The binding quote, with the account's position as of the `hello`.
    fn quote(&self) -> &Quote;

    /// Admit one request for the file `sha256`, counting it at once, whole, ranged or
    /// aborted alike. `false` means answer it with `refuse` and serve not one byte.
    /// That happens when:
    /// - the peer is banned;
    /// - the file is not this video's, or the seeder no longer serves this video, pre-paid
    ///   or not, on a session that was open when it stopped serving it as on one opened
    ///   since (either still has its payments verified as any others);
    /// - the chunk is not pre-paid and the account's window or the global cap is full.
    ///
    /// A refused request counts nowhere and creates no account.
    fn admit(&mut self, sha256: &str) -> bool;

    /// Handle a `pay` (NFX-07 §3), one at a time per account; bans are checked when its
    /// turn comes, a turn it takes over included, before any other check: a banned peer's
    /// payment is refused `banned`, whatever it offers.
    ///
    /// The checks run in this order: structure (`bad-token`), quoted mint (`bad-mint`),
    /// DLEQ (`bad-token`), exact face value (`underpaid`/`overpaid`), then the swap. An
    /// exact payment that would take the account's `spent_total` above 2^53-1 is
    /// `overpaid`: no `ack` or quote could carry it. A completed swap gives the `ack`,
    /// whether or not the peer has been banned since the payment's turn came. The swap can
    /// also end as:
    /// - `spent` or invalid proofs: refused, and the peer is banned;
    /// - an unreachable mint: `mint-unavailable`, which is not a ban.
    ///
    /// A refusal changes no accounting, creates no account and claims nothing. The one
    /// exception is a swap answered `mint-unavailable` that still lands: it is credited
    /// late (below), and creates the account if there was none.
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
    /// came after it: a payment whose turn comes then or later, or has not come by then,
    /// another payment holding it, runs none of its checks, the ban's included, asks the
    /// mint for nothing (keys and keyset listing alike) and sends no read; no payment asks
    /// the mint for keys or a keyset listing at or past its deadline, judged at every look;
    /// keys or a keyset listing that come then or later, or the mint's refusal of the keys,
    /// are not used, a swap's outcome settled then is late, and a payment whose swap is not
    /// sent by then is not rechecked. Its turn is freed at the deadline,
    /// however late this answer goes out, the swap's outcome comes, or another entry takes
    /// the turn over. A payment that takes a turn over reads the abandoned swap, as above.
    ///
    /// **Late outcomes:** an abandoned swap is settled when its outcome comes. A claim is
    /// credited (the next quote shows it), creating the account if there was none; a spent
    /// or invalid outcome bans nobody, and creates nothing.
    ///
    /// **Cancel-safe:** once the swap is sent it completes, and is credited or banned on,
    /// even if this future is dropped (the connection closed). The account's turn is held
    /// until then, or until the deadline. Dropped before its swap is sent, the payment is
    /// abandoned unswapped: its turn is freed then, and it creates no account. Nor is the
    /// outcome tied to this future's polls: the engine settles it as it comes back, whether
    /// or not this future is polled then, and one settled in time is the answer, however
    /// late this future is polled again.
    fn pay(&mut self, pay: &Pay) -> impl Future<Output = Result<Ack, Rej>> + Send;

    /// Whether this session's peer is banned.
    fn banned(&self) -> bool;
}

/// The watcher's side, for one seeder and one video: its ledger lasts across sessions.
/// Its **standing** with the seeder is shared with every [`Viewer::sibling`], its ledgers
/// for the seeder's other videos: whether the watcher has stopped paying the seeder,
/// reclaims not yet complete, payments awaiting a quote, the one payment in flight toward
/// the seeder (a payment left unsettled by a closed session included), and the count of
/// `mint-unavailable` answers in a row. A seeder is its long-term identity, never a
/// transport identity where it announces a long-term one (NFX-07 §3, §3a): the ledger lasts
/// as long as the watcher's own identity toward it, which the watcher keeps while a payment
/// of the ledger is not yet settled, and the standing as long as the wallet the watcher pays
/// from, so a lying seeder takes one payment per seeder identity the watcher pays.
/// Implementations: the real wallet-backed viewer (locked until the M2 security stage) and
/// [`crate::mock::MockViewer`]. It keeps time on the harness's clock.
#[allow(async_fn_in_trait)]
pub trait Viewer {
    /// A ledger for another video of the same seeder, sharing this one's standing: one made
    /// after a stop is stopped too. Making it changes nothing in the standing: it restores
    /// no `mint-unavailable` tries, undoes no stop, and leaves the payment in flight, a
    /// payment awaiting a quote and an incomplete reclaim as they were.
    fn sibling(&self) -> Self
    where
        Self: Sized;

    /// Start a session on its quote. A quote whose position equals the ledger plus a
    /// payment still unsettled, one awaiting a quote, or one whose reclaim is incomplete,
    /// settles it as accepted (and cancels that reclaim); one equal to the ledger settles
    /// nothing, and leaves such a reclaim incomplete. `Err`, and the viewer stops, when the
    /// quote is not honest about the account:
    /// - it claims more chunks than were requested of its video and not refused, whatever
    ///   the viewer paid for: credit it holds, or a payment the quote settles; nothing a
    ///   ledger for another of the seeder's videos holds counts;
    /// - its `accepted_upto` or `spent_total` is anything else, below the ledger included.
    ///
    /// Also `Err`, without stopping: a price over this viewer's cap, a `window` over its
    /// ceiling or no mint it holds tokens from, by the mint's exact URL (on every session, a
    /// resumed one included), or a session already open: a second quote on it is refused
    /// unread, whatever it claims, its price and `window` included. A quote refused so is not
    /// taken, and settles nothing: the payment in flight, a payment awaiting a quote and an
    /// incomplete reclaim stay as they were, and so do the `mint-unavailable` tries, none
    /// used and none restored. Taken, refused or dishonest, a quote settles nothing of the
    /// seeder's other videos, even one showing their payment in both fields: their payments
    /// stay as they were.
    ///
    /// A quote does not undo a stop: taken or not, it leaves a viewer that has stopped
    /// paying the seeder paying it nothing, on this session and every later one. One that
    /// settles a payment, left unsettled, awaiting a quote or being reclaimed, settles it
    /// into the ledger only, whenever the stop came: before its proofs were found spent, as
    /// they were, or after.
    fn quote(&mut self, quote: &Quote) -> Result<(), String>;

    /// The seeder refused this ledger's `hello`, so no session opened. `banned` stops the
    /// viewer; any other code, known or not, `mint-unavailable` included, changes nothing:
    /// it uses no `mint-unavailable` try. It never touches a payment: one in flight on this
    /// ledger's live session keeps its place and its 180 s from sending, `banned` or not.
    fn hello_refused(&mut self, rej: &Rej);

    /// A request was sent. It is owed unless the seeder refuses it. It leaves the payment in
    /// flight as it was, its place and its 180 s from sending included, and a stop and a
    /// refusal's licence to pay ahead as they were: it is no decision of what to pay.
    fn requested(&mut self);

    /// The seeder answered a request with `refuse`. It is not owed, and if it was already
    /// paid for, that payment becomes credit. It licenses the next [`Viewer::due`] on this
    /// ledger, and no other call, to pay ahead half a window, rounded down, less the credit
    /// already held, that much and not merely at most: that `due` uses the licence and ends
    /// it, whether or not it pays, and so does [`Viewer::end`]; [`Viewer::last_pay`] neither
    /// uses nor ends it, nor does anything else that comes before that `due` (a request
    /// sent, the answer to a payment in flight, a second quote, a refused `hello`, a timeout
    /// before a payment's 180 s or with no payment on the session, or anything on another
    /// video's ledger), and it
    /// licenses nothing on a ledger for another video. It settles nothing: the payment in flight, a
    /// payment awaiting a quote, an incomplete reclaim and a stop stay as they were.
    fn refused(&mut self);

    /// The payment due now, if any. It covers requested chunks at the quoted price (the open
    /// session's quote's, whatever an earlier session's or another video's was and whatever
    /// the viewer's own cap: so for every payment, ahead after a refusal and at a session's
    /// end included, on whichever ledger and whatever came before), made
    /// once the unpaid count reaches half the open session's quoted window (whatever an
    /// earlier session's or another video's was), rounded up, so a
    /// payment in flight never stalls the seeder, or pays ahead after a refusal half the
    /// window, rounded down, less the credit the ledger holds: what another video's ledger
    /// owes or holds counts for nothing. It pays ahead only as the first `due` after a
    /// refusal on this ledger's open session ([`Viewer::refused`]): if this call pays
    /// nothing, for whichever reason below or because nothing is payable, the refusal
    /// licenses nothing later. Its token, as [`Viewer::last_pay`]'s, meets the seeder's
    /// structure check (NFX-07 §3 step 1): of one mint, a quoted one by its exact URL, in
    /// `sat`, of at most 64 proofs, none locked (open mode), each with its DLEQ proof. A
    /// selection that would hold more than 64 proofs is swapped to fewer first. The due
    /// point, the pay-ahead and the token hold so for every payment, on whichever of the
    /// seeder's ledgers, and whatever came before it, on that ledger or on another of the
    /// seeder's: an ack, a `mint-unavailable` answer, a reclaim (of a refused payment, or of
    /// one a closed session left, by its own ledger or another video's, in a session or not;
    /// its proofs back at once, late, or less those lost to the expiry), a quote that settled
    /// a payment, a resumed session, credit held or chunks owed, a quote or a `hello`
    /// refused, its tries used and restored, or another video's payment in flight ahead of
    /// it. A payment's 180 s count from its own sending (NFX-07 §3a), whatever it is and
    /// wherever they are counted. One is in flight toward the seeder at a time, across its
    /// videos, and none is made:
    /// - once the viewer has stopped, ahead after a refusal included;
    /// - while a reclaim is incomplete or a payment awaits a quote;
    /// - after three `mint-unavailable` answers to its payments in a row, until a new
    ///   session's accepted quote. Each such answer uses a try, however its payment was
    ///   made (due, ahead, or at a session's end) and however its reclaim ends (every proof
    ///   back, at once or late, or lost to the expiry, every one of them or some and the
    ///   rest taken back). Nothing else uses a try: not a reclaim, retried while the
    ///   mint is down or not, a closed session's payment reclaimed with every proof back or
    ///   lost to the expiry, a refused `hello` or quote, a session's end, nor a timeout. Only
    ///   an ack or a new session's accepted quote restores them, and each restores them
    ///   all: on whichever of the seeder's videos it comes, however many were used, and
    ///   whether or not the quote settles a payment.
    ///
    /// It first finishes incomplete reclaims, and reclaims a payment a closed session left
    /// unsettled once it is 180 s old, whichever of the seeder's videos it was for. It
    /// does so even when the viewer has stopped, and when it holds no session's quote
    /// (between sessions, or its `hello` or quote refused), and when out of its
    /// `mint-unavailable` tries: reclaiming is not paying. A reclaim done with no session,
    /// or from another video's ledger, ends as one done in a session on the payment's own:
    /// proofs found spent (after a restore of its own outputs) leave the payment awaiting a
    /// quote on its own ledger, a mint that cannot serve it yet or a proof pending leaves it
    /// incomplete, and with every proof back or lost to the expiry the viewer pays again at
    /// its next session. A closed session's payment is reclaimed 180 s after it was sent,
    /// whatever came since, and not before, whichever ledger catches it up, one made since
    /// included, with a session or not, and whatever stopped the viewer. A payment an ack
    /// that does not match refused ([`Viewer::ack`]) is reclaimed here as an incomplete
    /// reclaim is finished, with no wait.
    async fn due(&mut self) -> Result<Option<Pay>, String>;

    /// The payment for every chunk still owed, when the session ends. It pays nothing ahead,
    /// and leaves a refusal's licence to the [`Viewer::due`] that follows it. It first
    /// catches up as `due` does: it finishes incomplete reclaims, and reclaims a closed
    /// session's payment 180 s after it was sent, and not before.
    async fn last_pay(&mut self) -> Result<Option<Pay>, String>;

    /// The seeder's `ack`. `Err`: it is unsolicited, or does not match the payment
    /// (`accepted_upto`, `spent_total`), one at or below the ledger included; the viewer
    /// stops paying this seeder. An ack settles only the payment sent on its session: an
    /// unsolicited one settles nothing, even one showing another video's payment in both
    /// fields. An ack that matches does not undo a stop: it settles its payment into the
    /// ledger, stopped or not, and nothing more. Nor does it end a refusal's licence
    /// ([`Viewer::refused`]).
    ///
    /// A payment answered by an ack that does not match is a refused payment (NFX-07 §3a):
    /// the viewer reclaims its proofs as any refused payment's, with no 180 s wait. This
    /// call does not reach the mint: it holds the payment as one whose reclaim is still to
    /// run, and the calls that finish an incomplete reclaim run it ([`Viewer::due`],
    /// [`Viewer::last_pay`], from whichever of the seeder's ledgers, with a session or not).
    /// Proofs it finds spent leave the payment to a quote that shows it, which settles it
    /// into the ledger only: the viewer has stopped. An unsolicited ack answers no payment,
    /// and reclaims nothing.
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
    /// - After any other code, known or not, one pay/1 sends only for a `hello` or another
    ///   spec's included, it stops. Proofs its reclaim finds spent then wait for a quote
    ///   that shows the payment, which settles it into the ledger only: the viewer stays
    ///   stopped, and awaits no quote.
    ///
    /// A reclaim the mint cannot serve yet blocks every payment until it completes.
    async fn rej(&mut self, rej: &Rej);

    /// No answer has come on this live session to the payment sent on it. Before 180 s
    /// from sending this does nothing, whatever came since and whether or not the viewer has
    /// stopped: it reclaims nothing, frees no slot, and uses or restores no try. From then,
    /// the viewer reclaims the proofs and stops; a reclaim the mint cannot serve yet is
    /// incomplete, and finished later. Proofs the reclaim finds spent leave the payment to a
    /// quote that shows it, which settles it into the ledger only: the viewer stays stopped,
    /// and awaits no quote. With no payment on the session it changes nothing. A
    /// payment an earlier session left unsettled is not this call's. Nor does it undo a
    /// stop, or end a refusal's licence to pay ahead ([`Viewer::refused`]), before the 180 s
    /// or with no payment on the session.
    async fn timeout(&mut self);

    /// The session ended (its connection closed). A refusal's licence to pay ahead ends
    /// with it. The ledger stays, and a payment in flight stays unsettled, still the
    /// standing's one payment in flight. This ledger's quote settles it if both its fields
    /// match. Failing that, any ledger of the standing reclaims it once it is 180 s old, and
    /// proofs found spent leave it awaiting a quote.
    fn end(&mut self);

    /// Whether the viewer pays this seeder nothing: it has stopped, or a payment awaits a
    /// quote.
    fn stopped(&self) -> bool;

    /// Whether paying waits for a new session: this ledger holds a payment whose proofs
    /// were found spent, awaiting a quote that shows it accepted (the watcher opens a new
    /// session for this video), or the standing has used its three `mint-unavailable`
    /// tries (any new session's accepted quote restores them). A quote equal to the ledger
    /// leaves a payment waiting, and the watcher paying nothing. A viewer whose standing has
    /// stopped paying the seeder (not merely awaiting a quote) awaits no quote, whatever it
    /// holds: no new session makes it pay. A stop holds whatever the viewer waits on when it
    /// comes, a payment awaiting a quote included.
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
    /// An invalid DLEQ proof, on proofs drawn as a wallet selects them: those of an older
    /// keyset it holds first ([`Harness::fund_older_keyset`]).
    OlderBadDleq,
    /// Not a token at all.
    Garbage,
    /// More than 64 proofs (input fees grow with the proof count).
    TooManyProofs,
    /// Well formed, with valid DLEQs, but the mint refuses its proofs as invalid at the
    /// swap. This one also bans the peer.
    Forged,
    /// Well formed, its proofs naming a keyset the mint never had, a fresh one at each call:
    /// the mint does not list it (NUT-02), and answers a request for its keys 12001.
    UnknownKeyset,
    /// Well formed, naming this harness's mint, its proofs of the keyset another mint alone
    /// started last ([`Harness::start_keyset_at`]), whose keys that mint serves: this
    /// harness's mint does not list it (NUT-02), and answers a request for its keys 12001.
    /// Asked for only after such a start.
    OtherMintsKeyset,
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
///
/// **How the suite waits.** It judges an engine's progress by the answers its calls await
/// and by the engine settling, never by a single poll or turn of the runtime. It drives
/// the engine's futures on the runtime its test runs it in, polled with their task's waker,
/// and yields to that runtime between polls, so that tasks the engine spawns or wakes run
/// too; it never blocks that runtime's thread while it waits for the engine. An engine
/// moves only on its calls' answers, on the harness's clock and on the suite's own calls: no
/// timer of its own in real time moves it. [`Harness::answers_under_way`] says whether an
/// answer the engine awaits is still on its way, and the suite waits, in real time, while
/// one is. The engine has settled once no answer is under way and its futures and tasks
/// have had 100 turns of the runtime since: what an engine does between an answer and its
/// next wait, on its own tasks and in the polls its answers wake, takes fewer turns than
/// that. A turn is over once every task the runtime had ready as it began has run, however
/// many they are, not once the suite's task is polled again: a runtime may poll it again
/// with tasks still ready (tokio's current-thread runtime does after 61), so the suite
/// queues a task of its own as a turn begins, and the turn ends as that task runs: the
/// runtime a runner gives the suite takes up its ready tasks in the order they became
/// ready, as that one does. A turn is not ended on real time, so no thread of an engine's
/// or a harness's keeps making tasks of that runtime ready without pause: a thread wakes a
/// task as an answer comes, and while several woke or started tasks with no pause at all a
/// turn would not end, and the run would be timed out as hung. So:
/// - it waits for an answer, or checks that a future still waits, by polling it until it is
///   ready, or until the engine has settled with the future pending, which then waits on
///   the suite (a clock move, a release, another entry). It lets a future it drives beside
///   its own steps reach its wait the same way;
/// - it leaves an entry with a read out by polling it until a read it sent has reached the
///   mint and its answer is not yet taken ([`Harness::reads_out`]), however many polls that
///   takes; where the mint answers a read in the poll that sends it, no read is ever out.
///   It closes an entry's connection once the entry waits on the suite (its swap held, say);
/// - after a release ([`Harness::release_swaps`], [`Harness::release_oldest_swap`],
///   [`Harness::roll_back_reserved`]), after a clock move, and after it closes a connection
///   (it drops a session, or a `hello` or a `pay` not yet answered) it lets the engine
///   settle before it acts again, the entries it polls on its own task not polled
///   meanwhile: an engine may take any of these on a task of its own, and stamp a close
///   with the time it takes it. Some scenarios do otherwise. A few move the clock and go
///   on with an entry at once, with no settling first: the suite then waits for the answer
///   of an entry on a task of its own that the move wakes, or polls a payment it drives
///   (at that payment's own deadline, `hello`s waiting behind it; or before the runtime
///   polls a payment on a task of its own that the same move wakes, so that the one it
///   drives takes a dead turn over first). That last poll sets the order only against an
///   engine whose entry, polled, judges a turn's deadline by the clock as it then stands,
///   as the mock's does: where an engine takes the clock on a task of its own, the payment
///   on the task may take the turn first, and the case then shows no payment woken at its
///   deadline behind one that arrived after it. And a connection a scenario lets go out
///   of scope (a session opened for its quote alone, say, or an entry not yet answered,
///   left with a read out) closes there, the suite going on to its next step at once. So
///   an engine that takes a clock move or a close on a task of its own may be polled
///   before that task has run;
/// - it reads what the engine holds ([`Harness::identities_held`]) and a session's ban only
///   once the engine has settled since the suite last acted, an answer it took and a
///   connection that closed as a session went out of scope included.
///
/// An engine settles a swap's outcome as it comes, on whatever task or thread takes it (a
/// task of its own, say), whether or not the entry that sent the swap is polled: the swap
/// is not tied to the `pay`'s connection (NFX-07 §3 step 5). An entry (a `hello` or a
/// `pay`) awaits its own reads, key requests and keyset listings, and takes an answer that
/// has woken it in a later poll: between its polls it sends its mint nothing more, so the
/// suite sets the order of the steps of two entries it polls on its own task by the order
/// it polls them in. It may reach the engine through tasks of the engine's own first, and
/// its answer and its wakes may come back through them. What an entry decides with no call
/// under way (a refusal as it arrives, say) it answers once it has decided it.
///
/// **An entry on a task of its own** is a task of the runtime the suite runs in, which that
/// runtime polls when it is woken, in turn with the engine's own tasks; the suite never
/// polls it. So whatever an entry awaits wakes it once the entry can see it: a wake that
/// comes before, with none after, leaves the entry waiting, and the suite fails it. This is
/// what the `Send` futures of [`SeederEngine`] and the `Clone` of [`Harness::Engine`] are
/// for: the task owns the session or a clone of the engine, and gives the session back.
///
/// **An entry on a thread of its own.** Scenarios whose entries meet at the mint drive each
/// on a thread the harness starts as the engine needs ([`Harness::spawn_thread`]), with an
/// executor of the suite's that polls it when it is woken, while the suite's thread goes on
/// with its runtime running, the engine's own tasks included. Turns of that runtime say
/// nothing of how far a thread has got: a thread starts, and takes up a wake, when the
/// operating system runs it. So the suite takes such an entry to wait on it only once, with
/// no answer under way, the entry has stood pending, not woken since its last poll began
/// and not polled, through 100 turns of the suite's runtime in a row: what such an entry
/// still awaits of the engine's own tasks on that runtime (a task it reaches the engine
/// through, one that passes a wake on to it) wakes it within fewer turns than that of its
/// beginning to wait, each such task running in a turn after it is spawned or woken. An
/// entry that waits by polling again (it wakes itself, and looks) waits on the suite too,
/// once it has been polled 100 times more with no answer under way, and is pending still.
/// The suite does not wait for its own runtime to take a turn between each two of those
/// polls: what an entry on a thread awaits of a task of the engine's own on the suite's
/// runtime, it awaits by that task's wake, not by polling for it. A panic raised on such a
/// thread, in the engine's code that the entry runs there, the suite keeps, and raises
/// again on its own thread at the next turn of a wait, so that it is the scenario's before
/// a check fails for want of what the entry was to do. An entry the suite leaves behind
/// there, a check having failed, it polls no more, and drops.
///
/// It waits 5 s in real time at most for an engine to settle, far above any honest answer,
/// and a scenario that hangs is timed out by its runner. That limit
/// ([`crate::adversary::SCENARIO_SECS`]) also ends a scenario whose mint is slow: the
/// longest awaits about 1,400 answers one after another, and with an honest engine whose
/// every answer took 250 ms it was ended there, at no check. So the harness's mint must
/// answer within about ten milliseconds, and a harness whose in-process mint is slower than
/// that in an unoptimised build must build the mint optimised.
/// A release that races the clock runs
/// on threads of the harness's own ([`Harness::race_release_with_clock`]) while the suite
/// polls the racing entry on its task. The mint answers from threads of the harness's own,
/// never from tasks on the suite's runtime. A panic raised on such a thread (in the
/// engine's code that takes an answer there, say) is the harness's to keep, and to raise
/// again on the suite's thread ([`crate::adversary::keep_panic`],
/// [`crate::adversary::rejoin`]): the suite's runner judges a panic by where it was first
/// raised, and one lost there would leave a check of the suite's to fail in its stead. An
/// engine may spawn tasks on the runtime it was made in (the suite makes each engine on its
/// own task), never on whatever thread polls its futures.
///
/// **The panic hook.** The runner notes the first panic raised on a scenario's thread with
/// a panic hook of its own, set over the hook that stood and handing every panic on to it
/// ([`crate::adversary::run_on_a_thread`]). So a harness and its engine leave the process's
/// panic hook as it is: neither replaces it (`std::panic::set_hook`,
/// `std::panic::take_hook`), as it is made or while a scenario runs, and no test does in a
/// binary that runs the suite. A harness may set a hook of its own over the runner's (an
/// error report, say) only if that hook hands every panic on to the one it found, and only
/// while no other scenario runs in the process: to set it is to take the hook that stood
/// and then set the new one, and between the two the default hook stands. A scenario on
/// another thread is reported as not judged if one of the runner's looks falls there, and a
/// panic raised on it there goes unnoted; a second harness that takes the hook there finds
/// the default one, and its own, set last, leaves the runner's out for good. So a harness
/// made in a scenario's body sets none where a binary's scenarios run several at once. The
/// runner looks before a scenario and after it, and reports a run under a hook that did not
/// stand as not finished, whatever the scenario did. It cannot see a hook replaced and put
/// back while a scenario ran, nor one that hands on some panics and not others: a harness
/// does neither. And the rule is the scenario's thread's: what an engine runs on tasks of
/// the runtime it was made in is polled there, the runner's runtime being a current-thread
/// one, and what a harness runs on threads of its own it keeps, as above.
#[allow(async_fn_in_trait)]
pub trait Harness {
    /// An engine owns what it needs, and is a handle to its seeder: the suite shares one
    /// with a thread of its own, and gives a clone of it, the same seeder, to a task of its
    /// own. So it borrows nothing from the harness that made it, nor from anything else
    /// outside itself; an engine that is no such handle is wrapped in one (an `Arc`).
    type Engine: SeederEngine + Clone + Send + Sync + 'static;
    type Viewer: Viewer;

    /// A seeder serving three videos (0, 1 and 2) at `price`, quoting `window` (≥ 2) and this
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
    /// A `hello` for video `v` (0, 1 or 2), under a fresh session id.
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
    /// `engine` stops serving video `v` (0, 1 or 2), as a seeder that drops a video does: it no
    /// longer serves the video's files, and keeps its accounts there (NFX-07 §3). A real
    /// engine's harness restarts it without the video, its state kept.
    fn drop_video(&self, engine: &Self::Engine, v: u8);

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
    /// The same naming the mint at `url`, quoted or not, as this harness's mint is named
    /// otherwise: its second mint, for [`BadToken::TwoMints`], is another again, and
    /// [`BadToken::OtherMintsKeyset`]'s keyset is one a mint other than `url` alone started
    /// last.
    async fn bad_token_at(&self, url: &str, kind: BadToken, amount: u64) -> String;
    /// The same proofs as `token` in a different string.
    async fn reencode(&self, token: &str) -> String;
    /// One token holding all the tokens' proofs, in the order given, each as it was: a
    /// proof that is locked, lacks a DLEQ proof, has an invalid one or names a keyset the
    /// mint never had stays so.
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
    /// link between the seeder and the mint: its asks for keys and for the mint's keyset
    /// listing alike. An engine uses the keys it holds without asking (NFX-07 §3 step 3
    /// caches them), and may hold keys from its start or from any fetch, for the payment's
    /// mint or for all it quotes: the suite holds keys only after
    /// [`Harness::forget_keys`]. So with key requests held, a payment waits on the mint
    /// wherever it must ask for the mint's keyset listing, every key it needs held or not:
    /// for a keyset the listing the engine holds does not name, the listing asked for
    /// before the payment arrived, or for the keyset rule (step 5), no listing of that mint
    /// asked for in the payment's turn's second or later. Its swap requests and its reads
    /// of swap state go through, unless something else holds them.
    fn hold_key_fetches(&self);
    /// The mint at `url` answers every request for a keyset's keys 12001, a keyset it does
    /// not know (`true`), while its keyset listing (NUT-02) names its keysets as before; or
    /// serves keys again (`false`). It stands for a mint that lists a keyset whose keys it
    /// no longer serves: one that lost them, or whose listing a cache in front of it
    /// outlived. A real mint's harness answers the mint's keys endpoint so. A seeder refuses
    /// a payment whose keys it is so refused `bad-token`, without a ban, and keeps nothing of
    /// the answer: it asks again for the next payment that names the keyset (NFX-07 §3 step
    /// 3).
    fn refuse_keys(&self, url: &str, refused: bool);
    /// `engine` drops the mint keys it holds, however it came by them (at its start, or by
    /// any fetch), and nothing else: its next payment at a mint fetches that mint's keys
    /// again, or waits for a request for them still unanswered. A real engine's harness
    /// needs a seam in its key cache to make it. One that ignores the request fails the
    /// scenarios that ask, at their checks that a payment asks for its keys, rather than
    /// passing them untested.
    fn forget_keys(&self, engine: &Self::Engine);
    /// Run the oldest held swap, or deliver the oldest held response, and keep holding
    /// the rest. Its answer may come back after this returns, as from a real mint: it is
    /// under way until then ([`Harness::answers_under_way`]).
    async fn release_oldest_swap(&self);
    /// Run the held swaps, deliver the held responses and answer held key requests, in
    /// order, and hold no more. Their answers may come back after this returns, as from a
    /// real mint: each is under way until then ([`Harness::answers_under_way`]).
    async fn release_swaps(&self);
    /// Release the held swaps, responses and key requests, as [`Harness::release_swaps`]
    /// does, on a thread of the harness's own while another moves the clock by `by`, as
    /// [`Harness::advance`] does, the two at once, and return without waiting for them: each
    /// is under way ([`Harness::answers_under_way`]) until it is done and the answers it
    /// released have come back. The suite meanwhile polls the entry whose outcome races its
    /// deadline on its own task, its runtime running.
    ///
    /// The suite races a hundred payments so, and each race may come out either way: the
    /// outcome settled before the clock reaches the deadline, or after. Both are right, so
    /// the suite requires neither of any race, and counts none. For both to come about, a
    /// harness varies from call to call which of the two starts first and by how much, the
    /// lags reaching from none to well past the time its mint's answer to a released swap
    /// takes to come back, for the calls of either parity alike (the suite races a claim
    /// and a refusal in turn). One that starts them the same way each time still passes,
    /// and tests one order only.
    fn race_release_with_clock(&self, by: Duration);
    /// Start a new thread running `side`, as the engine needs a thread to be to poll its
    /// futures there: the suite runs some entries on threads of their own, each driven by an
    /// executor of the suite's while the suite's runtime runs on its own thread. A harness
    /// whose engine's futures need a runtime's context to be polled (a reactor or a timer
    /// of a runtime the engine was made in) enters that context on the thread before it
    /// runs `side`; the default starts a plain thread.
    fn spawn_thread(&self, side: Box<dyn FnOnce() + Send>) {
        std::thread::spawn(side);
    }
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
    /// The mint delivers the swap responses [`Harness::hold_swap_responses`] held as the
    /// next read of a swap's state that an entry (a `hello` or a `pay`) makes reaches it,
    /// and answers that read by a wake only once the engine has settled them, on whatever
    /// task or thread settles them: an answer that lands while the seeder reads. The read
    /// is under way until then ([`Harness::answers_under_way`]). A real engine's harness
    /// needs a seam in its settlement to know that it has settled them (the mock's engine
    /// counts the outcomes it has been handed and not yet settled). One that answers the
    /// read without it races an engine that settles outcomes on a task of its own: the
    /// scenarios that ask then pass or fail by which of the two comes first, and where the
    /// read takes a mint's round trip to come back, the engine's task all but always does.
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
    /// still waiting for one gets no answer. It may learn so after this returns, as from a
    /// real mint: under way until then ([`Harness::answers_under_way`]).
    fn roll_back_reserved(&self);
    /// Reads of swap state that have reached the mint (NUT-07 checks and NUT-09 restores),
    /// one per request, however many swaps it covers: counted as each arrives, so one the
    /// mint holds ([`Harness::gather_state_reads`]) counts while it waits there.
    fn state_reads(&self) -> u64;
    /// Reads of swap state that have reached the mint and whose answers their readers have
    /// not yet taken: on their way back ([`Harness::answers_under_way`]), or ready for the
    /// reader's next poll. A read the mint answers in the poll that sends it is never out.
    fn reads_out(&self) -> usize;
    /// Key requests the seeder has sent the mint (NUT-01 and NUT-02), one per request,
    /// answered or held ([`Harness::hold_key_fetches`]).
    fn key_requests(&self) -> u64;
    /// Those of [`Harness::key_requests`] that asked for the mint's keyset listing (NUT-02).
    /// A seeder asks a mint for it at its own start or where a check of a payment's needs
    /// one, at most once a second, an ask at its start included: a `hello` asks for none,
    /// nor does a payment refused by an earlier check, or whose turn has not come by its
    /// deadline (NFX-07 §3 step 3).
    fn listing_requests(&self) -> u64;
    /// Whether an answer a seeder or a watcher awaits is under way: its call has left the
    /// engine or the watcher, to the mint or to anything else that answers from off the
    /// suite's runtime (a store's worker thread, say), and it has not yet been answered and
    /// its caller woken. A call the suite holds ([`Harness::hold_swaps`] and the like) is not
    /// under way, nor is an answer its caller has been woken for, or one ready for its
    /// caller's next poll. The suite waits while one is (the trait's doc says how). The
    /// mock's only such calls are the mint's; a harness for an engine that awaits others
    /// counts them too.
    fn answers_under_way(&self) -> bool;
    /// The mint refuses, at once, a NUT-07 check or a NUT-09 restore that covers more than
    /// `max` proofs or outputs (CDK's `max_inputs` and `max_outputs`: 11014 for a check,
    /// 11015 for a restore), or reads any size again (`None`).
    fn limit_state_reads(&self, max: Option<usize>);
    /// A read the mint leaves unanswered costs its client `wait`, its timeout, on the
    /// harness's clock.
    fn unanswered_reads_take(&self, wait: Duration);
    /// Each read of swap state the mint serves waits, in real time and at most `wait`,
    /// until `n` reads have reached it (`n` 0: none waits, and the reads waiting then go
    /// on): entries on threads then meet at the mint, as a real engine's can.
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
    /// inputs. Tokens issued from then on are of the new keyset, which the mint lists
    /// (NUT-02) from now: a seeder that asked for the listing in this second asks again
    /// only in the next (NFX-07 §3 step 3).
    fn rotate_keyset(&self);
    /// The mint at `url` alone starts a keyset of its own, its active one, which it lists
    /// (NUT-02) from now, its `final_expiry` that far from now (`None`: none), and issues
    /// its tokens from until it starts another: no other mint lists it or serves its keys.
    /// Its earlier keysets, and every other mint's, stay as they were. A seeder that asked
    /// that mint for its listing in this second asks it again only in the next (NFX-07 §3
    /// step 3).
    fn start_keyset_at(&self, url: &str, final_expiry: Option<Duration>);
    /// The mint's keyset expires now, as [`MintEvent::ExpireKeyset`] does before a swap:
    /// proofs of older keysets ([`Harness::fund_older_keyset`]) stay valid. Tokens issued
    /// from then on are of a new keyset, which the mint lists from now, as after
    /// [`Harness::rotate_keyset`].
    fn expire_keyset(&self);
    /// The mint's active keyset lists a `final_expiry` (NUT-02) `after` from now, or none,
    /// from its listing's next answer: a seeder that asked for the listing in this second
    /// may judge the keyset rule by that one until the next (NFX-07 §3 step 5).
    fn keyset_expires_in(&self, after: Option<Duration>);
    /// The mint's active keyset expires, and stays active (CDK does not rotate an expired
    /// keyset): outputs derived from it, and every proof it issued since the last rotation
    /// (those a wallet already holds included), are refused (12003), while proofs of older
    /// keysets stay valid, until [`Harness::rotate_keyset`]. Its listing shows the
    /// `final_expiry` from its next answer, as [`Harness::keyset_expires_in`] says.
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
    /// How long a ban lasts, from the refusal that earned it: what the ban itself refuses (a
    /// `hello`, a request, a `pay`) extends nothing.
    fn ban_ttl(&self) -> Duration;
}
