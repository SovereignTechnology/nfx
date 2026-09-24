//! The NFX-07 adversary suite against the mock engine. The M2 security stage runs the same
//! macro against the real engine (an in-process CDK mint); every scenario must pass there
//! unchanged.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::mock::MockHarness;

nfx_pay::adversary_suite!(MockHarness::default());
