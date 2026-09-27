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
//!
//! Every check names what it requires: an assertion, or an `expect` whose message says it.
//! A bare `unwrap` names nothing, and its panic is never counted as the suite failing
//! ([`Ran::failed_the_suite`]), so a defect caught only there would survive: they are
//! denied here.
#![deny(clippy::unwrap_used)]

use std::future::{Future, poll_fn};
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use nfx_pay_wire::pay::{Ack, Hello, Pay, Quote, Rej, RejCode};

use crate::session::{
    BadToken, EngineParams, Harness, MintEvent, SeederEngine, SeederSession, Viewer,
};

/// Every scenario, one `#[test]` each, against the harness `$h` builds: each runs on a
/// thread of its own, in a current-thread runtime, and fails if it does not finish within
/// 30 s ([`run_on_a_thread`]).
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
            concurrent_entries_read_two_a_second,
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
            #[test]
            fn $name() {
                match $crate::adversary::run_on_a_thread(30, || {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("a runtime")
                        .block_on(async { $crate::adversary::$name(&$h).await })
                }) {
                    $crate::adversary::Ran::Finished => {}
                    $crate::adversary::Ran::Panicked { payload, .. } => {
                        std::panic::resume_unwind(payload)
                    }
                    $crate::adversary::Ran::Hung => panic!("the scenario hung"),
                }
            }
        )*
    };
}

type Session<H> = <<H as Harness>::Engine as SeederEngine>::Session;

/// How a scenario run by [`run_on_a_thread`] ended.
pub enum Ran {
    /// It returned.
    Finished,
    /// It panicked, at `file`:`line` (where the panic was raised), with `payload`.
    Panicked {
        file: String,
        line: u32,
        payload: Box<dyn std::any::Any + Send>,
    },
    /// It did not finish in time: its thread is left behind, and dies with the process.
    Hung,
}

impl Ran {
    /// Whether it failed a check of the suite: a panic raised in this file, the scenarios'
    /// own, not in the engine, the harness or a runtime, on the scenario's thread or one it
    /// spawned ([`rejoin`]). Only the suite's checks count, and both of these must hold:
    /// - the line it was raised at makes one ([`makes_a_check`]): an assertion, `panic!`,
    ///   `unreachable!` or a named `expect`. So a bare `unwrap`, an index or an overflow at
    ///   any other line counts nowhere;
    /// - it is not a panic Rust raises of its own there (`RUNTIME_PANICS`), nor one that
    ///   names nothing (no message, or `panic!()` and `unreachable!()` bare): a check's line
    ///   can hold those too.
    #[must_use]
    pub fn failed_the_suite(&self) -> bool {
        let Self::Panicked {
            file,
            line,
            payload,
        } = self
        else {
            return false;
        };
        let message = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str));
        file.ends_with("nfx-pay/src/adversary.rs")
            && makes_a_check(include_str!("adversary.rs"), *line)
            && message.is_some_and(|m| {
                !NAMELESS.contains(&m) && !RUNTIME_PANICS.iter().any(|p| m.starts_with(p))
            })
    }
}

/// Whether line `line` (from 1) of the Rust source `source` makes a check in its code: an
/// assertion (`assert!`, `assert_eq!`, `assert_ne!`), `panic!`, `unreachable!`, or a named
/// `expect` or `expect_err`. Its comments, and the text of its string and character
/// literals, are not code: a check named there is not made.
#[must_use]
pub fn makes_a_check(source: &str, line: u32) -> bool {
    const CHECKS: [&str; 7] = [
        "assert!(",
        "assert_eq!(",
        "assert_ne!(",
        "panic!(",
        "unreachable!(",
        ".expect(",
        ".expect_err(",
    ];
    let code = String::from_utf8_lossy(&code_on(source.as_bytes(), line)).into_owned();
    CHECKS.iter().any(|c| code.contains(c))
}

/// Where a scan of Rust source is.
#[derive(Clone, Copy)]
enum Scan {
    Code,
    LineComment,
    /// In a block comment, nested this deep.
    BlockComment(u32),
    Str,
    /// In a raw string closed by a quote and this many `#`s.
    RawStr(usize),
}

/// The code on line `line` (from 1) of the source `s`: its comments left out and its
/// literals emptied, so literals and comments of any line, before it or on it, cannot pass
/// for code.
fn code_on(s: &[u8], line: u32) -> Vec<u8> {
    let is_ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let (mut i, mut at, mut scan, mut code) = (0, 1, Scan::Code, Vec::new());
    while i < s.len() && at <= line {
        let (c, rest) = (s[i], &s[i..]);
        if c == b'\n' {
            at += 1;
            if matches!(scan, Scan::LineComment) {
                scan = Scan::Code;
            }
            i += 1;
            continue;
        }
        match scan {
            Scan::Code if rest.starts_with(b"//") => scan = Scan::LineComment,
            Scan::Code if rest.starts_with(b"/*") => {
                scan = Scan::BlockComment(1);
                i += 1;
            }
            Scan::Code if c == b'"' => scan = Scan::Str,
            Scan::Code if is_ident(c) => {
                // A whole word (a scan in code is always at a word's start): a raw string's
                // prefix, or code.
                let word = rest.iter().take_while(|c| is_ident(**c)).count();
                let hashes = rest[word..].iter().take_while(|c| **c == b'#').count();
                let raw = matches!(&rest[..word], b"r" | b"br" | b"cr")
                    && rest.get(word + hashes) == Some(&b'"');
                if raw {
                    scan = Scan::RawStr(hashes);
                    i += word + hashes;
                } else {
                    if at == line {
                        code.extend_from_slice(&rest[..word]);
                    }
                    i += word - 1;
                }
            }
            Scan::Code if c == b'\'' => match char_literal(rest) {
                Some(len) => i += len - 1,
                None if at == line => code.push(c),
                None => {}
            },
            Scan::Code if at == line => code.push(c),
            Scan::Code | Scan::LineComment => {}
            Scan::BlockComment(depth) if rest.starts_with(b"/*") => {
                scan = Scan::BlockComment(depth + 1);
                i += 1;
            }
            Scan::BlockComment(depth) if rest.starts_with(b"*/") => {
                scan = if depth == 1 {
                    Scan::Code
                } else {
                    Scan::BlockComment(depth - 1)
                };
                i += 1;
            }
            Scan::BlockComment(_) => {}
            Scan::Str if c == b'\\' => {
                // An escape: the next byte is part of it, a line break too.
                if rest.get(1) == Some(&b'\n') {
                    at += 1;
                }
                i += 1;
            }
            Scan::Str if c == b'"' => scan = Scan::Code,
            Scan::Str => {}
            Scan::RawStr(hashes)
                if c == b'"'
                    && rest
                        .get(1..=hashes)
                        .is_some_and(|h| h.iter().all(|c| *c == b'#')) =>
            {
                scan = Scan::Code;
                i += hashes;
            }
            Scan::RawStr(_) => {}
        }
        i += 1;
    }
    code
}

/// How long the character literal is that `rest` starts with, at its quote; `None` if the
/// quote starts a lifetime or a label instead.
fn char_literal(rest: &[u8]) -> Option<usize> {
    let body = &rest[1..];
    let body = &body[..body.iter().position(|c| *c == b'\n').unwrap_or(body.len())];
    if body.first() == Some(&b'\\') {
        // An escape: to the quote after the escaped character.
        return body.iter().skip(2).position(|c| *c == b'\'').map(|p| p + 4);
    }
    let ch = String::from_utf8_lossy(&body[..body.len().min(4)])
        .chars()
        .next()?
        .len_utf8();
    (body.get(ch) == Some(&b'\'')).then_some(ch + 2)
}

/// What `panic!()` and `unreachable!()` say bare: like a panic with no message, they name no
/// behaviour.
const NAMELESS: [&str; 2] = ["explicit panic", "internal error: entered unreachable code"];

/// How the panics start that Rust raises of its own, reported at the line that caused them.
/// They are the second guard of [`Ran::failed_the_suite`]: the line rule is the first.
/// - The compiler's checks: arithmetic that overflows or divides by zero, an index past
///   the end, a finished future polled again.
/// - The standard library's checks that report their caller: a range past the end, a bare
///   `unwrap`, a `RefCell` borrowed twice, a `Vec`, map or `VecDeque` index out of range, a
///   `Duration` divided by zero or out of range, a slice split or copied out of range, a
///   chunk or window size of zero, a logarithm or root out of its domain, `clamp` with its
///   bounds crossed, an `Instant` or `SystemTime` out of range, a `String` cut, edited or
///   emptied at a bad place, a poisoned `Once`, a scoped thread that panicked, an
///   infinite iterator counted, a width or precision past 65535 in a format.
///
/// The list holds every message of the library's `#[track_caller]` functions that safe,
/// stable code can raise, as a scan of rustc 1.98's library source finds them (the crate
/// forbids unsafe code), and three this toolchain raises nowhere a caller's line shows (a
/// string sliced in a constant, `swap_remove`, a coroutine). The suite calls no other
/// crate whose panics report their caller.
const RUNTIME_PANICS: [&str; 45] = [
    "attempt to ",
    "index out of bounds",
    "range start index",
    "range end index",
    "slice index starts at",
    "start byte index",
    "end byte index",
    "byte range starts at",
    "failed to slice string",
    "called `Option::unwrap()`",
    "called `Result::unwrap()`",
    "called `Result::unwrap_err()`",
    "RefCell already",
    "removal index",
    "insertion index",
    "swap_remove index",
    "`at` split index",
    "`async fn` resumed after",
    "coroutine resumed after",
    "no entry found for key",
    "Out of bounds access",
    "divide by zero error when dividing duration",
    "mid > len",
    "copy_from_slice: source slice length",
    "destination and source slices have different lengths",
    "chunk size must be non-zero",
    "window size must be non-zero",
    "argument of integer logarithm must be positive",
    "base of integer logarithm must be at least 2",
    "argument of integer square root cannot be negative",
    "min > max",
    "overflow when adding duration to instant",
    "overflow when subtracting duration from instant",
    "assertion failed: self.is_char_boundary(",
    "Once instance has previously been poisoned",
    "a scoped thread panicked",
    "cannot remove a char from the end of a string",
    "start of range should be a character boundary",
    "end of range should be a character boundary",
    "dest is out of bounds",
    "overflow in `Duration::from_nanos_u128`",
    "overflow when adding duration to `SystemTime`",
    "overflow when subtracting duration from `SystemTime`",
    "iterator is infinite",
    "Formatting argument out of range",
];

std::thread_local! {
    /// Where the last panic on this thread was raised.
    static PANICKED_AT: std::cell::RefCell<Option<(String, u32)>> = const { std::cell::RefCell::new(None) };
}

/// Run `body` on a thread of its own and wait for it in real time, at most `secs`: an engine
/// that blocks its thread (a deadlock) is timed out too, where a runtime's timer could not
/// fire. A panic is reported with where it was raised.
pub fn run_on_a_thread(secs: u64, body: impl FnOnce() + Send + 'static) -> Ran {
    static HOOK: std::sync::Once = std::sync::Once::new();
    HOOK.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let at = info.location().map(|l| (l.file().to_owned(), l.line()));
            PANICKED_AT.with(|p| *p.borrow_mut() = at);
            previous(info);
        }));
    });
    let (done, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(body));
        let at = PANICKED_AT.with(|p| p.borrow_mut().take());
        let _ = done.send((run, at));
    });
    match answer.recv_timeout(Duration::from_secs(secs)) {
        Ok((Ok(()), _)) => Ran::Finished,
        Ok((Err(payload), at)) => {
            let (file, line) = at.unwrap_or_default();
            Ran::Panicked {
                file,
                line,
                payload,
            }
        }
        Err(_) => Ran::Hung,
    }
}

/// A panic on a thread a scenario spawned, kept with where it was raised.
pub struct Raised {
    at: Option<(String, u32)>,
    payload: Box<dyn std::any::Any + Send>,
}

/// Run `body` as the work of a thread a scenario spawned: a panic is kept with where it was
/// raised, for [`rejoin`] to raise again on the scenario's thread, where [`run_on_a_thread`]
/// judges it.
pub fn keep_panic<T>(body: impl FnOnce() -> T) -> Result<T, Raised> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)).map_err(|payload| Raised {
        at: PANICKED_AT.with(|p| p.borrow_mut().take()),
        payload,
    })
}

/// A spawned thread's result, on the scenario's thread: its panic raised again as from where
/// it was first raised (a resumed panic runs no hook, so the place stays as set here). So a
/// panic in the engine on another thread is never taken for the scenario's own, nor a
/// scenario's assertion there for a runtime's.
pub fn rejoin<T>(joined: std::thread::Result<Result<T, Raised>>) -> T {
    match joined {
        Ok(Ok(v)) => v,
        Ok(Err(Raised { at, payload })) => {
            PANICKED_AT.with(|p| *p.borrow_mut() = at);
            std::panic::resume_unwind(payload)
        }
        Err(payload) => {
            PANICKED_AT.with(|p| *p.borrow_mut() = None);
            std::panic::resume_unwind(payload)
        }
    }
}

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

/// A session of `peer` on video 0 after something that must ban nobody: a `hello` refused
/// `banned` fails `why`, not the `expect` of [`open`].
async fn open_unbanned<H: Harness>(h: &H, e: &H::Engine, peer: u8, why: &str) -> Session<H> {
    let r = e.hello(&h.peer(peer), &h.hello()).await;
    assert!(!is_rej(&r, &RejCode::Banned), "{why}");
    r.expect("a hello")
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

/// A payment to `upto` of `amount` claimed at the mint, its answer lost and its retry
/// never reaching the mint: unknown to the seeder, and learnt by the account's next read.
async fn lost_claim<H: Harness>(h: &H, s: &mut Session<H>, upto: u64, amount: u64) -> Pay {
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let p = Pay {
        upto_chunk: upto,
        token: h.token(amount).await,
    };
    let (r, ()) = both(s.pay(&p), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.mint_outage(false);
    assert!(h.claimed_all(&p.token).await, "the mint has the claim");
    p
}

/// A payment to `upto` whose swap the mint holds, its inputs reserved, and the seeder's
/// client timed out: unknown, and undecidable while the mint holds it.
async fn parked<H: Harness>(h: &H, s: &mut Session<H>, upto: u64) -> Pay {
    h.hold_next_swap_reserving();
    h.time_out_next_swap();
    let p = Pay {
        upto_chunk: upto,
        token: h.token(4).await,
    };
    let r = s.pay(&p).await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    p
}

/// Poll `f` until it is ready, moving the clock a second at a time (at most `secs`).
fn settle_on<F: Future, H: Harness>(h: &H, mut f: Pin<&mut F>, secs: u64) -> F::Output {
    for _ in 0..=secs {
        if let Some(v) = (0..1000).find_map(|_| poll_now(f.as_mut())) {
            return v;
        }
        h.advance(SECOND);
    }
    panic!("never answered");
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
    // The mint is checked before the amount: short or over, a foreign token is `bad-mint`.
    for amount in [11, 13] {
        let pay = Pay {
            upto_chunk: 4,
            token: h.token_at("https://other-mint.example", amount).await,
        };
        let r = s.pay(&pay).await;
        assert!(
            is_rej(&r, &RejCode::BadMint),
            "the mint is checked before the amount ({amount}): {r:?}"
        );
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
    // Its structure and its DLEQs are checked before its amount: short or over, each is
    // still `bad-token`.
    for kind in [
        BadToken::WrongUnit,
        BadToken::TwoMints,
        BadToken::TooManyProofs,
        BadToken::Locked,
        BadToken::NoDleq,
        BadToken::BadDleq,
        BadToken::Garbage,
    ] {
        for amount in [11, 13] {
            let pay = Pay {
                upto_chunk: 4,
                token: h.bad_token(kind, amount).await,
            };
            let r = s.pay(&pay).await;
            assert!(
                is_rej(&r, &RejCode::BadToken),
                "{kind:?} is checked before the amount ({amount}): {r:?}"
            );
        }
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

    // Exactly 64 proofs is within the limit.
    let e = h.engine(1, 64, 1000);
    let mut s = open(h, &e, 3).await;
    let mut parts = Vec::new();
    for _ in 0..64 {
        parts.push(h.token(1).await);
    }
    let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
    let token = h.combine(&parts).await;
    settles_pay::<H>(&mut s, 64, token, 64).await;
}

async fn settles_pay<H: Harness>(s: &mut Session<H>, upto: u64, token: String, spent: u64) {
    let ack = s
        .pay(&Pay {
            upto_chunk: upto,
            token,
        })
        .await
        .expect("accepted");
    assert_eq!((ack.accepted_upto, ack.spent_total), (upto, spent));
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
    an_account_spends_at_most_2_53_minus_1(h).await;
    a_product_above_2_53_is_underpaid(h).await;
}

/// A product above 2^53−1 is `underpaid` below 2^64 too, where no multiplication overflows:
/// a token paying it exactly, or more, is refused and nothing is claimed. A product of
/// exactly 2^53−1 is paid.
async fn a_product_above_2_53_is_underpaid<H: Harness>(h: &H) {
    let max = (1u64 << 53) - 1;
    let e = h.engine(1 << 51, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    // Four chunks at 2^51: a product of 2^53.
    for amount in [max + 1, max + 2] {
        let pay = Pay {
            upto_chunk: 4,
            token: h.token(amount).await,
        };
        let r = s.pay(&pay).await;
        assert!(
            is_rej(&r, &RejCode::Underpaid),
            "a product of 2^53 is underpaid, a token of {amount} too: {r:?}"
        );
        assert!(!h.claimed_any(&pay.token).await, "nothing is claimed");
    }
    settles(h, &mut s, 1, 1 << 51, 0).await;

    let e = h.engine(max, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 1);
    let r = s
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(max).await,
        })
        .await;
    assert!(
        matches!(&r, Ok(ack) if (ack.accepted_upto, ack.spent_total) == (1, max)),
        "a product of exactly 2^53-1 is paid: {r:?}"
    );
}

/// An account's `spent_total` is at most 2^53−1, all its `ack` and quote can carry: an
/// exact payment that would take it past is `overpaid`, nothing is claimed and nobody is
/// banned. A stale one is still `stale`, and a short one `underpaid`. The bound is each
/// account's own, across its sessions, and not its peer's.
async fn an_account_spends_at_most_2_53_minus_1<H: Harness>(h: &H) {
    let max = (1u64 << 53) - 1;
    // 2^53-1 is 6361 chunks at this price: each payment's product stays within the bound.
    let price = 1_416_003_655_831;
    let e = h.engine(price, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let ack = s
        .pay(&Pay {
            upto_chunk: 6360,
            token: h.token(6360 * price).await,
        })
        .await
        .expect("a pre-payment of 6360 chunks");
    assert_eq!(ack.spent_total, 6360 * price);
    let r = s
        .pay(&Pay {
            upto_chunk: 6361,
            token: h.token(price).await,
        })
        .await;
    assert!(
        matches!(&r, Ok(ack) if (ack.accepted_upto, ack.spent_total) == (6361, max)),
        "a spent_total of exactly 2^53-1 is acknowledged: {r:?}"
    );
    // The bound is the account's, across its sessions.
    drop(s);
    let mut s = open(h, &e, 1).await;
    let past = Pay {
        upto_chunk: 6362,
        token: h.token(price).await,
    };
    let r = s.pay(&past).await;
    assert!(
        is_rej(&r, &RejCode::Overpaid),
        "an exact payment taking spent_total past 2^53-1 is overpaid: {r:?}"
    );
    assert!(!h.claimed_any(&past.token).await, "nothing is claimed");
    assert!(!s.banned(), "the bound bans nobody");
    let r = s
        .pay(&Pay {
            upto_chunk: 6361,
            token: h.token(price).await,
        })
        .await;
    assert!(
        is_rej(&r, &RejCode::Stale),
        "a stale payment at the bound is stale, checked first: {r:?}"
    );
    let r = s
        .pay(&Pay {
            upto_chunk: 6362,
            token: h.token(price - 1).await,
        })
        .await;
    assert!(
        is_rej(&r, &RejCode::Underpaid),
        "a short payment past the bound is underpaid, the face value checked first: {r:?}"
    );
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (6361, max),
        "the refusals moved nothing"
    );
    let mut other = open_on(h, &e, 1, 1).await;
    let r = other
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(price).await,
        })
        .await;
    assert!(
        matches!(&r, Ok(ack) if (ack.accepted_upto, ack.spent_total) == (1, price)),
        "the bound is each account's own: the peer's other video pays as usual: {r:?}"
    );
}

/// Proofs already spent are `spent` and ban the peer, even re-encoded, and wherever a
/// spent proof sits among fresh ones: first, in the middle or last. The swap is atomic,
/// so the fresh proofs stay unclaimed. A peer with an account on one video is banned for
/// a double-spend on another, where it has none yet. Other peers are unaffected.
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
    let mut paid = open(h, &e, 6).await;
    serve(h, &mut paid, 0, 2);
    paid.pay(&Pay {
        upto_chunk: 2,
        token: h.token(2).await,
    })
    .await
    .expect("an account on video 0");
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let mut elsewhere = open_on(h, &e, 6, 1).await;
    let rej = elsewhere
        .pay(&Pay {
            upto_chunk: 4,
            token: spent,
        })
        .await
        .expect_err("spent, on a video with no account yet");
    assert_eq!(rej.code, RejCode::Spent);
    assert!(
        elsewhere.banned() && paid.banned(),
        "a peer with an account, on another video, is banned"
    );
    // An account it was served on and never paid is an account too.
    let mut unpaid = open(h, &e, 7).await;
    assert_eq!(serve(h, &mut unpaid, 0, 2), 2, "served, never paid");
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let mut elsewhere = open_on(h, &e, 7, 1).await;
    let rej = elsewhere
        .pay(&Pay {
            upto_chunk: 4,
            token: spent,
        })
        .await
        .expect_err("spent");
    assert_eq!(rej.code, RejCode::Spent);
    assert!(
        elsewhere.banned() && unpaid.banned(),
        "an unpaid account is an account"
    );
    assert_eq!(serve(h, &mut unpaid, 2, 2), 0, "and it is served no more");
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

    // A peer whose only account is pre-paid, never served, has an account (created by its
    // first payment), so a double spend bans it.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    s.pay(&Pay {
        upto_chunk: 2,
        token: h.token(2).await,
    })
    .await
    .expect("a pre-payment: the account exists, nothing served");
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let r = s
        .pay(&Pay {
            upto_chunk: 6,
            token: spent,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    assert!(
        s.banned(),
        "a peer whose only account is pre-paid (never served) is banned on a double spend"
    );
}

/// A banned peer gets nothing more: not a pre-paid chunk, not a new session on any
/// video, not a hearing for a valid payment, whose token stays unclaimed. A payment or a
/// `hello` queued behind the one that bans is refused when its turn comes.
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
    // So is a hello waiting behind it.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 3).await;
    serve(h, &mut s, 0, 4);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let replay = Pay {
        upto_chunk: 4,
        token: h.reencode(&spent).await,
    };
    let hello = h.hello();
    h.hold_swaps();
    let ((r, waited), ()) = both(both(s.pay(&replay), e.hello(&h.peer(3), &hello)), async {
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    assert!(
        is_rej(&waited, &RejCode::Banned),
        "the hello that waited behind the ban is refused banned"
    );

    a_banned_peers_requests_count_toward_nothing(h).await;
    a_banned_peers_pay_is_refused_whatever_it_offers(h).await;
    a_turn_taken_over_is_checked_for_the_ban(h).await;
    a_hello_checks_the_ban_as_it_answers(h).await;
    a_banned_peers_hello_is_refused_as_it_arrives(h).await;
    a_banned_peer_is_refused_before_all_else(h).await;
    a_hello_refused_after_its_wait_keeps_nothing(h).await;
    a_waited_hello_is_refused_banned_before_its_id(h).await;
}

/// A banned peer's `hello` is refused `banned`, whatever else it names: a video not served,
/// an open session's id, or one past its session cap. Its request and its payment on a
/// video it has no account on are refused, and create none.
async fn a_banned_peer_is_refused_before_all_else<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let hellos: Vec<Hello> = (0..h.session_cap())
        .map(|n| if n == 0 { h.hello() } else { h.hello_for(1) })
        .collect();
    let mut sessions = Vec::new();
    for hello in &hellos {
        let s = e.hello(&h.peer(1), hello).await;
        sessions.push(s.expect("up to the session cap"));
    }
    assert_eq!(serve(h, &mut sessions[0], 0, 1), 1);
    let spent = h.token(1).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let r = sessions[0]
        .pay(&Pay {
            upto_chunk: 1,
            token: spent,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    let held = h.identities_held(&e);
    for (what, hello) in [
        ("past its session cap", h.hello()),
        ("an open session's id", hellos[1].clone()),
        ("a video not served", h.unknown_hello()),
    ] {
        let r = e.hello(&h.peer(1), &hello).await;
        assert!(
            is_rej(&r, &RejCode::Banned),
            "a banned peer's hello is refused banned, {what}: {:?}",
            r.as_ref().err()
        );
    }
    assert_eq!(
        h.identities_held(&e),
        held,
        "its refused hellos keep nothing"
    );
    let other = &mut sessions[1];
    assert!(
        !other.admit(&h.chunk_of(1, 0)),
        "banned: nothing is admitted"
    );
    assert_eq!(
        h.identities_held(&e),
        held,
        "a banned peer's refused request creates no account on a video it had none on"
    );
    let r = other
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Banned), "{r:?}");
    assert_eq!(
        h.identities_held(&e),
        held,
        "a banned peer's refused payment creates no account on a video it had none on"
    );
    drop(sessions);
    h.advance(h.ban_ttl());
    let r = e.hello(&h.peer(1), &h.unknown_hello()).await;
    assert!(
        is_rej(&r, &RejCode::UnknownVideo),
        "once its ban has expired, its hello for a video not served is refused unknown-video: \
         {:?}",
        r.as_ref().err()
    );
}

/// A `hello` refused `banned` after waiting behind the payment that banned its peer keeps
/// nothing: once the ban has expired, the peer opens its full cap of sessions, one of them
/// under that `hello`'s session id.
async fn a_hello_refused_after_its_wait_keeps_nothing<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 3).await;
    serve(h, &mut s, 0, 4);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let replay = Pay {
        upto_chunk: 4,
        token: spent,
    };
    let hello = h.hello();
    h.hold_swaps();
    let ((r, waited), ()) = both(both(s.pay(&replay), e.hello(&h.peer(3), &hello)), async {
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    assert!(
        is_rej(&waited, &RejCode::Banned),
        "{:?}",
        waited.as_ref().err()
    );
    drop(s);
    h.advance(h.ban_ttl());
    let first = e.hello(&h.peer(3), &hello).await;
    let mut sessions = vec![first.expect("the refused hello's session id is not open")];
    for _ in 1..h.session_cap() {
        let s = e.hello(&h.peer(3), &h.hello()).await;
        sessions.push(s.expect("the refused hello holds no place under the session cap"));
    }
}

/// A `hello` that waited behind the payment that banned its peer is refused `banned`, even
/// when another peer opened its session id meanwhile.
async fn a_waited_hello_is_refused_banned_before_its_id<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 3).await;
    serve(h, &mut s, 0, 4);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let (peer, hello) = (h.peer(3), h.hello());
    h.hold_swaps();
    let replay = Pay {
        upto_chunk: 4,
        token: spent,
    };
    let mut paying = pin!(s.pay(&replay));
    assert!(poll_now(paying.as_mut()).is_none(), "its swap is held");
    let mut waiting = pin!(e.hello(&peer, &hello));
    assert!(
        poll_now(waiting.as_mut()).is_none(),
        "it waits for the payment"
    );
    let holder = e.hello(&h.peer(4), &hello).await;
    let _holder = holder.expect("another peer opens that id meanwhile");
    h.release_swaps().await;
    let r = paying.await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    let r = waiting.await;
    assert!(
        is_rej(&r, &RejCode::Banned),
        "a waited hello is refused banned, though its session id was opened meanwhile: {:?}",
        r.as_ref().err()
    );
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
    let other_video = Hello {
        session: hello.session.clone(),
        ..h.hello_for(1)
    };
    let r = e.hello(&h.peer(1), &other_video).await;
    assert!(
        is_rej(&r, &RejCode::BadSession),
        "an open session's id, on another video too: {:?}",
        r.as_ref().err()
    );
    drop(_open);
    drop(
        e.hello(&h.peer(2), &hello)
            .await
            .expect("a closed session's id is free again"),
    );

    one_session_id_for_two_waiting_hellos(h).await;
    a_hello_refused_bad_session_after_its_wait_keeps_nothing(h).await;
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
/// turn, the key fetch and the swap all count. A payment whose swap is held on its way to
/// the mint gets `mint-unavailable` at exactly 60 s, and so does one whose key request goes
/// unanswered; a payment queued behind a held one is answered 60 s after its own arrival.
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

    // Nor does a payment whose own read runs into its deadline. Its account's swap, A,
    // never reached the mint, and its payer spent the proofs since. The sweep runs during
    // the payment's read: it learns A came to nothing, and completes another account's
    // swap, B, whose request goes unanswered for 60 s. The payment reaches its swap at its
    // deadline, with nothing left unknown.
    let e = h.engine(1, 4, 1000);
    let mut other = open(h, &e, 2).await;
    serve(h, &mut other, 0, 1);
    let b = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&other.pay(&b).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.advance(h.account_ttl()); // B's inputs unspent all that time: it is due a completion
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&a).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    assert!(h.steal(&a.token).await, "A's payer spent its proofs");
    h.unanswered_reads_take(Duration::from_secs(60));
    h.hold_next_swap(); // B's completion
    h.sweep_during_next_read(&e);
    let slow = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let arrived = h.clock_secs();
    let r = s.pay(&slow).await;
    h.unanswered_reads_take(Duration::ZERO);
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(
        !h.claimed_any(&slow.token).await,
        "no swap is sent after the deadline"
    );
    assert_eq!(
        h.clock_secs() - arrived,
        60,
        "the payment's read ran into its deadline"
    );
    h.release_swaps().await;
    let next = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await;
    assert!(
        next.as_ref()
            .is_ok_and(|ack| (ack.accepted_upto, ack.spent_total) == (4, 4)),
        "the payment sent no swap by its deadline, and left nothing unknown: the next is \
         acknowledged: {next:?}"
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
    // The seeder's key requests are held, so nothing is sent: each payment waits on its own
    // deadline, counted from its arrival.
    h.hold_key_fetches();
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

    checks_after_the_deadline_answer_nothing(h).await;
}

