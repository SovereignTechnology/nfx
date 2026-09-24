//! A mock mint network and honest mock engines: an executable reading of NFX-07 §3.
//!
//! Tokens look like `cashuBmock<16 hex digits>`, which no real Cashu wallet accepts. The
//! network remembers each token's mint and amount and which tokens are claimed, so double
//! spends and foreign mints can be staged. No money and no cryptography are involved.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError};

use nfx_proto::pay::{Ack, Pay, Quote, Rej, RejCode};

use crate::session::{Harness, Seeder, Viewer};

#[derive(Default)]
struct Ledger {
    tokens: HashMap<String, (String, u64)>,
    claimed: HashSet<String>,
    next: u64,
}

/// Every mock mint's ledger, shared.
#[derive(Clone, Default)]
pub struct MockNetwork(Arc<Mutex<Ledger>>);

impl MockNetwork {
    fn ledger(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A fresh token worth `amount` from `mint`.
    #[must_use]
    pub fn issue(&self, mint: &str, amount: u64) -> String {
        let mut l = self.ledger();
        l.next += 1;
        let token = format!("cashuBmock{:016x}", l.next);
        l.tokens.insert(token.clone(), (mint.to_owned(), amount));
        token
    }

    /// A token's mint and amount; `None` for a token no mock mint issued.
    #[must_use]
    pub fn read(&self, token: &str) -> Option<(String, u64)> {
        self.ledger().tokens.get(token).cloned()
    }

    /// Claim a token at its mint (the NUT-03 swap). False if it was already claimed.
    pub fn claim(&self, token: &str) -> bool {
        self.ledger().claimed.insert(token.to_owned())
    }

    #[must_use]
    pub fn claimed(&self, token: &str) -> bool {
        self.ledger().claimed.contains(token)
    }
}

/// A defect planted in a mock seeder, to prove the adversary suite catches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeederFlaw {
    AcceptsOverpay,
    AcceptsForeignMint,
    NoBanOnSpent,
    WindowOffByOne,
    ClaimsBeforeChecking,
    IgnoresStale,
}

/// A defect planted in a mock viewer, to prove the adversary suite catches it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewerFlaw {
    PaysAhead,
    IgnoresBadAck,
    PaysAtTheWindow,
}

/// An honest seeder: the NFX-07 §3 checks in order, claiming synchronously. With a
/// [`SeederFlaw`] it is deliberately not.
pub struct MockSeeder {
    quote: Quote,
    net: MockNetwork,
    flaw: Option<SeederFlaw>,
    delivered: u64,
    acked: u64,
    spent_total: u64,
    banned: bool,
}

impl MockSeeder {
    #[must_use]
    pub fn new(quote: Quote, net: MockNetwork) -> Self {
        Self {
            quote,
            net,
            flaw: None,
            delivered: 0,
            acked: 0,
            spent_total: 0,
            banned: false,
        }
    }
}

fn rej(code: RejCode, detail: &str) -> Rej {
    Rej {
        code,
        detail: Some(detail.to_owned()),
    }
}

impl Seeder for MockSeeder {
    fn quote(&self) -> &Quote {
        &self.quote
    }

    fn may_serve(&self) -> bool {
        let extra = u64::from(self.flaw == Some(SeederFlaw::WindowOffByOne));
        !self.banned && self.delivered < self.acked.saturating_add(self.quote.window) + extra
    }

    fn delivered(&mut self) {
        self.delivered += 1;
    }

    async fn pay(&mut self, pay: &Pay) -> Result<Ack, Rej> {
        if self.banned {
            return Err(rej(RejCode::Spent, "this session is banned"));
        }
        if self.flaw == Some(SeederFlaw::ClaimsBeforeChecking) {
            self.net.claim(&pay.token);
        }
        if pay.upto_chunk <= self.acked && self.flaw != Some(SeederFlaw::IgnoresStale) {
            return Err(rej(RejCode::Stale, "already paid up to there"));
        }
        // 1. The exact amount. A product that overflows can never be paid: underpaid.
        let chunks = pay.upto_chunk.saturating_sub(self.acked);
        let Some(due) = chunks.checked_mul(self.quote.price_per_chunk) else {
            return Err(rej(RejCode::Underpaid, "amount overflows"));
        };
        let Some((mint, amount)) = self.net.read(&pay.token) else {
            return Err(rej(RejCode::Underpaid, "unreadable token"));
        };
        if amount < due {
            return Err(rej(RejCode::Underpaid, "short of the chunks claimed"));
        }
        if amount > due && self.flaw != Some(SeederFlaw::AcceptsOverpay) {
            return Err(rej(RejCode::Overpaid, "more than the chunks claimed"));
        }
        // 2. A mint this seeder quoted.
        if !self.quote.mints.contains(&mint) && self.flaw != Some(SeederFlaw::AcceptsForeignMint) {
            return Err(rej(RejCode::BadMint, "not a quoted mint"));
        }
        // 3. Unspent: claim it (the swap). A spent token bans the session.
        if !self.net.claim(&pay.token) && self.flaw != Some(SeederFlaw::ClaimsBeforeChecking) {
            self.banned = self.flaw != Some(SeederFlaw::NoBanOnSpent);
            return Err(rej(RejCode::Spent, "already spent"));
        }
        self.acked = pay.upto_chunk;
        self.spent_total += amount;
        Ok(Ack {
            accepted_upto: self.acked,
            spent_total: self.spent_total,
        })
    }

