//! The manifests an embedded scoped relay has accepted, kept across a restart (issue #114).
//!
//! A private directory (0700) holds:
//!
//! - `<sha256 of the manifest's a tag, hex>.json` (0600): the newest accepted revision of that
//!   address, the signed kind-38504 event exactly as a relay sends it. One file per address,
//!   so a write costs one event however many the relay holds, and a damaged file costs one
//!   manifest. Written to a temp file, fsynced and renamed.
//! - `deletions.jsonl` (0600): one `{"a":<a tag>,"until":<created_at>}` per address, the date
//!   at or before which no revision of it is taken. A deletion sets it. NFX-04 §7 persists
//!   kind 38504 only, so the deletion event itself is not kept: this line is what a restart
//!   needs to go on refusing the revisions it withdrew. An expired revision sets it too, so
//!   that the older one it replaced cannot be re-sent in its place. A line can only ever take
//!   a manifest away.
//! - `<same stem>.fallback` (0600), rarely: when the current rules refuse the stored revision
//!   (a clock set back, say) and accept an older one, the older one is kept here so that it
//!   survives a restart. The refused record stays where it is and wins again as soon as the
//!   rules take it; a deletion or a newer revision ends both.
//!
//! One writer at a time: the store holds an exclusive lock on the directory from before it
//! reads anything until its writer exits. A relay that cannot get it runs in memory.
//!
//! **A file grants nothing.** On load every event is re-verified (id and signature) and run
//! through the relay's current admission, so a creator taken off the allow-list is not served.
//! Such a file stays on disk, in case the operator puts the creator back. Beacons and
//! signaling never come here: only kind 38504 does ([`ManifestStore::put`]).
//!
//! The limits are the memory store's: [`MAX_STORED_EVENTS`] files in all, of at most
//! [`MAX_MANIFEST_BYTES`], the oldest going first. Nothing here can stop the relay: a file
//! that cannot be used is logged and passed over, and a write that fails leaves the manifest
//! served from memory until the next restart.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use nfx_proto::KIND_MANIFEST;
use nfx_proto::beacon::parse_a_tag;
use nfx_proto::deletion::Deletion;
use nostr_sdk::prelude as ns;
use tokio::sync::{mpsc, oneshot};

use crate::relay::{MAX_MANIFEST_BYTES, MAX_STORED_EVENTS};
use crate::unix_now;

const DELETIONS: &str = "deletions.jsonl";
const TEMP_PREFIX: &str = ".tmp-";
const FALLBACK_SUFFIX: &str = ".fallback";
/// A line of `deletions.jsonl`: the longest `a` tag (192 bytes: kind, key, namespace, id) and
/// its `until`, in JSON.
const MAX_DELETION_LINE: usize = 256;
const MAX_DELETIONS_BYTES: u64 = (MAX_STORED_EVENTS * MAX_DELETION_LINE) as u64;
/// Writes queued before a publisher waits for room.
const QUEUE: usize = 256;
/// Jobs handled in one pass of the writer, so that a burst shares one rewrite of the deletions.
const MAX_BATCH: usize = 64;
/// How long a publisher's `OK` waits for the disk. Past it the relay answers anyway: a stuck
/// disk must not stall the relay, and the write still happens if it can.
const WRITE_WAIT: Duration = Duration::from_secs(5);
/// A failing disk logs at most one line this often.
const WARN_EVERY_SECS: u64 = 60;
/// How long a start waits for the directory's lock, for a writer that is just finishing.
const LOCK_WAIT: Duration = Duration::from_secs(5);
const LOCK_POLL: Duration = Duration::from_millis(25);
/// A failed write of the deletions is retried after this, doubling up to [`RETRY_MAX`].
const RETRY_MIN: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(300);
/// File-by-file lines in a [`Reload`]; the counts always cover every file.
const MAX_NOTES: usize = 16;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);
static LAST_WARNED: AtomicU64 = AtomicU64::new(0);

/// What a start found in the state directory. Holds no event content.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reload {
    /// Manifests verified, admitted under the current rules and served.
    pub served: usize,
    /// Addresses whose newest revision the current rules refuse: kept on disk and not served.
    /// An older revision they accept may be served in its place.
    pub refused: usize,
    /// Past their NIP-40 `expiration`: removed.
    pub expired: usize,
    /// Withdrawn by a recorded deletion: removed.
    pub withdrawn: usize,
    /// Files that were not a valid record (corrupt, truncated, oversized, a bad signature):
    /// removed.
    pub corrupt: usize,
    /// Files passed over and left in place (unreadable, not a regular file).
    pub skipped: usize,
    /// Valid records older than the newest the limit allows: removed.
    pub excess: usize,
    /// Addresses with a recorded deletion (or expired revision) still honoured.
    pub deletions: usize,
    /// Damaged lines of the deletions file, passed over.
    pub bad_deletions: usize,
    /// One line per problem, at most 16; the counts above cover every file.
    pub notes: Vec<String>,
    /// Why nothing is being kept, when the directory cannot be used.
    pub off: Option<String>,
}

impl Reload {
    fn note(&mut self, line: String) {
        if self.notes.len() < MAX_NOTES {
            self.notes.push(line);
        }
    }
}

impl fmt::Display for Reload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let Some(why) = &self.off {
            return write!(f, "manifests are kept in memory only: {why}");
        }
        write!(
            f,
            "{} manifests reloaded, {} refused by the current rules (kept, not served), {} \
             expired, {} withdrawn, {} damaged (removed), {} passed over, {} past the limit \
             (removed), {} deletions honoured ({} damaged lines)",
            self.served,
            self.refused,
            self.expired,
            self.withdrawn,
            self.corrupt,
            self.skipped,
            self.excess,
            self.deletions,
            self.bad_deletions
        )
    }
}

type Deleted = Arc<Mutex<HashMap<String, u64>>>;
type Queued = (Job, oneshot::Sender<()>);

enum Job {
    Put(Box<ns::Event>),
    Withdraw { addresses: Vec<String>, until: u64 },
}

/// The relay's handle on the directory. All disk work happens on one thread, in order, so a
/// connection that goes away mid-write cannot leave it half done.
#[derive(Debug)]
pub(crate) struct ManifestStore {
    /// `None` once closed.
    jobs: Mutex<Option<mpsc::Sender<Queued>>>,
    deleted: Deleted,
}

impl ManifestStore {
    /// Keep `event`, if it is a manifest and the newest of its address. Returns once it is on
    /// disk, so that a publisher's `OK` means it survives a restart.
    pub(crate) async fn put(&self, event: &ns::Event) {
        if event.kind.as_u16() == KIND_MANIFEST {
            self.send(Job::Put(Box::new(event.clone()))).await;
        }
    }

    /// Record a deletion the relay has honoured, and remove the revisions it withdraws.
    pub(crate) async fn withdraw(&self, d: &Deletion) {
        let addresses = d
            .addresses
            .iter()
            .map(|addr| format!("{KIND_MANIFEST}:{}:{addr}", d.author))
            .collect();
        self.send(Job::Withdraw {
            addresses,
            until: d.created_at,
        })
        .await;
    }

    /// Whether a recorded deletion withdraws the revision of `a` made at `created_at`.
    pub(crate) fn withdrawn(&self, a: &str, created_at: u64) -> bool {
        lock(&self.deleted)
            .get(a)
            .is_some_and(|until| created_at <= *until)
    }

