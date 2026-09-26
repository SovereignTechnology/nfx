//! A mock mint network and honest mock engines: an executable reading of NFX-07 §3 and §3a.
//!
//! Tokens look like `cashuBmock<hex>`, which no real Cashu wallet accepts. They hold
//! power-of-two proofs, as a real mint issues them. The network tracks **proofs**, not
//! token strings, so a re-encoded or combined token is still a double spend.
//! - A swap is atomic: it claims every proof of a token, or none.
//! - Swaps can be held (not processed), or processed with their responses held, and
//!   released all at once or oldest first. Key requests can be held too.
//! - The mint can be taken down.
//! - The seeder and the viewers keep time on the harness's clock, so debt ages, deadlines
//!   pass and answers can be late. Moving the clock wakes whatever waits on it.
//!
//! No money and no cryptography are involved.
//!
//! Every defect the audits found in plausible engines can be planted with [`SeederFlaw`]
//! or [`ViewerFlaw`]; `tests/mutants.rs` shows the adversary suite catches each one.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::poll_fn;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use nfx_pay_wire::namespace::VideoAddr;
use nfx_pay_wire::pay::{
    Ack, Hello, MAX_INT, MAX_WINDOW, Message, ParseOptions, Pay, Quote, Rej, RejCode,
};

use crate::session::{
    BadToken, EngineParams, Harness, MintEvent, PeerId, SeederEngine, SeederSession, Viewer,
};

/// Sessions one peer may hold open at once, across all videos.
pub const MAX_OPEN_SESSIONS_PER_PEER: usize = 8;
/// How long an unpaid chunk counts toward the global cap (NFX-07 §3: 1 h recommended).
pub const DEBT_TTL: Duration = Duration::from_secs(3600);
/// The shortest `debt_ttl` a seeder accepts (NFX-07 §3).
pub const MIN_DEBT_TTL: Duration = Duration::from_secs(600);
/// How long a never-paid account with no open session is kept (24 h recommended).
pub const ACCOUNT_TTL: Duration = Duration::from_secs(24 * 3600);
/// How long a ban lasts (24 h recommended).
pub const BAN_TTL: Duration = Duration::from_secs(24 * 3600);
/// The largest global cap a seeder accepts: beyond it the cap bounds nothing (NFX-07 §3).
pub const MAX_GLOBAL_CAP: u64 = 1_000_000;
/// The largest `window` the mock viewer accepts in a quote: the wire's own ceiling
/// (NFX-07 §2).
pub const WINDOW_CEILING: u64 = MAX_WINDOW;
/// `mint-unavailable` answers in a row after which the viewer pays that seeder nothing
/// more until a new session (NFX-07 §3a).
pub const UNAVAILABLE_BUDGET: u32 = 3;
/// The seeder answers every `pay` within this (NFX-07 §3).
pub const SEEDER_DEADLINE: Duration = Duration::from_secs(60);
/// How long a watcher waits for an answer before reclaiming (NFX-07 §3a): the `pay`'s
/// delivery, the seeder's deadline and the answer's delivery, 60 s each.
pub const ANSWER_WAIT: Duration = Duration::from_secs(180);
/// The longest `debt_ttl` a seeder accepts (NFX-07 §3).
pub const MAX_DEBT_TTL: Duration = Duration::from_secs(24 * 3600);
/// The longest `account_ttl` and `ban_ttl` a seeder accepts (NFX-07 §3).
pub const MAX_STATE_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// The most proofs one payment may hold (NFX-07 §3).
pub const MAX_PROOFS: usize = 64;

/// Payment state is not trusted after a panic: a poisoned lock aborts the caller.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock()
        .unwrap_or_else(|_| panic!("a poisoned lock: payment state is not trusted"))
}

/// The harness's clock, in whole seconds. Futures that wait on time register with it,
/// and moving it wakes them.
#[derive(Clone, Default)]
pub struct Clock {
    now: Arc<AtomicU64>,
    waiting: Arc<Mutex<Vec<Waker>>>,
}

impl Clock {
    fn now(&self) -> u64 {
        self.now.load(Ordering::Relaxed)
    }

    fn watch(&self, waker: &Waker) {
        lock(&self.waiting).push(waker.clone());
    }

    fn advance(&self, by: Duration) {
        self.now.fetch_add(by.as_secs(), Ordering::Relaxed);
        let wake = std::mem::take(&mut *lock(&self.waiting));
        for w in wake {
            w.wake();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dleq {
    Valid,
    Invalid,
    Missing,
}

#[derive(Debug, Clone)]
struct TokenInfo {
    proofs: Vec<u64>,
    mints: Vec<String>,
    amount: u64,
    unit: &'static str,
    locked: bool,
    dleq: Dleq,
}

/// How a swap ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Swap {
    /// Every proof is now the swapper's.
    Claimed,
    /// A proof was already claimed; nothing was claimed.
    Spent,
    /// The mint refuses the proofs (forged, or not a token: CDK 10001); nothing was
    /// claimed.
    Invalid,
    /// The mint could not be reached: the request never got there, and nothing happened.
    Unreachable,
    /// The request reached the mint, and no answer came back (lost on the way): what
    /// happened is unknown until a retry or a restore (NUT-09) shows it.
    Lost,
    /// The mint refused the request: its inputs are reserved by a request it is still
    /// processing (NUT-07 `PENDING`; CDK's 11002 "token pending"). Nothing happened to
    /// this request.
    Pending,
    /// The mint refused the request's outputs: their keyset is no longer active (CDK
    /// 12002, after a rotation), or not one it knows (12001, which does not say whose
    /// keyset). Nothing happened, and no request with those outputs can go through any
    /// more; it is never the payer's fault.
    OutputsRefused,
    /// The mint refused the request because a keyset has expired (CDK 12003): its inputs'
    /// or its outputs', with the same code and detail either way. Nothing happened to this
    /// request; an inputs' expiry does not stop a request the mint reserved before it.
    Expired,
}

/// Why a read of swap state gave no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadErr {
    /// No answer came: the mint is down, or that endpoint is.
    Unanswered,
    /// Refused at once: more proofs or outputs than one request may cover (CDK's
    /// `max_inputs` and `max_outputs`: 11014 for a check, 11015 for a restore).
    TooMany,
}

/// A proof's state, as a NUT-07 check reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputState {
    Unspent,
    /// Reserved by a request the mint is still processing: it may yet go through, or be
    /// rolled back.
    Pending,
    Spent,
}

/// What reading a swap's state shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Read {
    /// Its outputs are signed.
    Claimed,
    /// Its outputs are unsigned and an input is spent: it can no longer go through.
    Nothing,
    /// Its outputs are unsigned and every input is unspent: the request may still be
    /// processed, or its payer has the inputs back and has not spent them.
    Unspent,
    /// Anything else: an input pending, or a read unanswered.
    Unknown,
}

/// How a wallet's reclaim of its own proofs ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reclaim {
    /// Every proof was taken back.
    All,
    /// Some proof had already been claimed by someone else (the rest were taken back).
    SomeSpent,
    /// No answer came (the mint could not be reached, or the response was lost): try
    /// again later.
    Blocked,
    /// The mint refused the reclaim: the proofs are reserved by a request it is still
    /// processing (CDK 11002). Nothing was taken back yet.
    Pending,
    /// The mint refused the reclaim because the proofs' keyset expired (CDK 12003), and a
    /// NUT-07 check shows every one unspent: lost to the expiry, not taken by anyone.
    Expired,
}

type Done = Box<dyn FnOnce(Swap) + Send>;

#[derive(Default)]
struct Ledger {
    tokens: HashMap<String, TokenInfo>,
    claimed: HashSet<u64>,
    forged: HashSet<u64>,
    next: u64,
    hold: bool,
    /// Hold only the next swap submitted.
    hold_next: bool,
    hold_responses: bool,
    hold_keys: bool,
    down: bool,
    dialled: HashSet<String>,
    /// Swaps sent while held, with their output sets: not yet processed.
    queued: Vec<(u64, String, u64, Done)>,
    /// Swaps processed whose responses are held.
    responses: Vec<(u64, Swap, Done)>,
    /// Delivered outcomes, by submission.
    answers: HashMap<u64, Swap>,
    waiting: Vec<Waker>,
    /// Swaps an acknowledge-first engine left for later ([`SeederFlaw::AckBeforeSwap`]).
    deferred: Vec<(String, Done)>,
    /// Process the next swap, and lose its response.
    lose_swap: bool,
    /// Process the next reclaim, and lose its response.
    lose_reclaim: bool,
    /// Restores go unanswered while swaps do not.
    restore_down: bool,
    /// The swapper's client gives up on the next swap at once (no answer), while the
    /// request stays queued at the mint, to be processed at release with no answer.
    time_out_next: bool,
    /// Queued requests whose client gave up: processed at release, answered to no one.
    gave_up: HashSet<u64>,
    /// Those requests are processed right after the next read of a swap's state (a
    /// NUT-07 check or a restore): between a seeder's two reads of it.
    mid_read: bool,
    /// Held responses are delivered right after the next read of a swap's state.
    deliver_mid_read: bool,
    /// The next swap's inputs are reserved (NUT-07 `PENDING`) and the request held.
    reserve_next: bool,
    /// The next request's inputs expire once the mint has reserved them
    /// ([`MintEvent::ExpireInputKeysetOnceReserved`]).
    expire_once_reserved: bool,
    /// Proofs reserved by a request the mint is still processing.
    reserved: HashSet<u64>,
    /// NUT-07 checks go unanswered while swaps and restores do not.
    state_down: bool,
    /// Reads of swap state served (NUT-07 checks and NUT-09 restores), one per request.
    reads: u64,
    /// The most proofs or outputs one read may cover; more is refused at once.
    read_limit: Option<usize>,
    /// Reads wait for this many to reach the mint, at most this long in real time
    /// ([`Harness::gather_state_reads`]).
    gather: (usize, Duration),
    /// Reads that have reached the mint while gathering.
    gathered: usize,
    /// Admissions that check and count in two steps meet between them: this many, at most
    /// this long in real time ([`Harness::gather_admissions`]).
    admit_gather: (usize, Duration),
    /// Admissions that have met there.
    admit_gathered: usize,
    /// Seconds the clock moves between the next outcome's arrival and its settlement
    /// ([`Harness::advance_during_next_land`]).
    advance_during_land: u64,
    /// Seconds a read left unanswered costs its client (its timeout).
    read_timeout: u64,
    /// Run during the next read of swap state (another learner, at the same time).
    during_read: Option<Box<dyn FnOnce() + Send>>,
    /// Output sets up to this id belong to a keyset rotated out: refused (0: none).
    retired_outputs: u64,
    /// Proofs and output sets up to this id belong to the mint's keyset that has expired
    /// (0: none), proofs of older keysets excepted: a request spending such a proof, or with
    /// such outputs, is refused (CDK 12003), and a restore does not show such outputs (CDK
    /// skips an expired keyset's).
    expired_upto: u64,
    /// Proofs of an older keyset that has expired, while the mint's own is still current.
    expired_inputs: HashSet<u64>,
    /// The mint's active keyset has expired and stays active: proofs and output sets after
    /// this id (its last rotation) belong to it, those it issued before its expiry included.
    active_expired_since: Option<u64>,
    /// Ids of keysets that expired while active, since rotated out.
    expired_ranges: Vec<(u64, u64)>,
    /// Reads of swap state are round trips: an engine's read answers on its next poll
    /// ([`MockHarness::with_round_trip_reads`]).
    round_trips: bool,
    /// What happens just before the next swap request reaches the mint, in order.
    before_swap: Vec<MintEvent>,
    /// The output sets the mint signed, one per swap request and its retries (NUT-13):
    /// what a restore (NUT-09) finds.
    signed: HashSet<u64>,
    /// Tokens the mint swapped, whatever the outputs ([`SeederFlaw::RestoreByToken`]).
    swapped_tokens: HashSet<String>,
    /// Proofs a watcher's own reclaims took back: its outputs, restorable.
    reclaimed: HashMap<u64, u64>,
    /// The `final_expiry` the mint lists for its active keyset (clock seconds), if any.
    final_expiry: Option<u64>,
    /// Sat the watchers' wallets hold in proofs of an older keyset, spent first
    /// ([`Harness::fund_older_keyset`]).
    older_balance: u64,
    /// Proofs of older keysets: never the active one's.
    older: HashSet<u64>,
    /// Those of the older keyset the wallets were funded in last.
    older_now: HashSet<u64>,
    /// That older keyset has expired: every proof of it, those the wallets still hold
    /// included ([`Harness::expire_older_keyset`]).
    older_expired: bool,
}

impl Ledger {
    /// The keyset of `proofs` expires, while the mint's own does not. Proofs of the older
    /// keyset the wallets hold take the whole of it with them.
    fn expire_inputs(&mut self, proofs: impl IntoIterator<Item = u64>) {
        for p in proofs {
            if self.older_now.contains(&p) {
                self.expire_older();
            }
            self.expired_inputs.insert(p);
        }
    }

    /// The older keyset expires: the proofs of it drawn so far, and those the wallets still
    /// hold, as they draw them.
    fn expire_older(&mut self) {
        self.older_expired = true;
        let drawn: Vec<u64> = self.older_now.iter().copied().collect();
        self.expired_inputs.extend(drawn);
    }

    fn in_expired_keyset(&self, id: u64) -> bool {
        (id <= self.expired_upto && !self.older.contains(&id))
            || self
                .active_expired_since
                .is_some_and(|x| id > x && !self.older.contains(&id))
            || (!self.older.contains(&id)
                && self
                    .expired_ranges
                    .iter()
                    .any(|(a, b)| (*a..=*b).contains(&id)))
    }

    fn proof_expired(&self, p: u64) -> bool {
        self.in_expired_keyset(p) || self.expired_inputs.contains(&p)
    }

    fn outputs_expired(&self, outputs: u64) -> bool {
        outputs != 0 && self.in_expired_keyset(outputs)
    }
}

/// Every mock mint's ledger, shared.
#[derive(Clone, Default)]
pub struct MockNetwork(Arc<Mutex<Ledger>>);

