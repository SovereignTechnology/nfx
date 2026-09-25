//! The NFX-07 adversary suite against the mock engine, its mint answering each read of swap
//! state on the reader's next poll: an engine whose reads are real round trips must pass
//! every scenario as the synchronous mock does.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::mock::MockHarness;

nfx_pay::adversary_suite!(MockHarness::with_round_trip_reads());
