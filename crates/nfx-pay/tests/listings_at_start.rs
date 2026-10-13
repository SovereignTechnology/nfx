//! The NFX-07 adversary suite against the mock engine asking every quoted mint for its
//! keyset listing at its start too: a keyset a mint started in that second waits for the
//! next second's listing (NFX-07 §3 step 3), and every scenario must pass as against the
//! engine that asks only when a check needs it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::mock::MockHarness;

nfx_pay::adversary_suite!(MockHarness::with_listings_at_start());
