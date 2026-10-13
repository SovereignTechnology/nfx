//! A turn of the suite's waiting (`yield_once`), without an engine: it ends once every task
//! the runtime had ready as it began has run, however many they are, and never sooner. The
//! cases that say so run through [`run_scenario!`](crate::run_scenario) itself, so they hold
//! of the runtime it builds and of the order that runtime takes its ready tasks up in: one
//! thread, a queue in order, and no other thread alive while a turn is waited, so nothing
//! here depends on timing. A turn that was one yield of the suite's task, as it once was,
//! fails each of them at its own assertion: tokio's current-thread runtime polls a task that
//! yielded again after 61 of its ready tasks. The cases that are about the
//! runner itself build theirs by hand, as that macro builds its own but for the way a task
//! is started.

use super::*;

/// How many tasks stand ready at once: far above the 61 one yield lets run, and above what
/// a hundred yields do.
const MANY: u64 = 30_000;

/// How long a case that builds its own runner may take: far above what it needs on any
/// machine. A turn that never ends is reported there as hung.
const PATIENCE: u64 = 60;

/// Tasks of the runtime that count their polls, each waiting to be woken between two.
#[derive(Clone, Default)]
struct Sleepers {
    polls: Arc<AtomicU64>,
    wakers: Arc<Mutex<Vec<Waker>>>,
}

impl Sleepers {
    /// One such task, to be started.
    fn one(&self) -> impl Future<Output = ()> + Send + 'static {
        let these = self.clone();
        poll_fn(move |cx| {
            these.polls.fetch_add(1, Ordering::SeqCst);
            these.asleep().push(cx.waker().clone());
            Poll::Pending
        })
    }

    /// Start `n` of them on the runtime this runs in: each is ready, behind every task
    /// that was.
    fn start(&self, n: u64) {
        for _ in 0..n {
            tokio::spawn(self.one());
        }
    }

    fn asleep(&self) -> std::sync::MutexGuard<'_, Vec<Waker>> {
        self.wakers.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Wake `n` of those that wait (all of them, if fewer do): each is ready again.
    fn wake(&self, n: u64) {
        let woken: Vec<Waker> = {
            let mut asleep = self.asleep();
            let keep = asleep
                .len()
                .saturating_sub(usize::try_from(n).unwrap_or(usize::MAX));
            asleep.split_off(keep)
        };
        for w in woken {
            w.wake();
        }
    }

    /// Polls made so far, of all of them together.
    fn polls(&self) -> u64 {
        self.polls.load(Ordering::SeqCst)
    }
}

/// A run through [`run_scenario!`](crate::run_scenario) finished: a panic it ended with is
/// raised again here, as [`adversary_suite!`](crate::adversary_suite) raises a scenario's.
fn finished(ran: Ran) {
    match ran {
        Ran::Finished => {}
        Ran::Panicked { payload, .. } => std::panic::resume_unwind(payload),
        Ran::Hung => panic!("a turn never ended: the run was timed out"),
    }
}

#[test]
fn a_turn_ends_once_every_task_ready_as_it_began_has_run() {
    finished(crate::run_scenario!(turns_one_after_another()));
}

