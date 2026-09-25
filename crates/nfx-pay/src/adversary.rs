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
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use nfx_proto::pay::{Ack, Pay, Quote, Rej, RejCode};

use crate::session::{BadToken, EngineParams, Harness, SeederEngine, SeederSession, Viewer};

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
            a_seeder_answers_within_its_deadline,
            a_late_outcome_is_credited_never_banned,
            the_deadline_frees_the_account,
            racing_outcomes_settle_once,
            a_mint_outage_is_not_a_ban,
            every_request_counts_whole_or_not,
            only_the_sessions_video_is_admitted,
            an_unpaid_window_stops_serving,
            the_window_is_per_account,
            an_honest_watcher_streams_two_videos_at_once,
            a_global_cap_bounds_free_service,
            the_global_cap_holds_whatever_payments_do,
            prepaid_chunks_are_served_whatever_the_cap,
            debt_counts_for_exactly_debt_ttl,
            only_never_paid_accounts_are_forgotten,
            bans_expire_and_state_stays_bounded,
            bad_configurations_are_refused,
            a_hello_holds_no_state,
            credit_covers_only_its_own_video,
            debt_is_freed_exactly_once,
            prepayment_extends_service_exactly,
            peers_are_isolated,
            one_accounts_payments_are_serialised,
            a_dropped_pay_is_credited_or_never_claimed,
            concurrent_admission_is_atomic,
            a_viewer_pays_for_every_request_and_no_more,
            a_viewer_owes_nothing_for_refused_requests,
            a_viewer_pays_ahead_only_after_a_refusal,
            a_viewer_refuses_quotes_it_cannot_honour,
            a_viewer_stops_on_a_wrong_or_unsolicited_ack,
            a_viewer_reclaims_a_refused_payment,
            a_viewer_reclaims_an_unanswered_payment,
            a_viewer_settles_a_lost_payment_after_180_s,
            a_viewer_settles_only_on_an_exact_match,
            a_lying_seeder_takes_at_most_one_payment,
            a_refusing_seeder_takes_at_most_half_a_window,
            an_unavailable_seeder_gets_three_tries_a_session,
            a_watchers_standing_spans_its_videos,
            a_stopped_viewer_pays_nothing,
            an_honest_pair_streams_a_whole_video,
            an_honest_pair_resumes_after_a_reconnect,
            an_honest_pair_waits_out_a_slow_mint,
            an_honest_pair_rides_out_a_mint_outage,
            an_honest_pair_survives_a_dropped_connection,
            an_honest_pair_survives_a_fast_reconnect,
            an_honest_pair_survives_a_reordered_payment,
            an_honest_pair_survives_a_refused_hello,
            an_honest_pair_survives_a_late_mint,
            a_paying_watcher_gets_through_a_full_cap,
        );
    };
    (@each $h:expr; $($name:ident),* $(,)?) => {
        $(
            #[tokio::test]
            async fn $name() {
                // A deadlocked engine fails here instead of hanging CI.
                tokio::time::timeout(
                    std::time::Duration::from_secs(30),
                    $crate::adversary::$name(&$h),
                )
                .await
                .expect("the scenario hung");
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

/// Poll `f` once, with a waker that does nothing: its output, if it is ready.
fn poll_now<F: Future>(f: Pin<&mut F>) -> Option<F::Output> {
    match f.poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => Some(v),
        Poll::Pending => None,
    }
}

/// `f`, marking `done` when it completes.
async fn marked<F: Future>(f: F, done: &AtomicBool) -> F::Output {
    let out = f.await;
    done.store(true, Ordering::SeqCst);
    out
}

/// Wait until the other future of a [`both`] sets `open`.
async fn until(open: &AtomicBool) {
    poll_fn(|_| {
        if open.load(Ordering::SeqCst) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
}

fn is_set(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

/// A waker that records its wake and passes it on to the task it runs in.
struct OwnWaker {
    woken: AtomicBool,
    outer: Mutex<Option<Waker>>,
}

impl Wake for OwnWaker {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.woken.store(true, Ordering::SeqCst);
        let outer = self
            .outer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(w) = outer {
            w.wake();
        }
    }
}

/// A future polled only when its own waker fires, as on a task of its own: whatever it
/// waits for must wake it.
struct OwnTask<F> {
    f: Pin<Box<F>>,
    waker: Arc<OwnWaker>,
}

fn own_task<F: Future>(f: F) -> OwnTask<F> {
    OwnTask {
        f: Box::pin(f),
        waker: Arc::new(OwnWaker {
            woken: AtomicBool::new(true),
            outer: Mutex::new(None),
        }),
    }
}

impl<F: Future> Future for OwnTask<F> {
    type Output = F::Output;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        *self
            .waker
            .outer
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(cx.waker().clone());
        if !self.waker.woken.swap(false, Ordering::SeqCst) {
            return Poll::Pending;
        }
        let waker = Waker::from(self.waker.clone());
        self.f.as_mut().poll(&mut Context::from_waker(&waker))
    }
}

/// Unparks a thread.
struct Unpark(std::thread::Thread);

impl Wake for Unpark {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// Run `f` to completion on this thread.
fn block_on<F: Future>(f: F) -> F::Output {
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut f = pin!(f);
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::park_timeout(Duration::from_millis(5));
    }
}

const SECOND: Duration = Duration::from_secs(1);

async fn open<H: Harness>(h: &H, e: &H::Engine, peer: u8) -> Session<H> {
    open_on(h, e, peer, 0).await
}

async fn open_on<H: Harness>(h: &H, e: &H::Engine, peer: u8, video: u8) -> Session<H> {
    e.hello(&h.peer(peer), &h.hello_for(video))
        .await
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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

    let mut forger = open(h, &e, 2).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut first = open(h, &e, 1).await;
    serve(h, &mut first, 0, 4);
    first
        .pay(&Pay {
            upto_chunk: 4,
            token: token.clone(),
        })
        .await
        .expect("the first spend");
    let mut second = open(h, &e, 2).await;
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
        let mut s = open(h, &e, peer).await;
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
    let mut s = open(h, &e, 1).await;
    let mut other_video = open_on(h, &e, 1, 1).await;
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
            is_rej(
                &e.hello(&h.peer(1), &h.hello_for(video)).await,
                &RejCode::Banned
            ),
            "no new session on video {video}"
        );
    }
    // A payment queued behind the one that bans is checked when its turn comes.
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 2).await;
    let mut second = open(h, &e, 2).await;
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
    let mut s = open(h, &e, 1).await;
    let q = s.quote();
    assert_eq!((q.served, q.accepted_upto, q.spent_total), (0, 0, 0));
    assert_eq!(serve(h, &mut s, 0, 4), 4);
    let mut again = open(h, &e, 1).await;
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
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!((q.served, q.accepted_upto, q.spent_total), (8, 8, 8));
    // Positions are per account: paying on one video moves nothing on the other.
    let mut other = open_on(h, &e, 1, 1).await;
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
    let q0 = open_on(h, &e, 1, 0).await.quote().clone();
    let q1 = open_on(h, &e, 1, 1).await.quote().clone();
    assert_eq!((q0.served, q0.accepted_upto, q0.spent_total), (8, 8, 8));
    assert_eq!((q1.served, q1.accepted_upto, q1.spent_total), (2, 2, 2));
}

/// A session id names one open session: while it is open, neither another peer nor the
/// same one may open it again (`bad-session`).
pub async fn a_session_id_names_one_open_session<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let hello = h.hello();
    let _open = e.hello(&h.peer(1), &hello).await.expect("the first");
    assert!(is_rej(
        &e.hello(&h.peer(2), &hello).await,
        &RejCode::BadSession
    ));
    assert!(is_rej(
        &e.hello(&h.peer(1), &hello).await,
        &RejCode::BadSession
    ));
    drop(_open);
    drop(
        e.hello(&h.peer(2), &hello)
            .await
            .expect("a closed session's id is free again"),
    );
}

