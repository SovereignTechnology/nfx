//! The NFX-07 adversary suite against honest engines that take their time differently, each
//! in a way NFX-07 leaves free: the mint's answers coming late, out of order, keys after the
//! listings asked after them, callers woken before their answer can be seen or woken for
//! nothing, and the seeder settling swaps or sweeping on tasks of its own, or taking more
//! polls at each step. The suite judges progress by answers and settling, so every scenario
//! must pass against each as against the synchronous mock (`adversary.rs`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use nfx_pay::mock::{MockHarness, Spawner, Timing};

/// Spawns on the runtime the scenario runs in, from whatever thread asks.
fn spawner() -> Spawner {
    let rt = tokio::runtime::Handle::current();
    Arc::new(move |f| {
        rt.spawn(f);
    })
}

fn woken() -> Timing {
    Timing {
        woken: true,
        ..Timing::default()
    }
}

/// Every answer comes back 5 ms after it reaches the mint.
mod slow_answers {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        answer_after: Some(Duration::from_millis(5)),
        ..woken()
    }));
}

/// Each answer takes from none to 4 ms, so answers overtake one another.
mod jittered_answers {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        jitter: true,
        ..woken()
    }));
}

/// Keys come back 6 ms after any other answer: after a listing asked after them.
mod keys_after_listings {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        keys_later: Some(Duration::from_millis(6)),
        ..woken()
    }));
}

/// A caller is woken a millisecond before its answer can be seen, then again.
mod early_wakes {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        wake_early: true,
        ..woken()
    }));
}

/// Every answer wakes everything that waits, at the mint or on the clock.
mod spurious_wakes {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        spurious_wakes: true,
        ..woken()
    }));
}

/// The seeder settles each swap's outcome on a task of its own, answers coming by a wake.
mod outcomes_on_a_task {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        spawn: Some(spawner()),
        ..woken()
    }));
}

/// The same, the mint answering at once.
mod outcomes_on_a_task_at_once {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        spawn: Some(spawner()),
        ..Timing::default()
    }));
}

/// The seeder sweeps on a task of its own too, which its sweep awaits.
mod sweeps_on_a_task {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        spawn: Some(spawner()),
        sweep_on_a_task: true,
        ..woken()
    }));
}

/// The seeder's entries take seven polls more at each step, waking themselves.
mod more_polls {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        yields: 7,
        ..woken()
    }));
}

/// The same, the mint answering at once.
mod more_polls_at_once {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        yields: 7,
        ..Timing::default()
    }));
}

/// All of them at once.
mod all_at_once {
    use super::*;
    nfx_pay::adversary_suite!(MockHarness::with_timing(Timing {
        jitter: true,
        keys_later: Some(Duration::from_millis(3)),
        wake_early: true,
        spurious_wakes: true,
        spawn: Some(spawner()),
        sweep_on_a_task: true,
        yields: 3,
        ..woken()
    }));
}