/// A swap abandoned at the deadline is settled when its outcome comes: a claim is
/// credited, freeing every chunk it covers from the global count, and a spent outcome
/// bans nobody, whether or not the `pay` is still awaited (the clock abandons it, not
/// whoever polls). An outcome that came in time is the answer, even when the `pay` is
/// polled only after the deadline. A swap whose response is lost is retried in time, and
/// a retry answered `spent` is settled by restore, never banned on; an outcome still
/// unknown is learnt by restore once the mint is back. A restore can show a claim before
/// its answer comes, and the answer then changes nothing. An account's own reads serve
/// only the entries whose swaps they covered, as fixed when sent; none is sent at an
/// entry's deadline; and a `hello` that waited for a payment reads after it. Outputs
/// unsigned with an input spent are nothing, whatever the other inputs are.
pub async fn a_late_outcome_is_credited_never_banned<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let mut other = open(h, &e, 2).await;
    assert_eq!(serve(h, &mut other, 0, 1), 0, "the global cap is full");
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
    h.restore_outage(true);
    assert_eq!(
        serve(h, &mut other, 0, 1),
        0,
        "full until the claim is known: it lands, or a restore shows it"
    );
    h.release_swaps().await;
    h.restore_outage(false);
    assert!(!s.banned());
    assert_eq!(
        serve(h, &mut other, 0, 4),
        4,
        "the late claim freed the four chunks it covers"
    );
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the late claim is credited"
    );
    // A restore shows the claim before its answer comes, here a lost one: it is credited
    // then, and the answer, when it comes, changes nothing.
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
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
    e.sweep().await;
    let mut other = open(h, &e, 2).await;
    assert_eq!(
        serve(h, &mut other, 0, 4),
        4,
        "a restore showed the claim: it freed the four chunks it covers"
    );
    h.release_swaps().await;
    assert!(!s.banned());
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "credited once, not again when its answer comes"
    );
    // Chunks admitted while the swap was in flight are freed by it too.
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    let mut side = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut s, 0, 2), 2);
    h.hold_swap_responses();
    let slow = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&slow), async {
        yield_once().await;
        assert_eq!(
            serve(h, &mut side, 2, 2),
            2,
            "two more while the swap is in flight"
        );
        h.advance(Duration::from_secs(60));
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.release_swaps().await;
    let mut other = open(h, &e, 2).await;
    assert_eq!(
        serve(h, &mut other, 0, 4),
        4,
        "the late claim freed all four chunks it covers"
    );

    // A swap whose response is lost is retried in time. The retry is answered spent, the
    // first attempt having gone through unseen: a restore of its outputs shows that, so
    // the payment is acknowledged, and nobody is banned.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.lose_next_swap_response();
    let unseen = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let ack = s
        .pay(&unseen)
        .await
        .expect("the retry and a restore settle it in time");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    assert!(!s.banned(), "its own swap is no double spend");
    // When the retry cannot reach the mint either, the answer is mint-unavailable. The
    // outcome is learnt by restore once the mint is back, and credited.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let unseen = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&unseen), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(!s.banned());
    h.mint_outage(false);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "restored once the mint is back, and credited"
    );

    // A restore finds its own swap and no other: a token already swapped and acked,
    // replayed for the next range with the answer lost, earns nothing.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let token = h.token(4).await;
    s.pay(&Pay {
        upto_chunk: 4,
        token: token.clone(),
    })
    .await
    .expect("paid");
    serve(h, &mut s, 4, 4);
    h.lose_next_swap_response();
    let r = s
        .pay(&Pay {
            upto_chunk: 8,
            token,
        })
        .await;
    assert!(r.is_err(), "a replayed token earns nothing: {r:?}");
    let q = open_unbanned(h, &e, 1, "a retry's spent bans nobody, a replay's included")
        .await
        .quote()
        .clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "nothing more credited"
    );
    // Nor does a token someone else spent, whose answer is lost: the retry's `spent` is
    // not this swap's, and it bans nobody.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    h.lose_next_swap_response();
    let r = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.reencode(&spent).await,
        })
        .await;
    assert!(
        is_rej(&r, &RejCode::MintUnavailable),
        "never acknowledged: {r:?}"
    );
    assert!(!s.banned(), "a retry's spent is never a ban");
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!((q.accepted_upto, q.spent_total), (0, 0), "nothing credited");

    // An outcome lost after the deadline, or after the `pay` was dropped, is learnt too.
    for dropped in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_swap_responses();
        h.lose_next_swap_response();
        let unseen = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        if dropped {
            poll_once(s.pay(&unseen)).await;
            drop(s);
            h.mint_outage(true);
            h.release_swaps().await;
            h.mint_outage(false);
        } else {
            let (r, ()) = both(s.pay(&unseen), async {
                yield_once().await;
                h.advance(Duration::from_secs(60));
            })
            .await;
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            h.release_swaps().await;
        }
        assert!(h.claimed_all(&unseen.token).await, "the mint processed it");
        let q = open(h, &e, 1).await.quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (4, 4),
            "learnt and credited (dropped: {dropped})"
        );
    }

    // A claim learnt by restore frees the global count, whichever learns it: here the
    // background sweep, with no entry of its own account.
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let mut other = open(h, &e, 2).await;
    assert_eq!(serve(h, &mut other, 0, 1), 0, "the global cap is full");
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let unseen = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&unseen), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.mint_outage(false);
    e.sweep().await;
    assert_eq!(
        serve(h, &mut other, 0, 4),
        4,
        "the restored claim freed the four chunks it covers"
    );

    // While an account's swap has an unknown outcome that cannot be learnt yet, the
    // account's next payment is not swapped: one unknown swap per account at most.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let unseen = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&unseen), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.mint_outage(false);
    h.restore_outage(true);
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    assert!(is_rej(&s.pay(&next).await, &RejCode::MintUnavailable));
    assert!(
        !h.claimed_any(&next.token).await,
        "not swapped while the earlier outcome is unknown"
    );
    // That account alone: another peer, and the same peer on another video, pay as usual.
    let mut other = open(h, &e, 2).await;
    serve(h, &mut other, 0, 4);
    other
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("another peer's payment is swapped");
    let mut elsewhere = open_on(h, &e, 1, 1).await;
    serve_on(h, &mut elsewhere, 1, 0, 4);
    elsewhere
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("so is the same peer's on another video");
    h.restore_outage(false);
    h.advance(SECOND); // not a read made this second, which would be reused
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "learnt once restores are answered"
    );
    // So is a swap in flight past its deadline, for that account alone.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap();
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
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    assert!(is_rej(&s.pay(&next).await, &RejCode::MintUnavailable));
    assert!(
        !h.claimed_any(&next.token).await,
        "not swapped while the earlier swap is in flight"
    );
    let mut other = open(h, &e, 2).await;
    serve(h, &mut other, 0, 4);
    other
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("another peer's payment is swapped");
    let mut elsewhere = open_on(h, &e, 1, 1).await;
    serve_on(h, &mut elsewhere, 1, 0, 4);
    elsewhere
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("so is the same peer's on another video");
    h.release_swaps().await;
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the swap in flight lands, and is credited late"
    );

    // Outputs unsigned with an input spent: the swap can no longer go through, so the
    // outcome is known, and the account pays again. (Its watcher took the proofs back;
    // the answer was lost, and the retry's restore went unanswered.)
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let first = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    assert!(
        h.steal(&first.token).await,
        "its watcher took the proofs back"
    );
    h.restore_outage(true);
    h.lose_next_swap_response();
    assert!(is_rej(&s.pay(&first).await, &RejCode::MintUnavailable));
    h.restore_outage(false);
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let ack = s
        .pay(&next)
        .await
        .expect("known: nothing was claimed, and the next payment is swapped");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    assert!(!s.banned(), "a spent outcome learnt by restore bans nobody");

    // Each undecided swap is decided on its own: in the sweep, another account's swap
    // that stays undecided (its payer never takes the proofs back, and the mint never
    // processes the request) delays no other. Both answers lost; one lost and one in flight; both in
    // flight. The stranger's swap is always the older.
    for case in 0..3 {
        let e = h.engine(1, 4, 1000);
        let mut bad = open(h, &e, 1).await;
        let mut good = open(h, &e, 2).await;
        serve(h, &mut bad, 0, 2);
        serve(h, &mut good, 0, 2);
        let (p, q) = (
            Pay {
                upto_chunk: 2,
                token: h.token(2).await,
            },
            Pay {
                upto_chunk: 2,
                token: h.token(2).await,
            },
        );
        if case == 2 {
            h.hold_next_swap();
            poll_once(bad.pay(&p)).await;
        } else {
            h.time_out_next_swap();
            h.mint_outage(true);
            assert!(is_rej(&bad.pay(&p).await, &RejCode::MintUnavailable));
            h.mint_outage(false);
        }
        if case == 0 {
            h.time_out_next_swap();
            h.mint_outage(true);
            assert!(is_rej(&good.pay(&q).await, &RejCode::MintUnavailable));
            h.mint_outage(false);
        } else {
            h.hold_next_swap();
            let (r, ()) = both(good.pay(&q), async {
                yield_once().await;
                h.advance(Duration::from_secs(60));
            })
            .await;
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        }
        assert!(
            h.steal(&q.token).await,
            "the honest watcher takes its proofs back"
        );
        e.sweep().await;
        let before = h.state_reads();
        let ack = good
            .pay(&Pay {
                upto_chunk: 2,
                token: h.token(2).await,
            })
            .await
            .expect("its own swap is decided: it pays again at once");
        assert_eq!((ack.accepted_upto, ack.spent_total), (2, 2), "case {case}");
        assert_eq!(
            h.state_reads(),
            before,
            "the sweep had decided it already (case {case})"
        );
        h.release_swaps().await;
    }

    // A retry whose outputs the mint refuses for good (its keyset rotated out after the
    // first attempt) is settled by a restore: the first attempt went through.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let rotated = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&rotated), async {
        yield_once().await;
        h.rotate_keyset();
        h.release_swaps().await;
    })
    .await;
    let ack = r.expect("a restore shows the first attempt's claim");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));

    // A retry refused for good whose restore goes unanswered leaves the outcome unknown:
    // the first attempt's claim is learnt once restores answer.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&p), async {
        yield_once().await;
        h.rotate_keyset();
        h.restore_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.restore_outage(false);
    h.advance(SECOND);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "learnt, and credited"
    );
    // A retry refused for good when the first attempt never went through (the mint rolled
    // it back): nothing, and no credit.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap_reserving();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&p), async {
        yield_once().await;
        h.rotate_keyset();
        h.roll_back_reserved();
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(!h.claimed_any(&p.token).await, "nothing was claimed");
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (0, 0),
        "and nothing credited"
    );
    // A retry that gets no answer either leaves the outcome unknown: learnt later.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&p), async {
        yield_once().await;
        h.lose_next_swap_response();
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.advance(SECOND);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "learnt, and credited"
    );
    // A first attempt the mint refuses because the seeder derived its outputs from a
    // keyset since rotated out (its own stale keys): `mint-unavailable`, never a ban, and
    // nothing left unknown, so the next payment is swapped at once.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.before_next_swap(MintEvent::RotateKeyset);
    let r = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(!s.banned(), "the seeder's own keyset error bans nobody");
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("nothing is left unknown: the next payment is swapped");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));

    // A first attempt refused because a keyset expired (CDK 12003): the payer's inputs'
    // or the seeder's own outputs', which the answer does not say. `mint-unavailable`,
    // never a ban, and nothing left unknown: the next payment is swapped at once.
    for event in [MintEvent::ExpireInputKeyset, MintEvent::ExpireKeyset] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let expired = h.token(4).await;
        h.before_next_swap(event);
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: expired,
            })
            .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        assert!(!s.banned(), "an expired keyset bans nobody ({event:?})");
        let ack = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            })
            .await
            .expect("nothing is left unknown: the next payment is swapped");
        assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    }
    // A retry refused because the payer's keyset expired: the first attempt, its inputs
    // reserved by the mint before the expiry, may still sign. While an input is pending the
    // outcome stays unknown; once the mint finishes that request, the claim is learnt and
    // credited. So too when the NUT-07 check goes unanswered: no input is shown not
    // pending, and nothing is settled.
    for state_down in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_next_swap_reserving();
        h.time_out_next_swap();
        h.before_next_swap(MintEvent::ExpireInputKeysetOnceReserved);
        h.state_check_outage(state_down);
        let reserved = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let r = s.pay(&reserved).await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        assert!(!s.banned(), "an expired keyset bans nobody");
        h.state_check_outage(false);
        h.release_swaps().await;
        assert!(
            h.claimed_all(&reserved.token).await,
            "the reserved request signed"
        );
        h.advance(SECOND);
        let q = open(h, &e, 1).await.quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (4, 4),
            "learnt once the mint finished it, and credited (NUT-07 down {state_down})"
        );
    }
    // The mint's own keyset expiring while it holds the first request reserved: that
    // request cannot sign now (its outputs' keyset expired too). Its inputs read unspent
    // again, so it is completed after `account_ttl`, like any undecided swap: the
    // completion is refused, a restore shows nothing, and the account pays again.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap_reserving();
    h.time_out_next_swap();
    h.before_next_swap(MintEvent::ExpireKeyset);
    let reserved = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let r = s.pay(&reserved).await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.release_swaps().await;
    assert!(!h.claimed_any(&reserved.token).await, "it could not sign");
    h.advance(h.account_ttl());
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("completed as nothing: the account pays again");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    // A claim not learnt before its outputs' keyset expires can no longer be proven: a
    // restore does not show an expired keyset's outputs, and spent inputs may as well be
    // the payer's own reclaim or a double spend. The seeder credits nothing (its expired
    // outputs are worth nothing to it either), bans nobody, and leaves nothing unknown: the
    // account pays again. So for a retry refused because the mint's keyset expired after
    // the first attempt went through, and through the late read when the mint was down for
    // the retry and the keyset expired meanwhile.
    for late in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_swap_responses();
        h.lose_next_swap_response();
        let first = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (r, ()) = both(s.pay(&first), async {
            yield_once().await;
            if late {
                h.mint_outage(true);
            } else {
                h.before_next_swap(MintEvent::ExpireKeyset);
            }
            h.release_swaps().await;
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        if late {
            h.expire_keyset();
            h.mint_outage(false);
        }
        h.advance(SECOND);
        let mut again = open_unbanned(h, &e, 1, &format!("nor anyone banned (late {late})")).await;
        let q = again.quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (0, 0),
            "an unprovable claim is not credited (late {late})"
        );
        assert!(!again.banned(), "nor anyone banned (late {late})");
        let ack = again
            .pay(&Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            })
            .await
            .expect("nothing is left unknown: the account pays again");
        assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    }
    // Which keeps the loss bound when the payer spends its proofs elsewhere while the
    // seeder cannot read, and the keyset expires before it can: a pre-payment of 32 chunks
    // earns nothing, and the account is served one window.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let prepaid = Pay {
        upto_chunk: 32,
        token: h.token(32).await,
    };
    h.hold_next_swap();
    let (r, ()) = both(s.pay(&prepaid), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
        yield_once().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.restore_outage(true);
    h.state_check_outage(true);
    assert!(
        h.steal(&prepaid.token).await,
        "the payer spends its proofs elsewhere"
    );
    e.sweep().await;
    h.advance(h.account_ttl() * 2);
    h.expire_keyset();
    h.restore_outage(false);
    h.state_check_outage(false);
    e.sweep().await;
    h.advance(SECOND);
    let mut s = open(h, &e, 1).await;
    let q = s.quote().clone();
    assert_eq!(
        (q.accepted_upto, serve(h, &mut s, 0, 40)),
        (0, 4),
        "a double-spent pre-payment earns nothing: one window served"
    );
    h.release_swaps().await;
    // With the payer's keyset expired instead, the outputs' is current: the restore shows
    // the first attempt's claim, and the payment is acknowledged in time.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let first = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&first), async {
        yield_once().await;
        h.before_next_swap(MintEvent::ExpireInputKeyset);
        h.release_swaps().await;
    })
    .await;
    let ack = r.expect("a restore shows the claim");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    // Its restore unanswered, the outcome stays unknown, and is learnt once restores
    // answer.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let first = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&first), async {
        yield_once().await;
        h.before_next_swap(MintEvent::ExpireInputKeyset);
        h.restore_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.restore_outage(false);
    h.advance(SECOND);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "learnt once restores answer, and credited"
    );

    // A retry refused as invalid (the first attempt's answer lost): validity is the proofs'
    // own, so the first attempt was refused the same way. `bad-token`, and a ban, as for a
    // first attempt.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.lose_next_swap_response();
    let r = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.bad_token(BadToken::Forged, 4).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::BadToken), "{r:?}");
    assert!(s.banned(), "as a first attempt refused so is");

    // Two learners at once (the sweep, run during another's read) credit a claim once.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.restore_outage(true);
    h.lose_next_swap_response();
    let unseen = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    assert!(is_rej(&s.pay(&unseen).await, &RejCode::MintUnavailable));
    h.restore_outage(false);
    h.sweep_during_next_read(&e);
    e.sweep().await;
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "credited once, by one of them"
    );

    // An answer that lands while the seeder reads the swap's state has settled it: the
    // read's decision, coming back after, credits nothing more.
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
    h.deliver_responses_mid_read();
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "credited once, by its answer"
    );
    h.release_swaps().await;

    // A first attempt refused because another request holds its inputs (pending) did
    // nothing: `mint-unavailable`, and never a ban. Here the same token pays on two
    // accounts while the mint holds the first, reserved.
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let mut second = open_on(h, &e, 1, 1).await;
    serve(h, &mut first, 0, 4);
    serve_on(h, &mut second, 1, 0, 4);
    let token = h.token(4).await;
    h.hold_next_swap_reserving();
    poll_once(first.pay(&Pay {
        upto_chunk: 4,
        token: token.clone(),
    }))
    .await;
    let r = second
        .pay(&Pay {
            upto_chunk: 4,
            token: h.reencode(&token).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(!second.banned(), "refused as pending: nobody is banned");
    let ack = second
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("it left nothing unknown: the next payment is swapped at once");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    h.release_swaps().await;
    let q = open_on(h, &e, 1, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the refused one credits nothing"
    );
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the first is credited"
    );

    // A request processed between the seeder's two reads of it: the inputs are read
    // first, so the restore that follows shows the claim.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&pay).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.process_timed_out_mid_read();
    let q = open(h, &e, 1).await.quote().clone();
    assert!(
        h.claimed_all(&pay.token).await,
        "processed between the two reads"
    );
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the claim is credited"
    );

    // A late claim is credited, freeing the global count, though its peer has been
    // banned since on another account.
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap();
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
    let mut elsewhere = open_on(h, &e, 1, 1).await;
    let spent = h.token(2).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let r = elsewhere
        .pay(&Pay {
            upto_chunk: 2,
            token: h.reencode(&spent).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent) && elsewhere.banned(), "{r:?}");
    h.release_swaps().await;
    assert!(
        h.claimed_all(&slow.token).await,
        "the seeder has the proofs"
    );
    let mut other = open(h, &e, 2).await;
    assert_eq!(
        serve(h, &mut other, 0, 4),
        4,
        "the late claim freed the four chunks it covers"
    );

    // A retry answered `spent` whose restore goes unanswered leaves the outcome unknown,
    // to be learnt; an honest watcher's next quote then settles the payment.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.restore_outage(true);
    h.lose_next_swap_response();
    let r = s.pay(&pay).await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(!s.banned());
    v.rej(&r.expect_err("mint-unavailable")).await;
    h.restore_outage(false);
    v.requested();
    let _ = v.due().await.expect("due answers after mint-unavailable");
    drop(s);
    v.end();
    let s = open(h, &e, 1).await;
    assert_eq!(
        (s.quote().accepted_upto, s.quote().spent_total),
        (2, 2),
        "the claim is learnt once restores are answered"
    );
    v.quote(s.quote()).expect("the quote settles the payment");
    assert!(!v.stopped(), "the honest pair carries on");

    // A late claim is credited when the payment was its account's first act: a
    // pre-payment by a peer the seeder had admitted nothing for.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    h.hold_swap_responses();
    let pre = Pay {
        upto_chunk: 2,
        token: h.token(2).await,
    };
    let (r, ()) = both(s.pay(&pre), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.release_swaps().await;
    assert!(h.claimed_all(&pre.token).await, "the seeder has the proofs");
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (2, 2),
        "the late claim is credited, creating the account"
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
    // Restores go unanswered, so it is the landing that moves the watermark.
    h.restore_outage(true);
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
    h.restore_outage(false);
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
    h.restore_outage(true);
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
    h.restore_outage(false);

    // A late claim the payment's own read learns, after its checks, moves the watermark
    // too: the payment it covers is `stale`, nothing is swapped, and the claim is credited
    // once. The same payment arriving again is `stale` as well: not `spent`, no ban.
    for replay in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_swap_responses();
        h.lose_next_swap_response();
        let first = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (r, ()) = both(s.pay(&first), async {
            yield_once().await;
            h.restore_outage(true);
            h.release_swaps().await;
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        h.restore_outage(false);
        h.advance(SECOND);
        let again = if replay {
            first.clone()
        } else {
            Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            }
        };
        let r = s.pay(&again).await;
        assert!(
            is_rej(&r, &RejCode::Stale),
            "the claim its own read learnt covers it (replay {replay}): {r:?}"
        );
        assert!(!s.banned(), "and nobody is banned (replay {replay})");
        if !replay {
            assert!(!h.claimed_any(&again.token).await, "nothing is swapped");
        }
        let q = open(h, &e, 1).await.quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (4, 4),
            "credited once (replay {replay})"
        );
    }

    // A `hello` waiting for a payment in progress reads after it: the payment's claim,
    // knowable at its deadline, is in the hello's quote. Two hellos waiting share one
    // read, and its result: both quote the claim.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swap_responses();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (peer, one, two) = (h.peer(1), h.hello(), h.hello());
    let ((r, (a, b)), ()) = both(
        both(s.pay(&p), both(e.hello(&peer, &one), e.hello(&peer, &two))),
        async {
            yield_once().await;
            h.advance(Duration::from_secs(60));
            yield_once().await;
        },
    )
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    for (n, quoted) in [a, b].into_iter().enumerate() {
        let q = quoted.expect("a hello").quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (4, 4),
            "each waiting hello read after the payment, and quotes its claim (hello {n})"
        );
    }
    h.release_swaps().await;

    // A read serves only entries whose swaps it covered: one sent before a swap became
    // unknown does not serve a hello waiting for that swap's payment, which reads again and
    // quotes the new claim too.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    for upto in [4, 8] {
        if upto == 8 {
            serve(h, &mut s, 4, 4);
        }
        h.hold_swap_responses();
        h.lose_next_swap_response();
        let p = Pay {
            upto_chunk: upto,
            token: h.token(4).await,
        };
        let (peer, hello) = (h.peer(1), h.hello());
        let ((r, quoted), ()) = both(both(s.pay(&p), e.hello(&peer, &hello)), async {
            yield_once().await;
            h.mint_outage(true);
            h.release_swaps().await;
            h.mint_outage(false);
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        let q = quoted.expect("a hello").quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (upto, upto),
            "the waiting hello quotes the claim it waited for, though a read was sent earlier that second"
        );
    }

    // Payments wait for reads too, and keep their deadline: a hello's read stalled, and a
    // payment's read abandoned, spend the second's two. A payment then waits for the hello's
    // read, and is answered by its deadline once the second has passed; one that nothing
    // under way serves reads in the next second, and is swapped. And a flood of entries in
    // that second, dropped or not, sends no more reads: at most two a second, abandoned ones
    // included, however they end.
    for case in 0..3 {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut other = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_next_swap_reserving(); // a swap its reads cannot decide yet
        h.time_out_next_swap();
        let parked = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let r = s.pay(&parked).await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        if case == 1 {
            // Taken back by its watcher once the mint rolls it back: the next read decides
            // it as nothing.
            h.roll_back_reserved();
            assert!(
                h.steal(&parked.token).await,
                "its watcher takes the proofs back"
            );
        }
        h.advance(SECOND);
        let peer = h.peer(1);
        let before = h.state_reads();
        let stalled_hello = h.hello();
        let mut stalled = Box::pin(e.hello(&peer, &stalled_hello));
        if poll_now(stalled.as_mut()).is_some() {
            continue; // synchronous reads: nothing is ever under way
        }
        if case == 1 {
            drop(stalled); // abandoned: it has no result for anyone
            stalled = Box::pin(e.hello(&peer, &stalled_hello));
        }
        {
            let dropped = Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            };
            let mut paying = Box::pin(other.pay(&dropped));
            assert!(poll_now(paying.as_mut()).is_none(), "its read is under way");
        } // its connection closes: abandoned
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        match case {
            0 => {
                let arrived = h.clock_secs();
                let mut pay = Box::pin(s.pay(&p));
                assert!(
                    poll_now(pay.as_mut()).is_none(),
                    "it waits for the hello's read"
                );
                h.advance(Duration::from_secs(61));
                let answered = (0..10_000).find_map(|_| poll_now(pay.as_mut()));
                assert!(
                    answered.is_some_and(|r| is_rej(&r, &RejCode::MintUnavailable)),
                    "answered by its deadline, {} s after arrival",
                    h.clock_secs() - arrived
                );
            }
            1 => {
                let mut pay = Box::pin(s.pay(&p));
                assert!(
                    (0..1000).all(|_| poll_now(pay.as_mut()).is_none()),
                    "two reads were sent this second, none with a result: it reads in the next"
                );
                h.advance(SECOND);
                let ack = (0..10_000)
                    .find_map(|_| poll_now(pay.as_mut()))
                    .expect("answered in the next second")
                    .expect("the parked swap read as nothing: swapped");
                assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
            }
            _ => {
                let hellos: Vec<_> = (0..20).map(|_| h.hello()).collect();
                let mut flood = Vec::new();
                for (n, hello) in hellos.iter().enumerate() {
                    let mut f = Box::pin(e.hello(&peer, hello));
                    let _ = poll_now(f.as_mut());
                    if n % 2 == 0 {
                        flood.push(f); // kept waiting
                    } // the rest dropped mid-way
                }
                for _ in 0..20 {
                    let again = Pay {
                        upto_chunk: 4,
                        token: p.token.clone(),
                    };
                    let mut f = Box::pin(s.pay(&again));
                    let _ = poll_now(f.as_mut());
                }
                assert!(
                    h.state_reads() - before <= 4,
                    "two reads this second, a NUT-07 check and a restore each: {}",
                    h.state_reads() - before
                );
                drop(flood);
            }
        }
        drop(stalled);
        h.release_swaps().await;
    }

    // Reads under way (round trips), for a claim whose answer was lost and whose retry
    // never reached the mint, which the account's next read learns. An entry reusing a read
    // waits until it is back, however many polls that takes; and if its reader is dropped
    // mid-read (a connection closing), it reads itself. Either way it quotes the claim.
    for dropped in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_swap_responses();
        h.lose_next_swap_response();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (r, ()) = both(s.pay(&p), async {
            yield_once().await;
            h.mint_outage(true);
            h.release_swaps().await;
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        h.mint_outage(false);
        h.advance(SECOND);
        let (peer, one, two) = (h.peer(1), h.hello(), h.hello());
        let mut a = Box::pin(e.hello(&peer, &one));
        let mut b = Box::pin(e.hello(&peer, &two));
        let mut quotes = Vec::new();
        match poll_now(a.as_mut()) {
            Some(q) => quotes.push(q), // synchronous reads: nothing is ever under way
            None => {
                assert!(
                    poll_now(b.as_mut()).is_none(),
                    "the second waits for the read"
                );
                let early = poll_now(b.as_mut()); // polled again before the read is back
                if dropped {
                    drop(a);
                } else {
                    quotes.push(a.await);
                }
                quotes.push(match early {
                    Some(q) => q,
                    None => b.await,
                });
            }
        }
        for (n, q) in quotes.into_iter().enumerate() {
            let q = q.expect("a hello").quote().clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "entry {n} quoted the claim (its reader dropped {dropped})"
            );
        }
    }
    // A read that does not come back within its second (its hello never polled again): the
    // entry waiting for it reads itself in the next second, and quotes the claim. And reads
    // abandoned mid-way still count: once two have been sent in a second, a further entry
    // reads in the next second, not at once.
    for abandoned in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_swap_responses();
        h.lose_next_swap_response();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (r, ()) = both(s.pay(&p), async {
            yield_once().await;
            h.mint_outage(true);
            h.release_swaps().await;
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        h.mint_outage(false);
        h.advance(SECOND);
        let peer = h.peer(1);
        let first_hello = h.hello();
        let mut first = Box::pin(e.hello(&peer, &first_hello));
        if poll_now(first.as_mut()).is_some() {
            continue; // synchronous reads: nothing is ever under way
        }
        if abandoned {
            drop(first);
            for _ in 0..19 {
                let hello = h.hello();
                let mut dropped = Box::pin(e.hello(&peer, &hello));
                assert!(poll_now(dropped.as_mut()).is_none());
            }
            let hello = h.hello();
            let mut late = Box::pin(e.hello(&peer, &hello));
            assert!(
                (0..1000).all(|_| poll_now(late.as_mut()).is_none()),
                "two reads were sent this second: it reads in the next"
            );
            h.advance(SECOND);
            let q = (0..10_000)
                .find_map(|_| poll_now(late.as_mut()))
                .expect("it read in the next second")
                .expect("a hello")
                .quote()
                .clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "and quotes the claim"
            );
        } else {
            let hello = h.hello();
            let mut waiting = Box::pin(e.hello(&peer, &hello));
            assert!(
                poll_now(waiting.as_mut()).is_none(),
                "it waits for the first's read"
            );
            h.advance(SECOND); // the first's read outlives its second
            let q = (0..10_000)
                .find_map(|_| poll_now(waiting.as_mut()))
                .expect("its wait ended with the second: it read itself")
                .expect("a hello")
                .quote()
                .clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "and quotes the claim"
            );
            drop(first);
        }
    }

    // A payment whose mint's keys come only at its deadline reads nothing: the keys came
    // too late to be used. A hello that waited for it, and one after it in that second,
    // read then, and quote the claim.
    for waiting in [true, false] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        lost_claim(h, &mut s, 4, 4).await;
        h.advance(SECOND);
        h.hold_key_fetches();
        let late = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (peer, hello) = (h.peer(1), h.hello());
        let mut paying = Box::pin(s.pay(&late));
        assert!(poll_now(paying.as_mut()).is_none(), "waiting for the keys");
        let mut behind = waiting.then(|| Box::pin(e.hello(&peer, &hello)));
        if let Some(b) = behind.as_mut() {
            assert!(
                poll_now(b.as_mut()).is_none(),
                "the hello waits for the payment"
            );
        }
        h.advance(Duration::from_secs(60)); // the payment's deadline
        h.release_swaps().await; // its keys come only now
        let r = (0..1000)
            .find_map(|_| poll_now(paying.as_mut()))
            .expect("answered at its deadline");
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        drop(paying);
        let quoted = match behind {
            Some(mut b) => (0..1000)
                .find_map(|_| poll_now(b.as_mut()))
                .expect("answered once the payment was"),
            None => e.hello(&peer, &hello).await,
        };
        let q = quoted.expect("a hello").quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (4, 4),
            "no read was sent at the payment's deadline: the hello read, and quotes the claim \
             (it waited for the payment: {waiting})"
        );
    }

    // What a read covers is fixed when it is sent: a read under way while another learner
    // decided A and a new claim, B, became unknown never read B, and serves no hello after.
    {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        lost_claim(h, &mut s, 4, 4).await;
        h.advance(SECOND);
        let (peer, first) = (h.peer(1), h.hello());
        let mut stalled = Box::pin(e.hello(&peer, &first));
        let under_way = poll_now(stalled.as_mut()).is_none();
        e.sweep().await; // A learnt by the sweep meanwhile
        assert_eq!(serve(h, &mut s, 4, 4), 4, "A credited");
        lost_claim(h, &mut s, 8, 4).await; // B
        if under_way {
            let _ = (0..1000)
                .find_map(|_| poll_now(stalled.as_mut()))
                .expect("its read is back");
        }
        drop(stalled);
        let q = open(h, &e, 1).await.quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (8, 8),
            "a read sent before B became unknown does not serve a hello after it"
        );
    }

    // Past two reads a second, a read still serves only an entry whose swaps it covered, a
    // payment as a hello. Two reads of A (a hello's, and a payment's of other proofs) in one
    // second; A then learnt by the sweep, and B, the next payment's swap, left unknown in
    // that second. A hello reads B in the next second and quotes it (B a claim); a payment
    // reads B in the next second and is swapped (B taken back by its watcher, nothing).
    for b_claimed in [true, false] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let a = parked(h, &mut s, 4).await;
        h.advance(SECOND);
        let before = h.state_reads();
        drop(open(h, &e, 1).await); // the hello's read of A
        let other = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let r = s.pay(&other).await; // the payment's, of other proofs
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        assert_eq!(h.state_reads() - before, 4, "two reads of A this second");
        h.release_swaps().await; // the mint finishes A: a claim
        assert!(h.claimed_all(&a.token).await);
        e.sweep().await; // learnt by the sweep, no read of the account's own
        assert_eq!(serve(h, &mut s, 4, 4), 4, "A credited");
        if b_claimed {
            lost_claim(h, &mut s, 8, 4).await;
            let (peer, hello) = (h.peer(1), h.hello());
            let quoting = pin!(e.hello(&peer, &hello));
            let q = settle_on(h, quoting, 3).expect("a hello").quote().clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (8, 8),
                "neither of the second's two reads covered B: the hello reads it, in the next second"
            );
        } else {
            let b = parked(h, &mut s, 8).await;
            h.roll_back_reserved();
            assert!(h.steal(&b.token).await, "its watcher takes B's proofs back");
            let again = Pay {
                upto_chunk: 8,
                token: h.token(4).await,
            };
            let paying = pin!(s.pay(&again));
            let ack = settle_on(h, paying, 3)
                .expect("B read as nothing in the next second: the payment is swapped");
            assert_eq!((ack.accepted_upto, ack.spent_total), (8, 8));
        }
    }

    // A payment's own proofs' read serves it only if it covered the account's swaps. A
    // payment reads A (nothing: its watcher took the proofs back), then swaps, and that
    // swap's answer is lost: B, a claim. The same proofs again that second: the first read
    // never read B, so the replay reads it, learns the claim, and is `stale`.
    {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let a = parked(h, &mut s, 4).await;
        h.roll_back_reserved();
        assert!(h.steal(&a.token).await, "its watcher takes A's proofs back");
        h.advance(SECOND);
        let b = lost_claim(h, &mut s, 4, 4).await; // reads A (nothing), then swaps: B
        let r = s.pay(&b).await;
        assert!(
            is_rej(&r, &RejCode::Stale),
            "the replay reads B (its own proofs' read covered only A), and learns the claim: {r:?}"
        );
    }

    // Two hellos in one second share one read of a swap abandoned in flight (sent, and past
    // its payment's deadline unanswered), as of a swap whose answer was lost.
    {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_next_swap_reserving();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        {
            let mut paying = Box::pin(s.pay(&p));
            assert!(poll_now(paying.as_mut()).is_none(), "its swap in flight");
            h.advance(Duration::from_secs(60));
            let r = (0..1000)
                .find_map(|_| poll_now(paying.as_mut()))
                .expect("answered at its deadline");
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        }
        h.advance(SECOND);
        let before = h.state_reads();
        drop(open(h, &e, 1).await);
        drop(open(h, &e, 1).await);
        assert_eq!(
            h.state_reads() - before,
            2,
            "two hellos in one second share one read (a NUT-07 check and a restore)"
        );
        h.release_swaps().await;
    }

    // A hello that waited for a payment reads after it: the payment's own read, sent before
    // the wait ended, does not serve it. A is undecided (its inputs reserved at the mint);
    // payment P reads A, and while that read is under way the mint finishes A, a claim. P is
    // answered without a swap (A still unknown to it); the hello behind P reads, and quotes A.
    {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let a = parked(h, &mut s, 4).await;
        h.advance(SECOND);
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (peer, hello) = (h.peer(1), h.hello());
        let mut paying = Box::pin(s.pay(&p));
        if poll_now(paying.as_mut()).is_none() {
            // Its read under way (round trips): the hello behind it waits for its turn.
            let mut behind = Box::pin(e.hello(&peer, &hello));
            assert!(
                poll_now(behind.as_mut()).is_none(),
                "the hello waits for the payment"
            );
            h.release_swaps().await; // A finishes at the mint, while P's read is under way
            assert!(
                h.claimed_all(&a.token).await,
                "A's claim landed before the hello read"
            );
            let r = (0..1000)
                .find_map(|_| poll_now(paying.as_mut()))
                .expect("answered");
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            let q = (0..1000)
                .find_map(|_| poll_now(behind.as_mut()))
                .expect("answered once the payment was")
                .expect("a hello")
                .quote()
                .clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "the hello that waited for P read after it, and quotes A's claim"
            );
        } else {
            h.release_swaps().await; // synchronous reads: nothing is ever under way
        }
    }

    // Two hellos woken by one payment share one read, sent after their wait ended: the
    // first reads, the second waits for that read and answers with it, this second. So they
    // do even when the turn is freed again that second, by a payment that came after their
    // wait ended: each hello's floor is the one its own wait ended at.
    for later_free in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        parked(h, &mut s, 4).await; // A: every read covers it, none can decide it
        h.advance(SECOND);
        let (peer, one, two) = (h.peer(1), h.hello(), h.hello());
        let p1 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let mut paying = Box::pin(s.pay(&p1));
        if poll_now(paying.as_mut()).is_some() {
            h.release_swaps().await; // synchronous reads: nothing is ever under way
            continue;
        }
        let mut first = Box::pin(e.hello(&peer, &one));
        let mut second = Box::pin(e.hello(&peer, &two));
        assert!(poll_now(first.as_mut()).is_none(), "it waits for P1");
        assert!(poll_now(second.as_mut()).is_none(), "it waits for P1");
        let r = (0..1000)
            .find_map(|_| poll_now(paying.as_mut()))
            .expect("P1 answered");
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        drop(paying);
        let before = h.state_reads();
        assert!(
            poll_now(first.as_mut()).is_none(),
            "the first reads: under way"
        );
        assert!(
            poll_now(second.as_mut()).is_none(),
            "the second waits for the first's read"
        );
        if later_free {
            let late = Pay {
                upto_chunk: 4,
                token: h.token(1).await,
            };
            let r = s2.pay(&late).await; // takes the free turn, refused at once: freed again
            assert!(is_rej(&r, &RejCode::Underpaid), "{r:?}");
        }
        (0..1000)
            .find_map(|_| poll_now(first.as_mut()))
            .expect("the first answered")
            .expect("a hello");
        assert!(
            (0..1000).find_map(|_| poll_now(second.as_mut())).is_some(),
            "the second shares the first's read, sent after its wait ended: answered this second \
             (a later free: {later_free})"
        );
        assert_eq!(
            h.state_reads() - before,
            2,
            "one read for both woken hellos (a later free: {later_free})"
        );
        h.release_swaps().await;
    }

    // The turn freed twice in one second: a hello that waited for the second payment, P2, is
    // not served by P2's own read, sent before its wait ended, though the first free's floor
    // would allow it. It reads after P2, and quotes A's claim, which reached the mint while
    // P2's read was under way.
    {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let a = parked(h, &mut s, 4).await;
        h.advance(SECOND);
        let p1 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let r = s.pay(&p1).await; // reads A, answered: the second's first free
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        let p2 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (peer, hello) = (h.peer(1), h.hello());
        let mut paying = Box::pin(s2.pay(&p2));
        if poll_now(paying.as_mut()).is_none() {
            let mut behind = Box::pin(e.hello(&peer, &hello));
            assert!(
                poll_now(behind.as_mut()).is_none(),
                "the hello waits for P2"
            );
            h.release_swaps().await; // A finishes at the mint, while P2's read is under way
            assert!(h.claimed_all(&a.token).await);
            let r = (0..1000)
                .find_map(|_| poll_now(paying.as_mut()))
                .expect("P2 answered");
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            drop(paying);
            let q = settle_on(h, behind.as_mut(), 3)
                .expect("a hello")
                .quote()
                .clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "the hello that waited for P2 reads after P2, and quotes A's claim"
            );
        } else {
            h.release_swaps().await; // synchronous reads: nothing is ever under way
        }
    }

    // Past two reads a second, a hello that waited is still served only by a read sent after
    // its wait ended, and the second's two stay its two: it sends no third, reads in the next
    // second, and quotes A's claim.
    {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let a = parked(h, &mut s, 4).await;
        h.advance(SECOND);
        let before = h.state_reads();
        let (peer, first) = (h.peer(1), h.hello());
        let mut reading = Box::pin(e.hello(&peer, &first));
        if poll_now(reading.as_mut()).is_none() {
            let _ = (0..1000)
                .find_map(|_| poll_now(reading.as_mut()))
                .expect("its read back"); // r0
            let hello = h.hello();
            let p = Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            };
            let mut paying = Box::pin(s.pay(&p)); // r1, of its own proofs
            assert!(poll_now(paying.as_mut()).is_none(), "P's read under way");
            let mut behind = Box::pin(e.hello(&peer, &hello));
            assert!(poll_now(behind.as_mut()).is_none(), "the hello waits for P");
            h.release_swaps().await; // A finishes at the mint, while P's read is under way
            assert!(h.claimed_all(&a.token).await);
            let r = (0..1000)
                .find_map(|_| poll_now(paying.as_mut()))
                .expect("P answered");
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            drop(paying);
            let early = (0..1000).find_map(|_| poll_now(behind.as_mut()));
            assert_eq!(
                h.state_reads() - before,
                4,
                "two reads this second (r0 and r1): the waited hello sends no third"
            );
            let q = match early {
                Some(q) => q,
                None => settle_on(h, behind.as_mut(), 3),
            }
            .expect("a hello")
            .quote()
            .clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "neither r0 nor r1 was sent after its wait ended: it reads, and quotes A's claim"
            );
        } else {
            h.release_swaps().await; // synchronous reads: nothing is ever under way
        }
    }

    // A payment that waits into its deadline (the second's two reads spent without a result)
    // sends no read at its deadline, and records none: its time left is judged at every
    // look. A hello then reads, and quotes A.
    {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let a = parked(h, &mut s, 4).await;
        h.advance(SECOND);
        h.hold_key_fetches();
        let hold = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let mut holding = Box::pin(s.pay(&hold));
        assert!(
            poll_now(holding.as_mut()).is_none(),
            "it waits for the keys"
        );
        h.advance(SECOND);
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let mut paying = Box::pin(s2.pay(&p)); // its deadline: 60 s from now
        assert!(poll_now(paying.as_mut()).is_none(), "P waits for its turn");
        h.advance(Duration::from_secs(59)); // the holder's deadline; P's second before its own
        let r = (0..1000)
            .find_map(|_| poll_now(holding.as_mut()))
            .expect("the holder answered at its deadline");
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        drop(holding);
        let mut spent = true;
        for _ in 0..2 {
            let (peer, hello) = (h.peer(1), h.hello());
            let mut f = Box::pin(e.hello(&peer, &hello));
            spent &= poll_now(f.as_mut()).is_none(); // under way, then dropped
        }
        h.release_swaps().await; // the keys come; A finishes at the mint: a claim
        if spent {
            assert!(h.claimed_all(&a.token).await);
            assert!(
                (0..1000).all(|_| poll_now(paying.as_mut()).is_none()),
                "P, in time, finds the second's two spent: it waits for the next"
            );
            h.advance(SECOND); // P's deadline
            let r = (0..1000)
                .find_map(|_| poll_now(paying.as_mut()))
                .expect("P answered at its deadline");
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            drop(paying);
            let q = open(h, &e, 1).await.quote().clone();
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "P sent no read at its deadline and recorded none: the hello reads, and quotes A"
            );
        } // else synchronous reads: nothing is ever under way
    }

    // A late claim frees exactly the chunks it covers from the global count, and no more:
    // the account's chunks beyond it are unpaid, and still count.
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut s, 0, 4), 4, "the global cap of 4 is full");
    lost_claim(h, &mut s, 2, 2).await; // pays chunks 1 and 2 of 4; unknown to the seeder
    h.advance(SECOND);
    let q = open(h, &e, 1).await.quote().clone(); // its hello reads, and learns the claim
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (2, 2),
        "the late claim is credited"
    );
    let mut other = open(h, &e, 2).await;
    assert_eq!(
        serve(h, &mut other, 0, 4),
        2,
        "the late claim freed the two chunks it covers and no more: chunks 3 and 4 still count"
    );

    // Signed outputs are a claim whatever the NUT-07 check said, an unanswered one included.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    lost_claim(h, &mut s, 4, 4).await;
    h.state_check_outage(true);
    h.advance(SECOND);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "a restore shows the claim: credited, though the NUT-07 check went unanswered"
    );
    h.state_check_outage(false);

    // A waited hello's floor, across a wait's every end and a change of second; how reads
    // count in the second they are sent; and a payment's waits, bounded by its deadline.
    a_read_sent_during_the_wait_serves_no_waited_hello(h).await;
    a_waited_hello_shares_a_read_of_a_later_second(h).await;
    hellos_woken_by_one_payment_share_a_read_across_a_second(h).await;
    a_read_back_after_its_second_marks_nothing_of_the_next(h).await;
    entries_that_waited_into_a_second_count_there(h).await;
    a_payment_waits_only_for_a_read_that_serves_it(h).await;
    a_payment_waits_no_longer_than_its_deadline(h).await;
    a_payment_waits_no_longer_than_its_deadline_behind_a_turn(h).await;
    a_turn_held_past_its_deadline_was_freed_there(h).await;
    a_turn_held_past_its_deadline_by_a_swap_was_freed_there(h).await;
    a_hello_behind_two_payments_reads_after_the_last(h).await;
    a_waited_hello_waits_for_no_read_sent_before_its_wait_ended(h).await;
    no_place_is_counted_at_the_deadline(h).await;

    an_unwaited_hello_reuses_the_payments_read(h).await;
    a_hello_arriving_past_the_deadline_did_not_wait(h).await;
    a_retry_settled_unsigned_leaves_nothing_unknown(h).await;

    // Outputs unsigned with an input spent are nothing, whatever the other inputs are.
    an_input_spent_beside_others_pending_is_nothing(h).await;
}

