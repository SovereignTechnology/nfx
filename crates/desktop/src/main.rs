//! The NFX desktop viewer (ADR 0008): `nfxd`'s [`Daemon`] behind a Tauri 2 window.
//!
//! - **Resolve and fetch**: a manifest address (`a` tag) is resolved over the configured
//!   scoped relays; seeders come from verified beacons; bytes arrive over iroh and are
//!   re-anchored to sha256 before they are stored (NFX-05 §4, NFX-06 §2).
//! - **Play**: the page's hls.js reads `nfx://localhost/<root>/…` (Windows and Android:
//!   `http://nfx.localhost/…`), served by the daemon's internal origin. The origin
//!   re-verifies every file on read and pulls misses from the swarm, so playback starts
//!   before the whole video is here.
//! - **Keep and seed what is watched** (NFX-18, decision record 0110): with "Seed videos I
//!   watch" on, the default, a video played for a minute ([`KEEP_AFTER`]) is fetched whole
//!   and seeded while the app runs, and again after a restart (`kept.json`). Seeding
//!   announces each kept video publicly, signed with this node's key and with this
//!   computer's public address, so the page says so once, and nothing is kept before the
//!   user has answered it. The switch stops all announcing at once; kept files stay. No
//!   address that is not public is ever announced (`public_addrs_only`), and the router is
//!   never asked to open a port. Videos are fetched from an iroh endpoint with a fresh key
//!   that serves nothing, never the one beacons name (NFX-18 §4: nfxd's `keep_on_request`
//!   does that). Kept videos share a disk cap (20 GiB unless set): the least recently
//!   watched make room, never the one playing. A play that ends before the minute keeps
//!   nothing: its files go when the next play starts, or at the next start.
//! - **History**: what was watched, when, and where playback was, in `history.json` (at most
//!   [`keep::MAX_HISTORY`] videos), shown with each one's kept and seeding state. Removing a
//!   video from it deletes this computer's copy too. It never leaves this computer.
//! - **Seeder ratings, if you choose to** (NFX-16, read-only): with the user's npub and at
//!   least one general relay set, the node reads the user's follow and mute lists and the
//!   ratings of those they follow, and tries well-rated seeders first. Ratings only order
//!   pulls; they never exclude a seeder, and the app publishes nothing. Reading one's own
//!   lists tells those relays that this computer's address goes with that key, so it is
//!   **off by default**. Keys are taken as npubs only: 64 hex digits would let a pasted
//!   secret key pass for a public one.
//!
//! State lives in the app data directory: `node.key` (the node's Nostr key, mode 0600,
//! never printed), `settings.json` (relays, sharing, the notice, the cap, ratings),
//! `kept.json`, `history.json`, and `store/` (content by sha256).
//!
//! Test mode (`NFX_DESKTOP_TEST` = `{"a", "relays", "iroh_relays", "share", "keep_after_s",
//! "rating_root", "general_relays"}` JSON, optional `NFX_DESKTOP_DATA` = data directory):
//! the page plays that address by itself, reports each step on stdout as JSON lines and
//! exits with `RESULT PASS|FAIL`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http_body_util::BodyExt as _;
use nfxd::daemon::{Config, Daemon, VideoState};
use nfxd::keep::{self, Budget, FsStore, History, Kept, KeptVideo};
use nfxd::key;
use serde::{Deserialize, Serialize};
use tauri::http::{Method, Response, StatusCode};
use tauri::{Manager, State};
use tokio::sync::{Mutex, RwLock};

/// How long a watch waits for a seeder (beacons republish every 60 s, NFX-03 §3).
const WATCH_TIMEOUT: Duration = Duration::from_secs(150);
/// Seconds of a video played before it is kept (NFX-18 §2.1).
const KEEP_AFTER: f64 = 60.0;
/// The settings file's format. A file without it is from before keeping, when sharing was
/// opt-in.
const SETTINGS_VERSION: u32 = 1;
const DEFAULT_CAP_GIB: u64 = keep::DEFAULT_CAP / keep::GIB;
/// The largest disk cap the page takes, in GiB.
const MAX_CAP_GIB: u64 = 1 << 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    /// [`SETTINGS_VERSION`] once written by a build that keeps.
    #[serde(default)]
    version: u32,
    /// Nostr scoped relays (NFX-04), `ws://` or `wss://`.
    relays: Vec<String>,
    /// The network's iroh relays (NFX-06 §1).
    iroh_relays: Vec<String>,
    /// Keep and seed what is watched (see the module docs). On unless the user turns it off.
    #[serde(default = "yes")]
    share: bool,
    /// The user has answered the notice of what seeding makes public (NFX-18 §6). Nothing
    /// is kept before.
    #[serde(default)]
    keep_notice_seen: bool,
    /// Disk space kept videos may take, in GiB.
    #[serde(default = "default_cap_gib")]
    cap_gib: u64,
    /// Seeder ratings (NFX-16): the user's key, as 64 hex digits. Unset: ratings are off.
    #[serde(default)]
    rating_root: Option<String>,
    /// More authors whose ratings count, as 64 hex digits.
    #[serde(default)]
    rating_trusted: Vec<String>,
    /// General Nostr relays the user's lists and the ratings are read from.
    #[serde(default)]
    general_relays: Vec<String>,
}

fn yes() -> bool {
    true
}

