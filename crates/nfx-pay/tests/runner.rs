//! The suite's runner (`nfx_pay::adversary::run_on_a_thread`), which the suite and the
//! mutants both use: a body that blocks its thread is timed out, and a panic is reported
//! with where it was raised, on a thread a scenario spawned too, so the mutants count only
//! a failed assertion of the suite, never a panic Rust raises of its own at a line of it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nfx_pay::adversary::{Ran, keep_panic, rejoin, run_on_a_thread};
use std::sync::atomic::{AtomicU32, Ordering};

#[test]
fn a_body_that_returns_finishes() {
    assert!(matches!(run_on_a_thread(5, || {}), Ran::Finished));
}

#[test]
fn a_body_that_blocks_its_thread_is_timed_out() {
    let ran = run_on_a_thread(1, || {
        loop {
            std::thread::park();
        }
    });
    assert!(matches!(ran, Ran::Hung));
}

#[test]
fn a_panic_outside_the_suite_is_not_the_suite_failing() {
    let ran = run_on_a_thread(5, || panic!("raised in a test file, not in the suite"));
    let Ran::Panicked { file, .. } = &ran else {
        panic!("it panicked");
    };
    assert!(file.ends_with("nfx-pay/tests/runner.rs"), "{file}");
    assert!(!ran.failed_the_suite());
}

#[test]
fn a_panic_on_a_spawned_thread_is_judged_where_it_was_raised() {
    static RAISED: AtomicU32 = AtomicU32::new(0);
    let ran = run_on_a_thread(5, || {
        std::thread::scope(|scope| {
            let t = scope.spawn(|| {
                keep_panic(|| {
                    RAISED.store(line!(), Ordering::SeqCst);
                    panic!("raised on the spawned thread");
                })
            });
            rejoin::<()>(t.join());
        });
    });
    let Ran::Panicked { file, line, .. } = &ran else {
        panic!("it panicked");
    };
    assert!(file.ends_with("nfx-pay/tests/runner.rs"), "{file}");
    assert_eq!(
        *line,
        RAISED.load(Ordering::SeqCst) + 1,
        "where it was raised, not rejoined"
    );
}

#[test]
fn a_runtime_panic_at_a_line_of_the_suite_is_not_the_suite_failing() {
    // Rust's own panics, raised for real, then reported as raised at a line of the suite.
    let runtime: [fn(); 6] = [
        || {
            std::hint::black_box(std::hint::black_box(0u64) - 1);
        },
        || {
            std::hint::black_box(1 / std::hint::black_box(0u64));
        },
        || {
            std::hint::black_box([0u8; 2][std::hint::black_box(2)]);
        },
        || {
            std::hint::black_box(std::hint::black_box(None::<u8>).unwrap());
        },
        || {
            std::hint::black_box(std::hint::black_box(Err::<u8, &str>("refused")).unwrap());
        },
        || {
            std::hint::black_box(&std::hint::black_box([0u8; 2])[..std::hint::black_box(3)]);
        },
    ];
    for raise in runtime {
        let ran = in_the_suite(run_on_a_thread(5, raise));
        assert!(!message(&ran).is_empty(), "a runtime panic has a message");
        assert!(!ran.failed_the_suite(), "counted: {}", message(&ran));
    }
    // Nor does a panic with no message.
    let ran = in_the_suite(run_on_a_thread(5, || std::panic::panic_any(7u8)));
    assert!(!ran.failed_the_suite(), "a panic with no message counted");
    // The suite's own do: an assertion, and named expects.
    let suite: [fn(); 3] = [
        || assert_eq!(std::hint::black_box(1), 2, "a behaviour"),
        || {
            std::hint::black_box(std::hint::black_box(None::<u8>).expect("a hello"));
        },
        || {
            std::hint::black_box(
                std::hint::black_box(Err::<u8, &str>("refused")).expect("accepted"),
            );
        },
    ];
    for raise in suite {
        let ran = in_the_suite(run_on_a_thread(5, raise));
        assert!(ran.failed_the_suite(), "not counted: {}", message(&ran));
    }
}

/// `ran`'s panic, reported as raised at the same line of the suite's file.
fn in_the_suite(ran: Ran) -> Ran {
    let Ran::Panicked { line, payload, .. } = ran else {
        panic!("it panicked");
    };
    Ran::Panicked {
        file: "nfx-pay/src/adversary.rs".into(),
        line,
        payload,
    }
}

fn message(ran: &Ran) -> String {
    let Ran::Panicked { payload, .. } = ran else {
        return String::new();
    };
    payload
        .downcast_ref::<&str>()
        .map(|m| (*m).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_default()
}
