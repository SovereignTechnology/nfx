//! The suite's runner (`nfx_pay::adversary::run_on_a_thread`), which the suite and the
//! mutants both use: a body that blocks its thread is timed out, and a panic is reported
//! with where it was raised, on a thread a scenario spawned too, so the mutants count only
//! a failed assertion of the suite.

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
