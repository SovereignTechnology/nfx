//! The NFX-07 adversary suite against the mock engine, its mint answering each read of swap
//! state from another thread a few milliseconds after it is sent, waking the reader, as a
//! real mint's answer comes back: an engine whose reads are real round trips must pass every
//! scenario as the synchronous mock does.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::mock::MockHarness;

nfx_pay::adversary_suite!(MockHarness::with_woken_reads());
