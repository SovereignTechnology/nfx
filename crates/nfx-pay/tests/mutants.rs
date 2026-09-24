//! The suite has teeth: each defect planted in the mock fails the scenario written for it.
//! (Against the honest mock every scenario passes: `adversary.rs`.)

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::adversary;
use nfx_pay::mock::{MockHarness, SeederFlaw, ViewerFlaw};

macro_rules! catches {
    ($($test:ident: $harness:expr => $scenario:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $test() {
                let run = tokio::spawn(async { adversary::$scenario(&$harness).await });
                let outcome = run.await;
                assert!(
                    outcome.as_ref().is_err_and(tokio::task::JoinError::is_panic),
                    "{} did not catch the planted defect",
                    stringify!($scenario)
                );
            }
        )*
    };
}

catches!(
    overpay_accepted: MockHarness::with_seeder_flaw(SeederFlaw::AcceptsOverpay) => overpaid_is_refused,
    foreign_mint_accepted: MockHarness::with_seeder_flaw(SeederFlaw::AcceptsForeignMint) => a_foreign_mint_is_refused,
    spent_without_ban: MockHarness::with_seeder_flaw(SeederFlaw::NoBanOnSpent) => a_double_spend_bans_the_session,
    window_off_by_one: MockHarness::with_seeder_flaw(SeederFlaw::WindowOffByOne) => an_unpaid_window_stops_serving,
    claims_before_checking: MockHarness::with_seeder_flaw(SeederFlaw::ClaimsBeforeChecking) => underpaid_is_refused,
    stale_credited: MockHarness::with_seeder_flaw(SeederFlaw::IgnoresStale) => a_stale_pay_changes_nothing,
    viewer_pays_ahead: MockHarness::with_viewer_flaw(ViewerFlaw::PaysAhead) => a_viewer_pays_only_for_what_it_received,
    viewer_ignores_bad_ack: MockHarness::with_viewer_flaw(ViewerFlaw::IgnoresBadAck) => a_viewer_stops_on_an_inconsistent_ack,
    viewer_pays_too_late: MockHarness::with_viewer_flaw(ViewerFlaw::PaysAtTheWindow) => an_honest_pair_streams_a_whole_video,
);
