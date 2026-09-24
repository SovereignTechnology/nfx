//! The bridge seeder (NFX-10 §2): a native node that also joins the browser mesh.
//!
//! It announces itself in each held video's per-rendition swarms on the node's own
//! embedded tracker, through an in-process socket ([`Tracker::local`]). It answers browser
//! offers with WebRTC from str0m (DTLS and SCTP come from the library; no hand-written
//! crypto), and speaks p2p-media-loader's peer protocol ([`crate::p2pml`]) on the data
//! channel.
//!
//! It serves segments from the node's content store, which re-verifies every file on read.
//! It **never downloads from browsers**, so it never has to trust their bytes.
//!
//! Hardening (independent audit, 2026-09-24):
//! - **ICE lite**: the bridge never sends connectivity checks. It only answers the
//!   browser's, at its one host candidate. So an offer listing internal addresses cannot
//!   make it send packets there.
//! - **Connections**: at most [`MAX_PEERS`] in total and [`MAX_PEERS_PER_SWARM`] per swarm.
//!   One per remote peer and swarm, and one data channel each. A full pool evicts the
//!   oldest unopened connection first. A connection is dropped if it is not open within
//!   [`OPEN_TIMEOUT`], idle for [`IDLE_TIMEOUT`], or disconnected.
//! - **Work**: segment reads go through a small cache of verified bytes. Requests are
//!   budgeted per peer and in total. Queued bytes per peer are capped. A new request
//!   cancels the upload in progress, as the protocol requires.

use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, RandomState};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use nfx_proto::hashlist::{HashList, Role};
use nfx_proto::namespace::VideoAddr;
use serde_json::{Value, json};
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::p2pml::{self, Command, Reassembler};
use crate::store::ContentStore;
use crate::tracker::{LocalSocket, Tracker};
use crate::{NodeError, Result};

/// Browser connections at once.
pub const MAX_PEERS: usize = 64;
/// Connections in one swarm.
pub const MAX_PEERS_PER_SWARM: usize = 16;
/// A connection must open its data channel within this.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// An open connection that asks for nothing for this long is dropped.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Segment bytes per data-channel message.
const CHUNK: usize = 16 * 1024;
/// Bytes queued for one peer; beyond this it is dropped (it is not reading).
const MAX_QUEUED: usize = 16 << 20;
/// Verified segment bytes kept in memory, so repeated requests cost no re-read.
const CACHE_BYTES: usize = 64 << 20;
/// Requests per peer, and in total: a burst, then a steady rate. A player needs one
/// request at a time; a peer over its budget is dropped, and requests over the global
/// budget are answered `Absent`.
const PEER_BURST: f64 = 60.0;
const PEER_RATE: f64 = 20.0;
const GLOBAL_BURST: f64 = 400.0;
const GLOBAL_RATE: f64 = 200.0;
/// How often incomplete swarms are rechecked (and failed announces retried).
const REFRESH_EVERY: Duration = Duration::from_secs(10);

/// One rendition's swarm: its segments by external id (the position of each `#EXTINF`
/// segment in the VOD playlist, as p2p-media-loader-hlsjs numbers them).
struct SwarmSpec {
    info_hash: String,
    segments: Vec<String>,
}

enum Control {
    Serve(Vec<SwarmSpec>),
    Forget(Vec<String>),
}

