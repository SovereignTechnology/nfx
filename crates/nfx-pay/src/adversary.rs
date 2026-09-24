//! The adversary suite for NFX-07 open-mode payments, written before the engine.
//!
//! Every scenario is generic over [`Harness`]. It runs against the mock now, and the M2
//! security stage runs it unchanged against the real engine with an in-process mint. A
//! scenario panics on failure. Concurrency uses [`both`], a deterministic two-future join,
//! so the suite needs no runtime of its own.
//!
//! **Run it with [`adversary_suite!`](crate::adversary_suite)**, which emits one test per
//! scenario from the list kept here: a runner cannot choose a subset. The list is pinned
//! with the locked paths, so weakening the suite is a reviewed change.

use std::future::{Future, poll_fn};
use std::pin::pin;
use std::task::Poll;
use std::time::Duration;

use nfx_proto::pay::{Ack, Pay, Quote, Rej, RejCode};

use crate::session::{BadToken, Harness, SeederEngine, SeederSession, Viewer};

/// Every scenario, one `#[tokio::test]` each, against the harness `$h` builds.
#[macro_export]
macro_rules! adversary_suite {
    ($h:expr) => {
        $crate::adversary_suite!(@each $h;
            exact_payment_opens_the_next_window,
            underpaid_is_refused_and_credits_nothing,
            overpaid_is_refused_and_credits_nothing,
            foreign_and_lookalike_mints_are_refused,
            bad_tokens_are_refused,
            a_stale_pay_changes_nothing,
            an_overflowing_claim_is_underpaid,
            a_double_spend_bans_the_peer,
            a_banned_peer_stays_banned,
            a_new_hello_continues_the_account,
            a_session_id_names_one_open_session,
            open_sessions_are_capped_and_released,
            service_waits_for_the_swap,
            a_mint_outage_is_not_a_ban,
            every_request_counts_whole_or_not,
            only_the_sessions_video_is_admitted,
            an_unpaid_window_stops_serving,
            the_window_spans_a_peers_videos,
            a_global_cap_bounds_free_service,
            the_global_cap_holds_whatever_payments_do,
            prepaid_chunks_are_served_whatever_the_cap,
            debt_counts_for_exactly_debt_ttl,
            credit_covers_only_its_own_video,
            debt_is_freed_exactly_once,
            prepayment_extends_service_exactly,
            peers_are_isolated,
            one_accounts_payments_are_serialised,
            a_dropped_pay_is_credited_or_never_claimed,
            concurrent_admission_is_atomic,
            a_viewer_pays_for_every_request_and_no_more,
            a_viewer_owes_nothing_for_refused_requests,
            a_viewer_refuses_quotes_it_cannot_honour,
            a_viewer_stops_on_a_wrong_or_unsolicited_ack,
            a_viewer_reclaims_a_refused_payment,
            a_viewer_reclaims_an_unanswered_payment,
            a_lying_seeder_takes_at_most_one_payment,
            a_stopped_viewer_pays_nothing,
            an_honest_pair_streams_a_whole_video,
            an_honest_pair_resumes_after_a_reconnect,
            an_honest_pair_waits_out_a_slow_mint,
            an_honest_pair_rides_out_a_mint_outage,
            an_honest_pair_survives_a_dropped_connection,
            a_paying_watcher_gets_through_a_full_cap,
        );
    };
    (@each $h:expr; $($name:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $name() {
                $crate::adversary::$name(&$h).await;
            }
        )*
    };
}

type Session<H> = <<H as Harness>::Engine as SeederEngine>::Session;

/// Run two futures on this task, always polling `a` first: `a` reaches its first wait
/// before `b` starts.
pub async fn both<A: Future, B: Future>(a: A, b: B) -> (A::Output, B::Output) {
    let (mut a, mut b) = (pin!(a), pin!(b));
    let (mut ra, mut rb) = (None, None);
    poll_fn(|cx| {
        if ra.is_none()
            && let Poll::Ready(v) = a.as_mut().poll(cx)
        {
            ra = Some(v);
        }
        if rb.is_none()
            && let Poll::Ready(v) = b.as_mut().poll(cx)
        {
            rb = Some(v);
        }
        match (ra.take(), rb.take()) {
            (Some(x), Some(y)) => Poll::Ready((x, y)),
            (x, y) => {
                (ra, rb) = (x, y);
                Poll::Pending
            }
        }
    })
    .await
}

/// Let the other future of a [`both`] run.
async fn yield_once() {
    let mut yielded = false;
    poll_fn(|cx| {
        if yielded {
            Poll::Ready(())
        } else {
            yielded = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    })
    .await;
}

/// Poll `f` once, then drop it: a connection that closes while its request is in flight.
async fn poll_once<F: Future>(f: F) {
    let mut f = pin!(f);
    poll_fn(|cx| {
        let _ = f.as_mut().poll(cx);
        Poll::Ready(())
    })
    .await;
}

fn open<H: Harness>(h: &H, e: &H::Engine, peer: u8) -> Session<H> {
    open_on(h, e, peer, 0)
}

fn open_on<H: Harness>(h: &H, e: &H::Engine, peer: u8, video: u8) -> Session<H> {
    e.hello(&h.peer(peer), &h.hello_for(video))
        .expect("a hello")
}

/// Admit up to `n` requests for distinct files of video 0 from file `from`; how many were.
fn serve<H: Harness>(h: &H, s: &mut Session<H>, from: u16, n: u16) -> u64 {
    serve_on(h, s, 0, from, n)
}

fn serve_on<H: Harness>(h: &H, s: &mut Session<H>, video: u8, from: u16, n: u16) -> u64 {
    (from..from + n)
        .filter(|i| s.admit(&h.chunk_of(video, *i)))
        .count() as u64
}

fn is_rej<T>(r: &Result<T, Rej>, code: &RejCode) -> bool {
    matches!(r, Err(rej) if rej.code == *code)
}

/// A refusal claims nothing, not even one proof, and credits nothing: the full window
/// stays full.
async fn refused<H: Harness>(h: &H, s: &mut Session<H>, pay: &Pay, want: &RejCode) {
    let rej = s.pay(pay).await.expect_err("this payment must be refused");
    assert_eq!(&rej.code, want, "{:?}", rej.detail);
    assert!(
        !h.claimed_any(&pay.token).await,
        "a refused token is not claimed, not even in part"
    );
    assert_eq!(serve(h, s, 900, 1), 0, "a refusal credits nothing");
}

/// After refusals, the exact payment for the range is accepted as if they never
/// happened: same watermark, same `spent_total`.
async fn settles<H: Harness>(h: &H, s: &mut Session<H>, upto: u64, amount: u64, spent: u64) {
    let token = h.token(amount).await;
    let ack = s
        .pay(&Pay {
            upto_chunk: upto,
            token: token.clone(),
        })
        .await
        .expect("the exact payment is accepted after the refusals");
    assert_eq!(
        (ack.accepted_upto, ack.spent_total),
        (upto, spent + amount),
        "the refusals moved nothing"
    );
    assert!(h.claimed_all(&token).await);
}

/// A peer is served `window` chunks unpaid, then waits. An exact payment is swapped,
/// then acknowledged, and the next window opens.
pub async fn exact_payment_opens_the_next_window<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    assert_eq!(serve(h, &mut s, 0, 10), 4, "a window of 4");
    let token = h.token(12).await;
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await
        .expect("an exact payment");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 12));
    assert!(h.claimed_all(&token).await, "acknowledged means swapped");
    assert_eq!(serve(h, &mut s, 10, 10), 4, "the next window");
}