impl MockNetwork {
    fn ledger(&self) -> MutexGuard<'_, Ledger> {
        lock(&self.0)
    }

    fn mint_token(&self, info: TokenInfo) -> String {
        let mut l = self.ledger();
        l.next += 1;
        let token = format!("cashuBmock{:016x}", l.next);
        l.tokens.insert(token.clone(), info);
        token
    }

    fn fresh_proofs(&self, n: usize) -> Vec<u64> {
        let mut l = self.ledger();
        (0..n)
            .map(|_| {
                l.next += 1;
                l.next
            })
            .collect()
    }

    /// Fresh proofs for `amount`: one per set bit, as a real mint splits.
    fn proofs_for(&self, amount: u64) -> Vec<u64> {
        self.fresh_proofs(amount.count_ones().max(1) as usize)
    }

    /// A fresh token worth `amount` sat from `mint`.
    #[must_use]
    pub fn issue(&self, mint: &str, amount: u64) -> String {
        self.issue_with(mint, amount, &[])
    }

    /// A token worth `amount` sat from `mint`: `old` proofs a wallet holds, then proofs for
    /// the amount (the mock does not weigh proofs one by one), of the older keyset while the
    /// wallets hold enough of it ([`Harness::fund_older_keyset`]), else fresh ones.
    fn issue_with(&self, mint: &str, amount: u64, old: &[u64]) -> String {
        let mut proofs = old.to_vec();
        let fresh = self.proofs_for(amount);
        {
            let mut l = self.ledger();
            if l.older_balance >= amount && amount > 0 {
                l.older_balance -= amount;
                l.older.extend(fresh.iter().copied());
                l.older_now.extend(fresh.iter().copied());
                if l.older_expired {
                    l.expired_inputs.extend(fresh.iter().copied());
                }
            }
        }
        proofs.extend(fresh);
        self.mint_token(TokenInfo {
            proofs,
            mints: vec![mint.to_owned()],
            amount,
            unit: "sat",
            locked: false,
            dleq: Dleq::Valid,
        })
    }

    fn read(&self, token: &str) -> Option<TokenInfo> {
        self.ledger().tokens.get(token).cloned()
    }

    /// Whether a read of swap state is a round trip, answered on its reader's next poll.
    fn round_trips(&self) -> bool {
        self.ledger().round_trips
    }

    /// Fetch something (keys) from the mint at `url`, now.
    fn dial(&self, url: &str) {
        self.ledger().dialled.insert(url.to_owned());
    }

    /// Fetch the keys of the mint at `url`: `false` while key requests are held, and then
    /// `waker` is woken at their release.
    fn fetch_keys(&self, url: &str, waker: &Waker) -> bool {
        let mut l = self.ledger();
        if l.hold_keys {
            l.waiting.push(waker.clone());
            return false;
        }
        l.dialled.insert(url.to_owned());
        true
    }

    /// Swap every proof of `token` at its mint, atomically, now.
    #[must_use]
    pub fn swap_now(&self, token: &str) -> Swap {
        self.swap_for(token, 0)
    }

    /// The same, to the output set `outputs` (0: none a restore can find).
    fn swap_for(&self, token: &str, outputs: u64) -> Swap {
        self.swap_checked(token, outputs, true)
    }

    /// A request the mint held, processed now. One whose inputs it reserved before holding
    /// it passed its input checks then: a keyset expiring since does not stop it, since CDK
    /// checks only the outputs' keyset when it signs.
    fn process(&self, token: &str, outputs: u64) -> Swap {
        let reserved = {
            let l = self.ledger();
            l.tokens.get(token).is_some_and(|i| {
                !i.proofs.is_empty() && i.proofs.iter().all(|p| l.reserved.contains(p))
            })
        };
        self.unreserve(token);
        self.swap_checked(token, outputs, !reserved)
    }

    /// A swap, its inputs' keyset expiry checked unless `check_inputs` is false (a request
    /// whose inputs the mint reserved before).
    fn swap_checked(&self, token: &str, outputs: u64, check_inputs: bool) -> Swap {
        let mut l = self.ledger();
        let Some(info) = l.tokens.get(token).cloned() else {
            return Swap::Invalid;
        };
        for m in &info.mints {
            l.dialled.insert(m.clone());
        }
        if l.down {
            return Swap::Unreachable;
        }
        // CDK checks the inputs first, then the outputs: an expired keyset is 12003 either
        // way. A reserved request passed its input checks; its outputs are checked again
        // when it signs.
        if check_inputs && info.proofs.iter().any(|p| l.proof_expired(*p)) {
            return Swap::Expired;
        }
        if l.outputs_expired(outputs) {
            return Swap::Expired;
        }
        if outputs != 0 && outputs <= l.retired_outputs {
            return Swap::OutputsRefused;
        }
        if info.proofs.iter().any(|p| l.reserved.contains(p)) {
            return Swap::Pending;
        }
        if info.proofs.iter().any(|p| l.forged.contains(p)) {
            return Swap::Invalid;
        }
        if info.proofs.iter().any(|p| l.claimed.contains(p)) {
            return Swap::Spent;
        }
        l.claimed.extend(info.proofs);
        if outputs != 0 {
            l.signed.insert(outputs);
        }
        l.swapped_tokens.insert(token.to_owned());
        Swap::Claimed
    }

    /// What the harness asked to happen before the next swap request, in order.
    fn before_swap(&self, token: &str) {
        let events = std::mem::take(&mut self.ledger().before_swap);
        for event in events {
            match event {
                MintEvent::Down => self.ledger().down = true,
                MintEvent::RestoresDown => self.ledger().restore_down = true,
                MintEvent::RotateKeyset => {
                    let mut l = self.ledger();
                    l.retired_outputs = l.next;
                }
                MintEvent::ExpireKeyset => {
                    let mut l = self.ledger();
                    l.expired_upto = l.next;
                }
                MintEvent::ExpireInputKeysetOnceReserved => {
                    self.ledger().expire_once_reserved = true;
                }
                MintEvent::ExpireInputKeyset => {
                    let mut l = self.ledger();
                    if let Some(i) = l.tokens.get(token).cloned() {
                        l.expire_inputs(i.proofs);
                    }
                }
                MintEvent::ProcessTimedOut | MintEvent::ReserveTimedOut => self.given_up(event),
            }
        }
    }

    /// The requests whose client gave up are processed, or start processing (their
    /// inputs reserved).
    fn given_up(&self, event: MintEvent) {
        let given_up = {
            let mut l = self.ledger();
            let (given_up, rest) = std::mem::take(&mut l.queued)
                .into_iter()
                .partition::<Vec<_>, _>(|q| l.gave_up.contains(&q.0));
            if event == MintEvent::ReserveTimedOut {
                for q in &given_up {
                    if let Some(i) = l.tokens.get(&q.1).cloned() {
                        l.reserved.extend(i.proofs);
                    }
                }
                l.queued = rest.into_iter().chain(given_up).collect();
                return;
            }
            l.queued = rest;
            for q in &given_up {
                l.gave_up.remove(&q.0);
            }
            given_up
        };
        for (_, token, outputs, done) in given_up {
            done(self.process(&token, outputs));
        }
    }

    /// A swap sent again by a swapper that waits for it here and nowhere else (a seeder's
    /// completion): no answer in time (held, given up, lost, or its response held) is
    /// `Lost`, while the request itself stays at the mint.
    fn resend(&self, token: &str, outputs: u64) -> Swap {
        self.before_swap(token);
        let waits = {
            let mut l = self.ledger();
            l.next += 1;
            let id = l.next;
            let expire_after = std::mem::take(&mut l.expire_once_reserved);
            let mut reserve = std::mem::take(&mut l.reserve_next);
            if reserve && let Some(i) = l.tokens.get(token).cloned() {
                if Self::refused_expired(&l, &i.proofs, outputs) {
                    reserve = false; // refused (12003) before anything is reserved
                } else {
                    l.reserved.extend(i.proofs.iter().copied());
                    if expire_after {
                        l.expire_inputs(i.proofs);
                    }
                }
            }
            let held = reserve || std::mem::take(&mut l.time_out_next) || l.hold;
            let held = held || std::mem::take(&mut l.hold_next);
            if held {
                l.queued
                    .push((id, token.to_owned(), outputs, Box::new(|_| {})));
                l.gave_up.insert(id);
            }
            held
        };
        if waits {
            return Swap::Lost;
        }
        let outcome = self.lose(self.swap_for(token, outputs));
        if self.ledger().hold_responses {
            return Swap::Lost; // processed; its response held, and answered to no one
        }
        outcome
    }

    /// An admission between its checks and its count: wait, in real time, for the others
    /// [`Harness::gather_admissions`] asks for.
    fn meet_admissions(&self) {
        let (n, wait) = {
            let mut l = self.ledger();
            l.admit_gathered += 1;
            l.admit_gather
        };
        let start = std::time::Instant::now();
        while n > 0 && self.ledger().admit_gathered < n && start.elapsed() < wait {
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Whether the mint refuses a request of `proofs` to `outputs` because a keyset has
    /// expired (12003), as it checks before reserving anything.
    fn refused_expired(l: &Ledger, proofs: &[u64], outputs: u64) -> bool {
        proofs.iter().any(|p| l.proof_expired(*p)) || l.outputs_expired(outputs)
    }

    /// A fresh output set's id, unique across every swapper sharing this mint.
    fn fresh_outputs(&self) -> u64 {
        let mut l = self.ledger();
        l.next += 1;
        l.next
    }

    /// How many proofs `token` holds: what one of its swaps' reads covers.
    fn proofs_in(&self, token: &str) -> usize {
        self.ledger()
            .tokens
            .get(token)
            .map_or(1, |i| i.proofs.len())
    }

    /// Serve one read of `size` proofs or outputs: `ReadErr` if unanswered (`down`) or too
    /// large for one request.
    fn serve_read<T>(
        &self,
        size: usize,
        down: impl Fn(&Ledger) -> bool,
        answer: impl FnOnce(&Ledger) -> T,
    ) -> Result<T, ReadErr> {
        let (n, wait) = {
            let mut l = self.ledger();
            l.gathered += 1;
            l.gather
        };
        let start = std::time::Instant::now();
        while n > 0 && self.ledger().gathered < n && start.elapsed() < wait {
            std::thread::sleep(Duration::from_millis(1));
        }
        let read = {
            let mut l = self.ledger();
            l.reads += 1;
            if down(&l) {
                Err(ReadErr::Unanswered)
            } else if l.read_limit.is_some_and(|max| size > max) {
                Err(ReadErr::TooMany)
            } else {
                Ok(answer(&l))
            }
        };
        self.after_read();
        read
    }

    /// NUT-09 restore of the output set `outputs` (`size` outputs): whether the mint signed
    /// it, that is processed that swap, or `None` without an answer.
    fn restore_swap(&self, outputs: u64, size: usize) -> Option<bool> {
        self.restore_swaps(&[outputs], &[size]).ok().map(|s| s[0])
    }

    /// NUT-09 restore of several output sets in one request.
    fn restore_swaps(&self, outputs: &[u64], sizes: &[usize]) -> Result<Vec<bool>, ReadErr> {
        self.serve_read(
            sizes.iter().sum(),
            |l| l.down || l.restore_down,
            |l| {
                outputs
                    .iter()
                    .map(|o| l.signed.contains(o) && !l.outputs_expired(*o))
                    .collect()
            },
        )
    }

    /// The `final_expiry` the mint lists for its active keyset (`/v1/keysets`, NUT-02).
    fn keyset_final_expiry(&self) -> Option<u64> {
        self.ledger().final_expiry
    }

    /// How many of `token`'s proofs the mint lists under an expired keyset, and how many
    /// not (`/v1/keysets`, NUT-02 `final_expiry`).
    fn proofs_listing(&self, token: &str) -> (usize, usize) {
        let l = self.ledger();
        l.tokens.get(token).map_or((0, 0), |i| {
            let expired = i.proofs.iter().filter(|p| l.proof_expired(**p)).count();
            (expired, i.proofs.len() - expired)
        })
    }

    /// Those of `token`'s proofs the mint lists under an expired keyset.
    fn proofs_listed_expired(&self, token: &str) -> Vec<u64> {
        let l = self.ledger();
        l.tokens.get(token).map_or_else(Vec::new, |i| {
            i.proofs
                .iter()
                .copied()
                .filter(|p| l.proof_expired(*p))
                .collect()
        })
    }

    /// Whether the mint's active keyset, which a reclaim's outputs come from, has expired.
    fn active_expired(&self) -> bool {
        let l = self.ledger();
        l.outputs_expired(l.next + 1)
    }

    /// A wallet taking back those of `token`'s proofs whose keyset is not expired, in a
    /// reclaim of their own: `Expired` when it has them all (the rest lost to the expiry),
    /// counting those its own earlier reclaim took back (restorable), which it does not
    /// send again.
    fn reclaim_unexpired(&self, token: &str) -> Reclaim {
        let mut l = self.ledger();
        if l.down {
            return Reclaim::Blocked;
        }
        let Some(info) = l.tokens.get(token).cloned() else {
            return Reclaim::SomeSpent;
        };
        let good: Vec<u64> = info
            .proofs
            .iter()
            .copied()
            .filter(|p| !l.proof_expired(*p))
            .collect();
        if good.iter().any(|p| l.reserved.contains(p)) {
            return Reclaim::Pending;
        }
        let back = good
            .iter()
            .filter(|p| l.reclaimed.get(p).is_some_and(|o| !l.outputs_expired(*o)))
            .count();
        let fresh: Vec<u64> = good
            .iter()
            .copied()
            .filter(|p| !l.claimed.contains(p) && !l.forged.contains(p))
            .collect();
        let all = fresh.len() + back == good.len();
        if fresh.is_empty() {
            return if all {
                Reclaim::Expired
            } else {
                Reclaim::SomeSpent
            };
        }
        if l.outputs_expired(l.next + 1) {
            return Reclaim::Blocked; // its outputs' keyset expired too: later
        }
        l.next += 1;
        let outputs = l.next;
        l.claimed.extend(fresh.iter().copied());
        l.reclaimed.extend(fresh.iter().map(|p| (*p, outputs)));
        if l.lose_reclaim {
            l.lose_reclaim = false;
            return Reclaim::Blocked;
        }
        if all {
            Reclaim::Expired
        } else {
            Reclaim::SomeSpent
        }
    }

    /// Whether the keyset of the output set `outputs` has expired: the mint's own state,
    /// which only a planted flaw consults.
    fn outputs_expired(&self, outputs: u64) -> bool {
        self.ledger().outputs_expired(outputs)
    }

    /// The mistake of restoring by token: any swap of these proofs counts as this one.
    fn restore_by_token(&self, token: &str) -> Option<bool> {
        let size = self.proofs_in(token);
        self.restore_by_tokens(&[token.to_owned()], &[size])
            .ok()
            .map(|s| s[0])
    }

    fn restore_by_tokens(&self, tokens: &[String], sizes: &[usize]) -> Result<Vec<bool>, ReadErr> {
        self.serve_read(
            sizes.iter().sum(),
            |l| l.down || l.restore_down,
            |l| {
                tokens
                    .iter()
                    .map(|t| l.swapped_tokens.contains(t))
                    .collect()
            },
        )
    }

    /// NUT-07 check of several tokens' proofs in one request: spent if any proof is,
    /// else pending if any proof is reserved, else unspent.
    fn input_states(&self, tokens: &[String]) -> Result<Vec<InputState>, ReadErr> {
        let size = tokens.iter().map(|t| self.proofs_in(t)).sum();
        self.serve_read(
            size,
            |l| l.down || l.state_down,
            |l| {
                tokens
                    .iter()
                    .map(|t| {
                        let proofs = l.tokens.get(t).map_or(&[][..], |i| &i.proofs[..]);
                        if proofs.iter().any(|p| l.claimed.contains(p)) {
                            InputState::Spent
                        } else if proofs.iter().any(|p| l.reserved.contains(p)) {
                            InputState::Pending
                        } else {
                            InputState::Unspent
                        }
                    })
                    .collect()
            },
        )
    }

    /// The mint gives `token`'s reserved proofs back to processing: done before it
    /// processes the request that reserved them.
    fn unreserve(&self, token: &str) {
        let mut l = self.ledger();
        if let Some(i) = l.tokens.get(token).cloned() {
            for p in &i.proofs {
                l.reserved.remove(p);
            }
        }
    }

    /// The mint abandons every request that reserved inputs (CDK's recovery at startup):
    /// the inputs are unspent again, and those requests are never processed. A client
    /// still waiting for one gets no answer.
    fn roll_back_reserved(&self) {
        let dropped = {
            let mut l = self.ledger();
            let reserved = std::mem::take(&mut l.reserved);
            let queued = std::mem::take(&mut l.queued);
            let (dropped, kept): (Vec<_>, Vec<_>) = queued.into_iter().partition(|q| {
                l.tokens
                    .get(&q.1)
                    .is_some_and(|i| i.proofs.iter().any(|p| reserved.contains(p)))
            });
            l.queued = kept;
            dropped
                .into_iter()
                .filter(|q| !l.gave_up.remove(&q.0))
                .collect::<Vec<_>>()
        };
        for (id, _, _, done) in dropped {
            done(Swap::Lost);
            self.deliver(id, Swap::Lost);
        }
    }

    /// After a read of a swap's state: process the requests whose client gave up, if the
    /// harness asked for that now. Their completions answer no one, so nothing re-enters
    /// the engine that is reading.
    fn after_read(&self) {
        let during = self.ledger().during_read.take();
        if let Some(f) = during {
            f();
        }
        let held = {
            let mut l = self.ledger();
            if std::mem::take(&mut l.deliver_mid_read) {
                std::mem::take(&mut l.responses)
            } else {
                Vec::new()
            }
        };
        for (id, outcome, done) in held {
            done(outcome);
            self.deliver(id, outcome);
        }
        let now = {
            let mut l = self.ledger();
            if !std::mem::take(&mut l.mid_read) {
                return;
            }
            let (now, rest) = std::mem::take(&mut l.queued)
                .into_iter()
                .partition::<Vec<_>, _>(|q| l.gave_up.contains(&q.0));
            l.queued = rest;
            for q in &now {
                l.gave_up.remove(&q.0);
            }
            now
        };
        for (_, token, outputs, done) in now {
            done(self.process(&token, outputs));
        }
    }

    /// A response the harness loses: only a request that reached the mint has one.
    fn lose(&self, outcome: Swap) -> Swap {
        let mut l = self.ledger();
        if l.lose_swap && outcome != Swap::Unreachable {
            l.lose_swap = false;
            return Swap::Lost;
        }
        outcome
    }

    /// NUT-09 restore of a watcher's reclaim outputs: whether its own reclaims took back
    /// every proof of `token` (or, with `any`, the mistake: some of them), or `None` while
    /// the mint cannot be reached.
    fn restore_reclaim(&self, token: &str, any: bool) -> Option<bool> {
        let l = self.ledger();
        if l.down || l.restore_down {
            return None;
        }
        // Its outputs, unless their keyset has expired: a restore no longer shows them then.
        let mine = |p: &u64| l.reclaimed.get(p).is_some_and(|o| !l.outputs_expired(*o));
        Some(l.tokens.get(token).is_some_and(|i| {
            if any {
                i.proofs.iter().any(mine)
            } else {
                i.proofs.iter().all(mine)
            }
        }))
    }

    /// NUT-09 restore of a watcher's reclaim outputs, for a token some of whose proofs a
    /// NUT-07 check found spent: whether every spent one is among them (its own reclaims'),
    /// or `None` while the mint cannot be reached.
    fn restore_spent_own(&self, token: &str) -> Option<bool> {
        let l = self.ledger();
        if l.down || l.restore_down {
            return None;
        }
        let mine = |p: &u64| l.reclaimed.get(p).is_some_and(|o| !l.outputs_expired(*o));
        Some(
            l.tokens
                .get(token)
                .is_some_and(|i| i.proofs.iter().filter(|p| l.claimed.contains(p)).all(mine)),
        )
    }

    /// Whether a third party's swap of proof `p` alone goes through: unclaimed, and not
    /// reserved (11002), of an expired keyset (12003) or invalid (forged).
    fn claimable(l: &Ledger, p: u64) -> bool {
        !l.claimed.contains(&p)
            && !l.forged.contains(&p)
            && !l.reserved.contains(&p)
            && !l.proof_expired(p)
    }

    /// A third party claiming the first unclaimed proof of `token`, in a swap of it alone:
    /// whether it got it.
    fn steal_one(&self, token: &str) -> bool {
        let mut l = self.ledger();
        let Some(info) = l.tokens.get(token).cloned() else {
            return false;
        };
        let Some(p) = info.proofs.iter().copied().find(|p| !l.claimed.contains(p)) else {
            return false;
        };
        if !Self::claimable(&l, p) {
            return false;
        }
        l.claimed.insert(p);
        true
    }

    /// A third party's request of `token`'s unclaimed proofs (a melt, say) that the mint
    /// reserves and never finishes, until it rolls back what it reserved: whether it
    /// reserved them. Refused whole if any is reserved already, of an expired keyset or
    /// invalid.
    fn reserve_rest(&self, token: &str) -> bool {
        let mut l = self.ledger();
        let Some(info) = l.tokens.get(token).cloned() else {
            return false;
        };
        let rest: Vec<u64> = info
            .proofs
            .into_iter()
            .filter(|p| !l.claimed.contains(p))
            .collect();
        if rest.is_empty() || rest.iter().any(|p| !Self::claimable(&l, *p)) {
            return false;
        }
        l.reserved.extend(rest);
        true
    }

    /// The wallets drop the proofs they hold that the mint lists expired: those of the older
    /// keyset, once it has expired.
    fn drop_expired_held(&self) {
        let mut l = self.ledger();
        if l.older_expired {
            l.older_balance = 0;
        }
    }

    /// Send a swap, as an engine does: `done` runs with the outcome when the mint answers,
    /// whether or not anyone is still waiting for it. Returns a handle for
    /// [`MockNetwork::try_answer`].
    fn submit(&self, token: &str, outputs: u64, done: Done) -> u64 {
        self.before_swap(token);
        let id = {
            let mut l = self.ledger();
            l.next += 1;
            let id = l.next;
            let expire_after = std::mem::take(&mut l.expire_once_reserved);
            if std::mem::take(&mut l.reserve_next)
                && let Some(i) = l.tokens.get(token).cloned()
                && !Self::refused_expired(&l, &i.proofs, outputs)
            {
                // Held after the mint reserved the inputs, as CDK does before it signs, and
                // only once their keysets and the outputs' have passed its checks.
                l.reserved.extend(i.proofs.iter().copied());
                if expire_after {
                    l.expire_inputs(i.proofs);
                }
                if !l.time_out_next {
                    l.queued.push((id, token.to_owned(), outputs, done));
                    return id;
                }
            }
            if l.time_out_next {
                l.time_out_next = false;
                l.queued
                    .push((id, token.to_owned(), outputs, Box::new(|_| {})));
                l.gave_up.insert(id);
                drop(l);
                done(Swap::Lost);
                self.deliver(id, Swap::Lost);
                return id;
            }
            if l.hold || l.hold_next {
                l.hold_next = false;
                l.queued.push((id, token.to_owned(), outputs, done));
                return id;
            }
            id
        };
        let outcome = self.lose(self.swap_for(token, outputs));
        {
            let mut l = self.ledger();
            if l.hold_responses {
                l.responses.push((id, outcome, done));
                return id;
            }
        }
        done(outcome);
        self.deliver(id, outcome);
        id
    }

    fn deliver(&self, id: u64, outcome: Swap) {
        let wake = {
            let mut l = self.ledger();
            l.answers.insert(id, outcome);
            std::mem::take(&mut l.waiting)
        };
        for w in wake {
            w.wake();
        }
    }

    /// A submitted swap's answer, if it has come; otherwise `waker` is woken when one does.
    fn try_answer(&self, id: u64, waker: &Waker) -> Option<Swap> {
        let mut l = self.ledger();
        let a = l.answers.remove(&id);
        if a.is_none() {
            l.waiting.push(waker.clone());
        }
        a
    }

    /// Run `then` with the swap's outcome now, or at release while swaps are held.
    fn swap_later(&self, token: &str, then: Done) {
        let mut l = self.ledger();
        if l.hold {
            l.deferred.push((token.to_owned(), then));
            return;
        }
        drop(l);
        then(self.swap_now(token));
    }

    /// A wallet taking back its own proofs: NUT-07 state check, then a swap of the
    /// unspent ones. It honours outages. `true` with the outcome: the mint refused it
    /// because a keyset expired (12003), and the outcome is the NUT-07 check's.
    /// `check_down_unspent`: the flaw of reading an unanswered NUT-07 check after a 12003
    /// as every input unspent.
    fn reclaim_as(&self, token: &str, check_down_unspent: bool) -> (Reclaim, bool) {
        let mut l = self.ledger();
        if l.down {
            return (Reclaim::Blocked, false);
        }
        // Its NUT-07 check unanswered: nothing is decided, and nothing is sent.
        if l.state_down && !check_down_unspent {
            return (Reclaim::Blocked, false);
        }
        let Some(info) = l.tokens.get(token).cloned() else {
            return (Reclaim::SomeSpent, false);
        };
        // Refused because a keyset expired (12003, before any other check): the proofs', or
        // the reclaim's outputs' (the mint's active keyset); a NUT-07 check then says what
        // happened to the proofs.
        if info.proofs.iter().any(|p| l.proof_expired(*p)) || l.outputs_expired(l.next + 1) {
            let checked = if l.state_down {
                Reclaim::Expired // the flaw: an unanswered check read as every input unspent
            } else if info.proofs.iter().any(|p| l.claimed.contains(p)) {
                Reclaim::SomeSpent
            } else if info.proofs.iter().any(|p| l.reserved.contains(p)) {
                Reclaim::Pending
            } else {
                Reclaim::Expired
            };
            return (checked, true);
        }
        if info.proofs.iter().any(|p| l.reserved.contains(p)) {
            return (Reclaim::Pending, false);
        }
        let fresh: Vec<u64> = info
            .proofs
            .iter()
            .copied()
            .filter(|p| !l.claimed.contains(p) && !l.forged.contains(p))
            .collect();
        let all = fresh.len() == info.proofs.len();
        l.claimed.extend(fresh.iter().copied());
        l.next += 1;
        let outputs = l.next; // the reclaim's own outputs (NUT-13), restorable
        l.reclaimed.extend(fresh.iter().map(|p| (*p, outputs)));
        if l.lose_reclaim {
            l.lose_reclaim = false;
            return (Reclaim::Blocked, false);
        }
        if all {
            (Reclaim::All, false)
        } else {
            (Reclaim::SomeSpent, false)
        }
    }

    /// A third party claiming whatever is unclaimed, outages aside, in swaps at the mint:
    /// never a proof the mint holds reserved or lists expired. Whether it got any.
    fn steal(&self, token: &str) -> bool {
        let mut l = self.ledger();
        let Some(info) = l.tokens.get(token).cloned() else {
            return false;
        };
        let fresh: Vec<u64> = info
            .proofs
            .iter()
            .copied()
            .filter(|p| Self::claimable(&l, *p))
            .collect();
        let any = !fresh.is_empty();
        l.claimed.extend(fresh);
        any
    }

    fn claim_first(&self, token: &str) {
        let mut l = self.ledger();
        if let Some(p) = l.tokens.get(token).and_then(|i| i.proofs.first().copied()) {
            l.claimed.insert(p);
        }
    }

    /// The mistake of checking only the last proof's state (a flag overwritten in a
    /// loop) and then claiming every unclaimed proof.
    fn swap_checking_last_only(&self, token: &str) -> Swap {
        let mut l = self.ledger();
        let Some(info) = l.tokens.get(token).cloned() else {
            return Swap::Invalid;
        };
        if info.proofs.last().is_some_and(|p| l.claimed.contains(p)) {
            return Swap::Spent;
        }
        let fresh: Vec<u64> = info
            .proofs
            .iter()
            .copied()
            .filter(|p| !l.claimed.contains(p))
            .collect();
        l.claimed.extend(fresh);
        Swap::Claimed
    }

    #[must_use]
    pub fn claimed_any(&self, token: &str) -> bool {
        let l = self.ledger();
        l.tokens
            .get(token)
            .is_some_and(|i| i.proofs.iter().any(|p| l.claimed.contains(p)))
    }

    #[must_use]
    pub fn claimed_all(&self, token: &str) -> bool {
        let l = self.ledger();
        l.tokens
            .get(token)
            .is_some_and(|i| i.proofs.iter().all(|p| l.claimed.contains(p)))
    }

    /// Run the oldest held swap, or deliver the oldest held response; hold the rest.
    fn release_oldest(&self) {
        let (queued, response) = {
            let mut l = self.ledger();
            if l.queued.is_empty() {
                let r = (!l.responses.is_empty()).then(|| l.responses.remove(0));
                (None, r)
            } else {
                (Some(l.queued.remove(0)), None)
            }
        };
        if let Some((id, token, outputs, done)) = queued {
            let outcome = self.lose(self.process(&token, outputs));
            done(outcome);
            if !self.ledger().gave_up.remove(&id) {
                self.deliver(id, outcome);
            }
        }
        if let Some((id, outcome, done)) = response {
            done(outcome);
            self.deliver(id, outcome);
        }
    }

    fn release(&self) {
        let (queued, responses, deferred, waiting) = {
            let mut l = self.ledger();
            l.hold = false;
            l.hold_next = false;
            l.hold_responses = false;
            l.hold_keys = false;
            (
                std::mem::take(&mut l.queued),
                std::mem::take(&mut l.responses),
                std::mem::take(&mut l.deferred),
                std::mem::take(&mut l.waiting),
            )
        };
        for w in waiting {
            w.wake();
        }
        for (id, token, outputs, done) in queued {
            let outcome = self.lose(self.process(&token, outputs));
            done(outcome);
            if !self.ledger().gave_up.remove(&id) {
                self.deliver(id, outcome);
            }
        }
        for (id, outcome, done) in responses {
            done(outcome);
            self.deliver(id, outcome);
        }
        for (token, then) in deferred {
            then(self.swap_now(&token));
        }
    }
}

/// A defect planted in a mock engine, to prove the adversary suite catches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeederFlaw {
    AcceptsOverpay,
    AcceptsForeignMint,
    PrefixMint,
    /// Verifies DLEQs by fetching keys from the token's own mint, before the mint check.
    DleqAtTokenMint,
    AcceptsBadTokens,
    NoDleqAccepted,
    TooManyProofsAccepted,
    InvalidNoBan,
    NoBanOnSpent,
    SpentCheckLastProof,
    /// Checks proof states and swaps only the unspent ones, crediting the whole token.
    SwapsUnspentSubset,
    WindowOffByOne,
    /// Counts the window across the peer's videos (the rule before the fourth audit).
    WindowAcrossVideos,
    ClaimsBeforeChecking,
    IgnoresStale,
    /// A `bad-mint` or `overpaid` refusal credits the claim anyway.
    RefusalCredits,
    /// An `underpaid` or `overpaid` refusal moves the watermark to `upto_chunk`.
    RefusalAdvancesAcked,
    /// A refusal claims the token's first proof.
    ClaimsOnRefusal,
    WrappingMul,
    PayIgnoresBan,
    /// Checks the ban when a payment arrives, not when its turn comes.
    BanCheckedBeforeTurn,
    AdmitIgnoresBan,
    BanPerVideo,
    FreshWindowPerHello,
    QuoteForgetsAccount,
    /// Quotes without waiting for a payment in progress.
    QuoteWithoutTurn,
    /// Creates an account on `hello`.
    HelloCreatesAccount,
    /// Does not count waiting hellos toward the session cap.
    HelloWaitUncapped,
    /// A hello dropped while it waits keeps counting toward the session cap.
    HelloWaitLeaksOnDrop,
    /// Quotes `spent_total` summed across the peer's videos.
    QuoteSpentPeerWide,
    /// Quotes `served` summed across the peer's videos.
    QuoteServedPeerWide,
    /// Acks `spent_total` summed across the peer's videos.
    AckSpentPeerWide,
    SessionIdAnyPeer,
    SessionCapOffByOne,
    /// Counts every session ever opened, not the open ones.
    SessionCapLifetime,
    /// Caps open sessions per (peer, video), not per peer.
    SessionCapPerVideo,
    HelloAnyVideo,
    CountsDistinctFiles,
    AdmitsForeignChunks,
    /// Treats a chunk as covered if any of the peer's accounts has credit.
    CoveredPeerWide,
    NoGlobalCap,
    GlobalCapGt,
    /// Nets every account's credit against every other's debt.
    GlobalCapNetsCredit,
    /// Keys the global count by (peer, chunk), so a peer's videos collide.
    LiveKeyedByPeer,
    BanForgetsDebt,
    /// Tests the global cap before the chunk's own pre-payment.
    CapBeforeCredit,
    /// Logs covered admissions as debt.
    CoveredLoggedAsDebt,
    DebtNeverAges,
    /// Ages debt after one second (a unit mix-up).
    AgeTtlOneSecond,
    /// Lets ageing free the peer's own window too.
    PeerDebtAges,
    /// Keeps the cap as a counter that both ageing and payment decrement, so a chunk
    /// paid and then aged (or aged and then paid) is freed twice; saturating.
    CountFreedTwice,
    /// The same, wrapping below zero (a release build without overflow checks).
    CountFreedTwiceWrapping,
    /// Keeps paid chunks in the global count.
    PaidDebtStaysCounted,
    /// Frees all of the account's debt on any payment, not just what it covers.
    CreditFreesAllDebt,
    /// Frees the debt it saw when it checked the payment, not what the swap covers.
    CreditFromSnapshot,
    /// Forgets accounts that have paid.
    ForgetsPaidAccounts,
    /// Never forgets an account.
    NeverForgets,
    /// Forgets never-paid accounts with a session open.
    ForgetsOpenAccounts,
    /// Forgets after `debt_ttl`, not `account_ttl`.
    ForgetsAtDebtTtl,
    /// Counts an account idle from its last admission, not its last session's close.
    ForgetsFromLastAdmission,
    /// Forgets accounts never served, not accounts never paid: a paid-ahead one is lost.
    ForgetsUnserved,
    /// Counts an account's sessions as closed when the first of them closes.
    ForgetsOnFirstClose,
    /// Keeps a closed session's id.
    SessionIdLeaks,
    /// Keeps the record of a payment dropped mid-swap after its swap lands.
    LandKeepsFinished,
    /// Forgets a peer's accounts when its ban expires.
    BanExpiryResetsAccounts,
    /// Records a ban for a peer with no account.
    BansWithoutAccount,
    /// Bans only a peer with an account on the offending video, not on any video.
    BanNeedsThisAccount,
    /// Bans a peer with an account on the offending video, or a paid one elsewhere.
    BanNeedsPaidOrThis,
    /// Checks a hello's ban only before it waits for the account's turn.
    HelloNoBanRecheck,
    /// Leaves an empty waiter list behind for every account that ever had one.
    WaitingKeptEmpty,
    /// Ages debt out of the global count but never trims its log.
    DebtLogUntrimmed,
    /// Accepts any `debt_ttl`, `account_ttl` or `ban_ttl` above the minimums.
    NoTtlCeiling,
    /// Validates mint URLs as a test deployment's writer would (loopback http allowed).
    ValidateAllowsLoopback,
    /// Keeps bans for ever.
    BansNeverExpire,
    /// Lets a ban expire after `debt_ttl`, not `ban_ttl`.
    BanExpiresEarly,
    /// Skips the configuration checks.
    NoValidate,
    /// Refuses `account_ttl` equal to `debt_ttl`, which NFX-07 allows.
    EqualTtlRefused,
    /// Accepts a global cap above the ceiling.
    NoCapCeiling,
    /// Accepts a `ban_ttl` below `debt_ttl`.
    NoBanTtlCheck,
    /// Acknowledges first and swaps later (the design the second audit retired).
    AckBeforeSwap,
    /// Claims, then credits only if the `pay` future is still alive to see the answer.
    ClaimThenAwaitCredit,
    /// Waits for the mint forever: no 60 s deadline.
    NoDeadline,
    /// Counts the deadline from the swap's sending, not the payment's arrival.
    DeadlineFromSwap,
    /// Waits for keys without registering with the clock.
    FetchNoClockWatch,
    /// Sends the swap after the payment's deadline, if nothing marked it abandoned.
    SendIgnoresDeadline,
    /// Checks the watermark and the amount only before the key fetch, not again as the
    /// swap is sent.
    NoRecheckAtSend,
    /// Re-checks only the watermark as the swap is sent, not the amount.
    RecheckStaleOnly,
    /// Answers `mint-unavailable` at the deadline even when the outcome is already known.
    DeadlineBeatsSettled,
    /// Treats a swap as late only once something has marked it abandoned, not by the
    /// clock, so a dropped `pay` is never abandoned.
    LateByFlagOnly,
    /// Bans on a late `spent` from a swap it had abandoned.
    LateOutcomeBans,
    /// Does not credit a late claim from a swap it had abandoned.
    LateClaimNotCredited,
    /// Credits a late claim but leaves its chunks in the global count.
    LateClaimKeepsDebt,
    /// Frees, for a late claim, only the debt seen when the payment was checked.
    LateCreditFromSnapshot,
    /// Answers a swap that got no answer at once, without a retry.
    NoRetry,
    /// Takes a retry's `spent` for a double spend, and bans on it.
    RetryBansOnSpent,
    /// Never learns the outcome of a swap that got no answer.
    NeverRestores,
    /// Restores by token: any earlier swap of the same proofs counts as this one.
    RestoreByToken,
    /// Takes a retry's `spent` for its own first attempt, without a restore.
    RetrySpentIsOwn,
    /// Keeps an unknown outcome to learn only while its payment is in time.
    UnknownOnlyInTime,
    /// Keeps an unknown outcome to learn only while its `pay` is awaited.
    UnknownOnlyWhileAwaited,
    /// Learns unknown outcomes only when a `hello` comes.
    LearnOnHelloOnly,
    /// Keeps swapping an account's payments while one has an unknown outcome.
    UnknownUnbounded,
    /// Refuses a token of exactly 64 proofs.
    ProofCapOffByOne,
    /// Counts only lost answers as unknown, not a swap still unanswered in flight.
    InFlightNotUnknown,
    /// Refuses every account's payments while any account has an unknown swap.
    UnknownGlobal,
    /// Refuses a peer's payments on every video while one account has an unknown swap.
    UnknownPeerWide,
    /// Takes a retry's `spent`, with its restore unanswered, as not its own.
    RetrySpentRestoreDownKnown,
    /// Forgets an account holding a swap of unknown outcome.
    ForgetsUnknownAccount,
    /// Credits a late claim only to an account that already exists.
    LateCreditNeedsAccount,
    /// Takes unsigned outputs as nothing, whether or not an input is spent.
    NotSignedFinal,
    /// Never takes unsigned outputs as nothing, even with an input spent.
    NotSignedStaysUnknown,
    /// Leaves a swap abandoned in flight unknown until its answer comes, whatever a
    /// NUT-07 check and a restore could show.
    InFlightNeverDecided,
    /// Refuses every account's payments while any account has a swap in flight.
    InFlightGlobal,
    /// Refuses a peer's payments on every video while one of its swaps is in flight.
    InFlightPeerWide,
    /// Applies the one-unknown bound only to a key that has an account.
    UnknownNeedsAccount,
    /// Counts a swap in flight only once its `pay` future has answered.
    InFlightFinishedOnly,
    /// Credits no late claim to a peer banned since.
    LateClaimSkipsBanned,
    /// Takes a lost answer as unknown even once its payment's outcome was decided, so a
    /// claim a restore showed is learnt, and credited, again.
    DecidedLostRelearnt,
    /// Restores a swap's outputs before checking its inputs, so a swap processed between
    /// the two reads looks like one that can no longer go through.
    RestoreBeforeInputs,
    /// Drops a decided payment's record but leaves the account's turn held by it.
    DecidedKeepsTurn,
    /// Takes an unanswered NUT-07 check as "an input spent".
    StateDownIsSpent,
    /// Takes a pending input (reserved by a request the mint is processing) as spent.
    PendingIsSpent,
    /// Takes a retry refused as pending as "nothing happened", not as unknown.
    RetryPendingKnown,
    /// Takes a first attempt refused as pending for a double spend, and bans.
    PendingBans,
    /// Stops learning lost answers at the first one still unknown.
    LearnStopsAtFirstUnknown,
    /// Leaves swaps abandoned in flight unread while any lost answer is still unknown.
    InFlightWaitsForUnknown,
    /// Stops learning swaps abandoned in flight at the first one still unknown.
    InFlightStopsAtFirstUnknown,
    /// Applies a read's decision without checking whether the swap's answer landed while
    /// it read, so a claim is credited twice.
    NoRecheckAfterRead,
    /// A decided swap releases whatever turn its account holds, not only its own.
    DecidedFreesAnyTurn,
    /// Releases a decided swap's turn without waking, or clearing, what waits for it.
    DecidedLeavesWaiters,
    /// Reads each undecided swap with its own two requests, not all of them in one batch.
    ReadsPerSwap,
    /// Keeps an undecided swap whose inputs stay unspent forever.
    UndecidedNeverExpires,
    /// Keeps a swap abandoned in flight whose inputs stay unspent forever.
    FlightNeverExpires,
    /// Drops an undecided swap whose inputs stay unspent, instead of completing it.
    ExpiryDrops,
    /// Takes a read the mint refuses as too large for the whole batch, never splitting it.
    NoSplitOnLimit,
    /// Reads every account's unknown swaps at any account's entry.
    ReadsOtherAccounts,
    /// Credits a lost answer's claim without checking that another learner has not
    /// credited it already.
    LostNoRecheck,
    /// Records a first attempt refused as pending as a swap of unknown outcome.
    PendingFirstUnknown,
    /// Completes a swap with fresh outputs, not its own.
    CompleteFreshOutputs,
    /// Takes a completion answered `spent` as nothing, without a restore.
    CompleteSpentIsNothing,
    /// Takes a completion refused as pending as nothing.
    CompletePendingIsNothing,
    /// Leaves a swap whose completion's outputs are refused for good unknown forever.
    CompleteRefusedStaysUnknown,
    /// Leaves a swap whose completion is refused as invalid unknown forever.
    CompleteInvalidStaysUnknown,
    /// Splits a read the mint left unanswered, as if it had refused it as too large.
    SplitOnUnanswered,
    /// Joins a split read's answers in the order they came back, not the swaps' order.
    SplitMisaligned,
    /// A `hello` reads every account's unknown swaps.
    HelloReadsAll,
    /// An account's own entries read every unknown swap of its peer, on any video.
    ScopeByPeer,
    /// An account's own entries read its swaps at every entry, however often, even a
    /// flood of hellos or of payments sending one token again.
    OwnReadsUnbounded,
    /// Takes a retry whose outputs the mint refuses for good as "nothing happened",
    /// without a restore.
    RetryRefusedIsKnown,
    /// A payment's own reads and completions run past its deadline.
    OwnReadsIgnoreDeadline,
    /// A payment of new proofs always reads afresh, however many reads that second.
    OwnReadsPerProofs,
    /// Reuses a read made for the same peer's other account.
    ReuseByPeer,
    /// Settles a completion that got no answer by a restore, as if it had been refused.
    CompleteLostByRestore,
    /// Bans on a completion refused as invalid.
    CompleteInvalidBans,
    /// Takes a completion that never reached the mint as nothing.
    CompleteUnreachableNothing,
    /// Takes a completion answered `spent` whose restore goes unanswered as nothing.
    CompleteRestoreDownNothing,
    /// Takes a retry refused for good whose restore goes unanswered as nothing.
    RetryRefusedRestoreDownKnown,
    /// Takes a retry refused for good as a claim.
    RetryRefusedIsClaim,
    /// Takes a retry that got no answer as nothing.
    RetryLostIsNothing,
    /// Bans on a first attempt whose outputs the mint refuses (the seeder's stale keyset).
    FirstRefusedBans,
    /// Records a first attempt whose outputs the mint refuses as a swap of unknown outcome.
    FirstRefusedUnknown,
    /// A payment's reads get their own 60 s, from when they start, not from its arrival.
    ReadDeadlineFromRead,
    /// A payment's completion is sent, and waited for, past its deadline.
    CompleteIgnoresDeadline,
    /// Checks the watermark again before the payment's own read, not after it: a late claim
    /// that read learns is not looked at.
    RecheckBeforeRead,
    /// A payment reads its account's unknown swaps before its key fetch and DLEQ check.
    ReadsBeforeKeyFetch,
    /// A payment reads its account's unknown swaps before its amount check.
    ReadsBeforeAmount,
    /// Never prunes the record of an account's reads.
    OwnReadsNeverPruned,
    /// Adds a read to the record of the second it began in, not the one it is made in.
    NoSecondReset,
    /// A `hello` checks for a read to reuse, awaits its own read, and records it only
    /// then: two at once both read.
    HelloAwaitsRead,
    /// A `hello` reads before it waits for the payment in progress.
    HelloReadsBeforeTurn,
    /// Settles a retry refused as invalid by a restore, as a completion is: no ban.
    RetryInvalidByRestore,
    /// Settles a retry refused because a keyset expired by a restore at once, even while an
    /// input is pending.
    RetryExpiredAtOnce,
    /// Settles a completion refused because a keyset expired by a restore at once, even
    /// while an input is pending.
    CompleteExpiredAtOnce,
    /// Bans on a first attempt refused because a keyset expired.
    FirstExpiredBans,
    /// Records a first attempt refused because a keyset expired as a swap of unknown
    /// outcome.
    FirstExpiredUnknown,
    /// Takes an unanswered NUT-07 check of a retry refused because a keyset expired as no
    /// input pending, and settles it by restore.
    ExpiredRestoreOnStateDown,
    /// Takes an unanswered restore of a retry refused because a keyset expired as nothing.
    ExpiredRestoreDownKnown,
    /// Never settles a retry refused because a keyset expired: it stays unknown.
    RetryExpiredStaysUnknown,
    /// A retry's restore, unanswered, is waited for past the payment's deadline.
    RetryRestoreUncapped,
    /// A completion's restore, unanswered, is waited for past the payment's deadline.
    CompleteRestoreUncapped,
    /// A payment's reads get 60 s from when its turn comes, not from its arrival.
    ReadDeadlineFromTurn,
    /// An entry reusing a read still under way answers without waiting for its result.
    ReuseWithoutWaiting,
    /// An entry reusing a read still under way waits for it one poll only.
    ReuseWaitsOnePoll,
    /// An entry reusing a read waits while any read of its account is under way, whatever
    /// the second (the eighteenth rework's wait): it can outlive its deadline.
    WaitsWhileReading,
    /// Takes a read abandoned before it was back as a result to reuse, so the entries
    /// waiting for it answer without one.
    AbandonedReadReused,
    /// A read abandoned before it is back gives its place in the second back (the
    /// nineteenth rework's), so dropped entries send reads without bound.
    AbandonedFreesItsPlace,
    /// An entry waiting for a read whose second ends first answers without reading.
    SecondEndReturns,
    /// Reuses a read whatever it covered: one sent before a swap became unknown serves an
    /// entry after it, whose quote then misses that swap's claim.
    ReuseByCoverageBlind,
    /// A payment waits while any read of its account is under way, whatever the second.
    PayWaitsForRead,
    /// A payment whose second's two reads were spent without a result answers at once,
    /// instead of reading in the next second.
    PayNextSecondReturns,
    /// Past two reads a second, an entry reads again rather than wait for one under way.
    PastTwoReadsAgain,
    /// Checks the second's reads, and takes its read's place only once the read is sent
    /// (the twenty-first rework's): entries on other threads checking meanwhile all read.
    PlaceTakenAfterCheck,
    /// Sends, and records, a read at or past its entry's deadline: nothing reaches the mint
    /// then, yet a later entry reuses it as a read of the account's swaps.
    ReadsPastDeadline,
    /// Fixes what a read covers when it comes back, not when it is sent: a swap that became
    /// unknown while it was under way counts as read.
    CoverageFixedAtBack,
    /// A payment is served by a read whatever it covered.
    PayReuseCoverageBlind,
    /// Past two reads a second, a read serves whatever it covered.
    PastTwoCoverageBlind,
    /// A payment's own proofs' read serves it whatever it covered.
    OwnProofsCoverageBlind,
    /// A read covers only swaps whose answer was lost, not swaps abandoned in flight.
    CoversLostOnly,
    /// A `hello` that waited for a payment reuses a read sent before its wait ended (the
    /// payment's own), and quotes without a claim that landed meanwhile.
    WaitedHelloReusesEarlierRead,
    /// A waited `hello` takes its floor from the account's latest free at each look (the
    /// twenty-second rework's): a later free moves it, and it stops sharing a read sent
    /// after its own wait ended.
    FloorAtLatestFree,
    /// A waited `hello` takes its floor as the reads sent by its first look (the twenty-second
    /// rework's first form): hellos woken by one payment cannot share a read.
    FloorAtLook,
    /// Notes a freed turn's floor only at the second's first free: a hello that waited for a
    /// later payment is served by that payment's own read.
    FloorFirstFreeOnly,
    /// Past two reads a second, a waited `hello` is served by any read, its floor ignored.
    FloorIgnoredPastTwo,
    /// A waited `hello` counts only the reads after its floor toward the second's two.
    WaitedCountsAfterFloor,
    /// A read's place covers nothing until its requests are back: an entry on another
    /// thread meanwhile reads again rather than share it.
    CoversSetAfterSend,
    /// Judges an entry's time left once, at its first look: a payment that waits into its
    /// deadline sends, and records, a read there.
    InTimeOnce,
    /// A late claim frees every unpaid chunk of its account from the global count, not only
    /// those it covers.
    LateCreditFreesAll,
    /// Completes a swap left unknown `debt_ttl` after it became unknown, not `account_ttl`:
    /// its payer's time to take the proofs back is cut short.
    CompletesAtDebtTtl,
    /// Takes signed outputs for a claim only when the NUT-07 check answered.
    SignedNeedsStates,
    /// Takes a completion refused for good (its outputs' keyset rotated out) as nothing,
    /// without the restore that would show a first request's claim.
    CompleteRefusedIsNothing,
    /// Bans on a double spend only a peer with an account that was served, not one whose only
    /// account is pre-paid.
    BanNeedsServed,
    /// Wakes only the first entry waiting for a freed turn, and drops the others' wakers.
    WakesOneDropsRest,
    /// A payment refused before its swap keeps its account's turn until its deadline.
    RefusalKeepsTurn,
    /// Decides whether an outcome landed in time from a clock read before its settlement,
    /// ignoring the payment's abandonment meanwhile.
    LandStaleClock,
    /// Admits in two steps, the checks and the count under separate locks.
    AdmitSplitLock,
    /// Retries a swap whose answer was lost at its payment's deadline too, not only before.
    RetryAtDeadline,
    /// Checks a `hello`'s session id only as it arrives, not again after its wait: two
    /// hellos of one id that waited together both open.
    HelloNoSessionRecheck,
    /// Gives every `hello` a floor, not only one that waited: a hello that did not wait
    /// reads again rather than reuse the second's read.
    FloorWithoutWait,
    /// Swaps to outputs of a keyset that expires sooner than twice `account_ttl` away.
    IgnoresKeysetExpiry,
    /// Measures the outputs' keyset margin by `ban_ttl`, not `account_ttl`.
    KeysetMarginBanTtl,
    /// Refuses a keyset exactly twice `account_ttl` away too.
    KeysetMarginInclusive,
    /// Measures the outputs' keyset margin by the longer of `account_ttl` and `ban_ttl`.
    KeysetMarginMaxTtl,
    /// Applies the outputs' keyset rule after the payment's own read, not before it.
    KeysetAfterRead,
    /// Applies the outputs' keyset rule before every other check.
    KeysetFirst,
    /// The eighteenth rework's rule: a swap whose outputs' keyset has expired is decided by
    /// its inputs alone, spent being the claim (so a reclaim or a double spend is credited).
    ExpiredSpentIsClaim,
    /// A retry's resend, unanswered, is waited for past the payment's deadline.
    RetryResendUncapped,
    /// The NUT-07 check settling a 12003, unanswered, is waited for past the deadline.
    ExpiredStateUncapped,
    /// Never takes over a turn held past its deadline.
    NoTakeover,
    /// Lets hellos take over a turn held past its deadline, but not payments.
    PayNoTakeover,
    /// Takes over a turn only a second after its deadline.
    TakeoverAt61,
    /// Waits for a turn without registering with the clock.
    TurnNoClockWatch,
    /// A settling payment releases whatever turn the account holds, not only its own.
    StaleTurnFrees,
    OutageBans,
    OutageCredits,
    SpentTotalCountsRefused,
    SpentTotalPerSession,
    /// Handles one account's payments concurrently.
    ConcurrentPays,
    /// A waited `hello` notes its floor as it starts to wait (its arrival), not
    /// as it finds the turn free: a read the payment sent during the wait serves it.
    FloorAtArrival,
    /// A waited `hello`'s floor noted in one second is applied to a later
    /// second's reads too.
    FloorAcrossSeconds,
    /// `take_place` starts a new second's reads but keeps the old `freed`.
    FreedKeptAtNewSecond,
    /// An entry waits for a read under way that serves it whatever its time
    /// left: its wait ends with the second, not at its deadline.
    WaitReadPastDeadline,
    /// An entry whose second's two are spent waits for the next second whatever
    /// its time left.
    NextSecondPastDeadline,
    /// A read's guard marks its place by index alone, whatever the second.
    ReadingIgnoresSecond,
    /// A read is counted in the second its entry first looked, not the one it
    /// is sent in.
    CountedAtFirstLook,
    /// An entry waits for any read of its account under way, serving it or not.
    WaitsForAnyUnderWay,
    /// A payment is served by any read, as a hello is.
    PayServedByAnyRead,
    /// A `hello` waits only for the payment holding the turn as it arrives: once that one
    /// has left it, the `hello` goes on, whatever payment holds the turn by then.
    HelloWaitsForFirstOnly,
    /// Notes a turn held past its payment's deadline as freed when it is taken over or
    /// released, not at the deadline: a read sent in between serves no `hello` behind it.
    FreedAfterDeadline,
    /// A waited `hello` takes its floor at the first freeing it sees (a new payment holding
    /// the turn), not at the last before it finds the turn free: that payment's own read
    /// serves it.
    FloorAtFirstWake,
    /// A `hello` behind several payments quotes the account as it stood when the payment it
    /// first waited for left the turn.
    QuoteAtFirstWake,
    /// A waiting `hello` stops counting toward the session cap once the payment it first
    /// waited for has left the turn, though it waits on behind the next.
    HelloUncountedAfterFirst,
    /// A waited `hello`'s floor is applied to reads that are back, not to reads under way:
    /// it waits for a read sent before its wait ended.
    FloorIgnoredForUnderWay,
    /// A `hello` waits for any read of its account under way, serving it or not.
    HelloWaitsForAnyUnderWay,
    /// A payment's read is counted in the second the payment first looked, not the one it
    /// is sent in.
    PayCountedAtFirstLook,
    /// An entry at or past its deadline takes a read's place, and abandons it, before it
    /// finds it may send nothing: a read never sent is counted.
    PlaceTakenPastDeadline,
    /// A payment waiting for its account's turn is answered only once it takes the turn,
    /// not at its own deadline.
    TurnWaitPastDeadline,
    /// Counts the deadline to which a payment holds the turn from when it took the turn,
    /// not from its arrival.
    HolderDeadlineFromTurn,
    /// Notes a turn held past its payment's deadline as freed when an entry takes it over,
    /// not at the deadline.
    TakeoverFreedAfterDeadline,
    /// Notes a turn held past its payment's deadline, with no swap sent, as freed when that
    /// payment is answered or dropped, not at the deadline.
    ReleaseFreedAfterDeadline,
    /// Notes a turn held past its payment's deadline, its swap in flight, as freed when
    /// that payment is answered `mint-unavailable`, not at the deadline.
    AnswerFreedAfterDeadline,
    /// Notes a turn held past its payment's deadline as freed when that payment's swap
    /// lands, not at the deadline.
    LandFreedAfterDeadline,
    /// Takes a turn freed in the second before its payment's deadline as freed at the
    /// deadline: a read sent earlier in that second serves the `hello` behind it.
    DeadlineSecondEarly,
    /// Takes a turn freed in its payment's deadline second as freed then, not at the
    /// deadline: a read sent earlier in that second serves no `hello` behind it.
    DeadlineSecondLate,
    /// A swap learnt as nothing, its answer lost or abandoned in flight, frees its account's
    /// chunks up to the payment from the global count, though nothing was paid for them.
    LateNothingFreesDebt,
    /// A payment checks its peer's ban without first expiring the bans past `ban_ttl`.
    PayBanNotAged,
    /// Refuses a request for a file of another video, or of none, but logs it in the global
    /// count as an unpaid chunk.
    ForeignAdmitCounts,
    /// Refuses a banned peer's request, but counts it as an unpaid chunk, to its account and
    /// in the global count.
    BannedAdmitCounts,
    /// A payment refused while its account's earlier swap is unknown drops the account's
    /// chunks from the log that ages them: they stay in the global count for good.
    PayDropsDebtLog,
    /// A swap abandoned in flight and learnt as nothing frees its account's chunks up to the
    /// payment from the global count; one whose answer was lost frees none.
    NothingInFlightFreesDebt,
    /// Refuses a banned peer's request, but counts it to its account (its window and its
    /// `served`), not to the global count.
    BannedAdmitCountsToAccount,
    /// A swap learnt as nothing by its account's own `hello` or payment frees the account's
    /// chunks up to the payment from the global count; one the sweep learns frees none.
    OwnNothingFreesDebt,
    /// A swap learnt as nothing by a payment of its account frees the account's chunks up
    /// to the payment from the global count; one a `hello` or the sweep learns frees none.
    PayNothingFreesDebt,
    /// A swap abandoned in flight and learnt as nothing by its account's own `hello` or
    /// payment frees the account's chunks up to the payment from the global count; one
    /// whose answer was lost, or that the sweep learns, frees none.
    OwnNothingInFlightFreesDebt,
    /// A swap abandoned in flight and learnt as nothing by a payment of its account frees
    /// the account's chunks up to the payment from the global count; one whose answer was
    /// lost, or that a `hello` or the sweep learns, frees none.
    PayNothingInFlightFreesDebt,
    /// A request checks its peer's ban without first expiring the bans past `ban_ttl`.
    AdmitBanNotAged,
    /// A session's `banned` answers without first expiring the bans past `ban_ttl`.
    BannedNotAged,
    /// A `hello` that took a turn over from a payment past its deadline reads nothing: its
    /// quote misses a claim that reached the mint before that deadline.
    HelloTakeoverSkipsRead,
    /// A payment that took a turn over from a payment past its deadline does not read the
    /// abandoned swap: while that outcome is unknown, it is answered at once.
    PayTakeoverSkipsRead,
    /// A payment that took a turn over from a payment past its deadline skips the ban
    /// check: a banned peer's payment is swapped.
    PayTakeoverSkipsBan,
    /// A `hello` that took a turn over from a payment past its deadline skips the ban check
    /// after its wait: a peer banned while it waited opens a session.
    HelloTakeoverSkipsBanRecheck,
    /// Uses keys it finds at or after the payment's deadline: its DLEQ and amount are
    /// judged late, and their refusal is the answer.
    LateKeysUsed,
    /// Reads the watermark again as the swap is sent before judging the payment's deadline:
    /// past it, the payment is refused `stale` or by amount on what was learnt late.
    RecheckPastDeadline,
    /// Takes an outcome settled in its payment's deadline second as in time: it is the
    /// answer, and a spent one bans.
    LandInTimeAtDeadline,
    /// A `hello` that finds its account's turn held past a payment's deadline, and takes it
    /// over, is taken as having waited: no read sent earlier in that second serves it.
    LateArrivalWaited,
    /// A retry answered `spent` whose restore finds its outputs unsigned leaves the swap
    /// unknown: the account's payments are refused until a read decides it.
    RetrySpentUnsignedStaysUnknown,
    /// Checks a payment's watermark before its peer's ban: a banned peer's stale payment is
    /// refused `stale`.
    StaleBeforeBan,
    /// Checks a payment's structure before its peer's ban: a banned peer's unreadable or
    /// malformed token is refused `bad-token`.
    StructureBeforeBan,
    /// A payment dropped before its swap is sent (its connection closed) holds its
    /// account's turn to its deadline: only an answer or the deadline frees it.
    DropHoldsTurn,
    /// Uses keys it finds in the payment's deadline second, as in time: its DLEQ and amount
    /// are judged, and their refusal is the answer.
    KeysInDeadlineSecondUsed,
    /// A retry refused for good whose restore finds its outputs unsigned leaves the swap
    /// unknown: the account's payments are refused until a read decides it.
    RetryRefusedUnsignedStaysUnknown,
    /// A retry refused because a keyset expired (12003), no input pending, whose restore
    /// finds its outputs unsigned leaves the swap unknown.
    RetryExpiredUnsignedStaysUnknown,
    /// A `hello` checks its peer's ban after its wait, before its reads, and not as it
    /// answers: a peer banned while it reads opens a session.
    HelloBanCheckBeforeRead,
    /// Checks a payment's peer's ban last, after its watermark, structure, mint, DLEQ and
    /// amount: a banned peer's payment is refused for any of those first.
    BanCheckedLast,
    /// A `hello` checks its peer's ban only as it answers, not as it arrives: a banned
    /// peer's `hello` waits for its account's turn, and reads, before it is refused.
    HelloBanNotAtArrival,
    /// A payment that took a turn over from a payment past its deadline reads the abandoned
    /// swap as its turn comes, before its ban and its other checks: a banned peer's payment
    /// costs the mint reads.
    TakeoverReadsBeforeChecks,
    /// A payment that took a turn over from a payment past its deadline reads the abandoned
    /// swap after its ban check, before its watermark and its other checks: a payment it
    /// then refuses costs the mint reads.
    TakeoverReadsBeforeStale,
    /// A payment that took a turn over from a payment past its deadline reads the abandoned
    /// swap once its keys come, before its DLEQ and amount checks: a payment it then
    /// refuses costs the mint reads.
    TakeoverReadsBeforeAmount,
    /// A payment that took a turn over from a payment past its deadline skips the watermark
    /// check: one for chunks already paid is refused by its amount, not `stale`.
    TakeoverStaleSkipped,
    /// A payment that took a turn over from a payment past its deadline checks its peer's
    /// ban without first expiring the bans past `ban_ttl`: a ban that lapsed while nothing
    /// came from the peer refuses it.
    TakeoverBanNotAged,
    /// A payment dropped once its swap is sent (its connection closed) is abandoned: its
    /// outcome, however soon it comes, is settled as late, and a spent one bans nobody.
    DropAbandonsInFlight,
    /// A payment that took a turn over from a payment past its deadline reads without its
    /// deadline: an unanswered read keeps it past its deadline.
    TakeoverReadsWithoutDeadline,
    /// A `hello` checks its peer's ban again as it answers only if it waited: one that read
    /// at once, its peer banned during that read, opens a session.
    HelloRecheckOnlyAfterWait,
    /// Marks a payment's swap sent before it judges the deadline: a payment answered at its
    /// deadline without a swap leaves an unknown one behind, and its account's next payment
    /// is refused.
    SentBeforeExpiry,
}

