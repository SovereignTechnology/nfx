//! What a viewer app keeps beside its daemon (NFX-18): the videos it keeps and seeds, its
//! user's watch history, which kept videos make room at a disk cap, and a budget on how much
//! it starts to keep. Two small JSON files in the app's data directory, each written whole
//! and atomically, and the NFX store, read here only to learn which files a video has and to
//! delete them. `nfxd run` uses none of it; the desktop viewer does.

use std::collections::{BTreeSet, VecDeque};
use std::fs::{self, File};
use std::io::{self, Write as _};
use std::path::Path;

/// The store a viewer's videos are in (`Config::store`).
pub use nfx_node::store::FsStore;
use nfx_node::store::{ContentStore as _, is_sha256_name};
use nfx_proto::hashlist::HashList;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub const GIB: u64 = 1 << 30;
/// Disk space kept videos may take unless the user sets another cap.
pub const DEFAULT_CAP: u64 = 20 * GIB;
/// Most videos kept at once. Each one kept and seeded is a beacon a minute on every relay
/// (NFX-03 §1), so past this many the least recently watched makes room.
pub const MAX_KEPT: usize = 100;
/// Most videos the history remembers; the oldest goes first.
pub const MAX_HISTORY: usize = 500;
/// Longest title kept in the history or the kept list, in characters.
pub const MAX_TITLE: usize = 200;
/// NFX-18 §2.4's reference budget: at most this many videos, and this many bytes, started
/// to be kept in any hour.
pub const BUDGET_VIDEOS: usize = 20;
pub const BUDGET_BYTES: u64 = 16 * GIB;
pub const BUDGET_WINDOW_SECS: u64 = 60 * 60;

/// One kept video.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeptVideo {
    /// Its address (`a` tag).
    pub a: String,
    /// Its hash list's sha256 (the manifest's `root`).
    pub root: String,
    #[serde(default)]
    pub title: String,
    /// Bytes its hash list declares, every file and the list itself: what it takes once
    /// whole.
    pub size: u64,
    /// Unix seconds.
    pub kept_at: u64,
    /// Unix seconds; the least recent makes room first.
    pub last_watched: u64,
}

/// The kept videos (`kept.json`), most recently watched first.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Kept {
    videos: Vec<KeptVideo>,
}

impl Kept {
    /// Read `path`; absent means nothing is kept. A file that is not a list of kept videos
    /// is an error, so that a caller can leave the store alone rather than take it for
    /// "nothing kept". Entries with no address, a root that is not a sha256 or an address
    /// seen before are dropped, and past [`MAX_KEPT`] the least recently watched.
    pub fn load(path: &Path) -> io::Result<Self> {
        let mut videos: Vec<KeptVideo> = read_list(path)?;
        videos.sort_by_key(|x| std::cmp::Reverse(x.last_watched));
        let mut kept = Self::default();
        for v in videos {
            if !v.a.is_empty() && is_sha256_name(&v.root) && !kept.contains(&v.a) {
                kept.videos.push(v);
            }
        }
        kept.videos.truncate(MAX_KEPT);
        Ok(kept)
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_atomic(path, &serde_json::to_vec_pretty(&self.videos)?)
    }

    #[must_use]
    pub fn videos(&self) -> &[KeptVideo] {
        &self.videos
    }

    #[must_use]
    pub fn get(&self, a: &str) -> Option<&KeptVideo> {
        self.videos.iter().find(|v| v.a == a)
    }

    #[must_use]
    pub fn contains(&self, a: &str) -> bool {
        self.get(a).is_some()
    }

    /// Every kept video's root.
    #[must_use]
    pub fn roots(&self) -> Vec<&str> {
        self.videos.iter().map(|v| v.root.as_str()).collect()
    }

    /// What the kept videos take once whole.
    #[must_use]
    pub fn total(&self) -> u64 {
        self.videos
            .iter()
            .map(|v| v.size)
            .fold(0, u64::saturating_add)
    }

    /// Add `v`, or replace the entry with its address. It counts as just watched.
    pub fn insert(&mut self, mut v: KeptVideo) {
        self.remove(&v.a);
        v.title = bounded(&v.title);
        self.videos.insert(0, v);
    }

    pub fn remove(&mut self, a: &str) -> Option<KeptVideo> {
        let i = self.videos.iter().position(|v| v.a == a)?;
        Some(self.videos.remove(i))
    }