    /// Stop taking work. The writer finishes what is queued, exits and releases the directory,
    /// so that a relay started next on it does not wait on this one's connections.
    pub(crate) fn close(&self) {
        drop(lock(&self.jobs).take());
    }

    async fn send(&self, job: Job) {
        let Some(jobs) = lock(&self.jobs).clone() else {
            return;
        };
        let (done, finished) = oneshot::channel();
        let wrote = tokio::time::timeout(WRITE_WAIT, async {
            jobs.send((job, done)).await.is_ok() && finished.await.is_ok()
        })
        .await;
        if !matches!(wrote, Ok(true)) {
            warn("the disk is behind: an accepted manifest may not survive a restart");
        }
    }
}

/// Open `dir`, take its lock, load what is valid, and start the writer. `admits` is the relay's
/// current admission. Never fails: a directory that cannot be used, or that another relay
/// holds, is reported in [`Reload::off`] and the relay runs in memory, as it does with no state
/// directory.
pub(crate) fn open(
    dir: &Path,
    cap: usize,
    admits: impl Fn(&ns::Event) -> bool,
) -> (Option<ManifestStore>, Vec<ns::Event>, Reload) {
    let off = |e: &dyn fmt::Display| Reload {
        off: Some(format!("cannot use {}: {e}", dir.display())),
        ..Reload::default()
    };
    let (disk, events, reload) = match load(dir, cap, &admits) {
        Ok(loaded) => loaded,
        Err(e) => return (None, Vec::new(), off(&e)),
    };
    let deleted = disk.deleted.clone();
    let (jobs, queue) = mpsc::channel(QUEUE);
    let writer = std::thread::Builder::new()
        .name("nfx-relay-store".into())
        .spawn(move || write_loop(disk, queue));
    match writer {
        Ok(_) => (
            Some(ManifestStore {
                jobs: Mutex::new(Some(jobs)),
                deleted,
            }),
            events,
            reload,
        ),
        // Still served this run, from what was read; nothing new is kept.
        Err(e) => (
            None,
            events,
            Reload {
                off: off(&e).off,
                ..reload
            },
        ),
    }
}

/// Runs until every sender is gone and the queue is drained. The [`Disk`] goes with it, and
/// with it the directory's lock.
fn write_loop(mut disk: Disk, mut queue: mpsc::Receiver<Queued>) {
    while let Some(first) = queue.blocking_recv() {
        let mut batch = vec![first];
        while batch.len() < MAX_BATCH {
            match queue.try_recv() {
                Ok(job) => batch.push(job),
                Err(_) => break,
            }
        }
        disk.apply(&batch);
        for (_, done) in batch {
            let _ = done.send(());
        }
    }
}

/// The directory's exclusive lock, on the directory itself so that it adds no file. The kernel
/// releases it however the process ends. A writer that is just finishing gets [`LOCK_WAIT`].
fn claim(dir: &Path) -> io::Result<File> {
    let handle = File::open(dir)?;
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match handle.try_lock() {
            Ok(()) => return Ok(handle),
            Err(TryLockError::Error(e)) => return Err(e),
            Err(TryLockError::WouldBlock) if Instant::now() >= deadline => {
                return Err(io::Error::new(
                    io::ErrorKind::WouldBlock,
                    "another relay holds it",
                ));
            }
            Err(TryLockError::WouldBlock) => std::thread::sleep(LOCK_POLL),
        }
    }
}

/// One revision of an address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Rev {
    created_at: u64,
    id: ns::EventId,
}

impl Rev {
    fn of(event: &ns::Event) -> Self {
        Self {
            created_at: event.created_at.as_secs(),
            id: event.id,
        }
    }

    /// NIP-01: the newer, and on a tie the lower id.
    fn replaces(self, other: Self) -> bool {
        self.created_at > other.created_at
            || (self.created_at == other.created_at && self.id < other.id)
    }
}

/// What the directory holds for one address.
#[derive(Clone, Copy)]
struct Held {
    /// The newest revision, in `<stem>.json`.
    top: Rev,
    /// The rules of this run refused `top` at load. It stays, not served.
    refused: bool,
    /// An older revision accepted while `top` is refused, in `<stem>.fallback`.
    fallback: Option<Rev>,
}

impl Held {
    /// Eviction order: an address with nothing to serve first, then the oldest.
    fn rank(&self, stem: &str) -> (bool, u64, String) {
        let serving = if self.refused {
            self.fallback
        } else {
            Some(self.top)
        };
        (
            serving.is_some(),
            serving.unwrap_or(self.top).created_at,
            stem.to_owned(),
        )
    }
}

/// The directory's index, owned by the writer thread.
struct Disk {
    dir: PathBuf,
    cap: usize,
    /// File stem → what is held for that address.
    held: HashMap<String, Held>,
    /// [`Held::rank`], to find what goes first.
    order: BTreeSet<(bool, u64, String)>,
    /// How many addresses have a fallback file: each counts against `cap`.
    fallbacks: usize,
    deleted: Deleted,
    /// Deletions not yet durably in the file.
    unsaved: bool,
    /// When a failed write of the deletions is next tried, and the wait after that one.
    retry_at: Option<Instant>,
    retry_wait: Duration,
    /// A rename went through but the directory sync after it failed.
    unsynced: bool,
    /// The deletions file exists and could not be read: it is not overwritten this run, since
    /// that would lose what it holds.
    deletions_unread: bool,
    /// Held for as long as this writer lives.
    _lock: File,
}

impl Disk {
    /// Deletions first, so that a manifest in the same batch meets them.
    fn apply(&mut self, batch: &[Queued]) {
        let mut withdrawn: Vec<(&str, u64)> = Vec::new();
        let mut changed = false;
        {
            let mut map = lock(&self.deleted);
            for (job, _) in batch {
                if let Job::Withdraw { addresses, until } = job {
                    for a in addresses {
                        // A replayed deletion changes nothing, and costs no rewrite.
                        if map.get(a).is_none_or(|cutoff| cutoff < until) {
                            map.insert(a.clone(), *until);
                            changed = true;
                        }
                        withdrawn.push((a.as_str(), *until));
                    }
                }
            }
            trim_oldest(&mut map, self.cap);
        }
        self.unsaved |= changed;
        // The record first: a crash before the removal is then undone at the next load. A
        // write that failed earlier is tried again here, whatever this batch holds.
        if self.unsaved && (changed || self.retry_at.is_none_or(|at| Instant::now() >= at)) {
            self.save_deletions();
        }
        if !withdrawn.is_empty() || self.unsynced {
            for (a, until) in withdrawn {
                self.forget(a, until);
            }
            match sync_dir(&self.dir) {
                Ok(()) => self.unsynced = false,
                Err(e) => {
                    self.unsynced = true;
                    warn(&format!("cannot sync the directory: {e}"));
                }
            }
        }
        for (job, _) in batch {
            if let Job::Put(event) = job {
                self.put(event);
            }
        }
    }