/// A peer holds at most the cap of sessions open at once, across all its videos; closed
/// ones do not count.
pub async fn open_sessions_are_capped_and_released<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let cap = h.session_cap();
    let mut held: Vec<Session<H>> = Vec::new();
    for i in 0..cap {
        held.push(open_on(h, &e, 3, (i % 2) as u8).await);
    }
    for video in [0, 1] {
        assert!(
            is_rej(
                &e.hello(&h.peer(3), &h.hello_for(video)).await,
                &RejCode::BadSession
            ),
            "one past the cap of {cap}, counted across videos (video {video})"
        );
    }
    drop(held);
    for play in 0..3 * cap {
        assert!(
            e.hello(&h.peer(3), &h.hello()).await.is_ok(),
            "closed sessions do not count (play {play})"
        );
    }
}

/// The seeder acknowledges only after the swap: while it is pending, the payment serves
/// nothing more, and nothing is acknowledged. The swap then frees every chunk the payment
/// covers, including those admitted while it was in flight.
pub async fn service_waits_for_the_swap<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut watch = open(h, &e, 1).await;
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

    let e = h.engine(1, 4, 5);
    let mut s = open(h, &e, 1).await;
    let mut side = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut s, 0, 2), 2);
    h.hold_swaps();
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (ack, ()) = both(s.pay(&pay), async {
        yield_once().await;
        assert_eq!(
            serve(h, &mut side, 2, 2),
            2,
            "two more while the swap is in flight"
        );
        h.release_swaps().await;
    })
    .await;
    ack.expect("accepted");
    assert_eq!(
        serve(h, &mut open(h, &e, 2).await, 0, 10),
        4,
        "all four chunks it covers left the cap"
    );
}

/// The seeder answers every `pay` within 60 s of its arrival: the wait for the account's
/// turn, the key fetch and the swap all count. A black-holed mint gets `mint-unavailable`
/// at exactly 60 s, and so does a key fetch it never answers; a payment queued behind a
/// black-holed one is answered 60 s after its own arrival.
pub async fn a_seeder_answers_within_its_deadline<H: Harness>(h: &H) {
    for keys in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let slow = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        h.hold_swaps();
        if keys {
            h.hold_key_fetches();
        }
        let done = AtomicBool::new(false);
        let (r, ()) = both(own_task(marked(s.pay(&slow), &done)), async {
            yield_once().await;
            h.advance(Duration::from_secs(59));
            yield_once().await;
            assert!(!is_set(&done), "still waiting at 59 s (keys held: {keys})");
            h.advance(SECOND);
            yield_once().await;
            assert!(
                is_set(&done),
                "answered at 60 s, on its own task (keys held: {keys})"
            );
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        h.release_swaps().await;
        assert!(!s.banned());
    }

    // Keys that arrive only once the deadline has passed send no swap.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let slow = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.hold_key_fetches();
    let (r, ()) = both(s.pay(&slow), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(
        !h.claimed_any(&slow.token).await,
        "no swap is sent after the deadline"
    );

    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let mut queued = open(h, &e, 1).await;
    serve(h, &mut first, 0, 4);
    let (a, b) = (
        Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        },
        Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        },
    );
    h.hold_swaps();
    let (a_done, b_arrived, b_done) = (
        AtomicBool::new(false),
        AtomicBool::new(false),
        AtomicBool::new(false),
    );
    let ((ra, rb), ()) = both(
        both(marked(first.pay(&a), &a_done), async {
            until(&b_arrived).await;
            marked(queued.pay(&b), &b_done).await
        }),
        async {
            yield_once().await;
            h.advance(Duration::from_secs(30));
            b_arrived.store(true, Ordering::SeqCst);
            yield_once().await;
            h.advance(Duration::from_secs(30));
            yield_once().await;
            assert!(
                is_set(&a_done) && !is_set(&b_done),
                "at 60 s the first is answered, and the second has its turn"
            );
            h.advance(Duration::from_secs(29));
            yield_once().await;
            assert!(!is_set(&b_done), "the second is in time at 89 s");
            h.advance(SECOND);
            yield_once().await;
            assert!(
                is_set(&b_done),
                "the second is answered at 90 s, 60 s after it arrived"
            );
        },
    )
    .await;
    assert!(is_rej(&ra, &RejCode::MintUnavailable), "{ra:?}");
    assert!(is_rej(&rb, &RejCode::MintUnavailable), "{rb:?}");
    h.release_swaps().await;
}

/// A swap abandoned at the deadline is settled when its outcome comes: a claim is
/// credited, and a spent outcome bans nobody, whether or not the `pay` is still awaited
/// (the clock abandons it, not whoever polls). An outcome that came in time is the
/// answer, even when the `pay` is polled only after the deadline.
pub async fn a_late_outcome_is_credited_never_banned<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    let slow = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&slow), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.release_swaps().await;
    assert!(!s.banned());
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the late claim is credited"
    );

    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swaps();
    let dropped = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(s.pay(&dropped)).await;
    h.advance(Duration::from_secs(61));
    assert!(
        h.steal(&dropped.token).await,
        "its watcher takes the proofs back"
    );
    h.release_swaps().await;
    assert!(
        !s.banned(),
        "the late spent of a dropped pay bans nobody: the clock abandoned it"
    );
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (0, 0),
        "and credits nothing"
    );

    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.advance(Duration::from_secs(59));
        h.release_swaps().await;
        h.advance(SECOND);
    })
    .await;
    let ack = r.expect("the outcome came at 59 s: it is the answer");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));

    // A late claim landing while the next payment fetches keys moves the watermark: that
    // payment is checked again as it is sent, and is stale.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    let first = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&first), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    let again = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.hold_key_fetches();
    let (r, ()) = both(s.pay(&again), async {
        yield_once().await;
        h.release_oldest_swap().await;
        h.release_swaps().await;
    })
    .await;
    assert!(
        is_rej(&r, &RejCode::Stale),
        "the late claim covered it: {r:?}"
    );
    assert!(!h.claimed_any(&again.token).await, "and it is not swapped");
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!((q.accepted_upto, q.spent_total), (4, 4));
    // One that covers only part of the next payment's range: that payment is refused by
    // amount as it is sent, never swapped.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    let half = Pay {
        upto_chunk: 2,
        token: h.token(2).await,
    };
    let (r, ()) = both(s.pay(&half), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    let whole = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.hold_key_fetches();
    let (r, ()) = both(s.pay(&whole), async {
        yield_once().await;
        h.release_oldest_swap().await;
        h.release_swaps().await;
    })
    .await;
    assert!(
        is_rej(&r, &RejCode::Overpaid),
        "half of it was credited late: {r:?}"
    );
    assert!(!h.claimed_any(&whole.token).await, "and it is not swapped");
}

/// A turn held past its payment's deadline is taken over, even when nobody awaits that
/// payment: a `hello` waiting behind a dropped, black-holed payment is answered at
/// exactly 60 s, on its own task. When the abandoned payment lands later, it releases
/// nothing it no longer holds. Waiting hellos count toward the session cap.
pub async fn the_deadline_frees_the_account<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swaps();
    let dropped = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(s.pay(&dropped)).await;
    let (peer, hello) = (h.peer(1), h.hello());
    let done = AtomicBool::new(false);
    let (quoted, ()) = both(own_task(marked(e.hello(&peer, &hello), &done)), async {
        yield_once().await;
        h.advance(Duration::from_secs(59));
        yield_once().await;
        assert!(!is_set(&done), "a hello waits for the payment in progress");
        h.advance(SECOND);
        yield_once().await;
        assert!(
            is_set(&done),
            "until its deadline frees the account, at 60 s"
        );
    })
    .await;
    let q = quoted.expect("a hello").quote().clone();
    assert_eq!((q.accepted_upto, q.spent_total), (0, 0));

    assert!(
        h.steal(&dropped.token).await,
        "its watcher takes the proofs back"
    );
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (hello, next_done, hello_done) =
        (h.hello(), AtomicBool::new(false), AtomicBool::new(false));
    let ((paid, late), ()) = both(
        both(
            marked(s.pay(&next), &next_done),
            own_task(marked(e.hello(&peer, &hello), &hello_done)),
        ),
        async {
            yield_once().await;
            h.release_oldest_swap().await;
            yield_once().await;
            assert!(
                !is_set(&hello_done) && !is_set(&next_done),
                "the abandoned payment landed: the turn is still the next payment's"
            );
            h.release_swaps().await;
            yield_once().await;
        },
    )
    .await;
    let ack = paid.expect("the next payment");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    let q = late.expect("a hello").quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the hello's quote shows the payment it waited for"
    );
    assert!(!s.banned(), "the late spent bans nobody");

    // A payment takes over a dead turn too, and its own swap goes through.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 3).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap();
    let dead = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(s.pay(&dead)).await;
    h.advance(Duration::from_secs(60));
    assert!(h.steal(&dead.token).await, "its watcher takes it back");
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("the next payment takes over the dead turn");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    h.release_swaps().await;

    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 2).await;
    serve(h, &mut s, 0, 4);
    h.hold_swaps();
    poll_once(s.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    }))
    .await;
    let peer = h.peer(2);
    let hellos: Vec<_> = (0..h.session_cap()).map(|_| h.hello()).collect();
    let mut waiting = Vec::new();
    for hello in &hellos[1..] {
        let mut w = Box::pin(e.hello(&peer, hello));
        assert!(poll_now(w.as_mut()).is_none(), "it waits for the payment");
        waiting.push(w);
    }
    let mut over = Box::pin(e.hello(&peer, &hellos[0]));
    let refused = poll_now(over.as_mut()).expect("one past the cap is refused at once");
    assert!(
        is_rej(&refused, &RejCode::BadSession),
        "waiting hellos count toward the session cap"
    );
    drop((waiting, over));
    h.release_swaps().await;
    drop(s);
    let mut all = Vec::new();
    for _ in 0..h.session_cap() {
        all.push(
            e.hello(&peer, &h.hello())
                .await
                .expect("hellos dropped while waiting hold no place"),
        );
    }
}