    /// `a` was watched again, so it is the last to make room. Whether it is kept.
    pub fn touch(&mut self, a: &str, now: u64) -> bool {
        let Some(mut v) = self.remove(a) else {
            return false;
        };
        v.last_watched = now;
        self.videos.insert(0, v);
        true
    }

    /// The kept videos to remove so that everything fits under `cap` and [`MAX_KEPT`] once
    /// `incoming` more bytes, and one more video, are kept: least recently watched first,
    /// never one whose address is in `protect`. The flag says whether that is enough; when it
    /// is not (`incoming` alone is over the cap, or the protected videos fill it), a caller
    /// that wants to keep something keeps nothing and removes nothing.
    #[must_use]
    pub fn to_evict(
        &self,
        cap: u64,
        incoming: Option<u64>,
        protect: &[&str],
    ) -> (Vec<KeptVideo>, bool) {
        let (bytes, count) = incoming.map_or((0, 0), |b| (b, 1));
        let mut total = self.total().saturating_add(bytes);
        let mut count = self.videos.len() + count;
        let fits = |total: u64, count: usize| total <= cap && count <= MAX_KEPT;
        let mut oldest: Vec<&KeptVideo> = self
            .videos
            .iter()
            .filter(|v| !protect.contains(&v.a.as_str()))
            .collect();
        oldest.sort_by_key(|v| (v.last_watched, v.kept_at));
        let mut out = Vec::new();
        for v in oldest {
            if fits(total, count) {
                break;
            }
            total = total.saturating_sub(v.size);
            count -= 1;
            out.push(v.clone());
        }
        (out, fits(total, count))
    }
}

/// One video in the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watched {
    /// Its address (`a` tag).
    pub a: String,
    #[serde(default)]
    pub title: String,
    /// Where playback last was, in whole seconds.
    #[serde(default)]
    pub position: u64,
    /// Unix seconds.
    pub watched_at: u64,
}

/// The user's watch history (`history.json`), most recent first, at most
/// [`MAX_HISTORY`]. It stays on this computer: nothing here is published.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct History {
    entries: Vec<Watched>,
}

impl History {
    /// Read `path`; absent means an empty history, a file that is not one an error.
    /// Entries with no address, and repeats, are dropped.
    pub fn load(path: &Path) -> io::Result<Self> {
        let mut entries: Vec<Watched> = read_list(path)?;
        entries.sort_by_key(|x| std::cmp::Reverse(x.watched_at));
        let mut history = Self::default();
        for w in entries {
            if !w.a.is_empty() && history.get(&w.a).is_none() {
                history.entries.push(w);
            }
        }
        history.entries.truncate(MAX_HISTORY);
        Ok(history)
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        write_atomic(path, &serde_json::to_vec_pretty(&self.entries)?)
    }

    #[must_use]
    pub fn entries(&self) -> &[Watched] {
        &self.entries
    }

    #[must_use]
    pub fn get(&self, a: &str) -> Option<&Watched> {
        self.entries.iter().find(|w| w.a == a)
    }

    /// A play of `a` started: it moves to the top with `title`, and keeps its position,
    /// to resume from.
    pub fn record(&mut self, a: &str, title: &str, now: u64) {
        let position = self.remove(a).map_or(0, |w| w.position);
        self.entries.insert(
            0,
            Watched {
                a: a.to_owned(),
                title: bounded(title),
                position,
                watched_at: now,
            },
        );
        self.entries.truncate(MAX_HISTORY);
    }

    /// Playback of `a` is at `position` seconds. Whether `a` is in the history.
    pub fn set_position(&mut self, a: &str, position: u64, now: u64) -> bool {
        let Some(w) = self.entries.iter_mut().find(|w| w.a == a) else {
            return false;
        };
        w.position = position;
        w.watched_at = now;
        true
    }

    pub fn remove(&mut self, a: &str) -> Option<Watched> {
        let i = self.entries.iter().position(|w| w.a == a)?;
        Some(self.entries.remove(i))
    }
}

/// How much keeping started in the last hour (NFX-18 §2.4), so that what plays cannot make
/// the app fetch without bound. In memory: only keeping started while the app runs counts.
#[derive(Debug, Default)]
pub struct Budget {
    /// When each keep started (Unix seconds), and the bytes it will fetch at most.
    started: VecDeque<(u64, u64)>,
}

impl Budget {
    /// Whether one more video of `bytes` may start to be kept at `now`.
    pub fn allows(&mut self, now: u64, bytes: u64) -> bool {
        while self
            .started
            .front()
            .is_some_and(|(at, _)| now.saturating_sub(*at) >= BUDGET_WINDOW_SECS)
        {
            self.started.pop_front();
        }
        let spent = self
            .started
            .iter()
            .map(|(_, b)| *b)
            .fold(0, u64::saturating_add);
        self.started.len() < BUDGET_VIDEOS && spent.saturating_add(bytes) <= BUDGET_BYTES
    }

