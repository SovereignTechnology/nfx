//! The suite's runner (`nfx_pay::adversary::run_on_a_thread`), which the suite and the
//! mutants both use: a body that blocks its thread is timed out, and a panic is reported
//! with where it was raised, on a thread a scenario spawned too, so the mutants count only
//! a failed check of the suite: never a panic at a line of it that makes no check, nor one
//! Rust raises of its own at a line that does.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use nfx_pay::adversary::{Ran, code_lines, keep_panic, makes_a_check, rejoin, run_on_a_thread};
use std::hint::black_box as bb;
use std::sync::atomic::{AtomicU32, Ordering};

/// The suite's own text, as the runner reads it.
const SUITE: &str = include_str!("../src/adversary.rs");

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
    // Nor in another file of the crate, at a line that makes a check in the suite.
    let at = suite_line(|l| l.starts_with("assert_eq!("));
    let Ran::Panicked { payload, .. } = run_on_a_thread(5, a_behaviour) else {
        panic!("it panicked");
    };
    let ran = Ran::Panicked {
        file: "nfx-pay/src/mock.rs".into(),
        line: at,
        payload,
    };
    assert!(!ran.failed_the_suite(), "counted in the mock");
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
fn the_suites_checks_are_the_suite_failing() {
    // Each kind of check the suite makes, raised for real, at a line of the suite that
    // makes a check.
    let at = suite_line(|l| l.starts_with("assert_eq!("));
    let checks: [fn(); 8] = [
        || assert!(bb(false), "a behaviour"),
        || assert_eq!(bb(1), 2, "a behaviour"),
        || assert_ne!(bb(1), 1, "a behaviour"),
        || {
            bb(bb(None::<u8>).expect("a hello"));
        },
        || {
            bb(bb(Err::<u8, &str>("refused")).expect("accepted"));
        },
        || {
            bb(bb(Ok::<u8, &str>(1)).expect_err("refused"));
        },
        || panic!("never answered"),
        || unreachable!("{}", bb("a behaviour")),
    ];
    for raise in checks {
        let ran = in_the_suite(run_on_a_thread(5, raise), at);
        assert!(ran.failed_the_suite(), "not counted: {}", message(&ran));
    }
    // A failed assertion counts at a line of each kind of check the suite makes (not the
    // runner's own list of them, in strings).
    let kinds: [fn(&str) -> bool; 6] = [
        |l| l.starts_with("assert!("),
        |l| l.starts_with("assert_eq!("),
        |l| l.starts_with("assert_ne!("),
        |l| !l.starts_with('"') && l.contains(".expect(\""),
        |l| !l.starts_with('"') && l.contains(".expect_err(\""),
        |l| !l.starts_with('"') && l.contains("panic!(\""),
    ];
    for kind in kinds {
        let at = suite_line(kind);
        let ran = in_the_suite(run_on_a_thread(5, a_behaviour), at);
        assert!(ran.failed_the_suite(), "not counted at line {at}");
    }
}

#[test]
fn a_panic_at_a_line_that_makes_no_check_is_not_the_suite_failing() {
    // A failed assertion's own panic, reported at lines of the suite that make no check:
    // plain code, a comment, a check named only in a string, and no line at all.
    let lines = [
        suite_line(|l| l.starts_with("let e = h.engine(")),
        1,
        suite_line(|l| l == "\"assert!(\","),
        0,
        u32::MAX,
    ];
    for at in lines {
        assert!(!makes_a_check(SUITE, at), "line {at} makes a check");
        let ran = in_the_suite(run_on_a_thread(5, a_behaviour), at);
        assert!(!ran.failed_the_suite(), "counted at line {at}");
    }
}

