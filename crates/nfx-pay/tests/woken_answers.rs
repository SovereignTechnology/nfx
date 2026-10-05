//! The NFX-07 adversary suite against the mock engine, its mint answering each of the
//! seeder's calls (its reads of swap state, its swaps, its key requests and keyset listings)
//! from another thread a few milliseconds after it reaches the mint, waking the caller, as a
//! real mint's answer comes back: an engine whose calls are real round trips must pass every
//! scenario as the synchronous mock does.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::mock::MockHarness;

nfx_pay::adversary_suite!(MockHarness::with_woken_answers());