/// Outputs unsigned with an input spent are nothing, whatever the other inputs are: the
/// swap is atomic, so it can no longer go through. The seeder's client gives up on a swap
/// the mint has not processed; a third party then spends one of its proofs, and holds the
/// rest reserved in a request the mint does not finish. The account's next payment reads
/// the swap as nothing, and is swapped at once.
async fn an_input_spent_beside_others_pending_is_nothing<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 3);
    let first = Pay {
        upto_chunk: 3,
        token: h.token(3).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(
        is_rej(&s.pay(&first).await, &RejCode::MintUnavailable),
        "its client gave up on the swap"
    );
    h.mint_outage(false);
    assert!(
        h.steal_one(&first.token).await,
        "a third party spends one proof"
    );
    assert!(
        h.reserve_rest(&first.token).await,
        "and holds the rest reserved"
    );
    let ack = s
        .pay(&Pay {
            upto_chunk: 3,
            token: h.token(3).await,
        })
        .await
        .expect(
            "an input spent beside others pending, the outputs unsigned: nothing, so the next \
             payment is swapped",
        );
    assert_eq!((ack.accepted_upto, ack.spent_total), (3, 3));
    h.roll_back_reserved();
    h.release_swaps().await;
}

/// A turn held past its payment's deadline is taken over, even when nobody awaits that
/// payment: a `hello` waiting behind a dropped, black-holed payment is answered at
/// exactly 60 s, on its own task. While the abandoned swap is in flight with its inputs
/// unspent, its outcome is unknown, so the next payment, once its read of that swap has
/// learnt nothing, is answered with no swap; once its watcher has taken the proofs back it
/// can no longer go through, and the next payment is swapped. When the abandoned payment
/// lands, it releases nothing it no longer holds. Waiting hellos count toward the session
/// cap.
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
        // Freed, it reads the abandoned swap first: round trips take polls, not time.
        for _ in 0..10_000 {
            yield_once().await;
            if is_set(&done) {
                break;
            }
        }
        assert!(
            is_set(&done),
            "until its deadline frees the account, at 60 s"
        );
    })
    .await;
    let q = quoted.expect("a hello").quote().clone();
    assert_eq!((q.accepted_upto, q.spent_total), (0, 0));

    // The abandoned swap is still in flight, its inputs unspent: its outcome is unknown,
    // so the next payment gets its turn, and is answered `mint-unavailable` without a
    // swap.
    let early = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    assert!(is_rej(&s.pay(&early).await, &RejCode::MintUnavailable));
    assert!(!h.claimed_any(&early.token).await, "not swapped");
    // The next payment holds the turn while it fetches keys. Its watcher takes the
    // proofs back meanwhile, and the abandoned swap lands, spent: that releases nothing it
    // no longer holds, and the account pays again.
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (hello, next_done, hello_done) =
        (h.hello(), AtomicBool::new(false), AtomicBool::new(false));
    h.hold_key_fetches();
    let ((paid, late), ()) = both(
        both(
            marked(s.pay(&next), &next_done),
            own_task(marked(e.hello(&peer, &hello), &hello_done)),
        ),
        async {
            yield_once().await;
            assert!(
                h.steal(&dropped.token).await,
                "its watcher takes the proofs back"
            );
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

    // A payment takes over a dead turn too. It reads the dead swap, and while that outcome
    // is unknown it is answered with no swap: at once, since the mint answers the read at
    // once. Once its watcher has taken the proofs back, the dead swap can no longer go
    // through, and the next payment is swapped at once; the dead swap's spent, when it
    // lands, bans nobody and changes nothing.
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
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let answered = {
        let mut paying = Box::pin(s.pay(&next));
        (0..1000).find_map(|_| poll_now(paying.as_mut()))
    };
    assert!(
        answered
            .as_ref()
            .is_some_and(|r| is_rej(r, &RejCode::MintUnavailable)),
        "the next payment takes over the dead turn, and is answered at once: {answered:?}"
    );
    assert!(!h.claimed_any(&next.token).await, "not swapped");
    assert!(h.steal(&dead.token).await, "its watcher takes it back");
    let again = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let ack = s
        .pay(&again)
        .await
        .expect("the dead swap can no longer go through: swapped at once");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    h.release_swaps().await;
    assert!(!s.banned(), "the dead swap's spent bans nobody");
    let q = open(h, &e, 3).await.quote().clone();
    assert_eq!((q.accepted_upto, q.spent_total), (4, 4));

    // A dead swap decided by a read releases only a turn it still holds: a payment that
    // took its turn over keeps it, so a hello waits for that payment.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap();
    let dead = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(s.pay(&dead)).await;
    h.advance(Duration::from_secs(60));
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.hold_key_fetches();
    let (peer, hello) = (h.peer(1), h.hello());
    let early = AtomicBool::new(false);
    let (paid, ()) = both(s.pay(&next), async {
        yield_once().await;
        assert!(
            h.steal(&dead.token).await,
            "its watcher takes the proofs back"
        );
        // The sweep reads the dead swap, and decides it (nothing).
        e.sweep().await;
        let mut waiting = Box::pin(e.hello(&peer, &hello));
        early.store(poll_now(waiting.as_mut()).is_some(), Ordering::SeqCst);
        drop(waiting);
        h.release_swaps().await;
    })
    .await;
    assert!(
        !is_set(&early),
        "a hello waits for the payment that took the dead turn over"
    );
    let ack = paid.expect("that payment");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));

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

    a_hello_waits_while_any_payment_holds_the_turn(h).await;
    hellos_behind_two_payments_wait_for_both(h).await;
    a_waiting_payment_is_answered_at_its_own_deadline(h).await;
    a_dropped_payment_that_waited_holds_the_turn_to_its_deadline(h).await;
    a_takeover_reads_the_abandoned_swap(h).await;
    a_payment_dropped_before_its_swap_frees_the_turn(h).await;
    a_takeover_is_checked_before_it_reads(h).await;
    a_takeovers_reads_end_at_its_deadline(h).await;
    no_retry_at_the_deadline(h).await; // last: the mint event it queues stays queued
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
        let release = scope.spawn(move || {
            keep_panic(|| {
                barrier.wait();
                block_on(h.release_swaps());
            })
        });
        let clock = scope.spawn(move || {
            keep_panic(|| {
                barrier.wait();
                h.advance(Duration::from_secs(60));
            })
        });
        barrier.wait();
        let r = loop {
            if let Poll::Ready(r) = f.as_mut().poll(&mut cx) {
                break r;
            }
            std::thread::park_timeout(Duration::from_millis(5));
        };
        rejoin(release.join());
        rejoin(clock.join());
        r
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

    // The same race made deterministic: an outcome that arrives a second before its payment's
    // deadline and is settled a second after it. Lateness is judged at settlement: the
    // payment is answered mint-unavailable, a claim is credited once, late, and a spent
    // outcome bans nobody.
    for spent in [false, true] {
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
        let mut paying = Box::pin(s.pay(&pay));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "its swap is held on its way to the mint"
        );
        h.advance(Duration::from_secs(59));
        let arrival = h.clock_secs();
        h.advance_during_next_land(Duration::from_secs(2));
        assert_eq!(
            h.clock_secs(),
            arrival,
            "asking for the move moves nothing: the outcome arrives a second before the deadline"
        );
        h.release_swaps().await;
        assert!(
            h.advanced_during_land(),
            "the harness moved the clock between the outcome's arrival and its settlement"
        );
        assert_eq!(
            h.clock_secs(),
            arrival + 2,
            "the clock moved by the 2 s asked, during the land"
        );
        let answer = (0..1000)
            .find_map(|_| poll_now(paying.as_mut()))
            .expect("answered");
        drop(paying);
        assert!(
            is_rej(&answer, &RejCode::MintUnavailable),
            "settled after its deadline: mint-unavailable, not the outcome (spent {spent}): \
             {answer:?}"
        );
        assert!(!s.banned(), "late, nobody is banned (spent {spent})");
        let q = open(h, &e, 1).await.quote().clone();
        let want = if spent { (0, 0) } else { (4, 4) };
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            want,
            "credited exactly once, late, if claimed (spent {spent})"
        );
    }

    an_outcome_in_the_deadlines_second_is_late(h).await;
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

    // A mint whose active keyset expires sooner than twice `account_ttl` away gets no swap:
    // a swap left undecided could outlive its outputs. The seeder's own keyset error:
    // `mint-unavailable`, never a ban, and the payer keeps its proofs. Later than that, or
    // with no expiry listed, it swaps.
    let ttl = h.account_ttl();
    for (after, swaps) in [
        (Some(ttl + ttl / 2), false),
        (Some(ttl * 3), true),
        (None, true),
    ] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.keyset_expires_in(after);
        let pay = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let r = s.pay(&pay).await;
        if swaps {
            let ack = r.expect("a keyset far enough from its expiry");
            assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
        } else {
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            assert!(!s.banned(), "the seeder's own keyset error bans nobody");
            assert!(!h.claimed_any(&pay.token).await, "nothing was swapped");
        }
    }
    h.keyset_expires_in(None);
    // The margin is exactly twice `account_ttl` (not `ban_ttl`): an `account_ttl` of 48 h and
    // a `ban_ttl` of 24 h, a keyset a second short of 96 h away, exactly 96 h, and a second
    // more.
    let ttl = Duration::from_secs(48 * 3600);
    for (after, swaps) in [
        (ttl * 2 - SECOND, false),
        (ttl * 2, true),
        (ttl * 2 + SECOND, true),
    ] {
        let e = h
            .engine_checked(EngineParams {
                price: 1,
                window: 4,
                global_cap: 1000,
                debt_ttl: h.debt_ttl(),
                account_ttl: ttl,
                ban_ttl: Duration::from_secs(24 * 3600),
                mints: 1,
                extra_mint: None,
            })
            .expect("a valid configuration");
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.keyset_expires_in(Some(after));
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            })
            .await;
        assert_eq!(r.is_ok(), swaps, "a keyset {after:?} away: {r:?}");
    }
    // Nor the longer of the two: with an `account_ttl` of 24 h and a `ban_ttl` of 30 days, a
    // keyset exactly 48 h away is swapped to.
    let ttl = Duration::from_secs(24 * 3600);
    for (after, swaps) in [(ttl * 2 - SECOND, false), (ttl * 2, true)] {
        let e = h
            .engine_checked(EngineParams {
                price: 1,
                window: 4,
                global_cap: 1000,
                debt_ttl: h.debt_ttl(),
                account_ttl: ttl,
                ban_ttl: Duration::from_secs(30 * 24 * 3600),
                mints: 1,
                extra_mint: None,
            })
            .expect("a valid configuration");
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.keyset_expires_in(Some(after));
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            })
            .await;
        assert_eq!(r.is_ok(), swaps, "a keyset {after:?} away: {r:?}");
    }
    h.keyset_expires_in(None);
    // Its refusal is step 5's, after every earlier check: `stale`, underpaid or a mint not
    // quoted keep their own codes. And it reads nothing, though the account holds a swap
    // of unknown outcome.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("paid before the keyset nears its expiry");
    assert_eq!(ack.accepted_upto, 4);
    serve(h, &mut s, 4, 4);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let lost = Pay {
        upto_chunk: 8,
        token: h.token(4).await,
    };
    let (r, ()) = both(s.pay(&lost), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.mint_outage(false);
    h.advance(SECOND);
    h.keyset_expires_in(Some(h.account_ttl()));
    for (upto_chunk, token, code) in [
        (4, h.token(4).await, RejCode::Stale),
        (8, h.token(3).await, RejCode::Underpaid),
        (
            8,
            h.token_at("https://other-mint.example", 4).await,
            RejCode::BadMint,
        ),
    ] {
        let r = s.pay(&Pay { upto_chunk, token }).await;
        assert!(is_rej(&r, &code), "{code:?} before the keyset rule: {r:?}");
    }
    let before = h.state_reads();
    let r = s
        .pay(&Pay {
            upto_chunk: 8,
            token: h.token(4).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert_eq!(
        h.state_reads(),
        before,
        "refused by the keyset rule, it read nothing"
    );
    h.keyset_expires_in(None);
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

    requests_not_admitted_leave_the_cap_alone(h).await;
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
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
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
                v.ack(&s.pay(&pay).await.expect("accepted"))
                    .expect("each video's honest ack is taken");
            }
            *in_flight = v.due().await.expect("due answers on each video");
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

    a_payment_frees_only_its_own_accounts_chunks(h).await;
}

/// A payment frees from the global count only its own account's chunks, none of its
/// peer's on another video, whatever their numbers.
async fn a_payment_frees_only_its_own_accounts_chunks<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 8);
    let mut zero = open_on(h, &e, 1, 0).await;
    let mut one = open_on(h, &e, 1, 1).await;
    assert_eq!(serve_on(h, &mut zero, 0, 0, 4), 4);
    assert_eq!(serve_on(h, &mut one, 1, 0, 4), 4, "the global cap is full");
    one.pay(&Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    })
    .await
    .expect("video 1's four chunks, paid");
    let mut others = 0;
    for p in 2..=3u8 {
        let mut s = open(h, &e, p).await;
        others += serve(h, &mut s, 0, 4);
    }
    assert_eq!(
        others, 4,
        "the payment freed video 1's four chunks, and none of video 0's"
    );
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

    debt_ages_while_a_swap_is_unknown(h).await;
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

    // An account holding a swap of unknown outcome is kept until it is learnt: its answer
    // lost with restores unanswered past account_ttl, or its swap still in flight (its
    // connection dropped at once, so the account is idle from before the swap's
    // deadline, and the swap has not read unspent for account_ttl yet).
    for in_flight in [false, true] {
        let e = h.engine(1, 4, 4);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let unseen = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        if in_flight {
            h.hold_swaps();
            poll_once(s.pay(&unseen)).await;
        } else {
            h.hold_swap_responses();
            h.lose_next_swap_response();
            let (r, ()) = both(s.pay(&unseen), async {
                yield_once().await;
                h.mint_outage(true);
                h.release_swaps().await;
            })
            .await;
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            h.mint_outage(false);
            h.restore_outage(true);
        }
        drop(s);
        h.advance(h.account_ttl() + SECOND);
        // Another peer's entry runs the housekeeping while the outcome is still unknown.
        let mut other = open(h, &e, 2).await;
        h.release_swaps().await;
        h.restore_outage(false);
        assert_eq!(serve(h, &mut other, 0, 4), 4, "the cap fills again");
        let mut s = open(h, &e, 1).await;
        assert_eq!(
            (s.quote().served, s.quote().accepted_upto),
            (4, 4),
            "the account was kept, and its claim credited (in flight: {in_flight})"
        );
        assert_eq!(
            serve(h, &mut s, 100, 4),
            0,
            "a full cap serves nothing uncovered (in flight: {in_flight})"
        );
    }
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
    // Payments whose swaps never land leave nothing behind either, once their outcomes
    // are learnt without an answer (here their watchers took the proofs back, so they
    // can no longer go through).
    let mut hung = open(h, &e, 101).await;
    serve(h, &mut hung, 0, 4);
    h.hold_next_swap();
    let unanswered = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(hung.pay(&unanswered)).await;
    drop(hung);
    // And one with a hello waiting behind it, woken when the read decides it.
    let mut hung = open(h, &e, 103).await;
    serve(h, &mut hung, 0, 4);
    h.hold_next_swap();
    let awaited = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(hung.pay(&awaited)).await;
    drop(hung);
    let (peer, hello) = (h.peer(103), h.hello());
    let mut waiting = Box::pin(e.hello(&peer, &hello));
    assert!(
        poll_now(waiting.as_mut()).is_none(),
        "the hello waits for the turn"
    );
    h.advance(Duration::from_secs(60));
    assert!(
        h.steal(&unanswered.token).await && h.steal(&awaited.token).await,
        "their watchers take the proofs back"
    );
    e.sweep().await;
    drop(
        poll_now(waiting.as_mut())
            .expect("the read freed the turn: the hello is answered")
            .expect("a hello"),
    );
    drop(waiting);
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

    // Replays during an outage keep nothing: a swap that never reached the mint has a
    // known outcome, nothing to learn.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.mint_outage(true);
    let before = h.identities_held(&e);
    for _ in 0..200 {
        assert!(is_rej(&s.pay(&pay).await, &RejCode::MintUnavailable));
    }
    assert_eq!(
        h.identities_held(&e),
        before,
        "replays during an outage leave nothing behind"
    );
    h.mint_outage(false);

    // Swaps left without an answer, in flight or lost, are one per account at most: while
    // one is, the account's payments are not swapped. What is held for the account is that
    // swap and, for this second, the record of its reads.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let before = h.identities_held(&e);
    h.restore_outage(true);
    h.hold_swaps();
    for _ in 0..20 {
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (r, ()) = both(s.pay(&p), async {
            yield_once().await;
            h.advance(Duration::from_secs(60));
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    }
    assert!(
        h.identities_held(&e) <= before + 2,
        "one swap in flight, not twenty"
    );
    // The one swap sent lands with its answer lost.
    h.lose_next_swap_response();
    h.release_swaps().await;
    assert!(
        h.identities_held(&e) <= before + 2,
        "one unknown outcome, not twenty"
    );
    h.restore_outage(false);

    // Strangers whose swaps stay undecided (the mint never processes the requests, and
    // they never spend the proofs; half lost their answers, half were in flight at their
    // deadlines). An honest account's own entries read none of them, even while reads go
    // unanswered at 30 s each. The sweep reads them all in one NUT-07 check and one
    // restore, or in requests within the mint's limit; once their inputs have read
    // unspent for account_ttl, it completes their swaps, so the strangers pay after all.
    let e = h.engine(1, 4, 1_000_000);
    let mut tokens = Vec::new();
    for peer in 1..=200u8 {
        let mut s = open(h, &e, peer).await;
        let p = Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        };
        if peer % 2 == 0 {
            h.time_out_next_swap();
            h.mint_outage(true);
            assert!(is_rej(&s.pay(&p).await, &RejCode::MintUnavailable));
            h.mint_outage(false);
        } else {
            h.hold_next_swap();
            poll_once(s.pay(&p)).await;
        }
        tokens.push(p.token);
    }
    h.advance(Duration::from_secs(60));
    h.restore_outage(true);
    h.unanswered_reads_take(Duration::from_secs(30));
    let before = h.state_reads();
    let mut honest = open(h, &e, 201).await;
    assert_eq!(serve(h, &mut honest, 0, 1), 1);
    let ack = honest
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await
        .expect("its own payment is answered in time");
    assert_eq!((ack.accepted_upto, ack.spent_total), (1, 1));
    // So does a stranger's own other account: its peer's swap on video 0 is not its own.
    let mut other_video = open_on(h, &e, 1, 1).await;
    assert_eq!(serve_on(h, &mut other_video, 1, 0, 1), 1);
    let ack = other_video
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await
        .expect("the same peer's other account pays in time");
    assert_eq!((ack.accepted_upto, ack.spent_total), (1, 1));
    assert_eq!(
        h.state_reads(),
        before,
        "an account with nothing undecided reads nothing, hello and payment alike"
    );
    let before = h.state_reads();
    e.sweep().await;
    assert_eq!(
        h.state_reads() - before,
        2,
        "an unanswered read is not split: one check and one restore for all two hundred"
    );
    h.unanswered_reads_take(Duration::ZERO);
    h.restore_outage(false);
    let before = h.state_reads();
    e.sweep().await;
    assert_eq!(
        h.state_reads() - before,
        2,
        "one NUT-07 check and one restore for all two hundred"
    );
    h.limit_state_reads(Some(64));
    h.advance(h.account_ttl());
    e.sweep().await;
    for t in &tokens {
        assert!(
            h.claimed_all(t).await,
            "the sweep completed every stranger's swap"
        );
    }
    for peer in [1, 2] {
        let q = open(h, &e, peer).await.quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (1, 1),
            "and credited it (peer {peer})"
        );
    }
    h.limit_state_reads(None);
    let before = h.state_reads();
    e.sweep().await;
    assert_eq!(h.state_reads(), before, "nothing is undecided any more");
    h.release_swaps().await;

    // A completion refused for good (its outputs' keyset rotated out), after the given-up
    // first request went through, is settled by a restore of its outputs: the claim.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut s, 0, 1), 1);
    let p = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&p).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    drop(s);
    h.advance(h.account_ttl());
    h.before_next_swap(MintEvent::ProcessTimedOut);
    h.before_next_swap(MintEvent::RotateKeyset);
    e.sweep().await;
    let s = open_unbanned(h, &e, 1, "a completion refused for good bans nobody").await;
    assert_eq!(
        (s.quote().accepted_upto, s.quote().spent_total),
        (1, 1),
        "a completion refused for good after the first request signed: a restore shows the claim"
    );

    // A completion is a retry, sent with the swap's own outputs, and settled as its
    // answer says:
    // 0. its answer lost: a later read learns the claim;
    // 1. answered `spent` (the given-up request processed just before it): a restore
    //    shows the claim;
    // 2. refused as pending (that request started just before it): unknown until the mint
    //    finishes it;
    // 3. refused for good, its outputs' keyset rotated out: nothing, and the account pays
    //    again;
    // 4. refused as invalid: nothing, and nobody banned;
    // 5. held on its way to the mint, unanswered: unknown, and learnt once processed;
    // 6. never reaching the mint: unknown, and completed again later;
    // 7. answered `spent` with restores down: unknown, and learnt once they answer;
    // 8. refused because the payer's keyset expired, while the given-up request holds the
    //    inputs reserved: unknown until the mint finishes that request, then its claim;
    // 9. refused because the mint's keyset expired, no input pending: nothing, and the
    //    account pays again;
    // 10. refused because the mint's keyset expired, the given-up request processed just
    //    before: a restore cannot show the outputs, so the claim cannot be proven, and is
    //    nothing; the account pays again.
    for case in 0..11 {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        assert_eq!(serve(h, &mut s, 0, 1), 1);
        let p = Pay {
            upto_chunk: 1,
            token: if case == 4 {
                h.bad_token(BadToken::Forged, 1).await
            } else {
                h.token(1).await
            },
        };
        h.time_out_next_swap();
        h.mint_outage(true);
        assert!(is_rej(&s.pay(&p).await, &RejCode::MintUnavailable));
        h.mint_outage(false);
        drop(s);
        h.advance(h.account_ttl());
        match case {
            0 => h.lose_next_swap_response(),
            1 => h.before_next_swap(MintEvent::ProcessTimedOut),
            2 => h.before_next_swap(MintEvent::ReserveTimedOut),
            3 => h.rotate_keyset(),
            5 => h.hold_swaps(),
            6 => h.before_next_swap(MintEvent::Down),
            7 => {
                h.before_next_swap(MintEvent::ProcessTimedOut);
                h.before_next_swap(MintEvent::RestoresDown);
            }
            8 => {
                h.before_next_swap(MintEvent::ReserveTimedOut);
                h.before_next_swap(MintEvent::ExpireInputKeyset);
            }
            9 => h.before_next_swap(MintEvent::ExpireKeyset),
            10 => {
                h.before_next_swap(MintEvent::ProcessTimedOut);
                h.before_next_swap(MintEvent::ExpireKeyset);
            }
            _ => {}
        }
        e.sweep().await;
        match case {
            2 | 5 | 8 => h.release_swaps().await,
            6 => h.mint_outage(false),
            7 => h.restore_outage(false),
            _ => {}
        }
        e.sweep().await;
        let why = format!("a late outcome bans nobody (case {case})");
        let mut s = open_unbanned(h, &e, 1, &why).await;
        let want = if matches!(case, 3 | 4 | 9 | 10) {
            (0, 0)
        } else {
            (1, 1)
        };
        assert_eq!(
            (s.quote().accepted_upto, s.quote().spent_total),
            want,
            "the completion settled as its answer says (case {case})"
        );
        if want == (0, 0) {
            let ack = s
                .pay(&Pay {
                    upto_chunk: 1,
                    token: h.token(1).await,
                })
                .await
                .expect("nothing is left unknown: the account pays again");
            assert_eq!((ack.accepted_upto, ack.spent_total), (1, 1));
        }
        h.release_swaps().await;
    }

    // A payment's own reads and completions end at its deadline: with the mint's read
    // endpoints hanging (40 s each), a payment of an account holding an unknown swap is
    // answered `mint-unavailable` at 60 s, not later.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.state_check_outage(true);
    h.restore_outage(true);
    h.unanswered_reads_take(Duration::from_secs(40));
    let arrived = h.clock_secs();
    let r = s
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert_eq!(h.clock_secs() - arrived, 60, "answered at its deadline");
    h.unanswered_reads_take(Duration::ZERO);
    h.state_check_outage(false);
    h.restore_outage(false);
    h.release_swaps().await;
    // However late its reads start: after a 30 s key fetch, still at 60 s from its
    // arrival, not 60 s from its first read.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.state_check_outage(true);
    h.restore_outage(true);
    h.unanswered_reads_take(Duration::from_secs(40));
    h.hold_key_fetches();
    let p = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    let arrived = h.clock_secs();
    let ((r, answered), ()) = both(
        async {
            let r = s.pay(&p).await;
            (r, h.clock_secs())
        },
        async {
            yield_once().await;
            h.advance(Duration::from_secs(30));
            h.release_swaps().await;
        },
    )
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert_eq!(
        answered - arrived,
        60,
        "answered 60 s from its arrival, its key fetch included"
    );
    h.unanswered_reads_take(Duration::ZERO);
    h.state_check_outage(false);
    h.restore_outage(false);
    // And a completion its read sends, held on its way to the mint while unanswered
    // requests take 90 s: abandoned at the deadline, and the payment answered then.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.advance(h.account_ttl());
    h.hold_swaps();
    h.unanswered_reads_take(Duration::from_secs(90));
    let arrived = h.clock_secs();
    let r = s
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert_eq!(
        h.clock_secs() - arrived,
        60,
        "answered at its deadline, the held completion abandoned"
    );
    h.unanswered_reads_take(Duration::ZERO);
    h.release_swaps().await;
    // A completion refused for good (its outputs' keyset rotated out) whose settling restore
    // goes unanswered: that restore ends at the deadline too.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.advance(h.account_ttl());
    h.unanswered_reads_take(Duration::from_secs(90));
    h.before_next_swap(MintEvent::RotateKeyset);
    h.before_next_swap(MintEvent::RestoresDown);
    let arrived = h.clock_secs();
    let r = s
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert_eq!(
        h.clock_secs() - arrived,
        60,
        "answered at its deadline, the completion's restore abandoned"
    );
    h.unanswered_reads_take(Duration::ZERO);
    h.restore_outage(false);
    h.release_swaps().await;
    // So does a retry's: the first attempt's answer lost, the retry's outputs refused for
    // good, and the restore that would settle it unanswered.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.unanswered_reads_take(Duration::from_secs(90));
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let arrived = h.clock_secs();
    let ((r, answered), ()) = both(
        async {
            let r = s.pay(&p).await;
            (r, h.clock_secs())
        },
        async {
            yield_once().await;
            h.rotate_keyset();
            h.restore_outage(true);
            h.release_swaps().await;
        },
    )
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    assert!(
        answered - arrived <= 60,
        "answered within 60 s, the retry's restore abandoned: {} s",
        answered - arrived
    );
    h.unanswered_reads_take(Duration::ZERO);
    h.restore_outage(false);
    // And a payment that waited for its account's turn: its reads end 60 s from its own
    // arrival, not 60 s from its turn.
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let mut second = open(h, &e, 1).await;
    let (p1, p2) = (
        Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        },
        Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        },
    );
    h.hold_next_swap(); // the first payment's swap, never answered
    h.state_check_outage(true);
    h.restore_outage(true);
    h.unanswered_reads_take(Duration::from_secs(40));
    let t0 = h.clock_secs();
    let ((r1, (r2, arrived, answered)), ()) = both(
        both(first.pay(&p1), async {
            while h.clock_secs() < t0 + 30 {
                yield_once().await;
            }
            let arrived = h.clock_secs();
            let r = second.pay(&p2).await;
            (r, arrived, h.clock_secs())
        }),
        async {
            yield_once().await;
            h.advance(Duration::from_secs(30));
            yield_once().await;
            yield_once().await;
            h.advance(Duration::from_secs(30));
            yield_once().await;
        },
    )
    .await;
    assert!(is_rej(&r1, &RejCode::MintUnavailable), "{r1:?}");
    assert!(is_rej(&r2, &RejCode::MintUnavailable), "{r2:?}");
    assert_eq!(
        answered - arrived,
        60,
        "the second answered 60 s from its arrival, its wait for the turn included"
    );
    h.unanswered_reads_take(Duration::ZERO);
    h.state_check_outage(false);
    h.restore_outage(false);
    h.release_swaps().await;
    // A retry's own resend left unanswered ends at the deadline too; and so does the NUT-07
    // check that would settle a retry refused because the payer's keyset expired.
    for check in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.unanswered_reads_take(Duration::from_secs(90));
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let arrived = h.clock_secs();
        let (r, answered) = if check {
            h.hold_next_swap_reserving();
            h.time_out_next_swap();
            h.before_next_swap(MintEvent::ExpireInputKeyset);
            h.state_check_outage(true);
            let r = s.pay(&p).await;
            (r, h.clock_secs())
        } else {
            h.hold_swap_responses();
            h.lose_next_swap_response();
            let ((r, answered), ()) = both(
                async {
                    let r = s.pay(&p).await;
                    (r, h.clock_secs())
                },
                async {
                    yield_once().await;
                    h.time_out_next_swap(); // the retry reaches the mint, and no answer comes
                    h.release_swaps().await;
                },
            )
            .await;
            (r, answered)
        };
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        assert!(
            answered - arrived <= 60,
            "answered {} s after arrival (the 12003 check {check})",
            answered - arrived
        );
        h.unanswered_reads_take(Duration::ZERO);
        h.state_check_outage(false);
        h.release_swaps().await;
    }

    // After a split read, each answer stays with its own swap: one account's claim (its
    // answer lost) and another's request the mint never processed, read one at a time.
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let claimed = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let (r, ()) = both(first.pay(&claimed), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.mint_outage(false);
    drop(first);
    let mut second = open(h, &e, 2).await;
    let held = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&second.pay(&held).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    drop(second);
    h.limit_state_reads(Some(1));
    e.sweep().await;
    h.limit_state_reads(None);
    assert!(
        !h.claimed_any(&held.token).await,
        "peer 2 still holds its proofs"
    );
    let q = open(h, &e, 2).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (0, 0),
        "peer 2 paid nothing"
    );
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (1, 1),
        "peer 1's claim is its own"
    );
    h.release_swaps().await;

    // An account's own reads are at most two a second: a flood of its hellos, or of
    // payments sending one token again, costs the mint one read, and payments of new proofs
    // no more than two. A banned peer's payment reads nothing.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.advance(SECOND);
    let before = h.state_reads();
    for _ in 0..100 {
        drop(open(h, &e, 1).await);
    }
    assert_eq!(h.state_reads() - before, 2, "a hundred hellos: one read");
    let again = h.token(1).await;
    let before = h.state_reads();
    for _ in 0..100 {
        let r = s
            .pay(&Pay {
                upto_chunk: 1,
                token: again.clone(),
            })
            .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    }
    assert_eq!(
        h.state_reads() - before,
        2,
        "a hundred payments of one token: one read"
    );
    let before = h.state_reads();
    for _ in 0..100 {
        let fresh = Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        };
        let r = {
            let mut paying = Box::pin(s.pay(&fresh));
            (0..1000).find_map(|_| poll_now(paying.as_mut()))
        };
        assert!(
            r.as_ref()
                .is_some_and(|r| is_rej(r, &RejCode::MintUnavailable)),
            "past two reads this second, a payment of new proofs is served by them, and \
             answered at once: {r:?}"
        );
    }
    assert_eq!(
        h.state_reads() - before,
        0,
        "nor a hundred of new proofs: two reads a second at most"
    );
    let mut elsewhere = open_on(h, &e, 1, 1).await;
    assert_eq!(serve_on(h, &mut elsewhere, 1, 0, 2), 2);
    let spent = h.token(2).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let r = elsewhere
        .pay(&Pay {
            upto_chunk: 2,
            token: h.reencode(&spent).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent) && elsewhere.banned(), "{r:?}");
    h.advance(SECOND);
    let before = h.state_reads();
    let r = s
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Banned), "{r:?}");
    assert_eq!(
        h.state_reads(),
        before,
        "a banned peer's payment reads nothing"
    );
    h.release_swaps().await;

    // Nor does a payment its other checks refuse: stale, a mint not quoted, a bad DLEQ,
    // underpaid or overpaid. It reads only once they have passed.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.advance(SECOND);
    let before = h.state_reads();
    let refused = [
        (0, h.token(1).await, RejCode::Stale),
        (
            1,
            h.token_at("https://other-mint.example", 1).await,
            RejCode::BadMint,
        ),
        (
            1,
            h.bad_token(BadToken::BadDleq, 1).await,
            RejCode::BadToken,
        ),
        (2, h.token(1).await, RejCode::Underpaid),
        (1, h.token(2).await, RejCode::Overpaid),
    ];
    for (upto_chunk, token, code) in refused {
        let r = s.pay(&Pay { upto_chunk, token }).await;
        assert!(is_rej(&r, &code), "{code:?}: {r:?}");
    }
    assert_eq!(
        h.state_reads(),
        before,
        "a payment its checks refuse reads nothing"
    );
    h.release_swaps().await;

    // Two a second, in a second a waiting entry crosses into as well: a payment waiting on
    // its key fetch, and a hello waiting behind it, both run in the next second, and with
    // the entries after them read at most twice in it.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.restore_outage(true); // the swap stays undecided, whatever happens at the mint
    h.advance(SECOND);
    drop(open(h, &e, 1).await); // a read, in this second
    h.hold_key_fetches();
    let p = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    let (peer, hello) = (h.peer(1), h.hello());
    let start = AtomicU64::new(0);
    let ((r, quoted), ()) = both(both(s.pay(&p), e.hello(&peer, &hello)), async {
        yield_once().await;
        h.advance(SECOND);
        start.store(h.state_reads(), Ordering::SeqCst);
        h.release_swaps().await;
        yield_once().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    drop(quoted.expect("a hello"));
    drop(open(h, &e, 1).await);
    for _ in 0..3 {
        let r = s
            .pay(&Pay {
                upto_chunk: 1,
                token: h.token(1).await,
            })
            .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    }
    assert_eq!(
        h.state_reads() - start.load(Ordering::SeqCst),
        4,
        "two reads in that second: a NUT-07 check and a restore each"
    );
    h.restore_outage(false);
    h.release_swaps().await;

    // Two hellos of one account at once share one read.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let parked = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&parked).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    h.advance(SECOND);
    let before = h.state_reads();
    let (peer, one, two) = (h.peer(1), h.hello(), h.hello());
    let (a, b) = both(e.hello(&peer, &one), e.hello(&peer, &two)).await;
    drop((a.expect("a hello"), b.expect("a hello")));
    assert_eq!(
        h.state_reads() - before,
        2,
        "one read: a NUT-07 check and a restore"
    );
    h.release_swaps().await;

    // A read is reused only by its own account: two claims whose answers were lost, one on
    // each of a peer's videos, and each video's hello in the same second learns its own.
    let e = h.engine(1, 4, 1000);
    for video in [0, 1] {
        let mut s = open_on(h, &e, 1, video).await;
        assert_eq!(serve_on(h, &mut s, video, 0, 1), 1);
        h.hold_swap_responses();
        h.lose_next_swap_response();
        let p = Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        };
        let (r, ()) = both(s.pay(&p), async {
            yield_once().await;
            h.mint_outage(true);
            h.release_swaps().await;
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        h.mint_outage(false);
    }
    h.advance(SECOND);
    for video in [0, 1] {
        let q = open_on(h, &e, 1, video).await.quote().clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (1, 1),
            "each account learns its own claim (video {video})"
        );
    }
    // And a read counts against its own account only: two on one video in a second leave
    // the peer's other video its own, so a stalled video holds up no other.
    let e = h.engine(1, 4, 1000);
    let mut zero = open_on(h, &e, 1, 0).await;
    assert_eq!(serve_on(h, &mut zero, 0, 0, 2), 2);
    h.hold_next_swap_reserving(); // undecidable for now: every read of it proves nothing
    h.time_out_next_swap();
    let r = zero
        .pay(&Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    let mut one = open_on(h, &e, 1, 1).await;
    assert_eq!(serve_on(h, &mut one, 1, 0, 1), 1);
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let p = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    let (r, ()) = both(one.pay(&p), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    h.mint_outage(false);
    h.advance(SECOND);
    drop(open_on(h, &e, 1, 0).await); // video 0's first read this second
    let r = zero
        .pay(&Pay {
            upto_chunk: 2,
            token: h.token(2).await,
        })
        .await; // and its second, for other proofs
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    let (peer, hello) = (h.peer(1), h.hello_for(1));
    let mut other_video = Box::pin(e.hello(&peer, &hello));
    let q = (0..1000)
        .find_map(|_| poll_now(other_video.as_mut()))
        .expect("video 0's two reads do not hold up video 1")
        .expect("a hello")
        .quote()
        .clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (1, 1),
        "it reads its own at once"
    );
    h.release_swaps().await;

    // So are a new peer's pre-payments, before its account exists (with, for this second,
    // the record of its reads).
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let before = h.identities_held(&e);
    h.hold_swaps();
    for _ in 0..20 {
        let p = Pay {
            upto_chunk: 2,
            token: h.token(2).await,
        };
        let (r, ()) = both(s.pay(&p), async {
            yield_once().await;
            h.advance(Duration::from_secs(60));
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    }
    assert!(
        h.identities_held(&e) <= before + 2,
        "one pre-payment in flight, not twenty"
    );
    h.release_swaps().await;
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (2, 2),
        "the one swapped is credited, late"
    );

    // What an account's reads leave behind, the record of them, goes with the rest: twenty
    // identities each read an undecided swap of their own, and once the flood has aged
    // out, nothing is held for it.
    let e = h.engine(1, 4, 1000);
    for peer in 1..=20u8 {
        let mut s = open(h, &e, peer).await;
        let p = Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        };
        h.time_out_next_swap();
        h.mint_outage(true);
        assert!(is_rej(&s.pay(&p).await, &RejCode::MintUnavailable));
        h.mint_outage(false);
        drop(s);
        assert!(h.steal(&p.token).await, "its watcher takes the proofs back");
        drop(open(h, &e, peer).await); // its hello reads, and decides it: nothing
    }
    h.advance(h.ban_ttl().max(h.account_ttl()).max(h.debt_ttl()));
    drop(open(h, &e, 200).await);
    assert_eq!(h.identities_held(&e), 0, "nothing is held for the flood");
    h.release_swaps().await;

    // A swap in flight counts whether or not its `pay` is still polled: a turn taken over
    // from a live, unpolled future is not swapped either.
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let mut second = open(h, &e, 1).await;
    serve(h, &mut first, 0, 4);
    h.hold_next_swap();
    let (p1, p2) = (
        Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        },
        Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        },
    );
    let mut unpolled = Box::pin(first.pay(&p1));
    assert!(
        poll_now(unpolled.as_mut()).is_none(),
        "its swap is in flight"
    );
    h.advance(Duration::from_secs(60));
    assert!(is_rej(&second.pay(&p2).await, &RejCode::MintUnavailable));
    assert!(
        !h.claimed_any(&p2.token).await,
        "not swapped while the first is in flight"
    );
    drop(unpolled);
    h.release_swaps().await;

    // A swap reading unspent is completed only account_ttl after it became unknown: a second
    // before, it is left alone, and its payer can still take the proofs back.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut s, 0, 1), 1);
    let p = Pay {
        upto_chunk: 1,
        token: h.token(1).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(&s.pay(&p).await, &RejCode::MintUnavailable));
    h.mint_outage(false);
    drop(s);
    h.advance(h.account_ttl() - SECOND);
    e.sweep().await;
    assert!(
        !h.claimed_any(&p.token).await,
        "a swap reading unspent is not completed a second before account_ttl"
    );
    assert!(h.steal(&p.token).await, "its payer takes the proofs back");
    e.sweep().await;
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (0, 0),
        "nothing was claimed"
    );

    a_ban_expires_on_its_own_session(h).await;
    a_lapsed_ban_refuses_no_takeover(h).await;
}

