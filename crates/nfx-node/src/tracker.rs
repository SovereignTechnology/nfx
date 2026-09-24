//! A WebTorrent tracker for the NFX browser mesh (NFX-10 §2): the subset p2p-media-loader
//! 4.0.0 speaks. That is an announce carrying WebRTC offers, an answer to a relayed offer,
//! and `stopped`. It relays SDP between peers of one swarm and never carries segment bytes.
//!
//! **Admission:** only the swarms of hash lists this node verified ([`Tracker::admit`]),
//! one per rendition, keyed by the NFX-10 §2 infohash. Anything else is refused, so the
//! tracker cannot be borrowed as a general signalling service.
//!
//! It hardens what `bittorrent-tracker` 11.2.3 leaves open:
//! - a socket's `peer_id` is fixed by its first announce;
//! - a `peer_id` held by a live socket cannot be taken over;
//! - offers and answers are validated and re-serialised, never relayed as raw objects;
//! - messages, offers per announce, swarms per socket and peers per swarm are capped;
//! - each socket is rate-limited, and dead sockets are found by ping;
//! - there is no scrape.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::hash::{BuildHasher, RandomState};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::Full;
use hyper::header::{self, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use n0_future::{SinkExt, StreamExt};
use nfx_proto::hashlist::HashList;
use nfx_proto::namespace::VideoAddr;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tungstenite::Message;
use tungstenite::protocol::{Role, WebSocketConfig};

use crate::limit::{ConnGuard, ConnLimits};
use crate::{NodeError, Result};

/// Seconds between a client's announces, as told to it (p2p-media-loader's default).
pub const ANNOUNCE_INTERVAL_SECS: u64 = 120;
/// Largest WebSocket message: five offers with their candidates fit many times over.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Offers accepted in one announce (p2p-media-loader sends 5).
pub const MAX_OFFERS: usize = 10;
/// Largest SDP in an offer or answer (a browser's, with its candidates, is 1–3 KiB).
pub const MAX_SDP_BYTES: usize = 8 * 1024;
/// Peers in one swarm.
pub const MAX_PEERS_PER_SWARM: usize = 1000;
/// Swarms one socket may be in (one per rendition and stream type it plays).
pub const MAX_SWARMS_PER_SOCKET: usize = 16;
/// Swarms admitted in total.
pub const MAX_ADMITTED: usize = 65_536;

/// Messages queued for one socket; beyond this, relayed offers to it are dropped (the
/// offerer times them out, as it would for a peer that never answers).
const OUTBOX: usize = 32;
/// A socket that sends nothing, pong included, for this long is closed.
const SILENCE_LIMIT: Duration = Duration::from_secs(75);
const PING_EVERY: Duration = Duration::from_secs(30);
/// Per-socket message budget: a burst, then a steady rate. p2p-media-loader sends one
/// announce per stream per interval plus one answer per offer it receives.
const RATE_BURST: f64 = 60.0;
const RATE_PER_SEC: f64 = 2.0;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Tracker {
    /// Infohash → the stream swarm ID it names.
    admitted: Mutex<HashMap<String, String>>,
    /// Infohash → peer id → peer.
    swarms: Mutex<HashMap<String, HashMap<String, Peer>>>,
    next_socket: AtomicU64,
}

struct Peer {
    socket: u64,
    outbox: mpsc::Sender<String>,
}

/// One WebSocket's state.
struct Socket {
    id: u64,
    outbox: mpsc::Sender<String>,
    peer_id: Option<String>,
    joined: HashSet<String>,
    tokens: f64,
    refilled: Instant,
    /// An in-process peer (the node's own bridge): no rate or swarm-count limit.
    trusted: bool,
}

impl Socket {
    fn new(id: u64, outbox: mpsc::Sender<String>, trusted: bool) -> Self {
        Self {
            id,
            outbox,
            peer_id: None,
            joined: HashSet::new(),
            tokens: RATE_BURST,
            refilled: Instant::now(),
            trusted,
        }
    }

    fn allow(&mut self) -> bool {
        if self.trusted {
            return true;
        }
        let now = Instant::now();
        let elapsed = now.duration_since(self.refilled).as_secs_f64();
        self.tokens = (self.tokens + elapsed * RATE_PER_SEC).min(RATE_BURST);
        self.refilled = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

/// A reply to the sender; `Close` ends its socket.
enum Reply {
    Send(String),
    None,
    Close,
}

fn failure(info_hash: Option<&str>, reason: &str) -> Reply {
    let mut m = Map::new();
    m.insert("action".into(), "announce".into());
    m.insert("failure reason".into(), reason.into());
    if let Some(ih) = info_hash {
        m.insert("info_hash".into(), ih.into());
    }
    Reply::Send(Value::Object(m).to_string())
}

/// A 20-character tracker string (`info_hash`, `peer_id`), in latin1 terms as
/// `bittorrent-tracker` counts it.
fn str20<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    let s = obj.get(key)?.as_str()?;
    (s.chars().count() == 20 && s.chars().all(|c| u32::from(c) <= 0xFF)).then_some(s)
}

fn offer_id(obj: &Map<String, Value>) -> Option<&str> {
    let s = obj.get("offer_id")?.as_str()?;
    let n = s.chars().count();
    ((1..=64).contains(&n) && s.chars().all(|c| u32::from(c) <= 0xFF)).then_some(s)
}

/// `{"type": kind, "sdp": "v=0…"}`, re-serialised with nothing else in it.
fn description(value: Option<&Value>, kind: &str) -> Option<Value> {
    let obj = value?.as_object()?;
    let sdp = obj.get("sdp")?.as_str()?;
    (obj.get("type")?.as_str()? == kind && sdp.len() <= MAX_SDP_BYTES && sdp.starts_with("v=0"))
        .then(|| json!({ "type": kind, "sdp": sdp }))
}

impl Default for Tracker {
    fn default() -> Self {
        Self {
            admitted: Mutex::new(HashMap::new()),
            swarms: Mutex::new(HashMap::new()),
            next_socket: AtomicU64::new(0),
        }
    }
}

impl Tracker {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Admit the browser-mesh swarms of a verified hash list: one per rendition (NFX-10
    /// §2). Returns how many are admitted for it.
    pub fn admit(&self, list: &HashList) -> Result<usize> {
        let video = VideoAddr::parse(&list.video)?;
        let mut admitted = self.admitted.lock().unwrap_or_else(PoisonError::into_inner);
        for r in &list.renditions {
            if admitted.len() >= MAX_ADMITTED {
                return Err(NodeError::Collection("tracker admission is full".into()));
            }
            admitted.insert(
                video.web_tracker_infohash(&r.id),
                video.web_stream_swarm_id(&r.id),
            );
        }
        Ok(list.renditions.len())
    }

    /// Withdraw a video's swarms (its creator deleted it, NFX-02 §6): new announces are
    /// refused, and its peers are dropped.
    pub fn forget(&self, list: &HashList) -> Result<()> {
        let video = VideoAddr::parse(&list.video)?;
        let hashes: Vec<String> = list
            .renditions
            .iter()
            .map(|r| video.web_tracker_infohash(&r.id))
            .collect();
        let mut admitted = self.admitted.lock().unwrap_or_else(PoisonError::into_inner);
        let mut swarms = self.swarms.lock().unwrap_or_else(PoisonError::into_inner);
        for h in &hashes {
            admitted.remove(h);
            swarms.remove(h);
        }
        Ok(())
    }

    /// Whether `info_hash` names an admitted swarm.
    #[must_use]
    pub fn admits(&self, info_hash: &str) -> bool {
        self.admitted
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(info_hash)
    }

    fn handle(&self, socket: &mut Socket, text: &str) -> Reply {
        if !socket.allow() {
            return Reply::Close;
        }
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(text) else {
            return failure(None, "invalid JSON");
        };
        if obj.get("action").and_then(Value::as_str) != Some("announce") {
            return failure(None, "only announce is supported");
        }
        let Some(info_hash) = str20(&obj, "info_hash") else {
            return failure(None, "invalid info_hash");
        };
        let Some(peer_id) = str20(&obj, "peer_id") else {
            return failure(Some(info_hash), "invalid peer_id");
        };
        match &socket.peer_id {
            Some(bound) if bound != peer_id => {
                return failure(Some(info_hash), "peer_id differs from this socket's");
            }
            Some(_) => {}
            None => socket.peer_id = Some(peer_id.to_owned()),
        }
        if !self.admits(info_hash) {
            return failure(Some(info_hash), "not an NFX swarm on this tracker");
        }
        if obj.contains_key("answer") {
            return self.answer(socket, &obj, info_hash, peer_id);
        }
        match obj.get("event").and_then(Value::as_str) {
            Some("stopped") => {
                self.leave_swarm(socket, info_hash);
                return Reply::Send(self.response(info_hash));
            }
            None | Some("started" | "update" | "completed") => {}
            Some(_) => return failure(Some(info_hash), "invalid event"),
        }
        let offers = match obj.get("offers") {
            None => Vec::new(),
            Some(Value::Array(list)) if list.len() <= MAX_OFFERS => {
                let mut offers = Vec::with_capacity(list.len());
                for o in list {
                    let Some(o) = o.as_object() else {
                        return failure(Some(info_hash), "invalid offer");
                    };
                    let (Some(sdp), Some(id)) = (description(o.get("offer"), "offer"), offer_id(o))
                    else {
                        return failure(Some(info_hash), "invalid offer");
                    };
                    offers.push((sdp, id.to_owned()));
                }
                offers
            }
            Some(_) => return failure(Some(info_hash), "invalid offers"),
        };
        if let Err(reason) = self.join(socket, info_hash, peer_id) {
            return failure(Some(info_hash), reason);
        }
        // Each offer goes to a different peer, picked at random (as bittorrent-tracker).
        let targets: Vec<mpsc::Sender<String>> = {
            let swarms = self.swarms.lock().unwrap_or_else(PoisonError::into_inner);
            let mut others: Vec<(&String, &Peer)> = swarms
                .get(info_hash)
                .map(|s| s.iter().filter(|(id, _)| *id != peer_id).collect())
                .unwrap_or_default();
            let order = RandomState::new();
            others.sort_by_key(|(id, _)| order.hash_one(id.as_str()));
            others
                .into_iter()
                .take(offers.len())
                .map(|(_, p)| p.outbox.clone())
                .collect()
        };
        for ((sdp, id), outbox) in offers.into_iter().zip(targets) {
            let relayed = json!({
                "action": "announce",
                "offer": sdp,
                "offer_id": id,
                "peer_id": peer_id,
                "info_hash": info_hash,
            });
            // A full outbox drops the offer; its sender times it out.
            let _ = outbox.try_send(relayed.to_string());
        }
        Reply::Send(self.response(info_hash))
    }

    /// Relay an answer to the peer whose offer it answers. There is no reply to the
    /// answerer (as bittorrent-tracker); answering joins it to the swarm.
    fn answer(
        &self,
        socket: &mut Socket,
        obj: &Map<String, Value>,
        info_hash: &str,
        peer_id: &str,
    ) -> Reply {
        let (Some(to), Some(id), Some(sdp)) = (
            str20(obj, "to_peer_id"),
            offer_id(obj),
            description(obj.get("answer"), "answer"),
        ) else {
            return failure(Some(info_hash), "invalid answer");
        };
        if let Err(reason) = self.join(socket, info_hash, peer_id) {
            return failure(Some(info_hash), reason);
        }
        let outbox = self
            .swarms
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(info_hash)
            .and_then(|s| s.get(to))
            .map(|p| p.outbox.clone());
        if let Some(outbox) = outbox {
            let relayed = json!({
                "action": "announce",
                "answer": sdp,
                "offer_id": id,
                "peer_id": peer_id,
                "info_hash": info_hash,
            });
            let _ = outbox.try_send(relayed.to_string());
        }
        Reply::None
    }

    /// Put this socket's peer in the swarm, or refresh it there. A `peer_id` held by
    /// another live socket is refused; one left by a closed socket is taken over.
    fn join(
        &self,
        socket: &mut Socket,
        info_hash: &str,
        peer_id: &str,
    ) -> core::result::Result<(), &'static str> {
        if !socket.trusted
            && !socket.joined.contains(info_hash)
            && socket.joined.len() >= MAX_SWARMS_PER_SOCKET
        {
            return Err("too many swarms on one socket");
        }
        let mut swarms = self.swarms.lock().unwrap_or_else(PoisonError::into_inner);
        let swarm = swarms.entry(info_hash.to_owned()).or_default();
        match swarm.get(peer_id) {
            Some(p) if p.socket != socket.id && !p.outbox.is_closed() => {
                return Err("peer_id in use");
            }
            None if swarm.len() >= MAX_PEERS_PER_SWARM => return Err("swarm full"),
            _ => {}
        }
        swarm.insert(
            peer_id.to_owned(),
            Peer {
                socket: socket.id,
                outbox: socket.outbox.clone(),
            },
        );
        socket.joined.insert(info_hash.to_owned());
        Ok(())
    }

    fn leave_swarm(&self, socket: &mut Socket, info_hash: &str) {
        socket.joined.remove(info_hash);
        let Some(peer_id) = &socket.peer_id else {
            return;
        };
        let mut swarms = self.swarms.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(swarm) = swarms.get_mut(info_hash) {
            if swarm.get(peer_id).is_some_and(|p| p.socket == socket.id) {
                swarm.remove(peer_id);
            }
            if swarm.is_empty() {
                swarms.remove(info_hash);
            }
        }
    }

    fn response(&self, info_hash: &str) -> String {
        let n = self
            .swarms
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(info_hash)
            .map_or(0, HashMap::len);
        json!({
            "complete": 0,
            "incomplete": n,
            "action": "announce",
            "interval": ANNOUNCE_INTERVAL_SECS,
            "info_hash": info_hash,
        })
        .to_string()
    }

    /// Peers currently in a swarm (for tests and status).
    #[must_use]
    pub fn peers(&self, info_hash: &str) -> usize {
        self.swarms
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(info_hash)
            .map_or(0, HashMap::len)
    }

    async fn run_socket(self: Arc<Self>, io: hyper::upgrade::Upgraded) {
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let mut ws =
            WebSocketStream::from_raw_socket(TokioIo::new(io), Role::Server, Some(config)).await;
        let (outbox, mut inbox) = mpsc::channel::<String>(OUTBOX);
        let mut socket = Socket::new(
            self.next_socket.fetch_add(1, Ordering::Relaxed),
            outbox,
            false,
        );
        let mut ping = tokio::time::interval(PING_EVERY);
        let mut heard = Instant::now();
        loop {
            let reply = tokio::select! {
                msg = ws.next() => {
                    heard = Instant::now();
                    match msg {
                        Some(Ok(Message::Text(text))) => self.handle(&mut socket, text.as_str()),
                        Some(Ok(Message::Binary(bytes))) => match std::str::from_utf8(&bytes) {
                            Ok(text) => self.handle(&mut socket, text),
                            Err(_) => failure(None, "invalid JSON"),
                        },
                        Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {
                            Reply::None
                        }
                        Some(Ok(Message::Close(_)) | Err(_)) | None => Reply::Close,
                    }
                }
                out = inbox.recv() => match out {
                    Some(text) => Reply::Send(text),
                    None => Reply::Close,
                },
                _ = ping.tick() => {
                    if heard.elapsed() > SILENCE_LIMIT
                        || ws.send(Message::Ping(Bytes::new())).await.is_err()
                    {
                        Reply::Close
                    } else {
                        Reply::None
                    }
                }
            };
            match reply {
                Reply::Send(text) => {
                    if ws.send(Message::text(text)).await.is_err() {
                        break;
                    }
                }
                Reply::None => {}
                Reply::Close => break,
            }
        }
        for info_hash in socket.joined.clone() {
            self.leave_swarm(&mut socket, &info_hash);
        }
    }

    /// A socket for an in-process peer, the node's own bridge: the same protocol,
    /// admission and relay as a WebSocket client, without the WebSocket. Messages the
    /// tracker sends it arrive on the receiver.
    #[must_use]
    pub fn local(self: &Arc<Self>) -> (LocalSocket, mpsc::Receiver<String>) {
        let (outbox, inbox) = mpsc::channel(OUTBOX * 4);
        let socket = Socket::new(
            self.next_socket.fetch_add(1, Ordering::Relaxed),
            outbox,
            true,
        );
        (
            LocalSocket {
                tracker: self.clone(),
                socket,
            },
            inbox,
        )
    }

    /// `guard` is the connection's admission slot; an upgraded WebSocket keeps it.
    fn respond(
        self: &Arc<Self>,
        mut req: Request<hyper::body::Incoming>,
        guard: Arc<ConnGuard>,
    ) -> Response<Full<Bytes>> {
        let headers = req.headers();
        let has = |name: header::HeaderName, token: &str| {
            headers
                .get_all(name)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .flat_map(|v| v.split(','))
                .any(|v| v.trim().eq_ignore_ascii_case(token))
        };
        let upgrade = req.method() == hyper::Method::GET
            && has(header::CONNECTION, "upgrade")
            && has(header::UPGRADE, "websocket");
        if !upgrade {
            return plain(StatusCode::OK, "nfx tracker (WebTorrent over WebSocket)");
        }
        let Some(key) = headers.get(header::SEC_WEBSOCKET_KEY).cloned() else {
            return plain(StatusCode::BAD_REQUEST, "missing Sec-WebSocket-Key");
        };
        if headers
            .get(header::SEC_WEBSOCKET_VERSION)
            .is_none_or(|v| v.as_bytes() != b"13")
        {
            let mut r = plain(StatusCode::UPGRADE_REQUIRED, "WebSocket version 13 only");
            r.headers_mut().insert(
                header::SEC_WEBSOCKET_VERSION,
                HeaderValue::from_static("13"),
            );
            return r;
        }
        let on_upgrade = hyper::upgrade::on(&mut req);
        let tracker = self.clone();
        tokio::spawn(async move {
            let _guard = guard;
            if let Ok(upgraded) = on_upgrade.await {
                tracker.run_socket(upgraded).await;
            }
        });
        let accept = tungstenite::handshake::derive_accept_key(key.as_bytes());
        Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_ACCEPT, accept)
            .body(Full::new(Bytes::new()))
            .unwrap_or_else(|_| plain(StatusCode::INTERNAL_SERVER_ERROR, "upgrade"))
    }

    /// Serve on `listener` until the task is dropped. Connections are capped per address
    /// and in total ([`crate::limit`]); a WebSocket holds its slot while it is open.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        let limits = Arc::new(ConnLimits::default());
        loop {
            let (stream, addr): (_, SocketAddr) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let Some(guard) = limits.admit(addr) else {
                continue;
            };
            let guard = Arc::new(guard);
            let tracker = self.clone();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(move |req| {
                    let (tracker, guard) = (tracker.clone(), guard.clone());
                    async move { Ok::<_, Infallible>(tracker.respond(req, guard)) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HEADER_READ_TIMEOUT)
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades()
                    .await;
            });
        }
    }
}

fn plain(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
    let mut r = Response::new(Full::new(Bytes::from_static(text.as_bytes())));
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    r
}

/// See [`Tracker::local`]. Dropping it leaves every swarm it joined.
pub struct LocalSocket {
    tracker: Arc<Tracker>,
    socket: Socket,
}

impl LocalSocket {
    /// Send one client message; the tracker's direct reply, if any.
    pub fn send(&mut self, text: &str) -> Option<String> {
        match self.tracker.handle(&mut self.socket, text) {
            Reply::Send(reply) => Some(reply),
            Reply::None | Reply::Close => None,
        }
    }
}

impl Drop for LocalSocket {
    fn drop(&mut self) {
        for info_hash in self.socket.joined.clone() {
            self.tracker.leave_swarm(&mut self.socket, &info_hash);
        }
    }
}
