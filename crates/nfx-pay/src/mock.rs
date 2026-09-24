//! A mock mint network and honest mock engines: an executable reading of NFX-07 §3 and §3a.
//!
//! Tokens look like `cashuBmock<hex>`, which no real Cashu wallet accepts. The network
//! tracks **proofs**, not token strings, so a re-encoded token is still a double spend.
//! Swaps can be held (acknowledged but not confirmed) and the mint can be taken down, so
//! asynchronous engines can be exercised. No money and no cryptography are involved.
//!
//! Every defect the audits found in plausible engines can be planted with [`SeederFlaw`]
//! or [`ViewerFlaw`]; `tests/mutants.rs` shows the adversary suite catches each one.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use nfx_proto::namespace::VideoAddr;
use nfx_proto::pay::{Ack, Hello, MAX_INT, Pay, Quote, Rej, RejCode};

use crate::session::{BadToken, Harness, PeerId, SeederEngine, SeederSession, Viewer};

/// Sessions one peer may hold at once.
pub const MAX_SESSIONS_PER_PEER: usize = 8;

#[derive(Debug, Clone)]
struct TokenInfo {
    proofs: Vec<u64>,
    mints: Vec<String>,
    amount: u64,
    unit: &'static str,
    locked: bool,
    dleq_ok: bool,
}

/// How a swap ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Swap {
    Claimed,
    Spent,
    Unreachable,
}

type Done = Box<dyn FnOnce(Swap) + Send>;

#[derive(Default)]
struct Ledger {
    tokens: HashMap<String, TokenInfo>,
    claimed: HashSet<u64>,
    next: u64,
    hold: bool,
    down: bool,
    pending: Vec<(String, Done)>,
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

    fn fresh_proof(&self) -> u64 {
        let mut l = self.ledger();
        l.next += 1;
        l.next
    }

    /// A fresh token (one new proof) worth `amount` sat from `mint`.
    #[must_use]
    pub fn issue(&self, mint: &str, amount: u64) -> String {
        let proof = self.fresh_proof();
        self.mint_token(TokenInfo {
            proofs: vec![proof],
            mints: vec![mint.to_owned()],
            amount,
            unit: "sat",
            locked: false,
            dleq_ok: true,
        })
    }

    fn read(&self, token: &str) -> Option<TokenInfo> {
        self.ledger().tokens.get(token).cloned()
    }

    /// Swap `token` now: `Claimed` claims every proof; `Spent` if any proof was already
    /// claimed (claiming none); `Unreachable` while the mint is down.
    pub fn swap_now(&self, token: &str) -> Swap {
        let mut l = self.ledger();
        if l.down {
            return Swap::Unreachable;
        }
        let Some(info) = l.tokens.get(token).cloned() else {
            return Swap::Spent;
        };
        if info.proofs.iter().any(|p| l.claimed.contains(p)) {
            return Swap::Spent;
        }
        l.claimed.extend(info.proofs);
        Swap::Claimed
    }

    /// Swap as an engine does. Held swaps are queued (`None`; `done` runs on release). A
    /// mint that is down answers `Unreachable` at once, as a real client would see it,
    /// and the swap is queued to be retried on release.
    fn swap(&self, token: &str, done: Done) -> Option<Swap> {
        let mut l = self.ledger();
        if l.hold {
            l.pending.push((token.to_owned(), done));
            return None;
        }
        if l.down {
            l.pending.push((token.to_owned(), done));
            return Some(Swap::Unreachable);
        }
        drop(l);
        Some(self.swap_now(token))
    }

    /// Whether every proof of `token` is claimed.
    #[must_use]
    pub fn claimed(&self, token: &str) -> bool {
        let l = self.ledger();
        l.tokens
            .get(token)
            .is_some_and(|i| i.proofs.iter().all(|p| l.claimed.contains(p)))
    }

