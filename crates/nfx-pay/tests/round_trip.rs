//! The NFX-07 adversary suite against the mock engine, its mint answering each read of swap
//! state on the reader's next poll: a read then spans polls of its entry, and the scenarios
//! act between them. `tests/woken_answers.rs` runs the suite with each of the seeder's calls
//! answered from another thread instead, as a real mint's answer comes back.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::mock::MockHarness;

nfx_pay::adversary_suite!(MockHarness::with_round_trip_reads());