/// Short of the chunks claimed is `underpaid`, and moves nothing: paying only the upper
/// half of the range afterwards is still `underpaid`.
pub async fn underpaid_is_refused_and_credits_nothing<H: Harness>(h: &H) {
    let e = h.engine(3, 8, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 8);
    let short = Pay {
        upto_chunk: 4,
        token: h.token(11).await,
    };
    refused(h, &mut s, &short, &RejCode::Underpaid).await;
    let upper_half = Pay {
        upto_chunk: 8,
        token: h.token(12).await,
    };
    refused(h, &mut s, &upper_half, &RejCode::Underpaid).await;
    settles(h, &mut s, 8, 24, 0).await;
}

/// Above the chunks claimed is `overpaid`: never credit on a miscount.
pub async fn overpaid_is_refused_and_credits_nothing<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(13).await,
    };
    refused(h, &mut s, &pay, &RejCode::Overpaid).await;
    settles(h, &mut s, 4, 12, 0).await;
}

/// Only a mint whose URL is exactly a quoted one is accepted. A foreign mint and
/// lookalikes of the quoted URL are `bad-mint`, and nothing is fetched from them.
pub async fn foreign_and_lookalike_mints_are_refused<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let m = h.mint();
    let lookalikes = [
        "https://other-mint.example".to_owned(),
        format!("{m}.attacker.example"),
        format!("{m}/"),
        format!("{m}:443"),
        m.to_uppercase(),
    ];
    for url in &lookalikes {
        let pay = Pay {
            upto_chunk: 4,
            token: h.token_at(url, 12).await,
        };
        refused(h, &mut s, &pay, &RejCode::BadMint).await;
        assert!(!h.dialled(url), "nothing is fetched from {url}");
    }
    settles(h, &mut s, 4, 12, 0).await;
    assert!(h.dialled(&m), "keys come from the quoted mint");
}

/// Tokens of the wrong shape are `bad-token`: the wrong unit, two mints, more than 64
/// proofs, locked proofs, a missing or invalid DLEQ, or not a token at all. A proof the mint refuses as invalid
/// is `bad-token` too, and bans the peer.
pub async fn bad_tokens_are_refused<H: Harness>(h: &H) {
    let e = h.engine(3, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    for kind in [
        BadToken::WrongUnit,
        BadToken::TwoMints,
        BadToken::TooManyProofs,
        BadToken::Locked,
        BadToken::NoDleq,
        BadToken::BadDleq,
        BadToken::Garbage,
    ] {
        let pay = Pay {
            upto_chunk: 4,
            token: h.bad_token(kind, 12).await,
        };
        refused(h, &mut s, &pay, &RejCode::BadToken).await;
        assert!(!s.banned(), "{kind:?} is refused, not banned");
    }
    settles(h, &mut s, 4, 12, 0).await;

    let mut forger = open(h, &e, 2);
    serve(h, &mut forger, 0, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.bad_token(BadToken::Forged, 12).await,
    };
    let rej = forger.pay(&pay).await.expect_err("forged proofs");
    assert_eq!(rej.code, RejCode::BadToken);
    assert!(forger.banned(), "a forged proof bans the peer");
}

/// A `pay` at or below the watermark is `stale` and changes nothing.
pub async fn a_stale_pay_changes_nothing<H: Harness>(h: &H) {
    let e = h.engine(2, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    s.pay(&Pay {
        upto_chunk: 4,
        token: h.token(8).await,
    })
    .await
    .expect("the first payment");
    assert_eq!(serve(h, &mut s, 4, 4), 4);
    for upto in [4, 3] {
        let pay = Pay {
            upto_chunk: upto,
            token: h.token(2).await,
        };
        refused(h, &mut s, &pay, &RejCode::Stale).await;
    }
    settles(h, &mut s, 8, 8, 8).await;
}

/// A claim whose price overflows (chunks × price beyond 2^53−1, here beyond 2^64) is
/// `underpaid`, whatever a wrapped product would say.
pub async fn an_overflowing_claim_is_underpaid<H: Harness>(h: &H) {
    let e = h.engine(4096, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: (1 << 52) + 1,
        token: h.token(4096).await,
    };
    refused(h, &mut s, &pay, &RejCode::Underpaid).await;
    settles(h, &mut s, 4, 4 * 4096, 0).await;
}

/// Proofs already spent are `spent` and ban the peer, even re-encoded, and wherever a
/// spent proof sits among fresh ones: first, in the middle or last. The swap is atomic,
/// so the fresh proofs stay unclaimed. Other peers are unaffected.
pub async fn a_double_spend_bans_the_peer<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let token = h.token(4).await;
    let mut first = open(h, &e, 1);
    serve(h, &mut first, 0, 4);
    first
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await
        .expect("the first spend");
    let mut second = open(h, &e, 2);
    serve(h, &mut second, 0, 4);
    let rej = second
        .pay(&Pay {
            upto_chunk: 4,
            token: h.reencode(&token).await,
        })
        .await
        .expect_err("re-encoded, the proofs are still spent");
    assert_eq!(rej.code, RejCode::Spent);
    assert!(second.banned());

    for (position, peer) in [(0, 3u8), (1, 4), (2, 5)] {
        let spent = h.token(1).await;
        assert!(h.steal(&spent).await, "someone else spent it");
        let (fresh_a, fresh_b) = (h.token(1).await, h.token(2).await);
        let mut parts = vec![fresh_a.as_str(), fresh_b.as_str()];
        parts.insert(position, spent.as_str());
        let mut s = open(h, &e, peer);
        serve(h, &mut s, 0, 4);
        let rej = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.combine(&parts).await,
            })
            .await
            .expect_err("one spent proof spoils the token");
        assert_eq!(
            rej.code,
            RejCode::Spent,
            "spent proof at position {position}"
        );
        assert!(s.banned());
        assert!(
            !h.claimed_any(&fresh_a).await && !h.claimed_any(&fresh_b).await,
            "the fresh proofs are not claimed (spent proof at position {position})"
        );
    }
    assert_eq!(
        serve(h, &mut first, 4, 4),
        4,
        "the first peer is unaffected"
    );
    first
        .pay(&Pay {
            upto_chunk: 8,
            token: h.token(4).await,
        })
        .await
        .expect("and still paying");
}