/// Poll `pay` on this thread while one thread releases the held swaps and another moves
/// the clock to the deadline, all at once.
fn race<H: Harness + Sync>(h: &H, s: &mut Session<H>, pay: &Pay) -> Result<Ack, Rej> {
    let barrier = std::sync::Barrier::new(3);
    std::thread::scope(|scope| {
        let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        let mut f = pin!(s.pay(pay));
        if let Poll::Ready(r) = f.as_mut().poll(&mut cx) {
            return r;
        }
        let barrier = &barrier;
        scope.spawn(move || {
            barrier.wait();
            block_on(h.release_swaps());
        });
        scope.spawn(move || {
            barrier.wait();
            h.advance(Duration::from_secs(60));
        });
        barrier.wait();
        loop {
            if let Poll::Ready(r) = f.as_mut().poll(&mut cx) {
                return r;
            }
            std::thread::park_timeout(Duration::from_millis(5));
        }
    })
}

/// A swap's outcome racing the deadline on other threads is settled once, and
/// consistently. In time it is the answer: an ack, or `spent` with a ban. Late the
/// answer is `mint-unavailable`: a claim is still credited, once, and nobody is banned.
pub async fn racing_outcomes_settle_once<H: Harness + Sync>(h: &H) {
    for round in 0..100u32 {
        let spent = round % 2 == 1;
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let pay = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        if spent {
            assert!(h.steal(&pay.token).await, "someone else spent it");
        }
        h.hold_swaps();
        let answer = race(h, &mut s, &pay);
        let banned = s.banned();
        match (&answer, spent) {
            (Ok(ack), false) => assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4)),
            (Err(r), false) => assert_eq!(r.code, RejCode::MintUnavailable, "round {round}"),
            (Err(r), true) if r.code == RejCode::Spent => {
                assert!(banned, "spent in time bans (round {round})");
            }
            (Err(r), true) if r.code == RejCode::MintUnavailable => {
                assert!(!banned, "late, nobody is banned (round {round})");
            }
            _ => panic!("round {round}: {answer:?}"),
        }
        if !banned {
            let q = open(h, &e, 1).await.quote().clone();
            let want = if spent { (0, 0) } else { (4, 4) };
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                want,
                "credited exactly once, if claimed (round {round}): {answer:?}"
            );
        }
    }
}

/// A mint that cannot be reached is `mint-unavailable`: no ban, no credit, no claim.
/// The payer pays again with fresh proofs once the mint is back.
pub async fn a_mint_outage_is_not_a_ban<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
    let same = h.chunk(0);
    let admitted = (0..10).filter(|_| s.admit(&same)).count();
    assert_eq!(admitted, 4);
}

/// A session admits only its own video's files, and a seeder refuses a `hello` for a
/// video it does not serve (`unknown-video`).
pub async fn only_the_sessions_video_is_admitted<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    assert!(!s.admit(&h.foreign_chunk()));
    assert!(!s.admit(&h.chunk_of(1, 0)), "another served video's file");
    assert_eq!(serve(h, &mut s, 0, 10), 4);
    assert!(is_rej(
        &e.hello(&h.peer(2), &h.unknown_hello()).await,
        &RejCode::UnknownVideo
    ));
}

/// A peer that never pays gets exactly `window` chunks.
pub async fn an_unpaid_window_stops_serving<H: Harness>(h: &H) {
    let e = h.engine(1, 8, 1000);
    let mut s = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut s, 0, 100), 8);
    assert_eq!(serve(h, &mut s, 100, 100), 0);
}

/// The window is the account's: each of a peer's videos gets its own.
pub async fn the_window_is_per_account<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut a = open_on(h, &e, 1, 0).await;
    let mut b = open_on(h, &e, 1, 1).await;
    assert_eq!(serve_on(h, &mut a, 0, 0, 10), 4);
    assert_eq!(
        serve_on(h, &mut b, 1, 0, 10),
        4,
        "its own window on the other video"
    );
}

/// An honest watcher streams two videos from one seeder at once, each answer arriving
/// one request late, and neither stalls: each video has its own window, and one payment
/// in flight toward the seeder at a time is enough.
pub async fn an_honest_watcher_streams_two_videos_at_once<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s0 = open_on(h, &e, 1, 0).await;
    let mut s1 = open_on(h, &e, 1, 1).await;
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    let (mut f0, mut f1): (Option<Pay>, Option<Pay>) = (None, None);
    for i in 0..20u16 {
        for (s, v, video, in_flight) in [
            (&mut s0, &mut v0, 0u8, &mut f0),
            (&mut s1, &mut v1, 1u8, &mut f1),
        ] {
            assert!(
                s.admit(&h.chunk_of(video, i)),
                "no stall (video {video}, chunk {i})"
            );
            v.requested();
            if let Some(pay) = in_flight.take() {
                v.ack(&s.pay(&pay).await.expect("accepted")).unwrap();
            }
            *in_flight = v.due().await.unwrap();
        }
    }
    assert!(!v0.stopped() && !v1.stopped());
}

/// Identities are free, so a global cap bounds unpaid service across all peers and
/// videos. A payment frees exactly the chunks it covers, and a peer's videos never share
/// a place in the count.
pub async fn a_global_cap_bounds_free_service<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 10);
    let mut served = 0;
    for p in 1..=6u8 {
        let video = p % 2;
        let mut s = open_on(h, &e, p, video).await;
        served += serve_on(h, &mut s, video, 0, 10);
    }
    assert_eq!(served, 10);
    open_on(h, &e, 2, 0)
        .await
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("a debtor pays");
    let mut next = open(h, &e, 7).await;
    assert_eq!(serve(h, &mut next, 0, 10), 4, "its chunks left the cap");

    // Partial payers: each pays for one of its four chunks; three still count.
    let e = h.engine(1, 4, 10);
    let mut unpaid = 0;
    for p in 1..=20u8 {
        let mut s = open(h, &e, p).await;
        let got = serve(h, &mut s, 0, 4);
        unpaid += got;
        if got > 0 {
            s.pay(&Pay {
                upto_chunk: 1,
                token: h.token(1).await,
            })
            .await
            .expect("pays for one chunk");
            unpaid -= 1;
        }
    }
    assert!(unpaid <= 10, "unpaid service stays under the cap: {unpaid}");

    // Spread over two videos, every chunk counts once.
    let e = h.engine(1, 4, 10);
    let mut served = 0;
    for p in 1..=10u8 {
        for video in [0, 1] {
            let mut s = open_on(h, &e, p, video).await;
            served += serve_on(h, &mut s, video, 0, 4);
        }
    }
    assert_eq!(
        served, 10,
        "a peer's videos do not share chunks in the count"
    );
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
        let mut s = open(h, &e, p).await;
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
        let mut s = open(h, &e, p).await;
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
    let mut rich = open(h, &e, 1).await;
    rich.pay(&Pay {
        upto_chunk: 100,
        token: h.token(100).await,
    })
    .await
    .expect("a large pre-payment");
    let mut others = 0;
    for p in 2..=60u8 {
        let mut s = open(h, &e, p).await;
        others += serve(h, &mut s, 0, 4);
    }
    assert_eq!(others, 10, "one account's credit offsets no other's debt");
    assert_eq!(serve(h, &mut rich, 0, 200), 100, "and it is served in full");
}