#[test]
fn a_runtime_panic_at_a_check_of_the_suite_is_not_the_suite_failing() {
    // Rust's own panics, raised for real, each reported at the line that caused it, then as
    // raised at a line of the suite that makes a check: one can sit on a check's line.
    let runtime: [fn(); 44] = [
        || {
            bb(bb(0u64) - 1);
        },
        || {
            bb(1 / bb(0u64));
        },
        || {
            bb([0u8; 2][bb(2)]);
        },
        || {
            bb(bb(None::<u8>).unwrap());
        },
        || {
            bb(bb(Err::<u8, &str>("refused")).unwrap());
        },
        || {
            bb(bb(Ok::<u8, &str>(1)).unwrap_err());
        },
        || {
            bb(&bb([0u8; 2])[..bb(3)]);
        },
        || {
            bb(&bb([0u8; 2])[bb(3)..]);
        },
        || {
            bb(&bb([0u8; 2])[bb(2)..bb(1)]);
        },
        || {
            bb(&bb("abc")[..bb(10)]);
        },
        || {
            bb(&bb("abc")[bb(10)..]);
        },
        || {
            bb(&bb("abc")[bb(2)..bb(1)]);
        },
        || {
            let cell = std::cell::RefCell::new(0u8);
            let _held = cell.borrow_mut();
            bb(cell.borrow_mut());
        },
        || {
            bb(bb(vec![1u8]).remove(bb(3)));
        },
        || bb(vec![1u8]).insert(bb(3), 1),
        || {
            bb(bb(vec![1u8]).split_off(bb(3)));
        },
        || {
            use std::future::Future;
            let mut done = std::pin::pin!(async {});
            let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
            let _ = done.as_mut().poll(&mut cx);
            let _ = done.as_mut().poll(&mut cx);
        },
        || {
            bb(bb(std::collections::HashMap::<u8, u8>::new())[&bb(1)]);
        },
        || {
            bb(bb(std::collections::BTreeMap::<u8, u8>::new())[&bb(1)]);
        },
        || {
            bb(bb(std::collections::VecDeque::<u8>::new())[bb(1)]);
        },
        || {
            bb(bb(std::time::Duration::from_secs(1)) / bb(0u32));
        },
        || {
            bb(bb(&[1u8; 2][..]).split_at(bb(3)));
        },
        || [0u8; 2].copy_from_slice(bb(&[1u8; 3][..])),
        || [0u8; 2].swap_with_slice(bb(&mut [1u8; 3][..])),
        || {
            bb(bb(&[1u8; 2][..]).chunks(bb(0)).count());
        },
        || {
            bb(bb(&[1u8; 2][..]).windows(bb(0)).count());
        },
        || {
            bb(bb(0u64).ilog2());
        },
        || {
            bb(bb(5u64).ilog(bb(1)));
        },
        || {
            bb(bb(-1i64).isqrt());
        },
        || {
            bb(bb(1u64).clamp(bb(3), bb(2)));
        },
        || {
            bb(std::time::Instant::now() + bb(std::time::Duration::MAX));
        },
        || {
            bb(std::time::Instant::now() - bb(std::time::Duration::MAX));
        },
        || bb(String::from("a")).insert(bb(3), 'x'),
        || {
            let once = std::sync::Once::new();
            let _ = std::panic::catch_unwind(|| once.call_once(|| panic!("poisons it")));
            once.call_once(|| {});
        },
        || {
            std::thread::scope(|scope| {
                scope.spawn(|| panic!("the scoped thread's own"));
            });
        },
        || {
            bb(bb(String::from("a")).remove(bb(1)));
        },
        || bb(String::from("é")).replace_range(bb(1)..2, "x"),
        || bb(String::from("é")).replace_range(bb(0)..1, "x"),
        || [1u8, 2, 3].copy_within(bb(0..2), bb(2)),
        || {
            bb(std::time::Duration::from_nanos_u128(bb(u128::MAX)));
        },
        || {
            bb(std::time::SystemTime::now() + bb(std::time::Duration::MAX));
        },
        || {
            bb(std::time::SystemTime::UNIX_EPOCH - bb(std::time::Duration::MAX));
        },
        || {
            bb(bb(std::iter::repeat(bb(1u8))).count());
        },
        || {
            bb(format!("{:1$}", 1, bb(70_000usize)));
        },
    ];
    let at = suite_line(|l| l.starts_with("assert_eq!("));
    for raise in runtime {
        let ran = run_on_a_thread(5, raise);
        let Ran::Panicked { file, .. } = &ran else {
            panic!("it panicked");
        };
        assert!(
            file.ends_with("nfx-pay/tests/runner.rs"),
            "reported at the line that caused it: {file}: {}",
            message(&ran)
        );
        let ran = in_the_suite(ran, at);
        assert!(!message(&ran).is_empty(), "a runtime panic has a message");
        assert!(!ran.failed_the_suite(), "counted: {}", message(&ran));
    }
    // Nor does a panic that names nothing: no message, or `panic!()` and `unreachable!()`
    // bare.
    let nameless: [fn(); 3] = [
        || std::panic::panic_any(7u8),
        || panic!(),
        || unreachable!(),
    ];
    for raise in nameless {
        let ran = in_the_suite(run_on_a_thread(5, raise), at);
        assert!(!ran.failed_the_suite(), "counted: {}", message(&ran));
    }
}