fn default_cap_gib() -> u64 {
    DEFAULT_CAP_GIB
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            relays: Vec::new(),
            iroh_relays: Vec::new(),
            share: true,
            keep_notice_seen: false,
            cap_gib: DEFAULT_CAP_GIB,
            rating_root: None,
            rating_trusted: Vec::new(),
            general_relays: Vec::new(),
        }
    }
}

impl Settings {
    /// Settings as read from a file. One written before keeping turns sharing on, whatever
    /// it said (off was only that build's default, and a user who chose it then could not
    /// be told apart), and shows the notice; one written since keeps the user's choice.
    fn upgraded(mut self) -> Self {
        if self.version < SETTINGS_VERSION {
            self.version = SETTINGS_VERSION;
            self.share = true;
            self.keep_notice_seen = false;
        }
        self
    }

    fn cap(&self) -> u64 {
        self.cap_gib.saturating_mul(keep::GIB)
    }

    /// Whether kept videos are seeded: sharing is on and the user has been told.
    fn seeding(&self) -> bool {
        self.share && self.keep_notice_seen
    }
}

/// The settings as the page sends them.
#[derive(Debug, Clone, Deserialize)]
struct SettingsForm {
    relays: Vec<String>,
    iroh_relays: Vec<String>,
    share: bool,
    cap_gib: u64,
    /// An npub, or empty.
    rating_root: String,
    rating_trusted: Vec<String>,
    general_relays: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct TestConfig {
    a: String,
    relays: Vec<String>,
    #[serde(default)]
    iroh_relays: Vec<String>,
    #[serde(default)]
    share: bool,
    /// Seconds played before a video is kept, in place of [`KEEP_AFTER`]: the e2e's clip is
    /// shorter than a minute.
    #[serde(default)]
    keep_after_s: Option<f64>,
    /// An npub, or empty.
    #[serde(default)]
    rating_root: String,
    #[serde(default)]
    general_relays: Vec<String>,
}

/// The video playing, from its watch until the next one.
#[derive(Debug, Clone)]
struct Play {
    a: String,
    root: String,
    title: String,
    /// Whether keeping it is settled: it was kept already, or its minute has played.
    decided: bool,
    /// Why it was not kept, once that is settled.
    not_kept: Option<String>,
}

/// What is kept and what was watched.
struct Library {
    kept: Kept,
    history: History,
    budget: Budget,
    play: Option<Play>,
    /// `kept.json` could not be read at start, so the store is not swept this run: its
    /// files may be videos that file kept.
    kept_unreadable: bool,
}

impl Library {
    /// The roots whose files stay: every kept video's, and the one playing.
    fn protected_roots(&self) -> Vec<&str> {
        let mut roots = self.kept.roots();
        roots.extend(self.play.as_ref().map(|p| p.root.as_str()));
        roots
    }

    fn save_kept(&self, dir: &Path) {
        logged("kept.json", self.kept.save(&dir.join("kept.json")));
    }

    fn save_history(&self, dir: &Path) {
        logged("history.json", self.history.save(&dir.join("history.json")));
    }
}

struct AppState {
    dir: PathBuf,
    pubkey: String,
    /// Held as `Arc` so a call (a watch can take 150 s) never holds the lock while it waits.
    daemon: RwLock<Option<Arc<Daemon>>>,
    settings: RwLock<Settings>,
    /// Taken after `daemon` and `settings` when a call needs them too, never before.
    library: Mutex<Library>,
    /// Seconds played before a video is kept.
    keep_after: f64,
    test: Option<TestConfig>,
}

impl AppState {
    fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    fn store_dir(&self) -> PathBuf {
        self.dir.join("store")
    }

    fn store(&self) -> Result<FsStore, String> {
        FsStore::open(self.store_dir()).map_err(|e| e.to_string())
    }

    /// A node for `settings`. While kept videos are seeded, each is seeded from the store
    /// as it is, or fetched first if it is not whole (the app closed while it was).
    async fn start(&self, settings: &Settings, kept: &[KeptVideo]) -> Result<Arc<Daemon>, String> {
        let keys = key::load(&self.dir.join("node.key")).map_err(|e| e.to_string())?;
        let iroh_relays = parse_iroh_relays(settings)?;
        let store = self.store()?;
        let (mut seed, mut fetch) = (Vec::new(), Vec::new());
        if settings.seeding() {
            for v in kept
                .iter()
                .filter(|v| nfx_proto::beacon::parse_a_tag(&v.a).is_ok())
            {
                if keep::is_whole(&store, &v.root) {
                    seed.push(v.a.clone());
                } else {
                    fetch.push(v.a.clone());
                }
            }
        }
        Daemon::start(Config {
            keys: Some(keys),
            store: self.store_dir(),
            relays: settings.relays.clone(),
            iroh_relays,
            internal_origin: true,
            seed,
            fetch,
            // A watch only keeps when this app says so (`keep_playing`).
            seed_watched: settings.share,
            keep_on_request: true,
            // Neither watching nor keeping needs an inbound port, and what is announced
            // must not map the user's home network (NFX-18 §4).
            no_portmapper: true,
            public_addrs_only: true,
            rating_root: settings.rating_root.clone(),
            rating_trusted: settings.rating_trusted.clone(),
            general_relays: settings.general_relays.clone(),
            ..Config::default()
        })
        .await
        .map(Arc::new)
        .map_err(|e| e.to_string())
    }