pub struct Bridge {
    control: mpsc::Sender<Control>,
    task: JoinHandle<()>,
    local: SocketAddr,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Bridge {
    /// Bind UDP on `bind`, a specific address browsers can reach (it is the only ICE
    /// candidate offered), and join swarms on `tracker` as they are served.
    pub async fn start(
        tracker: &Arc<Tracker>,
        store: Arc<dyn ContentStore + Send + Sync>,
        bind: SocketAddr,
    ) -> Result<Self> {
        if bind.ip().is_unspecified() {
            return Err(NodeError::Transport(
                "the bridge needs a specific address: it is its only ICE candidate".into(),
            ));
        }
        let socket = Arc::new(UdpSocket::bind(bind).await.map_err(NodeError::transport)?);
        let local = socket.local_addr().map_err(NodeError::transport)?;
        let (tracker, inbox) = tracker.local();
        let (control, commands) = mpsc::channel(64);
        let now = Instant::now();
        let state = State {
            socket: socket.clone(),
            local,
            tracker,
            me: peer_id(),
            swarms: HashMap::new(),
            peers: Vec::new(),
            store,
            cache: Cache::default(),
            budget: Bucket::new(GLOBAL_BURST, now),
            refreshed: now,
        };
        let task = tokio::spawn(run(state, socket, commands, inbox));
        Ok(Self {
            control,
            task,
            local,
        })
    }

    /// The UDP address browsers connect to.
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// Whether the bridge is still running (a panic in its task would end it).
    #[must_use]
    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    /// Join the swarms of a verified hash list: one per rendition whose VOD playlist is in
    /// `store`. A rendition whose playlist is not there yet, or that uses byte ranges, is
    /// skipped. Returns the rendition ids joined.
    pub async fn serve(&self, list: &HashList, store: &dyn ContentStore) -> Result<Vec<String>> {
        let video = VideoAddr::parse(&list.video)?;
        let mut swarms = Vec::new();
        let mut ids = Vec::new();
        for r in &list.renditions {
            let Some(file) = list
                .files
                .iter()
                .find(|f| f.role == Role::Playlist && f.name == r.playlist)
            else {
                continue;
            };
            let Some(segments) = store
                .get(&file.sha256)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .and_then(|text| vod_segments(&text))
            else {
                continue;
            };
            swarms.push(SwarmSpec {
                info_hash: video.web_tracker_infohash(&r.id),
                segments,
            });
            ids.push(r.id.clone());
        }
        self.control
            .send(Control::Serve(swarms))
            .await
            .map_err(|_| NodeError::Transport("the bridge stopped".into()))?;
        Ok(ids)
    }

    /// Leave a video's swarms (its creator deleted it) and drop their connections.
    pub async fn forget(&self, list: &HashList) -> Result<()> {
        let video = VideoAddr::parse(&list.video)?;
        let hashes = list
            .renditions
            .iter()
            .map(|r| video.web_tracker_infohash(&r.id))
            .collect();
        self.control
            .send(Control::Forget(hashes))
            .await
            .map_err(|_| NodeError::Transport("the bridge stopped".into()))
    }
}

/// A VOD playlist's media segments, as content-name hashes, in the order hls.js numbers
/// them: the URI line after each `#EXTINF`. `None` for a live playlist (no
/// `#EXT-X-ENDLIST`, so ids would be sequence numbers) or one with byte ranges (a bridge
/// serves whole files).
fn vod_segments(text: &str) -> Option<Vec<String>> {
    let mut vod = false;
    let mut segments = Vec::new();
    let mut after_inf = false;
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if line == "#EXT-X-ENDLIST" {
            vod = true;
        } else if line.starts_with("#EXT-X-BYTERANGE") {
            return None;
        } else if line.starts_with("#EXTINF") {
            after_inf = true;
        } else if !line.starts_with('#') && after_inf {
            segments.push(line.split('.').next().unwrap_or(line).to_owned());
            after_inf = false;
        }
    }
    vod.then_some(segments)
}

/// A 20-character peer id: a bridge prefix and 12 random alphanumerics.
fn peer_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = RandomState::new();
    let mut id = String::from("-NX0100-");
    let mut x = s.hash_one(std::time::SystemTime::now());
    for i in 0..12u64 {
        id.push(char::from(ALPHABET[(x % 62) as usize]));
        x = s.hash_one((x, i));
    }
    id
}