/// Turns one after another, each with tasks made ready before it: started, woken, by this
/// thread and by another.
async fn turns_one_after_another() {
    let tasks = Sleepers::default();
    // Started: the suite's first turn starts its own task behind them.
    tasks.start(MANY);
    yield_once().await;
    assert_eq!(
        tasks.polls(),
        MANY,
        "every task started before the suite's first turn has run as that turn ends"
    );
    // Nothing ready: the turn ends all the same, and nothing ran for it.
    yield_once().await;
    assert_eq!(tasks.polls(), MANY, "a turn with no task ready");
    // Woken: a later turn wakes the suite's own task behind them.
    tasks.wake(MANY);
    yield_once().await;
    assert_eq!(
        tasks.polls(),
        2 * MANY,
        "every task woken before a later turn has run as that turn ends"
    );
    // Woken and started both, a third of them by another thread, which has ended
    // before the turn begins: the runtime takes those up first.
    let (theirs, runtime) = (tasks.clone(), tokio::runtime::Handle::current());
    let other = std::thread::spawn(move || {
        theirs.wake(MANY / 3);
        for _ in 0..MANY / 3 {
            runtime.spawn(theirs.one());
        }
    });
    assert!(other.join().is_ok(), "the other thread ended");
    tasks.wake(MANY);
    tasks.start(MANY / 3);
    yield_once().await;
    assert_eq!(
        tasks.polls(),
        3 * MANY + 2 * (MANY / 3),
        "every task made ready before a turn, on this thread or by another, has run as \
         that turn ends"
    );
    // And once more with nothing ready, after all that.
    yield_once().await;
    assert_eq!(
        tasks.polls(),
        3 * MANY + 2 * (MANY / 3),
        "a last turn with no task ready"
    );
}

#[test]
fn two_turns_at_once_each_end_on_the_tasks_ready_as_they_began() {
    finished(crate::run_scenario!(turns_at_once()));
}

/// Turns of the two sides of a [`both`], waited at once.
async fn turns_at_once() {
    let tasks = Sleepers::default();
    // The first side's turn begins with its tasks ready, the second's with as many
    // more behind them: the suite's task is queued once, between the two lots.
    let (first, second) = both(
        async {
            tasks.start(MANY);
            yield_once().await;
            tasks.polls()
        },
        async {
            tasks.start(MANY);
            yield_once().await;
            tasks.polls()
        },
    )
    .await;
    assert!(
        first >= MANY,
        "the first side's turn ended with the tasks ready as it began run: {first} polls"
    );
    assert_eq!(
        second,
        2 * MANY,
        "the second side's turn ended with the tasks ready as it began run, the ones \
         started after the first side's turn began among them"
    );
    // One side waits two turns while the other waits one that began between them, each
    // with tasks made ready just before it.
    let (first, second) = both(
        async {
            tasks.wake(MANY / 2);
            yield_once().await;
            let after_one = tasks.polls();
            tasks.wake(MANY / 2);
            yield_once().await;
            (after_one, tasks.polls())
        },
        async {
            tasks.wake(MANY / 2);
            yield_once().await;
            tasks.polls()
        },
    )
    .await;
    assert!(
        first.0 >= 2 * MANY + MANY / 2,
        "the first of one side's two turns: {} polls",
        first.0
    );
    assert!(
        second >= 3 * MANY,
        "the other side's turn, begun behind the first: {second} polls"
    );
    assert_eq!(
        first.1,
        3 * MANY + MANY / 2,
        "the second of one side's two turns, begun with the other side's still waited"
    );
    // A turn alone again, once two were waited at once.
    tasks.wake(2 * MANY);
    yield_once().await;
    assert_eq!(tasks.polls(), 5 * MANY + MANY / 2, "a turn after those");
}

#[test]
fn a_turn_left_unfinished_ends_no_later_turn_early() {
    finished(crate::run_scenario!(a_turn_after_one_left_unfinished()));
}

/// A turn begun and dropped where it waits, then turns waited whole.
async fn a_turn_after_one_left_unfinished() {
    let tasks = Sleepers::default();
    tasks.start(MANY);
    {
        // A turn begun and dropped where it waits, as a future the suite drives is
        // dropped with a wait of its own under way.
        let mut left = pin!(yield_once());
        assert!(
            poll_in_task(left.as_mut()).await.is_none(),
            "a turn waits while tasks are ready"
        );
    }
    assert_eq!(tasks.polls(), 0, "no task has run yet");
    // The next begins with more tasks ready, behind the suite's own task as the turn
    // left unfinished queued it.
    tasks.start(MANY);
    yield_once().await;
    assert_eq!(
        tasks.polls(),
        2 * MANY,
        "the tasks ready as the turn began, those behind an earlier turn's end too"
    );
    tasks.wake(2 * MANY);
    yield_once().await;
    assert_eq!(tasks.polls(), 4 * MANY, "and a turn after it");
}