    /// Start the node, then clear the store of what earlier plays left behind. The node's
    /// blobs database is open by then, so no other instance of the app uses this store.
    async fn boot(&self, settings: &Settings) -> Result<(), String> {
        if settings.relays.is_empty() {
            return Ok(());
        }
        let kept = self.library.lock().await.kept.videos().to_vec();
        let daemon = self.start(settings, &kept).await?;
        *self.daemon.write().await = Some(daemon);
        let lib = self.library.lock().await;
        if !lib.kept_unreadable {
            let store = self.store()?;
            match keep::sweep(&store, &lib.kept.roots()) {
                Ok(0) => {}
                Ok(n) => nfxd::status!("nfx-desktop: deleted {n} files no kept video uses"),
                Err(e) => nfxd::status!("nfx-desktop: sweeping the store: {e}"),
            }
        }
        Ok(())
    }

    /// Restart the node with `new` and save it. A bad setting leaves the old node running.
    async fn apply(&self, new: Settings) -> Result<(), String> {
        // Both nodes would open one store; stop the old one first. `shutdown` releases the
        // store even while a pending watch still holds the old daemon.
        let mut daemon = self.daemon.write().await;
        if let Some(old) = daemon.take() {
            old.shutdown().await;
        }
        let kept = self.library.lock().await.kept.videos().to_vec();
        let started = match self.start(&new, &kept).await {
            Ok(d) => {
                *daemon = Some(d);
                Ok(())
            }
            Err(e) => {
                // Back to the old settings rather than no node at all.
                let old = self.settings.read().await.clone();
                *daemon = self.start(&old, &kept).await.ok();
                Err(e)
            }
        };
        let current = (*daemon).clone();
        drop(daemon);
        // The video playing goes on from whichever node runs now.
        if let Some(d) = current.clone() {
            let playing = self.library.lock().await.play.as_ref().map(|p| p.a.clone());
            if let Some(a) = playing {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = d.watch(&a, WATCH_TIMEOUT).await {
                        nfxd::status!("nfx-desktop: watching again after a restart: {e}");
                    }
                });
            }
        }
        started?;
        let json = serde_json::to_vec_pretty(&new).map_err(|e| e.to_string())?;
        keep::write_atomic(&self.settings_path(), &json).map_err(|e| e.to_string())?;
        *self.settings.write().await = new.clone();

        let store = self.store()?;
        let mut guard = self.library.lock().await;
        let lib = &mut *guard;
        // A lower cap: the least recently watched make room.
        let protect: Vec<String> = lib.play.iter().map(|p| p.a.clone()).collect();
        let protect: Vec<&str> = protect.iter().map(String::as_str).collect();
        let (evict, _) = lib.kept.to_evict(new.cap(), None, &protect);
        drop_kept(lib, current.as_deref(), &store, &self.dir, evict).await;
        Ok(())
    }

    /// The running daemon, without holding the lock.
    async fn daemon(&self) -> Option<Arc<Daemon>> {
        self.daemon.read().await.clone()
    }

    /// NFX-05 §6 through the daemon's origin: verified bytes, misses pulled from the swarm.
    async fn serve(&self, method: &Method, path: &str) -> Response<Vec<u8>> {
        let origin = self.daemon().await.and_then(|d| d.origin());
        let Some(origin) = origin else {
            return plain(StatusCode::SERVICE_UNAVAILABLE, "no node running");
        };
        let (parts, body) = origin.respond(method, path).await.into_parts();
        let bytes = body
            .collect()
            .await
            .map(|c| c.to_bytes().to_vec())
            .unwrap_or_default();
        Response::from_parts(parts, bytes)
    }
}

