//! An entry on a thread of its own (`on_a_thread`), without an engine: a panic raised on
//! that thread is the scenario's before a check of the suite's fails in its stead, and a
//! side dropped unjoined ends its thread. Each case runs as a scenario does, on a thread
//! of the runner's ([`run_on_a_thread`]), and is judged by how the runner reports it.

use std::sync::atomic::AtomicU32;
use std::time::Instant;

use super::*;

/// Start a thread for an entry, as a harness does ([`Harness::spawn_thread`]).
fn spawn(work: Box<dyn FnOnce() + Send>) {
    std::thread::spawn(work);
}

/// Drive `f` on this thread, polled again and again: a turn of the suite's needs no runtime
/// here, and a future that waits to be woken is polled all the same.
fn drive<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(v) = f.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::yield_now();
    }
}

/// How long a case waits, at most, for what must come at once on any machine.
const PATIENCE: Duration = Duration::from_secs(30);

/// Where the entry of each case that panics raised its panic: the line before.
static RAISED: [AtomicU32; 3] = [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)];

/// An entry whose engine panics on the entry's thread, in a file that is not the suite's.
async fn the_engine_panics(case: usize) {
    RAISED[case].store(line!(), Ordering::SeqCst);
    panic!("raised in the engine, on the entry's thread");
}

/// `ran` is reported as the engine's panic on the entry's thread, where it was raised: no
/// failed check of the suite's.
fn the_engines_panic(ran: &Ran, case: usize) {
    let Ran::Panicked {
        file,
        line,
        payload,
    } = ran
    else {
        panic!("the entry's panic is reported (case {case})");
    };
    let said = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or_default();
    assert_eq!(
        (file.ends_with("nfx-pay/src/adversary/side_tests.rs"), *line),
        (true, RAISED[case].load(Ordering::SeqCst) + 1),
        "where the entry raised it, not where a check of the suite's failed after it (case \
         {case}): {file}:{line}: {said}"
    );
    assert_eq!(said, "raised in the engine, on the entry's thread");
    assert!(!ran.failed_the_suite(), "counted (case {case})");
}

#[test]
fn a_panic_on_an_entrys_thread_is_raised_at_the_suites_next_turn() {
    // The suite waits, a turn at a time, for what the entry never does (a read that reaches
    // the mint, say), and then fails its check. The entry's panic is the scenario's first.
    let ran = run_on_a_thread(2 * PATIENCE.as_secs(), || {
        drive(async {
            let _entry = side(spawn, || the_engine_panics(0));
            let start = Instant::now();
            while start.elapsed() < PATIENCE {
                yield_once().await;
            }
            panic!("the check the suite makes of what it waited for");
        });
    });
    the_engines_panic(&ran, 0);
}

#[test]
fn a_panic_on_an_entrys_thread_is_raised_where_the_suite_waits_for_the_entry() {
    let ran = run_on_a_thread(2 * PATIENCE.as_secs(), || {
        drive(async {
            let entry = side(spawn, || the_engine_panics(1));
            entry.joined().await;
            panic!("the check the suite makes once the entry is back");
        });
    });
    the_engines_panic(&ran, 1);
}

#[test]
fn a_panic_on_an_entrys_thread_is_raised_as_the_scenario_returns() {
    // A scenario that let the side go, and passed every check after: no finished run.
    let ran = run_on_a_thread(2 * PATIENCE.as_secs(), || {
        let entry = side(spawn, || the_engine_panics(2));
        let start = Instant::now();
        while !entry.now().done && start.elapsed() < PATIENCE {
            std::thread::yield_now();
        }
    });
    the_engines_panic(&ran, 2);
}

#[test]
fn an_entry_on_a_thread_gives_its_output_where_it_is_joined() {
    let ran = run_on_a_thread(2 * PATIENCE.as_secs(), || {
        drive(async {
            let entry = side(spawn, || async { 7 });
            assert_eq!(entry.joined().await, 7, "the entry's output");
            for _ in 0..TURNS {
                yield_once().await;
            }
        });
    });
    assert!(matches!(ran, Ran::Finished), "nothing was raised");
}

/// Marks that the entry holding it was dropped.
struct Gone(Arc<AtomicBool>);

impl Drop for Gone {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[test]
fn a_side_dropped_unjoined_ends_its_thread() {
    // Left behind where it waits to be woken, and where the suite holds its polls: as a
    // scenario leaves one when a check fails between starting it and joining it. Its
    // thread ends, and the entry is dropped there. A thread that ran on would hang the
    // join here, and the runner would report that.
    for held in [false, true] {
        let ran = run_on_a_thread(2 * PATIENCE.as_secs(), move || {
            let gone = flag();
            let thread = Arc::new(Mutex::new(None));
            let started = thread.clone();
            let entry = {
                let gone = Gone(gone.clone());
                side(
                    move |work| {
                        *started.lock().unwrap_or_else(PoisonError::into_inner) =
                            Some(std::thread::spawn(work));
                    },
                    move || {
                        poll_fn(move |cx| {
                            let _lives = &gone; // the entry holds it while it lives
                            if held {
                                cx.waker().wake_by_ref(); // it waits by polling again
                            }
                            Poll::<()>::Pending
                        })
                    },
                )
            };
            let start = Instant::now();
            while entry.now().ended == 0 {
                assert!(start.elapsed() < PATIENCE, "the entry was polled");
                std::thread::yield_now();
            }
            if held {
                entry.hold();
            }
            assert!(!is_set(&gone), "the entry lives while its side does");
            drop(entry);
            let thread = thread
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take()
                .expect("the side's thread was started");
            assert!(thread.join().is_ok(), "the side's thread ended, and well");
            assert!(is_set(&gone), "the entry was dropped on its thread");
        });
        assert!(
            matches!(ran, Ran::Finished),
            "a side dropped unjoined ends its thread (its polls held: {held})"
        );
    }
}