/// A pre-paid chunk is served however full the global cap is.
pub async fn prepaid_chunks_are_served_whatever_the_cap<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut free = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut free, 0, 4), 4, "the cap is now full");
    let mut payer = open(h, &e, 2).await;
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
    let mut debtor = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut debtor, 0, 4), 4);
    let mut late = open(h, &e, 2).await;
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

/// A seeder may forget a never-paid account once it has had no open session for
/// `account_ttl`, counted from its last session's close; not a second sooner, never
/// while a session is open, and never an account that has paid.
pub async fn only_never_paid_accounts_are_forgotten<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    for peer in [1, 4] {
        let mut idle = open(h, &e, peer).await;
        assert_eq!(serve(h, &mut idle, 0, 4), 4);
    }
    let mut payer = open(h, &e, 2).await;
    serve(h, &mut payer, 0, 2);
    payer
        .pay(&Pay {
            upto_chunk: 2,
            token: h.token(2).await,
        })
        .await
        .expect("pays");
    drop(payer);
    let mut long = open(h, &e, 3).await;
    let second = open(h, &e, 3).await;
    assert_eq!(serve(h, &mut long, 0, 4), 4);
    drop(second);
    let mut ahead = open(h, &e, 5).await;
    ahead
        .pay(&Pay {
            upto_chunk: 2,
            token: h.token(2).await,
        })
        .await
        .expect("a pre-payment, nothing served");
    drop(ahead);

    h.advance(h.account_ttl() - SECOND);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(q.served, 4, "kept until account_ttl");
    h.advance(SECOND);
    let q = open(h, &e, 4).await.quote().clone();
    assert_eq!(
        (q.served, q.accepted_upto, q.spent_total),
        (0, 0, 0),
        "forgotten at account_ttl"
    );
    let q = open(h, &e, 2).await.quote().clone();
    assert_eq!(
        (q.served, q.accepted_upto, q.spent_total),
        (2, 2, 2),
        "an account that paid is kept"
    );
    let q = open(h, &e, 3).await.quote().clone();
    assert_eq!(
        q.served, 4,
        "an open session keeps its account, whatever other sessions closed"
    );
    let q = open(h, &e, 5).await.quote().clone();
    assert_eq!(
        (q.served, q.accepted_upto, q.spent_total),
        (0, 2, 2),
        "a paid-ahead account never served has paid: it is kept"
    );
    drop(long);

    h.advance(h.account_ttl() - SECOND);
    let q = open(h, &e, 3).await.quote().clone();
    assert_eq!(
        q.served, 4,
        "idle from its last session's close, not its last admission"
    );
}

/// Bans last `ban_ttl`, then expire. A flood of banned free identities leaves nothing
/// behind once its bans have expired, its debt has aged and its never-paid accounts are
/// forgotten.
pub async fn bans_expire_and_state_stays_bounded<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    for p in 1..=50u8 {
        let mut s = open(h, &e, p).await;
        serve(h, &mut s, 0, 4);
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.reencode(&spent).await,
            })
            .await;
        assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    }
    // A payment dropped mid-swap leaves nothing behind once it lands (here spent, so its
    // peer is banned, and the ban expires with the others).
    let mut dropped = open(h, &e, 100).await;
    serve(h, &mut dropped, 0, 4);
    h.hold_swaps();
    let replayed = Pay {
        upto_chunk: 4,
        token: h.reencode(&spent).await,
    };
    poll_once(dropped.pay(&replayed)).await;
    drop(dropped);
    h.release_swaps().await;
    assert!(h.identities_held(&e) >= 50, "fifty bans are held");
    h.advance(h.ban_ttl() - SECOND);
    assert!(
        is_rej(&e.hello(&h.peer(1), &h.hello()).await, &RejCode::Banned),
        "banned until ban_ttl"
    );
    h.advance(SECOND);
    drop(
        e.hello(&h.peer(1), &h.hello())
            .await
            .expect("the ban has expired"),
    );
    let longest = h.ban_ttl().max(h.account_ttl()).max(h.debt_ttl());
    h.advance(longest);
    drop(open(h, &e, 200).await);
    assert_eq!(
        h.identities_held(&e),
        0,
        "nothing is held for the flood any more"
    );

    // A ban that expires forgives no debt.
    let short = h
        .engine_checked(EngineParams {
            price: 1,
            window: 4,
            global_cap: 1000,
            debt_ttl: h.debt_ttl(),
            account_ttl: h.account_ttl(),
            ban_ttl: h.debt_ttl(),
            mints: 1,
            extra_mint: None,
        })
        .expect("ban_ttl may equal debt_ttl");
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let mut s = open(h, &short, 1).await;
    assert_eq!(serve(h, &mut s, 0, 4), 4);
    assert!(
        is_rej(
            &s.pay(&Pay {
                upto_chunk: 4,
                token: spent
            })
            .await,
            &RejCode::Spent
        ),
        "banned"
    );
    drop(s);
    h.advance(h.debt_ttl());
    let mut s = open(h, &short, 1).await;
    assert_eq!(s.quote().served, 4, "the ban is gone, the account is not");
    assert_eq!(serve(h, &mut s, 4, 4), 0, "and its window is still full");
}

/// A seeder refuses to start with a configuration NFX-07 §3 forbids, and starts with one
/// at every edge it allows.
pub async fn bad_configurations_are_refused<H: Harness>(h: &H) {
    let max = (1u64 << 53) - 1;
    let good = EngineParams {
        price: 1,
        window: 4,
        global_cap: 10,
        debt_ttl: h.debt_ttl(),
        account_ttl: h.account_ttl(),
        ban_ttl: h.ban_ttl(),
        mints: 1,
        extra_mint: None,
    };
    let ten_minutes = Duration::from_secs(600);
    let edges = [
        good,
        EngineParams {
            extra_mint: Some("https://mint.example:8443/path"),
            ..good
        },
        EngineParams {
            account_ttl: h.debt_ttl(),
            ban_ttl: h.debt_ttl(),
            ..good
        },
        EngineParams {
            price: max,
            window: 64,
            global_cap: 1_000_000,
            mints: 16,
            ..good
        },
        EngineParams {
            debt_ttl: Duration::from_secs(24 * 3600),
            account_ttl: Duration::from_secs(30 * 24 * 3600),
            ban_ttl: Duration::from_secs(30 * 24 * 3600),
            ..good
        },
        EngineParams {
            window: 2,
            global_cap: 1,
            debt_ttl: ten_minutes,
            account_ttl: ten_minutes,
            ban_ttl: ten_minutes,
            ..good
        },
    ];
    for p in edges {
        assert!(h.engine_checked(p).is_ok(), "accepted: {p:?}");
    }
    let short = h.debt_ttl() - SECOND;
    let bad = [
        EngineParams { price: 0, ..good },
        EngineParams {
            price: max + 1,
            ..good
        },
        EngineParams { window: 1, ..good },
        EngineParams { window: 65, ..good },
        EngineParams {
            global_cap: 0,
            ..good
        },
        EngineParams {
            global_cap: 1_000_001,
            ..good
        },
        EngineParams { mints: 0, ..good },
        EngineParams { mints: 17, ..good },
        EngineParams {
            extra_mint: Some("http://mint.example"),
            ..good
        },
        EngineParams {
            extra_mint: Some("http://127.0.0.1:3338"),
            ..good
        },
        EngineParams {
            debt_ttl: Duration::from_secs(24 * 3600 + 1),
            account_ttl: Duration::from_secs(30 * 24 * 3600),
            ..good
        },
        EngineParams {
            account_ttl: Duration::from_secs(30 * 24 * 3600 + 1),
            ..good
        },
        EngineParams {
            ban_ttl: Duration::from_secs(30 * 24 * 3600 + 1),
            ..good
        },
        EngineParams {
            extra_mint: Some("https://mint example"),
            ..good
        },
        EngineParams {
            debt_ttl: Duration::ZERO,
            ..good
        },
        EngineParams {
            debt_ttl: ten_minutes - SECOND,
            account_ttl: ten_minutes - SECOND,
            ban_ttl: ten_minutes - SECOND,
            ..good
        },
        EngineParams {
            account_ttl: short,
            ..good
        },
        EngineParams {
            ban_ttl: short,
            ..good
        },
    ];
    for p in bad {
        assert!(h.engine_checked(p).is_err(), "refused: {p:?}");
    }
}