fn logged<E: std::fmt::Display>(what: &str, r: Result<(), E>) {
    if let Err(e) = r {
        nfxd::status!("nfx-desktop: {what}: {e}");
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Let go of the video `a` (root `root`) and delete its files, but for those a kept video or
/// the one playing uses.
async fn drop_video(lib: &Library, daemon: Option<&Daemon>, store: &FsStore, a: &str, root: &str) {
    if let Some(d) = daemon {
        logged("releasing a video", d.release(a, root).await);
    }
    let spare: Vec<&str> = lib
        .protected_roots()
        .into_iter()
        .filter(|r| *r != root)
        .collect();
    keep::delete_video(store, root, &spare);
}

/// Stop keeping `evict` and delete their files.
async fn drop_kept(
    lib: &mut Library,
    daemon: Option<&Daemon>,
    store: &FsStore,
    dir: &Path,
    evict: Vec<KeptVideo>,
) {
    if evict.is_empty() {
        return;
    }
    for v in &evict {
        lib.kept.remove(&v.a);
    }
    lib.save_kept(dir);
    for v in evict {
        drop_video(lib, daemon, store, &v.a, &v.root).await;
    }
}

/// The play ended. Unless its video is kept, the node lets it go and its files are
/// deleted: a play shorter than the minute keeps nothing (NFX-18 §2.1).
async fn end_play(lib: &mut Library, daemon: Option<&Daemon>, store: &FsStore) {
    let Some(play) = lib.play.take() else {
        return;
    };
    if !lib.kept.contains(&play.a) {
        drop_video(lib, daemon, store, &play.a, &play.root).await;
    }
}

/// Keep the video playing, now that its minute has played: fetch it whole and seed it,
/// within the cap and the hour's budget (NFX-18 §2.4). Why not, when it is not kept.
async fn keep_playing(
    lib: &mut Library,
    daemon: Option<&Daemon>,
    settings: &Settings,
    store: &FsStore,
    dir: &Path,
) -> Option<String> {
    let play = lib.play.clone()?;
    if lib.kept.contains(&play.a) {
        return None;
    }
    if !settings.share {
        return Some("sharing is off".into());
    }
    if !settings.keep_notice_seen {
        return Some("the notice about sharing is not answered yet".into());
    }
    let Some(daemon) = daemon else {
        return Some("no node running".into());
    };
    let Some((_, size)) = keep::video_files(store, &play.root) else {
        return Some("its hash list is not here".into());
    };
    let (evict, fits) = lib
        .kept
        .to_evict(settings.cap(), Some(size), &[play.a.as_str()]);
    if !fits {
        return Some(format!(
            "it takes {:.1} GiB, more than the space set for kept videos",
            size as f64 / keep::GIB as f64
        ));
    }
    let now = unix_now();
    if !lib.budget.allows(now, size) {
        return Some(format!(
            "this hour's budget for keeping is spent ({} videos, {} GiB)",
            keep::BUDGET_VIDEOS,
            keep::BUDGET_BYTES / keep::GIB
        ));
    }
    if let Err(e) = daemon.keep(&play.a) {
        return Some(e.to_string());
    }
    lib.budget.spend(now, size);
    lib.kept.insert(KeptVideo {
        a: play.a,
        root: play.root,
        title: play.title,
        size,
        kept_at: now,
        last_watched: now,
    });
    drop_kept(lib, Some(daemon), store, dir, evict).await;
    lib.save_kept(dir);
    None
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    let mut r = Response::new(text.as_bytes().to_vec());
    *r.status_mut() = status;
    r
}

fn relay_ok(u: &str) -> bool {
    u.starts_with("wss://") || u.starts_with("ws://")
}

fn parse_iroh_relays(settings: &Settings) -> Result<Vec<iroh::RelayUrl>, String> {
    settings
        .iroh_relays
        .iter()
        .map(|u| u.parse().map_err(|_| format!("not an iroh relay URL: {u}")))
        .collect()
}

/// A key typed into the page, as 64 hex digits. Only an npub is taken (a `nostr:` prefix
/// is fine): bare hex would let a pasted secret key pass for a public one. The refusal
/// never repeats the input.
fn npub_hex(what: &str, v: &str) -> Result<String, String> {
    let hex = key::public_hex(v).map_err(|why| format!("{what}: {why}"))?;
    let v = v.trim();
    if !v.strip_prefix("nostr:").unwrap_or(v).starts_with("npub1") {
        return Err(format!("{what}: give an npub (npub1…)"));
    }
    Ok(hex)
}

/// The settings the page asked for, trimmed and checked, with the notice answered or not.
/// Nothing here touches the running node, so a bad setting leaves it alone.
fn checked(form: SettingsForm, keep_notice_seen: bool) -> Result<Settings, String> {
    let trim = |v: Vec<String>| -> Vec<String> {
        v.into_iter()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect()
    };
    if !(1..=MAX_CAP_GIB).contains(&form.cap_gib) {
        return Err(format!(
            "the space for kept videos must be 1 to {MAX_CAP_GIB} GiB"
        ));
    }
    let new = Settings {
        version: SETTINGS_VERSION,
        relays: trim(form.relays),
        iroh_relays: trim(form.iroh_relays),
        share: form.share,
        keep_notice_seen,
        cap_gib: form.cap_gib,
        rating_root: match form.rating_root.trim() {
            "" => None,
            v => Some(npub_hex("your npub", v)?),
        },
        rating_trusted: trim(form.rating_trusted)
            .iter()
            .enumerate()
            .map(|(i, v)| npub_hex(&format!("trusted key {}", i + 1), v))
            .collect::<Result<_, _>>()?,
        general_relays: trim(form.general_relays),
    };
    if let Some(bad) = new.relays.iter().find(|u| !relay_ok(u)) {
        return Err(format!("a relay must be ws:// or wss://: {bad}"));
    }
    if let Some(bad) = new.general_relays.iter().find(|u| !relay_ok(u)) {
        return Err(format!("a general relay must be ws:// or wss://: {bad}"));
    }
    // The daemon refuses the same combinations; said here in the page's words.
    let rating = new.rating_root.is_some();
    if !rating && !new.rating_trusted.is_empty() {
        return Err("trusted keys need your npub too".into());
    }
    if rating && new.general_relays.is_empty() {
        return Err("seeder ratings need at least one general relay".into());
    }
    if !rating && !new.general_relays.is_empty() {
        return Err(
            "general relays are only read for seeder ratings: add your npub or clear them".into(),
        );
    }
    parse_iroh_relays(&new)?;
    Ok(new)
}

/// Test mode's settings: what the e2e gives, the notice answered.
fn test_settings(t: &TestConfig) -> Result<Settings, String> {
    checked(
        SettingsForm {
            relays: t.relays.clone(),
            iroh_relays: t.iroh_relays.clone(),
            share: t.share,
            cap_gib: DEFAULT_CAP_GIB,
            rating_root: t.rating_root.clone(),
            rating_trusted: Vec::new(),
            general_relays: t.general_relays.clone(),
        },
        true,
    )
}

/// The app's own pages: `tauri://localhost` (Linux, macOS) or `http://tauri.localhost`
/// (Windows). `nfx://` serves media to them and is never a page to navigate to: a document
/// there would be a local origin with IPC.
fn app_page(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

#[derive(Serialize)]
struct SettingsView {
    relays: Vec<String>,
    iroh_relays: Vec<String>,
    share: bool,
    keep_notice_seen: bool,
    cap_gib: u64,
    /// The user's npub, or empty.
    rating_root: String,
    rating_trusted: Vec<String>,
    general_relays: Vec<String>,
    pubkey: String,
}

#[tauri::command]
async fn settings(state: State<'_, AppState>) -> Result<SettingsView, String> {
    let s = state.settings.read().await.clone();
    let npub = |hex: &String| key::npub(hex).unwrap_or_else(|| hex.clone());
    Ok(SettingsView {
        relays: s.relays,
        iroh_relays: s.iroh_relays,
        share: s.share,
        keep_notice_seen: s.keep_notice_seen,
        cap_gib: s.cap_gib,
        rating_root: s.rating_root.as_ref().map(npub).unwrap_or_default(),
        rating_trusted: s.rating_trusted.iter().map(npub).collect(),
        general_relays: s.general_relays,
        pubkey: state.pubkey.clone(),
    })
}

#[tauri::command]
async fn save_settings(state: State<'_, AppState>, form: SettingsForm) -> Result<(), String> {
    let seen = state.settings.read().await.keep_notice_seen;
    // Checked before anything stops: a bad setting leaves the running node alone.
    let new = checked(form, seen)?;
    state.apply(new).await
}

/// The user answered the notice: keep sharing (`share`) or turn it off.
#[tauri::command]
async fn answer_keep_notice(state: State<'_, AppState>, share: bool) -> Result<(), String> {
    let mut new = state.settings.read().await.clone();
    new.keep_notice_seen = true;
    if new.share != share {
        new.share = share;
        return state.apply(new).await;
    }
    // Nothing was kept before the answer, so the node runs on as it is.
    let json = serde_json::to_vec_pretty(&new).map_err(|e| e.to_string())?;
    keep::write_atomic(&state.settings_path(), &json).map_err(|e| e.to_string())?;
    *state.settings.write().await = new;
    Ok(())
}

#[derive(Serialize)]
struct Watched {
    a: String,
    root: String,
    title: String,
    video: String,
    /// Where the history says playback was, in seconds.
    resume: u64,
}

#[tauri::command]
async fn watch(state: State<'_, AppState>, a: String) -> Result<Watched, String> {
    let a = a.trim().to_owned();
    let daemon = state
        .daemon()
        .await
        .ok_or("no node running; set relays first")?;
    let store = state.store()?;
    {
        let mut lib = state.library.lock().await;
        if lib.play.as_ref().is_some_and(|p| p.a != a) {
            end_play(&mut lib, Some(&*daemon), &store).await;
        }
    }
    let m = daemon
        .watch(&a, WATCH_TIMEOUT)
        .await
        .map_err(|e| e.to_string())?;
    let (a, root, title) = (m.a_tag(), m.root_hex(), m.title.clone());
    let now = unix_now();
    let mut guard = state.library.lock().await;
    let lib = &mut *guard;
    if lib.play.as_ref().is_none_or(|p| p.a != a) {
        lib.play = Some(Play {
            a: a.clone(),
            root: root.clone(),
            title: title.clone(),
            decided: lib.kept.contains(&a),
            not_kept: None,
        });
    }
    lib.history.record(&a, &title, now);
    lib.save_history(&state.dir);
    if lib.kept.touch(&a, now) {
        lib.save_kept(&state.dir);
    }
    let resume = lib.history.get(&a).map_or(0, |w| w.position);
    Ok(Watched {
        a,
        root,
        title,
        video: m.addr.to_string(),
        resume,
    })
}

/// The page's report on the video playing: where playback is (`position`) and how many
/// seconds of it have played (`played`, seeks not counted). Once the minute has played the
/// video is kept, if sharing is on.
#[tauri::command]
async fn progress(
    state: State<'_, AppState>,
    a: String,
    position: f64,
    played: f64,
) -> Result<(), String> {
    let daemon = state.daemon().await;
    let settings = state.settings.read().await.clone();
    let store = state.store()?;
    let mut guard = state.library.lock().await;
    let lib = &mut *guard;
    let Some(decided) = lib.play.as_ref().filter(|p| p.a == a).map(|p| p.decided) else {
        return Ok(()); // a report about a play that has ended
    };
    let position = if position.is_finite() && position > 0.0 {
        position as u64
    } else {
        0
    };
    lib.history.set_position(&a, position, unix_now());
    lib.save_history(&state.dir);
    if !decided && played.is_finite() && played >= state.keep_after {
        let not_kept = keep_playing(lib, daemon.as_deref(), &settings, &store, &state.dir).await;
        if let Some(play) = lib.play.as_mut() {
            play.decided = true;
            play.not_kept = not_kept;
        }
    }
    Ok(())
}

/// A video in the history, as the page shows it.
#[derive(Serialize)]
struct HistoryItem {
    a: String,
    title: String,
    /// Seconds.
    position: u64,
    /// Unix seconds.
    watched_at: u64,
    kept: bool,
    state: String,
}

/// What became of a video in the history: kept or not, and what the node does with it.
fn keep_state(
    kept: bool,
    settings: &Settings,
    video: Option<&VideoState>,
    play: Option<&Play>,
) -> String {
    if !kept {
        return match play {
            Some(Play {
                not_kept: Some(why),
                ..
            }) => format!("not kept: {why}"),
            Some(_) if settings.share => "playing; kept after a minute".into(),
            Some(_) => "playing; not kept (sharing is off)".into(),
            None => "not kept".into(),
        };
    }
    if !settings.share {
        return "kept; not seeding (sharing is off)".into();
    }
    match video {
        Some(VideoState::Seeding) => "kept, seeding".into(),
        Some(VideoState::Unannounced(why)) => {
            format!("kept, seeding; the last announcement failed: {why}")
        }
        Some(VideoState::Resolving | VideoState::Fetching) => {
            "kept; fetching the rest before seeding it".into()
        }
        Some(VideoState::AwaitingRelay(_)) => {
            "kept; waiting for an iroh relay before seeding it".into()
        }
        Some(VideoState::Deleted) => "kept; its creator withdrew it, so it is not seeded".into(),
        Some(VideoState::Failed(why)) => format!("kept; seeding failed: {why}"),
        Some(VideoState::Serving) | None => "kept".into(),
    }
}

#[tauri::command]
async fn history(state: State<'_, AppState>) -> Result<Vec<HistoryItem>, String> {
    let videos = state.daemon().await.map(|d| d.state()).unwrap_or_default();
    let settings = state.settings.read().await.clone();
    let lib = state.library.lock().await;
    Ok(lib
        .history
        .entries()
        .iter()
        .map(|w| {
            let kept = lib.kept.contains(&w.a);
            let play = lib.play.as_ref().filter(|p| p.a == w.a);
            HistoryItem {
                a: w.a.clone(),
                title: w.title.clone(),
                position: w.position,
                watched_at: w.watched_at,
                kept,
                state: keep_state(kept, &settings, videos.get(&w.a), play),
            }
        })
        .collect())
}

/// Remove a video from the history, and this computer's copy with it: it is no longer
/// kept or seeded, and its files are deleted. The page stops it first if it is playing.
#[tauri::command]
async fn remove(state: State<'_, AppState>, a: String) -> Result<(), String> {
    let daemon = state.daemon().await;
    let store = state.store()?;
    let mut guard = state.library.lock().await;
    let lib = &mut *guard;
    let playing = lib.play.take_if(|p| p.a == a).map(|p| p.root);
    let kept = lib.kept.remove(&a).map(|v| v.root);
    if kept.is_some() {
        lib.save_kept(&state.dir);
    }
    if lib.history.remove(&a).is_some() {
        lib.save_history(&state.dir);
    }
    if let Some(root) = kept.or(playing) {
        drop_video(lib, daemon.as_deref(), &store, &a, &root).await;
    }
    Ok(())
}

/// A video's state as the page shows it.
fn describe(s: &VideoState) -> String {
    match s {
        VideoState::Unannounced(why) => format!("seeding (unannounced: {why})"),
        VideoState::Failed(why) => format!("failed: {why}"),
        other => format!("{other:?}").to_lowercase(),
    }
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> Result<Vec<(String, String)>, String> {
    Ok(state
        .daemon()
        .await
        .map(|d| {
            d.state()
                .into_iter()
                .map(|(a, s)| (a, describe(&s)))
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
fn test_config(state: State<'_, AppState>) -> Option<TestConfig> {
    state.test.clone()
}

/// One seeder of the video playing, for the page's "stats for nerds" (nfx #99).
#[derive(Serialize)]
struct NerdPeer {
    /// Its iroh endpoint id (hex).
    peer: String,
    bytes: u64,
    blobs: u64,
    last_ms: u64,
    open: bool,
}

/// What this node serves to browsers over WebRTC (sharing on), without addresses.
#[derive(Serialize)]
struct NerdMesh {
    rooms: usize,
    connecting: usize,
    open: usize,
    opened: u64,
    failed: u64,
    served: u64,
}

#[derive(Serialize)]
struct NerdStats {
    state: String,
    /// Seeders known from beacons and gossip.
    known: usize,
    peers: Vec<NerdPeer>,
    mesh: Option<NerdMesh>,
}

/// A seeder's path, only when the user asks to see addresses.
#[derive(Serialize)]
struct NerdRoute {
    peer: String,
    /// `direct`, `relay` or `unknown`.
    path: &'static str,
    /// The seeder's address (direct) or the relay's host (relay).
    address: Option<String>,
    rtt_ms: Option<u64>,
    open: bool,
}

fn root_ok(root: &str) -> Result<(), String> {
    if root.len() == 64
        && root
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err("not a root".into())
    }
}

/// Where the video `root` (address `a`) came from: per seeder bytes, what is known, and
/// what this node serves. No addresses (`nerd_addresses` has them, on request).
#[tauri::command]
async fn nerd_stats(
    state: State<'_, AppState>,
    a: String,
    root: String,
) -> Result<NerdStats, String> {
    root_ok(&root)?;
    let daemon = state.daemon().await.ok_or("no node running")?;
    let video_state = daemon
        .state()
        .get(&a)
        .map(describe)
        .unwrap_or_else(|| "not on this node".into());
    let peers = daemon
        .node()
        .transfers()
        .peers(&root)
        .into_iter()
        .map(|p| NerdPeer {
            peer: p.peer,
            bytes: p.bytes,
            blobs: p.blobs,
            last_ms: p.last_ms,
            open: p.open,
        })
        .collect();
    let mesh = daemon.mesh_status().map(|m| NerdMesh {
        rooms: m.rooms,
        connecting: m.connecting,
        open: m.open,
        opened: m.opened,
        failed: m.failed,
        served: m.served,
    });
    Ok(NerdStats {
        state: video_state,
        known: daemon.sources(&a).len(),
        peers,
        mesh,
    })
}

/// The path to each seeder of `root`: other hosts' addresses, so the page asks only while
/// its "Show addresses" switch is on.
#[tauri::command]
async fn nerd_addresses(
    state: State<'_, AppState>,
    root: String,
) -> Result<Vec<NerdRoute>, String> {
    root_ok(&root)?;
    let daemon = state.daemon().await.ok_or("no node running")?;
    Ok(daemon
        .node()
        .transfers()
        .routes(&root)
        .into_iter()
        .map(|r| NerdRoute {
            peer: r.peer,
            path: r.path.kind(),
            address: r.path.address(),
            rtt_ms: r.rtt_ms,
            open: r.open,
        })
        .collect())
}

/// Test mode only: a line of the e2e's report.
#[tauri::command]
fn report(state: State<'_, AppState>, line: String) -> Result<(), String> {
    if state.test.is_none() {
        return Err("not in test mode".into());
    }
    println!("{line}");
    Ok(())
}

/// Test mode only: the e2e's verdict, then exit.
#[tauri::command]
fn done(app: tauri::AppHandle, state: State<'_, AppState>, ok: bool) -> Result<(), String> {
    if state.test.is_none() {
        return Err("not in test mode".into());
    }
    println!("RESULT {}", if ok { "PASS" } else { "FAIL" });
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

/// The settings file, upgraded (see [`Settings::upgraded`]). No file, or one that is not
/// settings: the defaults.
fn load_settings(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .map(Settings::upgraded)
        .unwrap_or_default()
}

fn main() {
    let test: Option<TestConfig> = std::env::var("NFX_DESKTOP_TEST")
        .ok()
        .map(|j| serde_json::from_str(&j).expect("NFX_DESKTOP_TEST is JSON"));
    if test.is_some() {
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(240));
            println!("RESULT TIMEOUT");
            std::process::exit(2);
        });
    }
    tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("nav-guard")
                .on_navigation(|_, url| app_page(url))
                .build(),
        )
        .setup(move |app| {
            let dir = match std::env::var_os("NFX_DESKTOP_DATA") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            let key_path = dir.join("node.key");
            let pubkey = if key_path.exists() {
                key::load(&key_path)?.public_key().to_hex()
            } else {
                key::create(&key_path)?.public_key().to_hex()
            };
            let settings = match &test {
                Some(t) => test_settings(t)?,
                None => load_settings(&dir.join("settings.json")),
            };
            let (kept, kept_unreadable) = match Kept::load(&dir.join("kept.json")) {
                Ok(kept) => (kept, false),
                Err(e) => {
                    nfxd::status!("nfx-desktop: kept.json: {e}; the store is not swept");
                    (Kept::default(), true)
                }
            };
            let history = History::load(&dir.join("history.json")).unwrap_or_else(|e| {
                nfxd::status!("nfx-desktop: history.json: {e}; starting a new one");
                History::default()
            });
            let keep_after = test
                .as_ref()
                .and_then(|t| t.keep_after_s)
                .unwrap_or(KEEP_AFTER);
            let state = AppState {
                dir,
                pubkey,
                daemon: RwLock::new(None),
                settings: RwLock::new(settings.clone()),
                library: Mutex::new(Library {
                    kept,
                    history,
                    budget: Budget::default(),
                    play: None,
                    kept_unreadable,
                }),
                keep_after,
                test: test.clone(),
            };
            tauri::async_runtime::block_on(state.boot(&settings))?;
            app.manage(state);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("nfx", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let method = request.method().clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                responder.respond(state.serve(&method, &path).await);
            });
        })
        .invoke_handler(tauri::generate_handler![
            settings,
            save_settings,
            answer_keep_notice,
            watch,
            progress,
            history,
            remove,
            status,
            nerd_stats,
            nerd_addresses,
            test_config,
            report,
            done
        ])
        .run(tauri::generate_context!())
        .expect("tauri runtime");
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_CAP_GIB, Play, SETTINGS_VERSION, Settings, SettingsForm, checked, keep_state,
        load_settings,
    };
    use nfxd::daemon::VideoState;

    /// NIP-19's example key.
    const NPUB: &str = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
    const HEX: &str = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";

    fn form(root: &str, trusted: &[&str], general: &[&str]) -> SettingsForm {
        let v = |x: &[&str]| x.iter().map(|s| (*s).to_owned()).collect();
        SettingsForm {
            relays: vec!["wss://scoped.example".into()],
            iroh_relays: Vec::new(),
            share: false,
            cap_gib: DEFAULT_CAP_GIB,
            rating_root: root.into(),
            rating_trusted: v(trusted),
            general_relays: v(general),
        }
    }

    fn rating(root: &str, trusted: &[&str], general: &[&str]) -> Result<Settings, String> {
        checked(form(root, trusted, general), false)
    }

    #[test]
    fn ratings_are_off_by_default_and_keys_come_out_as_hex() {
        let s = rating("", &[], &[]).unwrap();
        assert_eq!(s.rating_root, None);
        assert!(s.rating_trusted.is_empty() && s.general_relays.is_empty());

        let nostr = format!("nostr:{NPUB}");
        let padded = format!(" {NPUB} ");
        let s = rating(&padded, &[&nostr, "  "], &[" wss://general.example ", ""]).unwrap();
        assert_eq!(s.rating_root.as_deref(), Some(HEX));
        assert_eq!(s.rating_trusted, [HEX]);
        assert_eq!(s.general_relays, ["wss://general.example"]);

        // An old settings.json, from before ratings, still loads with them off.
        let old: super::Settings =
            serde_json::from_str(r#"{"relays":["wss://a"],"iroh_relays":[],"share":true}"#)
                .unwrap();
        assert_eq!(old.rating_root, None);
    }

    #[test]
    fn settings_that_cannot_work_or_that_hold_a_secret_are_refused() {
        let g = ["wss://general.example"];
        // A pasted secret key, as an nsec or as bare hex, is never taken and never repeated.
        let nsec = format!("nsec1{}", "q".repeat(58));
        for (root, trusted, general, want) in [
            (nsec.as_str(), &[][..], &g[..], "secret key"),
            (HEX, &[][..], &g[..], "your npub: give an npub"),
            (NPUB, &[HEX][..], &g[..], "trusted key 1: give an npub"),
            ("npub1nope", &[][..], &g[..], "not an npub"),
            ("", &[NPUB][..], &[][..], "need your npub"),
            (NPUB, &[][..], &[][..], "at least one general relay"),
            ("", &[][..], &g[..], "only read for seeder ratings"),
            (
                NPUB,
                &[][..],
                &["https://general.example"][..],
                "ws:// or wss://",
            ),
        ] {
            let err = rating(root, trusted, general).unwrap_err();
            assert!(
                err.contains(want),
                "{root:?} {trusted:?} {general:?}: {err}"
            );
            assert!(!err.contains(&nsec[5..]) && !err.contains(HEX), "{err}");
        }
        for cap in [0, super::MAX_CAP_GIB + 1] {
            let err = checked(
                SettingsForm {
                    cap_gib: cap,
                    ..form("", &[], &[])
                },
                true,
            )
            .unwrap_err();
            assert!(err.contains("space for kept videos"), "{cap}: {err}");
        }
    }

    #[test]
    fn sharing_turns_on_once_at_the_upgrade_and_an_off_chosen_after_it_stays_off() {
        let dir = std::env::temp_dir().join(format!("nfx-desktop-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        // No file: on, the notice not yet answered, the default cap.
        let fresh = load_settings(&path);
        assert!(fresh.share && !fresh.keep_notice_seen);
        assert_eq!(fresh.cap_gib, DEFAULT_CAP_GIB);
        assert!(!fresh.seeding(), "nothing is seeded before the notice");

        // A file from before keeping, sharing off (that build's default): on, with the notice.
        std::fs::write(
            &path,
            br#"{"relays":["wss://a"],"iroh_relays":[],"share":false,"rating_root":null}"#,
        )
        .unwrap();
        let upgraded = load_settings(&path);
        assert!(upgraded.share && !upgraded.keep_notice_seen);
        assert_eq!(upgraded.version, SETTINGS_VERSION);
        assert_eq!(upgraded.relays, ["wss://a"]);

        // The user answers the notice and turns sharing off: written as this build writes
        // it, it stays off.
        let off = checked(
            SettingsForm {
                relays: upgraded.relays.clone(),
                ..form("", &[], &[])
            },
            true,
        )
        .unwrap();
        assert!(!off.share && off.keep_notice_seen);
        std::fs::write(&path, serde_json::to_vec_pretty(&off).unwrap()).unwrap();
        let again = load_settings(&path);
        assert!(!again.share && again.keep_notice_seen);

        // A file that is not settings: the defaults.
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_settings(&path).share);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_history_says_what_became_of_each_video() {
        let on = Settings {
            share: true,
            keep_notice_seen: true,
            ..Settings::default()
        };
        let off = Settings {
            share: false,
            ..on.clone()
        };
        let play = |why: Option<&str>| Play {
            a: "a".into(),
            root: "r".into(),
            title: String::new(),
            decided: why.is_some(),
            not_kept: why.map(str::to_owned),
        };
        let seeding = VideoState::Seeding;
        assert_eq!(keep_state(true, &on, Some(&seeding), None), "kept, seeding");
        assert_eq!(
            keep_state(true, &off, Some(&seeding), None),
            "kept; not seeding (sharing is off)"
        );
        assert_eq!(
            keep_state(true, &on, Some(&VideoState::Fetching), None),
            "kept; fetching the rest before seeding it"
        );
        assert_eq!(keep_state(false, &on, None, None), "not kept");
        assert_eq!(
            keep_state(false, &on, None, Some(&play(None))),
            "playing; kept after a minute"
        );
        assert_eq!(
            keep_state(false, &on, None, Some(&play(Some("sharing is off")))),
            "not kept: sharing is off"
        );
    }
}