    fn put(&mut self, event: &ns::Event) {
        let Some(a) = address(event) else {
            return;
        };
        let rev = Rev::of(event);
        if lock(&self.deleted)
            .get(&a)
            .is_some_and(|until| rev.created_at <= *until)
        {
            return;
        }
        let stem = key(&a);
        let (name, entry) = match self.held.get(&stem).copied() {
            // The revision already here, accepted again: the rules take it now.
            Some(h) if rev == h.top => {
                if h.refused {
                    let entry = Held {
                        refused: false,
                        fallback: None,
                        ..h
                    };
                    self.index(stem.clone(), entry);
                    let _ = fs::remove_file(self.dir.join(fallback_name(&stem)));
                }
                return;
            }
            Some(h) if rev.replaces(h.top) => (
                file_name(&stem),
                Held {
                    top: rev,
                    refused: false,
                    fallback: None,
                },
            ),
            Some(Held { refused: false, .. }) => return,
            // Older than a revision the rules refuse: it is what this run serves, so it is
            // kept beside that one, which still wins once the rules take it.
            Some(h) => {
                if h.fallback.is_some_and(|f| f == rev || f.replaces(rev)) {
                    return;
                }
                let entry = Held {
                    fallback: Some(rev),
                    ..h
                };
                (fallback_name(&stem), entry)
            }
            None => {
                // Full, and older than all it serves: the memory store would not keep it.
                if self.files() >= self.cap
                    && self
                        .order
                        .first()
                        .is_some_and(|(serving, t, _)| *serving && rev.created_at < *t)
                {
                    return;
                }
                (
                    file_name(&stem),
                    Held {
                        top: rev,
                        refused: false,
                        fallback: None,
                    },
                )
            }
        };
        let json = event.as_json();
        if json.len() > MAX_MANIFEST_BYTES {
            return;
        }
        if !self.write_record(&name, &json) {
            return;
        }
        let new_top = entry.top == rev;
        self.index(stem.clone(), entry);
        if new_top {
            // Whatever waited beside the old revision is older than this one.
            let _ = fs::remove_file(self.dir.join(fallback_name(&stem)));
        }
        self.evict();
    }

    /// Whether the new content is in place. Once the rename has happened it is, even if the
    /// directory sync after it failed: the index must then follow the file.
    fn write_record(&mut self, name: &str, json: &str) -> bool {
        match write_atomic(&self.dir, name, json.as_bytes()) {
            Ok(None) => {
                self.unsynced = false;
                true
            }
            Ok(Some(e)) => {
                self.unsynced = true;
                warn(&format!("cannot sync the directory: {e}"));
                true
            }
            Err(e) => {
                warn(&format!("cannot keep a manifest: {e}"));
                false
            }
        }
    }

    fn files(&self) -> usize {
        self.held.len() + self.fallbacks
    }

    fn index(&mut self, stem: String, entry: Held) {
        self.unindex(&stem);
        self.order.insert(entry.rank(&stem));
        self.fallbacks += usize::from(entry.fallback.is_some());
        self.held.insert(stem, entry);
    }

    fn unindex(&mut self, stem: &str) {
        if let Some(old) = self.held.remove(stem) {
            self.order.remove(&old.rank(stem));
            self.fallbacks -= usize::from(old.fallback.is_some());
        }
    }

    /// Past the limit, what goes first by [`Held::rank`] goes, with its files. Returns the
    /// stems removed.
    fn evict(&mut self) -> Vec<String> {
        let mut gone = Vec::new();
        while self.files() > self.cap {
            let Some(stem) = self.order.first().map(|(_, _, stem)| stem.clone()) else {
                break;
            };
            self.unindex(&stem);
            // The fallback first: left alone by a crash, it would take the record's place.
            let _ = fs::remove_file(self.dir.join(fallback_name(&stem)));
            let _ = fs::remove_file(self.dir.join(file_name(&stem)));
            gone.push(stem);
        }
        gone
    }

    fn forget(&mut self, a: &str, until: u64) {
        let stem = key(a);
        let Some(h) = self.held.get(&stem).copied() else {
            return;
        };
        if h.top.created_at <= until {
            self.unindex(&stem);
            // Older than `top`, so withdrawn with it. First: left alone by a crash, it would
            // take the record's place.
            let _ = fs::remove_file(self.dir.join(fallback_name(&stem)));
            match fs::remove_file(self.dir.join(file_name(&stem))) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => {
                    warn(&format!("cannot remove a withdrawn manifest: {e}"));
                }
                _ => {}
            }
        } else if h.fallback.is_some_and(|f| f.created_at <= until) {
            self.index(
                stem.clone(),
                Held {
                    fallback: None,
                    ..h
                },
            );
            let _ = fs::remove_file(self.dir.join(fallback_name(&stem)));
        }
    }

    /// An expired revision leaves its date behind, as a deletion does: otherwise the older
    /// revision it replaced could be re-sent and served in its place. Its file goes once that
    /// is durably on disk; if it cannot be written, the next start tries again.
    fn retire_expired(&mut self, lapsed: &[(String, u64, PathBuf)]) {
        if lapsed.is_empty() {
            return;
        }
        {
            let mut map = lock(&self.deleted);
            for (a, created_at, _) in lapsed {
                let cutoff = map.entry(a.clone()).or_insert(*created_at);
                *cutoff = (*cutoff).max(*created_at);
            }
            trim_oldest(&mut map, self.cap);
        }
        self.unsaved = true;
        if self.save_deletions() {
            for (_, _, path) in lapsed {
                let _ = fs::remove_file(path);
            }
        }
    }

    /// Write the deletions, and on failure set when to try again, waiting twice as long each
    /// time up to [`RETRY_MAX`]. True once they are durably on disk.
    fn save_deletions(&mut self) -> bool {
        let failed = match self.write_deletions() {
            Ok(None) => None,
            // In place but not synced: not yet durable, so it is written again.
            Ok(Some(e)) | Err(e) => Some(e),
        };
        let Some(e) = failed else {
            self.unsaved = false;
            self.retry_at = None;
            self.retry_wait = RETRY_MIN;
            return true;
        };
        warn(&format!("cannot record a deletion: {e}"));
        self.retry_at = Some(Instant::now() + self.retry_wait);
        self.retry_wait = (self.retry_wait * 2).min(RETRY_MAX);
        false
    }

    fn write_deletions(&self) -> io::Result<Option<io::Error>> {
        if self.deletions_unread {
            return Err(io::Error::other(
                "the deletions file could not be read, so it is left as it is",
            ));
        }
        let mut lines: Vec<String> = lock(&self.deleted)
            .iter()
            .map(|(a, until)| serde_json::json!({ "a": a, "until": until }).to_string())
            .collect();
        lines.sort_unstable();
        let mut out = lines.join("\n");
        out.push('\n');
        write_atomic(&self.dir, DELETIONS, out.as_bytes())
    }

    /// Everything stored for one address, its record and any fallback together, so that the
    /// outcome does not depend on the order the directory lists them in.
    fn load_address<F: Fn(&ns::Event) -> bool>(&mut self, stem: &str, scan: &mut Scan<'_, F>) {
        let main = self.dir.join(file_name(stem));
        let spare = self.dir.join(fallback_name(stem));
        match self.check(&main, stem, scan) {
            // Nothing is known about it, so neither file is touched.
            Found::Unreadable => {}
            // A fallback is older than its record, so it ends with it.
            Found::Ended => {
                if fs::remove_file(&spare).is_ok() {
                    scan.reload.withdrawn += 1;
                }
            }
            // The record is lost: a fallback, if there is one, is now the newest there is.
            Found::Lost => {
                let regular = fs::symlink_metadata(&spare).is_ok_and(|m| m.file_type().is_file());
                if regular && fs::rename(&spare, &main).is_ok() {
                    self.load_address(stem, scan);
                }
            }
            Found::Valid(event) => {
                let top = Rev::of(&event);
                let refused = !(scan.admits)(&event);
                let mut fallback = None;
                if refused {
                    if let Found::Valid(older) = self.check(&spare, stem, scan) {
                        if top.replaces(Rev::of(&older)) {
                            fallback = Some(Rev::of(&older));
                            if (scan.admits)(&older) {
                                scan.events.insert(stem.to_owned(), older);
                            }
                        } else {
                            let _ = fs::remove_file(&spare);
                        }
                    }
                } else {
                    let _ = fs::remove_file(&spare);
                    scan.events.insert(stem.to_owned(), event);
                }
                self.index(
                    stem.to_owned(),
                    Held {
                        top,
                        refused,
                        fallback,
                    },
                );
                // Each record seen is valid and settled, so what falls past the limit here
                // is confirmed excess, whatever comes later.
                for gone in self.evict() {
                    scan.events.remove(&gone);
                    scan.reload.excess += 1;
                }
            }
        }
    }

    /// Read one file and apply what no rule can override: damage, a deletion, an expiry.
    fn check<F>(&self, path: &Path, stem: &str, scan: &mut Scan<'_, F>) -> Found {
        let name = path.file_name().unwrap_or_default().display();
        let event = match read_record(path, stem) {
            Ok(event) => event,
            Err(Damage::Gone) => return Found::Lost,
            Err(Damage::Unreadable(why)) => {
                scan.reload.skipped += 1;
                scan.reload.note(format!("{name}: {why}; left in place"));
                return Found::Unreadable;
            }
            Err(Damage::Invalid(why)) => {
                scan.reload.corrupt += 1;
                scan.reload.note(format!("{name}: {why}; removed"));
                let _ = fs::remove_file(path);
                return Found::Lost;
            }
        };
        let created_at = event.created_at.as_secs();
        let withdrawn = address(&event).is_some_and(|a| {
            lock(&self.deleted)
                .get(&a)
                .is_some_and(|until| created_at <= *until)
        });
        if withdrawn {
            scan.reload.withdrawn += 1;
            let _ = fs::remove_file(path);
            return Found::Ended;
        }
        if event.is_expired_at(ns::Timestamp::from_secs(scan.now)) {
            scan.reload.expired += 1;
            if let Some(a) = address(&event) {
                scan.lapsed.push((a, created_at, path.to_owned()));
            }
            return Found::Ended;
        }
        Found::Valid(event)
    }
}

