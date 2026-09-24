//! The suite has teeth: each defect planted in the mock (every one the audits found in a
//! plausible engine) fails the scenario written for it. Against the honest mock every
//! scenario passes (`adversary.rs`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use nfx_pay::adversary;
use nfx_pay::mock::{MockHarness, SeederFlaw as S, ViewerFlaw as V};

macro_rules! catches {
    ($($test:ident: $harness:expr => $scenario:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $test() {
                let run = tokio::spawn(async { adversary::$scenario(&$harness).await });
                assert!(
                    run.await.as_ref().is_err_and(tokio::task::JoinError::is_panic),
                    "{} did not catch the planted defect",
                    stringify!($scenario)
                );
            }
        )*
    };
}

catches!(
    overpay_accepted: MockHarness::with_seeder_flaw(S::AcceptsOverpay) => overpaid_is_refused_and_credits_nothing,
    foreign_mint_accepted: MockHarness::with_seeder_flaw(S::AcceptsForeignMint) => foreign_and_lookalike_mints_are_refused,
    prefix_mint_match: MockHarness::with_seeder_flaw(S::PrefixMint) => foreign_and_lookalike_mints_are_refused,
    bad_tokens_accepted: MockHarness::with_seeder_flaw(S::AcceptsBadTokens) => bad_tokens_are_refused,
    spent_without_ban: MockHarness::with_seeder_flaw(S::NoBanOnSpent) => a_double_spend_bans_the_peer,
    window_off_by_one: MockHarness::with_seeder_flaw(S::WindowOffByOne) => an_unpaid_window_stops_serving,
    claims_before_checking: MockHarness::with_seeder_flaw(S::ClaimsBeforeChecking) => underpaid_is_refused_and_credits_nothing,
    stale_credited: MockHarness::with_seeder_flaw(S::IgnoresStale) => a_stale_pay_changes_nothing,
    gates_on_acked: MockHarness::with_seeder_flaw(S::GatesOnAcked) => service_waits_for_confirmed_swaps,
    refusal_credits: MockHarness::with_seeder_flaw(S::RefusalCredits) => overpaid_is_refused_and_credits_nothing,
    refusal_credits_mint: MockHarness::with_seeder_flaw(S::RefusalCredits) => foreign_and_lookalike_mints_are_refused,
    wrapping_mul: MockHarness::with_seeder_flaw(S::WrappingMul) => an_overflowing_claim_is_underpaid,
    pay_ignores_ban: MockHarness::with_seeder_flaw(S::PayIgnoresBan) => a_banned_peer_stays_banned,
    ban_per_session: MockHarness::with_seeder_flaw(S::BanPerSession) => a_banned_peer_stays_banned,
    fresh_window_per_hello: MockHarness::with_seeder_flaw(S::FreshWindowPerHello) => a_new_hello_continues_the_account,
    session_id_any_peer: MockHarness::with_seeder_flaw(S::SessionIdAnyPeer) => a_session_id_is_bound_to_its_peer,
    counts_distinct_files: MockHarness::with_seeder_flaw(S::CountsDistinctFiles) => every_request_counts_whole_or_not,
    admits_foreign_chunks: MockHarness::with_seeder_flaw(S::AdmitsForeignChunks) => only_the_sessions_video_is_admitted,
    no_global_cap: MockHarness::with_seeder_flaw(S::NoGlobalCap) => a_global_cap_bounds_free_service,
    outage_bans: MockHarness::with_seeder_flaw(S::OutageBans) => a_mint_outage_is_not_a_ban,
    viewer_pays_ahead: MockHarness::with_viewer_flaw(V::PaysAhead) => a_viewer_pays_for_every_request_and_no_more,
    viewer_ignores_bad_ack: MockHarness::with_viewer_flaw(V::IgnoresBadAck) => a_viewer_stops_on_a_wrong_or_unsolicited_ack,
    viewer_pays_too_late: MockHarness::with_viewer_flaw(V::PaysAtTheWindow) => an_honest_pair_streams_a_whole_video,
    viewer_second_quote: MockHarness::with_viewer_flaw(V::AcceptsSecondQuote) => a_viewer_refuses_quotes_it_cannot_honour,
    viewer_unsolicited_ack: MockHarness::with_viewer_flaw(V::AcceptsUnsolicitedAck) => a_viewer_stops_on_a_wrong_or_unsolicited_ack,
    viewer_ignores_spent_total: MockHarness::with_viewer_flaw(V::IgnoresSpentTotal) => a_viewer_stops_on_a_wrong_or_unsolicited_ack,
    viewer_no_reclaim: MockHarness::with_viewer_flaw(V::NoReclaim) => a_viewer_reclaims_a_refused_payment,
);
