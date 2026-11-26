//! The server side of the file channel (NFX-10 §6.10) on a mesh connection: what one channel
//! may serve, and its requests, answered one file at a time in the order they came.
//!
//! A node only serves here: its `hello` sets the files bit and not the beacons bit, and it
//! never asks. It serves the hash lists of the channel's video it has verified and their
//! files of every role but `segment`, from the content store (which re-verifies on read);
//! every other `sha` is answered `missing`, whatever else the store holds. Flow control: at
//! most [`fc::MAX_QUEUED`] bytes of `data` ahead of the transport per channel, so a large
//! file never holds back the connection's segments.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use nfx_proto::file_channel::{self as fc, Admit, Asked, Message, Read};
use nfx_proto::hashlist::{HashList, Role};

use crate::store::ContentStore;

/// A channel whose peer sends no `hello` this long after it opens is closed.
pub(crate) const HELLO_TIMEOUT: Duration = Duration::from_millis(fc::HELLO_TIMEOUT_MS);
/// A video-room connection is closed this long after the last request it answered (or after
/// it opened, when it was asked nothing).
pub(crate) const VIDEO_ROOM_IDLE: Duration = Duration::from_secs(20);

/// The verified hash lists of one video, by root: what its channels may serve.
#[derive(Clone, Default)]
pub(crate) struct VideoFiles {
    lists: BTreeMap<String, Arc<HashList>>,
}

impl VideoFiles {
    pub(crate) fn insert(&mut self, root: String, list: Arc<HashList>) {
        self.lists.insert(root, list);
    }

    /// Every list of `other` too.
    pub(crate) fn extend(&mut self, other: &Self) {
        for (root, list) in &other.lists {
            self.lists.insert(root.clone(), list.clone());
        }
    }

    /// Whether `sha` may be served on a channel of this video: one of its hash lists, or a
    /// file one of them names with a role other than `segment`.
    pub(crate) fn servable(&self, sha: &str) -> bool {
        self.lists.contains_key(sha)
            || self.lists.values().any(|l| {
                l.files
                    .iter()
                    .any(|f| f.role != Role::Segment && f.sha256 == sha)
            })
    }

    /// The answer to `list` for `root`: `None` when the video has no such hash list or the
    /// store no longer holds it (answered `missing`).
    pub(crate) fn have(&self, root: &str, store: &dyn ContentStore) -> Option<fc::Have> {
        let list = self.lists.get(root)?;
        if !store.has(root) {
            return None;
        }
        let mut have = fc::Have::default();
        // Renditions are named by their index; only the first 32 can be (NFX-10 §6.10).
        for (i, r) in list.renditions.iter().enumerate().take(fc::MAX_HAVE_IDS) {
            let Ok(i) = u8::try_from(i) else { break };
            let Some(playlist) = list
                .files
                .iter()
                .find(|f| f.role == Role::Playlist && f.name == r.playlist)
            else {
                continue;
            };
            let Some((init, segments)) = store
                .get(&playlist.sha256)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .map(|text| media_files(&text))
            else {
                continue;
            };
            if init.as_deref().is_some_and(|sha| !store.has(sha)) || segments.is_empty() {
                continue;
            }
            let held = segments.iter().filter(|s| store.has(s)).count();
            if held == segments.len() {
                have.whole.push(i);
            } else if held > 0 {
                have.part.push(i);
            }
        }
        Some(have)
    }
}

/// A media playlist's init (the `#EXT-X-MAP` URI) and segments (the URI after each
/// `#EXTINF`), as content-name hashes: the name before its first `.`.
pub(crate) fn media_files(text: &str) -> (Option<String>, Vec<String>) {
    let name = |uri: &str| uri.split('.').next().unwrap_or(uri).to_owned();
    let mut init = None;
    let mut segments = Vec::new();
    let mut after_inf = false;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(attrs) = line.strip_prefix("#EXT-X-MAP:") {
            init = attrs
                .split(',')
                .find_map(|a| a.trim().strip_prefix("URI="))
                .map(|v| name(v.trim_matches('"')));
        } else if line.starts_with("#EXTINF") {
            after_inf = true;
        } else if !line.starts_with('#') && after_inf {
            segments.push(name(line));
            after_inf = false;
        }
    }
    (init, segments)
}