/// Flaw `TakeoverBanNotAged`. A ban lasts `ban_ttl`, and a payment's turn, a turn it takes
/// over included, checks the ban as it stands then (NFX-07 §3). P1's swap is held at the
/// mint, its watcher takes the proofs back, and its connection closes. A second later the
/// peer is banned, for a double spend on its other video. The ban lapses with nothing more
/// from the peer, until P2, which takes P1's dead turn over: it is acknowledged.
async fn a_lapsed_ban_refuses_no_takeover<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 8).await;
    let mut s2 = open(h, &e, 8).await;
    let mut other = open_on(h, &e, 8, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap();
    let p1 = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(s.pay(&p1)).await; // its connection closes, its swap in flight
    assert!(
        h.steal(&p1.token).await,
        "P1's watcher takes the proofs back"
    );
    h.advance(SECOND);
    let spent = h.token(1).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let r = other
        .pay(&Pay {
            upto_chunk: 1,
            token: spent,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    assert!(s2.banned(), "the peer is banned");
    h.advance(h.ban_ttl());
    let r = s2
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await;
    assert!(
        r.as_ref()
            .is_ok_and(|ack| (ack.accepted_upto, ack.spent_total) == (4, 4)),
        "the peer's ban lapsed before P2 took P1's dead turn over: P2 is acknowledged: {r:?}"
    );
    h.release_swaps().await;
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
    let long_debt = EngineParams {
        debt_ttl: Duration::from_secs(24 * 3600 + 1),
        account_ttl: Duration::from_secs(30 * 24 * 3600),
        ban_ttl: Duration::from_secs(30 * 24 * 3600),
        ..good
    };
    assert!(
        h.engine_checked(long_debt).is_err(),
        "a debt_ttl past 24 h is refused, whatever the other ttls: {long_debt:?}"
    );
}

/// A `hello` alone leaves no state behind: free identities cost the seeder nothing. Nor
/// does anything refused to a peer with no account: a `hello`, a request or a payment.
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
    refused_hellos_keep_nothing(h).await;
    refused_requests_keep_nothing(h).await;
    refused_payments_keep_nothing(h).await;
    unavailable_payments_keep_nothing(h).await;
}

/// Refused `hello`s leave nothing behind either: for a video not served, naming an open
/// session's id, or past the peer's session cap. None holds a place under the cap.
async fn refused_hellos_keep_nothing<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let taken = h.hello();
    let holder = e.hello(&h.peer(0), &taken).await.expect("a hello");
    let held = h.identities_held(&e);
    for p in 1..=255u8 {
        let r = e.hello(&h.peer(p), &h.unknown_hello()).await;
        assert!(is_rej(&r, &RejCode::UnknownVideo), "{:?}", r.as_ref().err());
    }
    assert_eq!(
        h.identities_held(&e),
        held,
        "free identities' hellos refused unknown-video leave nothing behind"
    );
    for p in 1..=255u8 {
        let r = e.hello(&h.peer(p), &taken).await;
        assert!(is_rej(&r, &RejCode::BadSession), "{:?}", r.as_ref().err());
    }
    assert_eq!(
        h.identities_held(&e),
        held,
        "free identities' hellos naming an open session's id leave nothing behind"
    );
    let mut sessions = Vec::new();
    for _ in 0..h.session_cap() {
        sessions.push(open(h, &e, 1).await);
    }
    for _ in 0..4 {
        let r = e.hello(&h.peer(1), &h.hello()).await;
        assert!(
            is_rej(&r, &RejCode::BadSession),
            "past the cap: {:?}",
            r.as_ref().err()
        );
    }
    sessions.clear();
    drop(holder);
    assert_eq!(
        h.identities_held(&e),
        0,
        "hellos refused past the cap leave nothing behind"
    );
    for _ in 0..h.session_cap() {
        let s = e.hello(&h.peer(1), &h.hello()).await;
        sessions.push(s.expect("refused hellos hold no place under the session cap"));
    }
}

/// Nor do refused requests of a peer with no account, for another video's file or past a
/// full global cap: an account is created by an admission, and none was made.
async fn refused_requests_keep_nothing<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut filler = open(h, &e, 0).await;
    assert_eq!(serve(h, &mut filler, 0, 4), 4, "the global cap is full");
    let held = h.identities_held(&e);
    for p in 1..=255u8 {
        let mut s = open(h, &e, p).await;
        assert!(!s.admit(&h.chunk_of(1, 0)), "another video's file");
    }
    assert_eq!(
        h.identities_held(&e),
        held,
        "free identities' requests for another video's file leave nothing behind"
    );
    for p in 1..=255u8 {
        let mut s = open(h, &e, p).await;
        assert!(!s.admit(&h.chunk(0)), "the global cap is full");
    }
    assert_eq!(
        h.identities_held(&e),
        held,
        "free identities' requests refused by the full global cap leave nothing behind"
    );
}

/// Free identities whose payments are refused by the checks, for their mint, their amount
/// or a bad token of any kind, leave nothing behind: a refused token is not claimed, so one
/// serves them all. Such a peer has no account, so its double spend then keeps no ban.
async fn refused_payments_keep_nothing<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut refusals = vec![
        (
            "bad-mint".to_owned(),
            h.token_at("https://other-mint.example", 4).await,
            RejCode::BadMint,
        ),
        ("underpaid".to_owned(), h.token(3).await, RejCode::Underpaid),
        ("overpaid".to_owned(), h.token(5).await, RejCode::Overpaid),
    ];
    for kind in [
        BadToken::WrongUnit,
        BadToken::TwoMints,
        BadToken::TooManyProofs,
        BadToken::Locked,
        BadToken::NoDleq,
        BadToken::BadDleq,
        BadToken::Garbage,
        BadToken::Forged,
    ] {
        let token = h.bad_token(kind, 4).await;
        refusals.push((format!("bad-token ({kind:?})"), token, RejCode::BadToken));
    }
    let mut peers = 0..=255u8;
    for (what, token, code) in &refusals {
        for p in peers.by_ref().take(23) {
            let mut s = open(h, &e, p).await;
            let r = s
                .pay(&Pay {
                    upto_chunk: 4,
                    token: token.clone(),
                })
                .await;
            assert!(is_rej(&r, code), "refused {what}: {r:?}");
        }
        assert_eq!(
            h.identities_held(&e),
            0,
            "free identities' payments refused {what} leave nothing behind"
        );
    }
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let mut s = open(h, &e, 1).await;
    let r = s
        .pay(&Pay {
            upto_chunk: 4,
            token: spent,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    drop(s);
    assert_eq!(
        h.identities_held(&e),
        0,
        "a peer whose payments were all refused has no account: its double spend keeps no ban"
    );
}

/// Nor do payments refused `mint-unavailable` when nothing was swapped: the mint's keys
/// late, the turn not come by the deadline, the deadline past before the swap was sent,
/// the mint down, the proofs reserved by another request, the keyset too near its expiry,
/// or a first swap refused for a keyset. Nor does a swap whose outcome was unknown once it
/// is learnt as nothing: only a claim creates the account (NFX-07 §3, late outcomes).
async fn unavailable_payments_keep_nothing<H: Harness>(h: &H) {
    let minute = Duration::from_secs(60);
    let e = h.engine(1, 4, 1000);
    let token = h.token(4).await;
    h.hold_key_fetches();
    for p in 1..=16u8 {
        let mut s = open(h, &e, p).await;
        let pay = Pay {
            upto_chunk: 4,
            token: token.clone(),
        };
        let (r, ()) = both(s.pay(&pay), async {
            yield_once().await;
            h.advance(minute);
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "no keys: {r:?}");
    }
    h.release_swaps().await;
    assert_eq!(
        h.identities_held(&e),
        0,
        "free identities' payments refused mint-unavailable for want of the mint's keys leave \
         nothing behind"
    );
    // Keys that come at the deadline are not used (NFX-07 §3). A fresh seeder has none cached.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    h.hold_key_fetches();
    {
        let pay = Pay {
            upto_chunk: 4,
            token: token.clone(),
        };
        let mut paying = pin!(s.pay(&pay));
        assert!(poll_now(paying.as_mut()).is_none(), "its keys are held");
        h.advance(minute);
        h.release_swaps().await;
        let r = paying.await;
        assert!(
            is_rej(&r, &RejCode::MintUnavailable),
            "keys at the deadline: {r:?}"
        );
    }
    drop(s);
    assert_eq!(
        h.identities_held(&e),
        0,
        "a payment whose keys came only at its deadline leaves nothing behind"
    );
    // Two payments of one account from the same second: the first holds the turn, its keys
    // held, so the second's turn never comes.
    let e = h.engine(1, 4, 1000);
    let (mut first, mut second) = (open(h, &e, 1).await, open(h, &e, 1).await);
    h.hold_key_fetches();
    {
        let (a, b) = (
            Pay {
                upto_chunk: 4,
                token: token.clone(),
            },
            Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            },
        );
        let mut holding = pin!(first.pay(&a));
        let mut waiting = pin!(second.pay(&b));
        assert!(poll_now(holding.as_mut()).is_none(), "its keys are held");
        assert!(
            poll_now(waiting.as_mut()).is_none(),
            "it waits for the turn"
        );
        h.advance(minute);
        let r = waiting.await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "no turn: {r:?}");
        let r = holding.await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "no keys: {r:?}");
    }
    h.release_swaps().await;
    drop((first, second));
    assert_eq!(
        h.identities_held(&e),
        0,
        "a payment whose turn did not come by its deadline leaves nothing behind"
    );
    // The mint down, its keys fetched (for a payment refused underpaid): no swap reaches it.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 0).await;
    let r = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(3).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Underpaid), "{r:?}");
    drop(s);
    h.mint_outage(true);
    for p in 1..=16u8 {
        let mut s = open(h, &e, p).await;
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: token.clone(),
            })
            .await;
        assert!(
            is_rej(&r, &RejCode::MintUnavailable),
            "the mint down: {r:?}"
        );
    }
    h.mint_outage(false);
    assert_eq!(
        h.identities_held(&e),
        0,
        "free identities' payments whose swaps never reached the mint leave nothing behind"
    );
    // Proofs another request holds reserved: one token serves every identity.
    let reserved = h.token(4).await;
    assert!(
        h.reserve_rest(&reserved).await,
        "another request reserves them"
    );
    for p in 17..=32u8 {
        let mut s = open(h, &e, p).await;
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: reserved.clone(),
            })
            .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "reserved: {r:?}");
        assert!(!s.banned(), "a swap refused as pending bans nobody");
    }
    h.roll_back_reserved();
    assert_eq!(
        h.identities_held(&e),
        0,
        "free identities' payments refused as pending leave nothing behind"
    );
    h.keyset_expires_in(Some(h.account_ttl()));
    for p in 33..=48u8 {
        let mut s = open(h, &e, p).await;
        let r = s
            .pay(&Pay {
                upto_chunk: 4,
                token: token.clone(),
            })
            .await;
        assert!(
            is_rej(&r, &RejCode::MintUnavailable),
            "keyset too soon: {r:?}"
        );
    }
    h.keyset_expires_in(None);
    assert_eq!(
        h.identities_held(&e),
        0,
        "free identities' payments refused for a keyset too near its expiry leave nothing \
         behind"
    );
    // A first swap refused for a keyset: the seeder's outputs', rotated out, or one that
    // expired, the seeder's or the payer's.
    let mut peers = 49..=255u8;
    for (what, event) in [
        ("rotated out", MintEvent::RotateKeyset),
        ("expired", MintEvent::ExpireKeyset),
        ("the payer's, expired", MintEvent::ExpireInputKeyset),
    ] {
        for p in peers.by_ref().take(4) {
            let fresh = h.token(4).await;
            h.before_next_swap(event);
            let mut s = open(h, &e, p).await;
            let r = s
                .pay(&Pay {
                    upto_chunk: 4,
                    token: fresh,
                })
                .await;
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{what}: {r:?}");
        }
        assert_eq!(
            h.identities_held(&e),
            0,
            "free identities' first swaps refused for a keyset {what} leave nothing behind"
        );
    }
    // A swap whose answer never came, and one abandoned in flight at the deadline, each
    // learnt as nothing: their payers took the proofs back first.
    let e = h.engine(1, 4, 1000);
    for p in 1..=4u8 {
        let lost = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        h.time_out_next_swap();
        h.mint_outage(true);
        let r = open(h, &e, p).await.pay(&lost).await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "no answer: {r:?}");
        h.mint_outage(false);
        assert!(
            h.steal(&lost.token).await,
            "its payer takes the proofs back"
        );
        h.release_swaps().await; // the given-up request finds its inputs spent
    }
    e.sweep().await;
    assert_eq!(
        h.identities_held(&e),
        0,
        "free identities' payments whose answers never came, learnt as nothing, leave nothing \
         behind"
    );
    for p in 5..=8u8 {
        let late = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        h.hold_next_swap();
        let mut s = open(h, &e, p).await;
        let (r, ()) = both(s.pay(&late), async {
            yield_once().await;
            h.advance(minute);
        })
        .await;
        assert!(is_rej(&r, &RejCode::MintUnavailable), "abandoned: {r:?}");
        assert!(
            h.steal(&late.token).await,
            "its payer takes the proofs back"
        );
        h.release_swaps().await; // the held swap finds them spent: a late nothing
    }
    assert_eq!(
        h.identities_held(&e),
        0,
        "free identities' swaps abandoned at the deadline, learnt late as nothing, leave \
         nothing behind"
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

    a_swap_learnt_as_nothing_frees_no_debt(h).await;
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

    // A payment refused before its swap frees its account's turn at once: a hello right
    // after it is answered at once.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let r = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(3).await,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Underpaid), "{r:?}");
    let (peer, hello) = (h.peer(1), h.hello());
    let answered = {
        let mut f = Box::pin(e.hello(&peer, &hello));
        (0..1000)
            .find_map(|_| poll_now(f.as_mut()))
            .map(|r| r.is_ok())
    };
    assert_eq!(
        answered,
        Some(true),
        "a refused payment frees its account's turn: a hello right after it is answered at once"
    );

    // Every hello waiting for a payment is answered once the payment is, each on a task of
    // its own: each is woken, not only polled by whoever else is.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swaps();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let (peer, one, two) = (h.peer(1), h.hello(), h.hello());
    let (d1, d2) = (AtomicBool::new(false), AtomicBool::new(false));
    let ((paid, (q1, q2)), ()) = both(
        both(
            s.pay(&p),
            both(
                own_task(marked(e.hello(&peer, &one), &d1)),
                own_task(marked(e.hello(&peer, &two), &d2)),
            ),
        ),
        async {
            yield_once().await;
            assert!(
                !d1.load(Ordering::SeqCst) && !d2.load(Ordering::SeqCst),
                "both hellos wait for the payment"
            );
            h.release_swaps().await;
            for _ in 0..1000 {
                yield_once().await;
                if d1.load(Ordering::SeqCst) && d2.load(Ordering::SeqCst) {
                    break;
                }
            }
            assert!(
                d1.load(Ordering::SeqCst) && d2.load(Ordering::SeqCst),
                "both hellos waiting for the payment are answered once it is, each on its own task"
            );
        },
    )
    .await;
    paid.expect("the payment");
    q1.expect("a hello");
    q2.expect("a hello");
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

    a_dropped_pays_double_spend_bans(h).await;
}

/// Flaw `DropAbandonsInFlight`. A payment dropped once its swap is sent (its connection
/// closed) is settled as its swap completes, and banned on (NFX-07 §3): it is not
/// abandoned. P's proofs were spent elsewhere; its swap is held, and its connection
/// closes. A second later the mint refuses the swap `spent`, in time: the peer is banned.
async fn a_dropped_pays_double_spend_bans<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    assert!(h.steal(&pay.token).await, "someone else spent it");
    h.hold_swaps();
    poll_once(s.pay(&pay)).await; // its connection closes, its swap in flight
    h.advance(SECOND);
    h.release_swaps().await; // refused spent, in time
    assert!(
        s.banned(),
        "P's swap was sent before its connection closed, and refused spent in time: the peer \
         is banned"
    );
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
    h.gather_admissions(sessions.len(), SECOND);
    let admitted: u64 = std::thread::scope(|scope| {
        let threads: Vec<_> = sessions
            .into_iter()
            .enumerate()
            .map(|(t, mut s)| {
                let barrier = &barrier;
                scope.spawn(move || {
                    keep_panic(|| {
                        barrier.wait();
                        (0..64u16)
                            .filter(|i| s.admit(&h.chunk(t as u16 * 64 + i)))
                            .count() as u64
                    })
                })
            })
            .collect();
        threads.into_iter().map(|t| rejoin(t.join())).sum()
    });
    h.gather_admissions(0, Duration::ZERO);
    assert_eq!(
        admitted, 4,
        "admissions on threads at once: exactly the window, checked and counted in one step"
    );
}

/// An account's own reads stay two a second when its entries run on threads at once: an
/// entry takes its read's place in the same look that finds one free, so entries meeting at
/// the mint cannot all have found the second's places free and all read.
pub async fn concurrent_entries_read_two_a_second<H: Harness + Sync>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = parked(h, &mut s, 4).await; // a swap every hello reads, and none can decide
    drop(s);
    h.advance(SECOND);
    let n = h.session_cap();
    // Each read waits at the mint for the others (a second at most): as many reads as
    // entries that found a place free.
    h.gather_state_reads(n, SECOND);
    let before = h.state_reads();
    let barrier = std::sync::Barrier::new(n);
    std::thread::scope(|scope| {
        let threads: Vec<_> = (0..n)
            .map(|_| {
                let (barrier, e) = (&barrier, &e);
                scope.spawn(move || {
                    keep_panic(|| {
                        let (peer, hello) = (h.peer(1), h.hello());
                        barrier.wait();
                        drop(block_on(e.hello(&peer, &hello)).expect("a hello"));
                    })
                })
            })
            .collect();
        for t in threads {
            rejoin(t.join());
        }
    });
    h.gather_state_reads(0, Duration::ZERO);
    let reads = h.state_reads() - before;
    assert!(
        reads <= 4,
        "{n} hellos on threads in one second: two reads, a NUT-07 check and a restore each, \
         not {reads} requests"
    );
    h.release_swaps().await;
    assert!(h.claimed_all(&a.token).await);

    // And two at once share one read: a read's place covers its swaps from the moment it is
    // taken, so the second waits for it rather than read again. The first read waits at the
    // mint for a second one (a second at most), which never comes.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = parked(h, &mut s, 4).await;
    drop(s);
    h.advance(SECOND);
    h.gather_state_reads(2, SECOND);
    let before = h.state_reads();
    let barrier = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let (barrier, e) = (&barrier, &e);
                scope.spawn(move || {
                    keep_panic(|| {
                        let (peer, hello) = (h.peer(1), h.hello());
                        barrier.wait();
                        drop(block_on(e.hello(&peer, &hello)).expect("a hello"));
                    })
                })
            })
            .collect();
        for t in threads {
            rejoin(t.join());
        }
    });
    h.gather_state_reads(0, Duration::ZERO);
    let reads = h.state_reads() - before;
    assert_eq!(
        reads, 2,
        "two hellos on threads at once share one read (a NUT-07 check and a restore), not \
         {reads} requests"
    );
    h.release_swaps().await;
    assert!(h.claimed_all(&a.token).await);
}

/// A viewer pays for every request it sent and the seeder did not refuse, never ahead of
/// need (except half a window after a refusal), one payment at a time.
pub async fn a_viewer_pays_for_every_request_and_no_more<H: Harness>(h: &H) {
    let e = h.engine(2, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(2);
    v.quote(s.quote()).expect("an acceptable quote");
    assert!(
        v.due()
            .await
            .expect("due answers before any request")
            .is_none(),
        "nothing requested yet"
    );
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers with two chunks requested")
        .expect("half the window is due");
    assert_eq!(pay.upto_chunk, 2, "never ahead of what was requested");
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers with a payment in flight")
            .is_none(),
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
    v.quote(s.quote())
        .expect("an honest quote is accepted at a full cap");
    for i in 0..4 {
        v.requested();
        assert!(!s.admit(&h.chunk(i)), "the cap is full");
        v.refused();
    }
    assert!(
        v.last_pay()
            .await
            .expect("last_pay answers after refusals")
            .is_none(),
        "refused requests are not owed"
    );
    let ahead = v
        .due()
        .await
        .expect("due answers after a refusal")
        .expect("refused, it pays ahead");
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
    v.quote(s.quote()).expect("an honest quote is accepted");
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
    v.quote(s.quote()).expect("an honest quote is accepted");
    let admitted = (0..4)
        .filter(|i| {
            v.requested();
            s.admit(&h.chunk(*i))
        })
        .count();
    assert_eq!(admitted, 3, "the fourth is refused");
    let pay = v
        .due()
        .await
        .expect("due answers with four chunks requested")
        .expect("half the window is due");
    assert_eq!(pay.upto_chunk, 4);
    v.ack(&s.pay(&pay).await.expect("accepted"))
        .expect("the honest ack is taken, overtaking the refusal");
    v.refused();
    v.requested();
    assert!(s.admit(&h.chunk(3)), "the retry is served from the credit");
    assert!(
        v.last_pay()
            .await
            .expect("last_pay answers with every request paid for")
            .is_none(),
        "nothing more is owed"
    );
}

/// A viewer pays ahead only right after a refusal. It checks the seeder's ack of that
/// payment like any other, takes the honest one, and holding the credit it answers `due`
/// with nothing owed (NFX-07 §3a). Once the cap frees it goes back to paying for what it
/// requested, and ends holding no credit.
pub async fn a_viewer_pays_ahead_only_after_a_refusal<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut crowd = open(h, &e, 9).await;
    assert_eq!(serve(h, &mut crowd, 0, 4), 4, "the cap is full");
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote())
        .expect("an honest quote is accepted at a full cap");
    v.requested();
    assert!(!s.admit(&h.chunk(0)));
    v.refused();
    let ahead = v
        .due()
        .await
        .expect("due answers after a refusal")
        .expect("refused, it pays ahead");
    v.ack(&s.pay(&ahead).await.expect("accepted"))
        .expect("the seeder's honest ack of a pay-ahead is taken");
    assert!(!v.stopped(), "its pay-ahead acked, it goes on paying");
    assert!(
        v.due()
            .await
            .expect("holding credit, due answers")
            .is_none(),
        "holding its pay-ahead as credit, it owes nothing: nothing is due"
    );
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
    // Half a window, rounded down: on a window of 5, two chunks ahead.
    let s = open(h, &h.engine(1, 5, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.refused();
    let ahead = v
        .due()
        .await
        .expect("due answers after a refusal")
        .expect("pays ahead");
    assert_eq!(ahead.upto_chunk, 2, "never beyond half the window");
}

/// A viewer that has streamed 4 chunks and ended its session, and the quote its next
/// session gets.
async fn resumed_viewer<H: Harness>(h: &H) -> (H::Viewer, Quote) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(2);
    v.quote(s.quote()).expect("an honest quote is accepted");
    stream(h, &mut s, &mut v, 0, 4).await;
    drop(s);
    v.end();
    let q = open(h, &e, 1).await.quote().clone();
    (v, q)
}

/// A viewer refuses, without stopping, a quote over its cap, one naming no mint it holds,
/// one whose `window` is over its ceiling, on a resumed session too, and a second quote in
/// the same session, whatever it claims. It refuses, and stops on, a quote whose account
/// position disagrees with its ledger, a lower one on resume included. Its mint is named by
/// its exact URL only.
pub async fn a_viewer_refuses_quotes_it_cannot_honour<H: Harness>(h: &H) {
    let fair = open(h, &h.engine(1, 8, 1000), 1).await.quote().clone();
    let mut v = h.viewer(2);
    let mut dear = fair.clone();
    dear.price_per_chunk = 3;
    assert!(v.quote(&dear).is_err(), "over its price cap");
    assert!(!v.stopped(), "refused over its price cap, not stopped");
    let mut elsewhere = fair.clone();
    elsewhere.mints = vec!["https://unknown-mint.example".into()];
    assert!(v.quote(&elsewhere).is_err(), "no mint it holds");
    v.quote(&fair).expect("a fair quote");
    assert!(v.quote(&fair).is_err(), "one quote per session");
    let mut lying = fair.clone();
    lying.served = 5;
    assert!(
        v.quote(&lying).is_err() && !v.stopped(),
        "a second quote on the open session is refused whatever it claims, and it does not stop"
    );

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

    let lower: [fn(&mut Quote); 2] = [
        |q| q.accepted_upto = q.accepted_upto.saturating_sub(2),
        |q| q.spent_total = q.spent_total.saturating_sub(2),
    ];
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
    assert!(
        !v.stopped(),
        "refused over its price cap on resume, not stopped"
    );
    let (mut v, mut q) = resumed_viewer(h).await;
    q.mints = vec!["https://unknown-mint.example".into()];
    assert!(v.quote(&q).is_err(), "no mint it holds, on resume too");
    assert!(!v.stopped(), "refused for its mints on resume, not stopped");

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
    assert!(
        !v2.stopped(),
        "refused over its ceiling on resume, not stopped"
    );
    v.requested();
    v.refused();
    let ahead = v
        .due()
        .await
        .expect("due answers after a refusal")
        .expect("refused, it pays ahead");
    assert!(
        ahead.upto_chunk <= ceiling.div_ceil(2),
        "half its ceiling at most: {}",
        ahead.upto_chunk
    );

    // A quote whose served exceeds the chunks requested by just one is dishonest too.
    let e = h.engine(1, 8, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(2);
    v.quote(s.quote()).expect("a fair quote");
    for i in 0..3u16 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    drop(s);
    v.end();
    let mut q = open(h, &e, 1).await.quote().clone();
    assert_eq!(q.served, 3, "the seeder's own count");
    q.served = 4;
    assert!(
        v.quote(&q).is_err() && v.stopped(),
        "a quote claiming one chunk more than was requested is dishonest: refused, and it stops"
    );

    a_quote_names_its_mint_by_its_exact_url(h).await;
}

/// A quote names the viewer's mint only by its exact URL (NFX-07 §2), wherever it stands in
/// the list: one naming its mint among others is taken, and one naming only a lookalike of
/// it is refused, without stopping.
async fn a_quote_names_its_mint_by_its_exact_url<H: Harness>(h: &H) {
    let fair = open(h, &h.engine(1, 8, 1000), 1).await.quote().clone();
    let m = h.mint();
    let mut several = fair.clone();
    several.mints = vec![
        "https://other-mint.example".into(),
        m.clone(),
        "https://third-mint.example".into(),
    ];
    h.viewer(2)
        .quote(&several)
        .expect("a quote naming its mint among others is taken");
    for url in [
        format!("{m}.attacker.example"),
        format!("{m}/"),
        format!("{m}:443"),
        format!(
            "https://{}",
            m.trim_start_matches("https://").to_uppercase()
        ),
    ] {
        let mut lookalike = fair.clone();
        lookalike.mints = vec![url.clone()];
        let mut v = h.viewer(2);
        assert!(
            v.quote(&lookalike).is_err() && !v.stopped(),
            "{url} names no mint it holds: refused, and it does not stop"
        );
    }
}

/// A viewer stops paying a seeder whose `ack` is unsolicited, or does not match the
/// payment's `accepted_upto` or `spent_total`, whether short or inflated. An ack short of
/// the payment is wrong even when it is above the ledger: in `accepted_upto`, in
/// `spent_total`, or in both at the quoted price. So is one below the ledger, in either
/// field.
pub async fn a_viewer_stops_on_a_wrong_or_unsolicited_ack<H: Harness>(h: &H) {
    let mut unsolicited = h.viewer(1);
    unsolicited
        .quote(open(h, &h.engine(1, 2, 1000), 1).await.quote())
        .expect("an honest quote is accepted");
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
        |a| a.accepted_upto = a.accepted_upto.saturating_sub(1),
        |a| a.spent_total = a.spent_total.saturating_add(1),
        |a| a.accepted_upto = a.accepted_upto.saturating_add(1000),
        |a| a.spent_total = a.spent_total.saturating_add(1000),
    ];
    for tamper in tampers {
        let e = h.engine(1, 2, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("an honest quote is accepted");
        assert!(s.admit(&h.chunk(0)));
        v.requested();
        let pay = v.due().await.expect("due answers").expect("due");
        let mut ack = s.pay(&pay).await.expect("an honest payment is accepted");
        tamper(&mut ack);
        assert!(v.ack(&ack).is_err());
        assert!(v.stopped());
        v.requested();
        assert!(
            v.due().await.expect("due answers once stopped").is_none(),
            "no more payments"
        );
    }
    // With 4 chunks acknowledged at 1 sat each, a payment up to chunk 8 (4 sat) acked short
    // of it, though above the ledger: at chunk 5 with the payment's total, at chunk 5 with
    // a total short by chunks 6 to 8 (the fields agree at the price), or at chunk 8 with a
    // total short by 1. Taken, the first two would have the watcher pay chunks 6 to 8 again.
    // Or acked at or below the ledger: at chunk 2 with the payment's total, at chunk 8 with
    // a total below the ledger's or equal to it, at the ledger in both fields, or below it
    // in both. Taken, the first and the last would have it pay chunks 3 to 8 again, and the
    // third chunks 5 to 8.
    for (accepted_upto, spent_total, wrong) in [
        (
            5,
            8,
            "an ack short of the payment's upto_chunk, though above the ledger",
        ),
        (
            5,
            5,
            "an ack short of the payment in both fields, at its price",
        ),
        (
            8,
            7,
            "an ack whose spent_total is short of the ledger's plus the payment's, though above \
             the ledger's",
        ),
        (
            2,
            8,
            "an ack whose accepted_upto is below the ledger's, with the payment's total",
        ),
        (
            8,
            3,
            "an ack whose spent_total is below the ledger's, at the payment's upto_chunk",
        ),
        (
            8,
            4,
            "an ack whose spent_total equals the ledger's, at the payment's upto_chunk",
        ),
        (
            4,
            4,
            "an ack equal to the ledger, as if the payment were not taken",
        ),
        (2, 2, "an ack below the ledger in both fields"),
    ] {
        let e = h.engine(1, 8, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("an honest quote is accepted");
        for i in 0..4 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        let first = v
            .due()
            .await
            .expect("due answers with four chunks requested")
            .expect("due");
        v.ack(&s.pay(&first).await.expect("accepted"))
            .expect("the honest ack of the first payment is taken"); // the ledger: 4, 4
        for i in 4..8 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        let pay = v
            .due()
            .await
            .expect("due answers with eight chunks requested")
            .expect("due");
        assert_eq!(pay.upto_chunk, 8);
        let ack = s.pay(&pay).await.expect("accepted");
        assert_eq!(
            (ack.accepted_upto, ack.spent_total),
            (8, 8),
            "the seeder's own ack matches the payment"
        );
        let ack = Ack {
            accepted_upto,
            spent_total,
        };
        assert!(
            v.ack(&ack).is_err() && v.stopped(),
            "{wrong}, does not match: refused, and it stops"
        );
    }
}

/// A viewer reclaims every proof of a refused payment, whatever the code, known or not,
/// so a seeder that refuses and then claims gets nothing. It stops paying that seeder,
/// except after `mint-unavailable`. Proofs its own unanswered reclaim took back are not
/// lost: a restore of its outputs shows them. A refusal because a keyset expired is
/// decided per proof, the watcher's own reclaims counted as back, and proofs listed
/// expired, those the wallet still holds included, are never paid with, while the good ones
/// it holds are kept. A proof spent beside others pending keeps the reclaim incomplete,
/// whether or not a keyset has expired. A reclaim goes to the mint's active keyset,
/// whatever the proofs' own.
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
        v.quote(s.quote()).expect("an honest quote is accepted");
        v.requested();
        let pay = v.due().await.expect("due answers").expect("due");
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
    // A reclaim whose answer is lost is retried, and the retry finds the proofs spent by
    // the watcher itself: a restore of its outputs shows they are back, and it pays on.
    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let first = v.due().await.expect("due answers").expect("due");
    h.lose_next_reclaim_response();
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        h.claimed_all(&first.token).await && !h.steal(&first.token).await,
        "the unanswered reclaim went through"
    );
    assert!(
        v.due()
            .await
            .expect("due answers after its own reclaim went through")
            .is_some()
            && !v.awaiting_quote(),
        "its own reclaim is not a loss: it pays again"
    );
    // An unanswered restore says nothing: not that its own reclaim took the proofs...
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.mint_outage(true);
    let rej = s.pay(&pay).await.expect_err("mint-unavailable");
    h.mint_outage(false);
    h.lose_next_reclaim_response();
    h.restore_outage(true);
    v.rej(&rej).await;
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers with its reclaim incomplete")
            .is_none(),
        "the reclaim is still incomplete"
    );
    assert!(
        !v.stopped() && !v.awaiting_quote(),
        "nor that someone else spent them"
    );
    h.restore_outage(false);
    let again = v
        .due()
        .await
        .expect("due answers once the mint answers restores again")
        .expect("its proofs are back: it pays again");
    v.ack(&s.pay(&again).await.expect("accepted"))
        .expect("the honest ack is taken");
    // ...nor that they are back, when the seeder kept them.
    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let pay = v.due().await.expect("due answers").expect("due");
    assert!(h.steal(&pay.token).await, "the seeder keeps it");
    h.restore_outage(true);
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers while the restore goes unanswered")
            .is_none(),
        "nothing more is paid while the restore goes unanswered"
    );
    h.restore_outage(false);
    assert!(
        v.due()
            .await
            .expect("due answers once the mint answers restores again")
            .is_none()
            && v.awaiting_quote(),
        "then it awaits a quote"
    );
    // A reclaim refused because the proofs' keyset expired (CDK 12003) is decided by a
    // NUT-07 check. Every proof unspent: they are lost to the expiry, not taken by the
    // seeder, so the reclaim is complete and the watcher pays again.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.before_next_swap(MintEvent::ExpireKeyset);
    let rej = s
        .pay(&pay)
        .await
        .expect_err("its proofs' keyset has expired");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(!v.stopped(), "the seeder took nothing");
    for i in 2..4 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    assert!(
        v.due()
            .await
            .expect("due answers after the proofs' keyset expired")
            .is_some(),
        "the proofs lost to the expiry, it pays again"
    );
    // A reclaim whose answer is lost, and whose outputs' keyset expires before the retry:
    // a restore no longer shows them, so the watcher cannot tell its own reclaim from the
    // seeder's claim. It treats the proofs as found spent and awaits a quote, keeping its
    // bound (a seeder takes at most that one payment); whichever it was, their value is gone
    // from the watcher, to the seeder or with the outputs' keyset.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.mint_outage(true);
    let rej = s.pay(&pay).await.expect_err("the mint is down");
    h.mint_outage(false);
    h.lose_next_reclaim_response();
    v.rej(&rej).await; // its reclaim goes through; the answer is lost, so it is retried
    h.expire_keyset();
    for i in 2..4 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    assert!(
        v.due()
            .await
            .expect("due answers after the outputs' keyset expired")
            .is_none()
            && v.awaiting_quote(),
        "it awaits a quote, paying nothing more"
    );
    // A 12003 may be the reclaim's outputs' keyset: the mint's active one expired, and kept
    // active (as CDK does), while the proofs' older keyset is good. The proofs are lost to
    // the expiry only if the mint lists their own keyset as expired; here the reclaim is
    // incomplete, and it takes them back once the mint rotates.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.rotate_keyset(); // its proofs now of an older keyset
    h.expire_active_keyset();
    let rej = s.pay(&pay).await.expect_err("no keyset to swap to");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(!h.claimed_any(&pay.token).await, "the proofs are unspent");
    for i in 2..4 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    assert!(
        v.due()
            .await
            .expect("due answers with its reclaim incomplete")
            .is_none(),
        "its reclaim incomplete, it pays nothing more"
    );
    h.rotate_keyset();
    let next = v.due().await.expect("due answers once the mint rotates");
    assert!(
        h.claimed_all(&pay.token).await,
        "once the mint rotates, it takes its proofs back"
    );
    assert!(next.is_some(), "and pays again");
    // CDK's common case: the watcher pays in proofs of the mint's active keyset, which then
    // expires and stays active. Its proofs are listed expired: lost to the expiry, though the
    // reclaim's outputs' keyset has expired too. It pays again at once, with proofs it holds
    // of an older keyset.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers in the active keyset's proofs")
        .expect("due, in proofs of the active keyset");
    h.expire_active_keyset();
    let rej = s.pay(&pay).await.expect_err("no keyset to swap to");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    h.fund_older_keyset(1000);
    v.rej(&rej).await;
    assert!(
        !h.claimed_any(&pay.token).await,
        "nothing taken back: its proofs are listed expired"
    );
    for i in 2..4 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    assert!(
        v.due()
            .await
            .expect("due answers after the active keyset expired")
            .is_some(),
        "its proofs lost to the expiry, it pays again, with an older keyset's proofs"
    );
    h.rotate_keyset();
    h.fund_older_keyset(0);
    // A watcher whose only proofs are of the expired active keyset pays nothing: they are
    // worth nothing. Once the mint rotates, it pays with proofs of the new one.
    h.expire_active_keyset();
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    assert!(
        v.due()
            .await
            .expect("due answers holding only expired proofs")
            .is_none(),
        "its only proofs are listed expired: worth nothing, never paid with"
    );
    h.rotate_keyset();
    let pay = v
        .due()
        .await
        .expect("due answers once the mint rotates")
        .expect("once the mint rotates, it pays, in proofs of the new keyset");
    let ack = s.pay(&pay).await.expect("swapped");
    assert_eq!((ack.accepted_upto, ack.spent_total), (2, 2));
    v.ack(&ack).expect("the honest ack is taken");
    // A token of two keysets, one expired (a wallet spends an older keyset's proofs first):
    // decided per proof. The expired one is lost; the other is taken back, and the watcher
    // pays again.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..3 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due: 3 sat, two proofs");
    h.expire_keyset_of(&pay.token, 1);
    let rej = s
        .pay(&pay)
        .await
        .expect_err("one input's keyset has expired");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(
        h.claimed_any(&pay.token).await && !h.claimed_all(&pay.token).await,
        "the good proof is taken back, the expired one left"
    );
    assert!(s.admit(&h.chunk(3)));
    v.requested();
    let next = v
        .due()
        .await
        .expect("due answers after a proof's keyset expired")
        .expect("complete, the seeder having taken nothing: it pays again");
    // Never with the proof lost to the expiry: it is worth nothing, and a payment holding
    // it would be refused (12003) and answered `mint-unavailable`.
    let ack = s
        .pay(&next)
        .await
        .expect("its payment holds no proof listed expired: swapped");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    v.ack(&ack).expect("the honest ack is taken");

    // The same token, its good proof's reclaim going through with the answer lost: the
    // retry is refused (12003) with that proof spent. A restore shows it the watcher's own,
    // so nothing was taken by the seeder: the other proof, unspent and listed expired, is
    // lost to the expiry, and the watcher pays again, awaiting no quote.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..3 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due: 3 sat, two proofs");
    h.expire_keyset_of(&pay.token, 1);
    let rej = s
        .pay(&pay)
        .await
        .expect_err("one input's keyset has expired");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    h.lose_next_reclaim_response();
    v.rej(&rej).await;
    assert!(
        h.claimed_any(&pay.token).await && !h.claimed_all(&pay.token).await,
        "the good proof is taken back (its answer lost), the expired one left"
    );
    assert!(s.admit(&h.chunk(3)));
    v.requested();
    let next = v
        .due()
        .await
        .expect("due answers after a proof's keyset expired");
    assert!(
        !v.awaiting_quote(),
        "the seeder took nothing: its own reclaim has the good proof, the other is lost to the expiry"
    );
    assert!(next.is_some(), "and it pays again");

    // The same token while the mint's active keyset has expired too: the good proof cannot
    // be taken back yet (no keyset for the reclaim's outputs), so the reclaim is
    // incomplete, and the watcher pays nothing until the mint rotates and it completes.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..3 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due: 3 sat, two proofs");
    h.expire_keyset_of(&pay.token, 1);
    h.rotate_keyset(); // the good proof now of an older keyset
    h.expire_active_keyset();
    let rej = s.pay(&pay).await.expect_err("refused");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(!h.claimed_any(&pay.token).await, "nothing taken back yet");
    assert!(s.admit(&h.chunk(3)));
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers with its reclaim incomplete")
            .is_none(),
        "the good proof not yet taken back: the reclaim is incomplete, and it pays nothing"
    );
    h.rotate_keyset();
    assert!(
        v.due()
            .await
            .expect("due answers once the mint rotates")
            .is_some(),
        "then it pays again"
    );
    assert!(
        h.claimed_any(&pay.token).await && !h.claimed_all(&pay.token).await,
        "the good proof taken back, the expired one left"
    );

    // After a 12003, "back" is decided per spent input. A seeder keeps one proof of a
    // two-proof payment and answers `mint-unavailable`; the watcher's reclaim takes the
    // other back, its answer lost; the kept proof's keyset expires before the retry, which is
    // refused 12003 with every input spent, one of them not the watcher's: it awaits a quote.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for _ in 0..3 {
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due: 3 sat, two proofs");
    assert!(h.steal_one(&pay.token).await, "the seeder keeps one proof");
    h.lose_next_reclaim_response();
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        h.claimed_all(&pay.token).await,
        "the watcher took the rest back, its answer lost"
    );
    h.expire_keyset_of(&pay.token, 1);
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers after a spent input not its own")
            .is_none()
            && v.awaiting_quote(),
        "a spent input not its own: it awaits a quote, paying nothing more"
    );
    drop(s);

    // A seeder keeps one proof of a three-proof payment and answers `mint-unavailable`: the
    // watcher awaits a quote, and takes back the inputs left, unspent and not listed expired,
    // whether or not a keyset has expired meanwhile (the retry refused 12003).
    for expire in [false, true] {
        let e = h.engine(7, 2, 1000);
        let s = open(h, &e, 1).await;
        let mut v = h.viewer(7);
        v.quote(s.quote()).expect("an honest quote is accepted");
        v.requested();
        let pay = v
            .due()
            .await
            .expect("due answers")
            .expect("due: 7 sat, three proofs");
        assert!(h.steal_one(&pay.token).await, "the seeder keeps one proof");
        if expire {
            h.expire_keyset_of(&pay.token, 1);
        }
        v.rej(&Rej {
            code: RejCode::MintUnavailable,
            detail: None,
        })
        .await;
        assert!(v.awaiting_quote(), "part of it was kept: it awaits a quote");
        assert!(
            h.claimed_all(&pay.token).await,
            "the watcher took back the rest (a keyset expired: {expire})"
        );
        drop(s);
    }

    // A 12003 with an input pending (the seeder's request, reserved by the mint before the
    // payer's keyset expired, still signs), or with its NUT-07 check unanswered: nothing is
    // decided, so the reclaim is incomplete, never written off to the expiry. Once the mint
    // finishes the request, the proofs are found spent, and a quote settles the payment.
    for check_down in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("an honest quote is accepted");
        for i in 0..2 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        let pay = v.due().await.expect("due answers").expect("due");
        h.hold_next_swap_reserving();
        let (r, ()) = both(s.pay(&pay), async {
            yield_once().await;
            h.advance(Duration::from_secs(60));
        })
        .await;
        let rej = r.expect_err("no answer within 60 s");
        assert_eq!(rej.code, RejCode::MintUnavailable);
        h.expire_keyset_of(&pay.token, 64); // reserved first, then the payer's keyset expired
        h.state_check_outage(check_down);
        v.rej(&rej).await;
        assert!(
            !v.stopped()
                && v.due()
                    .await
                    .expect("due answers with an input pending")
                    .is_none(),
            "a 12003 with an input pending, or its check unanswered ({check_down}): the reclaim \
             is incomplete, and nothing is paid"
        );
        h.state_check_outage(false);
        h.release_swaps().await;
        assert!(
            h.claimed_all(&pay.token).await,
            "the reserved request signed"
        );
        assert!(
            v.due()
                .await
                .expect("due answers once the reserved request is signed")
                .is_none()
                && v.awaiting_quote(),
            "found spent by the seeder's request: it awaits a quote"
        );
        drop(s);
        v.end();
        h.advance(SECOND);
        let mut s = open(h, &e, 1).await;
        assert_eq!(
            (s.quote().accepted_upto, s.quote().spent_total),
            (2, 2),
            "the claim is credited"
        );
        v.quote(s.quote()).expect("the quote settles it");
        stream(h, &mut s, &mut v, 2, 4).await;
        assert!(!v.stopped() && !s.banned());
    }

    // Older-keyset proofs outlive the active keyset's expiry and its rotation; the rest of a
    // payment a seeder kept part of is taken back once it can be; and the session's last
    // payment never uses proofs listed expired either.
    older_proofs_reclaimed_after_rotation(h).await;
    older_proofs_swapped_after_rotation(h).await;
    foreign_rest_taken_back_after_rotation(h).await;
    last_pay_never_with_expired_proofs(h).await;

    a_pending_rest_keeps_the_reclaim_incomplete(h, true).await;

    // Proofs the wallet still holds of an expired older keyset are never paid with; and a
    // reclaim goes to the mint's active keyset at once, whatever the proofs' own keyset.
    held_expired_proofs_never_paid_with(h).await;
    older_proofs_reclaimed_into_an_expiring_keyset(h).await;

    // With no keyset expired too, a spent input beside inputs left pending keeps the reclaim
    // incomplete. And good proofs the wallet holds are kept when it drops the expired ones.
    a_pending_rest_keeps_the_reclaim_incomplete(h, false).await;
    good_held_proofs_kept_beside_expired(h).await;
}