#[test]
fn turns_waited_by_one_task_after_another_end_alike() {
    finished(crate::run_scenario!(turns_of_two_tasks()));
}

/// Turns the scenario's own task waits, then turns another task of the runtime waits, then
/// the scenario's again: whoever waits a turn is the one woken as it ends.
async fn turns_of_two_tasks() {
    let tasks = Sleepers::default();
    tasks.start(MANY);
    yield_once().await;
    assert_eq!(tasks.polls(), MANY, "a turn of the scenario's own task");
    let theirs = tasks.clone();
    let other = tokio::spawn(async move {
        theirs.wake(MANY);
        yield_once().await;
        let after_one = theirs.polls();
        theirs.wake(MANY);
        yield_once().await;
        (after_one, theirs.polls())
    });
    let seen = other.await.expect("the other task finished");
    assert_eq!(
        seen,
        (2 * MANY, 3 * MANY),
        "two turns waited by another task of the runtime"
    );
    tasks.wake(MANY);
    yield_once().await;
    assert_eq!(
        tasks.polls(),
        4 * MANY,
        "and a turn of the scenario's own task again"
    );
}

#[test]
fn a_turn_with_no_runner_is_one_yield() {
    // No runner gave this thread a way to start tasks: the turn asks to be polled again,
    // once, and is over at that poll.
    let ran = run_on_a_thread(PATIENCE, || {
        let wakes = Arc::new(Wakes::default());
        let waker = Waker::from(wakes.clone());
        let mut cx = Context::from_waker(&waker);
        let mut turn = pin!(yield_once());
        assert!(turn.as_mut().poll(&mut cx).is_pending(), "it yields");
        assert_eq!(
            wakes.0.load(Ordering::SeqCst),
            1,
            "and wakes its task, once"
        );
        assert!(turn.as_mut().poll(&mut cx).is_ready(), "one yield");
        assert_eq!(wakes.0.load(Ordering::SeqCst), 1, "with no wake more");
    });
    finished(ran);
}

/// Counts the wakes of a task polled by hand.
#[derive(Default)]
struct Wakes(AtomicU64);

impl Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// A task as a runner's `start` is handed it.
type Started = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Run `scenario` as [`run_scenario!`](crate::run_scenario) runs one, but for how a task
/// of the suite's is started: `start` is handed the runtime's handle with it.
fn run_started<F: Future<Output = ()>>(
    start: impl Fn(&tokio::runtime::Handle, Started) + Send + 'static,
    scenario: impl FnOnce() -> F + Send + 'static,
) -> Ran {
    run_on_a_thread(PATIENCE, move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .global_queue_interval(1)
            .build()
            .expect("a runtime");
        let tasks = runtime.handle().clone();
        with_tasks(
            move |task| start(&tasks, task),
            move || runtime.block_on(Box::pin(async move { scenario().await })),
        );
    })
}

/// `ran` ended on a turn that could not be waited: with the panic that is no check of the
/// suite's (`NoRunner`), raised in the suite, and neither finished nor hung.
fn no_turn_was_waited(ran: &Ran, runner: &str) {
    let Ran::Panicked { file, payload, .. } = ran else {
        panic!(
            "{runner}: the run is reported as panicked, not as {}",
            if matches!(ran, Ran::Hung) {
                "hung"
            } else {
                "finished"
            }
        );
    };
    assert!(
        payload.is::<NoRunner>(),
        "{runner}: raised as a task started with no runner is"
    );
    assert!(
        file.ends_with("nfx-pay/src/adversary.rs"),
        "{runner}: {file}"
    );
    assert!(
        !ran.failed_the_suite(),
        "{runner}: no check of the suite's failed, and no planted defect is caught so"
    );
}