    fn release(&self) {
        let pending = {
            let mut l = self.ledger();
            l.hold = false;
            std::mem::take(&mut l.pending)
        };
        let mut retry = Vec::new();
        for (token, done) in pending {
            match self.swap_now(&token) {
                Swap::Unreachable => retry.push((token, done)),
                outcome => done(outcome),
            }
        }
        self.ledger().pending.extend(retry);
    }
}

/// A defect planted in a mock engine, to prove the adversary suite catches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeederFlaw {
    AcceptsOverpay,
    AcceptsForeignMint,
    PrefixMint,
    AcceptsBadTokens,
    NoBanOnSpent,
    WindowOffByOne,
    ClaimsBeforeChecking,
    IgnoresStale,
    GatesOnAcked,
    RefusalCredits,
    WrappingMul,
    PayIgnoresBan,
    BanPerSession,
    FreshWindowPerHello,
    SessionIdAnyPeer,
    CountsDistinctFiles,
    AdmitsForeignChunks,
    NoGlobalCap,
    OutageBans,
}

/// A defect planted in a mock viewer, to prove the adversary suite catches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewerFlaw {
    PaysAhead,
    IgnoresBadAck,
    PaysAtTheWindow,
    AcceptsSecondQuote,
    AcceptsUnsolicitedAck,
    IgnoresSpentTotal,
    NoReclaim,
}

#[derive(Default)]
struct Account {
    admitted: u64,
    acked: u64,
    confirmed: u64,
    files: HashSet<String>,
}

#[derive(Default)]
struct State {
    accounts: HashMap<PeerId, Account>,
    banned: HashSet<PeerId>,
    owners: HashMap<String, PeerId>,
    sessions: HashMap<PeerId, HashSet<String>>,
}

struct Inner {
    quote: Quote,
    video: VideoAddr,
    members: HashSet<String>,
    global_cap: u64,
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
}

/// An honest engine for one video (NFX-07 §3). With a [`SeederFlaw`] it is deliberately
/// not.
#[derive(Clone)]
pub struct MockEngine(Arc<Inner>);