/// A viewer waits exactly 180 s for an answer on a live connection, then reclaims its
/// payment and stops. If the seeder had swapped it and the answer was lost, the viewer
/// stops without paying those chunks again, and nobody is banned.
pub async fn a_viewer_reclaims_an_unanswered_payment<H: Harness>(h: &H) {
    let s = open(h, &h.engine(3, 2, 1000), 1).await;
    let mut v = h.viewer(3);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    let pay = v.due().await.expect("due answers").expect("due");
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
    v.quote(s.quote()).expect("an honest quote is accepted");
    assert!(s.admit(&h.chunk(0)));
    v.requested();
    let pay = v.due().await.expect("due answers").expect("due");
    let _lost = s.pay(&pay).await.expect("swapped and acknowledged");
    h.advance(Duration::from_secs(180));
    v.timeout().await;
    assert!(v.stopped() && !s.banned());
    assert!(
        v.last_pay()
            .await
            .expect("last_pay answers after the timeout")
            .is_none(),
        "not paid twice"
    );
}

/// A payment left unsettled by a dropped connection, never seen by the seeder, is
/// reclaimed at 180 s and not before; then the viewer pays again and carries on.
pub async fn a_viewer_settles_a_lost_payment_after_180_s<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let lost = v.due().await.expect("due answers").expect("due");
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("the seeder never saw it");
    h.advance(Duration::from_secs(179));
    assert!(
        v.due()
            .await
            .expect("due answers with a lost payment at 179 s")
            .is_none(),
        "still waiting at 179 s"
    );
    assert!(!h.claimed_any(&lost.token).await, "and not reclaimed");
    h.advance(Duration::from_secs(1));
    let again = v
        .due()
        .await
        .expect("due answers at 180 s")
        .expect("reclaimed at 180 s, then paid again");
    assert!(
        h.claimed_all(&lost.token).await,
        "the lost proofs came back"
    );
    v.ack(&s.pay(&again).await.expect("accepted"))
        .expect("the honest ack is taken");
    assert!(!v.stopped());
}

/// After a dropped connection, a quote settles the payment in flight only if both its
/// `accepted_upto` and its `spent_total` show it. A quote matching on one alone stops the
/// viewer. A quote equal to the ledger settles nothing: a reclaim it finds incomplete stays
/// so.
pub async fn a_viewer_settles_only_on_an_exact_match<H: Harness>(h: &H) {
    for lie in ["spent only", "upto only"] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("an honest quote is accepted");
        for i in 0..2 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        v.due().await.expect("due answers").expect("due");
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
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let pay = v.due().await.expect("due answers").expect("due");
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
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let pay = v.due().await.expect("due answers").expect("due");
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
    assert!(v.stopped() && v.due().await.expect("due answers once stopped").is_none());

    // The same for a payment whose reclaim is incomplete: both fields, on its own video.
    for lie in ["spent only", "upto only", "another video"] {
        let e = h.engine(1, 4, 1000);
        let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
        let mut v0 = h.viewer(1);
        let mut v1 = v0.sibling();
        v0.quote(s0.quote())
            .expect("video 0's honest quote is accepted");
        v1.quote(s1.quote())
            .expect("video 1's honest quote is accepted");
        v0.requested();
        v0.requested();
        let pay = v0.due().await.expect("due answers").expect("due");
        h.mint_outage(true);
        v0.rej(&Rej {
            code: RejCode::MintUnavailable,
            detail: None,
        })
        .await;
        assert!(!v0.stopped(), "a blocked reclaim is not a stop");
        drop((s0, s1));
        v0.end();
        v1.end();
        let refused = if lie == "another video" {
            let mut q = open_on(h, &e, 1, 1).await.quote().clone();
            (q.accepted_upto, q.spent_total) = (pay.upto_chunk, 2);
            v1.quote(&q).is_err()
        } else {
            let mut q = open_on(h, &e, 1, 0).await.quote().clone();
            if lie == "spent only" {
                q.spent_total = 2;
            } else {
                q.accepted_upto = pay.upto_chunk;
            }
            v0.quote(&q).is_err()
        };
        assert!(refused, "{lie}: not a settlement");
        h.mint_outage(false);
        v0.requested();
        assert!(
            v0.due()
                .await
                .expect("due answers once the mint is back")
                .is_none(),
            "{lie}: nothing more is paid"
        );
    }

    a_settling_quote_matches_both_fields(h).await;
    a_quote_at_the_ledger_leaves_the_reclaim_incomplete(h).await;
}

/// A quote equal to the ledger leaves an incomplete reclaim in place: the watcher pays
/// nothing more until it completes, lest the seeder claim the proofs and be paid again. A
/// payment is refused while the mint is down, so its reclaim is incomplete, and the next
/// session's quote shows the ledger without the payment.
async fn a_quote_at_the_ledger_leaves_the_reclaim_incomplete<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("a fair quote");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.mint_outage(true);
    let rej = s.pay(&pay).await.expect_err("the mint is down");
    v.rej(&rej).await;
    drop(s);
    v.end();
    let s = open(h, &e, 1).await;
    assert_eq!(
        (s.quote().accepted_upto, s.quote().spent_total),
        (0, 0),
        "the seeder took nothing"
    );
    v.quote(s.quote()).expect("a quote at the ledger is honest");
    assert!(
        v.due().await.expect("due answers").is_none(),
        "a quote at the ledger leaves the reclaim incomplete: nothing is paid"
    );
    h.mint_outage(false);
    let again = v.due().await.expect("due answers");
    assert!(
        h.claimed_all(&pay.token).await,
        "once the mint is back, the reclaim completes"
    );
    assert!(again.is_some(), "and it pays again");
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
        v.quote(s.quote()).expect("an honest quote is accepted");
        for _ in 0..2 {
            v.requested();
        }
        let pay = v.due().await.expect("due answers").expect("due");
        assert!(h.steal(&pay.token).await, "the seeder swapped it");
        v.rej(&Rej {
            code: code.clone(),
            detail: None,
        })
        .await;
        assert!(v.stopped(), "{code:?} after a swap: nothing more is paid");
        v.requested();
        assert!(
            v.due().await.expect("due answers once stopped").is_none()
                && v.last_pay()
                    .await
                    .expect("last_pay answers once stopped")
                    .is_none(),
            "never paid again ({code:?})"
        );
        // A quote that does not show the payment leaves it lost, however honest.
        drop(s);
        v.end();
        v.quote(open(h, &e, 1).await.quote())
            .expect("a quote equal to the ledger");
        v.requested();
        assert!(
            v.stopped()
                && v.due()
                    .await
                    .expect("due answers after a quote equal to the ledger")
                    .is_none(),
            "still nothing paid: the seeder kept that one payment ({code:?})"
        );
    }

    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for _ in 0..2 {
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
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
        v.due()
            .await
            .expect("due answers after a refusal, its reclaim incomplete")
            .is_none(),
        "no pay-ahead while a reclaim is incomplete"
    );
    assert!(
        v.last_pay()
            .await
            .expect("last_pay answers with its reclaim incomplete")
            .is_none(),
        "no payment at session end either"
    );
    h.mint_outage(false);
    assert!(
        v.due()
            .await
            .expect("due answers once the mint is back")
            .is_none()
            && v.stopped(),
        "the retried reclaim finds the proofs spent: lost, and stopped"
    );

    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for _ in 0..2 {
        v.requested();
    }
    v.due().await.expect("due answers").expect("due");
    v.requested();
    v.refused();
    assert!(
        v.due()
            .await
            .expect("due answers after a refusal, a payment in flight")
            .is_none(),
        "one payment in flight at a time, refusal or not"
    );
    // A seeder that keeps part of a payment and answers `mint-unavailable`: the reclaim
    // takes back the rest, but not all came back, so the payment awaits a quote, and
    // nothing more is paid.
    let s = open(h, &h.engine(3, 4, 1000), 1).await;
    let mut v = h.viewer(3);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due: 6 sat, two proofs");
    assert!(h.steal_one(&pay.token).await, "the seeder keeps one proof");
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        h.claimed_all(&pay.token).await,
        "the watcher took back the rest"
    );
    assert!(v.awaiting_quote(), "part of it was kept: it awaits a quote");
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers awaiting a quote")
            .is_none(),
        "and nothing more is paid"
    );
}

/// A seeder that refuses every request, while acknowledging every payment, gets at most
/// the half window of credit a refusal lets the viewer pay ahead.
pub async fn a_refusing_seeder_takes_at_most_half_a_window<H: Harness>(h: &H) {
    let (price, window) = (3, 4);
    let e = h.engine(price, window, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(price);
    v.quote(s.quote()).expect("an honest quote is accepted");
    let mut paid = 0;
    for _ in 0..100 {
        v.requested();
        v.refused();
        if let Some(pay) = v.due().await.expect("due answers after each refusal") {
            let ack = s.pay(&pay).await.expect("the seeder takes it");
            v.ack(&ack)
                .expect("the seeder's honest ack of a pay-ahead is taken");
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
/// the budget bounds those costs. A new session's accepted quote starts the count again,
/// and an ack resets it; nothing else does, a ledger made for another video included.
pub async fn an_unavailable_seeder_gets_three_tries_a_session<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    let mu = Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    };
    v.requested();
    v.requested();
    let mut tries = 0;
    while let Some(pay) = v.due().await.expect("due answers, tries left or not") {
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
        v.last_pay()
            .await
            .expect("last_pay answers out of tries")
            .is_none(),
        "not even at the session's end"
    );
    drop(s);
    v.end();
    s = open(h, &e, 1).await;
    v.quote(s.quote())
        .expect("a new session's honest quote is accepted");
    let pay = v
        .due()
        .await
        .expect("due answers in a new session")
        .expect("a new session, a new try");
    v.ack(&s.pay(&pay).await.expect("this time the seeder takes it"))
        .expect("the honest ack is taken");
    // Refusals in between reset nothing, and pay-ahead is held to the count too.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    let mut tries = 0;
    for _ in 0..10 {
        v.requested();
        v.refused();
        if v.due()
            .await
            .expect("due answers after each refusal")
            .is_some()
        {
            tries += 1;
            v.rej(&mu).await;
        }
    }
    assert_eq!(tries, 3, "three tries, refusals or not");
    // Nor do refused hellos.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let mut tries = 0;
    while v
        .due()
        .await
        .expect("due answers, refused hellos or not")
        .is_some()
    {
        tries += 1;
        assert!(tries <= 3, "more than three tries");
        v.rej(&mu).await;
        v.hello_refused(&Rej {
            code: RejCode::BadSession,
            detail: None,
        });
    }
    assert_eq!(tries, 3, "three tries, refused hellos or not");
    // Nor does a second quote on the open session, which is refused.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let mut tries = 0;
    for _ in 0..10 {
        while v
            .due()
            .await
            .expect("due answers, second quotes or not")
            .is_some()
        {
            tries += 1;
            assert!(tries <= 3, "more than three tries");
            v.rej(&mu).await;
        }
        assert!(v.quote(s.quote()).is_err(), "one quote per session");
    }
    assert_eq!(tries, 3, "three tries, second quotes or not");
    // Nor does another video's session ending.
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    v1.requested();
    v1.requested();
    let mut tries = 0;
    while v1.due().await.expect("due answers on video 1").is_some() {
        tries += 1;
        v1.rej(&mu).await;
    }
    drop(s0);
    v0.end();
    while v1
        .due()
        .await
        .expect("due answers after video 0's session ends")
        .is_some()
    {
        tries += 1;
        assert!(tries <= 3, "more than three tries");
        v1.rej(&mu).await;
    }
    assert_eq!(
        tries, 3,
        "video 0's session ending is not video 1's new session"
    );
    // Nor do reclaims that complete only on a retry.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let mut tries = 0;
    for _ in 0..20 {
        h.mint_outage(false);
        if v.due()
            .await
            .expect("due answers as the mint comes and goes")
            .is_some()
        {
            tries += 1;
            h.mint_outage(true);
            v.rej(&mu).await;
        }
    }
    h.mint_outage(false);
    assert_eq!(tries, 3, "three tries, the mint down at each or not");

    // The count spans the seeder's videos.
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    v0.requested();
    v0.requested();
    v1.requested();
    v1.requested();
    for on_one in [false, false, true] {
        let v = if on_one { &mut v1 } else { &mut v0 };
        v.due()
            .await
            .expect("due answers on either video")
            .expect("a try");
        v.rej(&mu).await;
    }
    assert!(
        v0.due()
            .await
            .expect("video 0's due answers out of tries")
            .is_none()
            && v1
                .due()
                .await
                .expect("video 1's due answers out of tries")
                .is_none(),
        "three tries across both videos"
    );

    // An ack resets the count.
    let e = h.engine(1, 8, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..6u16 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    for _ in 0..2 {
        v.due()
            .await
            .expect("due answers for the first two tries")
            .expect("a try");
        v.rej(&mu).await;
    }
    let pay = v
        .due()
        .await
        .expect("due answers for a third try")
        .expect("a third try");
    v.ack(&s.pay(&pay).await.expect("this one is taken"))
        .expect("the honest ack is taken");
    for i in 6..10u16 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    for _ in 0..2 {
        v.due()
            .await
            .expect("due answers after the ack")
            .expect("tries again after the ack");
        v.rej(&mu).await;
    }
    assert!(
        v.due()
            .await
            .expect("due answers for a third try after the ack")
            .is_some(),
        "the ack reset the count: a third try"
    );

    // Nor does a ledger made for another video, before any session of it quotes.
    let e = h.engine(1, 4, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("a fair quote");
    v.requested();
    v.requested();
    let mut tries = 0;
    while v.due().await.expect("due answers").is_some() {
        tries += 1;
        assert!(
            tries <= 3,
            "more than three tries: a ledger made for another video restored them"
        );
        v.rej(&mu).await;
        let _other_video = v.sibling();
    }
    assert_eq!(
        tries, 3,
        "three tries, ledgers made for other videos or not"
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
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    for _ in 0..2 {
        v0.requested();
        v1.requested();
    }
    let p0 = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers with video 0's payment in flight")
            .is_none(),
        "one payment in flight toward a seeder, across its videos"
    );
    v1.end();
    v1.quote(open_on(h, &e, 1, 1).await.quote())
        .expect("video 1's next honest quote is accepted");
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers after its session ends")
            .is_none()
            && v1
                .last_pay()
                .await
                .expect("video 1's last_pay answers after its session ends")
                .is_none(),
        "video 1's session ending, or ending again, frees nothing: video 0's is in flight"
    );
    assert!(
        v0.last_pay()
            .await
            .expect("video 0's last_pay answers with its payment in flight")
            .is_none(),
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
        v1.due()
            .await
            .expect("video 1's due answers with video 0's payment lost")
            .is_none()
            && v1
                .last_pay()
                .await
                .expect("video 1's last_pay answers with video 0's payment lost")
                .is_none(),
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
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    for _ in 0..2 {
        v0.requested();
        v1.requested();
    }
    let p0 = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    h.mint_outage(true);
    v0.rej(&mu).await;
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers with video 0's reclaim incomplete")
            .is_none(),
        "a reclaim incomplete on video 0 holds back video 1"
    );
    h.mint_outage(false);
    v1.due()
        .await
        .expect("video 1's due answers once the mint is back")
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
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    v0.requested();
    v0.requested();
    let unread = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    drop(s0);
    v0.end();
    for i in 0..2 {
        assert!(s1.admit(&h.chunk_of(1, i)));
        v1.requested();
    }
    h.advance(Duration::from_secs(179));
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers at 179 s")
            .is_none(),
        "video 0's payment is in flight for 180 s"
    );
    h.advance(SECOND);
    let paid = v1
        .due()
        .await
        .expect("video 1's due answers at 180 s")
        .expect("then video 1 reclaims it, and pays");
    assert!(
        h.claimed_all(&unread.token).await && !h.steal(&unread.token).await,
        "video 0's unread payment came back"
    );
    v1.ack(&s1.pay(&paid).await.expect("accepted"))
        .expect("video 1's honest ack is taken");

    // A reclaim retried from video 1 that finds video 0's proofs spent leaves video 0's
    // payment awaiting video 0's quote, which settles it.
    let e = h.engine(1, 4, 1000);
    let (mut s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    for i in 0..2 {
        assert!(s0.admit(&h.chunk_of(0, i)));
        v0.requested();
    }
    v1.requested();
    let late = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
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
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers on its retried reclaim")
            .is_none(),
        "video 1 retries it"
    );
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
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
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
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    v0.requested();
    v0.requested();
    let p0 = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    drop(s0);
    v0.end();
    v1.requested();
    v1.requested();
    v1.hello_refused(&Rej {
        code: RejCode::BadSession,
        detail: None,
    });
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers after a refused hello")
            .is_none(),
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
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    for i in 0..2 {
        assert!(s0.admit(&h.chunk_of(0, i)));
        v0.requested();
    }
    v1.requested();
    let unread = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    v0.end();
    s0.pay(&unread)
        .await
        .expect("the seeder reads it late, and credits it");
    drop(s0);
    h.advance(Duration::from_secs(180));
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers on its catch-up")
            .is_none(),
        "video 1 catches up"
    );
    assert!(
        v0.awaiting_quote() && !v1.awaiting_quote(),
        "found spent: it awaits video 0's quote"
    );
    v0.quote(open_on(h, &e, 1, 0).await.quote())
        .expect("video 0's quote shows it: settled");
    assert!(!v0.stopped() && !v1.stopped());

    // Video 0's payment is acked, but the ack never arrives: the connection drops. Video
    // 1's catch-up at 180 s meets an outage, so its reclaim is incomplete. Video 0's next
    // quote shows the payment: that settles it, and cancels the reclaim.
    let e = h.engine(1, 4, 1000);
    let (mut s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    for i in 0..2 {
        assert!(s0.admit(&h.chunk_of(0, i)));
        v0.requested();
    }
    let unheard = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    s0.pay(&unheard).await.expect("the seeder swaps and acks");
    drop(s0);
    v0.end();
    h.advance(Duration::from_secs(180));
    h.mint_outage(true);
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers on a blocked catch-up")
            .is_none(),
        "video 1 catches up; the reclaim is blocked"
    );
    h.mint_outage(false);
    v0.quote(open_on(h, &e, 1, 0).await.quote())
        .expect("the quote shows the payment: settled");
    assert!(!v0.stopped() && !v1.stopped());

    // The same when video 1's catch-up finds the mint down, and its retry then finds the
    // proofs spent: the payment stays video 0's.
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    v0.requested();
    v0.requested();
    let kept = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    assert!(h.steal(&kept.token).await, "the seeder swapped it");
    drop(s0);
    v0.end();
    h.advance(Duration::from_secs(180));
    h.mint_outage(true);
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers on a blocked catch-up")
            .is_none(),
        "the catch-up's reclaim is blocked"
    );
    h.mint_outage(false);
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers on its retried reclaim")
            .is_none(),
        "the retry finds it spent"
    );
    assert!(
        v0.awaiting_quote() && !v1.awaiting_quote(),
        "it awaits video 0's quote, not video 1's"
    );
}

/// A stopped viewer pays nothing more, at the end of a session included, nor ahead after a
/// refusal, and awaits no quote. Nothing undoes the stop: not a later honest ack, a refused
/// request or `hello`, `mint-unavailable` with every proof taken back, the session's end, a
/// new session's quote, nor a ledger made for another video. Reclaiming is not paying: it
/// still takes back what is refused, unanswered or left unsettled.
pub async fn a_stopped_viewer_pays_nothing<H: Harness>(h: &H) {
    let mut v = h.viewer(1);
    v.quote(open(h, &h.engine(1, 2, 1000), 1).await.quote())
        .expect("an honest quote is accepted");
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
    assert!(v.due().await.expect("due answers once stopped").is_none());
    assert!(
        v.last_pay()
            .await
            .expect("last_pay answers once stopped")
            .is_none()
    );
    // Reclaiming is not paying: a stopped viewer still finishes its reclaim.
    let s = open(h, &h.engine(1, 4, 1000), 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let pay = v.due().await.expect("due answers").expect("due");
    h.mint_outage(true);
    v.rej(&Rej {
        code: RejCode::Underpaid,
        detail: None,
    })
    .await;
    assert!(v.stopped());
    h.mint_outage(false);
    assert!(
        v.due().await.expect("due answers once stopped").is_none(),
        "it pays nothing"
    );
    assert!(
        h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
        "but it took its proofs back"
    );
    // And a live session's payment the seeder refuses, or leaves unanswered, after the
    // standing has stopped: the watcher still takes those proofs back.
    for unanswered in [false, true] {
        let e = h.engine(1, 4, 1000);
        let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
        let mut v0 = h.viewer(1);
        let mut v1 = v0.sibling();
        v0.quote(s0.quote())
            .expect("video 0's honest quote is accepted");
        v1.quote(s1.quote())
            .expect("video 1's honest quote is accepted");
        v0.requested();
        v0.requested();
        let pay = v0
            .due()
            .await
            .expect("video 0's due answers")
            .expect("due on video 0");
        assert!(
            v1.ack(&Ack {
                accepted_upto: 1,
                spent_total: 1
            })
            .is_err()
        );
        assert!(v0.stopped(), "the standing is stopped");
        if unanswered {
            h.advance(Duration::from_secs(180));
            v0.timeout().await;
        } else {
            v0.rej(&Rej {
                code: RejCode::Underpaid,
                detail: None,
            })
            .await;
        }
        assert!(
            h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
            "its proofs came back (unanswered: {unanswered})"
        );
    }
    // So does a stopped standing with a closed session's unsettled payment: another
    // video's catch-up reclaims it at 180 s.
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote())
        .expect("video 0's honest quote is accepted");
    v1.quote(s1.quote())
        .expect("video 1's honest quote is accepted");
    v0.requested();
    v0.requested();
    let unread = v0
        .due()
        .await
        .expect("video 0's due answers")
        .expect("due on video 0");
    drop(s0);
    v0.end();
    assert!(
        v1.ack(&Ack {
            accepted_upto: 1,
            spent_total: 1
        })
        .is_err()
    );
    assert!(v0.stopped() && v1.stopped(), "the standing is stopped");
    h.advance(Duration::from_secs(180));
    assert!(
        v1.due()
            .await
            .expect("video 1's due answers once stopped")
            .is_none(),
        "it pays nothing"
    );
    assert!(
        h.claimed_all(&unread.token).await && !h.steal(&unread.token).await,
        "but video 0's unsettled payment came back"
    );

    // Nothing that comes after the stop undoes it: an honest ack of the payment in flight,
    // a refusal that would let it pay ahead, a new session or a new video's ledger, or a
    // `mint-unavailable` answer with every proof taken back. And a stopped viewer awaits no
    // quote.
    an_honest_ack_leaves_the_standing_stopped(h).await;
    a_stopped_viewer_pays_nothing_ahead(h).await;
    a_stopped_viewer_awaits_no_quote(h).await;
    a_new_session_leaves_the_standing_stopped(h).await;
    an_unavailable_answer_leaves_the_standing_stopped(h).await;
}

/// The seeder's honest ack of the payment in flight when the standing stopped leaves it
/// stopped: video 1's unsolicited ack stops the standing while video 0's payment is in
/// flight, the seeder then swaps and acks that payment, and the watcher pays nothing more.
async fn an_honest_ack_leaves_the_standing_stopped<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let (mut s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).expect("a fair quote");
    v1.quote(s1.quote()).expect("a fair quote");
    for i in 0..2 {
        assert!(s0.admit(&h.chunk_of(0, i)));
        v0.requested();
    }
    let pay = v0
        .due()
        .await
        .expect("due answers")
        .expect("due on video 0");
    assert!(
        v1.ack(&Ack {
            accepted_upto: 1,
            spent_total: 1
        })
        .is_err()
            && v0.stopped(),
        "an unsolicited ack on video 1 stops the standing"
    );
    let ack = s0.pay(&pay).await.expect("swapped");
    v0.ack(&ack)
        .expect("the seeder's own ack matches the payment");
    assert!(
        v0.stopped() && v1.stopped(),
        "the seeder's honest ack of the payment in flight leaves the standing stopped"
    );
    for i in 2..4 {
        assert!(s0.admit(&h.chunk_of(0, i)));
        v0.requested();
    }
    assert!(
        v0.due().await.expect("due answers").is_none(),
        "and it pays nothing more"
    );
}

/// A refusal lets the next payment go ahead, but not once the viewer has stopped: refused a
/// request, then stopped by an unsolicited ack, it pays nothing, ahead or not. A request
/// refused after the stop leaves it stopped.
async fn a_stopped_viewer_pays_nothing_ahead<H: Harness>(h: &H) {
    let mut v = h.viewer(1);
    v.quote(open(h, &h.engine(1, 4, 1000), 1).await.quote())
        .expect("a fair quote");
    v.requested();
    v.refused();
    assert!(
        v.ack(&Ack {
            accepted_upto: 0,
            spent_total: 0
        })
        .is_err()
            && v.stopped(),
        "an unsolicited ack stops it"
    );
    assert!(
        v.due().await.expect("due answers").is_none(),
        "refused a request and stopped since: it pays nothing ahead"
    );
    v.requested();
    v.refused();
    assert!(
        v.stopped(),
        "a request refused after the stop leaves the standing stopped"
    );
    assert!(
        v.due().await.expect("due answers").is_none(),
        "refused again after the stop: it pays nothing ahead"
    );
}

/// A viewer whose standing has stopped paying the seeder awaits no quote: no new session
/// makes it pay. It awaits one with its three tries used (three `mint-unavailable`
/// answers), or with a payment found spent, until an unsolicited ack stops its standing.
async fn a_stopped_viewer_awaits_no_quote<H: Harness>(h: &H) {
    let mut v = h.viewer(1);
    v.quote(open(h, &h.engine(1, 4, 1000), 1).await.quote())
        .expect("a fair quote");
    v.requested();
    v.requested();
    for _ in 0..3 {
        v.due().await.expect("due answers").expect("a try");
        v.rej(&Rej {
            code: RejCode::MintUnavailable,
            detail: None,
        })
        .await;
    }
    assert!(
        v.awaiting_quote(),
        "its three tries used, it awaits a quote"
    );
    assert!(
        v.ack(&Ack {
            accepted_upto: 0,
            spent_total: 0
        })
        .is_err()
            && v.stopped(),
        "an unsolicited ack stops it"
    );
    assert!(
        !v.awaiting_quote(),
        "its standing stopped, it awaits no quote: no new session makes it pay"
    );
    // And with a payment found spent: it awaits a quote until an unsolicited ack stops its
    // standing.
    let mut v = h.viewer(1);
    v.quote(open(h, &h.engine(1, 4, 1000), 1).await.quote())
        .expect("a fair quote");
    v.requested();
    v.requested();
    let pay = v.due().await.expect("due answers").expect("due");
    assert!(
        h.steal(&pay.token).await,
        "a third party claims the payment"
    );
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        v.awaiting_quote(),
        "its payment found spent, it awaits a quote"
    );
    assert!(
        v.ack(&Ack {
            accepted_upto: 0,
            spent_total: 0
        })
        .is_err(),
        "an unsolicited ack is refused, and stops its standing"
    );
    assert!(
        !v.awaiting_quote(),
        "its standing stopped, it awaits no quote, its payment found spent included: no new \
         session makes it pay"
    );
}

/// Nothing after the stop undoes it: not the session's end, a refused `hello`, a new
/// session's quote, taken or not, nor a ledger made for another video. Stopped by an
/// unsolicited ack, the watcher reconnects, and the seeder quotes its ledger honestly: it
/// pays nothing more, by `due` or by `last_pay`, on either video.
async fn a_new_session_leaves_the_standing_stopped<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("a fair quote");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    v.ack(&s.pay(&pay).await.expect("swapped"))
        .expect("the seeder's own ack matches the payment");
    assert!(
        v.ack(&Ack {
            accepted_upto: 2,
            spent_total: 2
        })
        .is_err()
            && v.stopped(),
        "a second ack is unsolicited: refused, and it stops"
    );
    drop(s);
    v.end();
    assert!(v.stopped(), "the session's end leaves the standing stopped");
    v.hello_refused(&Rej {
        code: RejCode::BadSession,
        detail: None,
    });
    assert!(
        v.stopped(),
        "a hello refused bad-session leaves the standing stopped"
    );
    let mut s = open(h, &e, 1).await;
    assert_eq!(
        (s.quote().accepted_upto, s.quote().spent_total),
        (2, 2),
        "the seeder's quote shows the ledger"
    );
    // Taken or refused, the quote undoes nothing.
    let _ = v.quote(s.quote());
    assert!(
        v.stopped(),
        "a new session's honest quote leaves the standing stopped"
    );
    for i in 2..4 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    assert!(
        v.due().await.expect("due answers").is_none(),
        "stopped before this session: it pays nothing"
    );
    assert!(
        v.last_pay().await.expect("last_pay answers").is_none(),
        "nor at the session's end"
    );
    let mut other = v.sibling();
    assert!(
        other.stopped(),
        "a ledger made after the stop, for another video, shares the stopped standing"
    );
    let mut s1 = open_on(h, &e, 1, 1).await;
    let _ = other.quote(s1.quote());
    for i in 0..2 {
        assert!(s1.admit(&h.chunk_of(1, i)));
        other.requested();
    }
    assert!(
        other.due().await.expect("due answers").is_none(),
        "it pays nothing on the other video"
    );
}