/// A banned peer gets nothing more: not a pre-paid chunk, not a new session on any
/// video, not a hearing for a valid payment, whose token stays unclaimed. A payment
/// queued behind the one that bans is refused when its turn comes.
pub async fn a_banned_peer_stays_banned<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let mut other_video = open_on(h, &e, 1, 1);
    s.pay(&Pay {
        upto_chunk: 8,
        token: h.token(8).await,
    })
    .await
    .expect("a pre-payment");
    assert_eq!(serve(h, &mut s, 0, 2), 2);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let rej = s
        .pay(&Pay {
            upto_chunk: 12,
            token: spent,
        })
        .await
        .expect_err("a spent token");
    assert_eq!(rej.code, RejCode::Spent);
    assert!(s.banned());
    assert_eq!(serve(h, &mut s, 2, 1), 0, "not even a pre-paid chunk");
    assert_eq!(
        serve_on(h, &mut other_video, 1, 0, 1),
        0,
        "nor on another video"
    );
    let valid = Pay {
        upto_chunk: 12,
        token: h.token(4).await,
    };
    assert!(is_rej(&s.pay(&valid).await, &RejCode::Banned));
    assert!(
        !h.claimed_any(&valid.token).await,
        "its payment is not taken"
    );
    for video in [0, 1] {
        assert!(
            is_rej(&e.hello(&h.peer(1), &h.hello_for(video)), &RejCode::Banned),
            "no new session on video {video}"
        );
    }
    // A payment queued behind the one that bans is checked when its turn comes.
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 2);
    let mut second = open(h, &e, 2);
    serve(h, &mut first, 0, 4);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let replay = Pay {
        upto_chunk: 4,
        token: h.reencode(&spent).await,
    };
    let valid = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.hold_swaps();
    let ((r1, r2), ()) = both(both(first.pay(&replay), second.pay(&valid)), async {
        yield_once().await;
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r1, &RejCode::Spent), "{r1:?}");
    assert!(
        is_rej(&r2, &RejCode::Banned),
        "checked when its turn came: {r2:?}"
    );
    assert!(!h.claimed_any(&valid.token).await);
}

/// A new `hello` continues the account: its quote carries the account's position, it
/// never opens a fresh window, and `spent_total` counts the whole account, and only it.
pub async fn a_new_hello_continues_the_account<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let q = s.quote();
    assert_eq!((q.served, q.accepted_upto, q.spent_total), (0, 0, 0));
    assert_eq!(serve(h, &mut s, 0, 4), 4);
    let mut again = open(h, &e, 1);
    let q = again.quote();
    assert_eq!((q.served, q.accepted_upto, q.spent_total), (4, 0, 0));
    assert_eq!(
        serve(h, &mut again, 4, 4),
        0,
        "the unpaid window carries over"
    );
    s.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("paid in the first session");
    assert_eq!(serve(h, &mut again, 4, 4), 4);
    let ack = again
        .pay(&Pay {
            upto_chunk: 8,
            token: h.token(4).await,
        })
        .await
        .expect("paid in the second");
    assert_eq!(ack.spent_total, 8, "spent_total is the account's");
    let q = open(h, &e, 1).quote().clone();
    assert_eq!((q.served, q.accepted_upto, q.spent_total), (8, 8, 8));
    // Positions are per account: paying on one video moves nothing on the other.
    let mut other = open_on(h, &e, 1, 1);
    assert_eq!(serve_on(h, &mut other, 1, 0, 2), 2);
    let ack = other
        .pay(&Pay {
            upto_chunk: 2,
            token: h.token(2).await,
        })
        .await
        .expect("paid on video 1");
    assert_eq!(
        (ack.accepted_upto, ack.spent_total),
        (2, 2),
        "per account, not per peer"
    );
    let q0 = open_on(h, &e, 1, 0).quote().clone();
    let q1 = open_on(h, &e, 1, 1).quote().clone();
    assert_eq!((q0.served, q0.accepted_upto, q0.spent_total), (8, 8, 8));
    assert_eq!((q1.served, q1.accepted_upto, q1.spent_total), (2, 2, 2));
}

/// A session id names one open session: while it is open, neither another peer nor the
/// same one may open it again (`bad-session`).
pub async fn a_session_id_names_one_open_session<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let hello = h.hello();
    let _open = e.hello(&h.peer(1), &hello).expect("the first");
    assert!(is_rej(&e.hello(&h.peer(2), &hello), &RejCode::BadSession));
    assert!(is_rej(&e.hello(&h.peer(1), &hello), &RejCode::BadSession));
}