    fn banned(&self) -> bool {
        self.banned
    }
}

/// An honest viewer holding tokens from one mint. With a [`ViewerFlaw`] it is
/// deliberately not.
pub struct MockViewer {
    net: MockNetwork,
    flaw: Option<ViewerFlaw>,
    mint: String,
    max_price: u64,
    quote: Option<Quote>,
    received: u64,
    acked: u64,
    paid_total: u64,
    /// The payment sent and not yet acknowledged: (upto, amount).
    pending: Option<(u64, u64)>,
    stopped: bool,
}

impl MockViewer {
    #[must_use]
    pub fn new(net: MockNetwork, mint: &str, max_price: u64) -> Self {
        Self {
            net,
            flaw: None,
            mint: mint.to_owned(),
            max_price,
            quote: None,
            received: 0,
            acked: 0,
            paid_total: 0,
            pending: None,
            stopped: false,
        }
    }

    fn pay_upto_received(&mut self, threshold: u64) -> Result<Option<Pay>, String> {
        let Some(q) = &self.quote else {
            return Ok(None);
        };
        if self.stopped || self.pending.is_some() {
            return Ok(None);
        }
        let unpaid = self.received - self.acked;
        if unpaid == 0 || unpaid < threshold {
            return Ok(None);
        }
        let ahead = u64::from(self.flaw == Some(ViewerFlaw::PaysAhead));
        let amount = (unpaid + ahead)
            .checked_mul(q.price_per_chunk)
            .ok_or("amount overflows")?;
        let token = self.net.issue(&self.mint, amount);
        self.pending = Some((self.received + ahead, amount));
        Ok(Some(Pay {
            upto_chunk: self.received + ahead,
            token,
        }))
    }
}

impl Viewer for MockViewer {
    fn quote(&mut self, quote: &Quote) -> Result<(), String> {
        if quote.price_per_chunk > self.max_price {
            return Err("price above this viewer's cap".into());
        }
        if !quote.mints.contains(&self.mint) {
            return Err("no mint this viewer holds tokens from".into());
        }
        self.quote = Some(quote.clone());
        Ok(())
    }

    fn received(&mut self) {
        self.received += 1;
    }

    async fn due(&mut self) -> Result<Option<Pay>, String> {
        // Pay at half the window, so the seeder never has to stall.
        let window = self.quote.as_ref().map_or(1, |q| q.window);
        let when = if self.flaw == Some(ViewerFlaw::PaysAtTheWindow) {
            window + 1
        } else {
            window.div_ceil(2)
        };
        self.pay_upto_received(when.max(1))
    }

    async fn last_pay(&mut self) -> Result<Option<Pay>, String> {
        self.pay_upto_received(1)
    }

    fn ack(&mut self, ack: &Ack) -> Result<(), String> {
        match self.pending.take() {
            Some((upto, amount))
                if ack.accepted_upto == upto && ack.spent_total == self.paid_total + amount =>
            {
                self.acked = upto;
                self.paid_total += amount;
                Ok(())
            }
            _ if self.flaw == Some(ViewerFlaw::IgnoresBadAck) => {
                self.acked = ack.accepted_upto;
                Ok(())
            }
            _ => {
                self.stopped = true;
                Err("the seeder acknowledged something other than what was paid".into())
            }
        }
    }

    fn rej(&mut self, _rej: &Rej) {
        self.stopped = true;
        self.pending = None;
    }

    fn stopped(&self) -> bool {
        self.stopped
    }
}

/// The mock behind the adversary suite: one quoted mint and one foreign mint.
pub struct MockHarness {
    net: MockNetwork,
    mint: String,
    foreign: String,
    seeder_flaw: Option<SeederFlaw>,
    viewer_flaw: Option<ViewerFlaw>,
}

impl MockHarness {
    /// A harness whose seeders carry `flaw` (the suite must fail against it).
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

impl Default for MockHarness {
    fn default() -> Self {
        Self {
            net: MockNetwork::default(),
            mint: "https://mint.mock.example".into(),
            foreign: "https://other-mint.mock.example".into(),
            seeder_flaw: None,
            viewer_flaw: None,
        }
    }
}

impl Harness for MockHarness {
    type Seeder = MockSeeder;
    type Viewer = MockViewer;

    fn seeder(&self, price: u64, window: u64) -> MockSeeder {
        let mut s = MockSeeder::new(
            Quote {
                price_per_chunk: price,
                mints: vec![self.mint.clone()],
                window,
            },
            self.net.clone(),
        );
        s.flaw = self.seeder_flaw;
        s
    }

    fn viewer(&self, max_price: u64) -> MockViewer {
        let mut v = MockViewer::new(self.net.clone(), &self.mint, max_price);
        v.flaw = self.viewer_flaw;
        v
    }

    async fn token(&self, amount: u64) -> String {
        self.net.issue(&self.mint, amount)
    }

    async fn foreign_token(&self, amount: u64) -> String {
        self.net.issue(&self.foreign, amount)
    }

    async fn claimed(&self, token: &str) -> bool {
        self.net.claimed(token)
    }

    async fn settle(&self) {}
}