/// A `mint-unavailable` answer after the stop, every proof taken back, leaves the standing
/// stopped: video 1's unsolicited ack stops it while video 0's payment is in flight, and
/// the seeder answers that payment `mint-unavailable`, claiming nothing.
async fn an_unavailable_answer_leaves_the_standing_stopped<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let (s0, s1) = (open_on(h, &e, 1, 0).await, open_on(h, &e, 1, 1).await);
    let mut v0 = h.viewer(1);
    let mut v1 = v0.sibling();
    v0.quote(s0.quote()).expect("a fair quote");
    v1.quote(s1.quote()).expect("a fair quote");
    v0.requested();
    v0.requested();
    let pay = v0
        .due()
        .await
        .expect("due answers")
        .expect("due on video 0");
    assert!(
        v1.ack(&Ack {
            accepted_upto: 1,
            spent_total: 1
        })
        .is_err()
            && v0.stopped(),
        "an unsolicited ack on video 1 stops the standing"
    );
    v0.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
        "it took every proof back"
    );
    assert!(
        v0.stopped() && v1.stopped(),
        "mint-unavailable, every proof taken back: the standing stays stopped"
    );
    v0.requested();
    v0.requested();
    assert!(
        v0.due().await.expect("due answers").is_none(),
        "and it pays nothing more"
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
            v.ack(&ack).expect("each honest ack is taken");
        }
        in_flight = v.due().await.expect("due answers while streaming");
    }
    if let Some(pay) = in_flight {
        let ack = s.pay(&pay).await.expect("honest payments are accepted");
        v.ack(&ack).expect("the last honest ack is taken");
    }
}

async fn stream<H: Harness>(h: &H, s: &mut Session<H>, v: &mut H::Viewer, from: u16, n: u16) {
    stream_on(h, s, v, 0, from, n).await;
}

async fn pay_the_tail<H: Harness>(s: &mut Session<H>, v: &mut H::Viewer) -> Option<Ack> {
    let pay = v.last_pay().await.expect("last_pay answers")?;
    let ack = s.pay(&pay).await.expect("the tail is paid");
    v.ack(&ack).expect("the tail's honest ack is taken");
    Some(ack)
}

/// An honest pair streams a whole video without the seeder ever stalling, and the total
/// paid is exactly chunks × the quoted price, whatever the viewer would pay at most.
pub async fn an_honest_pair_streams_a_whole_video<H: Harness>(h: &H) {
    let (chunks, price) = (101u16, 2);
    let e = h.engine(price, 8, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(price * 3);
    v.quote(s.quote()).expect("an honest quote is accepted");
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
    v.quote(s.quote()).expect("an honest quote is accepted");
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

/// A slow link to the mint delays the ack, never races it: the honest pair carries on, and
/// nobody is banned.
pub async fn an_honest_pair_waits_out_a_slow_mint<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.hold_swaps();
    let (ack, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.release_swaps().await;
    })
    .await;
    v.ack(&ack.expect("acknowledged once swapped"))
        .expect("the honest ack is taken once swapped");
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
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    h.mint_outage(true);
    let pay = v
        .due()
        .await
        .expect("due answers while the mint is down")
        .expect("due");
    let rej = s.pay(&pay).await.expect_err("the mint is down");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(!v.stopped() && !s.banned());
    assert!(
        v.due()
            .await
            .expect("due answers with its reclaim incomplete")
            .is_none(),
        "nothing more until its reclaim completes"
    );
    h.mint_outage(false);
    let again = v
        .due()
        .await
        .expect("due answers once the mint is back")
        .expect("paid again once reclaimed");
    assert_ne!(again.token, pay.token, "with fresh proofs");
    assert!(
        h.claimed_all(&pay.token).await,
        "the first proofs came back"
    );
    v.ack(&s.pay(&again).await.expect("accepted"))
        .expect("the honest ack is taken");
    stream(h, &mut s, &mut v, 2, 20).await;

    // A request the mint holds after reserving its inputs (NUT-07 `PENDING`, as CDK does
    // before it signs). The watcher's reclaim is refused as pending: incomplete, and
    // retried. The seeder reads the swap as undecided, and learns the claim once the mint
    // finishes it; the next quote settles the payment.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.hold_next_swap_reserving();
    let (r, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    let rej = r.expect_err("no answer within 60 s");
    v.rej(&rej).await;
    assert!(
        !v.stopped()
            && v.due()
                .await
                .expect("due answers with its reclaim refused as pending")
                .is_none(),
        "nothing paid while its reclaim is refused as pending"
    );
    e.sweep().await;
    h.release_swaps().await;
    assert!(
        v.due()
            .await
            .expect("due answers once the reserved request is signed")
            .is_none()
            && v.awaiting_quote()
    );
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
    assert_eq!((s.quote().accepted_upto, s.quote().spent_total), (2, 2));
    v.quote(s.quote()).expect("settled");
    stream(h, &mut s, &mut v, 2, 4).await;
    assert!(!v.stopped() && !s.banned());
    // The same, with the seeder's retry refused as pending too: its outcome stays
    // unknown, and the claim is credited once the mint finishes the request.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.hold_next_swap_reserving();
    h.time_out_next_swap();
    let rej = s.pay(&pay).await.expect_err("mint-unavailable");
    v.rej(&rej).await;
    h.release_swaps().await;
    assert!(
        v.due()
            .await
            .expect("due answers once the reserved request is signed")
            .is_none()
            && v.awaiting_quote()
    );
    drop(s);
    v.end();
    let s = open(h, &e, 1).await;
    assert_eq!(
        (s.quote().accepted_upto, s.quote().spent_total),
        (2, 2),
        "the claim is credited"
    );
    v.quote(s.quote()).expect("settled");
    drop(s);
    v.end();
    // And when the mint abandons the reserved request (CDK rolls it back at startup), the
    // watcher's retried reclaim takes the proofs back, and the pair pays again.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.hold_next_swap_reserving();
    let (r, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    v.rej(&r.expect_err("no answer within 60 s")).await;
    h.roll_back_reserved();
    let again = v
        .due()
        .await
        .expect("due answers once the reserved request is rolled back")
        .expect("its proofs came back: it pays again");
    assert!(h.claimed_all(&pay.token).await, "taken back by its reclaim");
    v.ack(
        &s.pay(&again)
            .await
            .expect("the abandoned swap can no longer go through: swapped"),
    )
    .expect("the honest ack is taken");
    assert!(!v.stopped() && !s.banned());
    drop(s);
    v.end();

    // A black-holed request: the seeder's swap is held on its way to the mint, and everything
    // else goes through. The seeder answers `mint-unavailable` at its deadline, and the
    // watcher's reclaim spends the proofs, so the held swap can no longer go through: the
    // pair pays again at once, and the held swap's spent, when it lands, bans nobody.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.hold_next_swap();
    let (r, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.advance(Duration::from_secs(60));
    })
    .await;
    let rej = r.expect_err("no answer within 60 s");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(
        h.claimed_all(&pay.token).await,
        "the watcher took its proofs back"
    );
    let again = v
        .due()
        .await
        .expect("due answers once its reclaim went through")
        .expect("paid again");
    v.ack(
        &s.pay(&again)
            .await
            .expect("the held swap can no longer go through: swapped"),
    )
    .expect("the honest ack is taken");
    stream(h, &mut s, &mut v, 2, 10).await;
    h.release_swaps().await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    assert!(!v.stopped() && !s.banned());
    drop(s);
    v.end();
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (12, 12),
        "every chunk paid exactly once"
    );
}

/// A connection dropped while a payment's swap is in flight: the seeder's swap completes
/// and is credited, the viewer's next quote settles it, and nobody is banned or pays
/// twice.
pub async fn an_honest_pair_survives_a_dropped_connection<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.hold_swaps();
    poll_once(s.pay(&pay)).await;
    drop(s);
    v.end();
    h.release_swaps().await;
    let mut s = open_unbanned(h, &e, 1, "a connection dropped mid-swap bans nobody").await;
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
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
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
    v.quote(old.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(old.admit(&h.chunk(i)));
        v.requested();
    }
    let buffered = v.due().await.expect("due answers").expect("due");
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
            v.due()
                .await
                .expect("due answers with a payment unsettled")
                .is_none(),
            "nothing more while it is unsettled"
        );
    }
    h.advance(Duration::from_secs(180));
    v.timeout().await;
    assert!(
        !v.stopped(),
        "no payment of this session is unanswered: a timeout changes nothing"
    );
    assert!(
        v.due().await.expect("due answers at 180 s").is_none(),
        "reclaimed at 180 s"
    );
    assert!(v.awaiting_quote(), "found spent, so it awaits a quote");
    drop(s);
    v.end();
    let mut s = open_unbanned(h, &e, 1, "a reordered payment bans nobody").await;
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
/// is credited, nobody is banned, and the next quote settles it. A `rej` or an `ack` on a
/// later session answers none of the earlier session's payments. A `hello` refused with any
/// code but `banned` changes nothing: a payment found spent still awaits a quote, and an
/// incomplete reclaim stays incomplete.
pub async fn an_honest_pair_survives_a_refused_hello<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
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
    // A hello refused `unknown-video`, or with a code this watcher does not know, changes
    // nothing; one refused `banned` stops the watcher, on every video.
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    v.hello_refused(&Rej {
        code: RejCode::UnknownVideo,
        detail: None,
    });
    v.hello_refused(&Rej {
        code: RejCode::Other("a-later-code".into()),
        detail: None,
    });
    assert!(
        !v.stopped(),
        "unknown-video, or an unknown code: nothing changes"
    );
    let s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers after a refused hello")
            .is_some(),
        "and it pays as usual"
    );
    let other_video = h.viewer(1);
    let mut banned = other_video.sibling();
    banned.hello_refused(&Rej {
        code: RejCode::Banned,
        detail: None,
    });
    assert!(
        banned.stopped() && other_video.stopped(),
        "banned: it stops paying the seeder, for every video"
    );

    // A rej on a new session that answers no payment is unsolicited: the watcher stops,
    // and the earlier session's payment is left to its own rules, not reclaimed at once.
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let earlier = v.due().await.expect("due answers").expect("due");
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
    // So is an ack on a new session, even one that matches the earlier session's
    // payment: the watcher stops, and reclaims that payment after the wait.
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    v.requested();
    let earlier = v.due().await.expect("due answers").expect("due");
    drop(s);
    v.end();
    let s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("the seeder never saw it");
    let matching = Ack {
        accepted_upto: earlier.upto_chunk,
        spent_total: 2,
    };
    assert!(
        v.ack(&matching).is_err() && v.stopped(),
        "unsolicited: the watcher stops"
    );
    h.advance(Duration::from_secs(180));
    assert!(
        v.due().await.expect("due answers once stopped").is_none(),
        "it pays nothing"
    );
    assert!(
        h.claimed_all(&earlier.token).await && !h.steal(&earlier.token).await,
        "and reclaims the earlier payment after the wait"
    );

    a_refused_hello_leaves_what_it_waits_on(h).await;
}

/// A `hello` refused `bad-session`, `unknown-video` or with a code the watcher does not know
/// leaves what the watcher waits on: a payment found spent still awaits a quote, and a
/// reclaim the mint cannot serve yet stays incomplete. On the next session, whose quote
/// shows the ledger, it pays nothing, and it takes the proofs back once the mint answers.
async fn a_refused_hello_leaves_what_it_waits_on<H: Harness>(h: &H) {
    let unavailable = Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    };
    for code in [
        RejCode::BadSession,
        RejCode::UnknownVideo,
        RejCode::Other("a-later-code".into()),
    ] {
        let refusal = Rej {
            code: code.clone(),
            detail: None,
        };
        // A payment found spent.
        let e = h.engine(1, 4, 1000);
        let s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("a fair quote");
        v.requested();
        v.requested();
        let pay = v.due().await.expect("due answers").expect("due");
        assert!(
            h.steal(&pay.token).await,
            "a third party claims the payment"
        );
        v.rej(&unavailable).await;
        drop(s);
        v.end();
        v.hello_refused(&refusal);
        let s = open(h, &e, 1).await;
        v.quote(s.quote())
            .expect("a quote showing the ledger is taken");
        v.requested();
        v.requested();
        assert!(
            v.awaiting_quote() && v.due().await.expect("due answers").is_none(),
            "a hello refused {}: the payment found spent still awaits a quote, and it pays \
             nothing",
            code.as_str()
        );
        // A reclaim the mint cannot serve yet.
        let e = h.engine(1, 4, 1000);
        let s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("a fair quote");
        v.requested();
        v.requested();
        let pay = v.due().await.expect("due answers").expect("due");
        h.mint_outage(true);
        v.rej(&unavailable).await;
        drop(s);
        v.end();
        v.hello_refused(&refusal);
        let s = open(h, &e, 1).await;
        v.quote(s.quote())
            .expect("a quote showing the ledger is taken");
        v.requested();
        v.requested();
        assert!(
            v.due().await.expect("due answers").is_none(),
            "a hello refused {}: the reclaim is still incomplete, and it pays nothing",
            code.as_str()
        );
        h.mint_outage(false);
        v.due().await.expect("due answers");
        assert!(
            h.claimed_all(&pay.token).await && !h.steal(&pay.token).await,
            "once the mint answers, it takes the proofs back"
        );
    }
}

/// The mint answers the seeder's swap only after the seeder's deadline. The seeder has
/// answered `mint-unavailable`, and the watcher's reclaim finds the proofs spent, so the
/// payment awaits a quote. A quote taken before the seeder learns the outcome leaves it
/// waiting; once the seeder credits the late claim (a restore shows it before its answer
/// comes), the next quote settles it, and the pair carries on.
pub async fn an_honest_pair_survives_a_late_mint<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut v = h.viewer(1);
    let mut s = open(h, &e, 1).await;
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
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
    h.restore_outage(true);
    let s = open(h, &e, 1).await;
    v.quote(s.quote())
        .expect("the seeder cannot learn the outcome yet: an honest quote");
    assert!(
        v.awaiting_quote()
            && v.due()
                .await
                .expect("due answers awaiting a quote")
                .is_none(),
        "still waiting, and paying nothing"
    );
    h.restore_outage(false);
    drop(s);
    v.end();
    h.advance(SECOND); // not a read made this second, which would be reused
    let mut s = open_unbanned(h, &e, 1, "a late mint bans nobody").await;
    v.quote(s.quote())
        .expect("a restore showed the claim, credited late: settled");
    assert!(!v.stopped() && !s.banned());
    h.release_swaps().await;
    stream(h, &mut s, &mut v, 2, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.served, q.spent_total),
        (12, 12),
        "every chunk paid exactly once"
    );

    // The swap's answer is lost and its retry meets an outage, so the answer is
    // `mint-unavailable`, and the watcher's reclaim is blocked too. Once the mint is back
    // the seeder learns the claim, and the next quote shows it: that settles the payment
    // whose reclaim is still incomplete, and the pair carries on.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.hold_swap_responses();
    h.lose_next_swap_response();
    let (r, ()) = both(s.pay(&pay), async {
        yield_once().await;
        h.mint_outage(true);
        h.release_swaps().await;
    })
    .await;
    let rej = r.expect_err("mint-unavailable");
    v.rej(&rej).await;
    assert!(!v.stopped(), "a blocked reclaim is not a stop");
    h.mint_outage(false);
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
    assert_eq!((s.quote().accepted_upto, s.quote().spent_total), (2, 2));
    v.quote(s.quote())
        .expect("the quote shows the payment: settled, reclaim and all");
    assert!(!v.stopped());
    stream(h, &mut s, &mut v, 2, 12).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    assert!(!v.stopped());
    drop(s);
    v.end();
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (14, 14),
        "every chunk paid, well past a window"
    );

    // A NUT-07 check that goes unanswered proves nothing: the request the seeder's client
    // gave up on is processed after all, and the claim is credited.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.time_out_next_swap();
    h.mint_outage(true);
    let r = s.pay(&pay).await;
    h.mint_outage(false);
    let rej = r.expect_err("mint-unavailable");
    h.state_check_outage(true);
    e.sweep().await;
    h.state_check_outage(false);
    h.release_swaps().await;
    v.rej(&rej).await;
    assert!(v.awaiting_quote(), "the seeder's swap spent its proofs");
    drop(s);
    v.end();
    let s = open(h, &e, 1).await;
    assert_eq!(
        (s.quote().accepted_upto, s.quote().spent_total),
        (2, 2),
        "the claim is credited"
    );
    v.quote(s.quote()).expect("settled");
    assert!(!v.stopped());
    drop(s);
    v.end();

    // The seeder's client gives up on a request the mint has not processed yet, and the
    // retry cannot reach the mint. A restore then finds nothing signed with every input
    // unspent, which proves nothing: the request is processed after all, and the claim
    // is credited, so the next quote settles the payment.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v.due().await.expect("due answers").expect("due");
    h.time_out_next_swap();
    h.mint_outage(true);
    let r = s.pay(&pay).await;
    h.mint_outage(false);
    let rej = r.expect_err("mint-unavailable");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    e.sweep().await;
    h.release_swaps().await;
    assert!(
        h.claimed_all(&pay.token).await,
        "the mint processed the request"
    );
    v.rej(&rej).await;
    assert!(v.awaiting_quote(), "the seeder's swap spent its proofs");
    drop(s);
    v.end();
    let mut s = open(h, &e, 1).await;
    assert_eq!(
        (s.quote().accepted_upto, s.quote().spent_total),
        (2, 2),
        "the claim is credited"
    );
    v.quote(s.quote()).expect("settled");
    stream(h, &mut s, &mut v, 2, 10).await;
    pay_the_tail::<H>(&mut s, &mut v).await;
    assert!(!v.stopped() && !s.banned());
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
    v.quote(s.quote())
        .expect("an honest quote is accepted at a full cap");
    let mut served = 0u64;
    for i in 0..40u16 {
        v.requested();
        if !s.admit(&h.chunk(i)) {
            v.refused();
            let pay = v
                .due()
                .await
                .expect("due answers after a refusal")
                .expect("refused, it pays ahead");
            v.ack(&s.pay(&pay).await.expect("a pre-payment is accepted"))
                .expect("the seeder's honest ack of a pay-ahead is taken");
            v.requested();
            assert!(
                s.admit(&h.chunk(i)),
                "then served from its credit (chunk {i})"
            );
        }
        served += 1;
        if let Some(pay) = v.due().await.expect("due answers, holding credit or not") {
            v.ack(&s.pay(&pay).await.expect("honest payments are accepted"))
                .expect("each honest ack is taken");
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

/// Flaw `FloorAtArrival`. A `hello` that waited for payment P is served only by a
/// read sent after its wait ended: not by P's own read, sent during the wait (NFX-07 §3). A
/// is undecidable at the mint; the second's two reads are spent, so P, holding the turn,
/// reads in the next second, after the hello began to wait. A finishes while P's read is
/// under way. The hello must read after P, and quote A's claim.
async fn a_read_sent_during_the_wait_serves_no_waited_hello<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    for _ in 0..2 {
        let hello = h.hello();
        let mut f = Box::pin(e.hello(&peer, &hello));
        if poll_now(f.as_mut()).is_some() {
            h.release_swaps().await;
            return; // synchronous reads: nothing is ever under way
        }
    } // both dropped mid-read: the second's two are spent
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s2.pay(&p));
    assert!(
        (0..1000).all(|_| poll_now(paying.as_mut()).is_none()),
        "P holds the turn and waits for the next second to read"
    );
    let hello = h.hello();
    let mut behind = Box::pin(e.hello(&peer, &hello));
    assert!(poll_now(behind.as_mut()).is_none(), "the hello waits for P");
    h.advance(SECOND);
    let before = h.state_reads();
    assert!(poll_now(paying.as_mut()).is_none(), "P's read under way");
    assert_eq!(
        h.state_reads() - before,
        2,
        "P read A, during the hello's wait"
    );
    h.release_swaps().await; // A finishes at the mint while P's read is under way
    assert!(h.claimed_all(&a.token).await);
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("P answered");
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    drop(paying);
    let q = settle_on(h, behind.as_mut(), 3)
        .expect("a hello")
        .quote()
        .clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "P's read was sent during the hello's wait: the hello reads after P, and quotes A's claim"
    );
}

/// Flaws `WaitReadPastDeadline` (`stalled`) and `NextSecondPastDeadline`.
/// "Its wait ends at its own deadline in any case" (NFX-07 §3), and a `pay` is answered
/// within 60 s. Hellos that passed the turn before P took it wait on a stalled read. In
/// P's second before its deadline two of them read and are dropped, and two find that
/// second's two spent and wait for the next; so does P, whose keys come then. In P's
/// deadline second those two read, one abandoned and one stalled (or both abandoned), and
/// P finds the second's two spent there.
async fn a_payment_waits_no_longer_than_its_deadline<H: Harness>(h: &H) {
    for stalled in [true, false] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        parked(h, &mut s, 4).await;
        h.advance(SECOND);
        let peer = h.peer(1);
        let hellos: Vec<_> = (0..5).map(|_| h.hello()).collect();
        let mut first = Box::pin(e.hello(&peer, &hellos[0]));
        if poll_now(first.as_mut()).is_some() {
            h.release_swaps().await;
            return; // synchronous reads: nothing is ever under way
        }
        let mut waiting: Vec<_> = hellos[1..]
            .iter()
            .map(|hello| Box::pin(e.hello(&peer, hello)))
            .collect();
        for f in &mut waiting {
            assert!(poll_now(f.as_mut()).is_none(), "waits for the first's read");
        }
        h.hold_key_fetches();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let arrived = h.clock_secs();
        let mut paying = Box::pin(s2.pay(&p));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P holds the turn, waiting for keys"
        );
        h.advance(Duration::from_secs(59)); // P's second before its deadline
        let mut late = waiting.split_off(2);
        for mut f in waiting {
            assert!(
                poll_now(f.as_mut()).is_none(),
                "it reads, and is dropped mid-read"
            );
        }
        for f in &mut late {
            assert!(
                poll_now(f.as_mut()).is_none(),
                "the second's two spent: it waits for the next"
            );
        }
        h.release_swaps().await; // P's keys come
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P finds this second's two reads spent, and waits for the next"
        );
        h.advance(SECOND); // P's deadline
        let mut it = late.into_iter();
        let mut second = it.next().expect("a hello");
        let mut third = it.next().expect("a hello");
        assert!(
            poll_now(second.as_mut()).is_none(),
            "the second reads, in P's deadline second"
        );
        drop(second);
        assert!(poll_now(third.as_mut()).is_none(), "the third reads too");
        let kept = if stalled {
            Some(third)
        } else {
            drop(third);
            None
        };
        let r = (0..1000).find_map(|_| poll_now(paying.as_mut()));
        assert!(
            r.as_ref()
                .is_some_and(|r| is_rej(r, &RejCode::MintUnavailable)),
            "P answered at its deadline, {} s after arrival, not after the second's end \
             (a read stalled: {stalled}): {r:?}",
            h.clock_secs() - arrived
        );
        drop((paying, kept, first));
    }
}

/// Flaw `FloorAcrossSeconds`. A waited `hello` whose floor is in second T, and that
/// reads in T+1 (T's two spent), is served by a read another hello sent in T+1: it waits
/// for that read under way and sends none of its own (NFX-07 §3: "waits for one under way
/// that would serve it").
async fn a_waited_hello_shares_a_read_of_a_later_second<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    {
        let hello = h.hello();
        let mut f = Box::pin(e.hello(&peer, &hello));
        if poll_now(f.as_mut()).is_some() {
            h.release_swaps().await;
            return; // synchronous reads: nothing is ever under way
        }
    } // r0, abandoned
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s2.pay(&p));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "P's read (r1) under way"
    );
    let hello = h.hello();
    let mut behind = Box::pin(e.hello(&peer, &hello));
    assert!(poll_now(behind.as_mut()).is_none(), "the hello waits for P");
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("P answered");
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    drop(paying);
    assert!(
        (0..1000).all(|_| poll_now(behind.as_mut()).is_none()),
        "r0 and r1 were sent before its wait ended: it reads in the next second"
    );
    h.advance(SECOND);
    let before = h.state_reads();
    let other = h.hello();
    let mut fresh = Box::pin(e.hello(&peer, &other));
    assert!(
        poll_now(fresh.as_mut()).is_none(),
        "a fresh hello's read under way"
    );
    assert!(
        poll_now(behind.as_mut()).is_none(),
        "the waited hello waits for that read"
    );
    (0..1000)
        .find_map(|_| poll_now(fresh.as_mut()))
        .expect("the fresh hello answered")
        .expect("a hello");
    (0..1000)
        .find_map(|_| poll_now(behind.as_mut()))
        .expect("the waited hello answered")
        .expect("a hello");
    assert_eq!(
        h.state_reads() - before,
        2,
        "a read sent in T+1 was sent after the wait ended: both hellos share it"
    );
    h.release_swaps().await;
}

/// Flaw `FreedKeptAtNewSecond`. Two hellos woken by one payment share one read
/// (NFX-07 §3), also when they find the turn free only in the next second.
async fn hellos_woken_by_one_payment_share_a_read_across_a_second<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s2.pay(&p));
    if poll_now(paying.as_mut()).is_some() {
        h.release_swaps().await;
        return; // synchronous reads: nothing is ever under way
    }
    let (one, two) = (h.hello(), h.hello());
    let mut first = Box::pin(e.hello(&peer, &one));
    let mut second = Box::pin(e.hello(&peer, &two));
    assert!(poll_now(first.as_mut()).is_none(), "it waits for P");
    assert!(poll_now(second.as_mut()).is_none(), "it waits for P");
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("P answered: the turn freed, both woken");
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    drop(paying);
    h.advance(SECOND); // they run only in the next second
    let before = h.state_reads();
    assert!(
        poll_now(first.as_mut()).is_none(),
        "the first reads: under way"
    );
    assert!(
        poll_now(second.as_mut()).is_none(),
        "the second waits for the first's read"
    );
    (0..1000)
        .find_map(|_| poll_now(first.as_mut()))
        .expect("the first answered")
        .expect("a hello");
    (0..1000)
        .find_map(|_| poll_now(second.as_mut()))
        .expect("the second answered")
        .expect("a hello");
    assert_eq!(
        h.state_reads() - before,
        2,
        "hellos woken by one payment share one read, in the next second too"
    );
    h.release_swaps().await;
}

/// Flaw `ReadingIgnoresSecond`. A read counts in the second it was sent (NFX-07 §3):
/// one sent in T and back only in T+1 marks nothing of T+1's reads. A hello's read of T
/// stalls; in T+1 the mint finishes A, a second hello reads it (under way), then the first
/// read comes back, and a third hello must wait for the second's result and quote A.
async fn a_read_back_after_its_second_marks_nothing_of_the_next<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    let (one, two, three) = (h.hello(), h.hello(), h.hello());
    let mut first = Box::pin(e.hello(&peer, &one));
    if poll_now(first.as_mut()).is_some() {
        h.release_swaps().await;
        return; // synchronous reads: nothing is ever under way
    }
    h.advance(SECOND);
    h.release_swaps().await; // A finishes at the mint: a claim
    assert!(h.claimed_all(&a.token).await);
    let mut second = Box::pin(e.hello(&peer, &two));
    assert!(
        poll_now(second.as_mut()).is_none(),
        "the second's read under way, in T+1"
    );
    (0..1000)
        .find_map(|_| poll_now(first.as_mut()))
        .expect("the first's read of T back")
        .expect("a hello");
    let mut third = Box::pin(e.hello(&peer, &three));
    let early = poll_now(third.as_mut()); // the second's read still under way: it waits
    let q2 = (0..1000)
        .find_map(|_| poll_now(second.as_mut()))
        .expect("the second answered")
        .expect("a hello")
        .quote()
        .clone();
    assert_eq!(
        (q2.accepted_upto, q2.spent_total),
        (4, 4),
        "the second quotes A's claim"
    );
    let at_once = early.is_some();
    let q3 = match early {
        Some(q) => q,
        None => (0..1000)
            .find_map(|_| poll_now(third.as_mut()))
            .expect("the third answered"),
    }
    .expect("a hello")
    .quote()
    .clone();
    assert_eq!(
        (q3.accepted_upto, q3.spent_total),
        (4, 4),
        "the third waited for the second's read and quotes A's claim (answered at once: {at_once})"
    );
}

/// Flaws `CountedAtFirstLook` and `PayCountedAtFirstLook`. "A read counts from when it is
/// sent, in the second it is sent (an entry that waited into a new second included)"
/// (NFX-07 §3). Four hellos find T's two spent and wait for T+1; there they send at most
/// two reads. So do two hellos and a payment that waited with them.
async fn entries_that_waited_into_a_second_count_there<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    for _ in 0..2 {
        let hello = h.hello();
        let mut f = Box::pin(e.hello(&peer, &hello));
        if poll_now(f.as_mut()).is_some() {
            h.release_swaps().await;
            return; // synchronous reads: nothing is ever under way
        }
    } // both dropped mid-read: T's two are spent
    let hellos: Vec<_> = (0..4).map(|_| h.hello()).collect();
    let mut waiting: Vec<_> = hellos.iter().map(|x| Box::pin(e.hello(&peer, x))).collect();
    for w in &mut waiting {
        assert!(
            (0..100).all(|_| poll_now(w.as_mut()).is_none()),
            "T's two spent: it waits for T+1"
        );
    }
    h.advance(SECOND);
    let before = h.state_reads();
    for w in &mut waiting {
        let _ = poll_now(w.as_mut());
    }
    let sent = h.state_reads() - before;
    for w in &mut waiting {
        let _ = (0..1000).find_map(|_| poll_now(w.as_mut()));
    }
    assert!(
        sent <= 4,
        "hellos that waited into T+1 read there, two reads at most (a NUT-07 check and a \
         restore each), not {sent} requests"
    );
    drop(waiting);
    h.release_swaps().await;

    // In T+1 the first hello reads, then P, and the second hello shares P's read (past two).
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    parked(h, &mut s, 4).await;
    h.advance(SECOND);
    for _ in 0..2 {
        let hello = h.hello();
        let mut f = Box::pin(e.hello(&peer, &hello));
        assert!(poll_now(f.as_mut()).is_none(), "its read under way");
    } // both dropped mid-read: T's two are spent
    let (one, two) = (h.hello(), h.hello());
    let mut first = Box::pin(e.hello(&peer, &one));
    let mut second = Box::pin(e.hello(&peer, &two));
    assert!(
        poll_now(first.as_mut()).is_none(),
        "T's two spent: it waits for T+1"
    );
    assert!(
        poll_now(second.as_mut()).is_none(),
        "T's two spent: it waits for T+1"
    );
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s2.pay(&p));
    assert!(
        (0..100).all(|_| poll_now(paying.as_mut()).is_none()),
        "T's two spent: P waits for T+1"
    );
    h.advance(SECOND);
    let before = h.state_reads();
    assert!(
        poll_now(first.as_mut()).is_none(),
        "the first hello reads in T+1"
    );
    assert!(poll_now(paying.as_mut()).is_none(), "P reads in T+1");
    let _ = poll_now(second.as_mut());
    let _ = (0..1000).find_map(|_| poll_now(first.as_mut()));
    let _ = (0..1000).find_map(|_| poll_now(paying.as_mut()));
    let _ = (0..1000).find_map(|_| poll_now(second.as_mut()));
    assert_eq!(
        h.state_reads() - before,
        4,
        "two reads in T+1 (a NUT-07 check and a restore each): P's read counts there"
    );
    drop((paying, first, second));
    h.release_swaps().await;
}

/// Flaw `WaitsForAnyUnderWay`. "waits for one under way that would serve it, and for
/// no other" (NFX-07 §3). A hello's read of A is under way and stalls; with fewer than two
/// sent, it serves no payment. A payment then reads itself, this second, learns A's claim,
/// and is `stale`.
async fn a_payment_waits_only_for_a_read_that_serves_it<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    lost_claim(h, &mut s, 4, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    let hello = h.hello();
    let mut stalled = Box::pin(e.hello(&peer, &hello));
    if poll_now(stalled.as_mut()).is_some() {
        return; // synchronous reads: nothing is ever under way
    }
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s.pay(&p));
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("the hello's read serves no payment: P reads itself, this second");
    assert!(
        is_rej(&r, &RejCode::Stale),
        "P's own read learnt A's claim: {r:?}"
    );
    drop((paying, stalled));
}

/// Flaws `FreedAfterDeadline`, `TakeoverFreedAfterDeadline`, `ReleaseFreedAfterDeadline`,
/// `DeadlineSecondLate` and `DeadlineSecondEarly`. A turn held past its payment's deadline
/// was freed at that deadline, however late P's answer goes out or an entry takes the turn
/// over (NFX-07 §3): a read sent in the deadline's second or later, while P still holds the
/// turn, was sent after the freeing, and serves the `hello` behind P. Hellos that passed
/// the turn before P took it wait on a stalled read; one reads A at P's deadline, or 5 s
/// past it, P still holding the turn (waiting for keys). The hello behind P then takes the
/// turn over, or finds it free once P is answered or dropped, reuses that read, sending
/// none of its own, and quotes what it learnt: A's claim if A reached the mint before the
/// deadline, and nothing if A reached it only while that read was under way. A turn freed
/// in the second before the deadline, once that read is back, was freed then: the read
/// does not serve the hello behind P, which reads itself and quotes A's claim.
async fn a_turn_held_past_its_deadline_was_freed_there<H: Harness>(h: &H) {
    // (seconds after P's arrival, how P leaves the turn, A at the mint before the deadline)
    for (at, leaves, early) in [
        (60, "taken over", false),
        (65, "taken over", false),
        (60, "answered", false),
        (65, "answered", false),
        (60, "dropped", false),
        (65, "dropped", false),
        (60, "taken over", true),
        (65, "answered", true),
        (59, "answered", false),
        (59, "dropped", false),
    ] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let a = parked(h, &mut s, 4).await;
        h.advance(SECOND);
        let peer = h.peer(1);
        let (one, two, three) = (h.hello(), h.hello(), h.hello());
        let mut first = Box::pin(e.hello(&peer, &one));
        if poll_now(first.as_mut()).is_some() {
            h.release_swaps().await;
            return; // synchronous reads: nothing is ever under way
        }
        let mut second = Box::pin(e.hello(&peer, &two));
        assert!(
            poll_now(second.as_mut()).is_none(),
            "waits for the first's read"
        );
        h.hold_key_fetches();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(1).await, // underpaid, once P has the keys
        };
        let mut paying = Some(Box::pin(s2.pay(&p)));
        assert!(
            paying
                .as_mut()
                .is_some_and(|f| poll_now(f.as_mut()).is_none()),
            "P holds the turn, waiting for keys"
        );
        let mut behind = Box::pin(e.hello(&peer, &three));
        assert!(poll_now(behind.as_mut()).is_none(), "the hello waits for P");
        if early {
            h.release_oldest_swap().await; // A finishes at the mint before P's deadline
            assert!(h.claimed_all(&a.token).await);
        }
        h.advance(Duration::from_secs(at)); // P's deadline is 60 s after its arrival
        let before = h.state_reads();
        assert!(
            poll_now(second.as_mut()).is_none(),
            "the second reads A, P still holding the turn"
        );
        if !early {
            h.release_oldest_swap().await; // A finishes at the mint while that read is under way
            assert!(h.claimed_all(&a.token).await);
        }
        let learnt = (0..1000)
            .find_map(|_| poll_now(second.as_mut()))
            .expect("the second's read back")
            .expect("a hello")
            .quote()
            .clone();
        match leaves {
            "answered" if at < 60 => {
                h.release_swaps().await; // P's keys come
                let r = paying
                    .as_mut()
                    .and_then(|f| (0..1000).find_map(|_| poll_now(f.as_mut())))
                    .expect("P answered before its deadline");
                assert!(is_rej(&r, &RejCode::Underpaid), "{r:?}");
            }
            "answered" => {
                let r = paying
                    .as_mut()
                    .and_then(|f| (0..1000).find_map(|_| poll_now(f.as_mut())))
                    .expect("P answered at its deadline");
                assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
            }
            "dropped" => paying = None, // its connection closes
            _ => {}                     // the hello takes the turn over
        }
        let q = (0..1000)
            .find_map(|_| poll_now(behind.as_mut()))
            .expect("the hello answered once P left the turn")
            .expect("a hello")
            .quote()
            .clone();
        if at < 60 {
            assert_eq!(
                h.state_reads() - before,
                4,
                "the second's read was sent before P was {leaves}, 1 s before its deadline, \
                 which freed the turn: the hello behind P reads itself"
            );
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "the hello's own read learnt A's claim"
            );
        } else {
            let past = at - 60;
            assert_eq!(
                h.state_reads() - before,
                2,
                "the second's read was sent after P's deadline, which freed the turn: it \
                 serves the hello behind P, which sends no read of its own ({past} s past the \
                 deadline, P {leaves})"
            );
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (learnt.accepted_upto, learnt.spent_total),
                "the hello quotes what that read learnt"
            );
        }
        if early {
            assert_eq!(
                (q.accepted_upto, q.spent_total),
                (4, 4),
                "A reached the mint before P's deadline freed the turn: the quote shows its claim"
            );
        }
        drop((paying, first));
        h.release_swaps().await;
    }
}