    /// A video of `bytes` started to be kept at `now`.
    pub fn spend(&mut self, now: u64, bytes: u64) {
        self.started.push_back((now, bytes));
    }
}

/// The files of the video whose hash list is `root`: the hash list and every file it names,
/// and the bytes they take. `None` when the store lacks the hash list or it is not one. The
/// store checks the bytes against `root`, so this is the list the video's manifest anchors.
#[must_use]
pub fn video_files(store: &FsStore, root: &str) -> Option<(BTreeSet<String>, u64)> {
    let bytes = store.get(root).ok()?;
    let list: HashList = serde_json::from_slice(&bytes).ok()?;
    let mut files: BTreeSet<String> = list
        .files
        .iter()
        .map(|f| f.sha256.clone())
        .filter(|sha| is_sha256_name(sha))
        .collect();
    files.insert(root.to_owned());
    let size = list
        .files
        .iter()
        .map(|f| f.size)
        .fold(bytes.len() as u64, u64::saturating_add);
    Some((files, size))
}

/// Whether every file of the video `root` is in the store, so that it can be seeded from it
/// as it is, with no fetch first.
#[must_use]
pub fn is_whole(store: &FsStore, root: &str) -> bool {
    video_files(store, root).is_some_and(|(files, _)| files.iter().all(|f| store.has(f)))
}

/// Every file of the videos `roots`; a root whose hash list is not here stands for itself.
fn files_of(store: &FsStore, roots: &[&str]) -> BTreeSet<String> {
    roots
        .iter()
        .flat_map(|root| {
            video_files(store, root).map_or_else(|| BTreeSet::from([(*root).to_owned()]), |f| f.0)
        })
        .collect()
}

/// Delete the files of the video `root` that no video in `keep` (roots) uses, its hash list
/// last, so that one left behind by a failure can still be found. Returns how many went. A
/// video whose hash list is not here has nothing to find.
pub fn delete_video(store: &FsStore, root: &str, keep: &[&str]) -> usize {
    let Some((files, _)) = video_files(store, root) else {
        return 0;
    };
    let kept = files_of(store, keep);
    let mut doomed: Vec<&str> = files
        .difference(&kept)
        .map(String::as_str)
        .filter(|f| *f != root)
        .collect();
    if !kept.contains(root) {
        doomed.push(root);
    }
    let mut deleted = 0;
    for f in doomed {
        if store.has(f) && store.remove(f).is_ok() {
            deleted += 1;
        }
    }
    deleted
}