/// What the connection must do after a message on its file channel.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Fine,
    /// A protocol error, or a `hello` that never came: close the channel (and a video-room
    /// connection with it).
    Close,
    /// Over the connection's request budget: drop the connection.
    Drop,
}

/// One file channel, server side.
pub(crate) struct FileChan {
    pub id: str0m::channel::ChannelId,
    book: fc::Channel,
    opened: Instant,
    /// Files accepted and not yet sent, by sha256, in the order asked (read when their turn
    /// comes, so waiting requests hold no bytes).
    todo: VecDeque<(u32, String)>,
    /// The file being sent: its request, its bytes, how far.
    sending: Option<(u32, Bytes, usize)>,
    /// Messages ready to write, each with the request it answers (`None`: our `hello`).
    pub out: VecDeque<(Option<u32>, Bytes)>,
    /// When the channel last had work: a request read, or an answer still being sent (see
    /// [`FileChan::idle_for`]), or the opening. What a video-room connection idles from.
    pub last_answer: Instant,
    /// Requests answered with a file.
    pub served: u64,
}

impl FileChan {
    /// A channel just opened: our `hello` goes first.
    pub(crate) fn new(id: str0m::channel::ChannelId, now: Instant) -> Self {
        let hello = Message::Hello {
            version: fc::VERSION,
            flags: fc::FLAG_FILES,
        };
        let mut out = VecDeque::new();
        if let Ok(b) = hello.encode() {
            out.push_back((None, Bytes::from(b)));
        }
        Self {
            id,
            book: fc::Channel::default(),
            opened: now,
            todo: VecDeque::new(),
            sending: None,
            out,
            last_answer: now,
            served: 0,
        }
    }

    /// When the peer's `hello` is late, if it has not come.
    pub(crate) fn hello_due(&self) -> Option<Instant> {
        self.book
            .peer_flags()
            .is_none()
            .then(|| self.opened + HELLO_TIMEOUT)
    }

    fn answer(&mut self, req: u32, m: &Message<'_>) {
        if let Ok(b) = m.encode() {
            self.out.push_back((Some(req), Bytes::from(b)));
        }
        self.book.answered(req);
    }

    /// A message from the peer. `take` charges one request to the connection's budget (false:
    /// over it); `global` to the endpoint's (false: answer `busy`); `fetch` reads a file the
    /// channel may serve.
    pub(crate) fn read(
        &mut self,
        msg: &[u8],
        files: &VideoFiles,
        store: &dyn ContentStore,
        now: Instant,
        take: &mut dyn FnMut() -> bool,
        global: &mut dyn FnMut() -> bool,
    ) -> Verdict {
        let Ok(read) = self.book.read(msg) else {
            return Verdict::Close;
        };
        let (req, asked, admit) = match read {
            Read::Hello { .. } => return Verdict::Fine,
            // A node asks nothing, so no answer is for a request of its own.
            Read::Answer(_) => return Verdict::Fine,
            Read::Cancelled { req, .. } => {
                self.cancel(req);
                return Verdict::Fine;
            }
            Read::Request { req, asked, admit } => (req, asked, admit),
        };
        if !take() {
            return Verdict::Drop;
        }
        self.last_answer = now;
        if admit == Admit::Missing {
            // Answered twice already: `missing`, and the book never held it open.
            if let Ok(b) = (Message::Missing { req }).encode() {
                self.out.push_back((Some(req), Bytes::from(b)));
            }
            return Verdict::Fine;
        }
        if !global() {
            self.answer(req, &Message::Busy { req });
            return Verdict::Fine;
        }
        match asked {
            Asked::File(sha) => {
                let sha = hex::encode(sha);
                if files.servable(&sha) && store.has(&sha) {
                    self.todo.push_back((req, sha));
                } else {
                    self.answer(req, &Message::Missing { req });
                }
            }
            Asked::List(root) => match files.have(&hex::encode(root), store) {
                Some(have) => self.answer(req, &Message::Have { req, have }),
                None => self.answer(req, &Message::Missing { req }),
            },
            // The beacons bit is not set: a peer that asks anyway gets `missing`.
            Asked::Beacons => self.answer(req, &Message::Missing { req }),
        }
        Verdict::Fine
    }