/// A load in progress.
struct Scan<'a, F> {
    admits: &'a F,
    now: u64,
    /// Per address, the revision to serve. Never more than the limit.
    events: HashMap<String, ns::Event>,
    lapsed: Vec<(String, u64, PathBuf)>,
    reload: Reload,
}

enum Found {
    Valid(ns::Event),
    /// Withdrawn or expired: anything older of its address goes too.
    Ended,
    /// Damaged and removed, or not there.
    Lost,
    /// There, and could not be read.
    Unreadable,
}

fn load(
    dir: &Path,
    cap: usize,
    admits: &impl Fn(&ns::Event) -> bool,
) -> io::Result<(Disk, Vec<ns::Event>, Reload)> {
    prepare(dir)?;
    // Before anything is read or removed: a second relay must not act on this directory.
    let dir_lock = claim(dir)?;
    let mut reload = Reload::default();
    let (deleted, deletions_unread) = read_deletions(dir, cap, &mut reload);
    let mut disk = Disk {
        dir: dir.to_owned(),
        cap,
        held: HashMap::new(),
        order: BTreeSet::new(),
        fallbacks: 0,
        deleted: Arc::new(Mutex::new(deleted)),
        unsaved: false,
        retry_at: None,
        retry_wait: RETRY_MIN,
        unsynced: false,
        deletions_unread,
        _lock: dir_lock,
    };
    let mut names = Vec::new();
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else {
            reload.skipped += 1;
            continue;
        };
        let file = entry.file_name();
        // Only names this module writes are touched, or printed.
        let Some(name) = file.to_str() else {
            continue;
        };
        if name.starts_with(TEMP_PREFIX) {
            // Left by a crash mid-write: the rename never happened.
            if entry.file_type().is_ok_and(|t| t.is_file()) {
                let _ = fs::remove_file(entry.path());
            }
        } else if record_stem(name).or_else(|| fallback_stem(name)).is_some() {
            names.push(name.to_owned());
        }
    }
    let mut scan = Scan {
        admits,
        now: unix_now(),
        events: HashMap::new(),
        lapsed: Vec::new(),
        reload,
    };
    for name in &names {
        if let Some(stem) = record_stem(name) {
            disk.load_address(stem, &mut scan);
        } else if let Some(stem) = fallback_stem(name) {
            // Read with its record. Alone, it takes the record's place.
            if fs::symlink_metadata(dir.join(file_name(stem))).is_err() {
                disk.load_address(stem, &mut scan);
            }
        }
    }
    let Scan {
        events,
        lapsed,
        mut reload,
        ..
    } = scan;
    disk.retire_expired(&lapsed);
    let _ = sync_dir(dir);
    if reload.excess > 0 {
        reload.note(format!(
            "{} older records past the limit of {cap}; removed",
            reload.excess
        ));
    }
    reload.deletions = lock(&disk.deleted).len();
    reload.refused = disk.held.values().filter(|h| h.refused).count();
    reload.served = events.len();
    Ok((disk, events.into_values().collect(), reload))
}

enum Damage {
    /// Not there.
    Gone,
    /// Not read, so nothing is known about it: it stays.
    Unreadable(String),
    /// Read, and not a record this relay could have written.
    Invalid(&'static str),
}

fn read_record(path: &Path, stem: &str) -> Result<ns::Event, Damage> {
    let (bytes, over) = match read_capped(path, MAX_MANIFEST_BYTES as u64) {
        Ok(Some(read)) => read,
        Ok(None) => return Err(Damage::Gone),
        Err(e) => return Err(Damage::Unreadable(e.to_string())),
    };
    if over {
        return Err(Damage::Invalid("over the 64 KiB limit"));
    }
    let event = ns::Event::from_json(&bytes).map_err(|_| Damage::Invalid("not a valid event"))?;
    if !(event.verify_id() && event.verify_signature()) {
        return Err(Damage::Invalid("its id or signature does not verify"));
    }
    if event.kind.as_u16() != KIND_MANIFEST {
        return Err(Damage::Invalid("not a manifest"));
    }
    if address(&event).is_none_or(|a| key(&a) != stem) {
        return Err(Damage::Invalid("stored under another address"));
    }
    Ok(event)
}

/// The recorded deletions, each a kind-38504 address, and whether the file was there but could
/// not be read. A date ahead of this clock is kept: the clock may be the one that is wrong, and
/// a deletion fails closed.
fn read_deletions(dir: &Path, cap: usize, reload: &mut Reload) -> (HashMap<String, u64>, bool) {
    let mut map = HashMap::new();
    let (bytes, over) = match read_capped(&dir.join(DELETIONS), MAX_DELETIONS_BYTES) {
        Ok(Some(read)) => read,
        Ok(None) => return (map, false),
        Err(e) => {
            reload.skipped += 1;
            reload.note(format!("{DELETIONS}: {e}; left in place"));
            return (map, true);
        }
    };
    if over {
        reload.note(format!("{DELETIONS}: over its size limit; read up to it"));
    }
    for line in bytes.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
        let parsed = (line.len() <= MAX_DELETION_LINE)
            .then(|| serde_json::from_slice::<serde_json::Value>(line).ok())
            .flatten()
            .and_then(|v| Some((v["a"].as_str()?.to_owned(), v["until"].as_u64()?)))
            .filter(|(a, _)| parse_a_tag(a).is_ok());
        match parsed {
            Some((a, until)) => {
                let cutoff = map.entry(a).or_insert(until);
                *cutoff = (*cutoff).max(until);
            }
            None => reload.bad_deletions += 1,
        }
    }
    if reload.bad_deletions > 0 {
        reload.note(format!(
            "{DELETIONS}: {} damaged lines passed over",
            reload.bad_deletions
        ));
    }
    trim_oldest(&mut map, cap);
    (map, false)
}