/// A peer holds at most the cap of sessions open at once, across all its videos; closed
/// ones do not count.
pub async fn open_sessions_are_capped_and_released<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let cap = h.session_cap();
    let held: Vec<Session<H>> = (0..cap).map(|i| open_on(h, &e, 3, (i % 2) as u8)).collect();
    for video in [0, 1] {
        assert!(
            is_rej(
                &e.hello(&h.peer(3), &h.hello_for(video)),
                &RejCode::BadSession
            ),
            "one past the cap of {cap}, counted across videos (video {video})"
        );
    }
    drop(held);
    for play in 0..3 * cap {
        assert!(
            e.hello(&h.peer(3), &h.hello()).is_ok(),
            "closed sessions do not count (play {play})"
        );
    }
}

/// The seeder acknowledges only after the swap: while it is pending, the payment serves
/// nothing more, and nothing is acknowledged.
pub async fn service_waits_for_the_swap<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let mut watch = open(h, &e, 1);
    assert_eq!(serve(h, &mut s, 0, 4), 4);
    h.hold_swaps();
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (ack, ()) = both(s.pay(&pay), async {
        yield_once().await;
        assert_eq!(
            serve(h, &mut watch, 100, 1),
            0,
            "no service while the swap is pending"
        );
        h.release_swaps().await;
    })
    .await;
    assert_eq!(ack.expect("acknowledged after the swap").accepted_upto, 4);
    assert_eq!(serve(h, &mut watch, 200, 10), 4, "then the next window");
}

/// A mint that cannot be reached is `mint-unavailable`: no ban, no credit, no claim.
/// The payer pays again with fresh proofs once the mint is back.
pub async fn a_mint_outage_is_not_a_ban<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    serve(h, &mut s, 0, 4);
    h.mint_outage(true);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    refused(h, &mut s, &pay, &RejCode::MintUnavailable).await;
    assert!(!s.banned(), "an outage is not the payer's fault");
    h.mint_outage(false);
    settles(h, &mut s, 4, 4, 0).await;
    assert!(!s.banned());
    assert_eq!(serve(h, &mut s, 20, 10), 4);
}

/// Every admitted request counts, even for the same file again (a ranged or aborted
/// request): the window is not a count of distinct files.
pub async fn every_request_counts_whole_or_not<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let same = h.chunk(0);
    let admitted = (0..10).filter(|_| s.admit(&same)).count();
    assert_eq!(admitted, 4);
}

/// A session admits only its own video's files, and a seeder refuses a `hello` for a
/// video it does not serve (`unknown-video`).
pub async fn only_the_sessions_video_is_admitted<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    assert!(!s.admit(&h.foreign_chunk()));
    assert!(!s.admit(&h.chunk_of(1, 0)), "another served video's file");
    assert_eq!(serve(h, &mut s, 0, 10), 4);
    assert!(is_rej(
        &e.hello(&h.peer(2), &h.unknown_hello()),
        &RejCode::UnknownVideo
    ));
}

/// A peer that never pays gets exactly `window` chunks.
pub async fn an_unpaid_window_stops_serving<H: Harness>(h: &H) {
    let e = h.engine(1, 8, 1000);
    let mut s = open(h, &e, 1);
    assert_eq!(serve(h, &mut s, 0, 100), 8);
    assert_eq!(serve(h, &mut s, 100, 100), 0);
}

/// The window is the peer's, across all its videos: a second video opens no second one.
pub async fn the_window_spans_a_peers_videos<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut a = open_on(h, &e, 1, 0);
    let mut b = open_on(h, &e, 1, 1);
    assert_eq!(serve_on(h, &mut a, 0, 0, 3), 3);
    assert_eq!(serve_on(h, &mut b, 1, 0, 10), 1, "4 unpaid in all");
}

/// Identities are free, so a global cap bounds unpaid service across all peers and
/// videos. A payment frees its chunks from the cap at once.
pub async fn a_global_cap_bounds_free_service<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 10);
    let served: u64 = (1..=6u8)
        .map(|p| {
            let video = p % 2;
            let mut s = open_on(h, &e, p, video);
            serve_on(h, &mut s, video, 0, 10)
        })
        .sum();
    assert_eq!(served, 10);
    open_on(h, &e, 2, 0)
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("a debtor pays");
    let mut next = open(h, &e, 7);
    assert_eq!(serve(h, &mut next, 0, 10), 4, "its chunks left the cap");
}

/// The global cap holds whatever payments do: a spent token replayed by 50 banned
/// identities, a mint outage, and one peer's large pre-payment all leave total unpaid
/// service at the cap.
pub async fn the_global_cap_holds_whatever_payments_do<H: Harness>(h: &H) {
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let e = h.engine(1, 4, 10);
    let mut served = 0;
    for p in 1..=50u8 {
        let mut s = open(h, &e, p);
        served += serve(h, &mut s, 0, 4);
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.reencode(&spent).await,
            })
            .await;
        assert!(r.is_err(), "a replayed spent token");
    }
    assert_eq!(served, 10, "banned identities' debt still counts");

    let e = h.engine(1, 4, 10);
    h.mint_outage(true);
    let mut served = 0;
    for p in 1..=20u8 {
        let mut s = open(h, &e, p);
        served += serve(h, &mut s, 0, 4);
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            })
            .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable));
    }
    h.mint_outage(false);
    assert_eq!(served, 10, "unconfirmed payments free nothing");

    let e = h.engine(1, 4, 10);
    let mut rich = open(h, &e, 1);
    rich.pay(&Pay {
        upto_chunk: 100,
        token: h.token(100).await,
    })
    .await
    .expect("a large pre-payment");
    let others: u64 = (2..=60u8)
        .map(|p| {
            let mut s = open(h, &e, p);
            serve(h, &mut s, 0, 4)
        })
        .sum();
    assert_eq!(others, 10, "one account's credit offsets no other's debt");
    assert_eq!(serve(h, &mut rich, 0, 200), 100, "and it is served in full");
}

/// A pre-paid chunk is served however full the global cap is.
pub async fn prepaid_chunks_are_served_whatever_the_cap<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut free = open(h, &e, 1);
    assert_eq!(serve(h, &mut free, 0, 4), 4, "the cap is now full");
    let mut payer = open(h, &e, 2);
    payer
        .pay(&Pay {
            upto_chunk: 5,
            token: h.token(5).await,
        })
        .await
        .expect("a pre-payment");
    assert_eq!(serve(h, &mut payer, 0, 10), 5, "exactly what it paid for");
}