/// The ids of `loaded` that one announcement can carry: p2p-media-loader's array holds at
/// most 255 blocks of 256, so ids beyond the 255th block are left out.
fn announceable(loaded: &[u64]) -> Vec<u64> {
    let mut blocks: Vec<u64> = Vec::new();
    loaded
        .iter()
        .copied()
        .filter(|id| {
            let block = id >> 8;
            if blocks.contains(&block) {
                true
            } else if blocks.len() < 255 {
                blocks.push(block);
                true
            } else {
                false
            }
        })
        .collect()
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            at: now,
        }
    }

    fn take(&mut self, now: Instant, burst: f64, rate: f64) -> bool {
        self.tokens = (self.tokens + now.duration_since(self.at).as_secs_f64() * rate).min(burst);
        self.at = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// Verified segment bytes by sha256, least recently used out first.
#[derive(Default)]
struct Cache {
    entries: HashMap<String, (Bytes, u64)>,
    bytes: usize,
    tick: u64,
}

impl Cache {
    fn get(&mut self, sha: &str, store: &dyn ContentStore) -> Option<Bytes> {
        self.tick += 1;
        if let Some((b, t)) = self.entries.get_mut(sha) {
            *t = self.tick;
            return Some(b.clone());
        }
        let b = Bytes::from(store.get(sha).ok()?);
        if b.len() > CACHE_BYTES / 4 {
            return Some(b);
        }
        while self.bytes + b.len() > CACHE_BYTES {
            let Some(old) = self
                .entries
                .iter()
                .min_by_key(|(_, (_, t))| *t)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((ob, _)) = self.entries.remove(&old) {
                self.bytes -= ob.len();
            }
        }
        self.bytes += b.len();
        self.entries.insert(sha.to_owned(), (b.clone(), self.tick));
        Some(b)
    }
}

struct Swarm {
    segments: Vec<String>,
    /// Ids held now (announced at channel open and whenever it grows).
    loaded: Vec<u64>,
    /// The tracker accepted our announce.
    joined: bool,
}

struct Peer {
    rtc: Rtc,
    info_hash: String,
    remote: String,
    channel: Option<ChannelId>,
    reassembler: Reassembler,
    /// Messages to send, each tagged with the upload (request id) it belongs to.
    out: VecDeque<(Option<u64>, Bytes)>,
    queued: usize,
    upload: Option<u64>,
    budget: Bucket,
    wake: Instant,
    born: Instant,
    active: Instant,
    dead: bool,
}

struct State {
    socket: Arc<UdpSocket>,
    local: SocketAddr,
    tracker: LocalSocket,
    me: String,
    swarms: HashMap<String, Swarm>,
    peers: Vec<Peer>,
    store: Arc<dyn ContentStore + Send + Sync>,
    cache: Cache,
    budget: Bucket,
    refreshed: Instant,
}

async fn run(
    mut state: State,
    socket: Arc<UdpSocket>,
    mut control: mpsc::Receiver<Control>,
    mut inbox: mpsc::Receiver<String>,
) {
    let mut buf = vec![0u8; 2048];
    loop {
        let wake = tokio::time::Instant::from_std(state.next_wake());
        tokio::select! {
            c = control.recv() => match c {
                Some(c) => state.control(c),
                None => break,
            },
            m = inbox.recv() => match m {
                Some(m) => state.on_tracker_message(&m),
                None => break,
            },
            r = socket.recv_from(&mut buf) => {
                if let Ok((n, source)) = r {
                    state.receive(&buf[..n], source);
                }
            }
            () = tokio::time::sleep_until(wake) => state.timeout(),
        }
        state.pump_all();
    }
}

impl State {
    fn next_wake(&self) -> Instant {
        let soon = Instant::now() + Duration::from_millis(500);
        self.peers
            .iter()
            .map(|p| p.wake)
            .min()
            .unwrap_or(soon)
            .min(soon)
    }

    fn loaded(&self, segments: &[String]) -> Vec<u64> {
        segments
            .iter()
            .enumerate()
            .filter(|(_, sha)| self.store.has(sha))
            .map(|(i, _)| i as u64)
            .collect()
    }

    fn announce(&mut self, info_hash: &str) -> bool {
        let started = json!({
            "action": "announce",
            "info_hash": info_hash,
            "peer_id": self.me,
            "numwant": 0,
            "uploaded": 0,
            "downloaded": 0,
            "offers": [],
            "event": "started",
        });
        // A failure (not admitted yet, say) is retried at the next refresh.
        self.tracker
            .send(&started.to_string())
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .is_some_and(|r| r.get("failure reason").is_none())
    }

    fn control(&mut self, c: Control) {
        match c {
            Control::Serve(specs) => {
                for s in specs {
                    let loaded = self.loaded(&s.segments);
                    let joined = self.announce(&s.info_hash);
                    self.swarms.insert(
                        s.info_hash,
                        Swarm {
                            segments: s.segments,
                            loaded,
                            joined,
                        },
                    );
                }
            }
            Control::Forget(hashes) => {
                for h in hashes {
                    let stopped = json!({
                        "action": "announce",
                        "info_hash": h,
                        "peer_id": self.me,
                        "numwant": 0,
                        "offers": [],
                        "event": "stopped",
                    });
                    let _ = self.tracker.send(&stopped.to_string());
                    self.swarms.remove(&h);
                    for p in self.peers.iter_mut().filter(|p| p.info_hash == h) {
                        p.dead = true;
                    }
                }
            }
        }
    }

    /// Recheck incomplete swarms (a pulled video fills in) and retry failed announces;
    /// peers of a swarm that grew get a fresh announcement.
    fn refresh(&mut self) {
        let hashes: Vec<String> = self.swarms.keys().cloned().collect();
        for h in hashes {
            let (retry, grown) = {
                let s = &self.swarms[&h];
                let grown = if s.loaded.len() < s.segments.len() {
                    let now = self.loaded(&s.segments);
                    (now.len() > s.loaded.len()).then_some(now)
                } else {
                    None
                };
                (!s.joined, grown)
            };
            if retry {
                let joined = self.announce(&h);
                if let Some(s) = self.swarms.get_mut(&h) {
                    s.joined = joined;
                }
            }
            if let Some(loaded) = grown {
                let announcement = Command::Announcement {
                    loaded: announceable(&loaded),
                    loading: vec![],
                };
                for p in self
                    .peers
                    .iter_mut()
                    .filter(|p| p.info_hash == h && p.channel.is_some())
                {
                    queue(p, None, &announcement);
                }
                if let Some(s) = self.swarms.get_mut(&h) {
                    s.loaded = loaded;
                }
            }
        }
    }

    /// An offer relayed by the tracker: answer it with a new connection.
    fn on_tracker_message(&mut self, text: &str) {
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let (Some(info_hash), Some(remote), Some(offer_id), Some(sdp)) = (
            m.get("info_hash").and_then(Value::as_str),
            m.get("peer_id").and_then(Value::as_str),
            m.get("offer_id").and_then(Value::as_str),
            m.get("offer")
                .and_then(|o| o.get("sdp"))
                .and_then(Value::as_str),
        ) else {
            return;
        };
        if !self.swarms.contains_key(info_hash) || remote == self.me {
            return;
        }
        // One connection per remote peer and swarm: a new offer replaces the old one.
        for p in self
            .peers
            .iter_mut()
            .filter(|p| p.info_hash == info_hash && p.remote == remote)
        {
            p.dead = true;
        }
        self.peers.retain(|p| !p.dead);
        let in_swarm = self
            .peers
            .iter()
            .filter(|p| p.info_hash == info_hash)
            .count();
        if self.peers.len() >= MAX_PEERS || in_swarm >= MAX_PEERS_PER_SWARM {
            // Full: make room only by evicting the oldest connection that never opened.
            let evict = self
                .peers
                .iter()
                .enumerate()
                .filter(|(_, p)| {
                    p.channel.is_none()
                        && (self.peers.len() >= MAX_PEERS || p.info_hash == info_hash)
                })
                .min_by_key(|(_, p)| p.born)
                .map(|(i, _)| i);
            match evict {
                Some(i) => {
                    let mut p = self.peers.remove(i);
                    p.rtc.disconnect();
                }
                None => return,
            }
        }
        let Ok(offer) = SdpOffer::from_sdp_string(sdp) else {
            return;
        };
        let now = Instant::now();
        let mut rtc = Rtc::builder().set_ice_lite(true).build(now);
        let Ok(candidate) = Candidate::host(self.local, "udp") else {
            return;
        };
        rtc.add_local_candidate(candidate);
        let Ok(answer) = rtc.sdp_api().accept_offer(offer) else {
            return;
        };
        let reply = json!({
            "action": "announce",
            "info_hash": info_hash,
            "peer_id": self.me,
            "to_peer_id": remote,
            "offer_id": offer_id,
            "answer": { "type": "answer", "sdp": answer.to_sdp_string() },
        });
        let _ = self.tracker.send(&reply.to_string());
        self.peers.push(Peer {
            rtc,
            info_hash: info_hash.to_owned(),
            remote: remote.to_owned(),
            channel: None,
            reassembler: Reassembler::default(),
            out: VecDeque::new(),
            queued: 0,
            upload: None,
            budget: Bucket::new(PEER_BURST, now),
            wake: now,
            born: now,
            active: now,
            dead: false,
        });
    }

    fn receive(&mut self, bytes: &[u8], source: SocketAddr) {
        let Ok(contents) = bytes.try_into() else {
            return;
        };
        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source,
                destination: self.local,
                contents,
            },
        );
        if let Some(peer) = self.peers.iter_mut().find(|p| p.rtc.accepts(&input))
            && peer.rtc.handle_input(input).is_err()
        {
            peer.dead = true;
        }
    }

    fn timeout(&mut self) {
        let now = Instant::now();
        for p in &mut self.peers {
            let unopened = p.channel.is_none() && now.duration_since(p.born) > OPEN_TIMEOUT;
            let idle = p.channel.is_some() && now.duration_since(p.active) > IDLE_TIMEOUT;
            if unopened
                || idle
                || (p.wake <= now && p.rtc.handle_input(Input::Timeout(now)).is_err())
            {
                p.dead = true;
            }
        }
        if now.duration_since(self.refreshed) >= REFRESH_EVERY {
            self.refreshed = now;
            self.refresh();
        }
    }

    fn pump_all(&mut self) {
        let now = Instant::now();
        let mut peers = std::mem::take(&mut self.peers);
        for p in &mut peers {
            if !p.dead {
                self.pump(p, now);
            }
        }
        for p in peers.iter_mut().filter(|p| p.dead) {
            // Let the close go out rather than leave the browser to time out.
            p.rtc.disconnect();
            while let Ok(out) = p.rtc.poll_output() {
                match out {
                    Output::Transmit(t) => {
                        let _ = self.socket.try_send_to(&t.contents, t.destination);
                    }
                    Output::Timeout(_) => break,
                    Output::Event(_) => {}
                }
            }
        }
        peers.retain(|p| !p.dead && p.rtc.is_alive());
        self.peers = peers;
    }

    /// Drain the connection's output and write what the channel accepts. str0m refuses a
    /// write while its send buffer is full; the rest waits for network input (the peer's
    /// acknowledgements), which is what frees the buffer.
    fn pump(&mut self, p: &mut Peer, now: Instant) {
        loop {
            loop {
                match p.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => {
                        p.wake = t;
                        break;
                    }
                    Ok(Output::Transmit(t)) => {
                        let _ = self.socket.try_send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(e)) => self.event(p, e, now),
                    Err(_) => {
                        p.dead = true;
                        return;
                    }
                }
            }
            if p.dead {
                return;
            }
            let (Some(id), Some((_, msg))) = (p.channel, p.out.front()) else {
                return;
            };
            match p.rtc.channel(id).map(|mut c| c.write(true, msg)) {
                Some(Ok(true)) => {
                    if let Some((_, m)) = p.out.pop_front() {
                        p.queued -= m.len();
                    }
                }
                Some(Ok(false)) => return,
                _ => {
                    p.dead = true;
                    return;
                }
            }
        }
    }

    fn event(&mut self, p: &mut Peer, e: Event, now: Instant) {
        match e {
            // One data channel per connection: a second open is ignored.
            Event::ChannelOpen(id, _) if p.channel.is_none() => {
                p.channel = Some(id);
                p.active = now;
                let loaded = self
                    .swarms
                    .get(&p.info_hash)
                    .map(|s| announceable(&s.loaded))
                    .unwrap_or_default();
                queue(
                    p,
                    None,
                    &Command::Announcement {
                        loaded,
                        loading: vec![],
                    },
                );
            }
            Event::ChannelData(d) if Some(d.id) == p.channel => {
                // Raw segment data would only follow a request of ours, and the bridge
                // makes none: it is ignored.
                if !p2pml::is_command_chunk(&d.data) {
                    return;
                }
                match p.reassembler.feed(&d.data) {
                    Err(_) => p.dead = true,
                    Ok(None) => {}
                    Ok(Some(cmd)) => self.command(p, cmd, now),
                }
            }
            Event::ChannelClose(id) if Some(id) == p.channel => p.dead = true,
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => p.dead = true,
            _ => {}
        }
    }

    fn command(&mut self, p: &mut Peer, cmd: Command, now: Instant) {
        match cmd {
            Command::Request { id, request, from } => {
                p.active = now;
                if !p.budget.take(now, PEER_BURST, PEER_RATE) {
                    p.dead = true;
                    return;
                }
                // One upload per peer: a new request cancels the one in progress first.
                cancel(p);
                let sha = usize::try_from(id)
                    .ok()
                    .and_then(|i| self.swarms.get(&p.info_hash)?.segments.get(i).cloned());
                let bytes = match sha {
                    Some(sha) if self.budget.take(now, GLOBAL_BURST, GLOBAL_RATE) => {
                        self.cache.get(&sha, &*self.store)
                    }
                    _ => None,
                };
                let from = usize::try_from(from).unwrap_or(usize::MAX);
                match bytes {
                    Some(bytes) if from <= bytes.len() => {
                        let data = bytes.slice(from..);
                        p.upload = Some(request);
                        let tag = Some(request);
                        queue(
                            p,
                            tag,
                            &Command::Data {
                                id,
                                request,
                                size: data.len() as u64,
                            },
                        );
                        for chunk in p2pml::data_chunks(&data, CHUNK) {
                            let at = chunk.as_ptr() as usize - data.as_ptr() as usize;
                            push(p, tag, data.slice(at..at + chunk.len()));
                        }
                        queue(p, tag, &Command::Completed { id, request });
                    }
                    _ => queue(p, None, &Command::Absent { id, request }),
                }
            }
            Command::Cancel { request, .. } => {
                p.active = now;
                if p.upload == Some(request) {
                    cancel(p);
                }
            }
            // The bridge downloads nothing, so announcements and transfers are not for it.
            Command::Announcement { .. }
            | Command::Data { .. }
            | Command::Completed { .. }
            | Command::Absent { .. } => {}
        }
    }
}