/// A `hello` alone leaves no state behind: free identities cost the seeder nothing.
pub async fn a_hello_holds_no_state<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    for p in 0..=255u8 {
        drop(open(h, &e, p).await);
    }
    assert_eq!(
        h.identities_held(&e),
        0,
        "hellos alone leave nothing behind"
    );
    // A hello that waited for a payment, which was then refused, leaves nothing either:
    // a peer with no account is not even banned.
    let e = h.engine(1, 4, 1000);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let (peer, first, second) = (h.peer(1), h.hello(), h.hello());
    let mut s = e.hello(&peer, &first).await.expect("a hello");
    h.hold_swaps();
    let replay = Pay {
        upto_chunk: 4,
        token: h.reencode(&spent).await,
    };
    let ((r, waited), ()) = both(both(s.pay(&replay), e.hello(&peer, &second)), async {
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    drop((s, waited.expect("not banned: it had no account")));
    assert_eq!(
        h.identities_held(&e),
        0,
        "a waited hello and a refused payment leave nothing behind"
    );
    for p in 0..=255u8 {
        let mut s = open(h, &e, p).await;
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.reencode(&spent).await,
            })
            .await;
        assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    }
    assert_eq!(
        h.identities_held(&e),
        0,
        "free identities replaying a spent token leave no bans"
    );
}

/// Credit on one video covers only that video's chunks; each video keeps its own window.
pub async fn credit_covers_only_its_own_video<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut one = open_on(h, &e, 1, 1).await;
    one.pay(&Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    })
    .await
    .expect("one chunk of video 1, pre-paid");
    let mut zero = open_on(h, &e, 1, 0).await;
    assert_eq!(
        serve_on(h, &mut zero, 0, 0, 100),
        4,
        "video 0: its window, no more"
    );
    assert_eq!(
        serve_on(h, &mut one, 1, 0, 100),
        5,
        "video 1: its one covered chunk and its own window"
    );
}

/// Each unpaid chunk leaves the global count exactly once, whichever comes first, its
/// payment or its ageing, and a pre-paid chunk never enters it.
pub async fn debt_is_freed_exactly_once<H: Harness>(h: &H) {
    let half = h.debt_ttl() / 2;
    // Paid, then aged, while other debt is live: ageing must not free it again.
    let e = h.engine(1, 4, 4);
    let mut a = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut a, 0, 4), 4);
    a.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("a pays");
    h.advance(half);
    let mut b = open(h, &e, 2).await;
    assert_eq!(serve(h, &mut b, 0, 4), 4, "the cap refills");
    h.advance(half);
    assert_eq!(
        serve(h, &mut open(h, &e, 3).await, 0, 1),
        0,
        "a's paid chunks aged, and b's are still live"
    );
    // Aged, then paid: the payment must not free it again.
    h.advance(half);
    let mut d = open(h, &e, 4).await;
    assert_eq!(serve(h, &mut d, 0, 4), 4, "b's debt has aged out");
    b.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("b pays late");
    assert_eq!(
        serve(h, &mut open(h, &e, 5).await, 0, 1),
        0,
        "d's debt is live"
    );
    // Paid, then aged, with nothing else live: the count cannot go below zero.
    let e = h.engine(1, 4, 4);
    let mut f = open(h, &e, 1).await;
    serve(h, &mut f, 0, 4);
    f.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("f pays");
    h.advance(h.debt_ttl());
    assert_eq!(
        serve(h, &mut open(h, &e, 2).await, 0, 10),
        4,
        "nothing is owed: the cap is free"
    );
    // A pre-paid chunk never enters the count.
    let e = h.engine(1, 4, 4);
    let mut p = open(h, &e, 1).await;
    p.pay(&Pay {
        upto_chunk: 10,
        token: h.token(10).await,
    })
    .await
    .expect("a pre-payment");
    assert_eq!(serve(h, &mut p, 0, 10), 10);
    assert_eq!(
        serve(h, &mut open(h, &e, 2).await, 0, 10),
        4,
        "pre-paid chunks are not debt"
    );
}

/// Paying ahead extends service by exactly the chunks paid.
pub async fn prepayment_extends_service_exactly<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
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
    let mut a = open(h, &e, 1).await;
    let mut b = open(h, &e, 2).await;
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
    let mut s1 = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
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
        let mut s = open(h, &e, 1).await;
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
        let q = open(h, &e, 1).await.quote().clone();
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
    let mut sessions: Vec<Session<H>> = Vec::new();
    for _ in 0..h.session_cap() {
        sessions.push(open(h, &e, 1).await);
    }
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
    let mut s = open(h, &e, 1).await;
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
    let mut crowd = open(h, &e, 1).await;
    serve(h, &mut crowd, 0, 4);
    let mut s = open(h, &e, 2).await;
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
    let mut s = open(h, &e, 1).await;
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
    v.quote(open(h, &e, 1).await.quote())
        .expect("the ledger agrees with the seeder");

    // An ack that overtakes a refusal: the refused chunk was paid for, so it is credit.
    let e = h.engine(1, 8, 3);
    let mut s = open(h, &e, 2).await;
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

/// A viewer pays ahead only right after a refusal. Once the cap frees it goes back to
/// paying for what it requested, and ends holding no credit.
pub async fn a_viewer_pays_ahead_only_after_a_refusal<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut crowd = open(h, &e, 9).await;
    assert_eq!(serve(h, &mut crowd, 0, 4), 4, "the cap is full");
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    v.requested();
    assert!(!s.admit(&h.chunk(0)));
    v.refused();
    let ahead = v.due().await.unwrap().expect("refused, it pays ahead");
    v.ack(&s.pay(&ahead).await.expect("accepted")).unwrap();
    crowd
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("the crowd pays, and the cap frees");
    stream(h, &mut s, &mut v, 0, 40).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (40, 40),
        "no credit is left over"
    );
}

/// A viewer that has streamed 4 chunks and ended its session, and the quote its next
/// session gets.
async fn resumed_viewer<H: Harness>(h: &H) -> (H::Viewer, Quote) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(2);
    v.quote(s.quote()).unwrap();
    stream(h, &mut s, &mut v, 0, 4).await;
    drop(s);
    v.end();
    let q = open(h, &e, 1).await.quote().clone();
    (v, q)
}

/// A viewer refuses a quote over its cap, one naming no mint it holds, and a second quote
/// in the same session. It refuses, and stops on, a quote whose account position
/// disagrees with its ledger, a lower one on resume included. And it refuses a resumed
/// quote over its cap.
pub async fn a_viewer_refuses_quotes_it_cannot_honour<H: Harness>(h: &H) {
    let fair = open(h, &h.engine(1, 8, 1000), 1).await.quote().clone();
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

    // A window over the viewer's ceiling: one refusal could make it pay ahead half of it.
    let ceiling = h.window_ceiling();
    let mut wide = fair.clone();
    wide.window = ceiling + 1;
    let mut v = h.viewer(2);
    assert!(v.quote(&wide).is_err(), "a window over its ceiling");
    assert!(!v.stopped(), "refused, not stopped");
    wide.window = ceiling;
    v.quote(&wide).expect("a window at its ceiling");
    let (mut v2, mut q) = resumed_viewer(h).await;
    q.window = ceiling + 1;
    assert!(v2.quote(&q).is_err(), "over its ceiling, on resume too");
    v.requested();
    v.refused();
    let ahead = v.due().await.unwrap().expect("refused, it pays ahead");
    assert!(
        ahead.upto_chunk <= ceiling.div_ceil(2),
        "half its ceiling at most: {}",
        ahead.upto_chunk
    );
}