/// An unpaid chunk counts toward the global cap for exactly `debt_ttl`, then frees it for
/// new peers. It never frees the debtor's own window.
pub async fn debt_counts_for_exactly_debt_ttl<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut debtor = open(h, &e, 1);
    assert_eq!(serve(h, &mut debtor, 0, 4), 4);
    let mut late = open(h, &e, 2);
    assert_eq!(serve(h, &mut late, 0, 1), 0, "the cap is full");
    h.advance(h.debt_ttl() - Duration::from_secs(1));
    assert_eq!(
        serve(h, &mut late, 0, 1),
        0,
        "still counted a second before debt_ttl"
    );
    h.advance(Duration::from_secs(1));
    assert_eq!(
        serve(h, &mut debtor, 4, 1),
        0,
        "the debtor still owes its window"
    );
    assert_eq!(serve(h, &mut late, 0, 10), 4, "the old debt has aged out");
}

/// Credit on one video covers only that video's chunks.
pub async fn credit_covers_only_its_own_video<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut one = open_on(h, &e, 1, 1);
    one.pay(&Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    })
    .await
    .expect("one chunk of video 1, pre-paid");
    let mut zero = open_on(h, &e, 1, 0);
    assert_eq!(
        serve_on(h, &mut zero, 0, 0, 100),
        4,
        "video 0: its window, no more"
    );
    assert_eq!(
        serve_on(h, &mut one, 1, 0, 100),
        1,
        "video 1: its one covered chunk"
    );
}

/// Each unpaid chunk leaves the global count exactly once, whichever comes first, its
/// payment or its ageing, and a pre-paid chunk never enters it.
pub async fn debt_is_freed_exactly_once<H: Harness>(h: &H) {
    let half = h.debt_ttl() / 2;
    // Paid, then aged, while other debt is live: ageing must not free it again.
    let e = h.engine(1, 4, 4);
    let mut a = open(h, &e, 1);
    assert_eq!(serve(h, &mut a, 0, 4), 4);
    a.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("a pays");
    h.advance(half);
    let mut b = open(h, &e, 2);
    assert_eq!(serve(h, &mut b, 0, 4), 4, "the cap refills");
    h.advance(half);
    assert_eq!(
        serve(h, &mut open(h, &e, 3), 0, 1),
        0,
        "a's paid chunks aged, and b's are still live"
    );
    // Aged, then paid: the payment must not free it again.
    h.advance(half);
    let mut d = open(h, &e, 4);
    assert_eq!(serve(h, &mut d, 0, 4), 4, "b's debt has aged out");
    b.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("b pays late");
    assert_eq!(serve(h, &mut open(h, &e, 5), 0, 1), 0, "d's debt is live");
    // Paid, then aged, with nothing else live: the count cannot go below zero.
    let e = h.engine(1, 4, 4);
    let mut f = open(h, &e, 1);
    serve(h, &mut f, 0, 4);
    f.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("f pays");
    h.advance(h.debt_ttl());
    assert_eq!(
        serve(h, &mut open(h, &e, 2), 0, 10),
        4,
        "nothing is owed: the cap is free"
    );
    // A pre-paid chunk never enters the count.
    let e = h.engine(1, 4, 4);
    let mut p = open(h, &e, 1);
    p.pay(&Pay {
        upto_chunk: 10,
        token: h.token(10).await,
    })
    .await
    .expect("a pre-payment");
    assert_eq!(serve(h, &mut p, 0, 10), 10);
    assert_eq!(
        serve(h, &mut open(h, &e, 2), 0, 10),
        4,
        "pre-paid chunks are not debt"
    );
}

/// Paying ahead extends service by exactly the chunks paid.
pub async fn prepayment_extends_service_exactly<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let ack = s
        .pay(&Pay {
            upto_chunk: 6,
            token: h.token(6).await,
        })
        .await
        .expect("a pre-payment");
    assert_eq!(ack.accepted_upto, 6);
    assert_eq!(serve(h, &mut s, 0, 100), 10);
}

/// One peer's payment credits no other.
pub async fn peers_are_isolated<H: Harness>(h: &H) {
    let e = h.engine(1, 2, 1000);
    let mut a = open(h, &e, 1);
    let mut b = open(h, &e, 2);
    serve(h, &mut a, 0, 2);
    serve(h, &mut b, 0, 2);
    a.pay(&Pay {
        upto_chunk: 2,
        token: h.token(2).await,
    })
    .await
    .expect("a pays");
    assert_eq!(serve(h, &mut a, 2, 1), 1);
    assert_eq!(serve(h, &mut b, 2, 1), 0, "b is still unpaid");
}

/// Two payments for the same range from two sessions of one account, at once: the
/// account takes them one at a time, so one is acknowledged and the other is `stale`,
/// its token unclaimed.
pub async fn one_accounts_payments_are_serialised<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s1 = open(h, &e, 1);
    let mut s2 = open(h, &e, 1);
    serve(h, &mut s1, 0, 4);
    let p1 = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let p2 = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.hold_swaps();
    let ((r1, r2), ()) = both(both(s1.pay(&p1), s2.pay(&p2)), async {
        yield_once().await;
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    let acks: Vec<&Ack> = [&r1, &r2]
        .into_iter()
        .filter_map(|r| r.as_ref().ok())
        .collect();
    assert_eq!(acks.len(), 1, "exactly one is acknowledged: {r1:?} {r2:?}");
    assert_eq!((acks[0].accepted_upto, acks[0].spent_total), (4, 4));
    let (other, token) = if r1.is_ok() { (&r2, &p2) } else { (&r1, &p1) };
    assert!(is_rej(other, &RejCode::Stale), "{other:?}");
    assert!(!h.claimed_any(&token.token).await);
}

/// A `pay` abandoned mid-swap (its connection dropped) is cancel-safe: if its proofs
/// were claimed, the account is credited, and the next quote shows it.
pub async fn a_dropped_pay_is_credited_or_never_claimed<H: Harness>(h: &H) {
    for held in ["the swap", "its response"] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1);
        serve(h, &mut s, 0, 4);
        let pay = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        if held == "the swap" {
            h.hold_swaps();
        } else {
            h.hold_swap_responses();
        }
        poll_once(s.pay(&pay)).await;
        h.release_swaps().await;
        drop(s);
        let q = open(h, &e, 1).quote().clone();
        if h.claimed_any(&pay.token).await {
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "claimed, so credited ({held} held)"
            );
        } else {
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (0, 0),
                "unclaimed, so not credited ({held} held)"
            );
        }
    }
}