#[test]
fn a_runner_that_drops_the_suites_task_gives_no_turn() {
    // The engine's one task is ready. A turn that ended at once would have the suite look
    // with it unrun, and the scenario go on to finish.
    let ran = run_started(
        |_, task| drop(task),
        || async {
            let tasks = Sleepers::default();
            tasks.start(1);
            yield_once().await;
            assert_eq!(tasks.polls(), 1, "the turn was waited");
        },
    );
    no_turn_was_waited(&ran, "a start that drops the task");
    // The same where the suite settles: a hundred turns, none of them waited.
    let ran = run_started(
        |_, task| drop(task),
        || async {
            let tasks = Sleepers::default();
            tasks.start(1);
            for _ in 0..TURNS {
                yield_once().await;
            }
        },
    );
    no_turn_was_waited(&ran, "a start that drops the task, a hundred turns");
}

#[test]
fn a_runner_that_starts_the_suites_task_elsewhere_gives_no_turn() {
    // Polled on another thread, the suite's task ends no turn of this thread's runtime:
    // taken for one that did, it would end each turn as one yield does.
    let ran = run_started(
        |_, mut task| {
            let elsewhere = std::thread::spawn(move || {
                let mut cx = Context::from_waker(Waker::noop());
                let done = task.as_mut().poll(&mut cx).is_ready();
                (done, task)
            });
            // Kept, as a runtime keeps a task it polls: dropped only if it finished.
            match elsewhere.join() {
                Ok((true, task)) => drop(task),
                Ok((false, task)) => std::mem::forget(task),
                Err(_) => {}
            }
        },
        || async {
            let tasks = Sleepers::default();
            tasks.start(MANY);
            yield_once().await;
            assert_eq!(tasks.polls(), MANY, "the turn was waited");
        },
    );
    no_turn_was_waited(&ran, "a start on another thread");
    // The same with that thread still at it as the turn begins to wait.
    let ran = run_started(
        |_, mut task| {
            std::thread::spawn(move || {
                let mut cx = Context::from_waker(Waker::noop());
                while task.as_mut().poll(&mut cx).is_pending() {
                    std::thread::park_timeout(Duration::from_millis(1));
                }
            });
        },
        || async {
            let tasks = Sleepers::default();
            tasks.start(MANY);
            yield_once().await;
            assert_eq!(tasks.polls(), MANY, "the turn was waited");
        },
    );
    no_turn_was_waited(&ran, "a start on another thread, not joined");
}

#[test]
fn a_turn_whose_task_is_ended_under_it_is_not_taken_for_over() {
    // The runner started the suite's task where it should, and something ends it while a
    // turn waits on it, with tasks ready as the turn began still to run.
    let started = Arc::new(Mutex::new(Vec::new()));
    let kept = started.clone();
    let ran = run_started(
        move |runtime, task| {
            let handle = runtime.spawn(task);
            kept.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(handle);
        },
        move || async move {
            let tasks = Sleepers::default();
            tasks.start(1);
            yield_once().await;
            assert_eq!(tasks.polls(), 1, "a first turn, waited");
            tokio::spawn(async move {
                for task in started
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .iter()
                {
                    task.abort();
                }
            });
            tasks.wake(1);
            tasks.start(MANY);
            yield_once().await;
            assert_eq!(tasks.polls(), 2 + MANY, "the turn was waited");
        },
    );
    no_turn_was_waited(&ran, "the suite's task ended while a turn waits");
}