/// Flaws `AnswerFreedAfterDeadline` and `LandFreedAfterDeadline`. The same with P's swap
/// in flight at its deadline. A hello that passed the turn waits on a stalled read, A's
/// claim is learnt by a sweep, and P pays; P's swap is held on its way to the mint. At P's
/// deadline, or 5 s past it, that hello reads P's swap, P still holding the turn. Then P is
/// answered `mint-unavailable`, or its swap lands (its answer lost) while P still holds the
/// turn, or the hello behind P takes the turn over. That hello reuses the read, sending
/// none of its own, and quotes what it learnt, though P's claim may have reached the mint
/// since.
async fn a_turn_held_past_its_deadline_by_a_swap_was_freed_there<H: Harness>(h: &H) {
    for (past, leaves) in [
        (0, "P answered"),
        (5, "P answered"),
        (0, "P's swap landed, its answer lost"),
        (5, "P's swap landed, its answer lost"),
        (0, "P taken over"),
        (5, "P taken over"),
    ] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        lost_claim(h, &mut s, 4, 4).await;
        h.advance(SECOND);
        let peer = h.peer(1);
        let (one, two, three) = (h.hello(), h.hello(), h.hello());
        let mut first = Box::pin(e.hello(&peer, &one));
        if poll_now(first.as_mut()).is_some() {
            return; // synchronous reads: nothing is ever under way
        }
        let mut second = Box::pin(e.hello(&peer, &two));
        assert!(
            poll_now(second.as_mut()).is_none(),
            "waits for the first's read"
        );
        e.sweep().await; // A's claim is learnt meanwhile
        assert_eq!(serve(h, &mut s, 4, 4), 4, "A's claim is credited");
        h.hold_swaps();
        h.lose_next_swap_response();
        let p = Pay {
            upto_chunk: 8,
            token: h.token(4).await,
        };
        let mut paying = Box::pin(s2.pay(&p));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P holds the turn, its swap held"
        );
        let mut behind = Box::pin(e.hello(&peer, &three));
        assert!(poll_now(behind.as_mut()).is_none(), "the hello waits for P");
        h.advance(Duration::from_secs(60 + past)); // P's deadline, or `past` s after it
        let before = h.state_reads();
        assert!(
            poll_now(second.as_mut()).is_none(),
            "the second reads P's swap, P still holding the turn"
        );
        let learnt = (0..1000)
            .find_map(|_| poll_now(second.as_mut()))
            .expect("the second's read back")
            .expect("a hello")
            .quote()
            .clone();
        if leaves == "P answered" {
            let r = (0..1000)
                .find_map(|_| poll_now(paying.as_mut()))
                .expect("P answered at its deadline");
            assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
        }
        if leaves != "P taken over" {
            h.release_oldest_swap().await; // P's swap reaches the mint, its answer lost
            assert!(h.claimed_all(&p.token).await);
        }
        let q = (0..1000)
            .find_map(|_| poll_now(behind.as_mut()))
            .expect("the hello answered past P's deadline")
            .expect("a hello")
            .quote()
            .clone();
        assert_eq!(
            h.state_reads() - before,
            2,
            "the second's read of P's swap was sent after P's deadline, which freed the turn: \
             it serves the hello behind P, which sends no read of its own ({past} s past the \
             deadline, {leaves})"
        );
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (learnt.accepted_upto, learnt.spent_total),
            "the hello quotes what that read learnt"
        );
        drop((paying, first));
        h.release_swaps().await;
    }
}

/// Flaw `FloorAtFirstWake`. A `hello` behind two payments reads after the last freeing of
/// the turn before it found the turn free (NFX-07 §3), not after the first. It waits
/// behind P1; P1 is answered, and P2, polled first, takes the turn and reads A during the
/// hello's wait. A finishes at the mint while that read is under way, then P2 is answered:
/// the hello reads after P2, and quotes A's claim.
async fn a_hello_behind_two_payments_reads_after_the_last<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s1 = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let (p1, p2) = (
        Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        },
        Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        },
    );
    let mut one = Box::pin(s1.pay(&p1));
    if poll_now(one.as_mut()).is_some() {
        h.release_swaps().await;
        return; // synchronous reads: nothing is ever under way
    }
    let (peer, hello) = (h.peer(1), h.hello());
    let mut behind = Box::pin(e.hello(&peer, &hello));
    assert!(
        poll_now(behind.as_mut()).is_none(),
        "the hello waits for P1"
    );
    let mut two = Box::pin(s2.pay(&p2));
    assert!(poll_now(two.as_mut()).is_none(), "P2 waits for the turn");
    let r1 = (0..1000)
        .find_map(|_| poll_now(one.as_mut()))
        .expect("P1 answered: the turn freed");
    assert!(is_rej(&r1, &RejCode::MintUnavailable), "{r1:?}");
    let before = h.state_reads();
    assert!(
        poll_now(two.as_mut()).is_none(),
        "P2, polled first, takes the turn and reads A"
    );
    assert_eq!(
        h.state_reads() - before,
        2,
        "P2 read A, during the hello's wait"
    );
    assert!(
        poll_now(behind.as_mut()).is_none(),
        "the hello waits for P2, which holds the turn now"
    );
    h.release_swaps().await; // A finishes at the mint while P2's read is under way
    assert!(h.claimed_all(&a.token).await);
    let r2 = (0..1000)
        .find_map(|_| poll_now(two.as_mut()))
        .expect("P2 answered: the turn freed again");
    assert!(is_rej(&r2, &RejCode::MintUnavailable), "{r2:?}");
    drop((one, two));
    let q = settle_on(h, behind.as_mut(), 3)
        .expect("a hello")
        .quote()
        .clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "P2's read was sent before the turn was last freed: the hello reads after P2, and \
         quotes A's claim"
    );
}

/// Flaws `FloorIgnoredForUnderWay` and `HelloWaitsForAnyUnderWay`. An entry "waits for one
/// under way that would serve it, and for no other" (NFX-07 §3). A hello's read of A
/// stalls; P holds the turn waiting for keys, and a hello behind it waits. P is refused
/// `underpaid`, reading nothing. The stalled read was sent before the waited hello's wait
/// ended, so it serves that hello not: with one read of the second spent, it reads itself,
/// this second.
async fn a_waited_hello_waits_for_no_read_sent_before_its_wait_ended<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    let (one, two) = (h.hello(), h.hello());
    let mut stalled = Box::pin(e.hello(&peer, &one));
    if poll_now(stalled.as_mut()).is_some() {
        h.release_swaps().await;
        return; // synchronous reads: nothing is ever under way
    }
    h.hold_key_fetches();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(1).await,
    };
    let mut paying = Box::pin(s2.pay(&p));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "P holds the turn, waiting for keys"
    );
    let mut behind = Box::pin(e.hello(&peer, &two));
    assert!(poll_now(behind.as_mut()).is_none(), "the hello waits for P");
    h.release_swaps().await; // P's keys come
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("P answered");
    assert!(is_rej(&r, &RejCode::Underpaid), "{r:?}");
    drop(paying);
    let before = h.state_reads();
    assert!(
        (0..1000).find_map(|_| poll_now(behind.as_mut())).is_some(),
        "the stalled read was sent before its wait ended: the hello waits for no read, and \
         reads itself this second"
    );
    assert_eq!(h.state_reads() - before, 2, "its own read");
    drop(stalled);
}

/// Flaw `PlaceTakenPastDeadline`. No read is sent at or past its entry's deadline, "and
/// none counted" (NFX-07 §3). Hellos that passed the turn before P took it wait on a
/// stalled read of A. In P's second before its deadline two of them read and are dropped,
/// and a third finds that second's two spent and waits for the next; so does P, whose
/// keys come then, as A finishes at the mint. In P's deadline second the third reads A and
/// is dropped mid-read: one of that second's two is spent. P goes on only then, and finds
/// no time left to read. A fresh hello has the second's other place: it reads, this
/// second, and quotes A's claim.
async fn no_place_is_counted_at_the_deadline<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let peer = h.peer(1);
    let hellos: Vec<_> = (0..4).map(|_| h.hello()).collect();
    let mut first = Box::pin(e.hello(&peer, &hellos[0]));
    if poll_now(first.as_mut()).is_some() {
        h.release_swaps().await;
        return; // synchronous reads: nothing is ever under way
    }
    let mut waiting: Vec<_> = hellos[1..]
        .iter()
        .map(|hello| Box::pin(e.hello(&peer, hello)))
        .collect();
    for f in &mut waiting {
        assert!(poll_now(f.as_mut()).is_none(), "waits for the first's read");
    }
    h.hold_key_fetches();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s2.pay(&p));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "P holds the turn, waiting for keys"
    );
    h.advance(Duration::from_secs(59)); // P's second before its deadline
    let mut third = waiting.pop().expect("a hello");
    for mut f in waiting {
        assert!(
            poll_now(f.as_mut()).is_none(),
            "it reads A, and is dropped mid-read"
        );
    }
    assert!(
        poll_now(third.as_mut()).is_none(),
        "the second's two spent: it waits for the next"
    );
    h.release_swaps().await; // P's keys come; A finishes at the mint
    assert!(h.claimed_all(&a.token).await);
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "P finds this second's two reads spent, and waits for the next"
    );
    h.advance(SECOND); // P's deadline
    assert!(
        poll_now(third.as_mut()).is_none(),
        "the third reads A, in P's deadline second"
    );
    drop(third); // dropped mid-read: it counts
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("P answered at its deadline");
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    drop(paying);
    let hello = h.hello();
    let mut fresh = Box::pin(e.hello(&peer, &hello));
    let q = (0..1000)
        .find_map(|_| poll_now(fresh.as_mut()))
        .expect(
            "P sent and counted no read at its deadline: one place is left, and the hello reads \
             this second",
        )
        .expect("a hello")
        .quote()
        .clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the hello read A's claim"
    );
    drop(first);
}

/// The same wait as [`a_payment_waits_no_longer_than_its_deadline`], reached with
/// no entry left unpolled across the jump: P waits 59 s for its turn behind P0 (whose keys
/// never come); at P0's deadline a hello takes the turn over, two hellos read and drop,
/// two more find that second's two spent and wait for the next, and only then does P take
/// the turn. Its keys come in that second: it finds the second's two spent too, and waits
/// for the next. In the next second, P's deadline, the waiting hellos read first.
async fn a_payment_waits_no_longer_than_its_deadline_behind_a_turn<H: Harness>(h: &H) {
    for stalled in [true, false] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s0 = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        parked(h, &mut s, 4).await;
        h.advance(SECOND);
        h.hold_key_fetches();
        let p0 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let mut holding = Box::pin(s0.pay(&p0));
        assert!(
            poll_now(holding.as_mut()).is_none(),
            "P0 holds the turn, waiting for keys"
        );
        h.advance(SECOND);
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let arrived = h.clock_secs();
        let mut paying = Box::pin(s2.pay(&p));
        assert!(poll_now(paying.as_mut()).is_none(), "P waits for its turn");
        h.advance(Duration::from_secs(59)); // P0's deadline; P's second before its own
        let peer = h.peer(1);
        let hellos: Vec<_> = (0..4).map(|_| h.hello()).collect();
        let mut late = Vec::new();
        for (n, hello) in hellos.iter().enumerate() {
            let mut f = Box::pin(e.hello(&peer, hello));
            if poll_now(f.as_mut()).is_some() {
                h.release_swaps().await;
                return; // synchronous reads: nothing is ever under way
            }
            if n >= 2 {
                late.push(f); // the second's two spent: it waits for the next
            } // the first two read, and are dropped mid-read
        }
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P takes the turn, and waits for keys"
        );
        h.release_swaps().await; // P's keys come, a second before its deadline
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P finds this second's two reads spent, and waits for the next"
        );
        drop(holding);
        h.advance(SECOND); // P's deadline
        let mut it = late.into_iter();
        let mut third = it.next().expect("a hello");
        let mut fourth = it.next().expect("a hello");
        assert!(
            poll_now(third.as_mut()).is_none(),
            "it reads, in P's deadline second"
        );
        drop(third);
        assert!(poll_now(fourth.as_mut()).is_none(), "it reads too");
        let kept = if stalled {
            Some(fourth)
        } else {
            drop(fourth);
            None
        };
        let r = (0..1000).find_map(|_| poll_now(paying.as_mut()));
        assert!(
            r.as_ref()
                .is_some_and(|r| is_rej(r, &RejCode::MintUnavailable)),
            "P answered at its deadline, {} s after arrival (a read stalled: {stalled}): {r:?}",
            h.clock_secs() - arrived
        );
        drop((paying, kept));
    }
}

/// F1a: a watcher pays with proofs of an older keyset (never expired) while the mint's
/// active keyset has expired; the seeder cannot swap, the watcher's reclaim has no keyset
/// for its outputs. Once the mint rotates, the older keyset's proofs are still good (CDK
/// rotation touches no other keyset), so the reclaim takes them back.
async fn older_proofs_reclaimed_after_rotation<H: Harness>(h: &H) {
    h.expire_active_keyset();
    h.fund_older_keyset(1000);
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due, in the older keyset's proofs");
    let rej = s.pay(&pay).await.expect_err("no keyset to swap to");
    assert_eq!(rej.code, RejCode::MintUnavailable);
    v.rej(&rej).await;
    assert!(
        !h.claimed_any(&pay.token).await,
        "incomplete: no keyset for the reclaim's outputs"
    );
    h.rotate_keyset();
    h.fund_older_keyset(0);
    let _ = v.due().await.expect("due answers once the mint rotates");
    assert!(
        h.claimed_all(&pay.token).await,
        "once the mint rotates, the older keyset's proofs (never expired) are taken back"
    );
}

/// F1b: an honest pair. The watcher pays in an older keyset's proofs; before the seeder
/// swaps, the mint's active keyset expires and is rotated out. The older keyset never
/// expired, so the swap (to the new active keyset) goes through at a CDK mint.
async fn older_proofs_swapped_after_rotation<H: Harness>(h: &H) {
    h.fund_older_keyset(1000);
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    for i in 0..2 {
        assert!(s.admit(&h.chunk(i)));
        v.requested();
    }
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due, in the older keyset's proofs");
    h.expire_active_keyset();
    h.rotate_keyset();
    let ack = s
        .pay(&pay)
        .await
        .expect("the older keyset never expired: swapped to the new active keyset");
    assert_eq!((ack.accepted_upto, ack.spent_total), (2, 2));
    v.ack(&ack).expect("the honest ack is taken");
    h.fund_older_keyset(0);
}

/// F2: a seeder keeps one proof of a three-proof payment; a 12003 follows (the kept proof's
/// keyset expired) while the mint's active keyset has expired too, so the inputs left
/// (older keyset, good) cannot be taken back yet. NFX-07 §3a: the whole reclaim is
/// incomplete, retried once the mint has a keyset; then the rest are taken back and the
/// payment awaits a quote.
async fn foreign_rest_taken_back_after_rotation<H: Harness>(h: &H) {
    let e = h.engine(7, 2, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(7);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due: 7 sat, three proofs");
    assert!(h.steal_one(&pay.token).await, "the seeder keeps one proof");
    h.expire_keyset_of(&pay.token, 1);
    h.rotate_keyset(); // the other two now of an older keyset, still good
    h.expire_active_keyset(); // no keyset for a reclaim's outputs
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        !h.claimed_all(&pay.token).await,
        "the rest cannot be taken back yet"
    );
    v.requested();
    assert!(
        v.due()
            .await
            .expect("due answers with its reclaim incomplete")
            .is_none(),
        "nothing is paid meanwhile"
    );
    h.rotate_keyset();
    assert!(
        v.due()
            .await
            .expect("due answers once the mint rotates")
            .is_none()
            && v.awaiting_quote(),
        "a spent input not its own: it awaits a quote"
    );
    assert!(
        h.claimed_all(&pay.token).await,
        "once the mint rotates, the inputs left are taken back"
    );
    drop(s);
}

/// F3: at a session's end too, a watcher whose only proofs are listed expired pays nothing.
async fn last_pay_never_with_expired_proofs<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut v = h.viewer(1);
    v.quote(s.quote()).expect("an honest quote is accepted");
    assert!(s.admit(&h.chunk(0)));
    v.requested();
    h.expire_active_keyset();
    assert!(
        v.last_pay()
            .await
            .expect("last_pay answers holding only expired proofs")
            .is_none(),
        "its only proofs are listed expired: never paid with, at the end either"
    );
    h.rotate_keyset();
    let pay = v
        .last_pay()
        .await
        .expect("last_pay answers once the mint rotates")
        .expect("once the mint rotates, it pays the tail");
    let ack = s.pay(&pay).await.expect("swapped");
    v.ack(&ack).expect("the tail's honest ack is taken");
}

/// A `hello` waits while any payment holds its account's turn, each to its own deadline,
/// whichever takes the turn next: behind P1 (its keys never come) and P2 (arrived 30 s
/// later, polled first at P1's deadline and so taking the turn over), it is answered at
/// P2's deadline, not at P1's.
async fn a_hello_waits_while_any_payment_holds_the_turn<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let mut second = open(h, &e, 1).await;
    let (p1, p2) = (
        Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        },
        Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        },
    );
    h.hold_key_fetches();
    let t0 = h.clock_secs();
    let (peer, hello) = (h.peer(1), h.hello());
    let mut one = Box::pin(first.pay(&p1));
    assert!(
        (0..1000).find_map(|_| poll_now(one.as_mut())).is_none(),
        "P1 holds the turn, its keys held"
    );
    let mut quote = Box::pin(e.hello(&peer, &hello));
    assert!(
        (0..1000).find_map(|_| poll_now(quote.as_mut())).is_none(),
        "the hello waits for P1"
    );
    h.advance(Duration::from_secs(30));
    let mut two = Box::pin(second.pay(&p2));
    assert!(
        (0..1000).find_map(|_| poll_now(two.as_mut())).is_none(),
        "P2 waits for the turn"
    );
    h.advance(Duration::from_secs(30)); // P1's deadline
    assert!(
        (0..1000).find_map(|_| poll_now(two.as_mut())).is_none(),
        "P2, polled first, takes the turn over, its keys held"
    );
    let r1 = (0..1000)
        .find_map(|_| poll_now(one.as_mut()))
        .expect("P1 is answered at its deadline");
    assert!(is_rej(&r1, &RejCode::MintUnavailable), "{r1:?}");
    assert!(
        (0..1000).find_map(|_| poll_now(quote.as_mut())).is_none(),
        "the hello waits for P2 too, which holds the turn now"
    );
    h.advance(Duration::from_secs(29));
    assert!(
        (0..1000).find_map(|_| poll_now(quote.as_mut())).is_none(),
        "the hello waits to P2's deadline"
    );
    h.advance(SECOND); // P2's deadline, 60 s from its arrival
    let r2 = (0..1000)
        .find_map(|_| poll_now(two.as_mut()))
        .expect("P2 is answered at its deadline");
    assert!(is_rej(&r2, &RejCode::MintUnavailable), "{r2:?}");
    let s = (0..1000)
        .find_map(|_| poll_now(quote.as_mut()))
        .expect("the hello is answered once P2 is")
        .expect("it opens");
    assert_eq!(
        h.clock_secs() - t0,
        90,
        "the hello is answered at P2's deadline, having waited for both"
    );
    assert_eq!((s.quote().accepted_upto, s.quote().spent_total), (0, 0));
    drop((one, two));
    h.release_swaps().await;
}

/// Flaws `HelloUncountedAfterFirst` and `QuoteAtFirstWake`. Hellos behind two payments
/// wait for both (NFX-07 §3), counting toward the session cap while they wait. P1 holds the
/// turn, its swap held, and P2 waits for it; the rest of the peer's cap are hellos waiting
/// behind P1, and one more is refused. P1 is acknowledged, and P2, polled first, takes the
/// turn: the hellos wait on behind P2, still counting, so one more is still refused. Once
/// P2 is acknowledged too, each quotes both payments.
async fn hellos_behind_two_payments_wait_for_both<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 2).await;
    let mut second = open(h, &e, 2).await;
    serve(h, &mut first, 0, 2);
    h.hold_swaps();
    let (p1, p2) = (
        Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        },
        Pay {
            upto_chunk: 2,
            token: h.token(1).await,
        },
    );
    let mut one = Box::pin(first.pay(&p1));
    assert!(
        poll_now(one.as_mut()).is_none(),
        "P1 holds the turn, its swap held"
    );
    let mut two = Box::pin(second.pay(&p2));
    assert!(poll_now(two.as_mut()).is_none(), "P2 waits for the turn");
    let peer = h.peer(2);
    let hellos: Vec<_> = (0..h.session_cap()).map(|_| h.hello()).collect();
    let mut waiting = Vec::new();
    for hello in &hellos[2..] {
        let mut w = Box::pin(e.hello(&peer, hello));
        assert!(poll_now(w.as_mut()).is_none(), "it waits for P1");
        waiting.push(w);
    }
    let mut over = Box::pin(e.hello(&peer, &hellos[0]));
    assert!(
        poll_now(over.as_mut()).is_some_and(|r| is_rej(&r, &RejCode::BadSession)),
        "one past the cap is refused, behind P1"
    );
    drop(over);
    h.release_oldest_swap().await; // P1's swap
    let r1 = (0..1000)
        .find_map(|_| poll_now(one.as_mut()))
        .expect("P1 answered");
    assert!(r1.is_ok(), "{r1:?}");
    assert!(
        poll_now(two.as_mut()).is_none(),
        "P2, polled first, takes the turn, its swap held"
    );
    for w in &mut waiting {
        assert!(poll_now(w.as_mut()).is_none(), "it waits on, behind P2");
    }
    let mut over = Box::pin(e.hello(&peer, &hellos[1]));
    assert!(
        poll_now(over.as_mut()).is_some_and(|r| is_rej(&r, &RejCode::BadSession)),
        "hellos waiting behind P2 still count toward the session cap: one past it is refused"
    );
    drop(over);
    h.release_swaps().await;
    let r2 = (0..1000)
        .find_map(|_| poll_now(two.as_mut()))
        .expect("P2 answered");
    assert!(r2.is_ok(), "{r2:?}");
    for w in &mut waiting {
        let q = (0..1000)
            .find_map(|_| poll_now(w.as_mut()))
            .expect("the hello answered once P2 is")
            .expect("a hello")
            .quote()
            .clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (2, 2),
            "a quote never misses an acknowledged payment: P1's and P2's"
        );
    }
}

/// Flaw `TurnWaitPastDeadline`. A payment waiting for its account's turn is answered at its
/// own deadline, whichever payment holds the turn then (NFX-07 §3: "the wait for the
/// account's turn ... count[s]"). P1 holds the turn, its keys held; P2 arrives 30 s later,
/// and P3 20 s after that. At P1's deadline P3, polled first, takes the turn over. P2 is
/// answered `mint-unavailable` at its own deadline, though P3 still holds the turn.
async fn a_waiting_payment_is_answered_at_its_own_deadline<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let mut second = open(h, &e, 1).await;
    let mut third = open(h, &e, 1).await;
    let mut pays = Vec::new();
    for _ in 0..3 {
        pays.push(Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        });
    }
    h.hold_key_fetches();
    let t0 = h.clock_secs();
    let mut one = Box::pin(first.pay(&pays[0]));
    assert!(
        (0..1000).find_map(|_| poll_now(one.as_mut())).is_none(),
        "P1 holds the turn, its keys held"
    );
    h.advance(Duration::from_secs(30));
    let mut two = Box::pin(second.pay(&pays[1]));
    assert!(
        (0..1000).find_map(|_| poll_now(two.as_mut())).is_none(),
        "P2 waits for the turn"
    );
    h.advance(Duration::from_secs(20));
    let mut three = Box::pin(third.pay(&pays[2]));
    assert!(
        (0..1000).find_map(|_| poll_now(three.as_mut())).is_none(),
        "P3 waits for the turn"
    );
    h.advance(Duration::from_secs(10)); // P1's deadline
    assert!(
        (0..1000).find_map(|_| poll_now(three.as_mut())).is_none(),
        "P3, polled first, takes the turn over, its keys held"
    );
    let r1 = (0..1000)
        .find_map(|_| poll_now(one.as_mut()))
        .expect("P1 is answered at its deadline");
    assert!(is_rej(&r1, &RejCode::MintUnavailable), "{r1:?}");
    assert!(
        (0..1000).find_map(|_| poll_now(two.as_mut())).is_none(),
        "P2 waits, P3 holding the turn"
    );
    h.advance(Duration::from_secs(29));
    assert!(
        (0..1000).find_map(|_| poll_now(two.as_mut())).is_none(),
        "P2 waits to its deadline"
    );
    h.advance(SECOND); // P2's deadline, 60 s from its arrival
    let r2 = (0..1000).find_map(|_| poll_now(two.as_mut()));
    assert!(
        r2.as_ref()
            .is_some_and(|r| is_rej(r, &RejCode::MintUnavailable)),
        "P2 is answered mint-unavailable at its own deadline, {} s after P1's arrival, \
         though P3 still holds the turn: {r2:?}",
        h.clock_secs() - t0
    );
    drop((one, two, three));
    h.release_swaps().await;
}

/// Flaw `HolderDeadlineFromTurn`. A payment holds the turn at most to its own deadline, 60 s
/// from its arrival (NFX-07 §3), one that waited for the turn included. P1 holds the turn,
/// its swap held; P2 arrives 30 s later and waits. At 40 s P1's swap lands, and P2 takes the
/// turn, sends its swap (held too) and is dropped. A hello at 85 s waits for P2's turn, and
/// is answered at P2's deadline, 90 s, not 60 s after P2 took the turn.
async fn a_dropped_payment_that_waited_holds_the_turn_to_its_deadline<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut first = open(h, &e, 1).await;
    let mut second = open(h, &e, 1).await;
    serve(h, &mut first, 0, 2);
    let (p1, p2) = (
        Pay {
            upto_chunk: 1,
            token: h.token(1).await,
        },
        Pay {
            upto_chunk: 2,
            token: h.token(1).await,
        },
    );
    h.hold_swaps();
    let t0 = h.clock_secs();
    let mut one = Box::pin(first.pay(&p1));
    assert!(
        (0..1000).find_map(|_| poll_now(one.as_mut())).is_none(),
        "P1's swap is held on its way to the mint"
    );
    h.advance(Duration::from_secs(30));
    let mut two = Box::pin(second.pay(&p2));
    assert!(
        (0..1000).find_map(|_| poll_now(two.as_mut())).is_none(),
        "P2 waits for the turn"
    );
    h.advance(Duration::from_secs(10));
    h.release_oldest_swap().await; // P1's swap lands in time
    let r1 = (0..1000)
        .find_map(|_| poll_now(one.as_mut()))
        .expect("P1 is answered");
    assert!(r1.is_ok(), "{r1:?}");
    assert!(
        (0..1000).find_map(|_| poll_now(two.as_mut())).is_none(),
        "P2 takes the turn, its swap held on its way to the mint"
    );
    drop(two); // its connection closes, its swap in flight
    h.advance(Duration::from_secs(45));
    let (peer, hello) = (h.peer(1), h.hello());
    let mut quote = Box::pin(e.hello(&peer, &hello));
    assert!(
        (0..1000).find_map(|_| poll_now(quote.as_mut())).is_none(),
        "the hello waits for P2's turn"
    );
    h.advance(Duration::from_secs(5)); // P2's deadline, 60 s from its arrival
    // It takes the turn over, then reads P2's swap: round trips take polls, not time.
    let answered = (0..10_000).find_map(|_| poll_now(quote.as_mut()));
    assert!(
        answered.is_some(),
        "the hello is answered at P2's deadline, {} s, 60 s from P2's arrival, not 60 s from \
         when P2 took the turn",
        h.clock_secs() - t0
    );
    drop((quote, one));
    h.release_swaps().await;
}

/// A swap whose answer is lost at its payment's deadline is not retried there: the seeder
/// retries "while it still has time", and its requests all end at the deadline. Observed
/// through a mint event queued for the next swap request: no request is sent, so the mint
/// stays up, and the account's next hello learns the claim.
async fn no_retry_at_the_deadline<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swaps();
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s.pay(&pay));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "its swap is held on its way to the mint"
    );
    h.advance(Duration::from_secs(60)); // its deadline; the payment is not polled meanwhile
    h.lose_next_swap_response();
    h.before_next_swap(MintEvent::Down); // any swap request sent from here finds the mint down
    h.release_swaps().await; // processed at the deadline, its answer lost
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("answered");
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    drop(paying);
    drop(s);
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "no retry was sent at the deadline: the mint is still up, and the hello's read learns \
         the claim"
    );
}

/// Two hellos naming one session id, both waiting for a payment in progress: once it is
/// answered, one opens and the other is refused `bad-session`.
async fn one_session_id_for_two_waiting_hellos<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_swaps();
    let pay = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s.pay(&pay));
    assert!(poll_now(paying.as_mut()).is_none(), "its swap is held");
    let hello = h.hello(); // one session id, sent twice
    let (peer, again) = (h.peer(1), hello.clone());
    let mut a = Box::pin(e.hello(&peer, &hello));
    let mut b = Box::pin(e.hello(&peer, &again));
    assert!(poll_now(a.as_mut()).is_none(), "it waits for the payment");
    assert!(poll_now(b.as_mut()).is_none(), "it waits for the payment");
    h.release_swaps().await;
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("answered");
    assert!(r.is_ok(), "{r:?}");
    let ra = (0..1000)
        .find_map(|_| poll_now(a.as_mut()))
        .expect("answered");
    let rb = (0..1000)
        .find_map(|_| poll_now(b.as_mut()))
        .expect("answered");
    let opened = usize::from(ra.is_ok()) + usize::from(rb.is_ok());
    let refused = usize::from(is_rej(&ra, &RejCode::BadSession))
        + usize::from(is_rej(&rb, &RejCode::BadSession));
    assert_eq!(
        (opened, refused),
        (1, 1),
        "one session id names one open session: of two hellos that waited, one opens and the \
         other is refused bad-session"
    );
}

/// A `hello` refused `bad-session` after its wait, another peer having opened its session
/// id meanwhile, keeps nothing: once every session has closed, its peer opens that id,
/// then its full cap of sessions, and holds no account.
async fn a_hello_refused_bad_session_after_its_wait_keeps_nothing<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let (peer, hello) = (h.peer(1), h.hello());
    let mut s = open(h, &e, 1).await;
    h.hold_swaps();
    {
        let replay = Pay {
            upto_chunk: 4,
            token: spent,
        };
        let mut paying = pin!(s.pay(&replay));
        assert!(poll_now(paying.as_mut()).is_none(), "its swap is held");
        let mut waiting = pin!(e.hello(&peer, &hello));
        assert!(
            poll_now(waiting.as_mut()).is_none(),
            "it waits for the payment"
        );
        let holder = e.hello(&h.peer(2), &hello).await;
        let holder = holder.expect("another peer opens that id meanwhile");
        h.release_swaps().await;
        let r = paying.await;
        assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
        let r = waiting.await;
        assert!(
            is_rej(&r, &RejCode::BadSession),
            "a waited hello whose session id was opened meanwhile is refused bad-session: {:?}",
            r.as_ref().err()
        );
        drop(holder);
    }
    drop(s);
    let first = e.hello(&peer, &hello).await;
    let mut sessions = vec![
        first.expect("the refused hello did not take the id: it is free once its holder closed"),
    ];
    for _ in 1..h.session_cap() {
        let s = e.hello(&peer, &h.hello()).await;
        sessions.push(s.expect("the refused hello holds no place under the session cap"));
    }
    sessions.clear();
    assert_eq!(
        h.identities_held(&e),
        0,
        "a hello refused bad-session after its wait creates no account"
    );
}

/// A quote settles a payment only when `spent_total` is the ledger plus the payment: with a
/// payment already acknowledged, a quote showing the new payment's `upto` with `spent_total`
/// inflated, or with the ledger's earlier spend dropped (a resync down), settles nothing and
/// is dishonest, whether the payment is unsettled, awaiting a quote, or being reclaimed.
async fn a_settling_quote_matches_both_fields<H: Harness>(h: &H) {
    for list in ["unsettled", "awaiting a quote", "reclaiming"] {
        for (lie, spent) in [("inflated", 5u64), ("the ledger dropped", 2)] {
            let e = h.engine(1, 4, 1000);
            let mut s = open(h, &e, 1).await;
            let mut v = h.viewer(1);
            v.quote(s.quote()).expect("an honest quote is accepted");
            for i in 0..2 {
                assert!(s.admit(&h.chunk(i)));
                v.requested();
            }
            let first = v
                .due()
                .await
                .expect("due answers with two chunks requested")
                .expect("due");
            v.ack(&s.pay(&first).await.expect("accepted"))
                .expect("the honest ack of the first payment is taken"); // the ledger: 2, 2
            for i in 2..4 {
                assert!(s.admit(&h.chunk(i)));
                v.requested();
            }
            let second = v
                .due()
                .await
                .expect("due answers with four chunks requested")
                .expect("due");
            assert_eq!(second.upto_chunk, 4);
            let unavailable = Rej {
                code: RejCode::MintUnavailable,
                detail: None,
            };
            match list {
                "unsettled" => {}
                "awaiting a quote" => {
                    assert!(h.steal(&second.token).await, "the seeder kept it");
                    v.rej(&unavailable).await;
                    assert!(v.awaiting_quote());
                }
                _ => {
                    h.mint_outage(true);
                    v.rej(&unavailable).await; // its reclaim cannot be sent: incomplete
                    h.mint_outage(false);
                    assert!(!v.awaiting_quote());
                }
            }
            drop(s);
            v.end();
            let mut q = open(h, &e, 1).await.quote().clone();
            (q.accepted_upto, q.spent_total) = (4, spent); // honest would be (4, 4)
            assert!(
                v.quote(&q).is_err() && v.stopped(),
                "{list}, {lie}: a quote whose spent_total is not the ledger plus the payment \
                 settles nothing, and is dishonest"
            );
        }
    }
}

/// A hello that did not wait for a payment reuses any read of its account that second which
/// covered its swaps and is back, a payment's included. Only a hello that waited reads after
/// the payment.
async fn an_unwaited_hello_reuses_the_payments_read<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    let a = parked(h, &mut s, 4).await;
    h.advance(SECOND);
    // P reads A (its own read, this second), learns nothing, and is answered at once: the
    // turn is freed.
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let r = s.pay(&p).await;
    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
    let before = h.state_reads();
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!((q.accepted_upto, q.spent_total), (0, 0));
    assert_eq!(
        h.state_reads() - before,
        0,
        "a hello that did not wait reuses the payment's read of this second, back and covering A"
    );
    h.release_swaps().await;
    assert!(h.claimed_all(&a.token).await);
}

/// A spent input not its own beside inputs left pending keeps the reclaim incomplete, after
/// a 12003 or with no keyset expired (`expire`): the watcher retries, and once the mint rolls
/// the request back it takes them back, and awaits a quote. A seeder keeps one proof of a
/// three-proof payment, in a swap of that proof alone, and a request of the rest is held
/// reserved at the mint.
async fn a_pending_rest_keeps_the_reclaim_incomplete<H: Harness>(h: &H, expire: bool) {
    let e = h.engine(7, 2, 1000);
    let s = open(h, &e, 1).await;
    let mut v = h.viewer(7);
    v.quote(s.quote()).expect("an honest quote is accepted");
    v.requested();
    let pay = v
        .due()
        .await
        .expect("due answers")
        .expect("due: 7 sat, three proofs");
    assert!(h.steal_one(&pay.token).await, "the seeder keeps one proof");
    assert!(
        h.reserve_rest(&pay.token).await,
        "a request of the rest, held reserved"
    );
    if expire {
        h.expire_keyset_of(&pay.token, 1); // the kept proof's keyset expires: the reclaim gets a 12003
    }
    v.rej(&Rej {
        code: RejCode::MintUnavailable,
        detail: None,
    })
    .await;
    assert!(
        !v.awaiting_quote()
            && v.due()
                .await
                .expect("due answers with the rest pending")
                .is_none(),
        "the inputs left are pending: the reclaim is incomplete, not settled as found spent"
    );
    h.roll_back_reserved();
    v.requested();
    let _ = v
        .due()
        .await
        .expect("due answers once the request is rolled back");
    assert!(
        !h.steal(&pay.token).await,
        "once the mint rolled the request back, the watcher took the rest back"
    );
    assert!(
        v.awaiting_quote(),
        "and, a proof being someone else's, awaits a quote"
    );
    drop(s);
}

/// Good proofs a wallet holds are kept when it drops those the mint lists expired, and are
/// paid with later. The mint's active keyset has expired, and the wallets hold 1 sat of an
/// older keyset that has not: a payment of 2 sat, drawn from both, cannot be made (its good
/// proof falls short, the rest are listed expired), by `due()` or by `last_pay()`. The same
/// watcher then owes 1 sat on the seeder's other video, and pays it with the good proof it
/// kept, which the seeder swaps once the mint rotates.
async fn good_held_proofs_kept_beside_expired<H: Harness>(h: &H) {
    for last in [false, true] {
        h.expire_active_keyset();
        h.fund_older_keyset(1);
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("a fair quote");
        for i in 0..2 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        let pay = if last {
            v.last_pay().await
        } else {
            v.due().await
        };
        assert!(
            pay.expect("its payment answers").is_none(),
            "2 sat owed, 1 sat of good proofs held, the rest listed expired: it pays nothing \
             (its last payment: {last})"
        );
        let mut s1 = open_on(h, &e, 1, 1).await;
        let mut sibling = v.sibling();
        sibling.quote(s1.quote()).expect("a fair quote");
        assert!(s1.admit(&h.chunk_of(1, 0)));
        sibling.requested();
        let pay = sibling
            .last_pay()
            .await
            .expect("its last payment answers")
            .expect("1 sat owed: paid with the good older proof the wallet kept");
        h.rotate_keyset();
        let ack = s1
            .pay(&pay)
            .await
            .expect("its payment holds only the good older proof: swapped");
        assert_eq!((ack.accepted_upto, ack.spent_total), (1, 1));
        sibling.ack(&ack).expect("the seeder's own ack is taken");
        h.fund_older_keyset(0);
        drop(s);
    }
}

/// Proofs a wallet still holds of an older keyset that has reached its own `final_expiry`,
/// while the mint's active keyset is current, are listed expired: never paid with, though a
/// wallet spends an older keyset's proofs first, nor at a session's end. The watcher pays
/// with others, and the seeder swaps them.
async fn held_expired_proofs_never_paid_with<H: Harness>(h: &H) {
    for last in [false, true] {
        h.fund_older_keyset(1000);
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("an honest quote is accepted");
        for i in 0..2 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        let first = v
            .due()
            .await
            .expect("due answers")
            .expect("due, in the older keyset's proofs");
        v.ack(
            &s.pay(&first)
                .await
                .expect("the older keyset is good: swapped"),
        )
        .expect("the honest ack is taken");
        h.expire_older_keyset(); // the proofs the wallet still holds of it expire too
        for i in 2..4 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        let (pay, which) = if last {
            (v.last_pay().await, "its session's last payment")
        } else {
            (v.due().await, "its payment")
        };
        let pay = pay
            .expect("its payment answers")
            .expect("due, in proofs of a keyset not expired");
        let ack = s.pay(&pay).await.unwrap_or_else(|rej| {
            panic!("{which} holds no proof of the expired older keyset: swapped: {rej:?}")
        });
        assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
        v.ack(&ack).expect("the honest ack is taken");
        h.fund_older_keyset(0);
    }
}