/// A defect planted in a mock viewer, to prove the adversary suite catches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewerFlaw {
    PaysAhead,
    IgnoresBadAck,
    PaysAtTheWindow,
    PaysAtFullWindow,
    /// Pays its own price cap instead of the quoted price.
    PaysAtCap,
    AcceptsSecondQuote,
    AcceptsUnsolicitedAck,
    IgnoresSpentTotal,
    AckAcceptsInflated,
    NoReclaim,
    ReclaimsFirstProofOnly,
    NoReclaimUnlessSpent,
    /// Pays again after `mint-unavailable` whatever the reclaim found.
    IgnoresReclaimOutcome,
    /// A retried reclaim ignores proofs found spent.
    RetryIgnoresSpent,
    LastPayIgnoresStop,
    /// Pays at session end while a reclaim is incomplete.
    LastPayIgnoresReclaim,
    PaysForRefused,
    /// Un-owes a refused request only while it is unpaid, so a paid one is paid twice.
    RefusedNoCredit,
    /// Un-owes two chunks per refusal.
    RefusedTwice,
    /// Never pays ahead after a refusal, so a full cap locks it out.
    NoPayAhead,
    /// Pays ahead half a window per refusal, whatever credit it holds.
    PayAheadUnbounded,
    /// Keeps paying ahead after a single refusal.
    PayAheadSticky,
    /// Pays ahead while a reclaim is incomplete.
    PayAheadIgnoresReclaim,
    /// Pays ahead over a payment in flight.
    PayAheadIgnoresPending,
    TrustsQuote,
    /// Adopts a quote below its ledger.
    ResyncsDown,
    /// Settles an unsettled payment when `spent_total` alone matches.
    SettleOnSpentOnly,
    /// Settles an unsettled payment when `accepted_upto` alone matches.
    SettleOnUptoOnly,
    /// Settles a payment awaiting a quote when `accepted_upto` alone matches.
    SettleLostOnUpto,
    /// Settles a payment awaiting a quote when `spent_total` alone matches.
    SettleLostOnSpentOnly,
    /// Settles a payment awaiting a quote on another video's quote.
    SettleLostAnyLedger,
    /// Reports a payment awaiting a quote on every ledger of the standing.
    AwaitingQuoteAnyLedger,
    /// Files a lost payment a sibling's retried reclaim found under the sibling.
    RetryAsSelf,
    /// Reclaims a closed session's unsettled payment only from its own ledger.
    CatchUpOwnOnly,
    /// Frees the standing's in-flight slot when a session ends.
    EndClearsInFlight,
    /// Pays the last payment over another video's payment in flight.
    LastPayIgnoresOtherInFlight,
    /// Pays the last payment over its own payment in flight.
    LastPayIgnoresOwnPending,
    /// Takes any quoted `window`, however large.
    NoWindowCeiling,
    /// Keeps paying after any number of `mint-unavailable` answers in a row.
    NoUnavailableBudget,
    /// Treats a refused `hello` as a refused payment, and reclaims at once.
    HelloRefusalReclaims,
    /// Lets `timeout` act on a payment an earlier session left unsettled.
    TimeoutTouchesUnsettled,
    /// Ignores a `rej` that answers no payment.
    UnsolicitedRejIgnored,
    /// Stops for good when a reclaim finds proofs spent, whatever a later quote shows.
    LostIsFinal,
    /// Resumes paying on a quote that does not show the payment it awaits.
    ForgivesLost,
    /// Keeps its stop, and a payment awaiting a quote, to one video.
    StopPerVideo,
    /// Lets an incomplete reclaim hold back only its own video.
    ReclaimPerVideo,
    /// Keeps one payment in flight per video, not per seeder.
    InFlightPerVideo,
    /// Checks its price cap on the first quote only.
    SkipsCapOnResume,
    KeepsPayingAfterTimeout,
    /// Reclaims an unanswered payment before 180 s.
    TimeoutEarly,
    /// Reclaims an unanswered payment a second before the wait is over.
    TimeoutAt179,
    /// Checks its window ceiling on the first quote only.
    SkipsCeilingOnResume,
    /// Frees the standing's slot when a `hello` is refused.
    HelloRefusedFreesSlot,
    /// Settles a closed session's payment on another video's quote.
    SettleUnsettledAnyLedger,
    /// Resets the `mint-unavailable` count on a refusal.
    RefusalResetsUnavailable,
    /// Pays ahead after a refusal whatever the `mint-unavailable` count.
    PayAheadSkipsBudget,
    /// Files a closed session's payment found spent under the ledger that caught up.
    CatchUpFilesUnderSelf,
    /// Stops on any refused `hello` but `bad-session`.
    HelloRefusalStops,
    /// Keeps the `mint-unavailable` count across an ack.
    AckKeepsUnavailable,
    /// Counts `mint-unavailable` answers per video, not per seeder.
    UnavailablePerLedger,
    /// Pays the last payment whatever the `mint-unavailable` count.
    LastPayIgnoresBudget,
    /// Ignores a `hello` refused `banned`.
    BannedHelloIgnored,
    /// On a `rej` with no payment in flight, reclaims a closed session's payment at once
    /// and carries on.
    UnsolicitedRejReclaimsUnsettled,
    /// Finishes no reclaim once stopped.
    StoppedSkipsReclaim,
    /// Once stopped, finishes incomplete reclaims but leaves closed sessions' payments
    /// unsettled.
    StoppedSkipsUnsettled,
    /// Resets the `mint-unavailable` count when a `hello` is refused.
    HelloRefusedResetsBudget,
    /// Stops on a `hello` refused with a code it does not know.
    UnknownHelloRefusalStops,
    /// Stops only the video whose `hello` was refused `banned`.
    BannedHelloStopsLedger,
    /// Files a closed session's payment whose catch-up reclaim is blocked under the
    /// ledger that caught up.
    CatchUpBlockedAsSelf,
    /// Ignores a `rej` once the standing has stopped.
    RejSkipsWhenStopped,
    /// Drops a payment refused once the standing has stopped, without reclaiming it.
    RejNoReclaimWhenStopped,
    /// Ignores `timeout` once the standing has stopped.
    TimeoutSkipsWhenStopped,
    /// Drops a payment timed out once the standing has stopped, without reclaiming it.
    TimeoutNoReclaimWhenStopped,
    /// Resets the `mint-unavailable` count on any quote, refused or not.
    QuoteResetsFirst,
    /// Resets the `mint-unavailable` count when any session of the standing ends.
    EndResetsBudget,
    /// Resets the `mint-unavailable` count when a retried reclaim completes.
    RetryResetsBudget,
    /// Settles a closed session's payment on an ack with no payment in flight.
    AckSettlesUnsettled,
    /// Takes proofs its own unanswered reclaim took back for spent, without a restore.
    ReclaimNoRestore,
    /// Counts a payment as back when a restore finds any of its proofs, not all.
    ReclaimRestoreAny,
    /// Settles no payment whose reclaim is incomplete from a quote, and stops instead.
    QuoteIgnoresReclaiming,
    /// Pays ahead half a window rounded up, beyond half on an odd window.
    PayAheadRoundsUp,
    /// Settles a payment whose reclaim is incomplete when `spent_total` alone matches.
    SettleReclaimingOnSpentOnly,
    /// Settles a payment whose reclaim is incomplete when `accepted_upto` alone matches.
    SettleReclaimingOnUpto,
    /// Settles a payment whose reclaim is incomplete on another video's quote.
    SettleReclaimingAnyLedger,
    /// Settles a payment whose reclaim is incomplete, but keeps retrying the reclaim.
    ReclaimSettleKeepsEntry,
    /// Takes an unanswered restore as every proof back.
    ReclaimRestoreDownIsBack,
    /// Takes an unanswered restore as proofs spent.
    ReclaimRestoreDownIsSpent,
    /// Keeps retrying a reclaim refused because the proofs' keyset expired, though a NUT-07
    /// check shows them unspent: it never completes.
    ExpiredReclaimRetried,
    /// Takes every reclaim refused 12003 with its proofs unspent as lost to the expiry,
    /// though the 12003 may be the reclaim's outputs' keyset, and the proofs still good.
    ExpiredByCodeAlone,
    /// Takes a 12003 whose reclaim outputs' keyset has expired as incomplete, before
    /// looking at the proofs' own: proofs of that very keyset are never written off.
    OutputsExpiryFirst,
    /// Writes off every proof of a token once any is listed expired (the twentieth's).
    ExpiredTokenWhole,
    /// Writes off a token's proofs only when every one is listed expired: a mixed token
    /// never completes.
    ExpiredNeedsEveryProof,
    /// After a 12003, calls the payment found spent unless a restore shows every proof its
    /// own: a mixed token whose good proofs its lost reclaim took back is never settled.
    ExpiredRestoreNeedsEveryProof,
    /// Writes a mixed token off whole while the mint's active keyset has expired too,
    /// instead of holding the reclaim of its good proofs incomplete.
    MixedActiveExpiredWritesOff,
    /// Pays with proofs the mint lists under an expired keyset (a wallet selecting an
    /// inactive keyset's proofs first, with no expiry filter): again, after a reclaim lost
    /// them to the expiry, and fresh ones while the mint's active keyset has expired.
    PaysWithExpiredProofs,
    /// After a 12003, takes every spent input for its own once a restore shows any one of
    /// them its own: a seeder that kept one proof gets paid again.
    ExpiredSpentAnyOwn,
    /// Takes a 12003 with an input pending as every input unspent: the payment is written off
    /// to the expiry, the reserved request then signs, and the next payment is stale.
    ExpiredPendingIsLost,
    /// After a 12003 with a spent input not its own, awaits a quote without taking back the
    /// inputs left unspent (the twenty-second rework's): the seeder can take them later.
    ExpiredForeignKeepsRest,
    /// Takes a 12003 whose NUT-07 check goes unanswered as every input unspent: the payment
    /// is written off to the expiry.
    ExpiredCheckDownIsUnspent,
    /// Takes a quote whose `served` exceeds the chunks it requested by one.
    ServedOffByOne,
    /// Settles a payment on a quote whose `spent_total` covers the payment, whatever the
    /// ledger's earlier spend: an inflated total, or one that drops the ledger, settles it.
    SettleIgnoresLedgerSpent,
    /// After a 12003 with a spent input not its own, awaits a quote when the inputs left are
    /// pending, instead of holding the reclaim incomplete: they are never taken back.
    ForeignPendingAwaits,
    /// After a 12003 with a spent input not its own, when the inputs left cannot be
    /// taken back yet (the mint's active keyset expired too, or they are pending), awaits a
    /// quote at once instead of holding the reclaim incomplete: they are never taken back.
    ExpiredForeignBlockedAwaits,
    /// Pays the last payment of a session with proofs the mint lists expired.
    LastPayWithExpiredProofs,
    /// Checks a payment's proofs against the mint's listing only while its active keyset has
    /// expired: it pays with proofs it holds of an expired older keyset, which a wallet
    /// spends first.
    ListingOnlyWhileActiveExpired,
    /// Accepts an ack whose `accepted_upto` is short of the payment's `upto_chunk` but above
    /// its ledger: it pays the chunks between again.
    AckAcceptsShort,
    /// Accepts an ack short of the payment in both fields at its price: `accepted_upto`
    /// above its ledger and short of `upto_chunk`, `spent_total` short by the chunks
    /// between. It takes the ack for its ledger and pays those chunks again.
    AckAcceptsPartial,
    /// Accepts an ack whose `accepted_upto` matches the payment but whose `spent_total` is
    /// short of its ledger's plus the payment's, though above its ledger.
    AckAcceptsShortSpent,
    /// Checks a session's last payment against the mint's listing only while its active
    /// keyset has expired: at the end, it pays with proofs it holds of an expired older
    /// keyset, which a wallet spends first.
    LastPayListingOnlyWhileActiveExpired,
    /// Gives no sign that its tries are used up.
    BudgetNotSignalled,
    /// Reclaims a payment left unsettled by a dropped connection at once.
    CatchUpIgnoresWait,
    /// Reclaims a payment in flight the moment its connection closes.
    EndReclaimsNow,
    /// Forgets a payment in flight when its connection closes.
    EndForgetsPending,
    ForgetsLedger,
    /// Stops paying after `mint-unavailable`.
    StopsOnOutage,
    /// Takes a reclaim refused as pending (CDK 11002) for proofs found spent.
    ReclaimPendingIsSpent,
}

/// (peer, video index): one account.
type Key = (PeerId, usize);
/// One unpaid admission in the global count: (account, account generation, chunk).
type Debt = (Key, u64, u64);

struct Account {
    /// Distinguishes this account from a forgotten one with the same key, so their chunk
    /// numbers never collide in the global count.
    generation: u64,
    admitted: u64,
    acked: u64,
    spent: u64,
    /// Chunk numbers of unpaid admissions, oldest first.
    unpaid: VecDeque<u64>,
    files: HashSet<String>,
    banned: bool,
    /// The last admission, payment or session close.
    last_active: u64,
}

/// The payment holding an account's turn.
struct Holder {
    pay: u64,
    deadline: u64,
}

/// One `pay`, from its arrival until both its future and its swap are done. Every
/// decision about it is applied under the engine's one lock, so it is answered, credited
/// and banned on consistently whichever side (the future, the swap's completion, a
/// takeover, a read of its state) acts first. A read of its state is a mint round trip,
/// made without the lock: its decision is applied only if the swap is still undecided
/// then.
struct PayRecord {
    key: Key,
    /// 60 s from arrival.
    deadline: u64,
    /// The swap has been sent: from then the swap's completion, the deadline or a
    /// takeover releases the turn, not the future.
    sent: bool,
    /// The swap settled in time: what the future answers.
    answer: Option<Result<Ack, Rej>>,
    /// Answered `mint-unavailable`: the swap is abandoned. A late outcome is credited if
    /// a claim, and never banned on.
    abandoned: bool,
    /// The swap's outcome has come.
    landed: bool,
    /// The future has answered, or is gone.
    finished: bool,
    waker: Option<Waker>,
    /// The swap once sent: what settles it, its token and its output set.
    swap: Option<(Settle, String, u64)>,
}