    fn cancel(&mut self, req: u32) {
        self.todo.retain(|(r, _)| *r != req);
        if self.sending.as_ref().is_some_and(|(r, _, _)| *r == req) {
            self.sending = None;
        }
        self.out.retain(|(r, _)| *r != Some(req));
    }

    /// Move the next `data` messages into `out` while it and the transport (`buffered`) hold
    /// less than [`fc::MAX_QUEUED`]. A file is read by `fetch` when its turn comes (`missing`
    /// if it is gone by then), and ends with `end`.
    pub(crate) fn refill(&mut self, buffered: usize, fetch: &mut dyn FnMut(&str) -> Option<Bytes>) {
        while buffered + self.queued() < fc::MAX_QUEUED {
            if self.sending.is_none() {
                let Some((req, sha)) = self.todo.pop_front() else {
                    return;
                };
                match fetch(&sha) {
                    Some(bytes) if !bytes.is_empty() => self.sending = Some((req, bytes, 0)),
                    _ => {
                        self.answer(req, &Message::Missing { req });
                        continue;
                    }
                }
            }
            let Some((req, bytes, at)) = &mut self.sending else {
                return;
            };
            let req = *req;
            if *at >= bytes.len() {
                self.sending = None;
                self.served += 1;
                self.answer(req, &Message::End { req });
                continue;
            }
            let end = (*at + fc::MAX_DATA).min(bytes.len());
            let chunk = bytes.slice(*at..end);
            *at = end;
            let m = Message::Data { req, bytes: &chunk };
            match m.encode() {
                Ok(b) => self.out.push_back((Some(req), Bytes::from(b))),
                Err(_) => {
                    self.sending = None;
                    return;
                }
            }
        }
    }

    /// Bytes waiting in `out`.
    pub(crate) fn queued(&self) -> usize {
        self.out.iter().map(|(_, b)| b.len()).sum()
    }

    /// Whether a file is being sent or waits its turn.
    pub(crate) fn busy(&self) -> bool {
        self.sending.is_some() || !self.todo.is_empty()
    }

