//! A mock mint network and honest mock engines: an executable reading of NFX-07 §3 and §3a.
//!
//! Tokens look like `cashuBmock<hex>`, which no real Cashu wallet accepts. They hold
//! power-of-two proofs, as a real mint issues them. The network tracks **proofs**, not
//! token strings, so a re-encoded or combined token is still a double spend.
//! - A swap is atomic: it claims every proof of a token, or none.
//! - Swaps can be held, which makes a `pay` wait, and the mint can be taken down.
//! - The seeder's clock is the harness's, so debt can age.
//!
//! No money and no cryptography are involved.
//!
//! Every defect the audits found in plausible engines can be planted with [`SeederFlaw`]
//! or [`ViewerFlaw`]; `tests/mutants.rs` shows the adversary suite catches each one.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::poll_fn;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Poll, Waker};

use nfx_proto::namespace::VideoAddr;
use nfx_proto::pay::{Ack, Hello, MAX_INT, Pay, Quote, Rej, RejCode};

use crate::session::{BadToken, Harness, PeerId, SeederEngine, SeederSession, Viewer};

/// Sessions one peer may hold open at once.
pub const MAX_OPEN_SESSIONS_PER_PEER: usize = 8;
/// How long an unpaid chunk counts toward the global cap (NFX-07 §3: 1 h recommended).
pub const DEBT_TTL_SECS: u64 = 3600;

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

type Deferred = Box<dyn FnOnce(Swap) + Send>;

#[derive(Default)]
struct Ledger {
    tokens: HashMap<String, TokenInfo>,
    claimed: HashSet<u64>,
    forged: HashSet<u64>,
    next: u64,
    hold: bool,
    down: bool,
    dialled: HashSet<String>,
    /// Engine swaps waiting for the hold to end.
    waiting: Vec<Waker>,
    /// Swaps an acknowledge-first engine left for later ([`SeederFlaw::AckBeforeSwap`]).
    deferred: Vec<(String, Deferred)>,
}

/// Every mock mint's ledger, shared.
#[derive(Clone, Default)]
pub struct MockNetwork(Arc<Mutex<Ledger>>);