#[derive(Default)]
struct State {
    accounts: HashMap<Key, Account>,
    next_generation: u64,
    /// Banned peers, and when each was banned.
    banned: HashMap<PeerId, u64>,
    /// Open session ids and their account.
    open: HashMap<String, Key>,
    /// Open sessions per peer (or per account, with [`SeederFlaw::SessionCapPerVideo`]).
    open_count: HashMap<(PeerId, Option<usize>), usize>,
    /// Open sessions per account, for forgetting.
    open_accounts: HashMap<Key, usize>,
    /// Hellos waiting for their account's turn, per peer: they count toward the cap.
    hellos_waiting: HashMap<PeerId, usize>,
    /// Sessions ever opened ([`SeederFlaw::SessionCapLifetime`] only).
    ever: HashMap<PeerId, usize>,
    /// Unpaid admissions and their time, oldest first, for ageing.
    debt: VecDeque<(Debt, u64)>,
    /// Unpaid admissions not yet aged out: the global cap's count. A set, so a chunk
    /// cannot be freed twice.
    live: HashSet<Debt>,
    /// The counter [`SeederFlaw::CountFreedTwice`] keeps instead.
    flawed_count: u64,
    /// The payment holding each account's turn.
    paying: HashMap<Key, Holder>,
    /// Hellos and payments waiting for an account's turn.
    waiting: HashMap<Key, Vec<Waker>>,
    /// Every `pay` not yet done on both sides.
    pays: HashMap<u64, PayRecord>,
    next_pay: u64,
    /// Swaps whose answer was lost: learnt by reading their state once the mint can be
    /// reached. With the swaps abandoned in flight, at most one per account: while one is
    /// unknown, the account's payments are not swapped.
    unknown: Vec<Unknown>,
    /// The second each account's own entries last read its swaps, and each read sent in it:
    /// kept for that second.
    own_reads: HashMap<Key, OwnReads>,
    /// The position a waiting `hello` noted as the payment it first waited for left the
    /// turn ([`SeederFlaw::QuoteAtFirstWake`] only).
    first_wake_position: HashMap<Key, (u64, u64, u64)>,
}

/// An account's own reads in one second: the second, each read sent in it, and how many had
/// been sent when its turn was last freed that second (a `hello` that waited for the turn
/// reads after it: none of those serves it). A turn freed at its payment's deadline was
/// freed as that second began, and counts none.
type OwnReads = (u64, Vec<OwnRead>, usize);

/// One read of an account's swaps, sent by a payment of `by` (`None`: a `hello`), covering
/// the swaps undecided when it was sent (by their outputs).
#[derive(Debug, Clone, PartialEq, Eq)]
struct OwnRead {
    by: Option<Vec<u64>>,
    covers: Vec<u64>,
    state: ReadState,
}

/// Where a read sent is: a read counts from when it is sent, whatever becomes of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadState {
    /// Sent, and not back yet (a round trip).
    UnderWay,
    /// Back: its result is applied.
    Back,
    /// Its entry was dropped before it came back: it counts, and has no result.
    Abandoned,
}

/// What an entry does about its account's reads, decided in one look at them.
enum Plan {
    /// Wait until no read of the account is under way, then answer (a flaw's).
    WaitAll,
    /// Answer without reading: a read serves it, or it has no time left.
    Done,
    /// Wait a poll for a read under way that would serve it, then look again.
    WaitRead,
    /// Wait a poll for the next second (the second's two reads spent), then look again.
    NextSecond,
    /// Read: in the place taken (its index), exactly the swaps it covers; or, with the
    /// flaw, in a place taken once sent.
    Read(Option<(usize, Vec<Unknown>, Vec<InFlight>)>),
}

/// Who applies a read of swap state: the sweep, or an account's own entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Learner {
    /// The background sweep.
    Sweep,
    /// The account's own `hello`.
    Hello,
    /// A payment of the account.
    Pay,
}

/// A read of swap state, sent, and not yet applied: its swaps, and what it found for each.
struct Learnt {
    lost: Vec<Unknown>,
    flight: Vec<InFlight>,
    reads: Vec<Read>,
}

impl Learnt {
    /// The swaps it covers, by their outputs.
    fn covers(&self) -> Vec<u64> {
        self.lost
            .iter()
            .map(|u| u.outputs)
            .chain(self.flight.iter().map(|f| f.3))
            .collect()
    }
}

/// A swap sent and past its payment's deadline, unanswered: the payment, its parameters,
/// its token, its outputs and its deadline.
type InFlight = (u64, Settle, String, u64, u64);

/// A swap whose answer was lost.
#[derive(Clone)]
struct Unknown {
    pay: Settle,
    token: String,
    outputs: u64,
    /// When its answer was lost.
    since: u64,
}

/// A seeder's configuration (NFX-07 §3).
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub price_per_chunk: u64,
    pub mints: Vec<String>,
    pub window: u64,
    pub global_cap: u64,
    pub debt_ttl: Duration,
    pub account_ttl: Duration,
    pub ban_ttl: Duration,
}

impl EngineConfig {
    /// A seeder refuses to start outside these (NFX-07 §3). A zero `debt_ttl`, or a cap
    /// beyond the ceiling, would switch the cap off; an `account_ttl` below `debt_ttl`
    /// would let a forgotten account start afresh while its debt still counted.
    pub fn validate(&self) -> Result<(), String> {
        self.check(None)
    }

    fn check(&self, flaw: Option<SeederFlaw>) -> Result<(), String> {
        if self.price_per_chunk == 0 || self.price_per_chunk > MAX_INT {
            return Err("price_per_chunk is 1 to 2^53-1".into());
        }
        if self.mints.is_empty() || self.mints.len() > 16 {
            return Err("quote 1 to 16 mints".into());
        }
        if self.window < 2 || self.window > MAX_WINDOW {
            return Err("window is 2 to 64".into());
        }
        let ceiling = flaw != Some(SeederFlaw::NoCapCeiling);
        if self.global_cap == 0 || (ceiling && self.global_cap > MAX_GLOBAL_CAP) {
            return Err("the global cap is 1 to 1,000,000".into());
        }
        if self.debt_ttl < MIN_DEBT_TTL {
            return Err("debt_ttl is at least 10 minutes".into());
        }
        let ceilings = flaw != Some(SeederFlaw::NoTtlCeiling);
        if ceilings
            && (self.debt_ttl > MAX_DEBT_TTL
                || self.account_ttl > MAX_STATE_TTL
                || self.ban_ttl > MAX_STATE_TTL)
        {
            return Err("debt_ttl is at most 24 h; account_ttl and ban_ttl at most 30 days".into());
        }
        let short = if flaw == Some(SeederFlaw::EqualTtlRefused) {
            self.account_ttl <= self.debt_ttl
        } else {
            self.account_ttl < self.debt_ttl
        };
        if short {
            return Err("account_ttl is at least debt_ttl".into());
        }
        if self.ban_ttl < self.debt_ttl && flaw != Some(SeederFlaw::NoBanTtlCheck) {
            return Err("ban_ttl is at least debt_ttl".into());
        }
        // Its quote must be one the pay/1 writer emits: every mint URL valid.
        let quote = Message::Quote(Quote {
            price_per_chunk: self.price_per_chunk,
            mints: self.mints.clone(),
            window: self.window,
            served: 0,
            accepted_upto: 0,
            spent_total: 0,
        });
        let opts = ParseOptions {
            allow_loopback_http: flaw == Some(SeederFlaw::ValidateAllowsLoopback),
        };
        quote
            .to_line_with(opts)
            .map_err(|e| format!("its quote is not valid pay/1: {e}"))?;
        Ok(())
    }
}

struct Video {
    addr: VideoAddr,
    members: HashSet<String>,
}

struct Inner {
    config: EngineConfig,
    videos: Vec<Video>,
    clock: Clock,
    net: MockNetwork,
    flaw: Option<SeederFlaw>,
    state: Mutex<State>,
}