/// Admission is atomic: the most sessions one peer may hold, admitting from as many
/// threads at once, get exactly `window` unpaid chunks between them.
pub async fn concurrent_admission_is_atomic<H: Harness + Sync>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let sessions: Vec<Session<H>> = (0..h.session_cap()).map(|_| open(h, &e, 1)).collect();
    let barrier = std::sync::Barrier::new(sessions.len());
    let admitted: u64 = std::thread::scope(|scope| {
        let threads: Vec<_> = sessions
            .into_iter()
            .enumerate()
            .map(|(t, mut s)| {
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    (0..64u16)
                        .filter(|i| s.admit(&h.chunk(t as u16 * 64 + i)))
                        .count() as u64
                })
            })
            .collect();
        threads
            .into_iter()
            .map(|t| t.join().expect("an admitting thread"))
            .sum()
    });
    assert_eq!(admitted, 4);
}

/// A viewer pays for every request it sent and the seeder did not refuse, never ahead of
/// need (except half a window after a refusal), one payment at a time.
pub async fn a_viewer_pays_for_every_request_and_no_more<H: Harness>(h: &H) {
    let e = h.engine(2, 4, 1000);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(2);
    v.quote(s.quote()).expect("an acceptable quote");
    assert!(v.due().await.unwrap().is_none(), "nothing requested yet");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.unwrap().expect("half the window is due");
    assert_eq!(pay.upto_chunk, 2, "never ahead of what was requested");
    v.requested();
    assert!(
        v.due().await.unwrap().is_none(),
        "one payment in flight at a time"
    );
    let ack = s.pay(&pay).await.expect("the viewer paid exactly");
    assert_eq!(ack.spent_total, 4);
    v.ack(&ack).expect("a consistent ack");

    // At a full global cap the seeder refuses every request: none is owed, and the
    // viewer's next payment pays ahead for half a window, no more.
    let e = h.engine(1, 4, 4);
    let mut crowd = open(h, &e, 1);
    serve(h, &mut crowd, 0, 4);
    let mut s = open(h, &e, 2);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for i in 0..4 {
        v.requested();
        assert!(!s.admit(&h.chunk(i)), "the cap is full");
        v.refused();
    }
    assert!(
        v.last_pay().await.unwrap().is_none(),
        "refused requests are not owed"
    );
    let ahead = v.due().await.unwrap().expect("refused, it pays ahead");
    assert_eq!(
        ahead.upto_chunk, 2,
        "half the window, nothing for the refusals"
    );
}

/// A refused request is never owed, even one already paid for, which becomes credit.
pub async fn a_viewer_owes_nothing_for_refused_requests<H: Harness>(h: &H) {
    // A refusal after admissions: the last payment covers exactly what was served.
    let e = h.engine(1, 8, 3);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for i in 0..4 {
        v.requested();
        if !s.admit(&h.chunk(i)) {
            v.refused();
        }
    }
    let tail = pay_the_tail::<H>(&mut s, &mut v)
        .await
        .expect("three chunks are owed");
    assert_eq!((tail.accepted_upto, tail.spent_total), (3, 3));
    drop(s);
    v.end();
    v.quote(open(h, &e, 1).quote())
        .expect("the ledger agrees with the seeder");

    // An ack that overtakes a refusal: the refused chunk was paid for, so it is credit.
    let e = h.engine(1, 8, 3);
    let mut s = open(h, &e, 2);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    let admitted = (0..4)
        .filter(|i| {
            v.requested();
            s.admit(&h.chunk(*i))
        })
        .count();
    assert_eq!(admitted, 3, "the fourth is refused");
    let pay = v.due().await.unwrap().expect("half the window is due");
    assert_eq!(pay.upto_chunk, 4);
    v.ack(&s.pay(&pay).await.expect("accepted")).unwrap();
    v.refused();
    v.requested();
    assert!(s.admit(&h.chunk(3)), "the retry is served from the credit");
    assert!(
        v.last_pay().await.unwrap().is_none(),
        "nothing more is owed"
    );
}

/// A viewer that has streamed 4 chunks and ended its session, and the quote its next
/// session gets.
async fn resumed_viewer<H: Harness>(h: &H) -> (H::Viewer, Quote) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(2);
    v.quote(s.quote()).unwrap();
    stream(h, &mut s, &mut v, 0, 4).await;
    drop(s);
    v.end();
    let q = open(h, &e, 1).quote().clone();
    (v, q)
}

/// A viewer refuses a quote over its cap, one naming no mint it holds, and a second quote
/// in the same session. It refuses, and stops on, a quote whose account position
/// disagrees with its ledger, a lower one on resume included. And it refuses a resumed
/// quote over its cap.
pub async fn a_viewer_refuses_quotes_it_cannot_honour<H: Harness>(h: &H) {
    let fair = open(h, &h.engine(1, 8, 1000), 1).quote().clone();
    let mut v = h.viewer(2);
    let mut dear = fair.clone();
    dear.price_per_chunk = 3;
    assert!(v.quote(&dear).is_err(), "over its price cap");
    let mut elsewhere = fair.clone();
    elsewhere.mints = vec!["https://unknown-mint.example".into()];
    assert!(v.quote(&elsewhere).is_err(), "no mint it holds");
    v.quote(&fair).expect("a fair quote");
    assert!(v.quote(&fair).is_err(), "one quote per session");

    let lies: [fn(&mut Quote); 3] = [
        |q| q.served = 5,
        |q| q.accepted_upto = 5,
        |q| q.spent_total = 5,
    ];
    for lie in lies {
        let mut v = h.viewer(2);
        let mut q = fair.clone();
        lie(&mut q);
        assert!(
            v.quote(&q).is_err(),
            "a quote that disagrees with the ledger"
        );
        assert!(v.stopped());
    }

    let lower: [fn(&mut Quote); 2] = [|q| q.accepted_upto -= 2, |q| q.spent_total -= 2];
    for lie in lower {
        let (mut v, mut q) = resumed_viewer(h).await;
        lie(&mut q);
        assert!(
            v.quote(&q).is_err(),
            "a quote below the ledger is never resynced"
        );
        assert!(v.stopped());
    }
    let (mut v, mut q) = resumed_viewer(h).await;
    q.price_per_chunk = 3;
    assert!(v.quote(&q).is_err(), "over its price cap, on resume too");
}