impl MockNetwork {
    fn ledger(&self) -> MutexGuard<'_, Ledger> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn mint_token(&self, info: TokenInfo) -> String {
        let mut l = self.ledger();
        l.next += 1;
        let token = format!("cashuBmock{:016x}", l.next);
        l.tokens.insert(token.clone(), info);
        token
    }

    /// Fresh proofs for `amount`: one per set bit, as a real mint splits.
    fn proofs_for(&self, amount: u64) -> Vec<u64> {
        let mut l = self.ledger();
        let n = amount.count_ones().max(1);
        (0..n)
            .map(|_| {
                l.next += 1;
                l.next
            })
            .collect()
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

    /// Swap as an engine does: it waits while swaps are held.
    async fn swap(&self, token: &str) -> Swap {
        poll_fn(|cx| {
            let mut l = self.ledger();
            if l.hold {
                l.waiting.push(cx.waker().clone());
                Poll::Pending
            } else {
                Poll::Ready(())
            }
        })
        .await;
        self.swap_now(token)
    }

    /// Run `then` with the swap's outcome now, or at release while swaps are held.
    fn swap_later(&self, token: &str, then: Deferred) {
        let mut l = self.ledger();
        if l.hold {
            l.deferred.push((token.to_owned(), then));
            return;
        }
        drop(l);
        then(self.swap_now(token));
    }

    /// Claim whatever of `token`'s proofs are unclaimed, as a wallet reclaiming its own
    /// (NUT-07 state check, then a swap of the unspent ones). Returns (claimed any,
    /// claimed all). Reclaims model "eventually", so they ignore holds and outages.
    fn claim_unclaimed(&self, token: &str) -> (bool, bool) {
        let mut l = self.ledger();
        let Some(info) = l.tokens.get(token).cloned() else {
            return (false, false);
        };
        let fresh: Vec<u64> = info
            .proofs
            .iter()
            .copied()
            .filter(|p| !l.claimed.contains(p) && !l.forged.contains(p))
            .collect();
        let all = fresh.len() == info.proofs.len();
        let any = !fresh.is_empty();
        l.claimed.extend(fresh);
        (any, all)
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
        let spent = info.proofs.last().is_some_and(|p| l.claimed.contains(p));
        if spent {
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
        let (wake, deferred) = {
            let mut l = self.ledger();
            l.hold = false;
            (
                std::mem::take(&mut l.waiting),
                std::mem::take(&mut l.deferred),
            )
        };
        for w in wake {
            w.wake();
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
    AdmitIgnoresBan,
    BanPerVideo,
    FreshWindowPerHello,
    QuoteForgetsAccount,
    SessionIdAnyPeer,
    SessionCapOffByOne,
    /// Counts every session ever opened, not the open ones.
    SessionCapLifetime,
    HelloAnyVideo,
    CountsDistinctFiles,
    AdmitsForeignChunks,
    /// Counts the window per account, not per peer across its videos.
    PerVideoWindow,
    NoGlobalCap,
    GlobalCapGt,
    /// Nets every account's credit against every other's debt.
    GlobalCapNetsCredit,
    BanForgetsDebt,
    /// Tests the global cap before the chunk's own pre-payment.
    CapBeforeCredit,
    /// Keeps paid chunks in the global count.
    PaidDebtStaysCounted,
    DebtNeverAges,
    /// Lets ageing free the peer's own window too.
    PeerDebtAges,
    /// Acknowledges first and swaps later (the design the second audit retired).
    AckBeforeSwap,
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
    AcceptsSecondQuote,
    AcceptsUnsolicitedAck,
    IgnoresSpentTotal,
    AckAcceptsInflated,
    NoReclaim,
    ReclaimsFirstProofOnly,
    NoReclaimUnlessSpent,
    LastPayIgnoresStop,
    PaysForRefused,
    TrustsQuote,
    KeepsPayingAfterTimeout,
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
    /// Chunks up to here have aged out of the global count.
    aged_through: u64,
    files: HashSet<String>,
    paying: bool,
    banned: bool,
}

#[derive(Default)]
struct State {
    accounts: HashMap<Key, Account>,
    banned: HashSet<PeerId>,
    /// Open session ids and their peer.
    open: HashMap<String, PeerId>,
    open_per_peer: HashMap<PeerId, usize>,
    ever_per_peer: HashMap<PeerId, usize>,
    /// Unpaid admissions (account, chunk, time), oldest first.
    debt: VecDeque<(Key, u64, u64)>,
    /// Unpaid admissions not yet aged out: the global cap's count.
    debt_count: u64,
    /// Payments waiting for their account's turn.
    waiting: Vec<Waker>,
}

/// A seeder's configuration.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub price_per_chunk: u64,
    pub mints: Vec<String>,
    pub window: u64,
    pub global_cap: u64,
    pub debt_ttl: u64,
}

struct Video {
    addr: VideoAddr,
    members: HashSet<String>,
}

struct Inner {
    config: EngineConfig,
    videos: Vec<Video>,
    clock: Arc<AtomicU64>,
    net: MockNetwork,
    flaw: Option<SeederFlaw>,
    state: Mutex<State>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn has(&self, f: SeederFlaw) -> bool {
        self.flaw == Some(f)
    }

    fn now(&self) -> u64 {
        self.clock.load(Ordering::Relaxed)
    }

    /// Age out unpaid admissions older than `debt_ttl` from the global count.
    fn age(&self, st: &mut State) {
        if self.has(SeederFlaw::DebtNeverAges) {
            return;
        }
        let now = self.now();
        while let Some(&(key, n, t)) = st.debt.front() {
            if t.saturating_add(self.config.debt_ttl) > now {
                break;
            }
            st.debt.pop_front();
            if let Some(a) = st.accounts.get_mut(&key) {
                if a.acked < n {
                    st.debt_count -= 1;
                }
                a.aged_through = a.aged_through.max(n);
            }
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
            let gone: Vec<Key> = st
                .accounts
                .keys()
                .copied()
                .filter(|k| k.0 == peer)
                .collect();
            for k in gone {
                if let Some(a) = st.accounts.remove(&k) {
                    let live = a.unpaid.iter().filter(|n| **n > a.aged_through).count();
                    st.debt_count -= live as u64;
                }
            }
            st.debt.retain(|(k, _, _)| k.0 != peer);
        }
    }

    /// The peer's unpaid chunks across its videos (its window's count).
    fn peer_unpaid(&self, st: &State, key: Key) -> u64 {
        let owed = |a: &Account| {
            let paid = if self.has(SeederFlaw::PeerDebtAges) {
                a.acked.max(a.aged_through)
            } else {
                a.acked
            };
            a.admitted.saturating_sub(paid)
        };
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
        st.debt_count
    }

    /// Credit `key` with a payment up to `upto` worth `amount`: its unpaid chunks up to
    /// there leave the global count unless they had aged out already.
    fn credit(&self, st: &mut State, key: Key, upto: u64, amount: u64) {
        let a = st.accounts.entry(key).or_default();
        let mut freed = 0;
        while let Some(&n) = a.unpaid.front() {
            if n > upto {
                break;
            }
            a.unpaid.pop_front();
            if n > a.aged_through {
                freed += 1;
            }
        }
        a.acked = a.acked.max(upto);
        a.spent += amount;
        if !self.has(SeederFlaw::PaidDebtStaysCounted) {
            st.debt_count -= freed;
        }
    }
}

/// An honest seeder (NFX-07 §3). With a [`SeederFlaw`] it is deliberately not.
#[derive(Clone)]
pub struct MockEngine(Arc<Inner>);

impl MockEngine {
    /// A seeder for `videos` (each with its member files).
    #[must_use]
    pub fn new(
        config: EngineConfig,
        videos: Vec<(VideoAddr, HashSet<String>)>,
        net: MockNetwork,
        clock: Arc<AtomicU64>,
        flaw: Option<SeederFlaw>,
    ) -> Self {
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
        let cap = MAX_OPEN_SESSIONS_PER_PEER + usize::from(e.has(SeederFlaw::SessionCapOffByOne));
        let held = if e.has(SeederFlaw::SessionCapLifetime) {
            st.ever_per_peer.get(peer).copied().unwrap_or(0)
        } else {
            st.open_per_peer.get(peer).copied().unwrap_or(0)
        };
        if held >= cap {
            return Err(rej(RejCode::BadSession, "too many open sessions"));
        }
        st.open.insert(hello.session.clone(), *peer);
        *st.open_per_peer.entry(*peer).or_default() += 1;
        *st.ever_per_peer.entry(*peer).or_default() += 1;
        if e.has(SeederFlaw::FreshWindowPerHello) {
            st.accounts.insert(key, Account::default());
        }
        let a = st.accounts.entry(key).or_default();
        let forget = e.has(SeederFlaw::QuoteForgetsAccount);
        let quote = Quote {
            price_per_chunk: e.config.price_per_chunk,
            mints: e.config.mints.clone(),
            window: e.config.window,
            served: if forget { 0 } else { a.admitted },
            accepted_upto: if forget { 0 } else { a.acked },
            spent_total: if forget { 0 } else { a.spent },
        };
        Ok(MockSession {
            e: self.0.clone(),
            key,
            session: hello.session.clone(),
            quote,
            session_spent: 0,
        })
    }
}

/// One open session of a [`MockEngine`]. Dropping it closes it.
pub struct MockSession {
    e: Arc<Inner>,
    key: Key,
    session: String,
    quote: Quote,
    session_spent: u64,
}

impl Drop for MockSession {
    fn drop(&mut self) {
        let mut st = self.e.state();
        if st.open.get(&self.session) == Some(&self.key.0) {
            st.open.remove(&self.session);
        }
        if let Some(n) = st.open_per_peer.get_mut(&self.key.0) {
            *n = n.saturating_sub(1);
        }
    }
}

/// An account's turn to pay: released when dropped, even if the `pay` is abandoned.
struct Turn {
    e: Arc<Inner>,
    key: Key,
}

impl Drop for Turn {
    fn drop(&mut self) {
        let wake = {
            let mut st = self.e.state();
            if let Some(a) = st.accounts.get_mut(&self.key) {
                a.paying = false;
            }
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
            let a = st.accounts.entry(self.key).or_default();
            if a.paying {
                st.waiting.push(cx.waker().clone());
                Poll::Pending
            } else {
                a.paying = true;
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

    fn ack(&mut self, upto: u64, amount: u64) -> Ack {
        let e = self.e.clone();
        let mut st = e.state();
        e.credit(&mut st, self.key, upto, amount);
        self.session_spent += amount;
        let spent = st.accounts.get(&self.key).map_or(0, |a| a.spent);
        Ack {
            accepted_upto: upto,
            spent_total: if e.has(SeederFlaw::SpentTotalPerSession) {
                self.session_spent
            } else {
                spent
            },
        }
    }

    async fn pay_in_turn(&mut self, pay: &Pay) -> Result<Ack, Rej> {
        let e = self.e.clone();
        if e.has(SeederFlaw::ClaimsBeforeChecking) {
            let _ = e.net.swap_now(&pay.token);
        }
        let acked = {
            let mut st = e.state();
            e.age(&mut st);
            if e.peer_banned(&st, self.key) && !e.has(SeederFlaw::PayIgnoresBan) {
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
        let shape_bad = info.unit != "sat" || info.mints.len() != 1 || info.locked || no_dleq;
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
        let short = due.is_none_or(|d| info.amount < d);
        if short {
            self.on_refusal(&pay.token, pay.upto_chunk, info.amount, true);
            return Err(rej(RejCode::Underpaid, "short of the chunks claimed"));
        }
        if due.is_some_and(|d| info.amount > d) && !e.has(SeederFlaw::AcceptsOverpay) {
            self.on_refusal(&pay.token, pay.upto_chunk, info.amount, true);
            return Err(rej(RejCode::Overpaid, "more than the chunks claimed"));
        }
        // 5. Swap, then acknowledge.
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
            return Ok(self.ack(pay.upto_chunk, info.amount));
        }
        let outcome = if e.has(SeederFlaw::SpentCheckLastProof) {
            e.net.swap_checking_last_only(&pay.token)
        } else if e.has(SeederFlaw::SwapsUnspentSubset) {
            if e.net.claim_unclaimed(&pay.token).0 {
                Swap::Claimed
            } else {
                Swap::Spent
            }
        } else {
            e.net.swap(&pay.token).await
        };
        match outcome {
            Swap::Claimed => Ok(self.ack(pay.upto_chunk, info.amount)),
            Swap::Spent => {
                if !e.has(SeederFlaw::NoBanOnSpent) {
                    let mut st = e.state();
                    e.ban(&mut st, self.key);
                }
                Err(rej(RejCode::Spent, "a proof is already spent"))
            }
            Swap::Invalid => {
                if !e.has(SeederFlaw::InvalidNoBan) {
                    let mut st = e.state();
                    e.ban(&mut st, self.key);
                }
                Err(rej(RejCode::BadToken, "the mint refuses these proofs"))
            }
            Swap::Unreachable => {
                if e.has(SeederFlaw::OutageBans) {
                    let mut st = e.state();
                    e.ban(&mut st, self.key);
                }
                if e.has(SeederFlaw::OutageCredits) {
                    return Ok(self.ack(pay.upto_chunk, info.amount));
                }
                Err(rej(RejCode::MintUnavailable, "the mint cannot be reached"))
            }
        }
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
        let a = st.accounts.entry(self.key).or_default();
        let covered = a.admitted < a.acked;
        let cap_first = e.has(SeederFlaw::CapBeforeCredit);
        if !covered || cap_first {
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
        let now = e.now();
        let a = st.accounts.entry(self.key).or_default();
        if e.has(SeederFlaw::CountsDistinctFiles) && !a.files.insert(sha256.to_owned()) {
            return true;
        }
        a.admitted += 1;
        if !covered {
            let n = a.admitted;
            a.unpaid.push_back(n);
            st.debt.push_back((self.key, n, now));
            st.debt_count += 1;
        }
        true
    }

    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej> {
        let turn = self.turn().await;
        let result = self.pay_in_turn(pay).await;
        drop(turn);
        result
    }

    fn banned(&self) -> bool {
        self.e.peer_banned(&self.e.state(), self.key)
    }
}

/// An honest viewer's ledger with one seeder for one video, holding tokens from one mint
/// (NFX-07 §3a). With a [`ViewerFlaw`] it is deliberately not.
pub struct MockViewer {
    net: MockNetwork,
    flaw: Option<ViewerFlaw>,
    mint: String,
    max_price: u64,
    /// The open session's quote.
    quote: Option<Quote>,
    requested: u64,
    acked: u64,
    spent: u64,
    /// The payment sent and not yet answered: (upto, amount, token).
    pending: Option<(u64, u64, String)>,
    stopped: bool,
}

impl MockViewer {
    #[must_use]
    pub fn new(net: MockNetwork, mint: &str, max_price: u64, flaw: Option<ViewerFlaw>) -> Self {
        Self {
            net,
            flaw,
            mint: mint.to_owned(),
            max_price,
            quote: None,
            requested: 0,
            acked: 0,
            spent: 0,
            pending: None,
            stopped: false,
        }
    }

    fn has(&self, f: ViewerFlaw) -> bool {
        self.flaw == Some(f)
    }

    fn pay_when(&mut self, threshold: u64, last: bool) -> Result<Option<Pay>, String> {
        let Some(q) = &self.quote else {
            return Ok(None);
        };
        let stopped = self.stopped && !(last && self.has(ViewerFlaw::LastPayIgnoresStop));
        if stopped || self.pending.is_some() {
            return Ok(None);
        }
        let unpaid = self.requested.saturating_sub(self.acked);
        if unpaid == 0 || unpaid < threshold {
            return Ok(None);
        }
        let ahead = u64::from(self.has(ViewerFlaw::PaysAhead));
        let upto = self.requested + ahead;
        let amount = (unpaid + ahead)
            .checked_mul(q.price_per_chunk)
            .ok_or("amount overflows")?;
        let token = self.net.issue(&self.mint, amount);
        self.pending = Some((upto, amount, token.clone()));
        Ok(Some(Pay {
            upto_chunk: upto,
            token,
        }))
    }

    /// Take the pending payment's proofs back. `false` if some were already claimed.
    fn reclaim(&mut self) -> bool {
        let Some((_, _, token)) = self.pending.take() else {
            return true;
        };
        if self.has(ViewerFlaw::NoReclaim) {
            return true;
        }
        if self.has(ViewerFlaw::ReclaimsFirstProofOnly) {
            self.net.claim_first(&token);
            return true;
        }
        self.net.claim_unclaimed(&token).1
    }
}

impl Viewer for MockViewer {
    fn quote(&mut self, quote: &Quote) -> Result<(), String> {
        if self.quote.is_some() && !self.has(ViewerFlaw::AcceptsSecondQuote) {
            return Err("one quote per session".into());
        }
        if quote.price_per_chunk > self.max_price {
            return Err("price above this viewer's cap".into());
        }
        if !quote.mints.contains(&self.mint) {
            return Err("no mint this viewer holds tokens from".into());
        }
        let honest = quote.served <= self.requested
            && quote.accepted_upto == self.acked
            && quote.spent_total == self.spent;
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
        if self.requested > self.acked && !self.has(ViewerFlaw::PaysForRefused) {
            self.requested -= 1;
        }
    }

    async fn due(&mut self) -> Result<Option<Pay>, String> {
        // Pay at half the window, so the seeder never has to stall.
        let window = self.quote.as_ref().map_or(1, |q| q.window);
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
            Some((upto, amount, _)) if self.has(ViewerFlaw::AckAcceptsInflated) => {
                ack.accepted_upto >= *upto && ack.spent_total >= self.spent + amount
            }
            Some((upto, amount, _)) => {
                ack.accepted_upto == *upto
                    && (ack.spent_total == self.spent + amount
                        || self.has(ViewerFlaw::IgnoresSpentTotal))
            }
            None => self.has(ViewerFlaw::AcceptsUnsolicitedAck),
        };
        if ok || self.has(ViewerFlaw::IgnoresBadAck) {
            self.acked = ack.accepted_upto;
            if let Some((_, amount, _)) = expected {
                self.spent += amount;
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
        self.reclaim();
        if rej.code != RejCode::MintUnavailable || self.has(ViewerFlaw::StopsOnOutage) {
            self.stopped = true;
        }
    }

    async fn timeout(&mut self) {
        // Reclaimed or found spent (the seeder was paid and its answer lost): either way,
        // stop, and never pay for those chunks again.
        self.reclaim();
        if !self.has(ViewerFlaw::KeepsPayingAfterTimeout) {
            self.stopped = true;
        }
    }

    fn end(&mut self) {
        if self.pending.is_some() {
            self.reclaim();
            self.stopped = true;
        }
        self.quote = None;
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
    clock: Arc<AtomicU64>,
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
            clock: Arc::new(AtomicU64::new(0)),
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
                debt_ttl: DEBT_TTL_SECS,
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
        MockViewer::new(self.net.clone(), &self.mint, max_price, self.viewer_flaw)
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
        self.net.claim_unclaimed(token).0
    }

    fn dialled(&self, url: &str) -> bool {
        self.net.ledger().dialled.contains(url)
    }

    fn hold_swaps(&self) {
        self.net.ledger().hold = true;
    }

    async fn release_swaps(&self) {
        self.net.release();
    }

    fn mint_outage(&self, down: bool) {
        self.net.ledger().down = down;
    }

    fn advance(&self, secs: u64) {
        self.clock.fetch_add(secs, Ordering::Relaxed);
    }

    fn debt_ttl(&self) -> u64 {
        DEBT_TTL_SECS
    }
}