/// Ready on the next poll: the shape of a mint round trip, with no time passing.
async fn next_poll() {
    let mut yielded = false;
    poll_fn(|cx| {
        if yielded {
            Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    })
    .await;
}

fn wake_all(wake: Vec<Waker>) {
    for w in wake {
        w.wake();
    }
}

fn unavailable(detail: &str) -> Rej {
    rej(RejCode::MintUnavailable, detail)
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn has(&self, f: SeederFlaw) -> bool {
        self.flaw == Some(f)
    }

    fn debt_key(&self, key: Key, generation: u64, n: u64) -> Debt {
        if self.has(SeederFlaw::LiveKeyedByPeer) {
            ((key.0, 0), 0, n)
        } else {
            (key, generation, n)
        }
    }

    fn free_flawed(&self, st: &mut State, n: u64) {
        st.flawed_count = if self.has(SeederFlaw::CountFreedTwiceWrapping) {
            st.flawed_count.wrapping_sub(n)
        } else {
            st.flawed_count.saturating_sub(n)
        };
    }

    /// Learn the outcome of swaps left unknown (an answer lost, or a swap abandoned in
    /// flight) while the mint can be reached: a claim is credited as a late one, and a
    /// swap that can no longer go through leaves nothing to credit. `scope`: that
    /// account's own, as its `hello` and `pay` learn them; `None`: every account's, as the
    /// background sweep does. Each is decided on its own: one still unknown delays no
    /// other. The reads are mint round trips, made without the state lock, in as few
    /// requests as the mint's limits allow; a decision is applied only to a swap still
    /// undecided when it comes back, so an answer, or another learner, that settled it
    /// meanwhile is not counted again. One whose inputs still read unspent `account_ttl`
    /// after it became unknown is completed: the seeder sends its swap again, with the
    /// same outputs, and settles it as that answer says.
    /// Whether it read anything. `until`: the reads, and completions, end then (a
    /// payment's deadline): one still unanswered is abandoned, and proves nothing. `by`:
    /// who applies it.
    fn learn(&self, scope: Option<Key>, until: Option<u64>, by: Learner) -> bool {
        match self.learn_read(scope, until) {
            Some(learnt) => {
                self.learn_apply(&learnt, by);
                true
            }
            None => false,
        }
    }

    /// The read half of [`Inner::learn`]: the swaps it covers, fixed as it is sent, and the
    /// mint's answers (completions included). `None`: nothing to read.
    fn learn_read(&self, scope: Option<Key>, until: Option<u64>) -> Option<Learnt> {
        let (lost, flight) = self.to_learn(scope);
        self.learn_read_of(lost, flight, until)
    }

    /// [`Inner::learn_read`] of the swaps given: exactly those are sent.
    fn learn_read_of(
        &self,
        lost: Vec<Unknown>,
        flight: Vec<InFlight>,
        until: Option<u64>,
    ) -> Option<Learnt> {
        if self.has(SeederFlaw::NeverRestores) {
            return None;
        }
        if lost.is_empty() && flight.is_empty() {
            return None;
        }
        let items: Vec<(String, u64)> = lost
            .iter()
            .map(|u| (u.token.clone(), u.outputs))
            .chain(flight.iter().map(|f| (f.2.clone(), f.3)))
            .collect();
        let since: Vec<(u64, bool)> = lost
            .iter()
            .map(|u| (u.since, false))
            .chain(flight.iter().map(|f| (f.4, true)))
            .collect();
        let mut reads: Vec<Read> = if self.has(SeederFlaw::ReadsPerSwap) {
            items
                .iter()
                .flat_map(|i| self.read_states(std::slice::from_ref(i), until))
                .collect()
        } else {
            self.read_states(&items, until)
        };
        // Undecided with every input unspent `account_ttl` after it became unknown: its
        // payer has had the inputs back all that time and never spent them. The seeder
        // completes the swap: a claim is credited late, like any other.
        let ttl = if self.has(SeederFlaw::CompletesAtDebtTtl) {
            self.config.debt_ttl.as_secs()
        } else {
            self.config.account_ttl.as_secs()
        };
        for (i, read) in reads.iter_mut().enumerate() {
            let (since, in_flight) = since[i];
            let due = *read == Read::Unspent
                && self.clock.now() >= since.saturating_add(ttl)
                && !self.has(SeederFlaw::UndecidedNeverExpires)
                && !(in_flight && self.has(SeederFlaw::FlightNeverExpires));
            if due {
                let key = if i < lost.len() {
                    lost[i].pay.key
                } else {
                    flight[i - lost.len()].1.key
                };
                *read = if self.has(SeederFlaw::ExpiryDrops) {
                    Read::Nothing
                } else {
                    self.complete(key, &items[i].0, items[i].1, until)
                };
            }
        }
        Some(Learnt {
            lost,
            flight,
            reads,
        })
    }

    /// The apply half of [`Inner::learn`]: each decision taken for a swap still undecided,
    /// by `by`.
    fn learn_apply(&self, learnt: &Learnt, by: Learner) {
        let (lost, flight, reads) = (&learnt.lost, &learnt.flight, &learnt.reads);
        let (lost_reads, flight_reads) = reads.split_at(lost.len());
        let decided = |read: Read| matches!(read, Read::Claimed | Read::Nothing);
        let mut wake = Vec::new();
        {
            let mut st = self.state();
            for (u, &read) in lost.iter().zip(lost_reads) {
                if !decided(read) {
                    if self.has(SeederFlaw::LearnStopsAtFirstUnknown) {
                        break;
                    }
                    continue;
                }
                // Decided by another learner meanwhile: nothing more to do.
                match st.unknown.iter().position(|x| x.outputs == u.outputs) {
                    Some(i) => {
                        st.unknown.remove(i);
                    }
                    None if self.has(SeederFlaw::LostNoRecheck) => {}
                    None => continue,
                }
                if read == Read::Claimed {
                    self.settle_late(&mut st, &u.pay, Swap::Claimed);
                } else if self.nothing_frees(by, false) {
                    self.free_unpaid(&mut st, &u.pay);
                }
            }
            let lost_open = st
                .unknown
                .iter()
                .any(|u| lost.iter().any(|l| l.outputs == u.outputs));
            if !(lost_open && self.has(SeederFlaw::InFlightWaitsForUnknown)) {
                for (f, &read) in flight.iter().zip(flight_reads) {
                    let (id, pay) = (f.0, &f.1);
                    if !decided(read) {
                        if self.has(SeederFlaw::InFlightStopsAtFirstUnknown) {
                            break;
                        }
                        continue;
                    }
                    // An answer that landed while it was read has settled it.
                    let open = st.pays.get(&id).is_some_and(|r| r.sent && !r.landed);
                    if !open && !self.has(SeederFlaw::NoRecheckAfterRead) {
                        continue;
                    }
                    if read == Read::Claimed {
                        self.settle_late(&mut st, pay, Swap::Claimed);
                    } else if self.nothing_frees(by, true) {
                        self.free_unpaid(&mut st, pay);
                    }
                    st.pays.remove(&id);
                    // A turn it still holds is released, and what waits for it woken; a
                    // turn another payment took over stays that payment's.
                    if self.has(SeederFlaw::DecidedKeepsTurn) {
                        continue;
                    }
                    if self.has(SeederFlaw::DecidedFreesAnyTurn) {
                        self.free_turn(&mut st, pay.key);
                    }
                    if self.has(SeederFlaw::DecidedLeavesWaiters) {
                        if st.paying.get(&pay.key).is_some_and(|h| h.pay == id) {
                            self.free_turn(&mut st, pay.key);
                        }
                    } else {
                        wake.extend(self.release_turn(&mut st, pay.key, id));
                    }
                }
            }
        }
        wake_all(wake);
    }

    /// Whether a swap learnt as nothing by `by` frees its account's chunks from the global
    /// count (`in_flight`: abandoned in flight, else its answer lost): only a flaw's does.
    fn nothing_frees(&self, by: Learner, in_flight: bool) -> bool {
        let (own, pay) = (by != Learner::Sweep, by == Learner::Pay);
        self.has(SeederFlaw::LateNothingFreesDebt)
            || (in_flight && self.has(SeederFlaw::NothingInFlightFreesDebt))
            || (own && self.has(SeederFlaw::OwnNothingFreesDebt))
            || (pay && self.has(SeederFlaw::PayNothingFreesDebt))
            || (own && in_flight && self.has(SeederFlaw::OwnNothingInFlightFreesDebt))
            || (pay && in_flight && self.has(SeederFlaw::PayNothingInFlightFreesDebt))
    }

    /// What the flaws of [`Inner::nothing_frees`] free for a swap learnt as nothing: its
    /// account's unpaid chunks up to the payment leave the global count, unpaid.
    fn free_unpaid(&self, st: &mut State, pay: &Settle) {
        let Some(a) = st.accounts.get(&pay.key) else {
            return;
        };
        let generation = a.generation;
        let freed: Vec<u64> = a
            .unpaid
            .iter()
            .copied()
            .filter(|n| *n <= pay.upto)
            .collect();
        for n in freed {
            st.live.remove(&self.debt_key(pay.key, generation, n));
        }
    }

    /// The swaps [`Inner::learn`] reads: `scope`'s own, or every account's. Lost answers
    /// first, then swaps in flight past their deadlines, oldest first.
    fn to_learn(&self, scope: Option<Key>) -> (Vec<Unknown>, Vec<InFlight>) {
        let st = self.state();
        self.to_learn_in(&st, scope)
    }

    /// [`Inner::to_learn`], under a lock already held.
    fn to_learn_in(&self, st: &State, scope: Option<Key>) -> (Vec<Unknown>, Vec<InFlight>) {
        let scope = scope.filter(|_| !self.has(SeederFlaw::ReadsOtherAccounts));
        let mine = |k: Key| {
            scope.is_none_or(|s| {
                if self.has(SeederFlaw::ScopeByPeer) {
                    s.0 == k.0
                } else {
                    s == k
                }
            })
        };
        let now = self.clock.now();
        let lost: Vec<Unknown> = st
            .unknown
            .iter()
            .filter(|u| mine(u.pay.key))
            .cloned()
            .collect();
        let mut flight: Vec<InFlight> = if self.has(SeederFlaw::InFlightNeverDecided) {
            Vec::new()
        } else {
            st.pays
                .iter()
                .filter(|(_, r)| {
                    mine(r.key) && r.sent && !r.landed && (r.abandoned || now >= r.deadline)
                })
                .filter_map(|(id, r)| r.swap.clone().map(|(p, t, o)| (*id, p, t, o, r.deadline)))
                .collect()
        };
        flight.sort_by_key(|f| f.0);
        (lost, flight)
    }

    /// Whether the mint's active keyset, as it lists its `final_expiry`, expires sooner than
    /// twice `account_ttl` away by this seeder's clock: then it is not swapped to.
    fn keyset_too_soon(&self) -> bool {
        if self.has(SeederFlaw::IgnoresKeysetExpiry) {
            return false;
        }
        let ttl = if self.has(SeederFlaw::KeysetMarginBanTtl) {
            self.config.ban_ttl
        } else if self.has(SeederFlaw::KeysetMarginMaxTtl) {
            self.config.account_ttl.max(self.config.ban_ttl)
        } else {
            self.config.account_ttl
        };
        let horizon = self.clock.now() + 2 * ttl.as_secs();
        self.net.keyset_final_expiry().is_some_and(|t| {
            if self.has(SeederFlaw::KeysetMarginInclusive) {
                t <= horizon
            } else {
                t < horizon
            }
        })
    }

    /// Whether `key` has swaps of its own to read now.
    fn has_reads(&self, key: Key) -> bool {
        if self.has(SeederFlaw::NeverRestores) {
            return false;
        }
        let (lost, flight) = self.to_learn(Some(key));
        !lost.is_empty() || !flight.is_empty()
    }

    /// Learn `key`'s own unknown swaps at a payment of `proofs` that has passed its
    /// checks, by its deadline `until`, unless this engine learns only at a `hello`.
    async fn learn_here(&self, key: Key, proofs: Vec<u64>, until: u64) {
        if !self.has(SeederFlaw::LearnOnHelloOnly) {
            let until = (!self.has(SeederFlaw::OwnReadsIgnoreDeadline)).then_some(until);
            self.learn_own(key, Some(proofs), until, None).await;
        }
    }

    /// Learn `key`'s own unknown swaps at its entry: a `hello` (`proofs` `None`), or a
    /// payment of `proofs`. An account's own reads are at most two a second: a `hello`
    /// reuses any read of its account made that second, a payment reuses one made for the
    /// same proofs, and past two reads that second every entry reuses them. So a flood,
    /// of hellos or of payments whatever their proofs, costs the mint two reads a second,
    /// while a watcher paying again after its reclaim, with other proofs, reads afresh.
    /// An entry takes its read's place in the same look at the second's reads that decides
    /// it reads, before the read is sent: an entry meanwhile, on this task or another,
    /// reuses it instead of reading again. No read is sent at or past the entry's deadline.
    /// `waited`: a `hello` that waited for a payment, which reads after it (only a read sent
    /// after its wait ended serves it).
    async fn learn_own(
        &self,
        key: Key,
        proofs: Option<Vec<u64>>,
        until: Option<u64>,
        floor: Option<(u64, usize)>,
    ) {
        let slot = self.slot(key);
        let by = if proofs.is_some() {
            Learner::Pay
        } else {
            Learner::Hello
        };
        // A `hello` that waited for a payment: the reads of its second sent before its wait
        // ended (`floor`, noted as it saw the turn free) serve it not.
        let after_wait = floor.is_some() && !self.has(SeederFlaw::WaitedHelloReusesEarlierRead);
        let look_floor = floor.map(|_| {
            let now = self.clock.now();
            let sent = self
                .state()
                .own_reads
                .get(&slot)
                .filter(|(at, ..)| *at == now)
                .map_or(0, |(_, reads, _)| reads.len());
            (now, sent)
        });
        let bounded = !self.has(SeederFlaw::OwnReadsUnbounded);
        let waits_any = self.has(SeederFlaw::WaitsWhileReading)
            || (proofs.is_some() && self.has(SeederFlaw::PayWaitsForRead));
        let first_in_time = until.is_none_or(|u| self.clock.now() < u);
        let first_look = self.clock.now();
        let at_first_look = self.has(SeederFlaw::CountedAtFirstLook)
            || (proofs.is_some() && self.has(SeederFlaw::PayCountedAtFirstLook));
        let mut waited_in = None;
        loop {
            let now = self.clock.now();
            if self.has(SeederFlaw::SecondEndReturns) && waited_in.is_some_and(|w| w != now) {
                return;
            }
            let in_time = if self.has(SeederFlaw::InTimeOnce) {
                first_in_time
            } else {
                until.is_none_or(|u| now < u)
            };
            let plan = {
                let mut st = self.state();
                // What this entry needs read: the account's swaps undecided now. A read
                // serves it only if it covered every one of them (so not one sent before a
                // swap became unknown), and it is this entry's, or a hello's, or past two
                // that second.
                let (lost, flight) = self.to_learn_in(&st, Some(key));
                let need: Vec<u64> = lost
                    .iter()
                    .map(|u| u.outputs)
                    .chain(flight.iter().map(|f| f.3))
                    .collect();
                let (back, under_way, sent) = if need.is_empty()
                    || self.has(SeederFlaw::NeverRestores)
                {
                    (true, false, 0)
                } else {
                    match st.own_reads.get(&slot).filter(|(at, ..)| *at == now) {
                        None => (false, false, 0),
                        Some((_, reads, freed)) => {
                            let past_two =
                                reads.len() >= 2 && !self.has(SeederFlaw::OwnReadsPerProofs);
                            let noted = if self.has(SeederFlaw::FloorAtLatestFree) {
                                Some((now, *freed))
                            } else if self.has(SeederFlaw::FloorAtLook) {
                                look_floor
                            } else {
                                floor
                            };
                            let across = self.has(SeederFlaw::FloorAcrossSeconds);
                            let from = match noted {
                                Some((at, n)) if after_wait && (at == now || across) => n,
                                _ => 0,
                            };
                            let from = if past_two && self.has(SeederFlaw::FloorIgnoredPastTwo) {
                                0
                            } else {
                                from
                            };
                            let serves = |i: usize, r: &OwnRead| {
                                let blind = self.has(SeederFlaw::ReuseByCoverageBlind)
                                    || (proofs.is_some()
                                        && self.has(SeederFlaw::PayReuseCoverageBlind))
                                    || (past_two && self.has(SeederFlaw::PastTwoCoverageBlind))
                                    || (proofs.is_some()
                                        && r.by == proofs
                                        && self.has(SeederFlaw::OwnProofsCoverageBlind));
                                i >= from
                                    && (past_two
                                        || proofs.is_none()
                                        || r.by == proofs
                                        || self.has(SeederFlaw::PayServedByAnyRead))
                                    && (blind || need.iter().all(|o| r.covers.contains(o)))
                            };
                            let back = |r: &OwnRead| {
                                r.state == ReadState::Back
                                    || (r.state == ReadState::Abandoned
                                        && self.has(SeederFlaw::AbandonedReadReused))
                            };
                            let sent = if self.has(SeederFlaw::WaitedCountsAfterFloor) {
                                reads.len().saturating_sub(from)
                            } else {
                                reads.len()
                            };
                            (
                                reads
                                    .iter()
                                    .enumerate()
                                    .any(|(i, r)| serves(i, r) && back(r)),
                                reads.iter().enumerate().any(|(i, r)| {
                                    (serves(i, r)
                                        || (self.has(SeederFlaw::FloorIgnoredForUnderWay)
                                            && serves(i.max(from), r))
                                        || self.has(SeederFlaw::WaitsForAnyUnderWay)
                                        || (proofs.is_none()
                                            && self.has(SeederFlaw::HelloWaitsForAnyUnderWay)))
                                        && r.state == ReadState::UnderWay
                                }),
                                sent,
                            )
                        }
                    }
                };
                let past_two_again = (self.has(SeederFlaw::PastTwoReadsAgain)
                    || (proofs.is_some() && self.has(SeederFlaw::OwnReadsPerProofs)))
                    && sent >= 2;
                if need.is_empty() || self.has(SeederFlaw::NeverRestores) {
                    Plan::Done
                } else if bounded && waits_any && (back || under_way) {
                    Plan::WaitAll
                } else if bounded && back {
                    Plan::Done
                } else if bounded && under_way && !past_two_again {
                    // Shared with its result: wait for it, to this entry's deadline at most
                    // (then as a read unanswered). Each poll looks again: the second may end
                    // first.
                    if self.has(SeederFlaw::ReuseWithoutWaiting)
                        || (!in_time && !self.has(SeederFlaw::WaitReadPastDeadline))
                    {
                        Plan::Done
                    } else {
                        Plan::WaitRead
                    }
                } else if bounded && sent >= 2 && !past_two_again {
                    // Two sent this second, and none with a result for this entry: it reads
                    // in the next second, by its deadline.
                    if (!in_time && !self.has(SeederFlaw::NextSecondPastDeadline))
                        || (proofs.is_some() && self.has(SeederFlaw::PayNextSecondReturns))
                    {
                        Plan::Done
                    } else {
                        Plan::NextSecond
                    }
                } else if !in_time && !self.has(SeederFlaw::ReadsPastDeadline) {
                    if self.has(SeederFlaw::PlaceTakenPastDeadline) {
                        let index = self.take_place(&mut st, slot, now, proofs.clone(), need);
                        if let Some((_, reads, _)) = st.own_reads.get_mut(&slot) {
                            reads[index].state = ReadState::Abandoned;
                        }
                    }
                    Plan::Done // no time left to send it: no read, and none counted
                } else if self.has(SeederFlaw::PlaceTakenAfterCheck) {
                    Plan::Read(None)
                } else {
                    // Its place, taken now, covering exactly the swaps it is about to send.
                    let covers = if self.has(SeederFlaw::CoversSetAfterSend) {
                        Vec::new()
                    } else if self.has(SeederFlaw::CoversLostOnly) {
                        lost.iter().map(|u| u.outputs).collect()
                    } else {
                        need
                    };
                    let at = if at_first_look { first_look } else { now };
                    let index = self.take_place(&mut st, slot, at, proofs.clone(), covers);
                    Plan::Read(Some((index, lost, flight)))
                }
            };
            match plan {
                Plan::WaitAll => {
                    // A wait on any read of the account under way, whatever the second.
                    while self
                        .state()
                        .own_reads
                        .get(&slot)
                        .is_some_and(|(_, reads, _)| {
                            reads.iter().any(|r| r.state == ReadState::UnderWay)
                        })
                    {
                        next_poll().await;
                    }
                    return;
                }
                Plan::Done => return,
                Plan::WaitRead => {
                    waited_in.get_or_insert(now);
                    next_poll().await;
                    if self.has(SeederFlaw::ReuseWaitsOnePoll) {
                        return;
                    }
                    continue;
                }
                Plan::NextSecond => {
                    waited_in.get_or_insert(now);
                    next_poll().await;
                    continue;
                }
                Plan::Read(None) => {
                    // The flaw: its place taken only as it is sent, or once it is back.
                    if self.net.round_trips() {
                        let Some(learnt) = self.learn_read(Some(key), until) else {
                            return;
                        };
                        let reading =
                            Reading::start(self, slot, now, proofs.clone(), learnt.covers());
                        next_poll().await;
                        self.learn_apply(&learnt, by);
                        reading.back();
                    } else if let Some(learnt) = self.learn_read(Some(key), until) {
                        self.learn_apply(&learnt, by);
                        self.record_read(
                            slot,
                            now,
                            proofs.clone(),
                            learnt.covers(),
                            ReadState::Back,
                        );
                    }
                    return;
                }
                Plan::Read(Some((index, lost, flight))) => {
                    let at = if at_first_look { first_look } else { now };
                    let reading = Reading::taken(self, slot, at, index);
                    // Sent now, exactly the swaps its place covers: its requests reach the
                    // mint.
                    let Some(learnt) = self.learn_read_of(lost, flight, until) else {
                        return;
                    };
                    if self.has(SeederFlaw::CoversSetAfterSend) {
                        reading.cover(learnt.covers());
                    }
                    if self.net.round_trips() {
                        // Its result is applied when it is back, on the next poll.
                        next_poll().await;
                        if self.has(SeederFlaw::CoverageFixedAtBack) {
                            let (lost, flight) = self.to_learn(Some(key));
                            reading.cover(
                                lost.iter()
                                    .map(|u| u.outputs)
                                    .chain(flight.iter().map(|f| f.3))
                                    .collect(),
                            );
                        }
                    }
                    self.learn_apply(&learnt, by);
                    reading.back();
                    return;
                }
            }
        }
    }

    /// Take a place for a read of `slot`'s swaps in second `now`, covering `covers` (the
    /// swaps it is about to send), under way from now: its index in that second's reads.
    fn take_place(
        &self,
        st: &mut State,
        slot: Key,
        now: u64,
        proofs: Option<Vec<u64>>,
        covers: Vec<u64>,
    ) -> usize {
        let reads = st.own_reads.entry(slot).or_insert((now, Vec::new(), 0));
        if reads.0 != now && !self.has(SeederFlaw::NoSecondReset) {
            let kept = if self.has(SeederFlaw::FreedKeptAtNewSecond) {
                reads.2
            } else {
                0
            };
            *reads = (now, Vec::new(), kept);
        }
        reads.1.push(OwnRead {
            by: proofs,
            covers,
            state: ReadState::UnderWay,
        });
        reads.1.len() - 1
    }

    /// Count a read of `slot`'s swaps sent in second `now`, by a payment of `proofs` or a
    /// `hello` (`None`), covering `covers`, in `state`; its index in that second's reads.
    fn record_read(
        &self,
        slot: Key,
        now: u64,
        proofs: Option<Vec<u64>>,
        covers: Vec<u64>,
        state: ReadState,
    ) -> usize {
        let mut st = self.state();
        let reads = st.own_reads.entry(slot).or_insert((now, Vec::new(), 0));
        if reads.0 != now && !self.has(SeederFlaw::NoSecondReset) {
            *reads = (now, Vec::new(), 0);
        }
        reads.1.push(OwnRead {
            by: proofs,
            covers,
            state,
        });
        reads.1.len() - 1
    }

    /// Send a swap left unknown again, with the same outputs: a retry. Answered `spent`,
    /// or refused for good (its outputs' keyset rotated out, or its inputs invalid), a
    /// restore of its outputs settles it: signed is the first request's claim, and
    /// unsigned is nothing, since no request can sign those outputs now. Refused because a
    /// keyset expired, the same once no input is pending. Late, nothing is banned on.
    /// Refused as pending, or unanswered: still unknown.
    fn complete(&self, key: Key, token: &str, outputs: u64, until: Option<u64>) -> Read {
        let until = until.filter(|_| !self.has(SeederFlaw::CompleteIgnoresDeadline));
        if until.is_some_and(|u| self.clock.now() >= u) {
            return Read::Unknown; // no time left to send it in
        }
        let outputs_sent = if self.has(SeederFlaw::CompleteFreshOutputs) {
            self.net.fresh_outputs()
        } else {
            outputs
        };
        let restore_until = until.filter(|_| !self.has(SeederFlaw::CompleteRestoreUncapped));
        let by_restore = || match self.restore(token, outputs, restore_until) {
            Some(true) => Read::Claimed,
            Some(false) => Read::Nothing,
            None if self.has(SeederFlaw::CompleteRestoreDownNothing) => Read::Nothing,
            None => Read::Unknown,
        };
        let answer = self.net.resend(token, outputs_sent);
        if answer == Swap::Lost {
            self.wait_unanswered(until); // its client waited for it
        }
        match answer {
            Swap::Claimed => Read::Claimed,
            Swap::Lost if self.has(SeederFlaw::CompleteLostByRestore) => by_restore(),
            Swap::Unreachable if self.has(SeederFlaw::CompleteUnreachableNothing) => Read::Nothing,
            Swap::Invalid if self.has(SeederFlaw::CompleteInvalidBans) => {
                self.ban(&mut self.state(), key);
                by_restore()
            }
            Swap::Spent if self.has(SeederFlaw::CompleteSpentIsNothing) => Read::Nothing,
            Swap::Spent => by_restore(),
            Swap::OutputsRefused if self.has(SeederFlaw::CompleteRefusedStaysUnknown) => {
                Read::Unknown
            }
            Swap::OutputsRefused if self.has(SeederFlaw::CompleteRefusedIsNothing) => Read::Nothing,
            Swap::OutputsRefused => by_restore(),
            Swap::Invalid if self.has(SeederFlaw::CompleteInvalidStaysUnknown) => Read::Unknown,
            Swap::Invalid => by_restore(),
            Swap::Expired if self.has(SeederFlaw::CompleteExpiredAtOnce) => by_restore(),
            Swap::Expired => match self.restore_unless_pending(token, outputs, restore_until) {
                Some(true) => Read::Claimed,
                Some(false) => Read::Nothing,
                None => Read::Unknown,
            },
            Swap::Pending if self.has(SeederFlaw::CompletePendingIsNothing) => Read::Nothing,
            Swap::Pending | Swap::Lost | Swap::Unreachable => Read::Unknown,
        }
    }

    /// A swap refused because a keyset expired (CDK 12003): its inputs' or its outputs',
    /// which the answer does not say. An inputs' expiry does not stop a first request the
    /// mint reserved before it, so a restore of its outputs settles it only once a NUT-07
    /// check shows no input pending. `None`: not yet (an input pending, or a read
    /// unanswered).
    fn restore_unless_pending(
        &self,
        token: &str,
        outputs: u64,
        until: Option<u64>,
    ) -> Option<bool> {
        match self.net.input_states(&[token.to_owned()]) {
            Ok(s) if s[0] == InputState::Pending => None,
            Ok(s)
                if self.has(SeederFlaw::ExpiredSpentIsClaim)
                    && self.net.outputs_expired(outputs) =>
            {
                Some(s[0] == InputState::Spent)
            }
            Ok(_) => match self.restore(token, outputs, until) {
                None if self.has(SeederFlaw::ExpiredRestoreDownKnown) => Some(false),
                signed => signed,
            },
            Err(_) if self.has(SeederFlaw::ExpiredRestoreOnStateDown) => {
                self.restore(token, outputs, until)
            }
            Err(_) => {
                self.wait_unanswered(until.filter(|_| !self.has(SeederFlaw::ExpiredStateUncapped)));
                None
            }
        }
    }

    /// One read over `n` items, in requests the mint accepts: one if it can, else split in
    /// halves as the mint refuses them as too large (CDK 11014 or 11015); every swap it
    /// once took fits in a request alone. `None` for items no answer covered; an
    /// unanswered request costs its client the wait (its timeout).
    fn split_read<T: Clone>(
        &self,
        n: usize,
        read: &dyn Fn(std::ops::Range<usize>) -> Result<Vec<T>, ReadErr>,
        until: Option<u64>,
    ) -> Vec<Option<T>> {
        let mut out = Vec::with_capacity(n);
        let mut todo = Vec::new();
        todo.push(0..n);
        while let Some(r) = todo.pop() {
            if until.is_some_and(|u| self.clock.now() >= u) {
                out.push((r.start, vec![None; r.len()])); // no time left to ask
                continue;
            }
            match read(r.clone()) {
                Ok(v) => out.push((r.start, v.into_iter().map(Some).collect::<Vec<_>>())),
                Err(err)
                    if r.len() > 1
                        && !self.has(SeederFlaw::NoSplitOnLimit)
                        && (err == ReadErr::TooMany || self.has(SeederFlaw::SplitOnUnanswered)) =>
                {
                    if err == ReadErr::Unanswered {
                        self.wait_unanswered(until);
                    }
                    let mid = r.start + r.len() / 2;
                    if self.has(SeederFlaw::SplitMisaligned) {
                        todo.push(r.start..mid);
                        todo.push(mid..r.end);
                    } else {
                        todo.push(mid..r.end);
                        todo.push(r.start..mid);
                    }
                }
                Err(err) => {
                    if err == ReadErr::Unanswered {
                        self.wait_unanswered(until);
                    }
                    out.push((r.start, vec![None; r.len()]));
                }
            }
        }
        // Each answer back with its own swap, whatever order the requests went in.
        if !self.has(SeederFlaw::SplitMisaligned) {
            out.sort_by_key(|(start, _)| *start);
        }
        out.into_iter().flat_map(|(_, v)| v).collect()
    }

    /// An unanswered request costs its client the wait: its timeout, or up to `until`,
    /// when it gives up.
    fn wait_unanswered(&self, until: Option<u64>) {
        let mut wait = self.net.ledger().read_timeout;
        if let Some(u) = until {
            wait = wait.min(u.saturating_sub(self.clock.now()));
        }
        if wait > 0 {
            self.clock.advance(Duration::from_secs(wait));
        }
    }

    /// Read the state of swaps `(token, outputs)`: their inputs first (NUT-07), then
    /// their own outputs (NUT-09 restore). In that order, a swap processed between the
    /// two reads shows as signed. Signed outputs are a claim, whatever the first read
    /// said. Unsigned outputs with an input spent are nothing: the swap is atomic, so it
    /// can no longer go through. Anything else proves nothing: an input pending (reserved
    /// by a request the mint is still processing), every input unspent, or a read
    /// unanswered.
    fn read_states(&self, items: &[(String, u64)], until: Option<u64>) -> Vec<Read> {
        let tokens: Vec<String> = items.iter().map(|i| i.0.clone()).collect();
        let outputs: Vec<u64> = items.iter().map(|i| i.1).collect();
        let sizes: Vec<usize> = tokens.iter().map(|t| self.net.proofs_in(t)).collect();
        let n = items.len();
        let states = || self.split_read(n, &|r| self.net.input_states(&tokens[r]), until);
        let restore = || {
            self.split_read(
                n,
                &|r| {
                    if self.has(SeederFlaw::RestoreByToken) {
                        self.net.restore_by_tokens(&tokens[r.clone()], &sizes[r])
                    } else {
                        self.net.restore_swaps(&outputs[r.clone()], &sizes[r])
                    }
                },
                until,
            )
        };
        let (states, signed) = if self.has(SeederFlaw::RestoreBeforeInputs) {
            let signed = restore();
            (states(), signed)
        } else {
            let states = states();
            (states, restore())
        };
        (0..n)
            .map(|i| {
                // The eighteenth rework's rule, now a planted flaw ([`Inner::by_inputs`]).
                if self.has(SeederFlaw::ExpiredSpentIsClaim) && self.net.outputs_expired(outputs[i])
                {
                    return match states[i] {
                        Some(InputState::Spent) => Read::Claimed,
                        Some(InputState::Unspent) => Read::Nothing,
                        Some(InputState::Pending) | None => Read::Unknown,
                    };
                }
                if states[i].is_none() && self.has(SeederFlaw::SignedNeedsStates) {
                    return Read::Unknown;
                }
                let Some(signed) = signed[i] else {
                    return Read::Unknown;
                };
                if signed {
                    return Read::Claimed;
                }
                let state = match states[i] {
                    Some(s) => s,
                    None if self.has(SeederFlaw::StateDownIsSpent) => InputState::Spent,
                    None => return Read::Unknown,
                };
                let spent = match state {
                    InputState::Spent => true,
                    InputState::Pending => self.has(SeederFlaw::PendingIsSpent),
                    InputState::Unspent => false,
                };
                if self.has(SeederFlaw::NotSignedStaysUnknown) {
                    Read::Unknown
                } else if spent || self.has(SeederFlaw::NotSignedFinal) {
                    Read::Nothing
                } else if state == InputState::Unspent {
                    Read::Unspent
                } else {
                    Read::Unknown
                }
            })
            .collect()
    }

    /// Whether `key` has a swap of unknown outcome: one whose answer was lost, or one sent
    /// and still unanswered (abandoned at its deadline while in flight). `except` is the
    /// payment asking.
    fn unknown_swap(&self, st: &State, key: Key, except: u64) -> bool {
        let same = |k: Key| {
            if self.has(SeederFlaw::UnknownGlobal) {
                true
            } else if self.has(SeederFlaw::UnknownPeerWide) {
                k.0 == key.0
            } else {
                k == key
            }
        };
        let in_flight_same = |k: Key| {
            if self.has(SeederFlaw::InFlightGlobal) {
                true
            } else if self.has(SeederFlaw::InFlightPeerWide) {
                k.0 == key.0
            } else {
                same(k)
            }
        };
        if self.has(SeederFlaw::UnknownNeedsAccount) && !st.accounts.contains_key(&key) {
            return false;
        }
        st.unknown.iter().any(|u| same(u.pay.key))
            || (!self.has(SeederFlaw::InFlightNotUnknown)
                && st.pays.iter().any(|(id, r)| {
                    *id != except
                        && in_flight_same(r.key)
                        && r.sent
                        && !r.landed
                        && (r.finished || !self.has(SeederFlaw::InFlightFinishedOnly))
                }))
    }

    /// A restore of this swap's own outputs (NUT-09): they are unique to one swap and its
    /// retries, so it finds that swap and no other.
    /// Unanswered, it costs its client the wait, to `until` at the latest. Once the
    /// outputs' keyset has expired a restore no longer shows them (CDK skips an expired
    /// keyset's signatures): a claim then reads as unsigned, and is never credited. Nothing
    /// else can prove it: spent inputs may be the payer's own reclaim or a double spend.
    fn restore(&self, token: &str, outputs: u64, until: Option<u64>) -> Option<bool> {
        if self.has(SeederFlaw::ExpiredSpentIsClaim) && self.net.outputs_expired(outputs) {
            return self.by_inputs(token, until);
        }
        let signed = if self.has(SeederFlaw::RestoreByToken) {
            self.net.restore_by_token(token)
        } else {
            self.net.restore_swap(outputs, self.net.proofs_in(token))
        };
        if signed.is_none() {
            self.wait_unanswered(until);
        }
        signed
    }

    /// The mistake the eighteenth rework made ([`SeederFlaw::ExpiredSpentIsClaim`]): a swap
    /// whose outputs a restore cannot show decided by its inputs, an input spent taken as
    /// the claim, though it may be the payer's reclaim or a double spend.
    fn by_inputs(&self, token: &str, until: Option<u64>) -> Option<bool> {
        match self.net.input_states(&[token.to_owned()]) {
            Ok(s) => match s[0] {
                InputState::Spent => Some(true),
                InputState::Unspent => Some(false),
                InputState::Pending => None,
            },
            Err(_) => {
                self.wait_unanswered(until);
                None
            }
        }
    }

    /// A swap that got no answer is retried while its payment is in time (NUT-19). A
    /// retry answered `spent` may be the first attempt, gone through unseen: a restore of
    /// its outputs settles that, and it is never a ban.
    fn after_swap(&self, id: u64, token: &str, outputs: u64, outcome: Swap) -> Swap {
        if outcome != Swap::Lost || self.has(SeederFlaw::NoRetry) {
            return outcome;
        }
        let deadline = {
            let st = self.state();
            let now = self.clock.now();
            st.pays
                .get(&id)
                .filter(|r| {
                    !r.abandoned
                        && if self.has(SeederFlaw::RetryAtDeadline) {
                            now <= r.deadline
                        } else {
                            now < r.deadline
                        }
                })
                .map(|r| r.deadline)
        };
        let Some(deadline) = deadline else {
            return outcome;
        };
        // Its reads, and the retry itself, end at the payment's deadline.
        let until = (!self.has(SeederFlaw::RetryRestoreUncapped)).then_some(deadline);
        let retried = self.net.resend(token, outputs);
        if retried == Swap::Lost {
            // Its client waited for it.
            self.wait_unanswered((!self.has(SeederFlaw::RetryResendUncapped)).then_some(deadline));
        }
        match retried {
            // No answer to the retry either: the outcome is still unknown.
            Swap::Lost if self.has(SeederFlaw::RetryLostIsNothing) => Swap::Unreachable,
            // Spent may be the first attempt, gone through unseen: a restore of this swap's
            // outputs says. Not this swap's: known, and never a ban; nothing to learn.
            Swap::Spent if self.has(SeederFlaw::RetrySpentIsOwn) => Swap::Claimed,
            Swap::Spent if !self.has(SeederFlaw::RetryBansOnSpent) => {
                match self.restore(token, outputs, until) {
                    Some(true) => Swap::Claimed,
                    Some(false) if self.has(SeederFlaw::RetrySpentUnsignedStaysUnknown) => {
                        Swap::Lost
                    }
                    Some(false) => Swap::Unreachable,
                    None if self.has(SeederFlaw::RetrySpentRestoreDownKnown) => Swap::Unreachable,
                    None => Swap::Lost,
                }
            }
            // Its outputs refused for good: the first attempt, if it went through, shows in
            // a restore; if not, it never can now.
            Swap::OutputsRefused if self.has(SeederFlaw::RetryRefusedIsKnown) => Swap::Unreachable,
            Swap::OutputsRefused if self.has(SeederFlaw::RetryRefusedIsClaim) => Swap::Claimed,
            Swap::OutputsRefused => match self.restore(token, outputs, until) {
                Some(true) => Swap::Claimed,
                Some(false) if self.has(SeederFlaw::RetryRefusedUnsignedStaysUnknown) => Swap::Lost,
                Some(false) => Swap::Unreachable,
                None if self.has(SeederFlaw::RetryRefusedRestoreDownKnown) => Swap::Unreachable,
                None => Swap::Lost,
            },
            // The retry never reached the mint: the first attempt's outcome is still unknown.
            Swap::Unreachable => Swap::Lost,
            Swap::Invalid if self.has(SeederFlaw::RetryInvalidByRestore) => {
                match self.restore(token, outputs, until) {
                    Some(true) => Swap::Claimed,
                    Some(false) => Swap::Unreachable,
                    None => Swap::Lost,
                }
            }
            // A keyset expired: the first attempt, reserved before the expiry, may still
            // sign. Settled by a restore once no input is pending.
            Swap::Expired if self.has(SeederFlaw::RetryExpiredStaysUnknown) => Swap::Lost,
            Swap::Expired if self.has(SeederFlaw::RetryExpiredAtOnce) => {
                match self.restore(token, outputs, until) {
                    Some(true) => Swap::Claimed,
                    Some(false) => Swap::Unreachable,
                    None => Swap::Lost,
                }
            }
            Swap::Expired => match self.restore_unless_pending(token, outputs, until) {
                Some(true) => Swap::Claimed,
                Some(false) if self.has(SeederFlaw::RetryExpiredUnsignedStaysUnknown) => Swap::Lost,
                Some(false) => Swap::Unreachable,
                None => Swap::Lost,
            },
            // Refused as pending: the first attempt may be what the mint is processing.
            Swap::Pending if self.has(SeederFlaw::RetryPendingKnown) => Swap::Unreachable,
            Swap::Pending => Swap::Lost,
            // Invalid inputs are the proofs' own: the first attempt was refused the same way.
            retried => retried,
        }
    }

    /// Housekeeping, on every entry (after a `hello` or `pay` has learnt its own account's
    /// unknown swaps): age out unpaid admissions older than `debt_ttl` from the global
    /// count, expire bans after `ban_ttl`, and forget never-paid accounts that have had no
    /// open session for `account_ttl`.
    fn age(&self, st: &mut State) {
        let now = self.clock.now();
        if !self.has(SeederFlaw::OwnReadsNeverPruned) {
            st.own_reads.retain(|_, (at, ..)| *at == now);
        }
        let secs = |d: Duration| d.as_secs();
        if !self.has(SeederFlaw::DebtNeverAges) {
            let ttl = if self.has(SeederFlaw::AgeTtlOneSecond) {
                1
            } else {
                secs(self.config.debt_ttl)
            };
            if self.has(SeederFlaw::DebtLogUntrimmed) {
                let aged: Vec<Debt> = st
                    .debt
                    .iter()
                    .filter(|(_, t)| t.saturating_add(ttl) <= now)
                    .map(|(d, _)| *d)
                    .collect();
                for d in aged {
                    st.live.remove(&d);
                }
            } else {
                while let Some(&(debt, t)) = st.debt.front() {
                    if t.saturating_add(ttl) > now {
                        break;
                    }
                    st.debt.pop_front();
                    st.live.remove(&debt);
                    self.free_flawed(st, 1);
                }
            }
        }
        if !self.has(SeederFlaw::BansNeverExpire) {
            let ttl = secs(if self.has(SeederFlaw::BanExpiresEarly) {
                self.config.debt_ttl
            } else {
                self.config.ban_ttl
            });
            let mut expired = Vec::new();
            st.banned.retain(|peer, at| {
                let keep = at.saturating_add(ttl) > now;
                if !keep {
                    expired.push(*peer);
                }
                keep
            });
            if self.has(SeederFlaw::BanExpiryResetsAccounts) {
                st.accounts.retain(|k, _| !expired.contains(&k.0));
            }
        }
        if !self.has(SeederFlaw::NeverForgets) {
            let ttl = secs(if self.has(SeederFlaw::ForgetsAtDebtTtl) {
                self.config.debt_ttl
            } else {
                self.config.account_ttl
            });
            let forget_paid = self.has(SeederFlaw::ForgetsPaidAccounts);
            let forget_open = self.has(SeederFlaw::ForgetsOpenAccounts);
            let unserved = self.has(SeederFlaw::ForgetsUnserved);
            // An account whose swap has an unknown outcome is kept until it is learnt.
            let held: HashSet<Key> = if self.has(SeederFlaw::ForgetsUnknownAccount) {
                HashSet::new()
            } else {
                st.accounts
                    .keys()
                    .copied()
                    .filter(|k| self.unknown_swap(st, *k, 0))
                    .collect()
            };
            let State {
                accounts,
                open_accounts,
                ..
            } = st;
            accounts.retain(|k, a| {
                if held.contains(k) {
                    return true;
                }
                let open = open_accounts.contains_key(k) && !forget_open;
                let idle = !open && a.last_active.saturating_add(ttl) <= now;
                let never_paid = if unserved {
                    a.admitted == 0
                } else {
                    a.acked == 0
                };
                !(idle && (never_paid || forget_paid))
            });
        }
    }

    fn account<'a>(&self, st: &'a mut State, key: Key) -> &'a mut Account {
        let now = self.clock.now();
        let generation = st.next_generation;
        let a = st.accounts.entry(key).or_insert_with(|| Account {
            generation,
            admitted: 0,
            acked: 0,
            spent: 0,
            unpaid: VecDeque::new(),
            files: HashSet::new(),
            banned: false,
            last_active: now,
        });
        if a.generation == generation {
            st.next_generation += 1;
        }
        a.last_active = now;
        a
    }

    fn peer_banned(&self, st: &State, key: Key) -> bool {
        if self.has(SeederFlaw::BanPerVideo) {
            st.accounts.get(&key).is_some_and(|a| a.banned)
        } else {
            st.banned.contains_key(&key.0)
        }
    }

    fn ban(&self, st: &mut State, key: Key) {
        // A peer with no account has been served nothing and owes nothing: nothing is kept.
        let has_account = if self.has(SeederFlaw::BanNeedsThisAccount) {
            st.accounts.contains_key(&key)
        } else if self.has(SeederFlaw::BanNeedsPaidOrThis) {
            st.accounts.contains_key(&key)
                || st.accounts.iter().any(|(k, a)| k.0 == key.0 && a.acked > 0)
        } else if self.has(SeederFlaw::BanNeedsServed) {
            st.accounts
                .iter()
                .any(|(k, a)| k.0 == key.0 && a.admitted > 0)
        } else {
            st.accounts.keys().any(|k| k.0 == key.0)
        };
        if !has_account && !self.has(SeederFlaw::BansWithoutAccount) {
            return;
        }
        if self.has(SeederFlaw::BanPerVideo) {
            self.account(st, key).banned = true;
        } else {
            st.banned.insert(key.0, self.clock.now());
        }
        if self.has(SeederFlaw::BanForgetsDebt) {
            let peer = key.0;
            st.accounts.retain(|k, _| k.0 != peer);
            st.live.retain(|(k, _, _)| k.0 != peer);
            st.debt.retain(|((k, _, _), _)| k.0 != peer);
        }
    }

    /// The account's unpaid chunks (its window's count).
    fn window_count(&self, st: &State, key: Key) -> u64 {
        if self.has(SeederFlaw::PeerDebtAges) {
            return st.live.iter().filter(|(k, _, _)| *k == key).count() as u64;
        }
        let owed = |a: &Account| a.admitted.saturating_sub(a.acked);
        if self.has(SeederFlaw::WindowAcrossVideos) {
            return st
                .accounts
                .iter()
                .filter(|(k, _)| k.0 == key.0)
                .map(|(_, a)| owed(a))
                .sum();
        }
        st.accounts.get(&key).map_or(0, owed)
    }

    /// The global cap's count.
    fn global_unpaid(&self, st: &State) -> u64 {
        if self.has(SeederFlaw::GlobalCapNetsCredit) {
            let admitted: u64 = st.accounts.values().map(|a| a.admitted).sum();
            let acked: u64 = st.accounts.values().map(|a| a.acked).sum();
            return admitted.saturating_sub(acked);
        }
        if self.has(SeederFlaw::CountFreedTwice) || self.has(SeederFlaw::CountFreedTwiceWrapping) {
            return st.flawed_count;
        }
        st.live.len() as u64
    }

    /// Credit `key` with a payment up to `upto` worth `amount`: its unpaid chunks up to
    /// there leave the global count (unless they had aged out already). `snapshot` is the
    /// debt a flawed engine saw when it checked the payment.
    fn credit(&self, st: &mut State, key: Key, pay: (u64, u64), snapshot: &[u64], late: bool) {
        let (upto, amount) = pay;
        let paid_stays = self.has(SeederFlaw::PaidDebtStaysCounted)
            || (late && self.has(SeederFlaw::LateClaimKeepsDebt));
        let all = self.has(SeederFlaw::CreditFreesAllDebt)
            || (late && self.has(SeederFlaw::LateCreditFreesAll));
        let from_snapshot = self.has(SeederFlaw::CreditFromSnapshot)
            || (late && self.has(SeederFlaw::LateCreditFromSnapshot));
        let a = self.account(st, key);
        let generation = a.generation;
        let mut freed = Vec::new();
        while let Some(&n) = a.unpaid.front() {
            if n > upto && !all {
                break;
            }
            a.unpaid.pop_front();
            freed.push(n);
        }
        if from_snapshot {
            let (kept, stale): (Vec<u64>, Vec<u64>) =
                freed.iter().partition(|n| snapshot.contains(n));
            for n in stale.iter().rev() {
                a.unpaid.push_front(*n);
            }
            freed = kept;
        }
        a.acked = a.acked.max(upto);
        a.spent += amount;
        if !paid_stays {
            for n in &freed {
                st.live.remove(&self.debt_key(key, generation, *n));
            }
        }
        self.free_flawed(st, freed.len() as u64);
    }

    fn account_spent(&self, st: &State, key: Key) -> u64 {
        if self.has(SeederFlaw::AckSpentPeerWide) {
            return st
                .accounts
                .iter()
                .filter(|(k, _)| k.0 == key.0)
                .map(|(_, a)| a.spent)
                .sum();
        }
        st.accounts.get(&key).map_or(0, |a| a.spent)
    }

    /// What a swap settled in time means for the account.
    fn settle(&self, st: &mut State, pay: &Settle, outcome: Swap) -> Result<Ack, Rej> {
        let key = pay.key;
        match outcome {
            Swap::Claimed => Ok(self.ack(st, pay)),
            Swap::Spent => {
                if !self.has(SeederFlaw::NoBanOnSpent) {
                    self.ban(st, key);
                }
                Err(rej(RejCode::Spent, "a proof is already spent"))
            }
            Swap::Invalid => {
                if !self.has(SeederFlaw::InvalidNoBan) {
                    self.ban(st, key);
                }
                Err(rej(RejCode::BadToken, "the mint refuses these proofs"))
            }
            Swap::OutputsRefused if self.has(SeederFlaw::FirstRefusedBans) => {
                self.ban(st, key);
                Err(rej(RejCode::BadToken, "the mint refuses these proofs"))
            }
            Swap::Expired if self.has(SeederFlaw::FirstExpiredBans) => {
                self.ban(st, key);
                Err(rej(RejCode::BadToken, "the mint refuses these proofs"))
            }
            Swap::Pending if self.has(SeederFlaw::PendingBans) => {
                self.ban(st, key);
                Err(rej(RejCode::Spent, "a proof is already spent"))
            }
            // Refused as pending: another request holds the inputs, and this one did
            // nothing. It may be the payer's own other payment, so it is never a ban. A
            // keyset expired: the payer's, or the seeder's own outputs'; the code does not
            // say which, so never a ban either.
            Swap::Unreachable
            | Swap::Lost
            | Swap::Pending
            | Swap::OutputsRefused
            | Swap::Expired => {
                if self.has(SeederFlaw::OutageBans) {
                    self.ban(st, key);
                }
                if self.has(SeederFlaw::OutageCredits) {
                    return Ok(self.ack(st, pay));
                }
                Err(unavailable("the mint cannot be reached"))
            }
        }
    }

    /// What a late outcome of an abandoned swap means: a claim is credited, and nothing
    /// is banned on.
    fn settle_late(&self, st: &mut State, pay: &Settle, outcome: Swap) {
        match outcome {
            Swap::Claimed
                if self.has(SeederFlaw::LateCreditNeedsAccount)
                    && !st.accounts.contains_key(&pay.key) => {}
            Swap::Claimed
                if self.has(SeederFlaw::LateClaimSkipsBanned) && self.peer_banned(st, pay.key) => {}
            Swap::Claimed if !self.has(SeederFlaw::LateClaimNotCredited) => {
                self.credit(st, pay.key, (pay.upto, pay.amount), &pay.snapshot, true);
            }
            Swap::Spent | Swap::Invalid if self.has(SeederFlaw::LateOutcomeBans) => {
                self.ban(st, pay.key);
            }
            _ => {}
        }
    }

    fn ack(&self, st: &mut State, pay: &Settle) -> Ack {
        self.credit(st, pay.key, (pay.upto, pay.amount), &pay.snapshot, false);
        let in_session = pay.session_spent.fetch_add(pay.amount, Ordering::Relaxed) + pay.amount;
        Ack {
            accepted_upto: pay.upto,
            spent_total: if self.has(SeederFlaw::SpentTotalPerSession) {
                in_session
            } else {
                self.account_spent(st, pay.key)
            },
        }
    }

    /// A new `pay`'s record; its deadline is 60 s from now, its arrival.
    fn arrive(&self, key: Key) -> u64 {
        let mut st = self.state();
        st.next_pay += 1;
        let id = st.next_pay;
        let deadline = if self.has(SeederFlaw::DeadlineFromSwap) {
            u64::MAX // set when the swap is sent
        } else {
            self.clock.now() + SEEDER_DEADLINE.as_secs()
        };
        st.pays.insert(
            id,
            PayRecord {
                key,
                deadline,
                sent: false,
                answer: None,
                abandoned: false,
                landed: false,
                finished: false,
                waker: None,
                swap: None,
            },
        );
        id
    }

    /// Release `key`'s turn if payment `pay` holds it, and wake what waits for it.
    fn release_turn(&self, st: &mut State, key: Key, pay: u64) -> Vec<Waker> {
        let ours = st
            .paying
            .get(&key)
            .is_some_and(|h| h.pay == pay || self.has(SeederFlaw::StaleTurnFrees));
        if ours {
            self.free_turn(st, key);
        }
        if self.has(SeederFlaw::WaitingKeptEmpty) {
            return std::mem::take(st.waiting.entry(key).or_default());
        }
        let mut wake = st.waiting.remove(&key).unwrap_or_default();
        if self.has(SeederFlaw::WakesOneDropsRest) {
            wake.truncate(1);
        }
        wake
    }

    /// Free `key`'s turn: what waits for it goes on, and a `hello` among them reads after
    /// it, so the second's reads sent by now serve none of them. A turn held to its
    /// payment's deadline was freed at that deadline, however late this runs: every read
    /// of this second was sent at or after it (deadlines and the clock are whole seconds).
    fn free_turn(&self, st: &mut State, key: Key) {
        let holder = st.paying.remove(&key);
        let now = self.clock.now();
        let at_deadline = holder.is_some_and(|h| {
            if self.has(SeederFlaw::DeadlineSecondEarly) {
                now + 1 >= h.deadline
            } else if self.has(SeederFlaw::DeadlineSecondLate) {
                now > h.deadline
            } else {
                now >= h.deadline
            }
        }) && !self.has(SeederFlaw::FreedAfterDeadline);
        if let Some((at, reads, freed)) = st.own_reads.get_mut(&self.slot(key))
            && *at == now
            && !at_deadline
            && !(self.has(SeederFlaw::FloorFirstFreeOnly) && *freed > 0)
        {
            *freed = reads.len();
        }
    }

    /// Run `free`, which frees `key`'s turn if payment `pay` holds it. With `flaw`, a
    /// planted defect of that way of freeing it, a turn held past its deadline is noted as
    /// freed now, not at the deadline.
    fn freeing(
        &self,
        st: &mut State,
        key: Key,
        pay: u64,
        flaw: SeederFlaw,
        free: impl FnOnce(&mut State) -> Vec<Waker>,
    ) -> Vec<Waker> {
        let now = self.clock.now();
        let late = self.has(flaw)
            && st
                .paying
                .get(&key)
                .is_some_and(|h| h.pay == pay && now >= h.deadline);
        let wake = free(st);
        if late
            && let Some((at, reads, freed)) = st.own_reads.get_mut(&self.slot(key))
            && *at == now
        {
            *freed = reads.len();
        }
        wake
    }

    /// Where `key`'s own reads are counted: its account's (by peer alone, with the flaw).
    fn slot(&self, key: Key) -> Key {
        if self.has(SeederFlaw::ReuseByPeer) {
            (key.0, 0)
        } else {
            key
        }
    }

    /// Abandon payment `pay`: it is answered `mint-unavailable`, and its account released.
    fn abandon(&self, st: &mut State, key: Key, pay: u64) -> Vec<Waker> {
        let mut wake = Vec::new();
        if let Some(r) = st.pays.get_mut(&pay) {
            r.abandoned = true;
            wake.extend(r.waker.take());
        }
        wake.extend(self.release_turn(st, key, pay));
        wake
    }

    /// Wait for `key`'s turn; with `claim`, take it for that payment. A turn held past its
    /// deadline is taken over (its payment abandoned). `false` first: the claiming
    /// payment's own deadline passed first. Then, if it waited, as the turn was found free:
    /// the second, and how many of the account's reads that second had been sent when the
    /// turn was last freed. A `hello` that waited reads after that ([`Inner::learn_own`]).
    /// Last, whether this wait took the turn over.
    async fn wait_turn_at(
        &self,
        key: Key,
        claim: Option<u64>,
    ) -> (bool, Option<(u64, usize)>, bool) {
        let mut waited = false;
        let mut arrival: Option<(u64, usize)> = None;
        let mut first_holder: Option<u64> = None;
        let mut first_wake: Option<(u64, usize)> = None;
        let mut uncounted = false;
        let mut took_over = false;
        let mut late_floor: Option<(u64, usize)> = None;
        poll_fn(|cx| {
            let mut wake = Vec::new();
            let done = {
                let mut st = self.state();
                let now = self.clock.now();
                let mut done = None;
                // A turn held past its deadline is taken over: its payment is abandoned.
                if let Some(h) = st.paying.get(&key) {
                    let (holder, deadline) = (h.pay, h.deadline);
                    let expired = if self.has(SeederFlaw::TakeoverAt61) {
                        now > deadline
                    } else {
                        now >= deadline
                    };
                    let takeover = expired
                        && !self.has(SeederFlaw::NoTakeover)
                        && !self.has(SeederFlaw::NoDeadline)
                        && !(claim.is_some() && self.has(SeederFlaw::PayNoTakeover));
                    if takeover {
                        let flaw = SeederFlaw::TakeoverFreedAfterDeadline;
                        wake = self.freeing(&mut st, key, holder, flaw, |st| {
                            self.abandon(st, key, holder)
                        });
                        took_over = true;
                        if !waited && claim.is_none() && self.has(SeederFlaw::LateArrivalWaited) {
                            let sent = st
                                .own_reads
                                .get(&self.slot(key))
                                .filter(|(at, ..)| *at == now)
                                .map_or(0, |(_, reads, _)| reads.len());
                            late_floor = Some((now, sent));
                        }
                    }
                }
                // A payment whose own deadline has passed takes no turn.
                let over = claim.and_then(|id| st.pays.get(&id)).is_some_and(|r| {
                    r.abandoned
                        || (now >= r.deadline && !self.has(SeederFlaw::TurnWaitPastDeadline))
                });
                if over && !self.has(SeederFlaw::NoDeadline) {
                    done = Some(false);
                } else if let Some(holder) = st.paying.get(&key).map(|h| h.pay)
                    && !(claim.is_none()
                        && self.has(SeederFlaw::HelloWaitsForFirstOnly)
                        && first_holder.is_some_and(|f| f != holder))
                {
                    first_holder.get_or_insert(holder);
                    // A `hello` behind a later payment: the one it first waited for has left.
                    let moved_on = claim.is_none() && first_holder != Some(holder);
                    if moved_on && first_wake.is_none() && self.has(SeederFlaw::FloorAtFirstWake) {
                        let freed = st
                            .own_reads
                            .get(&self.slot(key))
                            .filter(|(at, ..)| *at == now)
                            .map_or(0, |(_, _, freed)| *freed);
                        first_wake = Some((now, freed));
                    }
                    if moved_on && !uncounted && self.has(SeederFlaw::HelloUncountedAfterFirst) {
                        uncounted = true;
                        if let Some(n) = st.hellos_waiting.get_mut(&key.0) {
                            *n = n.saturating_sub(1);
                            if *n == 0 {
                                st.hellos_waiting.remove(&key.0);
                            }
                        }
                    }
                    if moved_on && self.has(SeederFlaw::QuoteAtFirstWake) {
                        let position = st
                            .accounts
                            .get(&key)
                            .map_or((0, 0, 0), |a| (a.admitted, a.acked, a.spent));
                        st.first_wake_position.entry(key).or_insert(position);
                    }
                    if !waited && self.has(SeederFlaw::FloorAtArrival) {
                        let sent = st
                            .own_reads
                            .get(&self.slot(key))
                            .filter(|(at, ..)| *at == now)
                            .map_or(0, |(_, reads, _)| reads.len());
                        arrival = Some((now, sent));
                    }
                    waited = true;
                    st.waiting.entry(key).or_default().push(cx.waker().clone());
                    if !self.has(SeederFlaw::TurnNoClockWatch) {
                        self.clock.watch(cx.waker());
                    }
                    drop(st);
                    wake_all(wake);
                    return Poll::Pending;
                }
                let freed = st
                    .own_reads
                    .get(&self.slot(key))
                    .filter(|(at, ..)| *at == now)
                    .map_or(0, |(_, _, freed)| *freed);
                if uncounted {
                    *st.hellos_waiting.entry(key.0).or_default() += 1; // for its `done`
                }
                if done.is_none() {
                    if let Some(id) = claim {
                        let deadline = if self.has(SeederFlaw::HolderDeadlineFromTurn) {
                            now + SEEDER_DEADLINE.as_secs()
                        } else {
                            st.pays.get(&id).map_or(u64::MAX, |r| r.deadline)
                        };
                        st.paying.insert(key, Holder { pay: id, deadline });
                    }
                    done = Some(true);
                }
                let floor = if self.has(SeederFlaw::FloorAtArrival) {
                    arrival
                } else if first_wake.is_some() {
                    first_wake
                } else if late_floor.is_some() {
                    late_floor
                } else {
                    (waited || self.has(SeederFlaw::FloorWithoutWait)).then_some((now, freed))
                };
                (done, floor)
            };
            let (done, floor) = done;
            wake_all(wake);
            Poll::Ready((done.unwrap_or(true), floor, took_over))
        })
        .await
    }

    /// Fetch the quoted mint's keys for payment `pay`: `false` once its deadline passes
    /// first, or it has been abandoned. Keys it finds at or past its deadline (whole
    /// seconds: in the deadline's second too) came after it, and are not used: the checks
    /// they serve would be reached late.
    async fn fetch_keys(&self, mint: &str, pay: u64) -> bool {
        poll_fn(|cx| {
            let found = self.net.fetch_keys(mint, cx.waker());
            if found && self.has(SeederFlaw::LateKeysUsed) {
                return Poll::Ready(true);
            }
            let st = self.state();
            let now = self.clock.now();
            let over = st.pays.get(&pay).is_none_or(|r| {
                let past = if found && self.has(SeederFlaw::KeysInDeadlineSecondUsed) {
                    now > r.deadline
                } else {
                    now >= r.deadline
                };
                r.abandoned || past
            });
            if over && !self.has(SeederFlaw::NoDeadline) {
                return Poll::Ready(false);
            }
            if found {
                return Poll::Ready(true);
            }
            if !self.has(SeederFlaw::FetchNoClockWatch) {
                self.clock.watch(cx.waker());
            }
            Poll::Pending
        })
        .await
    }

    /// The swap's outcome has come, on whatever task: settle it in time, or as late.
    fn land(&self, id: u64, pay: &Settle, token: &str, outputs: u64, outcome: Swap) {
        // The outcome arrives; the harness may move the clock before it is settled
        // ([`Harness::advance_during_next_land`]). Lateness is judged at settlement.
        let arrived = self.clock.now();
        let during = std::mem::take(&mut self.net.ledger().advance_during_land);
        if during > 0 {
            self.clock.advance(Duration::from_secs(during));
        }
        let wake = {
            let mut st = self.state();
            // A payment whose outcome was decided has no record left: its answer, lost or
            // not, changes nothing.
            let record = st
                .pays
                .get(&id)
                .map_or(self.has(SeederFlaw::DecidedLostRelearnt), |r| {
                    let in_time = !r.abandoned && self.clock.now() < r.deadline;
                    (in_time || !self.has(SeederFlaw::UnknownOnlyInTime))
                        && (!r.finished || !self.has(SeederFlaw::UnknownOnlyWhileAwaited))
                });
            let unknown = outcome == Swap::Lost
                || (outcome == Swap::Pending && self.has(SeederFlaw::PendingFirstUnknown))
                || (outcome == Swap::OutputsRefused && self.has(SeederFlaw::FirstRefusedUnknown))
                || (outcome == Swap::Expired && self.has(SeederFlaw::FirstExpiredUnknown));
            if unknown && record && !self.has(SeederFlaw::NeverRestores) {
                st.unknown.push(Unknown {
                    pay: pay.clone(),
                    token: token.to_owned(),
                    outputs,
                    since: self.clock.now(),
                });
            }
            let now = self.clock.now();
            let Some(r) = st.pays.get_mut(&id) else {
                return;
            };
            r.landed = true;
            let judged = if self.has(SeederFlaw::LandStaleClock) {
                arrived
            } else {
                now
            };
            // An outcome settled in the deadline's second came after the deadline, which
            // was as that second began.
            let past = if self.has(SeederFlaw::LandInTimeAtDeadline) {
                judged > r.deadline
            } else {
                judged >= r.deadline
            };
            let expired =
                past && !self.has(SeederFlaw::NoDeadline) && !self.has(SeederFlaw::LateByFlagOnly);
            let late = (r.abandoned && !self.has(SeederFlaw::LandStaleClock)) || expired;
            r.abandoned = late;
            let finished = r.finished;
            let mut wake: Vec<Waker> = r.waker.take().into_iter().collect();
            if late {
                self.settle_late(&mut st, pay, outcome);
            } else {
                let answer = self.settle(&mut st, pay, outcome);
                if let Some(r) = st.pays.get_mut(&id) {
                    r.answer = Some(answer);
                }
            }
            let flaw = SeederFlaw::LandFreedAfterDeadline;
            wake.extend(self.freeing(&mut st, pay.key, id, flaw, |st| {
                self.release_turn(st, pay.key, id)
            }));
            if finished && !self.has(SeederFlaw::LandKeepsFinished) {
                st.pays.remove(&id);
            }
            wake
        };
        wake_all(wake);
    }

    /// The answer to payment `id` once its swap is sent: its outcome if it settled in
    /// time, else `mint-unavailable` at the deadline.
    fn answer(&self, id: u64, cx: &Context<'_>) -> Poll<Result<Ack, Rej>> {
        let (result, wake) = {
            let mut st = self.state();
            let now = self.clock.now();
            let beats = self.has(SeederFlaw::DeadlineBeatsSettled);
            let Some(r) = st.pays.get_mut(&id) else {
                return Poll::Ready(Err(unavailable("no record of this payment")));
            };
            let expired = now >= r.deadline && !self.has(SeederFlaw::NoDeadline);
            if (!beats || !expired)
                && let Some(a) = r.answer.take()
            {
                return Poll::Ready(a);
            }
            if r.abandoned {
                return Poll::Ready(Err(unavailable("no answer from the mint within 60 s")));
            }
            if !expired {
                r.waker = Some(cx.waker().clone());
                self.clock.watch(cx.waker());
                return Poll::Pending;
            }
            r.answer = None;
            let key = r.key;
            let flaw = SeederFlaw::AnswerFreedAfterDeadline;
            let wake = self.freeing(&mut st, key, id, flaw, |st| self.abandon(st, key, id));
            (
                Err(unavailable("no answer from the mint within 60 s")),
                wake,
            )
        };
        wake_all(wake);
        Poll::Ready(result)
    }

    fn identities_held(&self) -> usize {
        let st = self.state();
        st.accounts.len()
            + st.banned.len()
            + st.open.len()
            + st.open_count.len()
            + st.open_accounts.len()
            + st.hellos_waiting.len()
            + st.ever.len()
            + st.paying.len()
            + st.waiting.len()
            + st.pays.len()
            + st.debt.len()
            + st.unknown.len()
            + st.own_reads.len()
    }
}

