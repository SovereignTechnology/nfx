//! The suite has teeth: each defect planted in the mock fails the scenario written for
//! it. The defects are every one the audits found in a plausible engine or viewer.
//! Against the honest mock every scenario passes (`adversary.rs`).

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

fn s(flaw: S) -> MockHarness {
    MockHarness::with_seeder_flaw(flaw)
}

fn v(flaw: V) -> MockHarness {
    MockHarness::with_viewer_flaw(flaw)
}

catches!(
    overpay_accepted: s(S::AcceptsOverpay) => overpaid_is_refused_and_credits_nothing,
    foreign_mint_accepted: s(S::AcceptsForeignMint) => foreign_and_lookalike_mints_are_refused,
    prefix_mint_match: s(S::PrefixMint) => foreign_and_lookalike_mints_are_refused,
    dleq_at_the_tokens_mint: s(S::DleqAtTokenMint) => foreign_and_lookalike_mints_are_refused,
    bad_tokens_accepted: s(S::AcceptsBadTokens) => bad_tokens_are_refused,
    missing_dleq_accepted: s(S::NoDleqAccepted) => bad_tokens_are_refused,
    forged_proof_not_banned: s(S::InvalidNoBan) => bad_tokens_are_refused,
    spent_without_ban: s(S::NoBanOnSpent) => a_double_spend_bans_the_peer,
    spent_check_on_the_last_proof: s(S::SpentCheckLastProof) => a_double_spend_bans_the_peer,
    swaps_the_unspent_subset: s(S::SwapsUnspentSubset) => a_double_spend_bans_the_peer,
    window_off_by_one: s(S::WindowOffByOne) => an_unpaid_window_stops_serving,
    claims_before_checking: s(S::ClaimsBeforeChecking) => underpaid_is_refused_and_credits_nothing,
    stale_credited: s(S::IgnoresStale) => a_stale_pay_changes_nothing,
    refusal_credits_overpaid: s(S::RefusalCredits) => overpaid_is_refused_and_credits_nothing,
    refusal_credits_bad_mint: s(S::RefusalCredits) => foreign_and_lookalike_mints_are_refused,
    refusal_advances_the_watermark: s(S::RefusalAdvancesAcked) => underpaid_is_refused_and_credits_nothing,
    refusal_claims_a_proof: s(S::ClaimsOnRefusal) => underpaid_is_refused_and_credits_nothing,
    wrapping_mul: s(S::WrappingMul) => an_overflowing_claim_is_underpaid,
    pay_ignores_ban: s(S::PayIgnoresBan) => a_banned_peer_stays_banned,
    admit_ignores_ban: s(S::AdmitIgnoresBan) => a_banned_peer_stays_banned,
    ban_per_video: s(S::BanPerVideo) => a_banned_peer_stays_banned,
    fresh_window_per_hello: s(S::FreshWindowPerHello) => a_new_hello_continues_the_account,
    quote_forgets_the_account: s(S::QuoteForgetsAccount) => a_new_hello_continues_the_account,
    spent_total_per_session: s(S::SpentTotalPerSession) => a_new_hello_continues_the_account,
    open_session_id_reused: s(S::SessionIdAnyPeer) => a_session_id_names_one_open_session,
    session_cap_off_by_one: s(S::SessionCapOffByOne) => open_sessions_are_capped_and_released,
    session_cap_for_life: s(S::SessionCapLifetime) => open_sessions_are_capped_and_released,
    hello_for_any_video: s(S::HelloAnyVideo) => only_the_sessions_video_is_admitted,
    counts_distinct_files: s(S::CountsDistinctFiles) => every_request_counts_whole_or_not,
    admits_foreign_chunks: s(S::AdmitsForeignChunks) => only_the_sessions_video_is_admitted,
    window_per_video: s(S::PerVideoWindow) => the_window_spans_a_peers_videos,
    no_global_cap: s(S::NoGlobalCap) => a_global_cap_bounds_free_service,
    global_cap_off_by_one: s(S::GlobalCapGt) => a_global_cap_bounds_free_service,
    global_cap_nets_credit: s(S::GlobalCapNetsCredit) => the_global_cap_holds_whatever_payments_do,
    ban_forgets_debt: s(S::BanForgetsDebt) => the_global_cap_holds_whatever_payments_do,
    cap_before_credit: s(S::CapBeforeCredit) => prepaid_chunks_are_served_whatever_the_cap,
    paid_debt_stays_counted: s(S::PaidDebtStaysCounted) => a_global_cap_bounds_free_service,
    debt_never_ages: s(S::DebtNeverAges) => debt_counts_for_exactly_debt_ttl,
    peer_debt_ages: s(S::PeerDebtAges) => debt_counts_for_exactly_debt_ttl,
    ack_before_swap: s(S::AckBeforeSwap) => service_waits_for_the_swap,
    outage_bans: s(S::OutageBans) => a_mint_outage_is_not_a_ban,
    outage_credits: s(S::OutageCredits) => a_mint_outage_is_not_a_ban,
    spent_total_counts_refusals: s(S::SpentTotalCountsRefused) => underpaid_is_refused_and_credits_nothing,
    concurrent_pays: s(S::ConcurrentPays) => one_accounts_payments_are_serialised,
    too_many_proofs_accepted: s(S::TooManyProofsAccepted) => bad_tokens_are_refused,
    ban_checked_before_the_turn: s(S::BanCheckedBeforeTurn) => a_banned_peer_stays_banned,
    quote_spent_peer_wide: s(S::QuoteSpentPeerWide) => a_new_hello_continues_the_account,
    quote_served_peer_wide: s(S::QuoteServedPeerWide) => a_new_hello_continues_the_account,
    ack_spent_peer_wide: s(S::AckSpentPeerWide) => a_new_hello_continues_the_account,
    session_cap_per_video: s(S::SessionCapPerVideo) => open_sessions_are_capped_and_released,
    covered_peer_wide: s(S::CoveredPeerWide) => credit_covers_only_its_own_video,
    covered_logged_as_debt: s(S::CoveredLoggedAsDebt) => debt_is_freed_exactly_once,
    ages_after_one_second: s(S::AgeTtlOneSecond) => debt_counts_for_exactly_debt_ttl,
    count_freed_twice: s(S::CountFreedTwice) => debt_is_freed_exactly_once,
    count_freed_twice_wrapping: s(S::CountFreedTwiceWrapping) => debt_is_freed_exactly_once,
    claim_then_await_credit: s(S::ClaimThenAwaitCredit) => a_dropped_pay_is_credited_or_never_claimed,
    viewer_pays_ahead: v(V::PaysAhead) => a_viewer_pays_for_every_request_and_no_more,
    viewer_ignores_bad_ack: v(V::IgnoresBadAck) => a_viewer_stops_on_a_wrong_or_unsolicited_ack,
    viewer_pays_too_late: v(V::PaysAtTheWindow) => an_honest_pair_streams_a_whole_video,
    viewer_pays_at_the_full_window: v(V::PaysAtFullWindow) => an_honest_pair_streams_a_whole_video,
    viewer_second_quote: v(V::AcceptsSecondQuote) => a_viewer_refuses_quotes_it_cannot_honour,
    viewer_unsolicited_ack: v(V::AcceptsUnsolicitedAck) => a_viewer_stops_on_a_wrong_or_unsolicited_ack,
    viewer_ignores_spent_total: v(V::IgnoresSpentTotal) => a_viewer_stops_on_a_wrong_or_unsolicited_ack,
    viewer_accepts_an_inflated_ack: v(V::AckAcceptsInflated) => a_viewer_stops_on_a_wrong_or_unsolicited_ack,
    viewer_no_reclaim: v(V::NoReclaim) => a_viewer_reclaims_a_refused_payment,
    viewer_reclaims_one_proof: v(V::ReclaimsFirstProofOnly) => a_viewer_reclaims_a_refused_payment,
    viewer_reclaims_only_after_spent: v(V::NoReclaimUnlessSpent) => a_viewer_reclaims_a_refused_payment,
    viewer_last_pay_after_stop: v(V::LastPayIgnoresStop) => a_stopped_viewer_pays_nothing,
    viewer_pays_for_refused_requests: v(V::PaysForRefused) => a_viewer_pays_for_every_request_and_no_more,
    viewer_trusts_the_quote: v(V::TrustsQuote) => a_viewer_refuses_quotes_it_cannot_honour,
    viewer_pays_after_a_timeout: v(V::KeepsPayingAfterTimeout) => a_viewer_reclaims_an_unanswered_payment,
    viewer_forgets_its_ledger: v(V::ForgetsLedger) => an_honest_pair_resumes_after_a_reconnect,
    viewer_stops_on_an_outage: v(V::StopsOnOutage) => an_honest_pair_rides_out_a_mint_outage,
    viewer_pays_its_cap: v(V::PaysAtCap) => an_honest_pair_streams_a_whole_video,
    viewer_ignores_the_reclaim: v(V::IgnoresReclaimOutcome) => a_lying_seeder_takes_at_most_one_payment,
    viewer_refused_no_credit: v(V::RefusedNoCredit) => a_viewer_owes_nothing_for_refused_requests,
    viewer_refused_twice: v(V::RefusedTwice) => a_viewer_owes_nothing_for_refused_requests,
    viewer_never_pays_ahead: v(V::NoPayAhead) => a_paying_watcher_gets_through_a_full_cap,
    viewer_resyncs_down: v(V::ResyncsDown) => a_viewer_refuses_quotes_it_cannot_honour,
    viewer_skips_its_cap_on_resume: v(V::SkipsCapOnResume) => a_viewer_refuses_quotes_it_cannot_honour,
    viewer_times_out_early: v(V::TimeoutEarly) => a_viewer_reclaims_an_unanswered_payment,
    viewer_reclaims_at_end: v(V::EndReclaimsNow) => an_honest_pair_survives_a_dropped_connection,
    viewer_forgets_at_end: v(V::EndForgetsPending) => an_honest_pair_survives_a_dropped_connection,
);