/// Past `cap`, the oldest deletions go, as the oldest events do in the memory store.
fn trim_oldest(map: &mut HashMap<String, u64>, cap: usize) {
    if map.len() <= cap {
        return;
    }
    let mut by_age: Vec<(u64, String)> = map.iter().map(|(a, t)| (*t, a.clone())).collect();
    by_age.sort_unstable();
    let excess = map.len() - cap;
    for (_, a) in by_age.into_iter().take(excess) {
        map.remove(&a);
    }
}

/// `38504:<pubkey>:<d>`, as [`nfx_proto::manifest::Manifest::a_tag`] writes it.
fn address(event: &ns::Event) -> Option<String> {
    let d = event.tags.identifier()?;
    Some(format!("{KIND_MANIFEST}:{}:{d}", event.pubkey.to_hex()))
}

/// A file's stem. Hashed, so that nothing a publisher chose ever reaches a path.
fn key(a: &str) -> String {
    hex::encode(nfx_proto::sha256(a.as_bytes()))
}

fn file_name(stem: &str) -> String {
    format!("{stem}.json")
}

fn fallback_name(stem: &str) -> String {
    format!("{stem}{FALLBACK_SUFFIX}")
}

fn record_stem(name: &str) -> Option<&str> {
    hex_stem(name.strip_suffix(".json")?)
}

fn fallback_stem(name: &str) -> Option<&str> {
    hex_stem(name.strip_suffix(FALLBACK_SUFFIX)?)
}

fn hex_stem(stem: &str) -> Option<&str> {
    (stem.len() == 64 && stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .then_some(stem)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One line on stderr at most every [`WARN_EVERY_SECS`]. Never panics on a closed stderr.
fn warn(message: &str) {
    let now = unix_now();
    let last = LAST_WARNED.load(Ordering::Relaxed);
    if now >= last.saturating_add(WARN_EVERY_SECS)
        && LAST_WARNED
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    {
        let _ = writeln!(io::stderr(), "relay store: {message}");
    }
}

/// Create `dir` private, or make it so. A symlink or a file in its place is an error.
fn prepare(dir: &Path) -> io::Result<()> {
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    match builder.create(dir) {
        Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
        _ => {}
    }
    let meta = fs::symlink_metadata(dir)?;
    if !meta.file_type().is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if meta.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// Up to `max` bytes of the regular file at `path`, never following a symlink, and whether
/// there was more. `None` if it does not exist.
fn read_capped(path: &Path, max: u64) -> io::Result<Option<(Vec<u8>, bool)>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ));
    }
    let file = File::open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if meta.permissions().mode() & 0o077 != 0 {
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
    }
    let mut bytes = Vec::new();
    file.take(max.saturating_add(1)).read_to_end(&mut bytes)?;
    let over = bytes.len() as u64 > max;
    bytes.truncate(max as usize);
    Ok(Some((bytes, over)))
}

/// A fresh temp file (created exclusively, 0600), synced, renamed over `name`, and the
/// directory synced: a reader or a crash sees the old file or the whole new one.
///
/// `Err` means `name` is unchanged. `Ok(Some(e))` means it was replaced but the directory sync
/// after the rename failed, so the new content is live and not yet known to be durable.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<Option<io::Error>> {
    let tmp = dir.join(format!(
        "{TEMP_PREFIX}{}-{}",
        std::process::id(),
        TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let placed = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, dir.join(name))
    })();
    if let Err(e) = placed {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(sync_dir(dir).err())
}

#[cfg(test)]
thread_local! {
    /// Makes [`sync_dir`] fail on this thread: no filesystem fails an fsync on request.
    static FAIL_DIR_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(test)]
    if FAIL_DIR_SYNC.get() {
        return Err(io::Error::other("injected directory sync failure"));
    }
    File::open(dir)?.sync_all()
}