impl MockEngine {
    #[must_use]
    pub fn new(
        quote: Quote,
        video: VideoAddr,
        members: HashSet<String>,
        global_cap: u64,
        net: MockNetwork,
        flaw: Option<SeederFlaw>,
    ) -> Self {
        Self(Arc::new(Inner {
            quote,
            video,
            members,
            global_cap,
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
        if st.banned.contains(peer) && !e.has(SeederFlaw::BanPerSession) {
            return Err(rej(RejCode::Banned, "this peer is banned"));
        }
        if hello.video != e.video {
            return Err(rej(RejCode::UnknownVideo, "not served here"));
        }
        match st.owners.get(&hello.session) {
            Some(owner) if owner != peer && !e.has(SeederFlaw::SessionIdAnyPeer) => {
                return Err(rej(RejCode::BadSession, "the session id is another peer's"));
            }
            _ => {}
        }
        let held = st.sessions.entry(*peer).or_default();
        if !held.contains(&hello.session) && held.len() >= MAX_SESSIONS_PER_PEER {
            return Err(rej(RejCode::BadSession, "too many sessions"));
        }
        held.insert(hello.session.clone());
        st.owners.insert(hello.session.clone(), *peer);
        if e.has(SeederFlaw::FreshWindowPerHello) {
            st.accounts.insert(*peer, Account::default());
        }
        st.accounts.entry(*peer).or_default();
        Ok(MockSession {
            e: self.0.clone(),
            peer: *peer,
            spent_total: 0,
            locally_banned: false,
        })
    }
}

/// One session of a [`MockEngine`].
pub struct MockSession {
    e: Arc<Inner>,
    peer: PeerId,
    spent_total: u64,
    locally_banned: bool,
}

impl MockSession {
    fn is_banned(&self, st: &State) -> bool {
        if self.e.has(SeederFlaw::BanPerSession) {
            self.locally_banned
        } else {
            st.banned.contains(&self.peer)
        }
    }

    fn ban(&mut self, st: &mut State) {
        if self.e.has(SeederFlaw::NoBanOnSpent) {
            return;
        }
        if self.e.has(SeederFlaw::BanPerSession) {
            self.locally_banned = true;
        } else {
            st.banned.insert(self.peer);
        }
    }

    /// The swap outcome's effect on this peer's account.
    fn settle(e: &Arc<Inner>, peer: PeerId, upto: u64, outcome: Swap) {
        let mut st = e.state();
        match outcome {
            Swap::Claimed => {
                let a = st.accounts.entry(peer).or_default();
                a.confirmed = a.confirmed.max(upto);
            }
            Swap::Spent if !e.has(SeederFlaw::NoBanOnSpent) => {
                st.banned.insert(peer);
            }
            Swap::Unreachable if e.has(SeederFlaw::OutageBans) => {
                st.banned.insert(peer);
            }
            _ => {}
        }
    }
}

impl SeederSession for MockSession {
    fn quote(&self) -> &Quote {
        &self.e.quote
    }

    fn admit(&mut self, sha256: &str) -> bool {
        let e = self.e.clone();
        let mut st = e.state();
        if self.is_banned(&st) {
            return false;
        }
        if !e.members.contains(sha256) && !e.has(SeederFlaw::AdmitsForeignChunks) {
            return false;
        }
        let unpaid: u64 = st
            .accounts
            .values()
            .map(|a| a.admitted.saturating_sub(a.confirmed))
            .sum();
        if unpaid >= e.global_cap && !e.has(SeederFlaw::NoGlobalCap) {
            return false;
        }
        let a = st.accounts.entry(self.peer).or_default();
        let paid = if e.has(SeederFlaw::GatesOnAcked) {
            a.acked
        } else {
            a.confirmed
        };
        let extra = u64::from(e.has(SeederFlaw::WindowOffByOne));
        if a.admitted >= paid.saturating_add(e.quote.window) + extra {
            return false;
        }
        if e.has(SeederFlaw::CountsDistinctFiles) && !a.files.insert(sha256.to_owned()) {
            return true;
        }
        a.admitted += 1;
        true
    }

    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej> {
        let e = self.e.clone();
        if e.has(SeederFlaw::ClaimsBeforeChecking) {
            let _ = e.net.swap_now(&pay.token);
        }
        {
            let st = e.state();
            if self.is_banned(&st) && !e.has(SeederFlaw::PayIgnoresBan) {
                return Err(rej(RejCode::Banned, "this peer is banned"));
            }
            let acked = st.accounts.get(&self.peer).map_or(0, |a| a.acked);
            if pay.upto_chunk <= acked && !e.has(SeederFlaw::IgnoresStale) {
                return Err(rej(RejCode::Stale, "already paid up to there"));
            }
        }
        // 1. Decode.
        let Some(info) = e.net.read(&pay.token) else {
            return Err(rej(RejCode::BadToken, "unreadable token"));
        };
        let shape_bad = info.unit != "sat" || info.mints.len() != 1 || info.locked || !info.dleq_ok;
        if shape_bad && !e.has(SeederFlaw::AcceptsBadTokens) {
            return Err(rej(RejCode::BadToken, "not a single-mint sat token"));
        }
        let credit_anyway = |this: &mut Self| {
            if e.has(SeederFlaw::RefusalCredits) {
                let mut st = e.state();
                let a = st.accounts.entry(this.peer).or_default();
                a.acked = pay.upto_chunk;
                a.confirmed = pay.upto_chunk;
            }
        };
        // 2. The mint: exactly a quoted URL.
        let mint = &info.mints[0];
        let quoted = if e.has(SeederFlaw::PrefixMint) {
            e.quote.mints.iter().any(|q| mint.starts_with(q.as_str()))
        } else {
            e.quote.mints.contains(mint)
        };
        if !quoted && !e.has(SeederFlaw::AcceptsForeignMint) {
            credit_anyway(self);
            return Err(rej(RejCode::BadMint, "not a quoted mint"));
        }
        // 3. The exact face value; a product beyond 2^53-1 can never be paid.
        let acked = e.state().accounts.get(&self.peer).map_or(0, |a| a.acked);
        let chunks = pay.upto_chunk.saturating_sub(acked);
        let due = if e.has(SeederFlaw::WrappingMul) {
            Some(chunks.wrapping_mul(e.quote.price_per_chunk))
        } else {
            chunks
                .checked_mul(e.quote.price_per_chunk)
                .filter(|d| *d <= MAX_INT)
        };
        let Some(due) = due else {
            return Err(rej(RejCode::Underpaid, "the claim is beyond any payment"));
        };
        if info.amount < due {
            return Err(rej(RejCode::Underpaid, "short of the chunks claimed"));
        }
        if info.amount > due && !e.has(SeederFlaw::AcceptsOverpay) {
            credit_anyway(self);
            return Err(rej(RejCode::Overpaid, "more than the chunks claimed"));
        }
        // 4. Swap: now, or held (acknowledged now, confirmed on completion).
        let (peer, upto, e2) = (self.peer, pay.upto_chunk, e.clone());
        let now = e.net.swap(
            &pay.token,
            Box::new(move |outcome| MockSession::settle(&e2, peer, upto, outcome)),
        );
        if matches!(now, Some(Swap::Spent)) {
            let mut st = e.state();
            self.ban(&mut st);
            return Err(rej(RejCode::Spent, "already spent"));
        }
        if let Some(outcome) = now {
            MockSession::settle(&e, peer, upto, outcome);
        }
        let mut st = e.state();
        let a = st.accounts.entry(self.peer).or_default();
        a.acked = pay.upto_chunk;
        self.spent_total += info.amount;
        Ok(Ack {
            accepted_upto: pay.upto_chunk,
            spent_total: self.spent_total,
        })
    }

    fn banned(&self) -> bool {
        self.is_banned(&self.e.state())
    }
}

/// An honest viewer holding tokens from one mint (NFX-07 §3a). With a [`ViewerFlaw`] it
/// is deliberately not.
pub struct MockViewer {
    net: MockNetwork,
    flaw: Option<ViewerFlaw>,
    mint: String,
    max_price: u64,
    quote: Option<Quote>,
    requested: u64,
    acked: u64,
    paid_total: u64,
    /// The payment sent and not yet acknowledged: (upto, amount, token).
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
            paid_total: 0,
            pending: None,
            stopped: false,
        }
    }

    fn has(&self, f: ViewerFlaw) -> bool {
        self.flaw == Some(f)
    }

    fn pay_when(&mut self, threshold: u64) -> Result<Option<Pay>, String> {
        let Some(q) = &self.quote else {
            return Ok(None);
        };
        if self.stopped || self.pending.is_some() {
            return Ok(None);
        }
        let unpaid = self.requested - self.acked;
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

    /// Take the pending payment's proofs back (swap them to ourselves).
    fn reclaim(&mut self) {
        if let Some((_, _, token)) = self.pending.take()
            && !self.has(ViewerFlaw::NoReclaim)
        {
            let _ = self.net.swap_now(&token);
        }
        self.stopped = true;
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
        self.quote = Some(quote.clone());
        Ok(())
    }

    fn requested(&mut self) {
        self.requested += 1;
    }

    async fn due(&mut self) -> Result<Option<Pay>, String> {
        // Pay at half the window, so the seeder never has to stall.
        let window = self.quote.as_ref().map_or(1, |q| q.window);
        let when = if self.has(ViewerFlaw::PaysAtTheWindow) {
            window + 1
        } else {
            window.div_ceil(2)
        };
        self.pay_when(when.max(1))
    }

    async fn last_pay(&mut self) -> Result<Option<Pay>, String> {
        self.pay_when(1)
    }

    fn ack(&mut self, ack: &Ack) -> Result<(), String> {
        let expected = self.pending.take();
        let ok = match &expected {
            Some((upto, amount, _)) => {
                ack.accepted_upto == *upto
                    && (ack.spent_total == self.paid_total + amount
                        || self.has(ViewerFlaw::IgnoresSpentTotal))
            }
            None => self.has(ViewerFlaw::AcceptsUnsolicitedAck),
        };
        if ok || self.has(ViewerFlaw::IgnoresBadAck) {
            self.acked = ack.accepted_upto;
            if let Some((_, amount, _)) = expected {
                self.paid_total += amount;
            }
            return Ok(());
        }
        self.stopped = true;
        Err("an ack that does not match what was paid".into())
    }

    async fn rej(&mut self, _rej: &Rej) {
        self.reclaim();
    }

    async fn timeout(&mut self) {
        self.reclaim();
    }

    fn stopped(&self) -> bool {
        self.stopped
    }
}

/// The mock behind the adversary suite.
pub struct MockHarness {
    net: MockNetwork,
    mint: String,
    video: VideoAddr,
    sessions: AtomicU64,
    seeder_flaw: Option<SeederFlaw>,
    viewer_flaw: Option<ViewerFlaw>,
}

impl Default for MockHarness {
    fn default() -> Self {
        Self {
            net: MockNetwork::default(),
            mint: "https://mint.mock.example".into(),
            video: VideoAddr::parse("nfx:testnet:1:adversary-suite")
                .unwrap_or_else(|_| unreachable!("a valid literal")),
            sessions: AtomicU64::new(0),
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
}

impl Harness for MockHarness {
    type Engine = MockEngine;
    type Viewer = MockViewer;

    fn engine(&self, price: u64, window: u64, global_cap: u64) -> MockEngine {
        MockEngine::new(
            Quote {
                price_per_chunk: price,
                mints: vec![self.mint.clone()],
                window,
            },
            self.video.clone(),
            (0..1024).map(|n| self.chunk(n)).collect(),
            global_cap,
            self.net.clone(),
            self.seeder_flaw,
        )
    }

    fn hello(&self) -> Hello {
        let n = self.sessions.fetch_add(1, Ordering::Relaxed);
        Hello {
            video: self.video.clone(),
            session: format!("{n:032x}"),
        }
    }

    fn peer(&self, n: u8) -> PeerId {
        [n; 32]
    }

    fn chunk(&self, n: u16) -> String {
        format!("{n:064x}")
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
        if kind == BadToken::Garbage {
            return "cashuBgarbage-not-a-token".into();
        }
        let proof = self.net.fresh_proof();
        let mut info = TokenInfo {
            proofs: vec![proof],
            mints: vec![self.mint.clone()],
            amount,
            unit: "sat",
            locked: false,
            dleq_ok: true,
        };
        match kind {
            BadToken::WrongUnit => info.unit = "msat",
            BadToken::TwoMints => info.mints.push("https://other.mock.example".into()),
            BadToken::Locked => info.locked = true,
            BadToken::BadDleq => info.dleq_ok = false,
            BadToken::Garbage => {}
        }
        self.net.mint_token(info)
    }

    async fn reencode(&self, token: &str) -> String {
        let info = self
            .net
            .read(token)
            .unwrap_or_else(|| unreachable!("the suite re-encodes its own tokens"));
        self.net.mint_token(info)
    }

    async fn combine(&self, a: &str, b: &str) -> String {
        let (Some(a), Some(b)) = (self.net.read(a), self.net.read(b)) else {
            unreachable!("the suite combines its own tokens")
        };
        let mut mints = a.mints.clone();
        for m in b.mints {
            if !mints.contains(&m) {
                mints.push(m);
            }
        }
        self.net.mint_token(TokenInfo {
            proofs: a.proofs.iter().chain(&b.proofs).copied().collect(),
            mints,
            amount: a.amount + b.amount,
            unit: "sat",
            locked: false,
            dleq_ok: true,
        })
    }

    async fn claimed(&self, token: &str) -> bool {
        self.net.claimed(token)
    }

    async fn steal(&self, token: &str) -> bool {
        self.net.swap_now(token) == Swap::Claimed
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
}
