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
//! Limits: at most [`MAX_PEERS`] connections, one per remote peer and swarm. A connection
//! whose data channel is not open within [`OPEN_TIMEOUT`], or whose ICE disconnects, is
//! dropped. A new request cancels the upload in progress, as the protocol requires.

use std::collections::{HashMap, VecDeque};
use std::hash::{BuildHasher, RandomState};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
/// A connection must open its data channel within this.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// Segment bytes per data-channel message.
const CHUNK: usize = 16 * 1024;
/// Segments one announcement may list (p2p-media-loader caps groups at 255 blocks of 256).
const MAX_ANNOUNCED: usize = 255 * 256;

/// One rendition's swarm: its infohash and its segments by external id (the 0-based
/// position in the VOD playlist, as p2p-media-loader-hlsjs numbers them).
struct Swarm {
    info_hash: String,
    segments: Vec<String>,
}

enum Control {
    Serve(Vec<Swarm>),
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
        let state = State {
            socket: socket.clone(),
            local,
            tracker,
            me: peer_id(),
            swarms: HashMap::new(),
            peers: Vec::new(),
            store,
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

    /// Join the swarms of a verified hash list whose files are in `store`: one per
    /// rendition with a VOD playlist. Returns the rendition ids joined.
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
            let text = String::from_utf8(store.get(&file.sha256)?)
                .map_err(|_| NodeError::Collection("playlist is not UTF-8".into()))?;
            // External ids are playlist positions only for VOD (`#EXT-X-ENDLIST`).
            if !text.lines().any(|l| l.trim() == "#EXT-X-ENDLIST") {
                continue;
            }
            let segments: Vec<String> = text
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .map(|l| l.split('.').next().unwrap_or(l).to_owned())
                .collect();
            swarms.push(Swarm {
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

struct Peer {
    rtc: Rtc,
    info_hash: String,
    remote: String,
    channel: Option<ChannelId>,
    reassembler: Reassembler,
    /// Messages to send, each tagged with the upload (request id) it belongs to.
    out: VecDeque<(Option<u64>, Vec<u8>)>,
    upload: Option<u64>,
    wake: Instant,
    born: Instant,
    dead: bool,
}

struct State {
    socket: Arc<UdpSocket>,
    local: SocketAddr,
    tracker: LocalSocket,
    me: String,
    swarms: HashMap<String, Arc<Vec<String>>>,
    peers: Vec<Peer>,
    store: Arc<dyn ContentStore + Send + Sync>,
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

    fn control(&mut self, c: Control) {
        match c {
            Control::Serve(swarms) => {
                for s in swarms {
                    let started = json!({
                        "action": "announce",
                        "info_hash": s.info_hash,
                        "peer_id": self.me,
                        "numwant": 0,
                        "uploaded": 0,
                        "downloaded": 0,
                        "offers": [],
                        "event": "started",
                    });
                    let _ = self.tracker.send(&started.to_string());
                    self.swarms.insert(s.info_hash, Arc::new(s.segments));
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
        if self.peers.len() >= MAX_PEERS {
            return;
        }
        let Ok(offer) = SdpOffer::from_sdp_string(sdp) else {
            return;
        };
        let now = Instant::now();
        let mut rtc = Rtc::new(now);
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
            upload: None,
            wake: now,
            born: now,
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
            if unopened || (p.wake <= now && p.rtc.handle_input(Input::Timeout(now)).is_err()) {
                p.dead = true;
            }
        }
    }

    fn pump_all(&mut self) {
        for p in &mut self.peers {
            if !p.dead {
                let segments = self.swarms.get(&p.info_hash).cloned();
                pump(p, &self.socket, segments.as_deref(), &*self.store);
            }
        }
        for p in self.peers.iter_mut().filter(|p| p.dead) {
            p.rtc.disconnect();
        }
        self.peers.retain(|p| !p.dead && p.rtc.is_alive());
    }
}

/// Drain the connection's output and write what the channel accepts. str0m refuses a
/// write while its send buffer is full; the rest waits for network input (the peer's
/// acknowledgements), which is what frees the buffer.
fn pump(
    p: &mut Peer,
    socket: &UdpSocket,
    segments: Option<&Vec<String>>,
    store: &dyn ContentStore,
) {
    loop {
        loop {
            match p.rtc.poll_output() {
                Ok(Output::Timeout(t)) => {
                    p.wake = t;
                    break;
                }
                Ok(Output::Transmit(t)) => {
                    let _ = socket.try_send_to(&t.contents, t.destination);
                }
                Ok(Output::Event(e)) => event(p, e, segments, store),
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
                p.out.pop_front();
            }
            Some(Ok(false)) => return,
            _ => {
                p.dead = true;
                return;
            }
        }
    }
}

fn queue(p: &mut Peer, tag: Option<u64>, cmd: &Command) {
    match p2pml::encode(cmd) {
        Ok(msgs) => p.out.extend(msgs.into_iter().map(|m| (tag, m))),
        Err(_) => p.dead = true,
    }
}

fn event(p: &mut Peer, e: Event, segments: Option<&Vec<String>>, store: &dyn ContentStore) {
    match e {
        Event::ChannelOpen(id, _) => {
            p.channel = Some(id);
            // Everything this node can serve for the swarm, now.
            let loaded: Vec<u64> = segments
                .map(|s| {
                    s.iter()
                        .enumerate()
                        .filter(|(_, sha)| store.has(sha))
                        .map(|(i, _)| i as u64)
                        .take(MAX_ANNOUNCED)
                        .collect()
                })
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
        Event::ChannelData(d) => {
            // Raw segment data would only follow a request of ours, and the bridge makes
            // none: it is ignored.
            if !p2pml::is_command_chunk(&d.data) {
                return;
            }
            match p.reassembler.feed(&d.data) {
                Err(_) => p.dead = true,
                Ok(None) => {}
                Ok(Some(cmd)) => command(p, cmd, segments, store),
            }
        }
        Event::ChannelClose(_) => p.dead = true,
        Event::IceConnectionStateChange(IceConnectionState::Disconnected) => p.dead = true,
        _ => {}
    }
}

fn command(p: &mut Peer, cmd: Command, segments: Option<&Vec<String>>, store: &dyn ContentStore) {
    match cmd {
        Command::Request { id, request, from } => {
            // One upload per peer: a new request cancels the one in progress first.
            if let Some(old) = p.upload.take() {
                p.out.retain(|(tag, _)| *tag != Some(old));
            }
            let bytes = usize::try_from(id)
                .ok()
                .and_then(|i| segments?.get(i))
                .and_then(|sha| store.get(sha).ok());
            let from = usize::try_from(from).unwrap_or(usize::MAX);
            match bytes {
                Some(bytes) if from <= bytes.len() => {
                    let data = &bytes[from..];
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
                    for chunk in p2pml::data_chunks(data, CHUNK) {
                        p.out.push_back((tag, chunk.to_vec()));
                    }
                    queue(p, tag, &Command::Completed { id, request });
                }
                _ => queue(p, None, &Command::Absent { id, request }),
            }
        }
        Command::Cancel { request, .. } => {
            if p.upload == Some(request) {
                p.out.retain(|(tag, _)| *tag != Some(request));
                p.upload = None;
            }
        }
        // The bridge downloads nothing, so announcements and transfers are not for it.
        Command::Announcement { .. }
        | Command::Data { .. }
        | Command::Completed { .. }
        | Command::Absent { .. } => {}
    }
}
