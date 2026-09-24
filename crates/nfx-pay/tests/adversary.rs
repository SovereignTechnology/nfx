//! The NFX-07 adversary suite against the mock engine. The M2 security stage adds the same
//! list against the real engine (an in-process CDK mint), and every scenario must pass
//! there unchanged.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::adversary;
use nfx_pay::mock::MockHarness;

macro_rules! suite {
    ($($name:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $name() {
                adversary::$name(&MockHarness::default()).await;
            }
        )*

        #[test]
        fn every_scenario_runs_here() {
            let here = [$(stringify!($name)),*];
            assert_eq!(here.as_slice(), adversary::ALL);
        }
    };
}

suite!(
    exact_payment_opens_the_next_window,
    underpaid_is_refused,
    overpaid_is_refused,
    a_foreign_mint_is_refused,
    a_stale_pay_changes_nothing,
    an_overflowing_claim_is_underpaid,
    a_double_spend_bans_the_session,
    an_unpaid_window_stops_serving,
    sessions_are_isolated,
    a_viewer_pays_only_for_what_it_received,
    a_viewer_refuses_quotes_it_cannot_honour,
    a_viewer_stops_on_an_inconsistent_ack,
    a_viewer_stops_after_a_refusal,
    an_honest_pair_streams_a_whole_video,
);