#[test]
fn a_task_ended_between_turns_is_started_again() {
    // Ended with no turn under way, it is gone: the next turn starts another, and is
    // waited as any.
    let started = Arc::new(Mutex::new(Vec::new()));
    let (kept, count) = (started.clone(), started.clone());
    let ran = run_started(
        move |runtime, task| {
            let handle = runtime.spawn(task);
            kept.lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(handle);
        },
        move || async move {
            let tasks = Sleepers::default();
            tasks.start(MANY);
            yield_once().await;
            assert_eq!(tasks.polls(), MANY, "a first turn, waited");
            for turn in 2..=4 {
                tasks.wake(MANY);
                yield_once().await;
                assert_eq!(tasks.polls(), turn * MANY, "turn {turn}, waited");
            }
            let first = {
                let mut started = started.lock().unwrap_or_else(PoisonError::into_inner);
                assert_eq!(
                    started.len(),
                    1,
                    "one task of the suite's serves every turn of a run"
                );
                started
                    .pop()
                    .expect("the suite's task was started for the first turn")
            };
            first.abort();
            assert!(
                first.await.is_err_and(|e| e.is_cancelled()),
                "the suite's task is ended, with no turn under way"
            );
            tasks.wake(MANY);
            tasks.start(MANY);
            yield_once().await;
            assert_eq!(tasks.polls(), 6 * MANY, "the next turn, waited");
            tasks.wake(2 * MANY);
            yield_once().await;
            assert_eq!(tasks.polls(), 8 * MANY, "and the one after");
        },
    );
    finished(ran);
    assert_eq!(
        count.lock().unwrap_or_else(PoisonError::into_inner).len(),
        1,
        "one task more was started, for the turns after the first was ended"
    );
}

/// A task polled with a waker of its own at each poll, of which only the last one made
/// wakes it: a runtime may hand a task another waker at every poll, and need not heed an
/// earlier one.
struct NewWakers {
    task: Started,
    made: Arc<AtomicU64>,
}

/// The waker of one poll of a [`NewWakers`].
struct OneOf {
    made: Arc<AtomicU64>,
    this: u64,
    task: Waker,
}

impl Wake for OneOf {
    fn wake(self: Arc<Self>) {
        if self.made.load(Ordering::SeqCst) == self.this {
            self.task.wake_by_ref();
        }
    }
}

impl Future for NewWakers {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let waker = Waker::from(Arc::new(OneOf {
            made: self.made.clone(),
            this: self.made.fetch_add(1, Ordering::SeqCst) + 1,
            task: cx.waker().clone(),
        }));
        self.task.as_mut().poll(&mut Context::from_waker(&waker))
    }
}

#[test]
fn the_suites_task_is_woken_by_the_waker_of_its_last_poll() {
    // The runner's runtime gives the suite's task a new waker at each poll: every turn
    // queues it by the one it was polled with last.
    let ran = run_started(
        |runtime, task| {
            runtime.spawn(NewWakers {
                task,
                made: Arc::default(),
            });
        },
        || async {
            let tasks = Sleepers::default();
            tasks.start(MANY);
            yield_once().await;
            assert_eq!(tasks.polls(), MANY, "a first turn");
            for turn in 2..=5 {
                tasks.wake(MANY);
                yield_once().await;
                assert_eq!(tasks.polls(), turn * MANY, "turn {turn}");
            }
        },
    );
    finished(ran);
}

#[test]
fn a_second_run_on_a_thread_takes_no_turn_from_the_first() {
    // Two runs on one thread, each with a runtime of its own, the first run's runtime
    // alive still, its task of the suite's with it: a turn of the second run ends on a
    // task of the second runtime.
    let ran = run_on_a_thread(PATIENCE, || {
        let runtime = || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .global_queue_interval(1)
                .build()
                .expect("a runtime")
        };
        let turns = |runtime: &tokio::runtime::Runtime| {
            let tasks = runtime.handle().clone();
            with_tasks(
                move |task| {
                    tasks.spawn(task);
                },
                || {
                    runtime.block_on(async {
                        let tasks = Sleepers::default();
                        tasks.start(MANY);
                        yield_once().await;
                        assert_eq!(tasks.polls(), MANY, "a turn of this run");
                        tasks.wake(MANY);
                        yield_once().await;
                        assert_eq!(tasks.polls(), 2 * MANY, "and the next");
                    });
                },
            );
        };
        let (first, second) = (runtime(), runtime());
        turns(&first);
        turns(&second);
        turns(&first);
    });
    finished(ran);
}