/// Delete every file in the store that no video in `keep` (roots) uses: what plays left
/// behind when the app stopped before they ended. Only files named by a sha256 are touched,
/// and temporary files another process left; directories (iroh-blobs' index) are not.
/// Returns how many went. Run it only while nothing else plays from the store.
pub fn sweep(store: &FsStore, keep: &[&str]) -> io::Result<usize> {
    let kept = files_of(store, keep);
    let ours = format!("-{}-", std::process::id());
    let mut deleted = 0;
    for entry in fs::read_dir(store.dir())? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        // A store write's temporary file is `.tmp-<sha256>-<pid>-<n>`; this process's own
        // may be in flight.
        let leftover = name
            .strip_prefix(".tmp-")
            .is_some_and(|rest| !rest.get(64..).is_some_and(|t| t.starts_with(&ours)));
        let unused = is_sha256_name(name) && !kept.contains(name);
        if (leftover || unused) && fs::remove_file(entry.path()).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

/// Write `bytes` to `path` so that a reader finds the old file or the whole new one: a
/// temporary file beside it, synced, then renamed over it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::other(format!(
            "not a file path: {}",
            path.display()
        )));
    };
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    let written = (|| {
        let mut file = File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written?;
    // Makes the rename durable where a directory can be opened (not on Windows).
    let _ = File::open(dir).and_then(|d| d.sync_all());
    Ok(())
}

fn read_list<T: DeserializeOwned>(path: &Path) -> io::Result<Vec<T>> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

/// A title as it is kept: at most [`MAX_TITLE`] characters.
fn bounded(title: &str) -> String {
    title.chars().take(MAX_TITLE).collect()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::path::PathBuf;

    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nfxd-keep-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn kept(a: &str, size: u64, last_watched: u64) -> KeptVideo {
        KeptVideo {
            a: a.into(),
            root: "0".repeat(63) + &a.len().to_string(),
            title: String::new(),
            size,
            kept_at: last_watched,
            last_watched,
        }
    }

    fn list_of(videos: Vec<KeptVideo>) -> Kept {
        let mut k = Kept::default();
        for v in videos.into_iter().rev() {
            k.insert(v);
        }
        k
    }

    #[test]
    fn the_least_recently_watched_make_room_and_never_the_one_playing() {
        let k = list_of(vec![
            kept("a", 5, 30),
            kept("bb", 5, 10),
            kept("ccc", 5, 20),
        ]);
        assert_eq!(k.total(), 15);
        // Room for 6 more under a cap of 15: the two least recently watched go, oldest first.
        let (out, fits) = k.to_evict(15, Some(6), &[]);
        let names: Vec<&str> = out.iter().map(|v| v.a.as_str()).collect();
        assert_eq!((names, fits), (vec!["bb", "ccc"], true));
        // `bb` is playing: `ccc` and `a` go instead.
        let (out, fits) = k.to_evict(15, Some(6), &["bb"]);
        let names: Vec<&str> = out.iter().map(|v| v.a.as_str()).collect();
        assert_eq!((names, fits), (vec!["ccc", "a"], true));
        // Nothing needs to go.
        assert_eq!(k.to_evict(100, Some(6), &[]), (vec![], true));
        // More than the cap alone: it cannot fit.
        assert!(!k.to_evict(16, Some(17), &[]).1);
        // A lower cap with nothing incoming: down to it.
        let (out, fits) = k.to_evict(5, None, &[]);
        assert_eq!((out.len(), fits), (2, true));
        // Protected videos over the cap: as much as can go, and it does not fit.
        let (out, fits) = k.to_evict(5, None, &["a", "bb"]);
        assert_eq!((out.len(), fits), (1, false));
    }

    #[test]
    fn at_most_max_kept_videos_are_kept() {
        let k = list_of(
            (0..MAX_KEPT as u64)
                .map(|i| kept(&format!("v{i}"), 1, i + 1))
                .collect(),
        );
        let (out, fits) = k.to_evict(u64::MAX, Some(1), &[]);
        assert_eq!(out.iter().map(|v| v.a.as_str()).collect::<Vec<_>>(), ["v0"]);
        assert!(fits);
    }

    #[test]
    fn the_kept_list_survives_a_restart_and_a_bad_file_is_not_taken_for_an_empty_one() {
        let dir = tmp("kept");
        let path = dir.join("kept.json");
        assert_eq!(
            Kept::load(&path).unwrap(),
            Kept::default(),
            "absent: nothing kept"
        );

        let mut k = list_of(vec![kept("a", 1, 2), kept("bb", 1, 1)]);
        assert!(k.touch("bb", 3), "watched again");
        assert!(!k.touch("zz", 3));
        k.save(&path).unwrap();
        let back = Kept::load(&path).unwrap();
        assert_eq!(back, k);
        assert_eq!(back.videos()[0].a, "bb", "most recently watched first");

        // Entries that cannot be acted on are dropped; repeats keep the most recent.
        let mut bad = kept("a", 1, 9);
        bad.root = "../../etc".into();
        let mut list = k.videos().to_vec();
        list.extend([
            bad,
            kept("bb", 1, 0),
            KeptVideo {
                a: String::new(),
                ..kept("x", 1, 0)
            },
        ]);
        fs::write(&path, serde_json::to_vec(&list).unwrap()).unwrap();
        assert_eq!(Kept::load(&path).unwrap(), k);

        fs::write(&path, b"{ not a list").unwrap();
        assert!(Kept::load(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_history_moves_a_rewatch_to_the_top_keeps_its_position_and_is_bounded() {
        let dir = tmp("history");
        let path = dir.join("history.json");
        let mut h = History::load(&path).unwrap();
        h.record("a", "First", 1);
        assert!(h.set_position("a", 95, 2));
        h.record("b", &"x".repeat(MAX_TITLE + 50), 3);
        h.record("a", "First, renamed", 4);
        assert_eq!(h.entries()[0].a, "a");
        assert_eq!(h.entries()[0].position, 95, "a rewatch resumes");
        assert_eq!(h.entries()[0].title, "First, renamed");
        assert_eq!(h.entries()[1].title.chars().count(), MAX_TITLE);
        assert!(!h.set_position("zz", 1, 5));
        h.save(&path).unwrap();
        assert_eq!(History::load(&path).unwrap(), h);

        assert_eq!(h.remove("a").map(|w| w.position), Some(95));
        assert!(h.get("a").is_none());

        for i in 0..MAX_HISTORY as u64 + 10 {
            h.record(&format!("v{i}"), "", 10 + i);
        }
        assert_eq!(h.entries().len(), MAX_HISTORY);
        assert!(h.get("b").is_none(), "the oldest went");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_budget_bounds_videos_and_bytes_an_hour() {
        let mut b = Budget::default();
        for i in 0..BUDGET_VIDEOS as u64 {
            assert!(b.allows(i, 1));
            b.spend(i, 1);
        }
        assert!(!b.allows(100, 1), "20 videos this hour");
        assert!(
            b.allows(BUDGET_WINDOW_SECS, 1),
            "the first one left the window"
        );

        let mut b = Budget::default();
        assert!(b.allows(0, BUDGET_BYTES));
        assert!(!b.allows(0, BUDGET_BYTES + 1));
        b.spend(0, BUDGET_BYTES - 10);
        assert!(!b.allows(5, 11));
        assert!(b.allows(5, 10));
    }

    /// A hash list naming `files` (name, bytes), put in `store` with the files present.
    fn put_video(store: &FsStore, name: &str, files: &[&[u8]], present: bool) -> String {
        let entries: Vec<serde_json::Value> = files
            .iter()
            .enumerate()
            .map(|(i, bytes)| {
                let sha = hex::encode(nfx_proto::sha256(bytes));
                if present {
                    store.put(bytes).unwrap();
                }
                serde_json::json!({
                    "name": format!("f{i}"), "role": "segment", "sha256": sha, "size": bytes.len(),
                })
            })
            .collect();
        let list = serde_json::json!({
            "v": 1, "video": format!("nfx:testnet:1:{name}"), "files": entries,
            "renditions": [{ "id": "720p", "playlist": "f0", "bandwidth": 1 }],
        });
        store.put(list.to_string().as_bytes()).unwrap()
    }

    #[test]
    fn deleting_a_video_spares_the_files_another_one_keeps() {
        let dir = tmp("store");
        let store = FsStore::open(dir.join("store")).unwrap();
        let shared: &[u8] = b"an init segment both videos have";
        let x = put_video(&store, "x", &[shared, b"x only"], true);
        let y = put_video(&store, "y", &[shared, b"y only"], true);
        let partial = put_video(&store, "z", &[b"z one", b"z two"], false);

        let (files, size) = video_files(&store, &x).unwrap();
        assert_eq!(files.len(), 3, "two files and the hash list");
        assert!(size > shared.len() as u64);
        assert!(is_whole(&store, &x));
        assert!(!is_whole(&store, &partial));
        assert!(video_files(&store, &"0".repeat(64)).is_none());

        // x goes; y keeps the shared file.
        assert_eq!(delete_video(&store, &x, &[&y]), 2);
        assert!(!store.has(&x));
        assert!(is_whole(&store, &y));
        assert_eq!(delete_video(&store, &x, &[&y]), 0, "already gone");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_sweep_leaves_only_what_is_kept() {
        let dir = tmp("sweep");
        let store = FsStore::open(dir.join("store")).unwrap();
        let x = put_video(&store, "x", &[b"x one", b"x two"], true);
        let y = put_video(&store, "y", &[b"y one"], true);
        let stray = store.put(b"a file no kept video names").unwrap();
        fs::create_dir_all(store.dir().join(".nfxd")).unwrap();
        fs::write(store.dir().join(".nfxd").join("blobs.db"), b"index").unwrap();
        fs::write(
            store.dir().join(format!(".tmp-{}-1-0", "a".repeat(64))),
            b"",
        )
        .unwrap();
        let mine = format!(".tmp-{}-{}-0", "b".repeat(64), std::process::id());
        fs::write(store.dir().join(&mine), b"").unwrap();
        fs::write(store.dir().join("notes.txt"), b"not the store's").unwrap();

        // y, its hash list and the other process's temporary file go.
        assert_eq!(sweep(&store, &[&x]).unwrap(), 4);
        assert!(is_whole(&store, &x));
        assert!(!store.has(&y) && !store.has(&stray));
        assert!(store.dir().join(".nfxd").join("blobs.db").exists());
        assert!(store.dir().join(&mine).exists(), "a write in flight");
        assert!(store.dir().join("notes.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_atomic_write_replaces_the_whole_file() {
        let dir = tmp("atomic");
        let path = dir.join("f.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "no temporary file left"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