#[cfg(all(test, unix))]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::os::unix::fs::PermissionsExt as _;

    use ns::FinalizeEvent as _;

    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nfx-relay-store-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d.join("relay-manifests")
    }

    fn manifest(keys: &ns::Keys, d: &str, at: u64, content: &str) -> ns::Event {
        ns::EventBuilder::new(ns::Kind::from(KIND_MANIFEST), content)
            .tags([ns::Tag::parse(["d", d]).unwrap()])
            .custom_created_at(ns::Timestamp::from_secs(at))
            .finalize(keys)
            .unwrap()
    }

    fn all(_: &ns::Event) -> bool {
        true
    }

    fn records(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter(|e| record_stem(e.as_ref().unwrap().file_name().to_str().unwrap()).is_some())
            .count()
    }

    fn stored(dir: &Path, event: &ns::Event) -> PathBuf {
        dir.join(file_name(&key(&address(event).unwrap())))
    }

    /// The directory is 0700, each file 0600, and a write leaves no temp file. Wider modes
    /// found on an existing directory or file are narrowed at load.
    #[tokio::test]
    async fn the_files_are_private_and_no_temp_file_is_left() {
        let dir = tmp("private");
        let keys = ns::Keys::generate();
        let (store, _, _) = open(&dir, 10, all);
        let store = store.unwrap();
        let event = manifest(&keys, "nfx:testnet:1:private-one", 100, "");
        store.put(&event).await;
        store
            .withdraw(&Deletion {
                author: keys.public_key().to_hex(),
                created_at: 50,
                addresses: vec![
                    nfx_proto::namespace::VideoAddr::parse("nfx:testnet:1:private-two").unwrap(),
                ],
            })
            .await;
        drop(store);
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&stored(&dir, &event)), 0o600);
        assert_eq!(mode(&dir.join(DELETIONS)), 0o600);
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(
            !names.iter().any(|n| n.starts_with(TEMP_PREFIX)),
            "{names:?}"
        );

        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(stored(&dir, &event), fs::Permissions::from_mode(0o644)).unwrap();
        let (_, events, _) = open(&dir, 10, all);
        assert_eq!(events.len(), 1);
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&stored(&dir, &event)), 0o600);
    }

    /// NIP-01 across a restart: the newest stays, an older revision does not replace it, and
    /// on an equal `created_at` the lower id is the one kept, whichever came first.
    #[tokio::test]
    async fn the_newest_revision_wins_and_a_tie_goes_to_the_lowest_id() {
        let dir = tmp("newest");
        let keys = ns::Keys::generate();
        let d = "nfx:testnet:1:newest-one";
        let (older, newer) = (
            manifest(&keys, d, 100, "old"),
            manifest(&keys, d, 200, "new"),
        );
        let (store, _, _) = open(&dir, 10, all);
        let store = store.unwrap();
        store.put(&newer).await;
        store.put(&older).await;
        drop(store);
        let (store, events, _) = open(&dir, 10, all);
        assert_eq!(events.iter().map(|e| e.id).collect::<Vec<_>>(), [newer.id]);
        let store = store.unwrap();
        store.put(&older).await;
        drop(store);
        let (_, events, _) = open(&dir, 10, all);
        assert_eq!(events[0].id, newer.id, "an older copy cannot come back");

        let (x, y) = (manifest(&keys, d, 300, "x"), manifest(&keys, d, 300, "y"));
        let (low, high) = if x.id < y.id { (x, y) } else { (y, x) };
        for (first, second) in [(&high, &low), (&low, &high)] {
            let dir = tmp(if first.id == high.id {
                "tie-a"
            } else {
                "tie-b"
            });
            let (store, _, _) = open(&dir, 10, all);
            let store = store.unwrap();
            store.put(first).await;
            store.put(second).await;
            drop(store);
            let (_, events, _) = open(&dir, 10, all);
            assert_eq!(events[0].id, low.id);
        }
    }

    /// The entry count is capped: past it the oldest go, from disk too, and one older than
    /// everything in a full store is not written.
    #[tokio::test]
    async fn the_entry_count_is_capped_and_the_oldest_go() {
        let dir = tmp("cap");
        let keys = ns::Keys::generate();
        let (store, _, _) = open(&dir, 3, all);
        let store = store.unwrap();
        let events: Vec<ns::Event> = (0..5u64)
            .map(|i| manifest(&keys, &format!("nfx:testnet:1:capped-{i}"), 100 + i, ""))
            .collect();
        for e in &events {
            store.put(e).await;
        }
        store
            .put(&manifest(&keys, "nfx:testnet:1:capped-old", 50, ""))
            .await;
        drop(store);
        assert_eq!(records(&dir), 3);
        let (_, loaded, reload) = open(&dir, 3, all);
        let mut at: Vec<u64> = loaded.iter().map(|e| e.created_at.as_secs()).collect();
        at.sort_unstable();
        assert_eq!(at, [102, 103, 104]);
        assert_eq!(reload.corrupt, 0);
    }

    /// Damage of every kind: the relay still starts, keeps what is valid, says what it did,
    /// and removes only regular files it could read and prove bad.
    #[tokio::test]
    async fn damaged_files_never_stop_a_start() {
        let dir = tmp("damage");
        let keys = ns::Keys::generate();
        let good = manifest(&keys, "nfx:testnet:1:damage-good", 100, "");
        let (store, _, _) = open(&dir, 10, all);
        store.unwrap().put(&good).await;

        let name = |i: u8| dir.join(file_name(&hex::encode([i; 32])));
        fs::write(name(1), b"not json").unwrap();
        // Truncated: the first half of a real record.
        let cut = manifest(&keys, "nfx:testnet:1:damage-cut", 100, "");
        let json = cut.as_json();
        fs::write(stored(&dir, &cut), &json.as_bytes()[..json.len() / 2]).unwrap();
        // Oversized.
        fs::write(name(2), vec![b' '; MAX_MANIFEST_BYTES + 1]).unwrap();
        // A signature that does not verify: another event's, on this one's fields.
        let forged = manifest(&keys, "nfx:testnet:1:damage-forged", 100, "");
        let other = manifest(&keys, "nfx:testnet:1:damage-other", 100, "");
        let mut v: serde_json::Value = serde_json::from_str(&forged.as_json()).unwrap();
        v["sig"] =
            serde_json::from_str::<serde_json::Value>(&other.as_json()).unwrap()["sig"].clone();
        fs::write(stored(&dir, &forged), v.to_string()).unwrap();
        // A valid event under a name that is not its own.
        let moved = manifest(&keys, "nfx:testnet:1:damage-moved", 100, "");
        fs::write(name(3), moved.as_json()).unwrap();
        // A valid event of another kind.
        let note = ns::EventBuilder::new(ns::Kind::from(20464u16), "x")
            .tags([ns::Tag::parse(["d", "nfx:testnet:1:damage-note"]).unwrap()])
            .finalize(&keys)
            .unwrap();
        fs::write(stored(&dir, &note), note.as_json()).unwrap();
        // Not regular files: passed over, untouched. The link's target is valid JSON for an
        // event, so that following it would show.
        fs::create_dir(name(4)).unwrap();
        let target = dir.with_file_name("link-target");
        fs::write(&target, good.as_json()).unwrap();
        std::os::unix::fs::symlink(&target, name(5)).unwrap();
        // Left by a crash mid-write, and a file that is none of this module's.
        fs::write(dir.join(".tmp-1-1"), b"partial").unwrap();
        fs::write(dir.join("README"), b"an operator's note").unwrap();
        fs::write(dir.join(DELETIONS), b"garbage line\n").unwrap();

        let (store, events, reload) = open(&dir, 10, all);
        assert!(store.is_some(), "it starts");
        assert_eq!(events.iter().map(|e| e.id).collect::<Vec<_>>(), [good.id]);
        assert_eq!((reload.served, reload.refused), (1, 0), "{reload:?}");
        assert_eq!(reload.corrupt, 6, "{reload:?}");
        assert_eq!(reload.skipped, 2, "{reload:?}");
        assert_eq!(reload.bad_deletions, 1, "{reload:?}");
        assert!(reload.notes.iter().any(|n| n.contains("removed")));
        assert!(!dir.join(".tmp-1-1").exists(), "the stale temp file goes");
        assert!(dir.join("README").exists(), "not ours: left alone");
        assert!(name(4).is_dir(), "a directory is left alone");
        assert!(
            fs::symlink_metadata(name(5)).is_ok() && target.exists(),
            "a symlink is neither followed nor removed"
        );
        assert!(!name(1).exists() && !name(2).exists() && !name(3).exists());
    }

    /// A recorded deletion outlives the restart. A line that is no manifest's address is passed
    /// over; one dated ahead of this clock is kept, since the clock may be what is wrong.
    #[tokio::test]
    async fn recorded_deletions_are_checked_on_load() {
        let dir = tmp("deletions");
        fs::create_dir_all(&dir).unwrap();
        let keys = ns::Keys::generate();
        let a = |id: &str| format!("38504:{}:nfx:testnet:1:{id}", keys.public_key().to_hex());
        let now = unix_now();
        let lines = [
            serde_json::json!({"a": a("deleted-one"), "until": now - 10}).to_string(),
            serde_json::json!({"a": a("clock-behind"), "until": now + 3600}).to_string(),
            serde_json::json!({"a": "1:nope:nothing", "until": 5}).to_string(),
            "not json".to_owned(),
        ];
        fs::write(dir.join(DELETIONS), lines.join("\n")).unwrap();
        let (store, _, reload) = open(&dir, 10, all);
        let store = store.unwrap();
        assert_eq!((reload.deletions, reload.bad_deletions), (2, 2));
        assert!(store.withdrawn(&a("deleted-one"), now - 10));
        assert!(!store.withdrawn(&a("deleted-one"), now - 9), "a later one");
        assert!(store.withdrawn(&a("clock-behind"), now));
    }

    /// A deletions file that is there but cannot be read is not overwritten: a new deletion
    /// is honoured for this run, and what the file holds is not lost.
    #[tokio::test]
    async fn an_unreadable_deletions_file_is_left_alone() {
        let dir = tmp("deletions-unread");
        fs::create_dir_all(dir.join(DELETIONS)).unwrap();
        let keys = ns::Keys::generate();
        let d = "nfx:testnet:1:unread-one";
        let event = manifest(&keys, d, 100, "");
        let (store, _, reload) = open(&dir, 10, all);
        assert_eq!(reload.skipped, 1, "{reload:?}");
        let store = store.unwrap();
        store.put(&event).await;
        store
            .withdraw(&Deletion {
                author: keys.public_key().to_hex(),
                created_at: 150,
                addresses: vec![nfx_proto::namespace::VideoAddr::parse(d).unwrap()],
            })
            .await;
        assert!(store.withdrawn(&address(&event).unwrap(), 100));
        assert!(!stored(&dir, &event).exists(), "the manifest still goes");
        assert!(dir.join(DELETIONS).is_dir(), "not replaced");
    }

    /// A deletion removes the withdrawn file, and a crash between the record and the removal
    /// cannot bring it back: the next load finishes the removal.
    #[tokio::test]
    async fn a_deletion_removes_the_file_and_survives_a_crash_before_the_removal() {
        let dir = tmp("withdraw");
        let keys = ns::Keys::generate();
        let d = "nfx:testnet:1:withdraw-one";
        let event = manifest(&keys, d, 100, "");
        let (store, _, _) = open(&dir, 10, all);
        let store = store.unwrap();
        store.put(&event).await;
        let deletion = Deletion {
            author: keys.public_key().to_hex(),
            created_at: 150,
            addresses: vec![nfx_proto::namespace::VideoAddr::parse(d).unwrap()],
        };
        store.withdraw(&deletion).await;
        assert!(!stored(&dir, &event).exists());
        // As if the process died after writing the record and before the unlink.
        fs::write(stored(&dir, &event), event.as_json()).unwrap();
        drop(store);
        let (store, events, reload) = open(&dir, 10, all);
        assert!(events.is_empty());
        assert_eq!(reload.withdrawn, 1);
        assert!(!stored(&dir, &event).exists());
        // The cutoff stands: the same revision is not written again, a later one is.
        let store = store.unwrap();
        store.put(&event).await;
        assert!(!stored(&dir, &event).exists());
        let later = manifest(&keys, d, 151, "");
        store.put(&later).await;
        assert!(stored(&dir, &later).exists());
    }

    /// A path that cannot be a directory leaves the relay running in memory, and says so.
    #[test]
    fn an_unusable_directory_is_reported_not_fatal() {
        let dir = tmp("unusable");
        fs::write(&dir, b"a file where the directory should be").unwrap();
        let (store, events, reload) = open(&dir, 10, all);
        assert!(store.is_none() && events.is_empty());
        assert!(reload.off.is_some());
        assert!(reload.to_string().contains("in memory only"));

        // A symlink to a directory is refused rather than followed.
        let real = tmp("unusable-real");
        fs::create_dir_all(&real).unwrap();
        let link = tmp("unusable-link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (store, _, reload) = open(&link, 10, all);
        assert!(store.is_none() && reload.off.is_some());
    }

    /// Only kind 38504 reaches the disk, whatever is handed to it.
    #[tokio::test]
    async fn only_manifests_are_written() {
        let dir = tmp("kinds");
        let keys = ns::Keys::generate();
        let (store, _, _) = open(&dir, 10, all);
        let store = store.unwrap();
        for kind in [20464u16, 25050, 33478, 5, 1] {
            let e = ns::EventBuilder::new(ns::Kind::from(kind), "not for the disk")
                .tags([ns::Tag::parse(["d", "nfx:testnet:1:other-kind"]).unwrap()])
                .finalize(&keys)
                .unwrap();
            store.put(&e).await;
        }
        drop(store);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    fn queued(job: Job) -> Queued {
        (job, oneshot::channel().0)
    }

    fn put_job(event: &ns::Event) -> Queued {
        queued(Job::Put(Box::new(event.clone())))
    }

    fn withdraw_job(event: &ns::Event, until: u64) -> Queued {
        queued(Job::Withdraw {
            addresses: vec![address(event).unwrap()],
            until,
        })
    }

    fn spare(dir: &Path, event: &ns::Event) -> PathBuf {
        dir.join(fallback_name(&key(&address(event).unwrap())))
    }

    fn created(events: &[ns::Event]) -> Vec<u64> {
        let mut at: Vec<u64> = events.iter().map(|e| e.created_at.as_secs()).collect();
        at.sort_unstable();
        at
    }

    /// A second open neither loads nor writes: it reports why and the relay runs in memory.
    /// Once the holder's writer has exited, the directory opens normally.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_second_relay_on_the_directory_is_refused_and_keeps_running() {
        let dir = tmp("lock");
        let keys = ns::Keys::generate();
        let event = manifest(&keys, "nfx:testnet:1:locked-one", 100, "");
        let (first, _, reload) = open(&dir, 10, all);
        assert_eq!(reload.off, None);
        let first = first.unwrap();
        first.put(&event).await;
        // A temp file the holder could be writing: a load would sweep it.
        let in_flight = dir.join(".tmp-held-1");
        fs::write(&in_flight, b"partial").unwrap();

        let (dir2, in_flight2) = (dir.clone(), in_flight.clone());
        let (second, events, reload) = tokio::task::spawn_blocking(move || open(&dir2, 10, all))
            .await
            .unwrap();
        assert!(second.is_none() && events.is_empty(), "no second writer");
        let why = reload.to_string();
        assert!(
            why.contains("in memory only") && why.contains("holds it"),
            "{why}"
        );
        assert!(in_flight2.exists(), "it touched nothing");

        first.close();
        let (third, events, reload) = tokio::task::spawn_blocking(move || open(&dir, 10, all))
            .await
            .unwrap();
        assert_eq!(reload.off, None);
        assert!(third.is_some());
        assert_eq!(events.iter().map(|e| e.id).collect::<Vec<_>>(), [event.id]);
    }

    /// A cutoff whose write failed is retried by a later put-only batch, not before its
    /// backoff is due, and the backoff stops growing at its limit.
    #[test]
    fn a_failed_cutoff_write_is_retried_by_a_later_put_with_bounded_backoff() {
        let dir = tmp("retry");
        let keys = ns::Keys::generate();
        let gone = manifest(&keys, "nfx:testnet:1:retry-gone", 100, "");
        let other = manifest(&keys, "nfx:testnet:1:retry-other", 100, "");
        let third = manifest(&keys, "nfx:testnet:1:retry-third", 100, "");
        let (mut disk, _, _) = load(&dir, 10, &all).unwrap();
        // A directory in the way makes the rename fail.
        fs::create_dir(dir.join(DELETIONS)).unwrap();
        disk.apply(&[withdraw_job(&gone, 150)]);
        assert!(disk.unsaved && disk.retry_at.is_some());
        fs::remove_dir(dir.join(DELETIONS)).unwrap();

        disk.retry_at = Some(Instant::now() + Duration::from_secs(3600));
        disk.apply(&[put_job(&other)]);
        assert!(disk.unsaved && !dir.join(DELETIONS).exists(), "not due yet");

        disk.retry_at = Some(Instant::now());
        disk.apply(&[put_job(&third)]);
        assert!(!disk.unsaved && disk.retry_at.is_none());
        assert_eq!(disk.retry_wait, RETRY_MIN);
        drop(disk);
        let (disk, _, reload) = load(&dir, 10, &all).unwrap();
        assert_eq!(reload.deletions, 1, "the cutoff survives a restart");
        assert_eq!(
            lock(&disk.deleted).get(&address(&gone).unwrap()),
            Some(&150)
        );

        let mut disk = disk;
        fs::remove_file(dir.join(DELETIONS)).unwrap();
        fs::create_dir(dir.join(DELETIONS)).unwrap();
        disk.unsaved = true;
        for _ in 0..16 {
            assert!(!disk.save_deletions());
        }
        assert_eq!(disk.retry_wait, RETRY_MAX);
    }

    /// A failed directory sync comes after the rename, so the index follows the file: a later
    /// deletion of the old revision's date leaves the new revision alone.
    #[test]
    fn the_index_follows_a_rename_whose_directory_sync_failed() {
        let dir = tmp("sync");
        let keys = ns::Keys::generate();
        let d = "nfx:testnet:1:sync-one";
        let (old, new) = (
            manifest(&keys, d, 100, "old"),
            manifest(&keys, d, 200, "new"),
        );
        let (mut disk, _, _) = load(&dir, 10, &all).unwrap();
        disk.put(&old);
        FAIL_DIR_SYNC.set(true);
        disk.put(&new);
        FAIL_DIR_SYNC.set(false);
        assert!(disk.unsynced);
        assert_eq!(disk.held[&key(&address(&new).unwrap())].top, Rev::of(&new));

        disk.apply(&[withdraw_job(&old, 150)]);
        assert!(!disk.unsynced, "the next batch syncs it");
        assert!(stored(&dir, &new).exists(), "the newer revision survives");
        drop(disk);
        let (_, events, _) = load(&dir, 10, &all).unwrap();
        assert_eq!(events.iter().map(|e| e.id).collect::<Vec<_>>(), [new.id]);
    }

    /// Over the limit after an interrupted write, a load keeps the newest whatever order the
    /// directory lists them in, removes only the valid excess, and leaves unreadable files.
    #[test]
    fn a_reload_over_the_limit_keeps_the_newest() {
        let dir = tmp("over");
        fs::create_dir_all(&dir).unwrap();
        let keys = ns::Keys::generate();
        for i in 0..12u64 {
            let e = manifest(&keys, &format!("nfx:testnet:1:over-{i}"), 100 + i, "");
            fs::write(stored(&dir, &e), e.as_json()).unwrap();
        }
        let unreadable = dir.join(file_name(&hex::encode([9u8; 32])));
        fs::create_dir(&unreadable).unwrap();

        let (_, events, reload) = open(&dir, 3, all);
        assert_eq!(created(&events), [109, 110, 111]);
        assert_eq!((reload.excess, reload.skipped), (9, 1), "{reload:?}");
        assert_eq!(records(&dir), 4, "three records and the unreadable entry");
        assert!(unreadable.is_dir());
    }

    /// A fallback whose record was lost takes its place. One that is not a regular file is
    /// neither moved nor removed.
    #[test]
    fn a_lone_fallback_takes_the_place_of_a_lost_record() {
        let dir = tmp("lone");
        fs::create_dir_all(&dir).unwrap();
        let keys = ns::Keys::generate();
        let lone = manifest(&keys, "nfx:testnet:1:lone-one", 100, "");
        fs::write(spare(&dir, &lone), lone.as_json()).unwrap();
        let odd = manifest(&keys, "nfx:testnet:1:lone-odd", 100, "");
        fs::create_dir(spare(&dir, &odd)).unwrap();

        let (_, events, _) = open(&dir, 10, all);
        assert_eq!(events.iter().map(|e| e.id).collect::<Vec<_>>(), [lone.id]);
        assert!(stored(&dir, &lone).exists() && !spare(&dir, &lone).exists());
        assert!(spare(&dir, &odd).is_dir() && !stored(&dir, &odd).exists());
    }

    /// A stored revision the rules refuse does not stop an older accepted one from being kept.
    /// The refused file stays, and wins as soon as the rules take it.
    #[tokio::test]
    async fn a_refused_revision_does_not_block_an_older_accepted_one() {
        let dir = tmp("refused");
        let keys = ns::Keys::generate();
        let d = "nfx:testnet:1:refused-one";
        let (older, newer) = (
            manifest(&keys, d, 100, "old"),
            manifest(&keys, d, 200, "new"),
        );
        let behind = |e: &ns::Event| e.created_at.as_secs() <= 150;
        let (store, _, _) = open(&dir, 10, all);
        let store = store.unwrap();
        store.put(&newer).await;
        drop(store);

        let (store, events, reload) = open(&dir, 10, behind);
        assert!(events.is_empty());
        assert_eq!(reload.refused, 1);
        let store = store.unwrap();
        store.put(&older).await;
        drop(store);

        let (store, events, reload) = open(&dir, 10, behind);
        assert_eq!(created(&events), [100], "the older one survives a restart");
        assert_eq!((reload.served, reload.refused), (1, 1));
        assert!(stored(&dir, &newer).exists(), "the refused file stays");
        drop(store);

        let (_, events, _) = open(&dir, 10, all);
        assert_eq!(
            created(&events),
            [200],
            "the newest wins once it is admitted"
        );
        assert!(!spare(&dir, &older).exists(), "the older copy is spent");
    }

    /// Nothing the store let go of comes back when the clock catches up: a deletion or a newer
    /// revision that arrived while one was refused still holds.
    #[tokio::test]
    async fn a_refused_revision_cannot_undo_a_deletion_or_a_replacement() {
        let keys = ns::Keys::generate();
        let d = "nfx:testnet:1:refused-two";
        let (older, newer) = (
            manifest(&keys, d, 100, "old"),
            manifest(&keys, d, 200, "new"),
        );
        let behind = |e: &ns::Event| e.created_at.as_secs() <= 150;
        let parked = |name: &'static str| {
            let dir = tmp(name);
            let (older, newer) = (older.clone(), newer.clone());
            async move {
                let (store, _, _) = open(&dir, 10, all);
                store.unwrap().put(&newer).await;
                let (store, _, _) = open(&dir, 10, behind);
                let store = store.unwrap();
                store.put(&older).await;
                assert!(spare(&dir, &older).exists());
                (dir, store)
            }
        };
        let deletion = |until: u64| Deletion {
            author: keys.public_key().to_hex(),
            created_at: until,
            addresses: vec![nfx_proto::namespace::VideoAddr::parse(d).unwrap()],
        };

        // A deletion past both ends both.
        let (dir, store) = parked("refused-del-all").await;
        store.withdraw(&deletion(250)).await;
        drop(store);
        let (_, events, reload) = open(&dir, 10, all);
        assert!(events.is_empty(), "{reload:?}");
        assert!(!stored(&dir, &newer).exists() && !spare(&dir, &older).exists());

        // A deletion between them ends the older; the refused one is newer than it and stays.
        let (dir, store) = parked("refused-del-old").await;
        store.withdraw(&deletion(150)).await;
        assert!(!spare(&dir, &older).exists());
        drop(store);
        let (store, events, _) = open(&dir, 10, behind);
        assert!(events.is_empty(), "the withdrawn fallback is not served");
        drop(store);
        let (_, events, _) = open(&dir, 10, all);
        assert_eq!(created(&events), [200]);

        // A newer accepted revision replaces both: neither can return under any rule.
        let (dir, store) = parked("refused-replaced").await;
        let newest = manifest(&keys, d, 300, "newest");
        store.put(&newest).await;
        drop(store);
        assert!(!spare(&dir, &older).exists());
        let (store, events, reload) = open(&dir, 10, |e| e.created_at.as_secs() <= 250);
        assert!(events.is_empty(), "no older copy stands in: {reload:?}");
        drop(store);
        let (_, events, _) = open(&dir, 10, all);
        assert_eq!(created(&events), [300]);
    }
}