/// A viewer stops paying a seeder whose `ack` is unsolicited, or does not match the
/// payment's `accepted_upto` or `spent_total`, whether short or inflated.
pub async fn a_viewer_stops_on_a_wrong_or_unsolicited_ack<H: Harness>(h: &H) {
    let mut unsolicited = h.viewer(1);
    unsolicited
        .quote(open(h, &h.engine(1, 2, 1000), 1).quote())
        .unwrap();
    assert!(
        unsolicited
            .ack(&Ack {
                accepted_upto: 0,
                spent_total: 0
            })
            .is_err()
    );
    assert!(unsolicited.stopped());
    let tampers: [fn(&mut Ack); 4] = [
        |a| a.accepted_upto -= 1,
        |a| a.spent_total += 1,
        |a| a.accepted_upto += 1000,
        |a| a.spent_total += 1000,
    ];
    for tamper in tampers {
        let e = h.engine(1, 2, 1000);
        let mut s = open(h, &e, 1);
        let mut v = h.viewer(1);
        v.quote(s.quote()).unwrap();
        assert!(s.admit(&h.chunk(0)));
        v.requested();
        let pay = v.due().await.unwrap().expect("due");
        let mut ack = s.pay(&pay).await.unwrap();
        tamper(&mut ack);
        assert!(v.ack(&ack).is_err());
        assert!(v.stopped());
        v.requested();
        assert!(v.due().await.unwrap().is_none(), "no more payments");
    }
}

/// A viewer reclaims every proof of a refused payment, whatever the code, known or not,
/// so a seeder that refuses and then claims gets nothing. It stops paying that seeder,
/// except after `mint-unavailable`.
pub async fn a_viewer_reclaims_a_refused_payment<H: Harness>(h: &H) {
    let codes = [
        RejCode::Underpaid,
        RejCode::Overpaid,
        RejCode::BadMint,
        RejCode::BadToken,
        RejCode::Spent,
        RejCode::Stale,
        RejCode::Banned,
        RejCode::BadSession,
        RejCode::MintUnavailable,
        RejCode::Other("some-future-code".into()),
    ];
    for code in codes {
        let s = open(h, &h.engine(7, 2, 1000), 1);
        let mut v = h.viewer(7);
        v.quote(s.quote()).unwrap();
        v.requested();
        let pay = v.due().await.unwrap().expect("due");
        v.rej(&Rej {
            code: code.clone(),
            detail: None,
        })
        .await;
        assert!(
            !h.steal(&pay.token).await,
            "every refused proof was taken back ({code:?})"
        );
        assert_eq!(v.stopped(), code != RejCode::MintUnavailable, "{code:?}");
    }
}

/// A viewer waits 120 s for an answer, then reclaims its payment and stops. If the
/// seeder had swapped it and the answer was lost, the viewer stops without paying those
/// chunks again, and nobody is banned.
pub async fn a_viewer_reclaims_an_unanswered_payment<H: Harness>(h: &H) {
    let s = open(h, &h.engine(3, 2, 1000), 1);
    let mut v = h.viewer(3);
    v.quote(s.quote()).unwrap();
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    v.timeout().await;
    assert!(
        !h.claimed_any(&pay.token).await && !v.stopped(),
        "nothing before 120 s"
    );
    h.advance(Duration::from_secs(120));
    v.timeout().await;
    assert!(v.stopped());
    assert!(
        h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
        "the unanswered proofs were taken back"
    );

    let mut s = open(h, &h.engine(1, 2, 1000), 1);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    assert!(s.admit(&h.chunk(0)));
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    let _lost = s.pay(&pay).await.expect("swapped and acknowledged");
    h.advance(Duration::from_secs(120));
    v.timeout().await;
    assert!(v.stopped() && !s.banned());
    assert!(v.last_pay().await.unwrap().is_none(), "not paid twice");
}

/// A seeder that swaps a payment and then refuses it, `mint-unavailable` included, gets
/// that one payment and nothing more: the viewer finds the proofs spent and stops.
pub async fn a_lying_seeder_takes_at_most_one_payment<H: Harness>(h: &H) {
    for code in [RejCode::MintUnavailable, RejCode::Underpaid] {
        let s = open(h, &h.engine(1, 4, 1000), 1);
        let mut v = h.viewer(1);
        v.quote(s.quote()).unwrap();
        for _ in 0..2 {
            v.requested();
        }
        let pay = v.due().await.unwrap().expect("due");
        assert!(h.steal(&pay.token).await, "the seeder swapped it");
        v.rej(&Rej {
            code: code.clone(),
            detail: None,
        })
        .await;
        assert!(v.stopped(), "{code:?} after a swap: the payment is lost");
        v.requested();
        assert!(
            v.due().await.unwrap().is_none() && v.last_pay().await.unwrap().is_none(),
            "never paid again ({code:?})"
        );
    }
}

/// A stopped viewer pays nothing more, at the end of a session included.
pub async fn a_stopped_viewer_pays_nothing<H: Harness>(h: &H) {
    let mut v = h.viewer(1);
    v.quote(open(h, &h.engine(1, 2, 1000), 1).quote()).unwrap();
    assert!(
        v.ack(&Ack {
            accepted_upto: 1,
            spent_total: 1
        })
        .is_err()
    );
    for _ in 0..3 {
        v.requested();
    }
    assert!(v.due().await.unwrap().is_none());
    assert!(v.last_pay().await.unwrap().is_none());
}