/// A reclaim's outputs are of the mint's active keyset, and the watcher reclaims at once
/// whatever the proofs' own keyset: proofs of an older keyset that never expires are taken
/// back into an active keyset whose `final_expiry` comes sooner. If that reclaim's answer is
/// lost and the active keyset expires before the retry, a restore no longer shows its
/// outputs: the watcher treats the proofs as found spent, whatever their own keyset, and
/// awaits a quote (NFX-07 §3a's concession).
async fn older_proofs_reclaimed_into_an_expiring_keyset<H: Harness>(h: &H) {
    h.fund_older_keyset(1000);
    h.keyset_expires_in(Some(h.account_ttl())); // too soon for a seeder to swap to
    for lost in [false, true] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut v = h.viewer(1);
        v.quote(s.quote()).expect("an honest quote is accepted");
        for i in 0..2 {
            assert!(s.admit(&h.chunk(i)));
            v.requested();
        }
        let pay = v
            .due()
            .await
            .expect("due answers")
            .expect("due, in the older keyset's proofs");
        let rej = s
            .pay(&pay)
            .await
            .expect_err("the active keyset expires too soon to swap to");
        assert_eq!(rej.code, RejCode::MintUnavailable);
        if lost {
            h.lose_next_reclaim_response();
        }
        v.rej(&rej).await;
        assert!(
            h.claimed_all(&pay.token).await,
            "reclaimed at once into the active keyset, though it expires sooner than the \
             proofs' own (answer lost: {lost})"
        );
        if !lost {
            assert!(
                !v.awaiting_quote()
                    && v.due()
                        .await
                        .expect("due answers with every proof back")
                        .is_some(),
                "every proof back: it pays again"
            );
            continue;
        }
        h.advance(h.account_ttl());
        h.expire_active_keyset();
        assert!(
            v.due()
                .await
                .expect("due answers once its reclaim's outputs expired")
                .is_none()
                && v.awaiting_quote(),
            "its reclaim's outputs expired unrestored: the proofs are treated as found spent, \
             whatever their own keyset, and it awaits a quote"
        );
        drop(s);
        v.end();
        h.rotate_keyset();
        let s = open(h, &e, 1).await;
        assert_eq!(
            (s.quote().accepted_upto, s.quote().spent_total),
            (0, 0),
            "the seeder never swapped it"
        );
        v.quote(s.quote())
            .expect("a quote equal to the ledger is honest");
        assert!(
            v.awaiting_quote(),
            "a quote equal to the ledger leaves it waiting: the concession's cost"
        );
    }
    h.fund_older_keyset(0);
}

/// A swap learnt as nothing pays for nothing: its account's chunks stay in the global count
/// until they age out at `debt_ttl`, whether its answer was lost or it was abandoned in
/// flight, and whoever learns it: the sweep, the account's own hello, or its next payment
/// (whose own swap then finds the mint down). Here its watcher took the proofs back, so it
/// can no longer go through.
async fn a_swap_learnt_as_nothing_frees_no_debt<H: Harness>(h: &H) {
    for in_flight in [false, true] {
        for by in ["the sweep", "its hello", "a payment"] {
            let e = h.engine(1, 4, 4);
            let admitted = h.clock_secs();
            let mut s = open(h, &e, 1).await;
            assert_eq!(serve(h, &mut s, 0, 4), 4, "the cap is full");
            let p = Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            };
            if in_flight {
                h.hold_next_swap();
                let (r, ()) = both(s.pay(&p), async {
                    yield_once().await;
                    h.advance(Duration::from_secs(60));
                })
                .await;
                assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
                assert!(h.steal(&p.token).await, "its watcher takes the proofs back");
            } else {
                h.time_out_next_swap();
                h.mint_outage(true);
                assert!(is_rej(&s.pay(&p).await, &RejCode::MintUnavailable));
                h.mint_outage(false);
                assert!(h.steal(&p.token).await, "its watcher takes the proofs back");
                h.release_swaps().await; // the given-up request finds its inputs spent
            }
            h.advance(SECOND); // no read of the account's is reused
            let before = h.state_reads();
            match by {
                "the sweep" => e.sweep().await,
                "its hello" => drop(open(h, &e, 1).await),
                _ => {
                    h.before_next_swap(MintEvent::Down);
                    let r = s
                        .pay(&Pay {
                            upto_chunk: 4,
                            token: h.token(4).await,
                        })
                        .await;
                    assert!(is_rej(&r, &RejCode::MintUnavailable), "{r:?}");
                    h.mint_outage(false);
                }
            }
            assert!(
                h.state_reads() > before,
                "{by} reads the swap (in flight {in_flight})"
            );
            let mut other = open(h, &e, 2).await;
            assert_eq!(
                serve(h, &mut other, 0, 4),
                0,
                "a swap learnt as nothing frees none of its chunks from the global cap (learnt by \
                 {by}, in flight {in_flight})"
            );
            let aged = admitted + h.debt_ttl().as_secs();
            h.advance(Duration::from_secs(aged - 1 - h.clock_secs()));
            assert_eq!(
                serve(h, &mut other, 0, 4),
                0,
                "still counted a second before debt_ttl (learnt by {by}, in flight {in_flight})"
            );
            h.advance(SECOND);
            assert_eq!(
                serve(h, &mut other, 0, 4),
                4,
                "they age out at debt_ttl (learnt by {by}, in flight {in_flight})"
            );
            h.release_swaps().await;
        }
    }
}

/// Debt ages whatever payments do: a payment refused while its account's earlier swap is
/// unknown leaves the account's chunks to age out of the global count at `debt_ttl`.
async fn debt_ages_while_a_swap_is_unknown<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut debtor = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut debtor, 0, 4), 4, "the cap is full");
    let parked = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    h.time_out_next_swap();
    h.mint_outage(true);
    assert!(is_rej(
        &debtor.pay(&parked).await,
        &RejCode::MintUnavailable
    ));
    h.mint_outage(false);
    let r = debtor
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await;
    assert!(
        is_rej(&r, &RejCode::MintUnavailable),
        "refused while its earlier swap is unknown: {r:?}"
    );
    let mut late = open(h, &e, 2).await;
    h.advance(h.debt_ttl() - SECOND);
    assert_eq!(
        serve(h, &mut late, 0, 1),
        0,
        "still counted a second before debt_ttl"
    );
    h.advance(SECOND);
    assert_eq!(
        serve(h, &mut late, 0, 10),
        4,
        "the refused account's chunks age out at debt_ttl all the same"
    );
    h.release_swaps().await;
}

/// A ban expires at `ban_ttl` on the session it was earned on, whatever comes first then: a
/// payment or a request expires it itself, and the session's `banned` says so.
async fn a_ban_expires_on_its_own_session<H: Harness>(h: &H) {
    for first in ["a payment", "a request", "banned"] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        assert_eq!(serve(h, &mut s, 0, 2), 2);
        let spent = h.token(2).await;
        assert!(h.steal(&spent).await, "someone else spent it");
        let r = s
            .pay(&Pay {
                upto_chunk: 2,
                token: spent,
            })
            .await;
        assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
        h.advance(h.ban_ttl() - SECOND);
        match first {
            "a payment" => {
                let r = s
                    .pay(&Pay {
                        upto_chunk: 2,
                        token: h.token(2).await,
                    })
                    .await;
                assert!(is_rej(&r, &RejCode::Banned), "banned until ban_ttl: {r:?}");
                h.advance(SECOND);
                let r = s
                    .pay(&Pay {
                        upto_chunk: 2,
                        token: h.token(2).await,
                    })
                    .await;
                assert!(
                    matches!(&r, Ok(ack) if (ack.accepted_upto, ack.spent_total) == (2, 2)),
                    "at ban_ttl the ban has expired, for a payment on the session it was earned \
                     on: {r:?}"
                );
            }
            "a request" => {
                assert!(!s.admit(&h.chunk(2)), "banned until ban_ttl");
                h.advance(SECOND);
                assert!(
                    s.admit(&h.chunk(2)),
                    "at ban_ttl the ban has expired, for a request on the session it was earned \
                     on"
                );
            }
            _ => {
                assert!(s.banned(), "banned until ban_ttl");
                h.advance(SECOND);
                assert!(
                    !s.banned(),
                    "at ban_ttl the ban has expired, for the banned() of the session it was \
                     earned on"
                );
            }
        }
    }
}

/// A request that is not admitted counts toward nothing: requests for files of another
/// video, or of none, leave the whole global cap to other peers.
async fn requests_not_admitted_leave_the_cap_alone<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    for n in 0..4 {
        assert!(!s.admit(&h.chunk_of(1, n)), "another served video's file");
        assert!(!s.admit(&h.foreign_chunk()), "no video's file");
    }
    let mut other = open(h, &e, 2).await;
    assert_eq!(
        serve(h, &mut other, 0, 10),
        4,
        "requests refused as not the session's video fill none of the global cap"
    );
}

/// A banned peer's requests count toward nothing: not the global cap, and not its account.
async fn a_banned_peers_requests_count_toward_nothing<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 4);
    let mut s = open(h, &e, 1).await;
    assert_eq!(serve(h, &mut s, 0, 1), 1);
    let spent = h.token(1).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let r = s
        .pay(&Pay {
            upto_chunk: 1,
            token: spent,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    assert_eq!(serve(h, &mut s, 1, 3), 0, "banned: nothing is admitted");
    let mut other = open(h, &e, 2).await;
    assert_eq!(
        serve(h, &mut other, 0, 10),
        3,
        "a banned peer's refused requests fill none of the global cap: it holds the one chunk \
         served"
    );
    h.advance(h.ban_ttl());
    let mut again = open(h, &e, 1).await;
    assert_eq!(
        again.quote().served,
        1,
        "nor its account: once the ban has expired, it was served the one chunk"
    );
    assert_eq!(
        serve(h, &mut again, 1, 10),
        3,
        "and its window has three places left"
    );
}

/// Flaws `StaleBeforeBan`, `StructureBeforeBan` and `BanCheckedLast`. A banned peer's `pay`
/// is refused `banned`, whatever it offers (NFX-07 §3): the ban is checked first, when its
/// turn comes. Paid to 4, the peer is banned for a double spend. A payment at the watermark
/// or below it, an unreadable or malformed token, a foreign mint's, one with an invalid
/// DLEQ, and a short or an excess payment are each refused `banned`, and none is claimed.
async fn a_banned_peers_pay_is_refused_whatever_it_offers<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 4).await;
    serve(h, &mut s, 0, 4);
    let ack = s
        .pay(&Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        })
        .await
        .expect("paid to 4");
    assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
    let spent = h.token(4).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let r = s
        .pay(&Pay {
            upto_chunk: 8,
            token: spent,
        })
        .await;
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    assert!(s.banned(), "the peer is banned");
    let offers = [
        ("a payment at the watermark", 4, h.token(4).await),
        ("a payment below the watermark", 2, h.token(2).await),
        (
            "an unreadable token",
            8,
            h.bad_token(BadToken::Garbage, 4).await,
        ),
        (
            "a token in another unit",
            8,
            h.bad_token(BadToken::WrongUnit, 4).await,
        ),
        (
            "a token without DLEQs",
            8,
            h.bad_token(BadToken::NoDleq, 4).await,
        ),
        (
            "a foreign mint's token",
            8,
            h.token_at("https://other-mint.example", 4).await,
        ),
        (
            "an invalid DLEQ",
            8,
            h.bad_token(BadToken::BadDleq, 4).await,
        ),
        ("a short payment", 8, h.token(3).await),
        ("an excess payment", 8, h.token(5).await),
    ];
    for (offer, upto, token) in offers {
        let r = s
            .pay(&Pay {
                upto_chunk: upto,
                token: token.clone(),
            })
            .await;
        assert!(
            is_rej(&r, &RejCode::Banned),
            "a banned peer's payment is refused banned, whatever it offers: {offer}: {r:?}"
        );
        assert!(!h.claimed_any(&token).await, "{offer}: not claimed");
    }
}

/// Flaws `PayTakeoverSkipsBan`, `TakeoverReadsBeforeChecks` and
/// `HelloTakeoverSkipsBanRecheck`. Bans are checked when a payment's turn comes, a turn it
/// takes over included, before any other check, and a payment reads only once its checks
/// pass; a `hello` checks again after its wait, however it ended (NFX-07 §3). P1's swap is
/// held at the mint, its watcher takes the proofs back, and its connection closes. P2, or a
/// `hello`, arrives 10 s later and waits; at 30 s the peer is banned, for a double spend on
/// its other video. At P1's deadline P2, or the `hello`, takes the turn over, and is
/// refused `banned`; P2 reads nothing, not even the swap it abandoned.
async fn a_turn_taken_over_is_checked_for_the_ban<H: Harness>(h: &H) {
    for entry in ["a payment", "a hello"] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 5).await;
        let mut s2 = open(h, &e, 5).await;
        let mut other = open_on(h, &e, 5, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_next_swap();
        let p1 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        poll_once(s.pay(&p1)).await; // its connection closes, its swap in flight
        assert!(
            h.steal(&p1.token).await,
            "P1's watcher takes the proofs back"
        );
        h.advance(Duration::from_secs(10));
        let p2 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let (peer, hello) = (h.peer(5), h.hello());
        let mut paying = Box::pin(s2.pay(&p2));
        let mut behind = Box::pin(e.hello(&peer, &hello));
        if entry == "a payment" {
            assert!(
                poll_now(paying.as_mut()).is_none(),
                "P2 waits for P1's turn"
            );
        } else {
            assert!(
                poll_now(behind.as_mut()).is_none(),
                "the hello waits for P1's turn"
            );
        }
        h.advance(Duration::from_secs(20));
        let spent = h.token(1).await;
        assert!(h.steal(&spent).await, "someone else spent it");
        let r = other
            .pay(&Pay {
                upto_chunk: 1,
                token: spent,
            })
            .await;
        assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
        h.advance(Duration::from_secs(30)); // P1's deadline: the turn is taken over
        if entry == "a payment" {
            let before = h.state_reads();
            let r = (0..1000)
                .find_map(|_| poll_now(paying.as_mut()))
                .expect("P2 answered");
            assert!(
                is_rej(&r, &RejCode::Banned),
                "banned while it waited, P2 took the dead turn over and is refused banned at \
                 its turn: {r:?}"
            );
            assert_eq!(
                h.state_reads(),
                before,
                "a banned payment that took the turn over reads nothing, not even P1's \
                 abandoned swap"
            );
            assert!(!h.claimed_any(&p2.token).await, "its payment is not taken");
        } else {
            let r = (0..1000)
                .find_map(|_| poll_now(behind.as_mut()))
                .expect("the hello answered");
            assert!(
                is_rej(&r, &RejCode::Banned),
                "banned while it waited, the hello took the dead turn over and is refused banned"
            );
        }
        drop((paying, behind));
        h.release_swaps().await;
    }
}

/// Flaws `LateKeysUsed`, `KeysInDeadlineSecondUsed` and `RecheckPastDeadline`. A payment
/// whose outcome the seeder has by its deadline is answered with it; otherwise it is
/// answered `mint-unavailable`, however it would have been refused (NFX-07 §3). Keys that
/// come at P's deadline or later are not used: P, 1 sat for 4 chunks, is
/// `mint-unavailable`, not `underpaid`. Keys that come a second before are: it is
/// `underpaid`. And a payment that reaches its swap past its deadline is not rechecked: a
/// claim learnt then covers P, which is `mint-unavailable`, not `stale`. Where P's keys are
/// held, it is polled as they come, or first after its deadline passed without them: a
/// payment left unpolled while keys that came in time wait for it may be answered either
/// way, since an engine that takes them in on another task reaches its checks as they come.
async fn checks_after_the_deadline_answer_nothing<H: Harness>(h: &H) {
    for keys_at in [65, 60, 59] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_key_fetches();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(1).await,
        };
        let mut paying = Box::pin(s.pay(&p));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P holds the turn, waiting for keys"
        );
        h.advance(Duration::from_secs(keys_at));
        h.release_swaps().await; // its keys come
        let r = (0..1000)
            .find_map(|_| poll_now(paying.as_mut()))
            .expect("P answered");
        if keys_at >= 60 {
            assert!(
                is_rej(&r, &RejCode::MintUnavailable),
                "P's keys came {keys_at} s after its arrival, at or past its deadline (whole \
                 seconds): they are not used, and it had no outcome by then: {r:?}"
            );
        } else {
            assert!(
                is_rej(&r, &RejCode::Underpaid),
                "P's keys came a second before its deadline: they are used, and the refusal \
                 they give is the answer: {r:?}"
            );
        }
        assert!(!h.claimed_any(&p.token).await, "not swapped");
    }

    // The claim that covers P is learnt by a sweep 5 s past P's deadline, as its keys come.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    lost_claim(h, &mut s, 4, 4).await;
    h.advance(SECOND);
    h.hold_key_fetches();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s2.pay(&p));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "P holds the turn, waiting for keys"
    );
    h.advance(Duration::from_secs(65));
    h.release_swaps().await; // its keys come
    e.sweep().await; // the earlier claim is learnt now, past P's deadline
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("P answered");
    assert!(
        is_rej(&r, &RejCode::MintUnavailable),
        "the claim that covers P was learnt 5 s past its deadline, as its keys came: P had no \
         outcome by then, and is not rechecked: {r:?}"
    );
    assert!(!h.claimed_any(&p.token).await, "not swapped");
    drop(paying);

    // P's keys come in time, and its checks pass. It reads its account's unknown swap, A, a
    // claim; the sweep runs during that read, with the mint's state checks unanswered for
    // 60 s, and learns the claim, which covers P, at P's deadline. P reaches its swap then.
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    lost_claim(h, &mut s, 4, 4).await;
    h.advance(SECOND);
    h.state_check_outage(true);
    h.unanswered_reads_take(Duration::from_secs(60));
    h.sweep_during_next_read(&e);
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let arrived = h.clock_secs();
    let r = s.pay(&p).await;
    h.unanswered_reads_take(Duration::ZERO);
    h.state_check_outage(false);
    assert!(
        is_rej(&r, &RejCode::MintUnavailable),
        "the claim that covers P was learnt at its deadline, during P's own read: P had no \
         outcome by then, and is not rechecked: {r:?}"
    );
    assert!(!h.claimed_any(&p.token).await, "not swapped");
    assert_eq!(
        h.clock_secs() - arrived,
        60,
        "P's read ran into its deadline"
    );
    let q = open(h, &e, 1).await.quote().clone();
    assert_eq!(
        (q.accepted_upto, q.spent_total),
        (4, 4),
        "the claim is credited"
    );
}

/// Flaw `LandInTimeAtDeadline`. Deadlines and the clock count whole seconds, and a deadline
/// is as its second began: an outcome settled in the deadline's second came after it
/// (NFX-07 §3). It arrives in that second, or a second before it and is settled in it. The
/// payment is answered `mint-unavailable`, a claim is credited once, late, and a spent
/// outcome bans nobody.
async fn an_outcome_in_the_deadlines_second_is_late<H: Harness>(h: &H) {
    for (spent, during) in [(false, 0), (true, 0), (false, 1), (true, 1)] {
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
        let deadline = h.clock_secs() + 60;
        let mut paying = Box::pin(s.pay(&pay));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "its swap is held at the mint"
        );
        h.advance(Duration::from_secs(60 - during));
        if during > 0 {
            h.advance_during_next_land(Duration::from_secs(during));
        }
        h.release_swaps().await;
        assert_eq!(h.clock_secs(), deadline, "settled in the deadline's second");
        let answer = (0..1000)
            .find_map(|_| poll_now(paying.as_mut()))
            .expect("answered");
        drop(paying);
        assert!(
            is_rej(&answer, &RejCode::MintUnavailable),
            "settled in its deadline's second, after the deadline: mint-unavailable, not the \
             outcome (spent {spent}, arrived {during} s before): {answer:?}"
        );
        assert!(
            !s.banned(),
            "late, nobody is banned, in the deadline's second too (spent {spent})"
        );
        let q = open(h, &e, 1).await.quote().clone();
        let want = if spent { (0, 0) } else { (4, 4) };
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            want,
            "credited exactly once, late, if claimed (spent {spent})"
        );
    }
}

/// Flaw `LateArrivalWaited`. A `hello` that arrives while a payment holds the turn past its
/// deadline, and takes the turn over itself, did not wait: the turn was freed at that
/// deadline, before it came (NFX-07 §3), so a read sent since serves it. The set-up of
/// [`a_turn_held_past_its_deadline_was_freed_there`]: at P's deadline, or 5 s past it, a
/// `hello` reads A, P still holding the turn. A new `hello` then takes the turn over,
/// reuses that read, sending none of its own, and quotes what it learnt.
async fn a_hello_arriving_past_the_deadline_did_not_wait<H: Harness>(h: &H) {
    for past in [0, 5] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        parked(h, &mut s, 4).await;
        h.advance(SECOND);
        let peer = h.peer(1);
        let (one, two, three) = (h.hello(), h.hello(), h.hello());
        let mut first = Box::pin(e.hello(&peer, &one));
        if poll_now(first.as_mut()).is_some() {
            h.release_swaps().await;
            return; // synchronous reads: nothing is ever under way
        }
        let mut second = Box::pin(e.hello(&peer, &two));
        assert!(
            poll_now(second.as_mut()).is_none(),
            "waits for the first's read"
        );
        h.hold_key_fetches();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let mut paying = Box::pin(s2.pay(&p));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P holds the turn, waiting for keys"
        );
        h.advance(Duration::from_secs(60 + past)); // P's deadline, or `past` s after it
        let before = h.state_reads();
        assert!(
            poll_now(second.as_mut()).is_none(),
            "the second reads A, P still holding the turn"
        );
        let learnt = (0..1000)
            .find_map(|_| poll_now(second.as_mut()))
            .expect("the second's read back")
            .expect("a hello")
            .quote()
            .clone();
        let mut late = Box::pin(e.hello(&peer, &three));
        let q = (0..1000)
            .find_map(|_| poll_now(late.as_mut()))
            .expect("the late hello answered")
            .expect("a hello")
            .quote()
            .clone();
        assert_eq!(
            h.state_reads() - before,
            2,
            "the turn was freed at P's deadline, before the late hello came ({past} s past \
             it): it did not wait, and reuses the read sent this second, sending none of its own"
        );
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (learnt.accepted_upto, learnt.spent_total),
            "the late hello quotes what that read learnt"
        );
        drop((paying, first));
        h.release_swaps().await;
    }
}

/// Flaws `RetrySpentUnsignedStaysUnknown`, `RetryRefusedUnsignedStaysUnknown` and
/// `RetryExpiredUnsignedStaysUnknown`. A retry settled by a restore that finds its outputs
/// unsigned is nothing (NFX-07 §3): answered `spent` (a token someone else spent), refused
/// for good (its outputs' keyset rotated out) or refused because the inputs' keyset
/// expired (12003, the first attempt rolled back, so no input pending). It is
/// `mint-unavailable`, and leaves nothing unknown: the account's next payment is swapped,
/// even while restores go unanswered.
async fn a_retry_settled_unsigned_leaves_nothing_unknown<H: Harness>(h: &H) {
    for retry in ["answered spent", "refused for good", "refused 12003"] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let r = if retry == "answered spent" {
            let spent = h.token(4).await;
            assert!(h.steal(&spent).await, "someone else spent it");
            h.lose_next_swap_response();
            s.pay(&Pay {
                upto_chunk: 4,
                token: h.reencode(&spent).await,
            })
            .await
        } else {
            h.hold_next_swap_reserving();
            let p = Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            };
            let (r, ()) = both(s.pay(&p), async {
                yield_once().await;
                if retry == "refused for good" {
                    h.rotate_keyset();
                } else {
                    h.before_next_swap(MintEvent::ExpireInputKeyset);
                }
                h.roll_back_reserved();
            })
            .await;
            assert!(
                !h.claimed_any(&p.token).await,
                "nothing was claimed ({retry})"
            );
            r
        };
        assert!(is_rej(&r, &RejCode::MintUnavailable), "{retry}: {r:?}");
        h.restore_outage(true);
        let next = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let r = s.pay(&next).await;
        h.restore_outage(false);
        assert!(
            r.as_ref()
                .is_ok_and(|ack| (ack.accepted_upto, ack.spent_total) == (4, 4)),
            "a retry {retry}, its outputs unsigned, left nothing unknown: the next payment is \
             swapped while restores go unanswered: {r:?}"
        );
    }
}

/// Flaws `HelloTakeoverSkipsRead` and `PayTakeoverSkipsRead`. An entry that takes over a
/// turn held past its payment's deadline reads the abandoned swap (NFX-07 §3). P's swap is
/// claimed at the mint, its answer held, and its connection closes. A `hello` that waited
/// for P, or one that arrives 5 s past P's deadline, takes the turn over and quotes the
/// claim. A payment for the same chunks, arriving 30 s after P, takes the turn over at P's
/// deadline, learns the claim and is refused `stale`. With P's swap unprocessed and its
/// proofs taken back, one that arrives 5 s past P's deadline learns it as nothing, and is
/// swapped.
async fn a_takeover_reads_the_abandoned_swap<H: Harness>(h: &H) {
    for waited in [true, false] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        h.hold_swap_responses();
        let p = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let mut paying = Box::pin(s.pay(&p));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P holds the turn, its answer held"
        );
        assert!(h.claimed_all(&p.token).await, "the mint has P's claim");
        drop(paying); // its connection closes, its swap in flight
        let (peer, hello) = (h.peer(1), h.hello());
        let mut behind = Box::pin(e.hello(&peer, &hello));
        if waited {
            assert!(
                poll_now(behind.as_mut()).is_none(),
                "the hello waits for P's turn"
            );
            h.advance(Duration::from_secs(60)); // P's deadline
        } else {
            h.advance(Duration::from_secs(65)); // the hello arrives 5 s past P's deadline
        }
        let q = settle_on(h, behind.as_mut(), 3)
            .expect("a hello")
            .quote()
            .clone();
        assert_eq!(
            (q.accepted_upto, q.spent_total),
            (4, 4),
            "P's claim reached the mint before its deadline freed the turn: the hello that took \
             the turn over reads P's swap, and quotes the claim (it waited: {waited})"
        );
        drop((behind, s));
        h.release_swaps().await;
    }
    for claimed in [true, false] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        if claimed {
            h.hold_swap_responses();
        } else {
            h.hold_next_swap();
        }
        let p1 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        poll_once(s.pay(&p1)).await; // its connection closes, its swap in flight
        if claimed {
            assert!(h.claimed_all(&p1.token).await, "the mint has P1's claim");
        } else {
            assert!(
                h.steal(&p1.token).await,
                "P1's watcher takes the proofs back"
            );
        }
        let p2 = Pay {
            upto_chunk: 4,
            token: h.token(4).await,
        };
        let mut paying = Box::pin(s2.pay(&p2));
        if claimed {
            h.advance(Duration::from_secs(30));
            assert!(
                poll_now(paying.as_mut()).is_none(),
                "P2 waits for P1's turn"
            );
            h.advance(Duration::from_secs(30)); // P1's deadline
        } else {
            h.advance(Duration::from_secs(65)); // P2 arrives 5 s past P1's deadline
        }
        let r = (0..1000).find_map(|_| poll_now(paying.as_mut()));
        drop(paying);
        if claimed {
            assert!(
                r.as_ref().is_some_and(|r| is_rej(r, &RejCode::Stale)),
                "P2 took the turn over, and its read learnt P1's claim, which covers it: {r:?}"
            );
            assert!(!h.claimed_any(&p2.token).await, "P2 is not swapped");
        } else {
            assert!(
                r.as_ref().is_some_and(|r| r
                    .as_ref()
                    .is_ok_and(|ack| (ack.accepted_upto, ack.spent_total) == (4, 4))),
                "P2 took the turn over, and its read learnt P1's swap as nothing: swapped: {r:?}"
            );
        }
        h.release_swaps().await;
    }
}

/// Flaw `DropHoldsTurn`. A payment dropped before its swap is sent (its connection closed)
/// is abandoned unswapped, and frees its account's turn then (NFX-07 §3), not at its
/// deadline. P holds the turn waiting for keys; a `hello` and a payment wait behind it. At
/// 10 s P's connection closes: the `hello` is answered, and the payment takes the turn, is
/// swapped once the keys come and is acknowledged, with no more time passing.
async fn a_payment_dropped_before_its_swap_frees_the_turn<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_key_fetches();
    let p = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut paying = Box::pin(s.pay(&p));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "P holds the turn, waiting for keys"
    );
    let (peer, hello) = (h.peer(1), h.hello());
    let mut behind = Box::pin(e.hello(&peer, &hello));
    assert!(poll_now(behind.as_mut()).is_none(), "the hello waits for P");
    let next = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let mut queued = Box::pin(s2.pay(&next));
    assert!(
        poll_now(queued.as_mut()).is_none(),
        "the next payment waits for P"
    );
    h.advance(Duration::from_secs(10));
    drop(paying); // its connection closes before its swap is sent
    let answered = (0..1000).find_map(|_| poll_now(behind.as_mut()));
    assert!(
        answered.as_ref().is_some_and(Result::is_ok),
        "P was dropped before its swap: its turn is freed then, and the hello is answered, 50 s \
         before P's deadline"
    );
    h.release_swaps().await; // the keys come
    let r = (0..1000).find_map(|_| poll_now(queued.as_mut()));
    assert!(
        r.as_ref()
            .is_some_and(|r| r.as_ref().is_ok_and(|ack| ack.accepted_upto == 4)),
        "P's turn was freed as it was dropped: the next payment took it, and is acknowledged: \
         {r:?}"
    );
    drop((behind, queued));
}

/// Flaws `TakeoverReadsBeforeStale`, `TakeoverReadsBeforeAmount` and
/// `TakeoverStaleSkipped`. A payment reads only once its checks pass, and is refused as
/// they say, a turn it takes over included (NFX-07 §3). Paid to 4, the account's P1, for
/// chunks 5 to 8, is held at the mint, and its connection closes. P2 arrives 30 s later
/// and waits; at P1's deadline it takes the turn over. A payment at the watermark, an
/// unreadable token, a foreign mint's, one with an invalid DLEQ, and a short payment are
/// each refused as their checks say, read nothing, not even P1's abandoned swap, and are
/// not claimed.
async fn a_takeover_is_checked_before_it_reads<H: Harness>(h: &H) {
    let offers = [
        (
            "a payment at the watermark",
            4,
            h.token(4).await,
            RejCode::Stale,
        ),
        (
            "an unreadable token",
            8,
            h.bad_token(BadToken::Garbage, 4).await,
            RejCode::BadToken,
        ),
        (
            "a foreign mint's token",
            8,
            h.token_at("https://other-mint.example", 4).await,
            RejCode::BadMint,
        ),
        (
            "an invalid DLEQ",
            8,
            h.bad_token(BadToken::BadDleq, 4).await,
            RejCode::BadToken,
        ),
        ("a short payment", 8, h.token(3).await, RejCode::Underpaid),
    ];
    for (offer, upto, token, want) in offers {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 1).await;
        let mut s2 = open(h, &e, 1).await;
        serve(h, &mut s, 0, 4);
        let ack = s
            .pay(&Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            })
            .await
            .expect("paid to 4");
        assert_eq!((ack.accepted_upto, ack.spent_total), (4, 4));
        serve(h, &mut s, 4, 4);
        h.hold_next_swap();
        let p1 = Pay {
            upto_chunk: 8,
            token: h.token(4).await,
        };
        poll_once(s.pay(&p1)).await; // its connection closes, its swap in flight
        h.advance(Duration::from_secs(30));
        let p2 = Pay {
            upto_chunk: upto,
            token: token.clone(),
        };
        let mut paying = Box::pin(s2.pay(&p2));
        assert!(
            poll_now(paying.as_mut()).is_none(),
            "P2 waits for P1's turn"
        );
        h.advance(Duration::from_secs(30)); // P1's deadline: P2 takes the turn over
        let before = h.state_reads();
        let r = (0..1000).find_map(|_| poll_now(paying.as_mut()));
        assert!(
            r.as_ref().is_some_and(|r| is_rej(r, &want)),
            "P2 took the dead turn over: {offer} is refused {want:?}, as its checks say: {r:?}"
        );
        assert_eq!(
            h.state_reads(),
            before,
            "P2 took the dead turn over and was refused: it read nothing, not even P1's \
             abandoned swap ({offer})"
        );
        assert!(!h.claimed_any(&token).await, "{offer}: not claimed");
        drop(paying);
        h.release_swaps().await;
    }
}

/// Flaw `TakeoverReadsWithoutDeadline`. A payment's own reads end at its deadline, 60 s
/// from its arrival, a turn it takes over included (NFX-07 §3). P1's swap is held at the
/// mint, and its connection closes. P2 arrives 30 s later and waits; at P1's deadline it
/// takes the turn over and reads the abandoned swap, while the mint leaves reads
/// unanswered for 90 s. P2 is answered `mint-unavailable` at its own deadline.
async fn a_takeovers_reads_end_at_its_deadline<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 1).await;
    let mut s2 = open(h, &e, 1).await;
    serve(h, &mut s, 0, 4);
    h.hold_next_swap();
    let p1 = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    poll_once(s.pay(&p1)).await; // its connection closes, its swap in flight
    h.advance(Duration::from_secs(30));
    let p2 = Pay {
        upto_chunk: 4,
        token: h.token(4).await,
    };
    let arrived = h.clock_secs();
    let mut paying = Box::pin(s2.pay(&p2));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "P2 waits for P1's turn"
    );
    h.state_check_outage(true);
    h.restore_outage(true);
    h.unanswered_reads_take(Duration::from_secs(90));
    h.advance(Duration::from_secs(30)); // P1's deadline: P2 takes the turn over
    let r = (0..1000).find_map(|_| poll_now(paying.as_mut()));
    h.unanswered_reads_take(Duration::ZERO);
    h.state_check_outage(false);
    h.restore_outage(false);
    assert!(
        r.as_ref()
            .is_some_and(|r| is_rej(r, &RejCode::MintUnavailable)),
        "P2 took the dead turn over, and its read of the abandoned swap went unanswered: \
         mint-unavailable: {r:?}"
    );
    assert_eq!(
        h.clock_secs() - arrived,
        60,
        "P2's read ended at its own deadline, 60 s after its arrival"
    );
    drop(paying);
    h.release_swaps().await;
}

/// Flaws `HelloBanCheckBeforeRead` and `HelloRecheckOnlyAfterWait`. A `hello` checks its
/// peer's ban again as it answers, after its wait and its reads, whether it waited or not
/// (NFX-07 §3). Its read of A is under way when the peer is banned, for a double spend on
/// its other video: once the read is back, the `hello` is refused `banned`. And on either
/// harness: the double spend's answer, held, lands as the `hello` reads A; the `hello` is
/// refused `banned` as it answers.
async fn a_hello_checks_the_ban_as_it_answers<H: Harness>(h: &H) {
    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 6).await;
    let mut other = open_on(h, &e, 6, 1).await;
    serve(h, &mut s, 0, 4);
    parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let (peer, hello) = (h.peer(6), h.hello());
    let mut reading = Box::pin(e.hello(&peer, &hello));
    if poll_now(reading.as_mut()).is_none() {
        let spent = h.token(1).await;
        assert!(h.steal(&spent).await, "someone else spent it");
        let r = other
            .pay(&Pay {
                upto_chunk: 1,
                token: spent,
            })
            .await;
        assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
        let r = (0..1000)
            .find_map(|_| poll_now(reading.as_mut()))
            .expect("the hello answered");
        assert!(
            is_rej(&r, &RejCode::Banned),
            "the peer was banned while its hello read: it is refused banned as it answers"
        );
    } // else synchronous reads: nothing is ever under way
    drop(reading);
    h.release_swaps().await;

    let e = h.engine(1, 4, 1000);
    let mut s = open(h, &e, 6).await;
    let mut other = open_on(h, &e, 6, 1).await;
    serve(h, &mut s, 0, 4);
    parked(h, &mut s, 4).await;
    h.advance(SECOND);
    let spent = h.token(1).await;
    assert!(h.steal(&spent).await, "someone else spent it");
    let double = Pay {
        upto_chunk: 1,
        token: spent,
    };
    h.hold_swap_responses();
    let mut paying = Box::pin(other.pay(&double));
    assert!(
        poll_now(paying.as_mut()).is_none(),
        "the double spend's answer is held"
    );
    h.deliver_responses_mid_read();
    let r = e.hello(&peer, &hello).await;
    assert!(
        is_rej(&r, &RejCode::Banned),
        "the peer was banned as its hello read, which did not wait: it is refused banned as it \
         answers"
    );
    let r = (0..1000)
        .find_map(|_| poll_now(paying.as_mut()))
        .expect("the double spend answered");
    assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
    drop(paying);
    h.release_swaps().await;
}

/// Flaw `HelloBanNotAtArrival`. A `hello` checks its peer's ban as it arrives (NFX-07 §3):
/// a banned peer's `hello` is refused at once, and waits for no turn and reads nothing. The
/// peer, banned for a double spend on its other video, has a payment's swap in flight on
/// video 0, which holds the account's turn, or a swap there parked unknown.
async fn a_banned_peers_hello_is_refused_as_it_arrives<H: Harness>(h: &H) {
    for held in [true, false] {
        let e = h.engine(1, 4, 1000);
        let mut s = open(h, &e, 7).await;
        let mut other = open_on(h, &e, 7, 1).await;
        serve(h, &mut s, 0, 4);
        if held {
            h.hold_next_swap();
            let p = Pay {
                upto_chunk: 4,
                token: h.token(4).await,
            };
            poll_once(s.pay(&p)).await; // its connection closes, its swap in flight
        } else {
            parked(h, &mut s, 4).await;
        }
        let spent = h.token(1).await;
        assert!(h.steal(&spent).await, "someone else spent it");
        let r = other
            .pay(&Pay {
                upto_chunk: 1,
                token: spent,
            })
            .await;
        assert!(is_rej(&r, &RejCode::Spent), "{r:?}");
        let before = h.state_reads();
        let (peer, hello) = (h.peer(7), h.hello());
        let mut arriving = Box::pin(e.hello(&peer, &hello));
        let r = poll_now(arriving.as_mut());
        assert!(
            r.as_ref().is_some_and(|r| is_rej(r, &RejCode::Banned)),
            "a banned peer's hello is refused at once, as it arrives (its account's turn held: \
             {held})"
        );
        assert_eq!(
            h.state_reads(),
            before,
            "a banned peer's hello reads nothing (its account's turn held: {held})"
        );
        drop(arriving);
        h.release_swaps().await;
    }
}
