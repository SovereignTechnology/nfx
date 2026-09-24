//! A mock mint network and honest mock engines: an executable reading of NFX-07 §3 and §3a.
//!
//! Tokens look like `cashuBmock<hex>`, which no real Cashu wallet accepts. They hold
//! power-of-two proofs, as a real mint issues them. The network tracks **proofs**, not
//! token strings, so a re-encoded or combined token is still a double spend.
//! - A swap is atomic: it claims every proof of a token, or none.
//! - Swaps can be held (not processed), or processed with their responses held.
//! - The mint can be taken down.
//! - The seeder and the viewers keep time on the harness's clock, so debt can age and
//!   answers can be late.
//!
//! No money and no cryptography are involved.
//!
//! Every defect the audits found in plausible engines can be planted with [`SeederFlaw`]
//! or [`ViewerFlaw`]; `tests/mutants.rs` shows the adversary suite catches each one.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::poll_fn;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Poll, Waker};
use std::time::Duration;

use nfx_proto::namespace::VideoAddr;
use nfx_proto::pay::{Ack, Hello, MAX_INT, Pay, Quote, Rej, RejCode};

use crate::session::{BadToken, Harness, PeerId, SeederEngine, SeederSession, Viewer};

/// Sessions one peer may hold open at once, across all videos.
pub const MAX_OPEN_SESSIONS_PER_PEER: usize = 8;
/// How long an unpaid chunk counts toward the global cap (NFX-07 §3: 1 h recommended).
pub const DEBT_TTL: Duration = Duration::from_secs(3600);
/// The shortest `debt_ttl` a seeder accepts (NFX-07 §3).
pub const MIN_DEBT_TTL: Duration = Duration::from_secs(600);
/// How long a watcher waits for an answer before reclaiming (NFX-07 §3a).
pub const ANSWER_WAIT: Duration = Duration::from_secs(120);
/// The most proofs one payment may hold (NFX-07 §3).
pub const MAX_PROOFS: usize = 64;

/// Payment state is not trusted after a panic: a poisoned lock aborts the caller.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock()
        .unwrap_or_else(|_| panic!("a poisoned lock: payment state is not trusted"))
}

/// The harness's clock, in whole seconds.
#[derive(Clone, Default)]
pub struct Clock(Arc<AtomicU64>);

impl Clock {
    fn now(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }

    fn advance(&self, by: Duration) {
        self.0.fetch_add(by.as_secs(), Ordering::Relaxed);
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
    /// The mint refuses the proofs (forged, or not a token); nothing was claimed.
    Invalid,
    /// The mint could not be reached; nothing happened.
    Unreachable,
}

/// How a wallet's reclaim of its own proofs ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reclaim {
    /// Every proof was taken back.
    All,
    /// Some proof had already been claimed by someone else (the rest were taken back).
    SomeSpent,
    /// The mint could not be reached; try again later.
    Blocked,
}

type Done = Box<dyn FnOnce(Swap) + Send>;

#[derive(Default)]
struct Ledger {
    tokens: HashMap<String, TokenInfo>,
    claimed: HashSet<u64>,
    forged: HashSet<u64>,
    next: u64,
    hold: bool,
    hold_responses: bool,
    down: bool,
    dialled: HashSet<String>,
    /// Swaps sent while held: not yet processed.
    queued: Vec<(u64, String, Done)>,
    /// Swaps processed whose responses are held.
    responses: Vec<(u64, Swap, Done)>,
    /// Delivered outcomes, by submission.
    answers: HashMap<u64, Swap>,
    waiting: Vec<Waker>,
    /// Swaps an acknowledge-first engine left for later ([`SeederFlaw::AckBeforeSwap`]).
    deferred: Vec<(String, Done)>,
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
        let proofs = self.proofs_for(amount);
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

    /// Fetch something (keys) from the mint at `url`.
    fn dial(&self, url: &str) {
        self.ledger().dialled.insert(url.to_owned());
    }

    /// Swap every proof of `token` at its mint, atomically, now.
    #[must_use]
    pub fn swap_now(&self, token: &str) -> Swap {
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
        if info.proofs.iter().any(|p| l.forged.contains(p)) {
            return Swap::Invalid;
        }
        if info.proofs.iter().any(|p| l.claimed.contains(p)) {
            return Swap::Spent;
        }
        l.claimed.extend(info.proofs);
        Swap::Claimed
    }