    /// How long the channel has had no work. A video-room connection closes after
    /// [`VIDEO_ROOM_IDLE`] of it (NFX-10 §6.9): counted from when the last answer was fully
    /// handed to the transport, never while a request is open or an answer's messages wait.
    pub(crate) fn idle_for(&mut self, now: Instant) -> Duration {
        if self.busy() || !self.out.is_empty() {
            self.last_answer = now;
        }
        now.saturating_duration_since(self.last_answer)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use nfx_proto::file_channel::{Message, data_messages};

    use super::*;

    #[derive(Default)]
    struct Mem(Mutex<HashMap<String, Vec<u8>>>);

    impl ContentStore for Mem {
        fn has(&self, sha256: &str) -> bool {
            self.0.lock().unwrap().contains_key(sha256)
        }
        fn raw_read(&self, sha256: &str) -> crate::Result<Vec<u8>> {
            self.0
                .lock()
                .unwrap()
                .get(sha256)
                .cloned()
                .ok_or_else(|| crate::NodeError::Collection("absent".into()))
        }
        fn raw_write(&self, sha256: &str, bytes: &[u8]) -> crate::Result<()> {
            self.0.lock().unwrap().insert(sha256.into(), bytes.into());
            Ok(())
        }
        fn remove(&self, sha256: &str) -> crate::Result<()> {
            self.0.lock().unwrap().remove(sha256);
            Ok(())
        }
        fn path_of(&self, _: &str) -> Option<PathBuf> {
            None
        }
    }

    /// A video of two renditions: `a` held whole, `b` with one segment of two; its hash list
    /// stored under its root. Also a file of another video, held.
    struct Fixture {
        store: Mem,
        files: VideoFiles,
        root: String,
        init_a: String,
        seg_b1: String,
        other: String,
        big: Vec<u8>,
        big_sha: String,
    }

    fn fixture() -> Fixture {
        let store = Mem::default();
        let put = |b: &[u8]| store.put(b).unwrap();
        let init_a = put(b"init a");
        let init_b = put(b"init b");
        let seg_a = [put(b"seg a0"), put(b"seg a1")];
        let seg_b0 = put(b"seg b0");
        let seg_b1 = hex::encode(nfx_proto::sha256(b"seg b1 (not held)"));
        let playlist = |init: &str, segs: &[&str]| {
            let mut t = format!("#EXTM3U\n#EXT-X-MAP:URI=\"{init}.mp4\"\n");
            for s in segs {
                t.push_str(&format!("#EXTINF:2.0,\n{s}.m4s\n"));
            }
            t.push_str("#EXT-X-ENDLIST\n");
            t
        };
        let pa = put(playlist(&init_a, &[&seg_a[0], &seg_a[1]]).as_bytes());
        let pb = put(playlist(&init_b, &[&seg_b0, &seg_b1]).as_bytes());
        // A thumbnail too big for one message: it spans three `data` messages.
        let big: Vec<u8> = (0..fc::MAX_DATA * 2 + 7).map(|i| (i % 251) as u8).collect();
        let big_sha = put(&big);
        let file = |name: &str, role: &str, sha: &str| serde_json::json!({"name": name, "role": role, "sha256": sha, "size": 1});
        let list: HashList = serde_json::from_value(serde_json::json!({
            "v": 1,
            "video": "nfx:mainnet:1:salt-flats-dusk",
            "files": [
                file("a.m3u8", "playlist", &pa), file("b.m3u8", "playlist", &pb),
                file("ia.mp4", "init", &init_a), file("ib.mp4", "init", &init_b),
                file("a0", "segment", &seg_a[0]), file("a1", "segment", &seg_a[1]),
                file("b0", "segment", &seg_b0), file("b1", "segment", &seg_b1),
                file("t.jpg", "thumb", &big_sha),
            ],
            "renditions": [
                {"id": "a", "playlist": "a.m3u8", "bandwidth": 1, "codecs": "x", "resolution": "1x1"},
                {"id": "b", "playlist": "b.m3u8", "bandwidth": 1, "codecs": "x", "resolution": "1x1"},
            ],
        }))
        .unwrap();
        let root = put(&serde_json::to_vec(&list).unwrap());
        let other = put(b"a file of another video");
        let mut files = VideoFiles::default();
        files.insert(root.clone(), Arc::new(list));
        let _ = seg_a;
        Fixture {
            store,
            files,
            root,
            init_a,
            seg_b1,
            other,
            big,
            big_sha,
        }
    }

    fn sha(hex_: &str) -> [u8; 32] {
        let mut out = [0; 32];
        hex::decode_to_slice(hex_, &mut out).unwrap();
        out
    }

    /// Every message the channel has ready, after refilling it with an empty transport.
    fn drain(f: &mut FileChan, store: &dyn ContentStore) -> Vec<Vec<u8>> {
        let mut got = Vec::new();
        loop {
            f.refill(0, &mut |s| store.get(s).ok().map(Bytes::from));
            if f.out.is_empty() {
                return got;
            }
            got.extend(f.out.drain(..).map(|(_, b)| b.to_vec()));
        }
    }

    /// A channel id: str0m makes them only itself.
    fn id() -> str0m::channel::ChannelId {
        str0m::Rtc::builder()
            .build(Instant::now())
            .sdp_api()
            .add_channel("t".into())
    }

    fn chan(now: Instant) -> FileChan {
        let mut f = FileChan::new(id(), now);
        f.out.clear(); // our hello
        f
    }

    #[test]
    fn servable_is_the_hash_list_and_its_files_but_segments() {
        let x = fixture();
        assert!(x.files.servable(&x.root));
        assert!(x.files.servable(&x.init_a));
        assert!(x.files.servable(&x.big_sha));
        assert!(!x.files.servable(&x.seg_b1), "a segment");
        assert!(!x.files.servable(&x.other), "held, but of another video");
    }

    #[test]
    fn have_names_whole_and_part_renditions() {
        let x = fixture();
        let have = x.files.have(&x.root, &x.store).unwrap();
        assert_eq!(have.whole, vec![0], "rendition a, the first");
        assert_eq!(have.part, vec![1], "rendition b");
        assert!(
            x.files.have(&x.other, &x.store).is_none(),
            "not a hash list of the video"
        );
        x.store.remove(&x.init_a).unwrap();
        let have = x.files.have(&x.root, &x.store).unwrap();
        assert!(have.whole.is_empty(), "no init, no rendition");
    }

    #[test]
    fn a_long_transfer_is_never_idle() {
        let x = fixture();
        let t0 = Instant::now();
        let mut f = chan(t0);
        let (mut yes, mut yes2) = (|| true, || true);
        for m in [
            Message::Hello {
                version: fc::VERSION,
                flags: 0,
            },
            Message::Get {
                req: 1,
                sha: sha(&x.big_sha),
            },
        ] {
            let v = f.read(
                &m.encode().unwrap(),
                &x.files,
                &x.store,
                t0,
                &mut yes,
                &mut yes2,
            );
            assert_eq!(v, Verdict::Fine);
        }
        // The transport is full: the file is still being sent 25 s after it was asked for.
        f.refill(fc::MAX_QUEUED, &mut |s| {
            x.store.get(s).ok().map(Bytes::from)
        });
        let later = t0 + Duration::from_secs(25);
        assert_eq!(f.idle_for(later), Duration::ZERO, "mid-transfer");
        drain(&mut f, &x.store);
        assert_eq!(
            f.idle_for(later + Duration::from_secs(5)),
            Duration::from_secs(5),
            "idle from the end of the transfer, not from the request"
        );
    }

    #[test]
    fn a_channel_serves_in_order_and_refuses_the_rest() {
        let x = fixture();
        let now = Instant::now();
        let mut f = chan(now);
        let (mut yes, mut yes2) = (|| true, || true);
        let mut read = |f: &mut FileChan, m: Message<'_>| {
            f.read(
                &m.encode().unwrap(),
                &x.files,
                &x.store,
                now,
                &mut yes,
                &mut yes2,
            )
        };
        assert_eq!(
            read(
                &mut f,
                Message::Get {
                    req: 1,
                    sha: [0; 32]
                }
            ),
            Verdict::Close,
            "before hello"
        );
        let mut f = chan(now);
        assert_eq!(
            read(
                &mut f,
                Message::Hello {
                    version: 1,
                    flags: 0
                }
            ),
            Verdict::Fine
        );
        assert!(f.hello_due().is_none());
        for (req, s) in [
            (1, &x.big_sha),
            (2, &x.init_a),
            (3, &x.seg_b1),
            (4, &x.other),
        ] {
            assert_eq!(
                read(&mut f, Message::Get { req, sha: sha(s) }),
                Verdict::Fine
            );
        }
        assert_eq!(
            read(
                &mut f,
                Message::List {
                    req: 5,
                    root: sha(&x.root)
                }
            ),
            Verdict::Fine
        );
        assert_eq!(read(&mut f, Message::Beacons { req: 6 }), Verdict::Fine);
        let got = drain(&mut f, &x.store);
        let decoded: Vec<Message<'_>> = got.iter().map(|m| Message::decode(m).unwrap()).collect();
        // `missing` and `have` go at once; the files follow, one at a time, in order.
        assert_eq!(decoded[0], Message::Missing { req: 3 }, "a segment");
        assert_eq!(decoded[1], Message::Missing { req: 4 }, "another video's");
        assert!(matches!(&decoded[2], Message::Have { req: 5, have } if have.whole == [0]));
        assert_eq!(decoded[3], Message::Missing { req: 6 }, "no beacons bit");
        let want_big = data_messages(1, &x.big).unwrap();
        assert_eq!(&got[4..8], &want_big[..], "three data messages, then end");
        let want_init = data_messages(2, b"init a").unwrap();
        assert_eq!(&got[8..], &want_init[..]);
        assert_eq!(f.served, 2);
        assert!(!f.busy());
    }