/// A read of an account's swaps under way (a round trip): marked back when it is, or
/// abandoned if its entry is dropped first. Either way it was sent, and counts.
struct Reading<'a> {
    e: &'a Inner,
    slot: Key,
    at: u64,
    index: usize,
    back: bool,
}

impl<'a> Reading<'a> {
    fn start(e: &'a Inner, slot: Key, at: u64, by: Option<Vec<u64>>, covers: Vec<u64>) -> Self {
        let index = e.record_read(slot, at, by, covers, ReadState::UnderWay);
        Self {
            e,
            slot,
            at,
            index,
            back: false,
        }
    }

    /// A read whose place [`Inner::take_place`] took.
    fn taken(e: &'a Inner, slot: Key, at: u64, index: usize) -> Self {
        Self {
            e,
            slot,
            at,
            index,
            back: false,
        }
    }

    fn back(mut self) {
        self.set(ReadState::Back);
        self.back = true;
    }

    fn set(&self, state: ReadState) {
        self.with(|r| r.state = state);
    }

    /// The swaps it covers, by their outputs.
    fn cover(&self, covers: Vec<u64>) {
        self.with(|r| r.covers = covers);
    }

    fn with(&self, f: impl FnOnce(&mut OwnRead)) {
        let mut st = self.e.state();
        let ignores = self.e.has(SeederFlaw::ReadingIgnoresSecond);
        if let Some((at, reads, _)) = st.own_reads.get_mut(&self.slot)
            && (*at == self.at || ignores)
            && let Some(r) = reads.get_mut(self.index)
        {
            f(r);
        }
    }
}

impl Drop for Reading<'_> {
    fn drop(&mut self) {
        if self.back {
            return;
        }
        if self.e.has(SeederFlaw::AbandonedFreesItsPlace) {
            // The nineteenth rework's: the abandoned read gives its place back.
            let mut st = self.e.state();
            if let Some((at, reads, _)) = st.own_reads.get_mut(&self.slot)
                && *at == self.at
                && self.index < reads.len()
            {
                reads.remove(self.index);
            }
            return;
        }
        self.set(ReadState::Abandoned);
    }
}

/// A payment's parameters, carried into its swap's completion.
#[derive(Clone)]
struct Settle {
    key: Key,
    upto: u64,
    amount: u64,
    snapshot: Vec<u64>,
    session_spent: Arc<AtomicU64>,
}

/// Owned by a `pay` future: when it answers or is dropped, the payment's record is
/// finished, and a turn it holds without a swap in flight is released. Dropped before its
/// swap is sent (its connection closed), it is abandoned unswapped.
struct PayGuard {
    e: Arc<Inner>,
    id: u64,
    /// The future answered, not dropped on the way.
    answered: bool,
}

impl Drop for PayGuard {
    fn drop(&mut self) {
        let wake = {
            let mut st = self.e.state();
            let Some(r) = st.pays.get_mut(&self.id) else {
                return;
            };
            r.finished = true;
            r.waker = None;
            let (key, sent, landed) = (r.key, r.sent, r.landed);
            if sent && !landed && self.e.has(SeederFlaw::DropAbandonsInFlight) {
                r.abandoned = true;
            }
            if sent && !landed {
                // The swap's completion, or a read of its state past the deadline, settles
                // it and releases the turn.
                Vec::new()
            } else {
                st.pays.remove(&self.id);
                if sent
                    || self.e.has(SeederFlaw::RefusalKeepsTurn)
                    || (!self.answered && self.e.has(SeederFlaw::DropHoldsTurn))
                {
                    Vec::new()
                } else {
                    let (e, flaw) = (&self.e, SeederFlaw::ReleaseFreedAfterDeadline);
                    e.freeing(&mut st, key, self.id, flaw, |st| {
                        e.release_turn(st, key, self.id)
                    })
                }
            }
        };
        wake_all(wake);
    }
}

/// A `hello` waiting for its account's turn, counted toward its peer's session cap.
struct HelloWait {
    e: Arc<Inner>,
    peer: PeerId,
    counted: bool,
}

impl HelloWait {
    fn done(&mut self, st: &mut State) {
        if !self.counted {
            return;
        }
        self.counted = false;
        if let Some(n) = st.hellos_waiting.get_mut(&self.peer) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                st.hellos_waiting.remove(&self.peer);
            }
        }
    }
}

impl Drop for HelloWait {
    fn drop(&mut self) {
        if self.counted && !self.e.has(SeederFlaw::HelloWaitLeaksOnDrop) {
            let e = self.e.clone();
            let mut st = e.state();
            self.done(&mut st);
        }
    }
}

/// An honest seeder (NFX-07 §3). With a [`SeederFlaw`] it is deliberately not.
#[derive(Clone)]
pub struct MockEngine(Arc<Inner>);

impl MockEngine {
    /// A seeder for `videos` (each with its member files), or its refusal to start
    /// ([`EngineConfig::validate`]).
    pub fn try_new(
        config: EngineConfig,
        videos: Vec<(VideoAddr, HashSet<String>)>,
        net: MockNetwork,
        clock: Clock,
        flaw: Option<SeederFlaw>,
    ) -> Result<Self, String> {
        if flaw != Some(SeederFlaw::NoValidate) {
            config.check(flaw)?;
        }
        Ok(Self(Arc::new(Inner {
            config,
            videos: videos
                .into_iter()
                .map(|(addr, members)| Video { addr, members })
                .collect(),
            clock,
            net,
            flaw,
            state: Mutex::new(State::default()),
        })))
    }

    /// Per-identity records held.
    #[must_use]
    pub fn identities_held(&self) -> usize {
        self.0.identities_held()
    }
}

fn rej(code: RejCode, detail: &str) -> Rej {
    Rej {
        code,
        detail: Some(detail.to_owned()),
    }
}

impl SeederEngine for MockEngine {
    type Session = MockSession;

    async fn sweep(&self) {
        if self.0.net.round_trips() {
            next_poll().await;
        }
        self.0.learn(None, None, Learner::Sweep);
    }

    async fn hello(&self, peer: &PeerId, hello: &Hello) -> Result<MockSession, Rej> {
        let e = &self.0;
        let video = match e.videos.iter().position(|v| v.addr == hello.video) {
            Some(v) => v,
            None if e.has(SeederFlaw::HelloAnyVideo) => 0,
            None => return Err(rej(RejCode::UnknownVideo, "not served here")),
        };
        let key = (*peer, video);
        let count_key = (
            *peer,
            e.has(SeederFlaw::SessionCapPerVideo).then_some(video),
        );
        let cap = MAX_OPEN_SESSIONS_PER_PEER + usize::from(e.has(SeederFlaw::SessionCapOffByOne));
        {
            let mut st = e.state();
            e.age(&mut st);
            if e.peer_banned(&st, key) && !e.has(SeederFlaw::HelloBanNotAtArrival) {
                return Err(rej(RejCode::Banned, "this peer is banned"));
            }
            if st.open.contains_key(&hello.session) && !e.has(SeederFlaw::SessionIdAnyPeer) {
                return Err(rej(RejCode::BadSession, "that session is open"));
            }
            let opened = if e.has(SeederFlaw::SessionCapLifetime) {
                st.ever.get(peer).copied().unwrap_or(0)
            } else {
                st.open_count.get(&count_key).copied().unwrap_or(0)
            };
            let waiting = if e.has(SeederFlaw::HelloWaitUncapped) {
                0
            } else {
                st.hellos_waiting.get(peer).copied().unwrap_or(0)
            };
            if opened + waiting >= cap {
                return Err(rej(RejCode::BadSession, "too many open sessions"));
            }
            *st.hellos_waiting.entry(*peer).or_default() += 1;
        }
        let mut wait = HelloWait {
            e: e.clone(),
            peer: *peer,
            counted: true,
        };
        if e.has(SeederFlaw::HelloReadsBeforeTurn) {
            e.learn_own(key, None, None, None).await;
        }
        // Wait for a payment in progress, so the quote cannot miss it; then read, after it.
        let (mut floor, mut took_over) = (None, false);
        if !e.has(SeederFlaw::QuoteWithoutTurn) {
            (_, floor, took_over) = e.wait_turn_at(key, None).await;
        }
        if e.has(SeederFlaw::HelloBanCheckBeforeRead) {
            let mut st = e.state();
            e.age(&mut st);
            if e.peer_banned(&st, key) {
                return Err(rej(RejCode::Banned, "this peer is banned"));
            }
        }
        if e.has(SeederFlaw::HelloReadsBeforeTurn)
            || (took_over && e.has(SeederFlaw::HelloTakeoverSkipsRead))
        {
        } else if e.has(SeederFlaw::HelloReadsAll) {
            e.learn(None, None, Learner::Hello);
        } else if e.has(SeederFlaw::HelloAwaitsRead) {
            let now = e.clock.now();
            let reuse = e
                .state()
                .own_reads
                .get(&key)
                .is_some_and(|(at, ..)| *at == now);
            if !reuse && e.has_reads(key) {
                next_poll().await; // the round trip, counted only once it is back
                if let Some(learnt) = e.learn_read(Some(key), None) {
                    e.learn_apply(&learnt, Learner::Hello);
                    e.record_read(key, now, None, learnt.covers(), ReadState::Back);
                }
            }
        } else {
            e.learn_own(key, None, None, floor).await;
        }
        let mut st = e.state();
        wait.done(&mut st);
        e.age(&mut st);
        // The ban again, as it answers: after its wait and its reads.
        let waited = floor.is_some() || took_over;
        let recheck = !(!waited && e.has(SeederFlaw::HelloRecheckOnlyAfterWait))
            && !e.has(SeederFlaw::HelloNoBanRecheck)
            && !e.has(SeederFlaw::HelloBanCheckBeforeRead)
            && !(took_over && e.has(SeederFlaw::HelloTakeoverSkipsBanRecheck));
        if recheck && e.peer_banned(&st, key) {
            return Err(rej(RejCode::Banned, "this peer is banned"));
        }
        if st.open.contains_key(&hello.session)
            && !e.has(SeederFlaw::SessionIdAnyPeer)
            && !e.has(SeederFlaw::HelloNoSessionRecheck)
        {
            return Err(rej(RejCode::BadSession, "that session is open"));
        }
        st.open.insert(hello.session.clone(), key);
        *st.open_count.entry(count_key).or_default() += 1;
        *st.open_accounts.entry(key).or_default() += 1;
        if e.has(SeederFlaw::SessionCapLifetime) {
            *st.ever.entry(*peer).or_default() += 1;
        }
        if e.has(SeederFlaw::FreshWindowPerHello) {
            st.accounts.remove(&key);
        }
        if e.has(SeederFlaw::HelloCreatesAccount) {
            e.account(&mut st, key);
        }
        // A hello creates no account: a new one quotes zeros.
        let mut position = st
            .accounts
            .get(&key)
            .map_or((0, 0, 0), |a| (a.admitted, a.acked, a.spent));
        if e.has(SeederFlaw::QuoteAtFirstWake)
            && let Some(noted) = st.first_wake_position.remove(&key)
        {
            position = noted;
        }
        let (mut served, accepted_upto, mut spent_total) = position;
        let peer_wide = |f: fn(&Account) -> u64| -> u64 {
            st.accounts
                .iter()
                .filter(|(k, _)| k.0 == *peer)
                .map(|(_, a)| f(a))
                .sum()
        };
        if e.has(SeederFlaw::QuoteServedPeerWide) {
            served = peer_wide(|a| a.admitted);
        }
        if e.has(SeederFlaw::QuoteSpentPeerWide) {
            spent_total = peer_wide(|a| a.spent);
        }
        drop(st);
        let forget = e.has(SeederFlaw::QuoteForgetsAccount);
        let quote = Quote {
            price_per_chunk: e.config.price_per_chunk,
            mints: e.config.mints.clone(),
            window: e.config.window,
            served: if forget { 0 } else { served },
            accepted_upto: if forget { 0 } else { accepted_upto },
            spent_total: if forget { 0 } else { spent_total },
        };
        Ok(MockSession {
            e: self.0.clone(),
            key,
            count_key,
            session: hello.session.clone(),
            quote,
            session_spent: Arc::new(AtomicU64::new(0)),
        })
    }
}

/// One open session of a [`MockEngine`]. Dropping it closes it.
pub struct MockSession {
    e: Arc<Inner>,
    key: Key,
    count_key: (PeerId, Option<usize>),
    session: String,
    quote: Quote,
    session_spent: Arc<AtomicU64>,
}

impl Drop for MockSession {
    fn drop(&mut self) {
        let now = self.e.clock.now();
        let from_close = !self.e.has(SeederFlaw::ForgetsFromLastAdmission);
        let mut st = self.e.state();
        if st.open.get(&self.session) == Some(&self.key) && !self.e.has(SeederFlaw::SessionIdLeaks)
        {
            st.open.remove(&self.session);
        }
        if let Some(n) = st.open_count.get_mut(&self.count_key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                st.open_count.remove(&self.count_key);
            }
        }
        if let Some(n) = st.open_accounts.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 || self.e.has(SeederFlaw::ForgetsOnFirstClose) {
                st.open_accounts.remove(&self.key);
            }
        }
        // An account is idle from its last session's close.
        if from_close && let Some(a) = st.accounts.get_mut(&self.key) {
            a.last_active = now;
        }
    }
}

impl MockSession {
    /// What a flawed engine does on refusing a decoded token of `amount`.
    fn on_refusal(&mut self, token: &str, upto: u64, amount: u64, amount_refusal: bool) {
        let e = self.e.clone();
        let mut st = e.state();
        if e.has(SeederFlaw::RefusalCredits) {
            e.credit(&mut st, self.key, (upto, 0), &[], false);
        }
        if amount_refusal && e.has(SeederFlaw::RefusalAdvancesAcked) {
            let a = e.account(&mut st, self.key);
            a.acked = a.acked.max(upto);
        }
        if e.has(SeederFlaw::SpentTotalCountsRefused) {
            e.account(&mut st, self.key).spent += amount;
        }
        drop(st);
        if e.has(SeederFlaw::ClaimsOnRefusal) {
            e.net.claim_first(token);
        }
    }

    fn settle_now(&self, upto: u64, amount: u64, outcome: Swap) -> Result<Ack, Rej> {
        let settle = Settle {
            key: self.key,
            upto,
            amount,
            snapshot: Vec::new(),
            session_spent: self.session_spent.clone(),
        };
        self.e.settle(&mut self.e.state(), &settle, outcome)
    }