/// A viewer stops paying a seeder whose `ack` is unsolicited, or does not match the
/// payment's `accepted_upto` or `spent_total`, whether short or inflated.
pub async fn a_viewer_stops_on_a_wrong_or_unsolicited_ack<H: Harness>(h: &H) {
    let mut unsolicited = h.viewer(1);
    unsolicited
        .quote(open(h, &h.engine(1, 2, 1000), 1).await.quote())
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
        let mut s = open(h, &e, 1).await;
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
        let s = open(h, &h.engine(7, 2, 1000), 1).await;
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

/// A viewer waits exactly 180 s for an answer on a live connection, then reclaims its
/// payment and stops. If the seeder had swapped it and the answer was lost, the viewer
/// stops without paying those chunks again, and nobody is banned.
pub async fn a_viewer_reclaims_an_unanswered_payment<H: Harness>(h: &H) {
    let s = open(h, &h.engine(3, 2, 1000), 1).await;
    let mut v = h.viewer(3);
    v.quote(s.quote()).unwrap();
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    v.timeout().await;
    h.advance(Duration::from_secs(179));
    v.timeout().await;
    assert!(
        !h.claimed_any(&pay.token).await && !v.stopped(),
        "nothing before 180 s"
    );
    h.advance(Duration::from_secs(1));
    v.timeout().await;
    assert!(v.stopped());
    assert!(
        h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
        "the unanswered proofs were taken back at 180 s"
    );

    let mut s = open(h, &h.engine(1, 2, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    assert!(s.admit(&h.chunk(0)));
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    let _lost = s.pay(&pay).await.expect("swapped and acknowledged");
    h.advance(Duration::from_secs(180));
    v.timeout().await;
    assert!(v.stopped() && !s.banned());
    assert!(v.last_pay().await.unwrap().is_none(), "not paid twice");
}

/// A payment left unsettled by a dropped connection, never seen by the seeder, is
/// reclaimed at 180 s and not before; then the viewer pays again and carries on.
pub async fn a_viewer_settles_a_lost_payment_after_180_s<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let lost = v.due().await.unwrap().expect("due");
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("the seeder never saw it");
    h.advance(Duration::from_secs(179));
    assert!(v.due().await.unwrap().is_none(), "still waiting at 179 s");
    assert!(!h.claimed_any(&lost.token).await, "and not reclaimed");
    h.advance(Duration::from_secs(1));
    let again = v
        .due()
        .await
        .unwrap()
        .expect("reclaimed at 180 s, then paid again");
    assert!(
        h.claimed_all(&lost.token).await,
        "the lost proofs came back"
    );
    v.ack(&s.pay(&again).await.expect("accepted")).unwrap();
    assert!(!v.stopped());
}

/// After a dropped connection, a quote settles the payment in flight only if both its
/// `accepted_upto` and its `spent_total` show it. A quote matching on one alone stops the
/// viewer.
pub async fn a_viewer_settles_only_on_an_exact_match<H: Harness>(h: &H) {
    for lie in ["spent only", "upto only"] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).unwrap();
        for i in 0..2 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        v.due().await.unwrap().expect("due");
        drop(s);
        v.end();
        let mut q = open(h, &e, 1).await.quote().clone();
        if lie == "spent only" {
            q.spent_total = 2;
        } else {
            q.accepted_upto = 2;
        }
        assert!(v.quote(&q).is_err(), "{lie}: not a settlement");
        assert!(v.stopped());
    }

    // The same for a payment awaiting a quote.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    v.requested();
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    assert!(h.steal(&pay.token).await, "the seeder keeps it");
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(v.awaiting_quote());
    drop(s);
    v.end();
    let mut q = open(h, &e, 1).await.quote().clone();
    q.accepted_upto = pay.upto_chunk;
    assert!(
        v.quote(&q).is_err(),
        "accepted_upto alone does not settle a payment awaiting a quote"
    );
    assert!(v.stopped());

    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    v.requested();
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    assert!(h.steal(&pay.token).await, "the seeder keeps it");
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    drop(s);
    v.end();
    let mut q = open(h, &e, 1).await.quote().clone();
    q.spent_total = 2;
    assert!(
        v.quote(&q).is_err(),
        "spent_total alone does not settle a payment awaiting a quote"
    );
    assert!(v.stopped() && v.due().await.unwrap().is_none());
}

/// A seeder that swaps a payment and then refuses it, `mint-unavailable` included, gets
/// that one payment and nothing more: the viewer finds the proofs spent and stops. While
/// its reclaim cannot complete it pays nothing, and a refusal while a payment is in
/// flight sends no second one over it.
pub async fn a_lying_seeder_takes_at_most_one_payment<H: Harness>(h: &H) {
    for code in [RejCode::MintUnavailable, RejCode::Underpaid] {
        let e = h.engine(1, 4, 1000);
        let s = open(h, &e, 1).await;
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
        assert!(v.stopped(), "{code:?} after a swap: nothing more is paid");
        v.requested();
        assert!(
            v.due().await.unwrap().is_none() && v.last_pay().await.unwrap().is_none(),
            "never paid again ({code:?})"
        );
        // A quote that does not show the payment leaves it lost, however honest.
        drop(s);
        v.end();
        v.quote(open(h, &e, 1).await.quote())
            .expect("a quote equal to the ledger");
        v.requested();
        assert!(
            v.stopped() && v.due().await.unwrap().is_none(),
            "still nothing paid: the seeder kept that one payment ({code:?})"
        );
    }

    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for _ in 0..2 {
        v.requested();
    }
    let pay = v.due().await.unwrap().expect("due");
    assert!(h.steal(&pay.token).await, "the seeder swapped it");
    h.mint_outage(true);
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        !v.stopped(),
        "not known lost yet: the reclaim waits for the mint"
    );
    v.requested();
    v.refused();
    assert!(
        v.due().await.unwrap().is_none(),
        "no pay-ahead while a reclaim is incomplete"
    );
    assert!(
        v.last_pay().await.unwrap().is_none(),
        "no payment at session end either"
    );
    h.mint_outage(false);
    assert!(
        v.due().await.unwrap().is_none() && v.stopped(),
        "the retried reclaim finds the proofs spent: lost, and stopped"
    );

    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for _ in 0..2 {
        v.requested();
    }
    v.due().await.unwrap().expect("due");
    v.requested();
    v.refused();
    assert!(
        v.due().await.unwrap().is_none(),
        "one payment in flight at a time, refusal or not"
    );
}