/// Drop the queued messages of the upload in progress.
fn cancel(p: &mut Peer) {
    if let Some(old) = p.upload.take() {
        let mut freed = 0;
        p.out.retain(|(tag, m)| {
            let keep = *tag != Some(old);
            if !keep {
                freed += m.len();
            }
            keep
        });
        p.queued -= freed;
    }
}

fn push(p: &mut Peer, tag: Option<u64>, m: Bytes) {
    p.queued += m.len();
    p.out.push_back((tag, m));
    if p.queued > MAX_QUEUED {
        p.dead = true;
    }
}

fn queue(p: &mut Peer, tag: Option<u64>, cmd: &Command) {
    match p2pml::encode(cmd) {
        Ok(msgs) => {
            for m in msgs {
                push(p, tag, Bytes::from(m));
            }
        }
        Err(_) => p.dead = true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segments_are_numbered_as_hls_js_numbers_them() {
        let vod = "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"init.mp4\"\n\
                   #EXTINF:2.0,\naaa.m4s\n#EXT-X-DISCONTINUITY\n#EXTINF:2.0,\nbbb.m4s\n\
                   stray.m4s\n#EXT-X-ENDLIST\n";
        assert_eq!(vod_segments(vod), Some(vec!["aaa".into(), "bbb".into()]));
        assert_eq!(vod_segments("#EXTM3U\n#EXTINF:2,\na.m4s\n"), None, "live");
        assert_eq!(
            vod_segments("#EXTINF:2,\n#EXT-X-BYTERANGE:10@0\na.m4s\n#EXT-X-ENDLIST\n"),
            None,
            "byte ranges"
        );
    }

    #[test]
    fn announcements_stay_within_255_blocks() {
        let ids: Vec<u64> = (0..300u64).map(|b| b * 256).collect();
        let a = announceable(&ids);
        assert_eq!(a.len(), 255);
        assert!(
            p2pml::encode(&Command::Announcement {
                loaded: a,
                loading: vec![]
            })
            .is_ok()
        );
    }
}