    /// Payment `id`, its turn come (`took_over`: its wait took the turn over from a payment
    /// past its deadline): its checks, its read and its swap.
    async fn pay_in_turn(&mut self, pay: &Pay, id: u64, took_over: bool) -> Result<Ack, Rej> {
        let e = self.e.clone();
        let turn_came = e.clock.now();
        if e.has(SeederFlaw::KeysetFirst) && e.keyset_too_soon() {
            return Err(unavailable("the mint's keyset expires too soon to swap to"));
        }
        if e.has(SeederFlaw::ClaimsBeforeChecking) {
            let _ = e.net.swap_now(&pay.token);
        }
        let read_first = took_over && e.has(SeederFlaw::TakeoverReadsBeforeChecks);
        if read_first {
            let proofs = e.net.read(&pay.token).map_or_else(Vec::new, |i| i.proofs);
            let deadline = e.state().pays.get(&id).map_or(0, |r| r.deadline);
            e.learn_here(self.key, proofs, deadline).await;
        }
        // The structure checks (step 1), on the token as it reads.
        let structure = || -> Result<TokenInfo, Rej> {
            let Some(info) = e.net.read(&pay.token) else {
                return Err(rej(RejCode::BadToken, "unreadable token"));
            };
            let no_dleq = info.dleq == Dleq::Missing && !e.has(SeederFlaw::NoDleqAccepted);
            let too_many = if e.has(SeederFlaw::ProofCapOffByOne) {
                info.proofs.len() >= MAX_PROOFS
            } else {
                info.proofs.len() > MAX_PROOFS && !e.has(SeederFlaw::TooManyProofsAccepted)
            };
            let shape_bad =
                info.unit != "sat" || info.mints.len() != 1 || info.locked || no_dleq || too_many;
            if shape_bad && !e.has(SeederFlaw::AcceptsBadTokens) {
                return Err(rej(
                    RejCode::BadToken,
                    "not a single-mint sat token with DLEQs",
                ));
            }
            Ok(info)
        };
        if e.has(SeederFlaw::StructureBeforeBan) {
            structure()?;
        }
        // The ban first: a banned peer's payment is refused `banned`, whatever it offers.
        let ban_now = !e.has(SeederFlaw::BanCheckedLast)
            && !e.has(SeederFlaw::PayIgnoresBan)
            && !e.has(SeederFlaw::BanCheckedBeforeTurn)
            && !(took_over && e.has(SeederFlaw::PayTakeoverSkipsBan));
        let (acked, snapshot) = {
            let mut st = e.state();
            if !e.has(SeederFlaw::PayBanNotAged)
                && !(took_over && e.has(SeederFlaw::TakeoverBanNotAged))
            {
                e.age(&mut st);
            }
            let (acked, snapshot) = st.accounts.get(&self.key).map_or((0, Vec::new()), |a| {
                (a.acked, a.unpaid.iter().copied().collect())
            });
            if e.has(SeederFlaw::StaleBeforeBan) && pay.upto_chunk <= acked {
                return Err(rej(RejCode::Stale, "already paid up to there"));
            }
            if ban_now && e.peer_banned(&st, self.key) {
                return Err(rej(RejCode::Banned, "this peer is banned"));
            }
            (acked, snapshot)
        };
        let read_before_stale = took_over && e.has(SeederFlaw::TakeoverReadsBeforeStale);
        if read_before_stale {
            let proofs = e.net.read(&pay.token).map_or_else(Vec::new, |i| i.proofs);
            let deadline = e.state().pays.get(&id).map_or(0, |r| r.deadline);
            e.learn_here(self.key, proofs, deadline).await;
        }
        if pay.upto_chunk <= acked
            && !e.has(SeederFlaw::IgnoresStale)
            && !(took_over && e.has(SeederFlaw::TakeoverStaleSkipped))
        {
            return Err(rej(RejCode::Stale, "already paid up to there"));
        }
        // 1. Structure.
        let info = structure()?;
        let mint = info.mints[0].clone();
        if e.has(SeederFlaw::DleqAtTokenMint) {
            e.net.dial(&mint);
            if info.dleq == Dleq::Invalid {
                return Err(rej(RejCode::BadToken, "an invalid DLEQ"));
            }
        }
        // 2. The mint: exactly a quoted URL, before anything is fetched.
        let quoted = if e.has(SeederFlaw::PrefixMint) {
            e.config.mints.iter().any(|q| mint.starts_with(q.as_str()))
        } else {
            e.config.mints.contains(&mint)
        };
        if !quoted && !e.has(SeederFlaw::AcceptsForeignMint) {
            self.on_refusal(&pay.token, pay.upto_chunk, info.amount, false);
            return Err(rej(RejCode::BadMint, "not a quoted mint"));
        }
        if e.has(SeederFlaw::ReadsBeforeKeyFetch) {
            let deadline = e.state().pays.get(&id).map_or(0, |r| r.deadline);
            e.learn_here(self.key, info.proofs.clone(), deadline).await;
        }
        // 3. DLEQ, against the quoted mint's keys, fetched within the deadline.
        if !e.fetch_keys(&mint, id).await {
            return Err(unavailable("no keys from the mint within 60 s"));
        }
        let read_before_amount = took_over && e.has(SeederFlaw::TakeoverReadsBeforeAmount);
        if read_before_amount {
            let deadline = e.state().pays.get(&id).map_or(0, |r| r.deadline);
            e.learn_here(self.key, info.proofs.clone(), deadline).await;
        }
        if info.dleq == Dleq::Invalid && !e.has(SeederFlaw::AcceptsBadTokens) {
            return Err(rej(RejCode::BadToken, "an invalid DLEQ"));
        }
        if e.has(SeederFlaw::ReadsBeforeAmount) {
            let deadline = e.state().pays.get(&id).map_or(0, |r| r.deadline);
            e.learn_here(self.key, info.proofs.clone(), deadline).await;
        }
        // 4. The exact face value; a product beyond 2^53-1 can never be paid.
        let chunks = pay.upto_chunk.saturating_sub(acked);
        let due = if e.has(SeederFlaw::WrappingMul) {
            Some(chunks.wrapping_mul(e.config.price_per_chunk))
        } else {
            chunks
                .checked_mul(e.config.price_per_chunk)
                .filter(|d| *d <= MAX_INT)
        };
        if due.is_none_or(|d| info.amount < d) {
            self.on_refusal(&pay.token, pay.upto_chunk, info.amount, true);
            return Err(rej(RejCode::Underpaid, "short of the chunks claimed"));
        }
        if due.is_some_and(|d| info.amount > d) && !e.has(SeederFlaw::AcceptsOverpay) {
            self.on_refusal(&pay.token, pay.upto_chunk, info.amount, true);
            return Err(rej(RejCode::Overpaid, "more than the chunks claimed"));
        }
        // 5. Swap, then acknowledge.
        let (upto, amount) = (pay.upto_chunk, info.amount);
        if e.has(SeederFlaw::AckBeforeSwap) {
            let (e2, key) = (e.clone(), self.key);
            e.net.swap_later(
                &pay.token,
                Box::new(move |outcome| {
                    if outcome == Swap::Spent {
                        let mut st = e2.state();
                        e2.ban(&mut st, key);
                    }
                }),
            );
            return self.settle_now(upto, amount, Swap::Claimed);
        }
        let immediate = if e.has(SeederFlaw::SpentCheckLastProof) {
            Some(e.net.swap_checking_last_only(&pay.token))
        } else if e.has(SeederFlaw::SwapsUnspentSubset) {
            Some(if e.net.steal(&pay.token) {
                Swap::Claimed
            } else {
                Swap::Spent
            })
        } else {
            None
        };
        if let Some(outcome) = immediate {
            return self.settle_now(upto, amount, outcome);
        }
        if e.has(SeederFlaw::ClaimThenAwaitCredit) {
            let submitted = e.net.submit(&pay.token, 0, Box::new(|_| {}));
            let outcome = poll_fn(|cx| match e.net.try_answer(submitted, cx.waker()) {
                Some(a) => Poll::Ready(a),
                None => Poll::Pending,
            })
            .await;
            return self.settle_now(upto, amount, outcome);
        }
        let settle = Settle {
            key: self.key,
            upto,
            amount,
            snapshot,
            session_spent: self.session_spent.clone(),
        };
        // Outputs only from a keyset that outlives any wait to decide this swap: none whose
        // listed `final_expiry` is sooner than twice `account_ttl` away. With none, no swap:
        // the seeder's own keyset error, read nothing for.
        if !e.has(SeederFlaw::KeysetAfterRead)
            && !e.has(SeederFlaw::KeysetFirst)
            && e.keyset_too_soon()
        {
            return Err(unavailable("the mint's keyset expires too soon to swap to"));
        }
        // The swap's outputs, derived for it alone (NUT-13): its retries reuse them, and
        // a restore of them finds this swap and no other.
        let outputs = e.net.fresh_outputs();
        // Send the swap, unless the deadline has passed: its completion settles it (in
        // time, or late) and releases the turn, whether or not this future still waits.
        // Past the deadline nothing more is judged: it is answered `mint-unavailable`.
        // The watermark is read again as it is sent: a late claim may have moved it
        // during the key fetch.
        // While this account's earlier swap has an unknown outcome, nothing more is swapped
        // for it: what the seeder must learn stays one swap per account.
        // Its account's own unknown swaps are read once, now: after its checks, so a
        // payment the seeder would refuse anyway costs the mint nothing, and by its
        // deadline. A payment that took the turn over reads the abandoned swap so.
        // The watermark is read again after it: a late claim it learns may cover this
        // payment.
        let proofs = e.net.read(&pay.token).map_or_else(Vec::new, |i| i.proofs);
        let deadline = if took_over && e.has(SeederFlaw::TakeoverReadsWithoutDeadline) {
            u64::MAX
        } else if e.has(SeederFlaw::ReadDeadlineFromRead) {
            e.clock.now() + SEEDER_DEADLINE.as_secs()
        } else if e.has(SeederFlaw::ReadDeadlineFromTurn) {
            turn_came + SEEDER_DEADLINE.as_secs()
        } else {
            e.state().pays.get(&id).map_or(0, |r| r.deadline)
        };
        let recheck = |acked_now: u64| -> Result<(), Rej> {
            if acked_now == acked || e.has(SeederFlaw::NoRecheckAtSend) {
                return Ok(());
            }
            if pay.upto_chunk <= acked_now {
                return Err(rej(RejCode::Stale, "already paid up to there"));
            }
            let due_now = (pay.upto_chunk - acked_now)
                .checked_mul(e.config.price_per_chunk)
                .filter(|d| *d <= MAX_INT);
            let by_amount = !e.has(SeederFlaw::RecheckStaleOnly);
            if by_amount && due_now.is_none_or(|d| amount < d) {
                return Err(rej(RejCode::Underpaid, "short of the chunks claimed"));
            }
            if by_amount && due_now.is_some_and(|d| amount > d) {
                return Err(rej(RejCode::Overpaid, "more than the chunks claimed"));
            }
            Ok(())
        };
        if e.has(SeederFlaw::RecheckBeforeRead) {
            recheck(e.state().accounts.get(&self.key).map_or(0, |a| a.acked))?;
        }
        if e.has(SeederFlaw::BanCheckedLast) {
            let mut st = e.state();
            e.age(&mut st);
            if e.peer_banned(&st, self.key) {
                return Err(rej(RejCode::Banned, "this peer is banned"));
            }
        }
        let read_already = read_first || read_before_stale || read_before_amount;
        if !read_already && !(took_over && e.has(SeederFlaw::PayTakeoverSkipsRead)) {
            e.learn_here(self.key, proofs, deadline).await;
        }
        if e.has(SeederFlaw::KeysetAfterRead) && e.keyset_too_soon() {
            return Err(unavailable("the mint's keyset expires too soon to swap to"));
        }
        {
            let mut st = e.state();
            let now = e.clock.now();
            if e.unknown_swap(&st, self.key, id) && !e.has(SeederFlaw::UnknownUnbounded) {
                if e.has(SeederFlaw::PayDropsDebtLog) {
                    let key = self.key;
                    st.debt.retain(|(debt, _)| debt.0 != key);
                }
                return Err(unavailable("an earlier payment's outcome is not known yet"));
            }
            let acked_now = st.accounts.get(&self.key).map_or(0, |a| a.acked);
            let recheck_first = e.has(SeederFlaw::RecheckPastDeadline);
            if recheck_first && !e.has(SeederFlaw::RecheckBeforeRead) {
                recheck(acked_now)?;
            }
            let Some(r) = st.pays.get_mut(&id) else {
                return Err(unavailable("no record of this payment"));
            };
            if e.has(SeederFlaw::SentBeforeExpiry) {
                r.sent = true;
            }
            let expired = now >= r.deadline
                && !e.has(SeederFlaw::NoDeadline)
                && !e.has(SeederFlaw::SendIgnoresDeadline);
            if r.abandoned || expired {
                let wake = e.abandon(&mut st, self.key, id);
                drop(st);
                wake_all(wake);
                return Err(unavailable("no answer from the mint within 60 s"));
            }
            if !recheck_first && !e.has(SeederFlaw::RecheckBeforeRead) {
                recheck(acked_now)?;
            }
            r.sent = true;
            r.swap = Some((settle.clone(), pay.token.clone(), outputs));
            if e.has(SeederFlaw::DeadlineFromSwap) {
                let deadline = now + SEEDER_DEADLINE.as_secs();
                r.deadline = deadline;
                if let Some(h) = st.paying.get_mut(&self.key)
                    && h.pay == id
                {
                    h.deadline = deadline;
                }
            }
        }
        let e2 = e.clone();
        let token = pay.token.clone();
        e.net.submit(
            &pay.token,
            outputs,
            Box::new(move |outcome| {
                let outcome = e2.after_swap(id, &token, outputs, outcome);
                e2.land(id, &settle, &token, outputs, outcome);
            }),
        );
        poll_fn(|cx| e.answer(id, cx)).await
    }
}

impl SeederSession for MockSession {
    fn quote(&self) -> &Quote {
        &self.quote
    }

    fn admit(&mut self, sha256: &str) -> bool {
        let e = self.e.clone();
        let mut st = e.state();
        if e.has(SeederFlaw::AdmitBanNotAged) {
            let bans = st.banned.clone(); // its debt ages, its bans do not
            e.age(&mut st);
            st.banned = bans;
        } else {
            e.age(&mut st);
        }
        if e.peer_banned(&st, self.key) && !e.has(SeederFlaw::AdmitIgnoresBan) {
            if e.has(SeederFlaw::BannedAdmitCounts) || e.has(SeederFlaw::BannedAdmitCountsToAccount)
            {
                let now = e.clock.now();
                let a = e.account(&mut st, self.key);
                a.admitted += 1;
                let (n, generation) = (a.admitted, a.generation);
                a.unpaid.push_back(n);
                if e.has(SeederFlaw::BannedAdmitCounts) {
                    let debt = e.debt_key(self.key, generation, n);
                    st.debt.push_back((debt, now));
                    st.live.insert(debt);
                }
            }
            return false;
        }
        let member = e.videos[self.key.1].members.contains(sha256);
        if !member && !e.has(SeederFlaw::AdmitsForeignChunks) {
            if e.has(SeederFlaw::ForeignAdmitCounts) {
                // Under a generation of its own: it collides with no account's chunk.
                let generation = st.next_generation;
                st.next_generation += 1;
                let debt = e.debt_key(self.key, generation, 1);
                st.debt.push_back((debt, e.clock.now()));
                st.live.insert(debt);
            }
            return false;
        }
        let covered = if e.has(SeederFlaw::CoveredPeerWide) {
            st.accounts
                .iter()
                .any(|(k, a)| k.0 == self.key.0 && a.admitted < a.acked)
        } else {
            st.accounts
                .get(&self.key)
                .is_some_and(|a| a.admitted < a.acked)
        };
        if !covered || e.has(SeederFlaw::CapBeforeCredit) {
            if !covered {
                let unpaid = e.window_count(&st, self.key);
                let full = if e.has(SeederFlaw::WindowOffByOne) {
                    unpaid > e.config.window
                } else {
                    unpaid >= e.config.window
                };
                if full {
                    return false;
                }
            }
            let global = e.global_unpaid(&st);
            let capped = if e.has(SeederFlaw::GlobalCapGt) {
                global > e.config.global_cap
            } else {
                global >= e.config.global_cap
            };
            if capped && !e.has(SeederFlaw::NoGlobalCap) {
                return false;
            }
        }
        let mut st = if e.has(SeederFlaw::AdmitSplitLock) {
            drop(st); // the checks and the count in two steps: another admission between
            e.net.meet_admissions();
            e.state()
        } else {
            st
        };
        let now = e.clock.now();
        let a = e.account(&mut st, self.key);
        if e.has(SeederFlaw::CountsDistinctFiles) && !a.files.insert(sha256.to_owned()) {
            return true;
        }
        a.admitted += 1;
        if !covered || e.has(SeederFlaw::CoveredLoggedAsDebt) {
            let (n, generation) = (a.admitted, a.generation);
            a.unpaid.push_back(n);
            let debt = e.debt_key(self.key, generation, n);
            st.debt.push_back((debt, now));
            st.live.insert(debt);
            st.flawed_count = st.flawed_count.wrapping_add(1);
        }
        true
    }

    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej> {
        if self.e.has(SeederFlaw::BanCheckedBeforeTurn) && self.banned() {
            return Err(rej(RejCode::Banned, "this peer is banned"));
        }
        // The deadline counts from here, the payment's arrival.
        let id = self.e.arrive(self.key);
        let mut record = PayGuard {
            e: self.e.clone(),
            id,
            answered: false,
        };
        let mut took_over = false;
        if !self.e.has(SeederFlaw::ConcurrentPays) {
            let (came, _, taken) = self.e.wait_turn_at(self.key, Some(id)).await;
            if !came {
                record.answered = true;
                return Err(unavailable("the account's turn did not come within 60 s"));
            }
            took_over = taken;
        }
        let answer = self.pay_in_turn(pay, id, took_over).await;
        record.answered = true;
        answer
    }

    fn banned(&self) -> bool {
        let mut st = self.e.state();
        if !self.e.has(SeederFlaw::BannedNotAged) {
            self.e.age(&mut st);
        }
        self.e.peer_banned(&st, self.key)
    }
}

/// A payment sent and not yet settled.
#[derive(Debug, Clone)]
struct Pending {
    upto: u64,
    amount: u64,
    token: String,
    sent_at: u64,
}

/// A watcher's standing with one seeder, shared by its ledgers for that seeder's videos
/// (NFX-07 §3a). Entries name the ledger they belong to.
#[derive(Default)]
struct Standing {
    /// The watcher has stopped paying this seeder.
    stopped: bool,
    /// The ledger with the payment in flight toward the seeder, unsettled ones included.
    in_flight: Option<u64>,
    /// Payments closed sessions left unsettled.
    unsettled: Vec<(u64, Pending)>,
    /// Payments whose reclaim the mint could not serve yet.
    reclaiming: Vec<(u64, Pending)>,
    /// Payments whose proofs were found spent, each awaiting a quote on its ledger.
    lost: Vec<(u64, Pending)>,
    /// `mint-unavailable` answers in a row since the last ack or quote.
    unavailable: u32,
    next_ledger: u64,
    /// Proofs the mint lists under an expired keyset, kept to pay with again
    /// ([`ViewerFlaw::PaysWithExpiredProofs`] only: an honest wallet drops them).
    expired_kept: Vec<u64>,
}

/// An honest viewer's ledger with one seeder for one video, holding tokens from one mint
/// (NFX-07 §3a); its standing with the seeder is shared with its siblings. With a
/// [`ViewerFlaw`] it is deliberately not honest.
pub struct MockViewer {
    net: MockNetwork,
    clock: Clock,
    flaw: Option<ViewerFlaw>,
    mint: String,
    max_price: u64,
    /// This ledger, in its standing.
    id: u64,
    standing: Arc<Mutex<Standing>>,
    /// This ledger's own stop ([`ViewerFlaw::StopPerVideo`] and
    /// [`ViewerFlaw::BannedHelloStopsLedger`] only).
    halted: bool,
    /// The open session's quote.
    quote: Option<Quote>,
    requested: u64,
    acked: u64,
    spent: u64,
    /// The payment in flight on this session.
    pending: Option<Pending>,
    /// A refusal since the last payment: the next one may pay ahead.
    pay_ahead: bool,
    /// `mint-unavailable` answers counted here ([`ViewerFlaw::UnavailablePerLedger`] only).
    unavailable_here: u32,
}

impl MockViewer {
    #[must_use]
    pub fn new(
        net: MockNetwork,
        clock: Clock,
        mint: &str,
        max_price: u64,
        flaw: Option<ViewerFlaw>,
    ) -> Self {
        Self::ledger(
            net,
            clock,
            mint,
            max_price,
            flaw,
            0,
            Arc::new(Mutex::new(Standing::default())),
        )
    }

    fn ledger(
        net: MockNetwork,
        clock: Clock,
        mint: &str,
        max_price: u64,
        flaw: Option<ViewerFlaw>,
        id: u64,
        standing: Arc<Mutex<Standing>>,
    ) -> Self {
        Self {
            net,
            clock,
            flaw,
            mint: mint.to_owned(),
            max_price,
            id,
            standing,
            halted: false,
            quote: None,
            requested: 0,
            acked: 0,
            spent: 0,
            pending: None,
            pay_ahead: false,
            unavailable_here: 0,
        }
    }

    fn has(&self, f: ViewerFlaw) -> bool {
        self.flaw == Some(f)
    }

    fn standing(&self) -> MutexGuard<'_, Standing> {
        lock(&self.standing)
    }

    /// Stop paying this seeder.
    fn halt(&mut self) {
        if self.has(ViewerFlaw::StopPerVideo) {
            self.halted = true;
        } else {
            self.standing().stopped = true;
        }
    }

    fn halted(&self) -> bool {
        if self.has(ViewerFlaw::StopPerVideo) {
            self.halted
        } else {
            self.standing().stopped || self.halted
        }
    }

    fn reclaim_incomplete(&self) -> bool {
        let own = self.has(ViewerFlaw::ReclaimPerVideo);
        self.standing()
            .reclaiming
            .iter()
            .any(|(l, _)| !own || *l == self.id)
    }

    /// Whether a payment awaits a quote: any of the standing's, or this ledger's only.
    fn awaiting(&self, own_only: bool) -> bool {
        self.standing()
            .lost
            .iter()
            .any(|(l, _)| !own_only || *l == self.id)
    }

    fn set_pending(&mut self, p: Pending) {
        self.pending = Some(p);
        self.standing().in_flight = Some(self.id);
    }

    /// Free the standing's in-flight slot if `ledger` holds it.
    fn free_slot(&self, ledger: u64) {
        let mut st = self.standing();
        if st.in_flight == Some(ledger) {
            st.in_flight = None;
        }
    }

    fn take_pending(&mut self) -> Option<Pending> {
        let p = self.pending.take();
        if p.is_some() {
            self.free_slot(self.id);
        }
        p
    }

    /// Take `token`'s proofs back, as this viewer does.
    fn take_back(&self, token: &str, retry: bool) -> Reclaim {
        if self.has(ViewerFlaw::NoReclaim) {
            return Reclaim::All;
        }
        if self.has(ViewerFlaw::ReclaimsFirstProofOnly) {
            self.net.claim_first(token);
            return Reclaim::All;
        }
        let (first, expired_code) = self
            .net
            .reclaim_as(token, self.has(ViewerFlaw::ExpiredCheckDownIsUnspent));
        let outcome = match first {
            // Refused 12003 with an input pending: the request that reserved it may still
            // sign, so the reclaim is incomplete (below), never lost to the expiry.
            Reclaim::Pending if expired_code && self.has(ViewerFlaw::ExpiredPendingIsLost) => {
                Reclaim::Expired
            }
            // Spent may be this watcher's own reclaim, gone through unanswered: a restore
            // of its outputs shows which.
            Reclaim::SomeSpent if !self.has(ViewerFlaw::ReclaimNoRestore) => {
                match self
                    .net
                    .restore_reclaim(token, self.has(ViewerFlaw::ReclaimRestoreAny))
                {
                    Some(true) => Reclaim::All,
                    // Refused because a keyset expired, with every spent input its own (its
                    // reclaim of the good proofs, answer lost): the rest, every one unspent,
                    // are decided per proof, below.
                    Some(false)
                        if expired_code
                            && !self.has(ViewerFlaw::ExpiredRestoreNeedsEveryProof)
                            && (self.net.restore_spent_own(token) == Some(true)
                                || (self.has(ViewerFlaw::ExpiredSpentAnyOwn)
                                    && self.net.restore_reclaim(token, true) == Some(true))) =>
                    {
                        Reclaim::Expired
                    }
                    // Refused because a keyset expired, with a spent input not its own: it
                    // awaits a quote, and still takes back the inputs left unspent and not
                    // listed expired, as it does when no keyset has expired. While those
                    // cannot be taken back yet, the reclaim is incomplete.
                    Some(false)
                        if expired_code && !self.has(ViewerFlaw::ExpiredForeignKeepsRest) =>
                    {
                        match self.net.reclaim_unexpired(token) {
                            Reclaim::Pending if self.has(ViewerFlaw::ForeignPendingAwaits) => {
                                Reclaim::SomeSpent
                            }
                            Reclaim::Blocked | Reclaim::Pending
                                if !self.has(ViewerFlaw::ExpiredForeignBlockedAwaits) =>
                            {
                                Reclaim::Blocked
                            }
                            _ => Reclaim::SomeSpent,
                        }
                    }
                    Some(false) => Reclaim::SomeSpent,
                    None if self.has(ViewerFlaw::ReclaimRestoreDownIsBack) => Reclaim::All,
                    None if self.has(ViewerFlaw::ReclaimRestoreDownIsSpent) => Reclaim::SomeSpent,
                    None => Reclaim::Blocked,
                }
            }
            outcome => outcome,
        };
        match outcome {
            Reclaim::SomeSpent
                if self.has(ViewerFlaw::IgnoresReclaimOutcome)
                    || (retry && self.has(ViewerFlaw::RetryIgnoresSpent)) =>
            {
                Reclaim::All
            }
            // Refused as pending: nothing was taken back yet, and nothing is lost yet
            // either. It is retried like a reclaim the mint did not answer.
            Reclaim::Pending if self.has(ViewerFlaw::ReclaimPendingIsSpent) => Reclaim::SomeSpent,
            Reclaim::Expired if self.has(ViewerFlaw::ExpiredReclaimRetried) => Reclaim::Blocked,
            // Decided per proof, by the mint's listing: those under an expired keyset are
            // lost to the expiry, the rest taken back in a reclaim of their own. None listed
            // expired: the 12003 was the reclaim's outputs' (an expired active keyset), so
            // it is incomplete, retried once the mint has a keyset to take them back to.
            Reclaim::Expired if !self.has(ViewerFlaw::ExpiredByCodeAlone) => {
                let (expired, good) = self.net.proofs_listing(token);
                let outputs_first =
                    self.has(ViewerFlaw::OutputsExpiryFirst) && self.net.active_expired();
                let decided = if outputs_first || expired == 0 {
                    Reclaim::Blocked
                } else if good == 0 || self.has(ViewerFlaw::ExpiredTokenWhole) {
                    Reclaim::Expired
                } else if self.has(ViewerFlaw::ExpiredNeedsEveryProof) {
                    Reclaim::Blocked
                } else if self.has(ViewerFlaw::MixedActiveExpiredWritesOff)
                    && self.net.active_expired()
                {
                    Reclaim::Expired
                } else {
                    self.net.reclaim_unexpired(token)
                };
                if decided == Reclaim::Expired && self.has(ViewerFlaw::PaysWithExpiredProofs) {
                    let lost = self.net.proofs_listed_expired(token);
                    self.standing().expired_kept.extend(lost);
                }
                decided
            }
            Reclaim::Pending => Reclaim::Blocked,
            outcome => outcome,
        }
    }

    /// Reclaim payment `p` of `ledger`. Proofs found spent leave it awaiting a quote on
    /// that ledger; a mint that is down leaves the reclaim to finish later. Either way
    /// nothing is paid to the seeder until then.
    fn reclaim(&mut self, ledger: u64, p: Pending, retry: bool) {
        match self.take_back(&p.token, retry) {
            // Expired: lost to the expiry, not taken by the seeder. Nothing is left to wait
            // for, and the seeder is owed no blame: the watcher pays again.
            Reclaim::All | Reclaim::Expired => {}
            Reclaim::SomeSpent if self.has(ViewerFlaw::LostIsFinal) => self.halt(),
            Reclaim::SomeSpent => self.standing().lost.push((ledger, p)),
            Reclaim::Blocked | Reclaim::Pending => self.standing().reclaiming.push((ledger, p)),
        }
    }

    fn waited(&self, p: &Pending) -> bool {
        let wait = if self.has(ViewerFlaw::TimeoutAt179) {
            ANSWER_WAIT.as_secs() - 1
        } else {
            ANSWER_WAIT.as_secs()
        };
        self.clock.now() >= p.sent_at + wait
    }

    /// Finish incomplete reclaims, and reclaim payments closed sessions left unsettled
    /// once they are 180 s old, whichever of the standing's ledgers they belong to.
    fn catch_up(&mut self) {
        let own = self.has(ViewerFlaw::ReclaimPerVideo);
        let retry: Vec<(u64, Pending)> = {
            let mut st = self.standing();
            let (retry, keep) = std::mem::take(&mut st.reclaiming)
                .into_iter()
                .partition(|(l, _)| !own || *l == self.id);
            st.reclaiming = keep;
            retry
        };
        for (ledger, p) in retry {
            let ledger = if self.has(ViewerFlaw::RetryAsSelf) {
                self.id
            } else {
                ledger
            };
            if self.has(ViewerFlaw::RetryResetsBudget) {
                match self.take_back(&p.token, true) {
                    Reclaim::All | Reclaim::Expired => self.standing().unavailable = 0,
                    Reclaim::SomeSpent => self.standing().lost.push((ledger, p)),
                    Reclaim::Blocked | Reclaim::Pending => {
                        self.standing().reclaiming.push((ledger, p));
                    }
                }
                continue;
            }
            self.reclaim(ledger, p, true);
        }
        if self.has(ViewerFlaw::StoppedSkipsUnsettled) && self.halted() {
            return;
        }
        let own = self.has(ViewerFlaw::CatchUpOwnOnly);
        let early = self.has(ViewerFlaw::CatchUpIgnoresWait);
        let old: Vec<(u64, Pending)> = {
            let mut st = self.standing();
            let (old, keep) = std::mem::take(&mut st.unsettled)
                .into_iter()
                .partition(|(l, p)| (!own || *l == self.id) && (early || self.waited(p)));
            st.unsettled = keep;
            old
        };
        for (ledger, p) in old {
            self.free_slot(ledger);
            let owner = if self.has(ViewerFlaw::CatchUpFilesUnderSelf) {
                self.id
            } else {
                ledger
            };
            if self.has(ViewerFlaw::CatchUpBlockedAsSelf) {
                match self.take_back(&p.token, false) {
                    Reclaim::All | Reclaim::Expired => {}
                    Reclaim::SomeSpent => self.standing().lost.push((owner, p)),
                    Reclaim::Blocked | Reclaim::Pending => {
                        self.standing().reclaiming.push((self.id, p));
                    }
                }
                continue;
            }
            self.reclaim(owner, p, false);
        }
    }

    /// Whether the standing has used its `mint-unavailable` tries for this session.
    fn out_of_tries(&self) -> bool {
        let used = if self.has(ViewerFlaw::UnavailablePerLedger) {
            self.unavailable_here
        } else {
            self.standing().unavailable
        };
        used >= UNAVAILABLE_BUDGET && !self.has(ViewerFlaw::NoUnavailableBudget)
    }

    fn pay_when(&mut self, threshold: u64, last: bool) -> Result<Option<Pay>, String> {
        let Some(q) = self.quote.clone() else {
            return Ok(None);
        };
        let stop_holds = !(last && self.has(ViewerFlaw::LastPayIgnoresStop));
        if self.halted() && stop_holds && self.has(ViewerFlaw::StoppedSkipsReclaim) {
            return Ok(None);
        }
        // Reclaiming is not paying: a stopped viewer still catches up.
        self.catch_up();
        let may_ahead = self.pay_ahead && !last && !self.has(ViewerFlaw::NoPayAhead);
        let reclaim_blocks = self.reclaim_incomplete()
            && !(may_ahead && self.has(ViewerFlaw::PayAheadIgnoresReclaim))
            && !(last && self.has(ViewerFlaw::LastPayIgnoresReclaim));
        // The standing's one slot: this ledger's payment in flight or left unsettled, or
        // another video's.
        let slot = self.standing().in_flight;
        let own = slot == Some(self.id) || self.pending.is_some();
        let own_blocks = own && !(last && self.has(ViewerFlaw::LastPayIgnoresOwnPending));
        let other_blocks = slot.is_some_and(|l| l != self.id)
            && !self.has(ViewerFlaw::InFlightPerVideo)
            && !(last && self.has(ViewerFlaw::LastPayIgnoresOtherInFlight));
        let pending_blocks = (own_blocks || other_blocks)
            && !(may_ahead && self.has(ViewerFlaw::PayAheadIgnoresPending));
        let awaiting = self.awaiting(self.has(ViewerFlaw::StopPerVideo));
        let out_of_tries = self.out_of_tries()
            && !(may_ahead && self.has(ViewerFlaw::PayAheadSkipsBudget))
            && !(last && self.has(ViewerFlaw::LastPayIgnoresBudget));
        if (self.halted() && stop_holds) || awaiting || reclaim_blocks || pending_blocks {
            return Ok(None);
        }
        if out_of_tries {
            return Ok(None);
        }
        let unpaid = self.requested.saturating_sub(self.acked);
        let credit = self.acked.saturating_sub(self.requested);
        let ahead = if !may_ahead {
            0
        } else if self.has(ViewerFlaw::PayAheadUnbounded) {
            q.window / 2
        } else if self.has(ViewerFlaw::PayAheadRoundsUp) {
            q.window.div_ceil(2).saturating_sub(credit)
        } else {
            (q.window / 2).saturating_sub(credit)
        };
        if ahead == 0 && (unpaid == 0 || unpaid < threshold) {
            return Ok(None);
        }
        let extra = u64::from(self.has(ViewerFlaw::PaysAhead));
        let upto = self.requested.max(self.acked) + ahead + extra;
        if upto <= self.acked {
            return Ok(None);
        }
        let price = if self.has(ViewerFlaw::PaysAtCap) {
            self.max_price.max(q.price_per_chunk)
        } else {
            q.price_per_chunk
        };
        let amount = (upto - self.acked)
            .checked_mul(price)
            .ok_or("amount overflows")?;
        let kept = if self.has(ViewerFlaw::PaysWithExpiredProofs) {
            std::mem::take(&mut self.standing().expired_kept)
        } else {
            Vec::new()
        };
        let mut token = self.net.issue_with(&self.mint, amount, &kept);
        // Proofs the mint lists under an expired keyset are worth nothing: never paid with.
        // It drops those it holds and pays with the rest; with only such proofs (the mint's
        // active keyset expired), it pays nothing until the mint rotates.
        let checks = !self.has(ViewerFlaw::PaysWithExpiredProofs)
            && !(last && self.has(ViewerFlaw::LastPayWithExpiredProofs))
            && !(self.has(ViewerFlaw::ListingOnlyWhileActiveExpired) && !self.net.active_expired())
            && !(last
                && self.has(ViewerFlaw::LastPayListingOnlyWhileActiveExpired)
                && !self.net.active_expired());
        if checks && self.net.proofs_listing(&token).0 > 0 {
            self.net.drop_expired_held();
            token = self.net.issue_with(&self.mint, amount, &[]);
            if self.net.proofs_listing(&token).0 > 0 {
                return Ok(None);
            }
        }
        self.set_pending(Pending {
            upto,
            amount,
            token: token.clone(),
            sent_at: self.clock.now(),
        });
        if !self.has(ViewerFlaw::PayAheadSticky) {
            self.pay_ahead = false;
        }
        Ok(Some(Pay {
            upto_chunk: upto,
            token,
        }))
    }

    /// Settle this ledger's entry in `list` (of the standing) if `quote` shows it exactly.
    fn settle_by_quote(
        &mut self,
        quote: &Quote,
        pick: fn(&mut Standing) -> &mut Vec<(u64, Pending)>,
        upto_alone: bool,
        spent_alone: bool,
        any_ledger: bool,
    ) -> bool {
        let found = {
            let mut st = self.standing();
            pick(&mut st)
                .iter()
                .find(|(l, _)| any_ledger || *l == self.id)
                .map(|(l, p)| (*l, p.clone()))
        };
        let Some((ledger, p)) = found else {
            return false;
        };
        let upto_ok = quote.accepted_upto == p.upto;
        let spent_ok = if self.has(ViewerFlaw::SettleIgnoresLedgerSpent) {
            quote.spent_total >= p.amount
        } else {
            quote.spent_total == self.spent + p.amount
        };
        let settles = if upto_alone {
            upto_ok
        } else if spent_alone {
            spent_ok
        } else {
            upto_ok && spent_ok
        };
        if !settles {
            return false;
        }
        self.acked = quote.accepted_upto;
        self.spent = quote.spent_total;
        pick(&mut self.standing()).retain(|(l, _)| *l != ledger);
        true
    }
}