/// A seeder that refuses every request, while acknowledging every payment, gets at most
/// the half window of credit a refusal lets the viewer pay ahead.
pub async fn a_refusing_seeder_takes_at_most_half_a_window<H: Harness>(h: &H) {
    let (price, window) = (3, 4);
    let e = h.engine(price, window, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(price);
    v.quote(s.quote()).unwrap();
    let mut paid = 0;
    for _ in 0..100 {
        v.requested();
        v.refused();
        if let Some(pay) = v.due().await.unwrap() {
            let ack = s.pay(&pay).await.expect("the seeder takes it");
            v.ack(&ack).unwrap();
            paid = ack.spent_total;
        }
    }
    assert_eq!(
        paid,
        window.div_ceil(2) * price,
        "half a window of credit, and no more"
    );
}

/// A seeder that answers every payment `mint-unavailable` without swapping gets three
/// tries a session: each try costs the watcher a reclaim and a new token at the mint, so
/// the budget bounds those costs. A new session's quote starts the count again, and an
/// ack resets it.
pub async fn an_unavailable_seeder_gets_three_tries_a_session<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    let mu = Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    };
    v.requested();
    v.requested();
    let mut tries = 0;
    while let Some(pay) = v.due().await.unwrap() {
        tries += 1;
        assert!(tries <= 3, "more than three tries");
        v.rej(&mu).await;
        assert!(
            h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
            "each one reclaimed"
        );
    }
    assert_eq!(tries, 3, "three tries");
    assert!(!v.stopped(), "not stopped: a new session tries again");
    assert!(v.awaiting_quote(), "and it says a new session is needed");
    v.requested();
    assert!(
        v.last_pay().await.unwrap().is_none(),
        "not even at the session's end"
    );
    drop(s);
    v.end();
    s = open(h, &e, 1).await;
    v.quote(s.quote()).unwrap();
    let pay = v.due().await.unwrap().expect("a new session, a new try");
    v.ack(&s.pay(&pay).await.expect("this time the seeder takes it"))
        .unwrap();
    // Refusals in between reset nothing, and pay-ahead is held to the count too.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    let mut tries = 0;
    for _ in 0..10 {
        v.requested();
        v.refused();
        if v.due().await.unwrap().is_some() {
            tries += 1;
            v.rej(&mu).await;
        }
    }
    assert_eq!(tries, 3, "three tries, refusals or not");

    // The count spans the seeder's videos.
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    v0.requested();
    v0.requested();
    v1.requested();
    v1.requested();
    for on_one in [false, false, true] {
        let v = if on_one { &mut v1 } else { &mut v0 };
        v.due().await.unwrap().expect("a try");
        v.rej(&mu).await;
    }
    assert!(
        v0.due().await.unwrap().is_none() && v1.due().await.unwrap().is_none(),
        "three tries across both videos"
    );

    // An ack resets the count.
    let e = h.engine(1, 8, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    for i in 0..6u16 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    for _ in 0..2 {
        v.due().await.unwrap().expect("a try");
        v.rej(&mu).await;
    }
    let pay = v.due().await.unwrap().expect("a third try");
    v.ack(&s.pay(&pay).await.expect("this one is taken"))
        .unwrap();
    for i in 6..10u16 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    for _ in 0..2 {
        v.due().await.unwrap().expect("tries again after the ack");
        v.rej(&mu).await;
    }
    assert!(
        v.due().await.unwrap().is_some(),
        "the ack reset the count: a third try"
    );
}