    #[test]
    fn limits_cancel_and_flow_control() {
        let x = fixture();
        let now = Instant::now();
        let mut f = chan(now);
        let get = |req, s: &str| Message::Get { req, sha: sha(s) }.encode().unwrap();
        let (mut yes, mut no) = (|| true, || false);
        f.read(&[4, 1, 0], &x.files, &x.store, now, &mut yes, &mut || true);
        // Over the endpoint's budget: `busy`. Over the connection's: drop it.
        assert_eq!(
            f.read(
                &get(1, &x.big_sha),
                &x.files,
                &x.store,
                now,
                &mut yes,
                &mut no
            ),
            Verdict::Fine
        );
        assert_eq!(
            f.read(
                &get(2, &x.root),
                &x.files,
                &x.store,
                now,
                &mut no,
                &mut || true
            ),
            Verdict::Drop
        );
        assert_eq!(
            drain(&mut f, &x.store),
            vec![Message::Busy { req: 1 }.encode().unwrap()]
        );
        // A file is answered at most twice on a channel.
        for req in [3, 4] {
            f.read(
                &get(req, &x.init_a),
                &x.files,
                &x.store,
                now,
                &mut yes,
                &mut || true,
            );
            drain(&mut f, &x.store);
        }
        f.read(
            &get(5, &x.init_a),
            &x.files,
            &x.store,
            now,
            &mut yes,
            &mut || true,
        );
        assert_eq!(
            drain(&mut f, &x.store),
            vec![Message::Missing { req: 5 }.encode().unwrap()]
        );
        // A full transport takes nothing more; a cancel drops what is left of the file.
        f.read(
            &get(6, &x.big_sha),
            &x.files,
            &x.store,
            now,
            &mut yes,
            &mut || true,
        );
        f.refill(fc::MAX_QUEUED, &mut |s| {
            x.store.get(s).ok().map(Bytes::from)
        });
        assert!(f.out.is_empty() && f.busy());
        f.refill(fc::MAX_QUEUED - 1, &mut |s| {
            x.store.get(s).ok().map(Bytes::from)
        });
        assert_eq!(f.out.len(), 1, "one message while under 256 KiB");
        f.read(
            &Message::Cancel { req: 6 }.encode().unwrap(),
            &x.files,
            &x.store,
            now,
            &mut yes,
            &mut || true,
        );
        assert!(f.out.is_empty() && !f.busy());
        // Nine open requests: a protocol error. Nine thumbnails of one list, all held.
        let thumbs: Vec<String> = (0..9u8).map(|i| x.store.put(&[i; 3]).unwrap()).collect();
        let list: HashList = serde_json::from_value(serde_json::json!({
            "v": 1,
            "video": "nfx:mainnet:1:salt-flats-dusk",
            "files": thumbs.iter().enumerate().map(|(i, s)| serde_json::json!(
                {"name": format!("t{i}"), "role": "thumb", "sha256": s, "size": 3})).collect::<Vec<_>>(),
            "renditions": [],
        }))
        .unwrap();
        let mut many = VideoFiles::default();
        many.insert(x.root.clone(), Arc::new(list));
        let mut f = chan(now);
        f.read(&[4, 1, 0], &many, &x.store, now, &mut yes, &mut || true);
        for (req, s) in (0u32..).zip(&thumbs[..8]) {
            assert_eq!(
                f.read(&get(req, s), &many, &x.store, now, &mut yes, &mut || true),
                Verdict::Fine
            );
        }
        assert_eq!(f.book.requests().open_count(), 8);
        assert_eq!(
            f.read(
                &get(8, &thumbs[8]),
                &many,
                &x.store,
                now,
                &mut yes,
                &mut || true
            ),
            Verdict::Close
        );
    }

    #[test]
    fn a_peer_with_no_hello_is_late_after_3_s() {
        let now = Instant::now();
        let f = FileChan::new(id(), now);
        assert_eq!(f.hello_due(), Some(now + HELLO_TIMEOUT));
        assert_eq!(
            Message::decode(&f.out[0].1).unwrap(),
            Message::Hello {
                version: 1,
                flags: fc::FLAG_FILES
            }
        );
    }

    #[test]
    fn media_files_reads_init_and_segments() {
        let (init, segs) = media_files(
            "#EXTM3U\n#EXT-X-MAP:URI=\"abc.mp4\",BYTERANGE=\"1@0\"\n#EXTINF:2,\nd.m4s\n",
        );
        assert_eq!(init.as_deref(), Some("abc"));
        assert_eq!(segs, vec!["d".to_owned()]);
    }
}