impl Viewer for MockViewer {
    fn sibling(&self) -> Self {
        let id = {
            let mut st = self.standing();
            st.next_ledger += 1;
            st.next_ledger
        };
        Self::ledger(
            self.net.clone(),
            self.clock.clone(),
            &self.mint,
            self.max_price,
            self.flaw,
            id,
            self.standing.clone(),
        )
    }

    fn quote(&mut self, quote: &Quote) -> Result<(), String> {
        if self.has(ViewerFlaw::QuoteResetsFirst) {
            self.standing().unavailable = 0;
        }
        if self.quote.is_some() && !self.has(ViewerFlaw::AcceptsSecondQuote) {
            return Err("one quote per session".into());
        }
        let resumed = self.requested > 0 || self.acked > 0;
        let skip_cap = resumed && self.has(ViewerFlaw::SkipsCapOnResume);
        if quote.price_per_chunk > self.max_price && !skip_cap {
            return Err("price above this viewer's cap".into());
        }
        let skip_ceiling = resumed && self.has(ViewerFlaw::SkipsCeilingOnResume);
        if quote.window > WINDOW_CEILING && !self.has(ViewerFlaw::NoWindowCeiling) && !skip_ceiling
        {
            return Err("window above this viewer's ceiling".into());
        }
        if !quote.mints.contains(&self.mint) {
            return Err("no mint this viewer holds tokens from".into());
        }
        // A quote showing an unsettled payment accepted, both fields, settles it.
        if self.settle_by_quote(
            quote,
            |st| &mut st.unsettled,
            self.has(ViewerFlaw::SettleOnUptoOnly),
            self.has(ViewerFlaw::SettleOnSpentOnly),
            self.has(ViewerFlaw::SettleUnsettledAnyLedger),
        ) {
            self.free_slot(self.id);
        }
        // So does one showing a payment that awaits a quote; one equal to the ledger
        // leaves it waiting.
        self.settle_by_quote(
            quote,
            |st| &mut st.lost,
            self.has(ViewerFlaw::SettleLostOnUpto),
            self.has(ViewerFlaw::SettleLostOnSpentOnly),
            self.has(ViewerFlaw::SettleLostAnyLedger),
        );
        // And one showing a payment whose reclaim is incomplete: the seeder has it, and
        // the reclaim is cancelled.
        if !self.has(ViewerFlaw::QuoteIgnoresReclaiming) {
            let keep = self.has(ViewerFlaw::ReclaimSettleKeepsEntry);
            let before = keep.then(|| self.standing().reclaiming.clone());
            self.settle_by_quote(
                quote,
                |st| &mut st.reclaiming,
                self.has(ViewerFlaw::SettleReclaimingOnUpto),
                self.has(ViewerFlaw::SettleReclaimingOnSpentOnly),
                self.has(ViewerFlaw::SettleReclaimingAnyLedger),
            );
            if let Some(entries) = before {
                self.standing().reclaiming = entries;
            }
        }
        let mut honest = quote.served
            <= self.requested + u64::from(self.has(ViewerFlaw::ServedOffByOne))
            && quote.accepted_upto == self.acked
            && quote.spent_total == self.spent;
        if !honest
            && self.has(ViewerFlaw::ResyncsDown)
            && quote.accepted_upto <= self.acked
            && quote.spent_total <= self.spent
        {
            (self.acked, self.spent) = (quote.accepted_upto, quote.spent_total);
            honest = true;
        }
        if !honest && !self.has(ViewerFlaw::TrustsQuote) {
            self.halt();
            return Err("the quote disagrees with this viewer's ledger".into());
        }
        if self.has(ViewerFlaw::ForgivesLost) {
            let id = self.id;
            self.standing().lost.retain(|(l, _)| *l != id);
        }
        // A new session: `mint-unavailable` answers are counted afresh.
        self.standing().unavailable = 0;
        self.unavailable_here = 0;
        self.quote = Some(quote.clone());
        Ok(())
    }

    fn hello_refused(&mut self, rej: &Rej) {
        if self.has(ViewerFlaw::HelloRefusalReclaims) {
            let id = self.id;
            let mine: Vec<(u64, Pending)> = {
                let mut st = self.standing();
                let (mine, keep) = std::mem::take(&mut st.unsettled)
                    .into_iter()
                    .partition(|(l, _)| *l == id);
                st.unsettled = keep;
                mine
            };
            for (ledger, p) in mine {
                self.free_slot(ledger);
                self.reclaim(ledger, p, false);
            }
        }
        if self.has(ViewerFlaw::HelloRefusedFreesSlot) {
            self.standing().in_flight = None;
        }
        if self.has(ViewerFlaw::HelloRefusedResetsBudget) {
            self.standing().unavailable = 0;
        }
        let stops = if self.has(ViewerFlaw::HelloRefusalStops) {
            rej.code != RejCode::BadSession
        } else if self.has(ViewerFlaw::UnknownHelloRefusalStops) {
            matches!(rej.code, RejCode::Banned | RejCode::Other(_))
        } else {
            rej.code == RejCode::Banned && !self.has(ViewerFlaw::BannedHelloIgnored)
        };
        if stops && self.has(ViewerFlaw::BannedHelloStopsLedger) {
            self.halted = true;
        } else if stops {
            self.halt();
        }
    }

    fn requested(&mut self) {
        self.requested += 1;
    }

    fn refused(&mut self) {
        if self.has(ViewerFlaw::PaysForRefused) {
            return;
        }
        if self.has(ViewerFlaw::RefusedNoCredit) {
            if self.requested > self.acked {
                self.requested -= 1;
            }
        } else if self.has(ViewerFlaw::RefusedTwice) {
            self.requested = self.requested.saturating_sub(2);
        } else {
            self.requested = self.requested.saturating_sub(1);
        }
        self.pay_ahead = true;
        if self.has(ViewerFlaw::RefusalResetsUnavailable) {
            self.standing().unavailable = 0;
        }
    }

    async fn due(&mut self) -> Result<Option<Pay>, String> {
        // Pay at half the window, so the seeder never has to stall.
        let window = self.quote.as_ref().map_or(2, |q| q.window);
        let when = if self.has(ViewerFlaw::PaysAtTheWindow) {
            window + 1
        } else if self.has(ViewerFlaw::PaysAtFullWindow) {
            window
        } else {
            window.div_ceil(2)
        };
        self.pay_when(when.max(1), false)
    }

    async fn last_pay(&mut self) -> Result<Option<Pay>, String> {
        self.pay_when(1, true)
    }

    fn ack(&mut self, ack: &Ack) -> Result<(), String> {
        if self.has(ViewerFlaw::AckSettlesUnsettled) && self.pending.is_none() {
            let (id, spent) = (self.id, self.spent);
            let found = self.standing().unsettled.iter().position(|(l, p)| {
                *l == id && ack.accepted_upto == p.upto && ack.spent_total == spent + p.amount
            });
            if let Some(i) = found {
                let (_, p) = self.standing().unsettled.remove(i);
                self.free_slot(id);
                self.acked = p.upto;
                self.spent += p.amount;
                return Ok(());
            }
        }
        let expected = self.take_pending();
        // Short of the payment's upto, though above the ledger.
        let short = |p: &Pending| ack.accepted_upto > self.acked && ack.accepted_upto < p.upto;
        // Short of the payment in both fields, at its price.
        let partial = expected.as_ref().is_some_and(|p| {
            self.has(ViewerFlaw::AckAcceptsPartial)
                && short(p)
                && ack.spent_total.checked_sub(self.spent).is_some_and(|d| {
                    d * (p.upto - self.acked) == (ack.accepted_upto - self.acked) * p.amount
                })
        });
        let ok = match &expected {
            Some(_) if partial => true,
            Some(p) if self.has(ViewerFlaw::AckAcceptsInflated) => {
                ack.accepted_upto >= p.upto && ack.spent_total >= self.spent + p.amount
            }
            Some(p) => {
                (ack.accepted_upto == p.upto || (self.has(ViewerFlaw::AckAcceptsShort) && short(p)))
                    && (ack.spent_total == self.spent + p.amount
                        || self.has(ViewerFlaw::IgnoresSpentTotal)
                        || (self.has(ViewerFlaw::AckAcceptsShortSpent)
                            && ack.accepted_upto == p.upto
                            && ack.spent_total > self.spent
                            && ack.spent_total < self.spent + p.amount))
            }
            None => self.has(ViewerFlaw::AcceptsUnsolicitedAck),
        };
        if ok || self.has(ViewerFlaw::IgnoresBadAck) {
            self.acked = ack.accepted_upto;
            if partial {
                self.spent = ack.spent_total;
            } else if let Some(p) = expected {
                self.spent += p.amount;
            }
            if !self.has(ViewerFlaw::AckKeepsUnavailable) {
                self.standing().unavailable = 0;
                self.unavailable_here = 0;
            }
            return Ok(());
        }
        self.halt();
        Err("an ack that does not match what was paid".into())
    }

    async fn rej(&mut self, rej: &Rej) {
        let was_halted = self.halted();
        if was_halted && self.has(ViewerFlaw::RejSkipsWhenStopped) {
            return;
        }
        if self.has(ViewerFlaw::NoReclaimUnlessSpent) && rej.code != RejCode::Spent {
            self.take_pending();
            self.halt();
            return;
        }
        let Some(p) = self.take_pending() else {
            // It answers no payment of this session: unsolicited.
            if self.has(ViewerFlaw::UnsolicitedRejReclaimsUnsettled) {
                let id = self.id;
                let mine: Vec<(u64, Pending)> = {
                    let mut st = self.standing();
                    let (mine, keep) = std::mem::take(&mut st.unsettled)
                        .into_iter()
                        .partition(|(l, _)| *l == id);
                    st.unsettled = keep;
                    mine
                };
                for (ledger, p) in mine {
                    self.free_slot(ledger);
                    self.reclaim(ledger, p, false);
                }
                return;
            }
            if !self.has(ViewerFlaw::UnsolicitedRejIgnored) {
                self.halt();
            }
            return;
        };
        if !(was_halted && self.has(ViewerFlaw::RejNoReclaimWhenStopped)) {
            self.reclaim(self.id, p, false);
        }
        if rej.code != RejCode::MintUnavailable || self.has(ViewerFlaw::StopsOnOutage) {
            self.halt();
        } else if self.has(ViewerFlaw::UnavailablePerLedger) {
            self.unavailable_here += 1;
        } else {
            self.standing().unavailable += 1;
        }
    }

    async fn timeout(&mut self) {
        let was_halted = self.halted();
        if was_halted && self.has(ViewerFlaw::TimeoutSkipsWhenStopped) {
            return;
        }
        if self.has(ViewerFlaw::TimeoutTouchesUnsettled) && self.pending.is_none() {
            let id = self.id;
            let mine = {
                let st = self.standing();
                st.unsettled.iter().any(|(l, p)| *l == id && self.waited(p))
            };
            if mine {
                self.halt();
            }
            return;
        }
        let Some(p) = &self.pending else {
            return;
        };
        if !self.waited(p) && !self.has(ViewerFlaw::TimeoutEarly) {
            return;
        }
        if let Some(p) = self.take_pending()
            && !(was_halted && self.has(ViewerFlaw::TimeoutNoReclaimWhenStopped))
        {
            self.reclaim(self.id, p, false);
        }
        if !self.has(ViewerFlaw::KeepsPayingAfterTimeout) {
            self.halt();
        }
    }

    fn end(&mut self) {
        self.quote = None;
        if self.has(ViewerFlaw::EndResetsBudget) {
            self.standing().unavailable = 0;
        }
        if let Some(p) = self.pending.take() {
            if self.has(ViewerFlaw::EndReclaimsNow) {
                self.free_slot(self.id);
                self.reclaim(self.id, p, false);
                self.halt();
            } else if self.has(ViewerFlaw::EndForgetsPending) {
                self.free_slot(self.id);
            } else {
                if self.has(ViewerFlaw::EndClearsInFlight) {
                    self.free_slot(self.id);
                }
                self.standing().unsettled.push((self.id, p));
            }
        }
        if self.has(ViewerFlaw::ForgetsLedger) {
            (self.requested, self.acked, self.spent) = (0, 0, 0);
        }
    }

    fn stopped(&self) -> bool {
        self.halted() || self.awaiting(self.has(ViewerFlaw::StopPerVideo))
    }

    fn awaiting_quote(&self) -> bool {
        let tries_used = self.out_of_tries() && !self.has(ViewerFlaw::BudgetNotSignalled);
        !self.halted()
            && (self.awaiting(!self.has(ViewerFlaw::AwaitingQuoteAnyLedger)) || tries_used)
    }
}

/// The mock behind the adversary suite.
pub struct MockHarness {
    net: MockNetwork,
    mint: String,
    videos: [VideoAddr; 2],
    unknown: VideoAddr,
    sessions: AtomicU64,
    clock: Clock,
    seeder_flaw: Option<SeederFlaw>,
    viewer_flaw: Option<ViewerFlaw>,
}

fn addr(s: &str) -> VideoAddr {
    VideoAddr::parse(s).unwrap_or_else(|_| unreachable!("a valid literal"))
}

impl Default for MockHarness {
    fn default() -> Self {
        Self {
            net: MockNetwork::default(),
            mint: "https://mint.mock.example".into(),
            videos: [
                addr("nfx:testnet:1:adversary-suite"),
                addr("nfx:testnet:1:adversary-suite-two"),
            ],
            unknown: addr("nfx:testnet:1:not-served-here"),
            sessions: AtomicU64::new(0),
            clock: Clock::default(),
            seeder_flaw: None,
            viewer_flaw: None,
        }
    }
}

impl MockHarness {
    /// A harness whose engines carry `flaw` (the suite must fail against it).
    #[must_use]
    pub fn with_seeder_flaw(flaw: SeederFlaw) -> Self {
        Self {
            seeder_flaw: Some(flaw),
            ..Self::default()
        }
    }

    /// An honest harness whose mint answers each read of swap state on its reader's next
    /// poll, as a real mint's round trips do: an engine whose reads yield passes the suite
    /// too.
    #[must_use]
    pub fn with_round_trip_reads() -> Self {
        let h = Self::default();
        h.net.ledger().round_trips = true;
        h
    }

    /// A round-trip harness ([`MockHarness::with_round_trip_reads`]) whose seeders carry
    /// `flaw`: for defects only an engine whose reads yield can have.
    #[must_use]
    pub fn with_seeder_flaw_round_trip(flaw: SeederFlaw) -> Self {
        let h = Self::with_seeder_flaw(flaw);
        h.net.ledger().round_trips = true;
        h
    }

    /// A harness whose viewers carry `flaw` (the suite must fail against it).
    #[must_use]
    pub fn with_viewer_flaw(flaw: ViewerFlaw) -> Self {
        Self {
            viewer_flaw: Some(flaw),
            ..Self::default()
        }
    }

    fn token_with(&self, amount: u64, edit: impl FnOnce(&mut TokenInfo)) -> String {
        let mut info = TokenInfo {
            proofs: self.net.proofs_for(amount),
            mints: vec![self.mint.clone()],
            amount,
            unit: "sat",
            locked: false,
            dleq: Dleq::Valid,
        };
        edit(&mut info);
        self.net.mint_token(info)
    }

    fn videos(&self) -> Vec<(VideoAddr, HashSet<String>)> {
        (0..2u8)
            .map(|v| {
                let members = (0..1024).map(|n| self.chunk_of(v, n)).collect();
                (self.videos[usize::from(v)].clone(), members)
            })
            .collect()
    }
}
impl Harness for MockHarness {
    type Engine = MockEngine;
    type Viewer = MockViewer;

    fn engine(&self, price: u64, window: u64, global_cap: u64) -> MockEngine {
        self.engine_checked(EngineParams {
            price,
            window,
            global_cap,
            debt_ttl: DEBT_TTL,
            account_ttl: ACCOUNT_TTL,
            ban_ttl: BAN_TTL,
            mints: 1,
            extra_mint: None,
        })
        .unwrap_or_else(|why| panic!("a seeder refuses this configuration: {why}"))
    }

    fn engine_checked(&self, params: EngineParams) -> Result<MockEngine, String> {
        MockEngine::try_new(
            EngineConfig {
                price_per_chunk: params.price,
                mints: (0..params.mints)
                    .map(|i| {
                        if i == 0 {
                            self.mint.clone()
                        } else {
                            format!("https://mint{i}.mock.example")
                        }
                    })
                    .chain(params.extra_mint.map(str::to_owned))
                    .collect(),
                window: params.window,
                global_cap: params.global_cap,
                debt_ttl: params.debt_ttl,
                account_ttl: params.account_ttl,
                ban_ttl: params.ban_ttl,
            },
            self.videos(),
            self.net.clone(),
            self.clock.clone(),
            self.seeder_flaw,
        )
    }

    fn identities_held(&self, engine: &MockEngine) -> usize {
        engine.identities_held()
    }

    fn hello_for(&self, v: u8) -> Hello {
        let n = self.sessions.fetch_add(1, Ordering::Relaxed);
        Hello {
            video: self.videos[usize::from(v)].clone(),
            session: format!("{n:032x}"),
        }
    }

    fn unknown_hello(&self) -> Hello {
        Hello {
            video: self.unknown.clone(),
            ..self.hello()
        }
    }

    fn session_cap(&self) -> usize {
        MAX_OPEN_SESSIONS_PER_PEER
    }

    fn peer(&self, n: u8) -> PeerId {
        [n; 32]
    }

    fn chunk_of(&self, v: u8, n: u16) -> String {
        format!("{v:02x}{n:062x}")
    }

    fn foreign_chunk(&self) -> String {
        "f".repeat(64)
    }

    fn window_ceiling(&self) -> u64 {
        WINDOW_CEILING
    }

    fn viewer(&self, max_price: u64) -> MockViewer {
        MockViewer::new(
            self.net.clone(),
            self.clock.clone(),
            &self.mint,
            max_price,
            self.viewer_flaw,
        )
    }

    fn mint(&self) -> String {
        self.mint.clone()
    }

    async fn token(&self, amount: u64) -> String {
        self.net.issue(&self.mint, amount)
    }

    async fn token_at(&self, url: &str, amount: u64) -> String {
        self.net.issue(url, amount)
    }

    async fn bad_token(&self, kind: BadToken, amount: u64) -> String {
        match kind {
            BadToken::Garbage => "cashuBgarbage-not-a-token".into(),
            BadToken::WrongUnit => self.token_with(amount, |i| i.unit = "msat"),
            BadToken::TwoMints => self.token_with(amount, |i| {
                i.mints.push("https://other.mock.example".into())
            }),
            BadToken::Locked => self.token_with(amount, |i| i.locked = true),
            BadToken::NoDleq => self.token_with(amount, |i| i.dleq = Dleq::Missing),
            BadToken::BadDleq => self.token_with(amount, |i| i.dleq = Dleq::Invalid),
            BadToken::TooManyProofs => {
                let proofs = self.net.fresh_proofs(MAX_PROOFS + 1);
                self.token_with(amount, |i| i.proofs = proofs)
            }
            BadToken::Forged => {
                let token = self.token_with(amount, |_| {});
                let proofs = self.net.read(&token).map(|i| i.proofs).unwrap_or_default();
                self.net.ledger().forged.extend(proofs);
                token
            }
        }
    }

    async fn reencode(&self, token: &str) -> String {
        let info = self
            .net
            .read(token)
            .unwrap_or_else(|| unreachable!("the suite re-encodes its own tokens"));
        self.net.mint_token(info)
    }

    async fn combine(&self, tokens: &[&str]) -> String {
        let infos: Vec<TokenInfo> = tokens
            .iter()
            .map(|t| {
                self.net
                    .read(t)
                    .unwrap_or_else(|| unreachable!("the suite combines its own tokens"))
            })
            .collect();
        let mut mints: Vec<String> = Vec::new();
        for m in infos.iter().flat_map(|i| &i.mints) {
            if !mints.contains(m) {
                mints.push(m.clone());
            }
        }
        self.net.mint_token(TokenInfo {
            proofs: infos.iter().flat_map(|i| i.proofs.clone()).collect(),
            mints,
            amount: infos.iter().map(|i| i.amount).sum(),
            unit: "sat",
            locked: false,
            dleq: Dleq::Valid,
        })
    }

    async fn claimed_any(&self, token: &str) -> bool {
        self.net.claimed_any(token)
    }

    async fn claimed_all(&self, token: &str) -> bool {
        self.net.claimed_all(token)
    }

    async fn steal(&self, token: &str) -> bool {
        self.net.steal(token)
    }

    fn dialled(&self, url: &str) -> bool {
        self.net.ledger().dialled.contains(url)
    }

    fn hold_swaps(&self) {
        self.net.ledger().hold = true;
    }

    fn hold_swap_responses(&self) {
        self.net.ledger().hold_responses = true;
    }

    fn hold_key_fetches(&self) {
        self.net.ledger().hold_keys = true;
    }

    fn hold_next_swap(&self) {
        self.net.ledger().hold_next = true;
    }

    async fn release_oldest_swap(&self) {
        self.net.release_oldest();
    }

    async fn release_swaps(&self) {
        self.net.release();
    }

    fn mint_outage(&self, down: bool) {
        self.net.ledger().down = down;
    }

    fn lose_next_swap_response(&self) {
        self.net.ledger().lose_swap = true;
    }

    fn lose_next_reclaim_response(&self) {
        self.net.ledger().lose_reclaim = true;
    }

    async fn steal_one(&self, token: &str) -> bool {
        self.net.steal_one(token)
    }

    async fn reserve_rest(&self, token: &str) -> bool {
        self.net.reserve_rest(token)
    }

    fn restore_outage(&self, down: bool) {
        self.net.ledger().restore_down = down;
    }

    fn time_out_next_swap(&self) {
        self.net.ledger().time_out_next = true;
    }

    fn process_timed_out_mid_read(&self) {
        self.net.ledger().mid_read = true;
    }

    fn deliver_responses_mid_read(&self) {
        self.net.ledger().deliver_mid_read = true;
    }

    fn state_check_outage(&self, down: bool) {
        self.net.ledger().state_down = down;
    }

    fn hold_next_swap_reserving(&self) {
        self.net.ledger().reserve_next = true;
    }

    fn roll_back_reserved(&self) {
        self.net.roll_back_reserved();
    }

    fn state_reads(&self) -> u64 {
        self.net.ledger().reads
    }

    fn limit_state_reads(&self, max: Option<usize>) {
        self.net.ledger().read_limit = max;
    }

    fn unanswered_reads_take(&self, wait: Duration) {
        self.net.ledger().read_timeout = wait.as_secs();
    }

    fn gather_admissions(&self, n: usize, wait: Duration) {
        let mut l = self.net.ledger();
        l.admit_gather = (n, wait);
        l.admit_gathered = 0;
    }

    fn advance_during_next_land(&self, by: Duration) {
        self.net.ledger().advance_during_land = by.as_secs();
    }

    fn advanced_during_land(&self) -> bool {
        self.net.ledger().advance_during_land == 0
    }

    fn gather_state_reads(&self, n: usize, wait: Duration) {
        let mut l = self.net.ledger();
        l.gather = (n, wait);
        l.gathered = 0;
    }

    fn rotate_keyset(&self) {
        let mut l = self.net.ledger();
        l.retired_outputs = l.next;
        if let Some(x) = l.active_expired_since.take() {
            let upto = l.next;
            l.expired_ranges.push((x + 1, upto));
            l.final_expiry = None;
        }
    }

    fn expire_keyset_of(&self, token: &str, proofs: usize) {
        let mut l = self.net.ledger();
        if let Some(i) = l.tokens.get(token).cloned() {
            l.expire_inputs(i.proofs.into_iter().take(proofs));
        }
    }

    fn expire_older_keyset(&self) {
        self.net.ledger().expire_older();
    }

    fn expire_active_keyset(&self) {
        let mut l = self.net.ledger();
        l.final_expiry = Some(self.clock.now());
        // Everything it issued since the last rotation: proofs a wallet already holds too.
        l.active_expired_since = Some(l.retired_outputs);
    }

    fn fund_older_keyset(&self, amount: u64) {
        let mut l = self.net.ledger();
        l.older_balance = amount;
        if l.older_expired {
            // Another older keyset: the expired one's proofs stay expired.
            l.older_expired = false;
            l.older_now.clear();
        }
    }

    fn keyset_expires_in(&self, after: Option<Duration>) {
        self.net.ledger().final_expiry = after.map(|d| self.clock.now() + d.as_secs());
    }

    fn expire_keyset(&self) {
        let mut l = self.net.ledger();
        l.expired_upto = l.next;
    }

    fn before_next_swap(&self, event: MintEvent) {
        self.net.ledger().before_swap.push(event);
    }

    fn clock_secs(&self) -> u64 {
        self.clock.now()
    }

    fn sweep_during_next_read(&self, engine: &MockEngine) {
        let e = engine.0.clone();
        self.net.ledger().during_read = Some(Box::new(move || {
            e.learn(None, None, Learner::Sweep);
        }));
    }

    fn advance(&self, by: Duration) {
        self.clock.advance(by);
    }

    fn debt_ttl(&self) -> Duration {
        DEBT_TTL
    }

    fn account_ttl(&self) -> Duration {
        ACCOUNT_TTL
    }

    fn ban_ttl(&self) -> Duration {
        BAN_TTL
    }
}