    /// Send a swap, as an engine does: `done` runs with the outcome when the mint answers,
    /// whether or not anyone is still waiting for it. Returns a handle for
    /// [`MockNetwork::answer`].
    fn submit(&self, token: &str, done: Done) -> u64 {
        let id = {
            let mut l = self.ledger();
            l.next += 1;
            let id = l.next;
            if l.hold {
                l.queued.push((id, token.to_owned(), done));
                return id;
            }
            id
        };
        let outcome = self.swap_now(token);
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

    /// Wait for a submitted swap's answer.
    async fn answer(&self, id: u64) -> Swap {
        poll_fn(|cx| {
            let mut l = self.ledger();
            if let Some(a) = l.answers.remove(&id) {
                Poll::Ready(a)
            } else {
                l.waiting.push(cx.waker().clone());
                Poll::Pending
            }
        })
        .await
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
    /// unspent ones. It honours outages.
    fn reclaim(&self, token: &str) -> Reclaim {
        let mut l = self.ledger();
        if l.down {
            return Reclaim::Blocked;
        }
        let Some(info) = l.tokens.get(token).cloned() else {
            return Reclaim::SomeSpent;
        };
        let fresh: Vec<u64> = info
            .proofs
            .iter()
            .copied()
            .filter(|p| !l.claimed.contains(p) && !l.forged.contains(p))
            .collect();
        let all = fresh.len() == info.proofs.len();
        l.claimed.extend(fresh);
        if all {
            Reclaim::All
        } else {
            Reclaim::SomeSpent
        }
    }

    /// A third party claiming whatever is unclaimed, outages aside: whether it got any.
    fn steal(&self, token: &str) -> bool {
        let mut l = self.ledger();
        let Some(info) = l.tokens.get(token).cloned() else {
            return false;
        };
        let fresh: Vec<u64> = info
            .proofs
            .iter()
            .copied()
            .filter(|p| !l.claimed.contains(p) && !l.forged.contains(p))
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

    fn release(&self) {
        let (queued, responses, deferred) = {
            let mut l = self.ledger();
            l.hold = false;
            l.hold_responses = false;
            (
                std::mem::take(&mut l.queued),
                std::mem::take(&mut l.responses),
                std::mem::take(&mut l.deferred),
            )
        };
        for (id, token, done) in queued {
            let outcome = self.swap_now(&token);
            done(outcome);
            self.deliver(id, outcome);
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
    /// Counts the window per account, not per peer across its videos.
    PerVideoWindow,
    /// Treats a chunk as covered if any of the peer's accounts has credit.
    CoveredPeerWide,
    NoGlobalCap,
    GlobalCapGt,
    /// Nets every account's credit against every other's debt.
    GlobalCapNetsCredit,
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
    /// Acknowledges first and swaps later (the design the second audit retired).
    AckBeforeSwap,
    /// Claims, then credits only if the `pay` future is still alive to see the answer.
    ClaimThenAwaitCredit,
    OutageBans,
    OutageCredits,
    SpentTotalCountsRefused,
    SpentTotalPerSession,
    /// Handles one account's payments concurrently.
    ConcurrentPays,
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
    LastPayIgnoresStop,
    PaysForRefused,
    /// Un-owes a refused request only while it is unpaid, so a paid one is paid twice.
    RefusedNoCredit,
    /// Un-owes two chunks per refusal.
    RefusedTwice,
    /// Never pays ahead after a refusal, so a full cap locks it out.
    NoPayAhead,
    TrustsQuote,
    /// Adopts a quote below its ledger.
    ResyncsDown,
    /// Checks its price cap on the first quote only.
    SkipsCapOnResume,
    KeepsPayingAfterTimeout,
    /// Reclaims an unanswered payment before 120 s.
    TimeoutEarly,
    /// Reclaims a payment in flight the moment its connection closes.
    EndReclaimsNow,
    /// Forgets a payment in flight when its connection closes.
    EndForgetsPending,
    ForgetsLedger,
    /// Stops paying after `mint-unavailable`.
    StopsOnOutage,
}

/// (peer, video index): one account.
type Key = (PeerId, usize);

#[derive(Default)]
struct Account {
    admitted: u64,
    acked: u64,
    spent: u64,
    /// Chunk numbers of unpaid admissions, oldest first.
    unpaid: VecDeque<u64>,
    files: HashSet<String>,
    banned: bool,
}

#[derive(Default)]
struct State {
    accounts: HashMap<Key, Account>,
    banned: HashSet<PeerId>,
    /// Open session ids and their account.
    open: HashMap<String, Key>,
    /// Open sessions per peer (or per account, with [`SeederFlaw::SessionCapPerVideo`]).
    open_count: HashMap<(PeerId, Option<usize>), usize>,
    ever: HashMap<PeerId, usize>,
    /// Unpaid admissions (account, chunk, time), oldest first, for ageing.
    debt: VecDeque<(Key, u64, u64)>,
    /// Unpaid admissions not yet aged out: the global cap's count. A set, so a chunk
    /// cannot be freed twice.
    live: HashSet<(Key, u64)>,
    /// The counter [`SeederFlaw::CountFreedTwice`] keeps instead.
    flawed_count: u64,
    /// Accounts with a payment in progress.
    paying: HashSet<Key>,
    /// Payments waiting for their account's turn.
    waiting: Vec<Waker>,
}

/// A seeder's configuration (NFX-07 §3).
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub price_per_chunk: u64,
    pub mints: Vec<String>,
    pub window: u64,
    pub global_cap: u64,
    pub debt_ttl: Duration,
}

impl EngineConfig {
    /// A seeder refuses to start outside these (NFX-07 §3). A zero `debt_ttl` would switch
    /// the cap off.
    pub fn validate(&self) -> Result<(), String> {
        if self.price_per_chunk == 0 {
            return Err("price_per_chunk is at least 1".into());
        }
        if self.mints.is_empty() {
            return Err("quote at least one mint".into());
        }
        if self.window < 2 {
            return Err("window is at least 2".into());
        }
        if self.global_cap == 0 {
            return Err("the global cap is at least 1".into());
        }
        if self.debt_ttl < MIN_DEBT_TTL {
            return Err("debt_ttl is at least 10 minutes".into());
        }
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

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    fn has(&self, f: SeederFlaw) -> bool {
        self.flaw == Some(f)
    }

    fn free_flawed(&self, st: &mut State, n: u64) {
        st.flawed_count = if self.has(SeederFlaw::CountFreedTwiceWrapping) {
            st.flawed_count.wrapping_sub(n)
        } else {
            st.flawed_count.saturating_sub(n)
        };
    }

    /// Age out unpaid admissions older than `debt_ttl` from the global count.
    fn age(&self, st: &mut State) {
        if self.has(SeederFlaw::DebtNeverAges) {
            return;
        }
        let ttl = if self.has(SeederFlaw::AgeTtlOneSecond) {
            1
        } else {
            self.config.debt_ttl.as_secs()
        };
        let now = self.clock.now();
        while let Some(&(key, n, t)) = st.debt.front() {
            if t.saturating_add(ttl) > now {
                break;
            }
            st.debt.pop_front();
            st.live.remove(&(key, n));
            self.free_flawed(st, 1);
        }
    }

    fn peer_banned(&self, st: &State, key: Key) -> bool {
        if self.has(SeederFlaw::BanPerVideo) {
            st.accounts.get(&key).is_some_and(|a| a.banned)
        } else {
            st.banned.contains(&key.0)
        }
    }

    fn ban(&self, st: &mut State, key: Key) {
        if self.has(SeederFlaw::BanPerVideo) {
            st.accounts.entry(key).or_default().banned = true;
        } else {
            st.banned.insert(key.0);
        }
        if self.has(SeederFlaw::BanForgetsDebt) {
            let peer = key.0;
            st.accounts.retain(|k, _| k.0 != peer);
            st.live.retain(|(k, _)| k.0 != peer);
            st.debt.retain(|(k, _, _)| k.0 != peer);
        }
    }

    /// The peer's unpaid chunks across its videos (its window's count).
    fn peer_unpaid(&self, st: &State, key: Key) -> u64 {
        if self.has(SeederFlaw::PeerDebtAges) {
            return st.live.iter().filter(|(k, _)| k.0 == key.0).count() as u64;
        }
        let owed = |a: &Account| a.admitted.saturating_sub(a.acked);
        if self.has(SeederFlaw::PerVideoWindow) {
            return st.accounts.get(&key).map_or(0, owed);
        }
        st.accounts
            .iter()
            .filter(|(k, _)| k.0 == key.0)
            .map(|(_, a)| owed(a))
            .sum()
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
    /// there leave the global count (unless they had aged out already).
    fn credit(&self, st: &mut State, key: Key, upto: u64, amount: u64) {
        let paid_stays = self.has(SeederFlaw::PaidDebtStaysCounted);
        let a = st.accounts.entry(key).or_default();
        let mut freed = Vec::new();
        while let Some(&n) = a.unpaid.front() {
            if n > upto {
                break;
            }
            a.unpaid.pop_front();
            freed.push(n);
        }
        a.acked = a.acked.max(upto);
        a.spent += amount;
        if !paid_stays {
            for n in &freed {
                st.live.remove(&(key, *n));
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

    /// What a completed swap means for the account, on whatever task runs it.
    fn settle(
        &self,
        key: Key,
        upto: u64,
        amount: u64,
        outcome: Swap,
        session_spent: &AtomicU64,
    ) -> Result<Ack, Rej> {
        let mut st = self.state();
        match outcome {
            Swap::Claimed => Ok(self.ack(&mut st, key, upto, amount, session_spent)),
            Swap::Spent => {
                if !self.has(SeederFlaw::NoBanOnSpent) {
                    self.ban(&mut st, key);
                }
                Err(rej(RejCode::Spent, "a proof is already spent"))
            }
            Swap::Invalid => {
                if !self.has(SeederFlaw::InvalidNoBan) {
                    self.ban(&mut st, key);
                }
                Err(rej(RejCode::BadToken, "the mint refuses these proofs"))
            }
            Swap::Unreachable => {
                if self.has(SeederFlaw::OutageBans) {
                    self.ban(&mut st, key);
                }
                if self.has(SeederFlaw::OutageCredits) {
                    return Ok(self.ack(&mut st, key, upto, amount, session_spent));
                }
                Err(rej(RejCode::MintUnavailable, "the mint cannot be reached"))
            }
        }
    }

    fn ack(
        &self,
        st: &mut State,
        key: Key,
        upto: u64,
        amount: u64,
        session_spent: &AtomicU64,
    ) -> Ack {
        self.credit(st, key, upto, amount);
        let in_session = session_spent.fetch_add(amount, Ordering::Relaxed) + amount;
        Ack {
            accepted_upto: upto,
            spent_total: if self.has(SeederFlaw::SpentTotalPerSession) {
                in_session
            } else {
                self.account_spent(st, key)
            },
        }
    }
}

/// An honest seeder (NFX-07 §3). With a [`SeederFlaw`] it is deliberately not.
#[derive(Clone)]
pub struct MockEngine(Arc<Inner>);

impl MockEngine {
    /// A seeder for `videos` (each with its member files).
    ///
    /// # Panics
    /// On a configuration a seeder must refuse ([`EngineConfig::validate`]).
    #[must_use]
    pub fn new(
        config: EngineConfig,
        videos: Vec<(VideoAddr, HashSet<String>)>,
        net: MockNetwork,
        clock: Clock,
        flaw: Option<SeederFlaw>,
    ) -> Self {
        if let Err(why) = config.validate() {
            panic!("a seeder refuses this configuration: {why}");
        }
        Self(Arc::new(Inner {
            config,
            videos: videos
                .into_iter()
                .map(|(addr, members)| Video { addr, members })
                .collect(),
            clock,
            net,
            flaw,
            state: Mutex::new(State::default()),
        }))
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

    fn hello(&self, peer: &PeerId, hello: &Hello) -> Result<MockSession, Rej> {
        let e = &self.0;
        let mut st = e.state();
        e.age(&mut st);
        let video = match e.videos.iter().position(|v| v.addr == hello.video) {
            Some(v) => v,
            None if e.has(SeederFlaw::HelloAnyVideo) => 0,
            None => return Err(rej(RejCode::UnknownVideo, "not served here")),
        };
        let key = (*peer, video);
        if e.peer_banned(&st, key) {
            return Err(rej(RejCode::Banned, "this peer is banned"));
        }
        if st.open.contains_key(&hello.session) && !e.has(SeederFlaw::SessionIdAnyPeer) {
            return Err(rej(RejCode::BadSession, "that session is open"));
        }
        let count_key = (
            *peer,
            e.has(SeederFlaw::SessionCapPerVideo).then_some(video),
        );
        let cap = MAX_OPEN_SESSIONS_PER_PEER + usize::from(e.has(SeederFlaw::SessionCapOffByOne));
        let held = if e.has(SeederFlaw::SessionCapLifetime) {
            st.ever.get(peer).copied().unwrap_or(0)
        } else {
            st.open_count.get(&count_key).copied().unwrap_or(0)
        };
        if held >= cap {
            return Err(rej(RejCode::BadSession, "too many open sessions"));
        }
        st.open.insert(hello.session.clone(), key);
        *st.open_count.entry(count_key).or_default() += 1;
        *st.ever.entry(*peer).or_default() += 1;
        if e.has(SeederFlaw::FreshWindowPerHello) {
            st.accounts.remove(&key);
        }
        // A hello creates no account: a new one quotes zeros.
        let (mut served, accepted_upto, mut spent_total) = st
            .accounts
            .get(&key)
            .map_or((0, 0, 0), |a| (a.admitted, a.acked, a.spent));
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
        let mut st = self.e.state();
        if st.open.get(&self.session) == Some(&self.key) {
            st.open.remove(&self.session);
        }
        if let Some(n) = st.open_count.get_mut(&self.count_key) {
            *n = n.saturating_sub(1);
        }
    }
}

/// An account's turn to pay. Released when dropped, and moved into a sent swap's
/// completion, so an abandoned `pay` keeps the turn until its swap has been credited.
struct Turn {
    e: Arc<Inner>,
    key: Key,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let wake = {
            let mut st = self.e.state();
            st.paying.remove(&self.key);
            std::mem::take(&mut st.waiting)
        };
        for w in wake {
            w.wake();
        }
    }
}

impl MockSession {
    async fn turn(&self) -> Option<Turn> {
        if self.e.has(SeederFlaw::ConcurrentPays) {
            return None;
        }
        poll_fn(|cx| {
            let mut st = self.e.state();
            if st.paying.contains(&self.key) {
                st.waiting.push(cx.waker().clone());
                Poll::Pending
            } else {
                st.paying.insert(self.key);
                Poll::Ready(())
            }
        })
        .await;
        Some(Turn {
            e: self.e.clone(),
            key: self.key,
        })
    }

    /// What a flawed engine does on refusing a decoded token of `amount`.
    fn on_refusal(&mut self, token: &str, upto: u64, amount: u64, amount_refusal: bool) {
        let e = self.e.clone();
        let mut st = e.state();
        if e.has(SeederFlaw::RefusalCredits) {
            e.credit(&mut st, self.key, upto, 0);
        }
        if amount_refusal && e.has(SeederFlaw::RefusalAdvancesAcked) {
            let a = st.accounts.entry(self.key).or_default();
            a.acked = a.acked.max(upto);
        }
        if e.has(SeederFlaw::SpentTotalCountsRefused) {
            st.accounts.entry(self.key).or_default().spent += amount;
        }
        drop(st);
        if e.has(SeederFlaw::ClaimsOnRefusal) {
            e.net.claim_first(token);
        }
    }

    async fn pay_in_turn(&mut self, pay: &Pay, turn: Option<Turn>) -> Result<Ack, Rej> {
        let e = self.e.clone();
        if e.has(SeederFlaw::ClaimsBeforeChecking) {
            let _ = e.net.swap_now(&pay.token);
        }
        let acked = {
            let mut st = e.state();
            e.age(&mut st);
            let ban_now =
                !e.has(SeederFlaw::PayIgnoresBan) && !e.has(SeederFlaw::BanCheckedBeforeTurn);
            if ban_now && e.peer_banned(&st, self.key) {
                return Err(rej(RejCode::Banned, "this peer is banned"));
            }
            st.accounts.get(&self.key).map_or(0, |a| a.acked)
        };
        if pay.upto_chunk <= acked && !e.has(SeederFlaw::IgnoresStale) {
            return Err(rej(RejCode::Stale, "already paid up to there"));
        }
        // 1. Structure.
        let Some(info) = e.net.read(&pay.token) else {
            return Err(rej(RejCode::BadToken, "unreadable token"));
        };
        let no_dleq = info.dleq == Dleq::Missing && !e.has(SeederFlaw::NoDleqAccepted);
        let too_many = info.proofs.len() > MAX_PROOFS && !e.has(SeederFlaw::TooManyProofsAccepted);
        let shape_bad =
            info.unit != "sat" || info.mints.len() != 1 || info.locked || no_dleq || too_many;
        if shape_bad && !e.has(SeederFlaw::AcceptsBadTokens) {
            return Err(rej(
                RejCode::BadToken,
                "not a single-mint sat token with DLEQs",
            ));
        }
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
        // 3. DLEQ, against the quoted mint's keys.
        e.net.dial(&mint);
        if info.dleq == Dleq::Invalid && !e.has(SeederFlaw::AcceptsBadTokens) {
            return Err(rej(RejCode::BadToken, "an invalid DLEQ"));
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
        let (key, upto, amount) = (self.key, pay.upto_chunk, info.amount);
        if e.has(SeederFlaw::AckBeforeSwap) {
            let e2 = e.clone();
            e.net.swap_later(
                &pay.token,
                Box::new(move |outcome| {
                    if outcome == Swap::Spent {
                        let mut st = e2.state();
                        e2.ban(&mut st, key);
                    }
                }),
            );
            let mut st = e.state();
            return Ok(e.ack(&mut st, key, upto, amount, &self.session_spent));
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
            return e.settle(key, upto, amount, outcome, &self.session_spent);
        }
        if e.has(SeederFlaw::ClaimThenAwaitCredit) {
            let id = e.net.submit(&pay.token, Box::new(|_| {}));
            let outcome = e.net.answer(id).await;
            return e.settle(key, upto, amount, outcome, &self.session_spent);
        }
        // The swap's completion credits (or bans) and then releases the turn, whether or
        // not this future is still waiting for it.
        let result: Arc<Mutex<Option<Result<Ack, Rej>>>> = Arc::new(Mutex::new(None));
        let (e2, spent, slot) = (e.clone(), self.session_spent.clone(), result.clone());
        let id = e.net.submit(
            &pay.token,
            Box::new(move |outcome| {
                let r = e2.settle(key, upto, amount, outcome, &spent);
                *lock(&slot) = Some(r);
                drop(turn);
            }),
        );
        e.net.answer(id).await;
        lock(&result)
            .take()
            .unwrap_or_else(|| Err(rej(RejCode::MintUnavailable, "no outcome")))
    }
}

impl SeederSession for MockSession {
    fn quote(&self) -> &Quote {
        &self.quote
    }

    fn admit(&mut self, sha256: &str) -> bool {
        let e = self.e.clone();
        let mut st = e.state();
        e.age(&mut st);
        if e.peer_banned(&st, self.key) && !e.has(SeederFlaw::AdmitIgnoresBan) {
            return false;
        }
        let member = e.videos[self.key.1].members.contains(sha256);
        if !member && !e.has(SeederFlaw::AdmitsForeignChunks) {
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
                let unpaid = e.peer_unpaid(&st, self.key);
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
        let now = e.clock.now();
        let a = st.accounts.entry(self.key).or_default();
        if e.has(SeederFlaw::CountsDistinctFiles) && !a.files.insert(sha256.to_owned()) {
            return true;
        }
        a.admitted += 1;
        if !covered || e.has(SeederFlaw::CoveredLoggedAsDebt) {
            let n = a.admitted;
            a.unpaid.push_back(n);
            st.debt.push_back((self.key, n, now));
            st.live.insert((self.key, n));
            st.flawed_count = st.flawed_count.wrapping_add(1);
        }
        true
    }

    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej> {
        if self.e.has(SeederFlaw::BanCheckedBeforeTurn) && self.banned() {
            return Err(rej(RejCode::Banned, "this peer is banned"));
        }
        let turn = self.turn().await;
        self.pay_in_turn(pay, turn).await
    }

    fn banned(&self) -> bool {
        self.e.peer_banned(&self.e.state(), self.key)
    }
}

/// A payment sent and not yet settled.
struct Pending {
    upto: u64,
    amount: u64,
    token: String,
    sent_at: u64,
}

/// An honest viewer's ledger with one seeder for one video, holding tokens from one mint
/// (NFX-07 §3a). With a [`ViewerFlaw`] it is deliberately not.
pub struct MockViewer {
    net: MockNetwork,
    clock: Clock,
    flaw: Option<ViewerFlaw>,
    mint: String,
    max_price: u64,
    /// The open session's quote.
    quote: Option<Quote>,
    requested: u64,
    acked: u64,
    spent: u64,
    pending: Option<Pending>,
    /// The pending payment outlived its session: the next quote or a reclaim settles it.
    unsettled: bool,
    /// A refused payment whose reclaim has not completed (the mint was down).
    reclaiming: Option<String>,
    /// A refusal since the last payment: the next one may pay ahead.
    pay_ahead: bool,
    stopped: bool,
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
        Self {
            net,
            clock,
            flaw,
            mint: mint.to_owned(),
            max_price,
            quote: None,
            requested: 0,
            acked: 0,
            spent: 0,
            pending: None,
            unsettled: false,
            reclaiming: None,
            pay_ahead: false,
            stopped: false,
        }
    }

    fn has(&self, f: ViewerFlaw) -> bool {
        self.flaw == Some(f)
    }

    /// Take `token`'s proofs back, as this viewer does.
    fn take_back(&self, token: &str) -> Reclaim {
        if self.has(ViewerFlaw::NoReclaim) {
            return Reclaim::All;
        }
        if self.has(ViewerFlaw::ReclaimsFirstProofOnly) {
            self.net.claim_first(token);
            return Reclaim::All;
        }
        match self.net.reclaim(token) {
            Reclaim::SomeSpent if self.has(ViewerFlaw::IgnoresReclaimOutcome) => Reclaim::All,
            outcome => outcome,
        }
    }

    /// Reclaim `token`: proofs found spent mean the payment is lost, and the viewer stops;
    /// a mint that is down leaves the reclaim to finish later, and nothing is paid until
    /// then.
    fn reclaim(&mut self, token: String) {
        match self.take_back(&token) {
            Reclaim::All => {}
            Reclaim::SomeSpent => self.stopped = true,
            Reclaim::Blocked => self.reclaiming = Some(token),
        }
    }

    /// Finish an incomplete reclaim, and settle a payment that outlived its session and
    /// has gone unanswered for 120 s.
    fn catch_up(&mut self) {
        if let Some(token) = self.reclaiming.take() {
            self.reclaim(token);
        }
        let old = self.pending.as_ref().is_some_and(|p| {
            self.unsettled && self.clock.now() >= p.sent_at + ANSWER_WAIT.as_secs()
        });
        if old && let Some(p) = self.pending.take() {
            self.unsettled = false;
            self.reclaim(p.token);
        }
    }

    fn pay_when(&mut self, threshold: u64, last: bool) -> Result<Option<Pay>, String> {
        let Some(q) = self.quote.clone() else {
            return Ok(None);
        };
        let stop_holds = !(last && self.has(ViewerFlaw::LastPayIgnoresStop));
        if self.stopped && stop_holds {
            return Ok(None);
        }
        self.catch_up();
        if (self.stopped && stop_holds) || self.reclaiming.is_some() || self.pending.is_some() {
            return Ok(None);
        }
        let unpaid = self.requested.saturating_sub(self.acked);
        let ahead = if self.pay_ahead && !last && !self.has(ViewerFlaw::NoPayAhead) {
            q.window.div_ceil(2)
        } else {
            0
        };
        if ahead == 0 && (unpaid == 0 || unpaid < threshold) {
            return Ok(None);
        }
        let extra = u64::from(self.has(ViewerFlaw::PaysAhead));
        let upto = self.requested.max(self.acked) + ahead + extra;
        let price = if self.has(ViewerFlaw::PaysAtCap) {
            self.max_price.max(q.price_per_chunk)
        } else {
            q.price_per_chunk
        };
        let amount = (upto - self.acked)
            .checked_mul(price)
            .ok_or("amount overflows")?;
        let token = self.net.issue(&self.mint, amount);
        self.pending = Some(Pending {
            upto,
            amount,
            token: token.clone(),
            sent_at: self.clock.now(),
        });
        self.pay_ahead = false;
        Ok(Some(Pay {
            upto_chunk: upto,
            token,
        }))
    }
}

impl Viewer for MockViewer {
    fn quote(&mut self, quote: &Quote) -> Result<(), String> {
        if self.quote.is_some() && !self.has(ViewerFlaw::AcceptsSecondQuote) {
            return Err("one quote per session".into());
        }
        let resumed = self.requested > 0 || self.acked > 0;
        let skip_cap = resumed && self.has(ViewerFlaw::SkipsCapOnResume);
        if quote.price_per_chunk > self.max_price && !skip_cap {
            return Err("price above this viewer's cap".into());
        }
        if !quote.mints.contains(&self.mint) {
            return Err("no mint this viewer holds tokens from".into());
        }
        // A quote showing the unsettled payment accepted settles it.
        if self.unsettled
            && let Some(p) = &self.pending
            && quote.accepted_upto == p.upto
            && quote.spent_total == self.spent + p.amount
        {
            self.acked = p.upto;
            self.spent += p.amount;
            self.pending = None;
            self.unsettled = false;
        }
        let mut honest = quote.served <= self.requested
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
            self.stopped = true;
            return Err("the quote disagrees with this viewer's ledger".into());
        }
        self.quote = Some(quote.clone());
        Ok(())
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
        let expected = self.pending.take();
        let ok = match &expected {
            Some(p) if self.has(ViewerFlaw::AckAcceptsInflated) => {
                ack.accepted_upto >= p.upto && ack.spent_total >= self.spent + p.amount
            }
            Some(p) => {
                ack.accepted_upto == p.upto
                    && (ack.spent_total == self.spent + p.amount
                        || self.has(ViewerFlaw::IgnoresSpentTotal))
            }
            None => self.has(ViewerFlaw::AcceptsUnsolicitedAck),
        };
        if ok || self.has(ViewerFlaw::IgnoresBadAck) {
            self.acked = ack.accepted_upto;
            if let Some(p) = expected {
                self.spent += p.amount;
            }
            return Ok(());
        }
        self.stopped = true;
        Err("an ack that does not match what was paid".into())
    }

    async fn rej(&mut self, rej: &Rej) {
        if self.has(ViewerFlaw::NoReclaimUnlessSpent) && rej.code != RejCode::Spent {
            self.pending = None;
            self.stopped = true;
            return;
        }
        if let Some(p) = self.pending.take() {
            self.unsettled = false;
            self.reclaim(p.token);
        }
        if rej.code != RejCode::MintUnavailable || self.has(ViewerFlaw::StopsOnOutage) {
            self.stopped = true;
        }
    }

    async fn timeout(&mut self) {
        let Some(p) = &self.pending else {
            return;
        };
        let waited = self.clock.now() >= p.sent_at + ANSWER_WAIT.as_secs();
        if !waited && !self.has(ViewerFlaw::TimeoutEarly) {
            return;
        }
        if let Some(p) = self.pending.take() {
            self.unsettled = false;
            self.reclaim(p.token);
        }
        if !self.has(ViewerFlaw::KeepsPayingAfterTimeout) {
            self.stopped = true;
        }
    }

    fn end(&mut self) {
        self.quote = None;
        if self.pending.is_some() {
            if self.has(ViewerFlaw::EndReclaimsNow) {
                if let Some(p) = self.pending.take() {
                    self.reclaim(p.token);
                }
                self.stopped = true;
            } else if self.has(ViewerFlaw::EndForgetsPending) {
                self.pending = None;
            } else {
                self.unsettled = true;
            }
        }
        if self.has(ViewerFlaw::ForgetsLedger) {
            (self.requested, self.acked, self.spent) = (0, 0, 0);
        }
    }

    fn stopped(&self) -> bool {
        self.stopped
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
}

impl Harness for MockHarness {
    type Engine = MockEngine;
    type Viewer = MockViewer;

    fn engine(&self, price: u64, window: u64, global_cap: u64) -> MockEngine {
        MockEngine::new(
            EngineConfig {
                price_per_chunk: price,
                mints: vec![self.mint.clone()],
                window,
                global_cap,
                debt_ttl: DEBT_TTL,
            },
            (0..2u8)
                .map(|v| {
                    let members = (0..1024).map(|n| self.chunk_of(v, n)).collect();
                    (self.videos[usize::from(v)].clone(), members)
                })
                .collect(),
            self.net.clone(),
            self.clock.clone(),
            self.seeder_flaw,
        )
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

    async fn release_swaps(&self) {
        self.net.release();
    }

    fn mint_outage(&self, down: bool) {
        self.net.ledger().down = down;
    }

    fn advance(&self, by: Duration) {
        self.clock.advance(by);
    }

    fn debt_ttl(&self) -> Duration {
        DEBT_TTL
    }
}