#[test]
fn only_the_code_of_a_line_makes_a_check() {
    let made = [
        "assert!(x);",
        "    assert_eq!(a, b, \"a behaviour\");",
        "assert_ne!(a, b);",
        "let x = y.expect(\"named\");",
        "let x = y.expect_err(\"named\");",
        "_ => panic!(\"round {round}\"),",
        "unreachable!(\"named\")",
        "let s = \"\\\\\"; assert!(x);",
        "let s = \"\\\"\"; assert!(x);",
        "let q = '\"'; assert!(x);",
        "let q = '\\''; assert!(x);",
        "let s = r#\"a \" b\"#; assert!(x);",
        "fn f<'a>(x: &'a str) { assert!(x.is_empty()) }",
        "/* a comment */ assert!(x);",
    ];
    for source in made {
        assert!(makes_a_check(source, 1), "no check found: {source}");
    }
    let not_made = [
        "let x = y.unwrap();",
        "let x = y; // assert!(x)",
        "/// assert!(x)",
        "let s = \"assert!(x)\";",
        "let s = \"\\\" assert!(x)\";",
        "let q = '\\n'// assert!(x)",
        "let s = b\"assert!(x)\";",
        "let s = r#\"assert!(\"#;",
        "let s = r\"\\\"; let t = \"assert!(\";",
        "let q = '\"'; let s = \"assert!(\";",
        "/* assert!(x) */ let y = 1;",
        "/* /* */ assert!(x) */ let y = 1;",
        "let x = todo!();",
    ];
    for source in not_made {
        assert!(!makes_a_check(source, 1), "a check found: {source}");
    }
    // Literals and comments run across lines: a line inside one makes no check.
    let across = [
        "let s = \"a\nassert!(x)\";",
        "let s = \"a \\\nassert!(x)\";",
        "let s = r#\"a\nassert!(x)\"#;",
        "/* a\nassert!(x) */",
        "/* a /* b */\nassert!(x) */",
    ];
    for source in across {
        assert!(!makes_a_check(source, 2), "a check found: {source}");
    }
    let after = "let s = \"a\nb\"; assert!(x);";
    assert!(makes_a_check(after, 2), "no check after a string ends");
    assert!(
        !makes_a_check("assert!(x);", 2),
        "a line that does not exist"
    );
    assert!(!makes_a_check("assert!(x);", 0), "no line at all");
}

#[test]
fn the_suite_makes_no_bare_unwrap() {
    // clippy denies an `unwrap` call in the suite, but not one passed as a function
    // (`map(Option::unwrap)`): its panic is raised in core, where no check counts it. So
    // the suite's code, read as the line rule reads it, names neither word at all.
    assert_eq!(
        code_lines(SUITE).len(),
        SUITE.lines().count(),
        "the code of every line of the suite"
    );
    let found = bare_unwraps(SUITE);
    assert!(
        found.is_empty(),
        "a bare unwrap in the suite, at lines {found:?}"
    );
    // Found as a call and as a function, never in a comment, a literal or a longer word.
    let found = [
        "let x = y.unwrap();",
        "let n = [o].into_iter().map(Option::unwrap).sum::<u8>();",
        "let f: fn(Option<u8>) -> u8 = Option::unwrap;",
        "let x = Result::unwrap(r);",
        "let e = r.unwrap_err();",
        "let e = [r].map(Result::unwrap_err);",
        "let x = <Option<u8>>::unwrap(o);",
        "let x = y.r#unwrap();",
    ];
    for source in found {
        assert!(bare_unwraps(source) == [1], "not found: {source}");
    }
    let not_found = [
        "let x = y.unwrap_or(0);",
        "let x = y.unwrap_or_else(f).unwrap_or_default();",
        "let x = y.expect(\"named\"); // not y.unwrap()",
        "/* y.unwrap() */ let x = 1;",
        "let s = \"y.unwrap()\";",
        "let s = r#\"Option::unwrap\"#;",
        "let s = \"a\ny.unwrap()\";",
        "/* a\nmap(Option::unwrap) */",
    ];
    for source in not_found {
        assert!(bare_unwraps(source).is_empty(), "found: {source}");
    }
}

/// The lines (from 1) of `source` whose code names `unwrap` or `unwrap_err` as a word.
fn bare_unwraps(source: &str) -> Vec<usize> {
    let is_ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    (1..)
        .zip(code_lines(source))
        .filter(|(_, code)| {
            code.split(|c| !is_ident(c))
                .any(|w| w == "unwrap" || w == "unwrap_err")
        })
        .map(|(at, _)| at)
        .collect()
}

fn a_behaviour() {
    assert_eq!(bb(1), 2, "a behaviour");
}

/// The first line of the suite whose text, trimmed, `matches`.
fn suite_line(matches: impl Fn(&str) -> bool) -> u32 {
    let at = SUITE
        .lines()
        .position(|l| matches(l.trim()))
        .expect("such a line in the suite");
    u32::try_from(at + 1).expect("a line number")
}

/// `ran`'s panic, reported as raised at line `line` of the suite's file.
fn in_the_suite(ran: Ran, line: u32) -> Ran {
    let Ran::Panicked { payload, .. } = ran else {
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