/// A watcher's standing with a seeder spans its videos: one payment in flight toward the
/// seeder at a time, a payment lost on one video holds back the others, and so does an
/// incomplete reclaim.
pub async fn a_watchers_standing_spans_its_videos<H: Harness>(h: &H) {
    let mu = Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    };
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    for _ in 0..2 {
        v0.requested();
        v1.requested();
    }
    let p0 = v0.due().await.unwrap().expect("due on video 0");
    assert!(
        v1.due().await.unwrap().is_none(),
        "one payment in flight toward a seeder, across its videos"
    );
    v1.end();
    v1.quote(open_on(h, &e, 1, 1).await.quote()).unwrap();
    assert!(
        v1.due().await.unwrap().is_none() && v1.last_pay().await.unwrap().is_none(),
        "video 1's session ending, or ending again, frees nothing: video 0's is in flight"
    );
    assert!(
        v0.last_pay().await.unwrap().is_none(),
        "nor is anything paid over video 0's own payment"
    );
    assert!(h.steal(&p0.token).await, "the seeder keeps it");
    v0.rej(&mu).await;
    assert!(v0.awaiting_quote() && v1.stopped(), "lost on video 0");
    assert!(
        !v1.awaiting_quote(),
        "it awaits video 0's quote, not video 1's"
    );
    assert!(
        v1.due().await.unwrap().is_none() && v1.last_pay().await.unwrap().is_none(),
        "so nothing is paid on video 1 either"
    );
    v1.end();
    let mut q = open_on(h, &e, 1, 1).await.quote().clone();
    (q.accepted_upto, q.spent_total) = (p0.upto_chunk, 2);
    assert!(
        v1.quote(&q).is_err() && v1.stopped(),
        "video 1's quote cannot settle video 0's payment"
    );

    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    for _ in 0..2 {
        v0.requested();
        v1.requested();
    }
    let p0 = v0.due().await.unwrap().expect("due on video 0");
    h.mint_outage(true);
    v0.rej(&mu).await;
    assert!(
        v1.due().await.unwrap().is_none(),
        "a reclaim incomplete on video 0 holds back video 1"
    );
    h.mint_outage(false);
    v1.due()
        .await
        .unwrap()
        .expect("once it completes, video 1 pays");
    assert!(
        h.claimed_all(&p0.token).await && !h.steal(&p0.token).await,
        "video 0's proofs came back"
    );

    // A payment left unsettled by video 0's closed session is reclaimed after 180 s by
    // whichever video carries on, so video 1 does not wait for ever.
    let e = h.engine(1, 4, 1000);
    let (s0, mut s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    v0.requested();
    v0.requested();
    let unread = v0.due().await.unwrap().expect("due on video 0");
    drop(s0);
    v0.end();
    for i in 0..2 {
        assert!(s1.admit(&h.chunk_of(1, i)));
        v1.requested();
    }
    h.advance(Duration::from_secs(179));
    assert!(
        v1.due().await.unwrap().is_none(),
        "video 0's payment is in flight for 180 s"
    );
    h.advance(SECOND);
    let paid = v1
        .due()
        .await
        .unwrap()
        .expect("then video 1 reclaims it, and pays");
    assert!(
        h.claimed_all(&unread.token).await && !h.steal(&unread.token).await,
        "video 0's unread payment came back"
    );
    v1.ack(&s1.pay(&paid).await.expect("accepted")).unwrap();

    // A reclaim retried from video 1 that finds video 0's proofs spent leaves video 0's
    // payment awaiting video 0's quote, which settles it.
    let e = h.engine(1, 4, 1000);
    let (mut s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    for i in 0..2 {
        assert!(s0.admit(&h.chunk_of(0, i)));
        v0.requested();
    }
    v1.requested();
    let late = v0.due().await.unwrap().expect("due on video 0");
    h.hold_swap_responses();
    let (r, ()) = both(s0.pay(&late), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    let rej = r.expect_err("no answer within 60 s");
    h.mint_outage(true);
    v0.rej(&rej).await;
    h.mint_outage(false);
    h.release_swaps().await;
    assert!(v1.due().await.unwrap().is_none(), "video 1 retries it");
    assert!(
        v0.awaiting_quote() && !v1.awaiting_quote(),
        "found spent: video 0's payment awaits video 0's quote"
    );
    drop(s0);
    v0.end();
    v0.quote(open_on(h, &e, 1, 0).await.quote())
        .expect("the late claim was credited: settled");
    assert!(!v0.stopped() && !v1.stopped());

    // A rej that answers no payment is unsolicited: the watcher stops paying the seeder.
    let e = h.engine(1, 4, 1000);
    let s1 = open_on(h, &e, 1, 1).await;
    let v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v1.quote(s1.quote()).unwrap();
    v1.rej(&mu).await;
    assert!(
        v0.stopped() && v1.stopped(),
        "an unsolicited rej stops the standing"
    );
    // A refused hello on video 1 frees nothing: video 0's closed session's payment keeps
    // the slot, and video 1's quote cannot settle it.
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    v0.requested();
    v0.requested();
    let p0 = v0.due().await.unwrap().expect("due on video 0");
    drop(s0);
    v0.end();
    v1.requested();
    v1.requested();
    v1.hello_refused(&Rej {
        code: RejCode::BadSession,
        detail: None,
    });
    assert!(
        v1.due().await.unwrap().is_none(),
        "a refused hello leaves video 0's payment holding the slot"
    );
    v1.end();
    let mut q = open_on(h, &e, 1, 1).await.quote().clone();
    (q.accepted_upto, q.spent_total) = (p0.upto_chunk, 2);
    assert!(
        v1.quote(&q).is_err() && v1.stopped(),
        "video 1's quote cannot settle video 0's payment"
    );

    // Video 0's payment, read by the seeder only after its session closed, is credited;
    // video 1's catch-up at 180 s finds it spent, and it awaits video 0's quote.
    let e = h.engine(1, 4, 1000);
    let (mut s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).unwrap();
    v1.quote(s1.quote()).unwrap();
    for i in 0..2 {
        assert!(s0.admit(&h.chunk_of(0, i)));
        v0.requested();
    }
    v1.requested();
    let unread = v0.due().await.unwrap().expect("due on video 0");
    v0.end();
    s0.pay(&unread)
        .await
        .expect("the seeder reads it late, and credits it");
    drop(s0);
    h.advance(Duration::from_secs(180));
    assert!(v1.due().await.unwrap().is_none(), "video 1 catches up");
    assert!(
        v0.awaiting_quote() && !v1.awaiting_quote(),
        "found spent: it awaits video 0's quote"
    );
    v0.quote(open_on(h, &e, 1, 0).await.quote())
        .expect("video 0's quote shows it: settled");
    assert!(!v0.stopped() && !v1.stopped());
}

/// A stopped viewer pays nothing more, at the end of a session included.
pub async fn a_stopped_viewer_pays_nothing<H: Harness>(h: &H) {
    let mut v = h.viewer(1);
    v.quote(open(h, &h.engine(1, 2, 1000), 1).await.quote())
        .unwrap();
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
    // Reclaiming is not paying: a stopped viewer still finishes its reclaim.
    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).unwrap();
    v.requested();
    v.requested();
    let pay = v.due().await.unwrap().expect("due");
    h.mint_outage(true);
    v.rej(&Rej {
        code: RejCode::Underpaid,
        detail: None,
    })
    .await;
    assert!(v.stopped());
    h.mint_outage(false);
    assert!(v.due().await.unwrap().is_none(), "it pays nothing");
    assert!(
        h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
        "but it took its proofs back"
    );
}

/// Stream `n` chunks of `video` from file `from` with an honest pair, paying as due. Each
/// answer arrives one request late, as over a real connection: the next request is
/// admitted before the payment is answered.
async fn stream_on<H: Harness>(
    h: &H,
    s: &mut Session<H>,
    v: &mut H::Viewer,
    video: u8,
    from: u16,
    n: u16,
) {
    let mut in_flight: Option<Pay> = None;
    for i in from..from + n {
        assert!(
            s.admit(&h.chunk_of(video, i)),
            "an honest viewer never makes the seeder stall (video {video}, chunk {i})"
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

async fn stream<H: Harness>(h: &H, s: &mut Session<H>, v: &mut H::Viewer, from: u16, n: u16) {
    stream_on(h, s, v, 0, from, n).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).unwrap();
    stream(h, &mut s, &mut v, 0, 10).await;
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
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
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote())
        .expect("the quote settles the payment as accepted");
    assert!(!s.banned() && !v.stopped());
    stream(h, &mut s, &mut v, 2, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (12, 12),
        "every chunk paid exactly once"
    );
}

/// The same, reconnecting before the swap completes: the new `hello` waits for it, so its
/// quote settles the payment at once and streaming carries on without a stall.
pub async fn an_honest_pair_survives_a_fast_reconnect<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut s = open(h, &e, 1).await;
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
    let (mut s, ()) = both(open(h, &e, 1), async {
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    v.quote(s.quote()).expect("the quote shows the payment");
    stream(h, &mut s, &mut v, 2, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (12, 12),
        "every chunk paid exactly once"
    );
    assert!(!v.stopped());
}

/// A payment still buffered on a dropped connection reaches the seeder only after the
/// watcher's new `hello`, so the new quote misses it, and the seeder credits it. The
/// watcher's reclaim at 180 s finds it spent, so it awaits a quote; the next session's
/// quote shows it, and the pair carries on with every chunk paid once.
pub async fn an_honest_pair_survives_a_reordered_payment<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut old = open(h, &e, 1).await;
    v.quote(old.quote()).unwrap();
    for i in 0..2 {
        assert!(old.admit(&h.chunk(i)));
        v.requested();
    }
    let buffered = v.due().await.unwrap().expect("due");
    v.end();
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("the seeder has not read it yet");
    let ack = old
        .pay(&buffered)
        .await
        .expect("the seeder reads it now, and credits it");
    assert_eq!(ack.accepted_upto, 2, "an ack the watcher never sees");
    drop(old);
    for i in 2..4 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
        assert!(
            v.due().await.unwrap().is_none(),
            "nothing more while it is unsettled"
        );
    }
    h.advance(Duration::from_secs(180));
    v.timeout().await;
    assert!(
        !v.stopped(),
        "no payment of this session is unanswered: a timeout changes nothing"
    );
    assert!(v.due().await.unwrap().is_none(), "reclaimed at 180 s");
    assert!(v.awaiting_quote(), "found spent, so it awaits a quote");
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("the quote shows it: settled");
    assert!(!v.stopped() && !s.banned());
    stream(h, &mut s, &mut v, 4, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (14, 14),
        "every chunk paid exactly once"
    );
}

/// The watcher's connection drops with a payment's swap in flight. The seeder has not
/// yet closed the old session, so the reconnect's `hello` is refused `bad-session`. That
/// refusal is not the payment's: the payment stays unsettled, the seeder's swap lands and
/// is credited, nobody is banned, and the next quote settles it.
pub async fn an_honest_pair_survives_a_refused_hello<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).unwrap();
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.unwrap().expect("due");
    h.hold_swaps();
    poll_once(s.pay(&pay)).await;
    v.end();
    let mut others = Vec::new();
    for _ in 1..h.session_cap() {
        others.push(open_on(h, &e, 1, 1).await);
    }
    let refused = e
        .hello(&h.peer(1), &h.hello())
        .await
        .map(|_| ())
        .expect_err("the seeder still counts the old session");
    assert_eq!(refused.code, RejCode::BadSession);
    v.hello_refused(&refused);
    h.release_swaps().await;
    assert!(!s.banned(), "the seeder's swap was not raced by a reclaim");
    drop((s, others));
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote())
        .expect("the quote shows the payment: settled");
    assert!(!v.stopped());
    stream(h, &mut s, &mut v, 2, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (12, 12),
        "every chunk paid exactly once"
    );
    // A hello refused `unknown-video` changes nothing; one refused `banned` stops the
    // watcher.
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    v.hello_refused(&Rej {
        code: RejCode::UnknownVideo,
        detail: None,
    });
    assert!(!v.stopped(), "unknown-video: nothing changes");
    let s = open(h, &e, 1).await;
    v.quote(s.quote()).unwrap();
    v.requested();
    v.requested();
    assert!(v.due().await.unwrap().is_some(), "and it pays as usual");
    let mut banned = h.viewer(1);
    banned.hello_refused(&Rej {
        code: RejCode::Banned,
        detail: None,
    });
    assert!(banned.stopped(), "banned: it stops paying the seeder");

    // A rej on a new session that answers no payment is unsolicited: the watcher stops,
    // and the earlier session's payment is left to its own rules, not reclaimed at once.
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let s = open(h, &e, 1).await;
    v.quote(s.quote()).unwrap();
    v.requested();
    v.requested();
    let earlier = v.due().await.unwrap().expect("due");
    drop(s);
    v.end();
    let s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("the seeder never saw it");
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(v.stopped(), "an unsolicited rej stops the watcher");
    assert!(
        !h.claimed_any(&earlier.token).await,
        "the earlier payment is not reclaimed on its account"
    );
}

/// The mint answers the seeder's swap only after the seeder's deadline. The seeder has
/// answered `mint-unavailable`, and the watcher's reclaim finds the proofs spent, so the
/// payment awaits a quote. A quote taken before the seeder learns the outcome leaves it
/// waiting; once the seeder credits the late claim, the next quote settles it, and the
/// pair carries on.
pub async fn an_honest_pair_survives_a_late_mint<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).unwrap();
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.unwrap().expect("due");
    h.hold_swap_responses();
    let (r, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    let rej = r.expect_err("no answer within 60 s");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(v.awaiting_quote(), "the seeder's swap spent its proofs");
    drop(s);
    v.end();
    let s = open(h, &e, 1).await;
    v.quote(s.quote())
        .expect("the seeder has not heard back yet: an honest quote");
    assert!(
        v.awaiting_quote() && v.due().await.unwrap().is_none(),
        "still waiting, and paying nothing"
    );
    h.release_swaps().await;
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote())
        .expect("the late claim was credited: settled");
    assert!(!v.stopped() && !s.banned());
    stream(h, &mut s, &mut v, 2, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
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
        let mut s = open(h, &e, p).await;
        serve(h, &mut s, 0, 4);
    }
    let mut s = open(h, &e, 1).await;
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
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(q.served, served);
    assert!(
        q.spent_total >= served * price && q.spent_total <= (served + window) * price,
        "paid for what it got, and at most a window ahead: {q:?}"
    );
}