/// Stream `n` chunks from file `from` with an honest pair, paying as due. Each answer
/// arrives one request late, as over a real connection: the next request is admitted
/// before the payment is answered.
async fn stream<H: Harness>(h: &H, s: &mut Session<H>, v: &mut H::Viewer, from: u16, n: u16) {
    let mut in_flight: Option<Pay> = None;
    for i in from..from + n {
        assert!(
            s.admit(&h.chunk(i)),
            "an honest viewer never makes the seeder stall (chunk {i})"
        );
        v.requested();
        if let Some(pay) = in_flight.take() {
            let ack = s.pay(&pay).await.expect("honest payments are accepted");
            v.ack(&ack).unwrap();
        }
        in_flight = v.due().await.unwrap();
    }
    if let Some(pay) = in_flight {
        let ack = s.pay(&pay).await.expect("honest payments are accepted");
        v.ack(&ack).unwrap();
    }
}

async fn pay_the_tail<H: Harness>(s: &mut Session<H>, v: &mut H::Viewer) -> Option<Ack> {
    let pay = v.last_pay().await.unwrap()?;
    let ack = s.pay(&pay).await.expect("the tail is paid");
    v.ack(&ack).unwrap();
    Some(ack)
}

/// An honest pair streams a whole video without the seeder ever stalling, and the total
/// paid is exactly chunks × the quoted price, whatever the viewer would pay at most.
pub async fn an_honest_pair_streams_a_whole_video<H: Harness>(h: &H) {
    let (chunks, price) = (101u16, 2);
    let e = h.engine(price, 8, 1000);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(price * 3);
    v.quote(s.quote()).unwrap();
    stream(h, &mut s, &mut v, 0, chunks).await;
    let tail = pay_the_tail::<H>(&mut s, &mut v)
        .await
        .expect("a tail is owed");
    assert_eq!(tail.spent_total, u64::from(chunks) * price);
    assert!(!v.stopped() && !s.banned());
}

/// An honest pair survives a dropped connection with chunks still owed: the next
/// session's quote carries the account's position, the viewer's ledger agrees, and
/// streaming continues with every chunk paid exactly once.
pub async fn an_honest_pair_resumes_after_a_reconnect<H: Harness>(h: &H) {
    let price = 3;
    let e = h.engine(price, 8, 1000);
    let mut v = h.viewer(price);
    let mut s = open(h, &e, 1);
    v.quote(s.quote()).unwrap();
    stream(h, &mut s, &mut v, 0, 10).await;
    drop(s);
    v.end();
    let mut s = open(h, &e, 1);
    v.quote(s.quote())
        .expect("the resumed account agrees with the ledger");
    stream(h, &mut s, &mut v, 10, 11).await;
    let tail = pay_the_tail::<H>(&mut s, &mut v)
        .await
        .expect("a tail is owed");
    assert_eq!(
        tail.spent_total,
        21 * price,
        "every chunk paid exactly once"
    );
    assert!(!v.stopped() && !s.banned());
}

/// A slow mint delays the ack, never races it: the honest pair carries on, and nobody is
/// banned.
pub async fn an_honest_pair_waits_out_a_slow_mint<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.unwrap().expect("due");
    h.hold_swaps();
    let (ack, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    v.ack(&ack.expect("acknowledged once swapped")).unwrap();
    assert!(!v.stopped() && !s.banned());
    stream(h, &mut s, &mut v, 2, 20).await;
}

/// An honest pair rides out a mint outage. The seeder answers `mint-unavailable`; the
/// viewer pays nothing more until its reclaim completes, then pays again with fresh
/// proofs once the mint is back.
pub async fn an_honest_pair_rides_out_a_mint_outage<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    h.mint_outage(true);
    let pay = v.due().await.unwrap().expect("due");
    let rej = s.pay(&pay).await.expect_err("the mint is down");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(!v.stopped() && !s.banned());
    assert!(
        v.due().await.unwrap().is_none(),
        "nothing more until its reclaim completes"
    );
    h.mint_outage(false);
    let again = v.due().await.unwrap().expect("paid again once reclaimed");
    assert_ne!(again.token, pay.token, "with fresh proofs");
    assert!(
        h.claimed_all(&pay.token).await,
        "the first proofs came back"
    );
    v.ack(&s.pay(&again).await.expect("accepted")).unwrap();
    stream(h, &mut s, &mut v, 2, 20).await;
}

/// A connection dropped while a payment's swap is in flight: the seeder's swap completes
/// and is credited, the viewer's next quote settles it, and nobody is banned or pays
/// twice.
pub async fn an_honest_pair_survives_a_dropped_connection<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut s = open(h, &e, 1);
    v.quote(s.quote()).unwrap();
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.unwrap().expect("due");
    h.hold_swaps();
    poll_once(s.pay(&pay)).await;
    drop(s);
    v.end();
    h.release_swaps().await;
    let mut s = open(h, &e, 1);
    v.quote(s.quote())
        .expect("the quote settles the payment as accepted");
    assert!(!s.banned() && !v.stopped());
    stream(h, &mut s, &mut v, 2, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (12, 12),
        "every chunk paid exactly once"
    );
}

/// Free identities filling the global cap cannot lock out a paying watcher. Refused, it
/// pays ahead, and pre-paid chunks are served whatever the cap.
pub async fn a_paying_watcher_gets_through_a_full_cap<H: Harness>(h: &H) {
    let (price, window) = (2, 4);
    let e = h.engine(price, window, 8);
    for p in 10..=11u8 {
        let mut s = open(h, &e, p);
        serve(h, &mut s, 0, 4);
    }
    let mut s = open(h, &e, 1);
    let mut v = h.viewer(price);
    v.quote(s.quote()).unwrap();
    let mut served = 0u64;
    for i in 0..40u16 {
        v.requested();
        if !s.admit(&h.chunk(i)) {
            v.refused();
            let pay = v.due().await.unwrap().expect("refused, it pays ahead");
            v.ack(&s.pay(&pay).await.expect("a pre-payment is accepted"))
                .unwrap();
            v.requested();
            assert!(
                s.admit(&h.chunk(i)),
                "then served from its credit (chunk {i})"
            );
        }
        served += 1;
        if let Some(pay) = v.due().await.unwrap() {
            v.ack(&s.pay(&pay).await.expect("honest payments are accepted"))
                .unwrap();
        }
    }
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).quote().clone();
    assert_eq!(q.served, served);
    assert!(
        q.spent_total >= served * price && q.spent_total <= (served + window) * price,
        "paid for what it got, and at most a window ahead: {q:?}"
    );
}
