//! The mesh endpoint (NFX-10 §6; issue #71): a full-ICE WebRTC peer that meets browsers in
//! the rooms of the renditions this node holds, through ordinary Nostr relays, with no
//! tracker and no TURN, and serves them verified segments. It works behind a NAT: both ends
//! send connectivity checks to each other's public mappings, which is the hole punch.
//!
//! - **Signaling** is nfx-proto's [`signal`]: one room per held rendition's stream swarm
//!   (NFX-10 §2), a fresh random session key per run (never the node's identity key),
//!   presence when a room is joined and every 30 s, a `disconnect` on shutdown, NIP-44 v2
//!   offers and answers each signed when it is sent, and the reader's checks (§6.5),
//!   freshness included. The lower session key offers (§6.6): this node answers offers, and
//!   offers to the peers whose key is higher. Its bounds are the browser library's
//!   ([`book`]): 256 peers' presence per room; one negotiation per peer and 16 per room, at
//!   most 4 of them offers of ours awaiting an answer; 8 offers or answers decrypted per
//!   sender per 30 s; the last 4096 event ids per room, each for 2 min (longer than any
//!   event stays fresh); relay messages over 70 KiB dropped.
//!   An offer unanswered in 15 s, or a connection not open 15 s after the answer (20 s after
//!   answering), has failed; the next offer to that peer waits 30 s, doubling to 10 min.
//! - **ICE** is str0m's full agent (the bridge's is ICE lite), on a UDP socket of its own.
//!   Its candidates: the socket's address (host; for a wildcard bind, the address the route
//!   to the first STUN server, or to the internet, leaves from), the mappings the configured
//!   STUN servers report for that socket (server reflexive; asked at start, for at most
//!   [`GATHER_TIMEOUT`], and every 25 s after, which also keeps the NAT's mapping alive), and
//!   a port the gateway maps by UPnP, PCP or NAT-PMP when [`MeshConfig::portmapper`] is on
//!   and the gateway does. Every SDP sent carries every candidate (no trickle).
//! - **Behind a DNAT** ([`MeshConfig::public`]), whose public address STUN cannot report (a
//!   STUN server of the node's own needs a hairpin) and no gateway maps: that address is one
//!   more host candidate, the first, and every datagram the socket receives is taken as sent
//!   to it, as the bridge does (`--bridge-public`). Then no candidate whose address is not
//!   public ([`crate::node::is_public`]) is offered, as with iroh's external addresses: not
//!   the socket's own address behind the DNAT, nor a private mapping.
//! - **Serving** is the bridge's ([`crate::rtc_serve`]): only verified segments of held
//!   renditions, under the same per-peer caps. It never takes bytes from a peer.
//! - **Discovery is by room alone** (§6): a page that plays a rendition joins its room and
//!   meets every node present there. Beacons need no new endpoint for it, but a page and a
//!   node meet only on a relay both use.
//! - **STUN from Nostr** ([`MeshConfig::stun_from_nostr`], on by default): on its relays, the
//!   endpoint also reads the live beacons of the videos it serves
//!   ([`Mesh::stun_from_beacons_of`]), for their `stun` endpoints, and the STUN service
//!   announcements (kind 33478) for the networks of the rooms it joins (NFX-10 §1). It asks
//!   the servers NFX-10 §1's rules pick (`nfx_proto::stun::select`): the configured ones
//!   first; then global unicast ones of its family, ranked by how many distinct keys name
//!   them; one named by a lone key only when nothing better exists; at most [`MAX_STUN`] in
//!   all. A mapping such a server reports is offered only if it is global unicast, so a lying
//!   server can add at most one useless candidate, never point peers at a private address.
//!   It keeps [`MAX_NAMED`] sources of names at most, [`NAMED_PER_KEY`] per key.
//!
//! Hardening:
//! - A full agent sends checks to the addresses a peer's SDP names. Only
//!   [`sdp::MAX_REMOTE_CANDIDATES`] per SDP are kept, UDP, of the socket's family, on a port
//!   of 1024 or above, never unspecified, multicast, broadcast, link-local or IPv4-mapped, and
//!   loopback only when the socket is itself on loopback ([`sdp::checkable`]).
//! - Connections: at most [`MeshConfig::max_peers`] (default [`MAX_PEERS`]) in all and
//!   [`MAX_PEERS_PER_ROOM`] in one room; at most [`MAX_ROOMS`] rooms. A peer that connects
//!   again replaces its old connection in that room.
//! - The socket takes STUN responses only from a server it asked, for a transaction id it
//!   sent; every other datagram goes to the connection that accepts it, or is dropped.
//!
//! **Privacy.** Joining a room tells anyone who announces presence there this node's
//! candidate addresses (NFX-10 §6.7): its host address, which behind a NAT is a private one
//! (unless [`MeshConfig::public`] is set), and its public mappings. Relays see the room keys
//! (which the catalog maps back to videos), the session key and who signals whom, never the
//! SDP. The endpoint is off unless relays are configured.

pub mod book;
pub mod sdp;
pub mod stun;

use std::collections::{BTreeSet, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::num::NonZeroU16;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use n0_future::{Stream, StreamExt};
use nfx_proto::beacon::{Beacon, Endpoint};
use nfx_proto::event::Event;
use nfx_proto::hashlist::HashList;
use nfx_proto::namespace::VideoAddr;
use nfx_proto::signal::{self, Parsed, Received, Room, Session, Signal};
use nfx_proto::stun::{KIND_STUN_ANNOUNCEMENT, StunAnnouncement};
use nfx_proto::{KIND_BEACON, KIND_MANIFEST};
use nostr_sdk::prelude as ns;
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::{Candidate, Input, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use self::book::{
    NEGOTIATIONS_PER_ROOM, OfferBackoff, PENDING_OFFERS_PER_ROOM, PresenceBook, SeenIds,
    SenderLimiter,
};
use crate::node::is_public;
use crate::nostr::{from_nostr, to_nostr};
use crate::rtc_serve::{Conn, IDLE_TIMEOUT, Swarm, Uploader, announceable, queue, received};
use crate::store::ContentStore;
use crate::{NodeError, Result, unix_now};

/// Relays a node signals through, at most.
pub const MAX_RELAYS: usize = 8;
/// STUN servers it asks, at most.
pub const MAX_STUN: usize = 4;
/// Connections at once, by default ([`MeshConfig::max_peers`]).
pub const MAX_PEERS: usize = 16;
/// The most [`MeshConfig::max_peers`] may be: each connection may queue 16 MiB.
pub const MAX_PEERS_LIMIT: usize = crate::bridge::MAX_PEERS_LIMIT;
/// Connections in one room (or `max_peers`, when that is smaller).
pub const MAX_PEERS_PER_ROOM: usize = 16;
/// Rooms joined at most: renditions held beyond this join none.
pub const MAX_ROOMS: usize = 256;
/// How long candidates are gathered before the first room is joined.
pub const GATHER_TIMEOUT: Duration = Duration::from_secs(5);
/// An offer unanswered this long has failed.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// A connection not open this long after the answer (offerer) has failed.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// The answerer's wait also covers the offerer's receipt of the answer.
const ANSWERED_TIMEOUT: Duration = Duration::from_secs(20);
/// Relay messages longer than this are dropped unparsed (NFX-10 §6.5).
pub const MAX_RELAY_MESSAGE: u32 = 70 * 1024;
/// Rooms per subscription filter: a relay caps both subscriptions per connection (strfry: 20)
/// and a filter's size.
const ROOMS_PER_SUB: usize = 64;
/// How often the subscriptions are checked on every connected relay (a relay that connected
/// late, closed one, or reconnected gets them again, and this node's presence).
const SUB_CHECK: Duration = Duration::from_secs(5);
/// STUN: how often the mappings are asked again (and the NAT's mapping kept alive).
const STUN_REFRESH: Duration = Duration::from_secs(25);
/// STUN: the first retransmission wait; it doubles, for [`STUN_TRIES`] sends in all.
const STUN_RTO: Duration = Duration::from_millis(500);
const STUN_TRIES: u32 = 4;
/// How long a relay gets to acknowledge an event.
const SEND_TIMEOUT: Duration = Duration::from_secs(5);
/// On shutdown, how long the `disconnect`s get.
const SHUTDOWN_WAIT: Duration = Duration::from_secs(2);
/// Local candidates offered, at most (the public address, host, and one per distinct
/// mapping).
const MAX_LOCAL_CANDIDATES: usize = 7;
/// How often a room whose rendition is not all in the store is checked again, so peers hear
/// of segments that arrived (a pulled or fetched video fills in), as the bridge does.
const REFRESH_EVERY: Duration = Duration::from_secs(10);
/// A room's presence is sent again, out of turn, at most this often: when a new peer whose
/// key is lower (so it is the one to offer) appears, so it need not wait for the next round.
const REANNOUNCE_EVERY: Duration = Duration::from_secs(5);
/// STUN from Nostr: the sources of names held at most (a beacon per signer and video, an
/// announcement per operator and server). Keys are free: past it, a new source is ignored
/// until one expires.
pub const MAX_NAMED: usize = 1024;
/// STUN from Nostr: the sources one key may hold, so one key cannot fill the table.
pub const NAMED_PER_KEY: usize = 8;
/// STUN from Nostr: the addresses one source names, at most (a `stun` endpoint's limit;
/// a beacon may carry several endpoints). The rest are not counted.
pub const MAX_STUN_ADDRS: usize = nfx_proto::beacon::MAX_STUN_ADDRS;
/// Manifest addresses (or networks) per subscription filter.
const TAGS_PER_SUB: usize = 64;
/// Stored announcements asked for per subscription.
const ANNOUNCEMENTS_ASKED: usize = 512;

/// Where the mesh endpoint listens, whom it asks for its public mapping, and which relays it
/// signals through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshConfig {
    /// Nostr relays for signaling, 1 to [`MAX_RELAYS`]: `wss://` (or `ws://`) URLs of general
    /// relays, or of scoped relays that admit kind 25050 (NFX-04 §1 as amended 2026-11-18;
    /// most refuse it).
    pub relays: Vec<String>,
    /// The UDP address to bind. A wildcard is allowed: the host candidate is then the address
    /// the route out leaves from.
    pub bind: SocketAddr,
    /// STUN servers (Binding only) for server-reflexive candidates, at most [`MAX_STUN`], of
    /// `bind`'s address family.
    pub stun: Vec<SocketAddr>,
    /// Connections at once, 1 to [`MAX_PEERS_LIMIT`].
    pub max_peers: usize,
    /// Ask the gateway for a port mapping (UPnP, PCP, NAT-PMP), offered as one more
    /// candidate when it gives one. IPv4 only.
    pub portmapper: bool,
    /// The public address of a DNAT that forwards to `bind`'s port, when STUN cannot report
    /// it: offered as the first host candidate, and every datagram the socket receives is
    /// taken as sent to it. With it, no other candidate whose address is not public
    /// ([`crate::node::is_public`]) is offered. An address peers can dial, of `bind`'s family;
    /// whether it is public is the caller's to check (`nfxd` refuses one that is not).
    /// `None`: none.
    pub public: Option<SocketAddr>,
    /// Learn STUN servers from Nostr (NFX-10 §1): beacons' `stun` endpoints for the videos
    /// served ([`Mesh::stun_from_beacons_of`]) and STUN service announcements for the rooms'
    /// networks, read on `relays`, picked by NFX-10 §1's rules after `stun`.
    pub stun_from_nostr: bool,
}

impl MeshConfig {
    /// Signal through `relays`, on an ephemeral IPv4 port, with no STUN server of its own but
    /// those learnt from Nostr, [`MAX_PEERS`] connections, no portmapper and no public address.
    #[must_use]
    pub fn new(relays: Vec<String>) -> Self {
        Self {
            relays,
            bind: SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)),
            stun: Vec::new(),
            max_peers: MAX_PEERS,
            portmapper: false,
            public: None,
            stun_from_nostr: true,
        }
    }
}

/// What is wrong with `url` as a relay the mesh endpoint signals through, if anything: it
/// must be `wss://` or `ws://`, with a host and no credentials, query or fragment. `ws://`
/// shows room keys, session keys and timing (never the SDP) to anyone on the path; prefer
/// `wss://`.
#[must_use]
pub fn relay_url_problem(url: &str) -> Option<String> {
    let Some(rest) = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
    else {
        return Some("not a wss:// or ws:// URL".into());
    };
    if rest.is_empty() || rest.starts_with('/') || url.contains(['@', '?', '#', ' ']) {
        return Some("needs a host, and no credentials, query or fragment".into());
    }
    ns::RelayUrl::parse(url).err().map(|e| e.to_string())
}

/// What the endpoint is doing, for a status line.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MeshStatus {
    /// Whether candidate gathering has ended (rooms are joined only after).
    pub gathered: bool,
    /// The candidates every SDP carries, as `host <ip:port>` and `srflx <ip:port>`; the
    /// public address ([`MeshConfig::public`]) first, when there is one.
    pub candidates: Vec<String>,
    /// The STUN servers asked now: the configured ones, then those learnt from Nostr.
    pub stun: Vec<String>,
    /// Rooms joined.
    pub rooms: usize,
    /// Connections negotiating, and open.
    pub connecting: usize,
    pub open: usize,
    /// Since start: offers and answers sent, connections opened and failed, and segment
    /// requests served.
    pub offers: u64,
    pub answers: u64,
    pub opened: u64,
    pub failed: u64,
    pub served: u64,
}

/// One rendition's room to join.
struct RoomSpec {
    room: Room,
    segments: Vec<String>,
    /// The video's network (its namespace): announcements for it count.
    network: String,
}

enum Control {
    Serve(Vec<RoomSpec>),
    /// Leave these rooms, and stop reading the beacons of this video (`<namespace>:<id>`).
    Forget(Vec<String>, String),
    /// Read this manifest's beacons for `stun` endpoints.
    Beacons(String),
    Shutdown(oneshot::Sender<()>),
}

/// A running mesh endpoint. Dropping it stops it without a `disconnect`; [`Mesh::shutdown`]
/// sends them first.
pub struct Mesh {
    control: mpsc::Sender<Control>,
    task: JoinHandle<()>,
    client: ns::Client,
    local: SocketAddr,
    public: Option<SocketAddr>,
    session: String,
    status: Arc<Mutex<MeshStatus>>,
}

impl Drop for Mesh {
    fn drop(&mut self) {
        self.task.abort();
        let client = self.client.clone();
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move { client.shutdown().await });
        }
    }
}

/// `N` bytes from the operating system's random source.
fn random<const N: usize>() -> Option<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).ok()?;
    Some(b)
}

/// A fresh session: a random key (drawn again in the ~2^-128 case it is out of range) and id.
fn new_session() -> Result<Session> {
    for _ in 0..8 {
        let (Some(secret), Some(id)) = (random::<32>(), random::<16>()) else {
            break;
        };
        if let Ok(s) = Session::new(secret, id) {
            return Ok(s);
        }
    }
    Err(NodeError::Transport(
        "no session key: the random source failed".into(),
    ))
}

/// The address the route to `to` leaves from (nothing is sent: a UDP `connect` only picks
/// the route).
fn route_source(to: SocketAddr) -> Option<IpAddr> {
    let any: SocketAddr = if to.is_ipv4() {
        (Ipv4Addr::UNSPECIFIED, 0).into()
    } else {
        (Ipv6Addr::UNSPECIFIED, 0).into()
    };
    let s = std::net::UdpSocket::bind(any).ok()?;
    s.connect(to).ok()?;
    Some(s.local_addr().ok()?.ip()).filter(|ip| !ip.is_unspecified())
}

impl Mesh {
    /// Bind the socket, connect to the relays (waiting at most 5 s for one), and start: it
    /// gathers candidates for at most [`GATHER_TIMEOUT`], then joins the rooms [`Mesh::serve`]
    /// names.
    pub async fn start(
        store: Arc<dyn ContentStore + Send + Sync>,
        cfg: MeshConfig,
    ) -> Result<Self> {
        let bad = |why: String| Err(NodeError::Transport(why));
        if cfg.relays.is_empty() || cfg.relays.len() > MAX_RELAYS {
            return bad(format!("the mesh needs 1 to {MAX_RELAYS} relays"));
        }
        if let Some((url, why)) = cfg
            .relays
            .iter()
            .find_map(|u| relay_url_problem(u).map(|why| (u, why)))
        {
            return bad(format!("relay {url}: {why}"));
        }
        if cfg.stun.len() > MAX_STUN {
            return bad(format!("the mesh takes at most {MAX_STUN} STUN servers"));
        }
        if let Some(s) = cfg.stun.iter().find(|s| {
            s.port() == 0
                || s.ip().is_unspecified()
                || s.ip().is_multicast()
                || s.is_ipv4() != cfg.bind.is_ipv4()
        }) {
            return bad(format!(
                "STUN server {s}: not a unicast address of the bind's family"
            ));
        }
        if !(1..=MAX_PEERS_LIMIT).contains(&cfg.max_peers) {
            return bad(format!(
                "the mesh's connection cap must be 1 to {MAX_PEERS_LIMIT}"
            ));
        }
        if cfg.bind.ip().is_multicast() {
            return bad(format!("{}: not an address to bind", cfg.bind));
        }
        // Checked before anything binds. str0m refuses a host candidate on an IPv4
        // link-local address too, which no DNAT forwards from.
        if let Some(public) = cfg.public
            && (!crate::bridge::dialable(public)
                || public.is_ipv4() != cfg.bind.is_ipv4()
                || Candidate::host(public, "udp").is_err())
        {
            return bad(format!(
                "the mesh's public address {public}: not one peers can dial, of the bind's family"
            ));
        }
        let socket = Arc::new(
            UdpSocket::bind(cfg.bind)
                .await
                .map_err(NodeError::transport)?,
        );
        let local = socket.local_addr().map_err(NodeError::transport)?;
        // The socket's own address, a host candidate (unless a public address is set and it is
        // not public): the bound address, or for a wildcard the address the route out leaves
        // from. Every datagram is taken as arriving there, or at the public address.
        let base = if local.ip().is_unspecified() {
            let probe = cfg.stun.first().copied().unwrap_or(if local.is_ipv4() {
                SocketAddr::from(([192, 0, 2, 1], 9))
            } else {
                SocketAddr::from((Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1), 9))
            });
            let Some(ip) = route_source(probe) else {
                return bad(format!(
                    "the mesh is bound to {local} but this host has no route out: bind a specific address"
                ));
            };
            SocketAddr::new(ip, local.port())
        } else {
            local
        };
        Candidate::host(base, "udp").map_err(NodeError::transport)?;
        let session = new_session()?;
        let limits = ns::RelayLimits {
            messages: ns::RelayMessageLimits {
                max_size: Some(MAX_RELAY_MESSAGE),
            },
            ..ns::RelayLimits::default()
        };
        let client = ns::Client::builder()
            .relay_limits(limits)
            .verify_subscriptions(true)
            .build();
        for url in &cfg.relays {
            client
                .add_relay(url.as_str())
                .await
                .map_err(NodeError::relay)?;
        }
        let notifications = client.notifications();
        client.connect().and_wait(GATHER_TIMEOUT).await;
        let portmap = (cfg.portmapper && base.is_ipv4())
            .then(|| NonZeroU16::new(local.port()))
            .flatten()
            .map(|port| {
                let pm = portmapper::Client::new(portmapper::Config::default());
                pm.update_local_port(port);
                pm.procure_mapping();
                let rx = pm.watch_external_address();
                (pm, rx)
            });
        let now = Instant::now();
        let status = Arc::new(Mutex::new(MeshStatus::default()));
        let session_key = session.pubkey().to_owned();
        let nostr_stun = cfg.stun_from_nostr.then(NostrStun::default);
        let state = State {
            session,
            client: client.clone(),
            uploader: Uploader::new(socket.clone(), store, now),
            base,
            public: cfg.public,
            stun: Stun::new(cfg.stun.clone(), now),
            nostr_stun,
            portmapped: None,
            gathered: false,
            started: now,
            rooms: HashMap::new(),
            waiting: Vec::new(),
            subs: Vec::new(),
            sub_seq: 0,
            next_sub_check: now,
            next_refresh: now + REFRESH_EVERY,
            links: Vec::new(),
            max_peers: cfg.max_peers,
            max_per_room: MAX_PEERS_PER_ROOM.min(cfg.max_peers),
            next_presence: now,
            status: status.clone(),
            counts: MeshStatus::default(),
            #[cfg(test)]
            sent: Vec::new(),
        };
        let (control, commands) = mpsc::channel(64);
        let task = tokio::spawn(run(state, socket, commands, notifications, portmap));
        Ok(Self {
            control,
            task,
            client,
            local,
            public: cfg.public,
            session: session_key,
            status,
        })
    }

    /// The UDP address the endpoint is bound to.
    #[must_use]
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// The public address in front of it ([`MeshConfig::public`]), when there is one.
    #[must_use]
    pub fn public_addr(&self) -> Option<SocketAddr> {
        self.public
    }

    /// This run's session key (64 lowercase hex): what relays and peers see, never the
    /// node's identity.
    #[must_use]
    pub fn session_key(&self) -> &str {
        &self.session
    }

    /// What the endpoint is doing now.
    #[must_use]
    pub fn status(&self) -> MeshStatus {
        self.status
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Whether the endpoint is still running (a panic in its task would end it).
    #[must_use]
    pub fn is_running(&self) -> bool {
        !self.task.is_finished()
    }

    /// Join the rooms of a verified hash list: one per rendition whose VOD playlist is in
    /// `store`, of the renditions `only` names (every one when `None`). Returns the rendition
    /// ids joined (once candidates are gathered).
    pub async fn serve(
        &self,
        list: &HashList,
        store: &dyn ContentStore,
        only: Option<&[String]>,
    ) -> Result<Vec<String>> {
        let video = VideoAddr::parse(&list.video)?;
        let network = video.namespace().to_string();
        let mut specs = Vec::new();
        let mut ids = Vec::new();
        for (id, segments) in crate::rtc_serve::vod_renditions(list, store, only) {
            specs.push(RoomSpec {
                room: Room::derive(&video.web_stream_swarm_id(&id)),
                segments,
                network: network.clone(),
            });
            ids.push(id);
        }
        self.control
            .send(Control::Serve(specs))
            .await
            .map_err(|_| NodeError::Transport("the mesh stopped".into()))?;
        Ok(ids)
    }

    /// Leave a video's rooms (its creator deleted it) and drop their connections.
    pub async fn forget(&self, list: &HashList) -> Result<()> {
        let video = VideoAddr::parse(&list.video)?;
        let rooms = list
            .renditions
            .iter()
            .map(|r| {
                Room::derive(&video.web_stream_swarm_id(&r.id))
                    .pubkey()
                    .to_owned()
            })
            .collect();
        self.control
            .send(Control::Forget(rooms, video.to_string()))
            .await
            .map_err(|_| NodeError::Transport("the mesh stopped".into()))
    }

    /// Count the `stun` endpoints of the live beacons of `manifest_a` (a manifest address,
    /// `38504:<creator>:<namespace>:<video-id>`) among the STUN servers named over Nostr
    /// (NFX-10 §1), as read on the mesh's relays. Nothing when [`MeshConfig::stun_from_nostr`]
    /// is off. [`Mesh::forget`] of the video stops it.
    pub async fn stun_from_beacons_of(&self, manifest_a: &str) -> Result<()> {
        nfx_proto::beacon::parse_a_tag(manifest_a)?;
        self.control
            .send(Control::Beacons(manifest_a.to_owned()))
            .await
            .map_err(|_| NodeError::Transport("the mesh stopped".into()))
    }

    /// Leave every room (a `disconnect` to the relays, best effort, for at most 2 s), close
    /// every connection and the relay connections.
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self.control.send(Control::Shutdown(tx)).await.is_ok() {
            let _ = tokio::time::timeout(SHUTDOWN_WAIT * 2, rx).await;
        }
        self.client.shutdown().await;
    }
}

/// STUN requests in flight and the mappings servers reported.
struct Stun {
    /// The servers asked: the configured ones, then any learnt from Nostr.
    servers: Vec<SocketAddr>,
    /// The configured ones ([`MeshConfig::stun`]).
    configured: Vec<SocketAddr>,
    /// By transaction id: the server, the sends so far and when the next is due.
    pending: HashMap<[u8; 12], (SocketAddr, u32, Instant)>,
    /// Per server, the mapping it last reported.
    mapped: HashMap<SocketAddr, SocketAddr>,
    next_round: Instant,
}

impl Stun {
    fn new(servers: Vec<SocketAddr>, now: Instant) -> Self {
        Self {
            configured: servers.clone(),
            servers,
            pending: HashMap::new(),
            mapped: HashMap::new(),
            next_round: now,
        }
    }
}

/// One source of STUN server names: a signer's newest beacon for one video, or its newest
/// announcement of one server.
#[derive(Debug, Clone)]
struct Named {
    created_at: u64,
    expiration: u64,
    /// The order heard, for ties.
    heard: u64,
    /// At most [`MAX_STUN_ADDRS`] (a beacon may carry more `stun` endpoints than one).
    addrs: Vec<String>,
    /// An announcement's networks: it counts only while a room of one of them is joined.
    /// `None` for a beacon, which counts while its video is watched.
    networks: Option<Vec<String>>,
}

/// STUN servers named over Nostr (NFX-10 §1): what to read, and what was read.
#[derive(Debug, Default)]
struct NostrStun {
    /// The manifest addresses whose beacons count.
    watched: BTreeSet<String>,
    /// By (signer, source): a source is `beacon <a>` or `announcement <server>`.
    named: HashMap<(String, String), Named>,
    heard: u64,
    subs: Vec<(ns::SubscriptionId, ns::Filter)>,
    sub_seq: u64,
}

impl NostrStun {
    /// Take what a source names now, if it is newer than what it named before. An empty
    /// list names nothing and is kept until it expires (within the same bounds), so an older
    /// event replayed later does not bring back what the newer one withdrew. False if
    /// nothing changed.
    fn note(&mut self, signer: &str, source: String, named: Named, now: u64) -> bool {
        let key = (signer.to_owned(), source);
        match self.named.get(&key) {
            Some(held) if held.created_at >= named.created_at => return false,
            Some(_) => {}
            None => {
                if self.named.len() >= MAX_NAMED {
                    self.named.retain(|_, n| n.expiration > now);
                }
                let mine = self.named.keys().filter(|(s, _)| s == signer).count();
                if self.named.len() >= MAX_NAMED || mine >= NAMED_PER_KEY {
                    return false;
                }
            }
        }
        self.heard += 1;
        let heard = self.named.get(&key).map_or(self.heard, |n| n.heard);
        self.named.insert(key, Named { heard, ..named });
        true
    }

    /// The live (signer, address) pairs, in the order first heard: beacons', and those of
    /// announcements for one of `networks`.
    fn pairs(&mut self, now: u64, networks: &BTreeSet<String>) -> Vec<(String, String)> {
        self.named.retain(|_, n| n.expiration > now);
        let mut sources: Vec<(&(String, String), &Named)> = self
            .named
            .iter()
            .filter(|(_, n)| {
                n.networks
                    .as_ref()
                    .is_none_or(|nets| nets.iter().any(|x| networks.contains(x)))
            })
            .collect();
        sources.sort_by_key(|(_, n)| n.heard);
        sources
            .into_iter()
            .flat_map(|((signer, _), n)| n.addrs.iter().map(move |a| (signer.clone(), a.clone())))
            .collect()
    }
}

/// A connection with one peer in one room: who offered, and where the negotiation stands.
struct Link {
    /// `conn.swarm` is the room key, `conn.remote` the peer's session key.
    conn: Conn,
    offerer: bool,
    /// The offer's event id: ours (offerer) or the peer's (answerer).
    offer_id: String,
    /// Ours, until the answer arrives.
    pending: Option<SdpPendingOffer>,
    /// By when the next step (the answer, or the open channel) must happen.
    deadline: Instant,
    opened: bool,
    /// Replaced by a newer negotiation with the same peer: its end is no failure.
    superseded: bool,
}

/// A joined room.
struct RoomState {
    room: Room,
    swarm: Swarm,
    presence: PresenceBook,
    seen: SeenIds,
    limiter: SenderLimiter,
    backoff: OfferBackoff,
    /// When this room's presence may next go out of turn ([`REANNOUNCE_EVERY`]).
    reannounce_at: Instant,
    /// The video's network (its namespace).
    network: String,
}

struct State {
    session: Session,
    client: ns::Client,
    uploader: Uploader,
    /// The socket's own address: a host candidate unless `public` is set and it is not
    /// public; what a peer's candidates are judged from ([`sdp::filter_candidates`]).
    base: SocketAddr,
    /// The public address of a DNAT in front of the socket ([`MeshConfig::public`]).
    public: Option<SocketAddr>,
    stun: Stun,
    /// STUN servers named over Nostr, when it learns them ([`MeshConfig::stun_from_nostr`]).
    nostr_stun: Option<NostrStun>,
    portmapped: Option<SocketAddr>,
    gathered: bool,
    started: Instant,
    /// By room key.
    rooms: HashMap<String, RoomState>,
    /// Rooms to join once candidates are gathered.
    waiting: Vec<RoomSpec>,
    /// Our subscriptions, each with its filter.
    subs: Vec<(ns::SubscriptionId, ns::Filter)>,
    sub_seq: u64,
    next_sub_check: Instant,
    next_refresh: Instant,
    links: Vec<Link>,
    max_peers: usize,
    max_per_room: usize,
    next_presence: Instant,
    status: Arc<Mutex<MeshStatus>>,
    counts: MeshStatus,
    /// Every event published, for the unit tests.
    #[cfg(test)]
    sent: Vec<Event>,
}

type Notifications = Pin<Box<dyn Stream<Item = ns::ClientNotification> + Send>>;
type PortMap = (
    portmapper::Client,
    watch::Receiver<Option<std::net::SocketAddrV4>>,
);

async fn run(
    mut state: State,
    socket: Arc<UdpSocket>,
    mut control: mpsc::Receiver<Control>,
    mut notifications: Notifications,
    portmap: Option<PortMap>,
) {
    // Without a portmapper, a channel whose sender is gone: `watching` stays false.
    let (mapper, mut mapped) = match portmap {
        Some((pm, rx)) => (Some(pm), rx),
        None => (None, watch::channel(None).1),
    };
    let mut watching = mapper.is_some();
    let mut buf = vec![0u8; 2048];
    state.timeout().await;
    loop {
        let wake = tokio::time::Instant::from_std(state.next_wake());
        tokio::select! {
            c = control.recv() => match c {
                Some(Control::Shutdown(done)) => {
                    state.shutdown().await;
                    let _ = done.send(());
                    break;
                }
                Some(c) => {
                    state.control(c).await;
                    state.publish_status();
                }
                None => break,
            },
            n = notifications.next() => match n {
                Some(ns::ClientNotification::Event { event, .. }) => state.on_event(&event),
                Some(ns::ClientNotification::Shutdown) | None => break,
                Some(_) => {}
            },
            r = socket.recv_from(&mut buf) => {
                if let Ok((n, source)) = r {
                    state.receive(&buf[..n], source);
                }
            }
            r = mapped.changed(), if watching => match r {
                Ok(()) => {
                    state.portmapped = (*mapped.borrow_and_update()).map(SocketAddr::V4);
                    state.publish_status();
                }
                Err(_) => watching = false,
            },
            () = tokio::time::sleep_until(wake) => state.timeout().await,
        }
        state.pump_all();
    }
    state.publish_status();
}

impl State {
    fn me(&self) -> &str {
        self.session.pubkey()
    }

    fn next_wake(&self) -> Instant {
        let soon = Instant::now() + Duration::from_millis(500);
        let mut wake = soon
            .min(self.next_sub_check)
            .min(self.stun.next_round)
            .min(self.next_presence);
        for (_, _, at) in self.stun.pending.values() {
            wake = wake.min(*at);
        }
        for l in &self.links {
            wake = wake.min(l.conn.wake).min(l.deadline);
        }
        wake
    }

    /// Where every datagram the socket receives is taken as sent: the public address of the
    /// DNAT in front of it, or its own.
    fn arrival(&self) -> SocketAddr {
        self.public.unwrap_or(self.base)
    }

    /// The local candidates every new connection gets, each address once: the public address
    /// (host) when there is one, the socket's own (host), then each distinct mapping a STUN
    /// server or the gateway reported (server reflexive; one from a server learnt over Nostr
    /// only if global unicast, [`State::stun_response`]). With a public address, none but it
    /// whose address is not public: neither the socket's address behind the DNAT nor a
    /// private mapping. A server-reflexive candidate's base is [`State::arrival`] (str0m
    /// writes no `raddr` of ours, but hashes the base into the foundation), so nothing in
    /// the SDP is derived from an address left out.
    fn candidates(&self) -> Vec<Candidate> {
        let only_public = self.public.is_some();
        let hosts = self
            .public
            .into_iter()
            .chain([self.base])
            .map(|a| (a, true));
        let mapped = self
            .stun
            .servers
            .iter()
            .filter_map(|s| self.stun.mapped.get(s))
            .chain(self.portmapped.as_ref())
            .map(|a| (*a, false));
        let mut out = Vec::new();
        let mut seen = Vec::new();
        for (i, (addr, host)) in hosts.chain(mapped).enumerate() {
            let given = i == 0 && only_public;
            if out.len() >= MAX_LOCAL_CANDIDATES
                || seen.contains(&addr)
                || (only_public && !given && !is_public(&addr))
            {
                continue;
            }
            let c = if host {
                Candidate::host(addr, "udp")
            } else {
                Candidate::server_reflexive(addr, self.arrival(), "udp")
            };
            if let Ok(c) = c {
                seen.push(addr);
                out.push(c);
            }
        }
        out
    }

    fn new_rtc(&self, now: Instant) -> Rtc {
        let mut rtc = Rtc::builder().build(now);
        for c in self.candidates() {
            rtc.add_local_candidate(c);
        }
        rtc
    }

    fn publish_status(&mut self) {
        let mut s = self.counts.clone();
        s.gathered = self.gathered;
        s.candidates = self
            .candidates()
            .iter()
            .map(|c| format!("{} {}", c.kind(), c.addr()))
            .collect();
        s.stun = self.stun.servers.iter().map(ToString::to_string).collect();
        s.rooms = self.rooms.len();
        s.open = self.links.iter().filter(|l| l.opened).count();
        s.connecting = self.links.len() - s.open;
        *self.status.lock().unwrap_or_else(PoisonError::into_inner) = s;
    }

    /// Send a signed event to every relay now; never queued or replayed (NFX-10 §6.4).
    fn publish(&mut self, ev: &Event) {
        #[cfg(test)]
        self.sent.push(ev.clone());
        let Ok(ev) = to_nostr(ev) else {
            return;
        };
        let client = self.client.clone();
        tokio::spawn(async move {
            let _ = client.send_event(&ev).ok_timeout(SEND_TIMEOUT).await;
        });
    }

    async fn control(&mut self, c: Control) {
        match c {
            Control::Serve(specs) => {
                self.waiting.extend(specs);
                if self.gathered {
                    self.join_waiting().await;
                }
            }
            Control::Beacons(a) => {
                if let Some(n) = &mut self.nostr_stun
                    && n.watched.insert(a)
                {
                    self.resubscribe_stun().await;
                }
            }
            Control::Forget(keys, video) => {
                if let Some(n) = &mut self.nostr_stun {
                    // `38504:<creator>:<video>`: the watched addresses of that video.
                    n.watched
                        .retain(|a| a.splitn(3, ':').nth(2) != Some(video.as_str()));
                    n.named.retain(|(_, source), _| {
                        source
                            .strip_prefix("beacon ")
                            .is_none_or(|a| a.splitn(3, ':').nth(2) != Some(video.as_str()))
                    });
                }
                self.waiting
                    .retain(|s| !keys.iter().any(|k| k == s.room.pubkey()));
                let mut changed = false;
                for k in &keys {
                    if let Some(r) = self.rooms.remove(k) {
                        changed = true;
                        if let Ok(ev) = self.session.disconnect(&r.room, unix_now()) {
                            self.publish(&ev);
                        }
                    }
                    for l in self.links.iter_mut().filter(|l| &l.conn.swarm == k) {
                        l.conn.dead = true;
                        l.superseded = true;
                    }
                }
                if changed {
                    self.resubscribe().await;
                }
                self.resubscribe_stun().await;
                // What the video's beacons named, and announcements for a network no room is
                // in any more, count no longer.
                let networks = self.networks();
                if let Some(n) = &mut self.nostr_stun {
                    n.named.retain(|_, x| {
                        x.networks
                            .as_ref()
                            .is_none_or(|nets| nets.iter().any(|y| networks.contains(y)))
                    });
                }
                self.select_stun(Instant::now(), true);
            }
            Control::Shutdown(_) => {}
        }
    }

    /// Join the rooms waiting for candidates: subscribe, then announce presence in each.
    async fn join_waiting(&mut self) {
        let mut joined = Vec::new();
        for spec in std::mem::take(&mut self.waiting) {
            let key = spec.room.pubkey().to_owned();
            if self.rooms.len() >= MAX_ROOMS && !self.rooms.contains_key(&key) {
                continue;
            }
            let loaded = self.uploader.loaded(&spec.segments);
            // A video served again (a re-seed) keeps its room's books.
            let r = self.rooms.entry(key.clone()).or_insert_with(|| RoomState {
                room: spec.room,
                swarm: Swarm {
                    segments: Vec::new(),
                    loaded: Vec::new(),
                },
                presence: PresenceBook::default(),
                seen: SeenIds::default(),
                limiter: SenderLimiter::default(),
                backoff: OfferBackoff::default(),
                reannounce_at: Instant::now(),
                network: spec.network.clone(),
            });
            r.swarm = Swarm {
                segments: spec.segments,
                loaded,
            };
            joined.push(key);
        }
        if joined.is_empty() {
            return;
        }
        // Peers already connected in a room that grew hear its new state.
        for l in self.links.iter_mut().filter(|l| l.opened) {
            if let Some(r) = self.rooms.get(&l.conn.swarm)
                && joined.contains(&l.conn.swarm)
            {
                let announcement = crate::p2pml::Command::Announcement {
                    loaded: announceable(&r.swarm.loaded),
                    loading: vec![],
                };
                queue(&mut l.conn, None, &announcement);
            }
        }
        self.resubscribe().await;
        self.resubscribe_stun().await;
        let now = unix_now();
        for key in joined {
            if let Some(r) = self.rooms.get(&key)
                && let Ok(ev) = self.session.connect(&r.room, now)
            {
                self.publish(&ev);
            }
        }
    }

    /// Replace the subscriptions with ones for the rooms joined now, on every relay.
    async fn resubscribe(&mut self) {
        for (id, _) in std::mem::take(&mut self.subs) {
            let _ = self.client.unsubscribe(&id).await;
        }
        let mut keys: Vec<String> = self.rooms.keys().cloned().collect();
        keys.sort();
        let since = ns::Timestamp::from(unix_now().saturating_sub(signal::MAX_AGE));
        for chunk in keys.chunks(ROOMS_PER_SUB) {
            self.sub_seq += 1;
            let id = ns::SubscriptionId::new(format!("nfx-mesh-{}", self.sub_seq));
            let filter = ns::Filter::new()
                .kind(ns::Kind::from(signal::KIND_SIGNAL))
                .custom_tags(ns::SingleLetterTag::UPPERCASE_P, chunk.iter().cloned())
                .since(since);
            self.subs.push((id, filter));
        }
        self.next_sub_check = Instant::now();
        self.check_subscriptions().await;
    }

    /// The networks of the rooms joined: announcements for them count.
    fn networks(&self) -> BTreeSet<String> {
        self.rooms.values().map(|r| r.network.clone()).collect()
    }

    /// Replace the subscriptions that learn STUN servers (NFX-10 §1) with ones for the videos
    /// watched (their beacons) and the networks of the rooms joined (announcements).
    async fn resubscribe_stun(&mut self) {
        let networks = self.networks();
        let Some(n) = &mut self.nostr_stun else {
            return;
        };
        let watched: Vec<String> = n.watched.iter().cloned().collect();
        let networks: Vec<String> = networks.into_iter().collect();
        let mut filters = Vec::new();
        for chunk in watched.chunks(TAGS_PER_SUB) {
            filters.push(
                ns::Filter::new()
                    .kind(ns::Kind::from(KIND_BEACON))
                    .custom_tags(ns::SingleLetterTag::LOWERCASE_A, chunk.iter().cloned()),
            );
        }
        for chunk in networks.chunks(TAGS_PER_SUB) {
            filters.push(
                ns::Filter::new()
                    .kind(ns::Kind::from(KIND_STUN_ANNOUNCEMENT))
                    .custom_tags(ns::SingleLetterTag::LOWERCASE_N, chunk.iter().cloned())
                    .limit(ANNOUNCEMENTS_ASKED),
            );
        }
        if n.subs.iter().map(|(_, f)| f).eq(filters.iter()) {
            return;
        }
        let old = std::mem::take(&mut n.subs);
        for f in filters {
            n.sub_seq += 1;
            n.subs.push((
                ns::SubscriptionId::new(format!("nfx-stun-{}", n.sub_seq)),
                f,
            ));
        }
        for (id, _) in old {
            let _ = self.client.unsubscribe(&id).await;
        }
        self.next_sub_check = Instant::now();
        self.check_subscriptions().await;
    }

    /// Every connected relay holds every subscription; one that lacked some (it connected
    /// late, reconnected, or closed one) gets them, and this node's presence in every room.
    async fn check_subscriptions(&mut self) {
        let now = Instant::now();
        if now < self.next_sub_check {
            return;
        }
        self.next_sub_check = now + SUB_CHECK;
        let stun_subs: Vec<(ns::SubscriptionId, ns::Filter)> = self
            .nostr_stun
            .as_ref()
            .map(|n| n.subs.clone())
            .unwrap_or_default();
        for (url, relay) in self.client.relays().await {
            if !relay.status().is_connected() {
                continue;
            }
            for (id, filter) in &stun_subs {
                if relay.subscription(id).await.is_none() {
                    let _ = self
                        .client
                        .subscribe(ns::ReqTarget::single(url.clone(), [filter.clone()]))
                        .with_id(id.clone())
                        .await;
                }
            }
            let mut fresh = false;
            for (id, filter) in &self.subs {
                if relay.subscription(id).await.is_none() {
                    fresh = true;
                    let _ = self
                        .client
                        .subscribe(ns::ReqTarget::single(url.clone(), [filter.clone()]))
                        .with_id(id.clone())
                        .await;
                }
            }
            if fresh {
                let created_at = unix_now();
                let events: Vec<ns::Event> = self
                    .rooms
                    .values()
                    .filter_map(|r| self.session.connect(&r.room, created_at).ok())
                    .filter_map(|ev| to_nostr(&ev).ok())
                    .collect();
                tokio::spawn(async move {
                    for ev in events {
                        let _ = relay.send_event(&ev).ok_timeout(SEND_TIMEOUT).await;
                    }
                });
            }
        }
    }

    async fn shutdown(&mut self) {
        let now = unix_now();
        let events: Vec<ns::Event> = self
            .rooms
            .values()
            .filter_map(|r| self.session.disconnect(&r.room, now).ok())
            .filter_map(|ev| to_nostr(&ev).ok())
            .collect();
        let client = self.client.clone();
        let sends = async move {
            for ev in events {
                let _ = client.send_event(&ev).ok_timeout(SHUTDOWN_WAIT).await;
            }
        };
        let _ = tokio::time::timeout(SHUTDOWN_WAIT, sends).await;
        for l in &mut self.links {
            self.uploader.close(&mut l.conn);
        }
        self.links.clear();
        self.rooms.clear();
    }

    // ---- STUN -----------------------------------------------------------------------------

    fn stun_send(&mut self, server: SocketAddr, tries: u32, now: Instant) {
        let Some(tid) = random::<12>() else {
            return;
        };
        let _ = self
            .uploader
            .socket
            .try_send_to(&stun::binding_request(&tid), server);
        self.stun
            .pending
            .insert(tid, (server, tries + 1, now + STUN_RTO * (1 << tries)));
    }

    /// The servers to ask (NFX-10 §1): the configured ones, then those Nostr names that the
    /// rules pick, of the socket's family. A server picked anew is asked at once (with `ask`;
    /// else at the round about to start); one no longer picked is forgotten, with its mapping.
    fn select_stun(&mut self, now: Instant, ask: bool) {
        let networks = self.networks();
        let Some(n) = &mut self.nostr_stun else {
            return;
        };
        let v4 = self.base.is_ipv4();
        let pairs: Vec<(String, String)> = n
            .pairs(unix_now(), &networks)
            .into_iter()
            .filter(|(_, a)| a.parse::<SocketAddr>().is_ok_and(|a| a.is_ipv4() == v4))
            .collect();
        let own: Vec<String> = self
            .stun
            .configured
            .iter()
            .map(ToString::to_string)
            .collect();
        let chosen: Vec<SocketAddr> = nfx_proto::stun::select(
            &own,
            pairs.iter().map(|(k, a)| (k.as_str(), a.as_str())),
            MAX_STUN,
        )
        .iter()
        .filter_map(|a| a.parse().ok())
        .collect();
        if chosen == self.stun.servers {
            return;
        }
        let fresh: Vec<SocketAddr> = chosen
            .iter()
            .filter(|s| !self.stun.servers.contains(s))
            .copied()
            .collect();
        self.stun.mapped.retain(|s, _| chosen.contains(s));
        self.stun.pending.retain(|_, (s, _, _)| chosen.contains(s));
        self.stun.servers = chosen;
        if ask {
            for server in fresh {
                self.stun_send(server, 0, now);
            }
        }
        self.publish_status();
    }

    /// Start a round, retransmit what is due, and end gathering once the first round is
    /// answered or timed out, or [`GATHER_TIMEOUT`] has passed.
    fn stun_tick(&mut self, now: Instant) {
        if now >= self.stun.next_round {
            // What expired is no longer counted.
            self.select_stun(now, false);
            self.stun.next_round = now + STUN_REFRESH;
            self.stun.pending.clear();
            for server in self.stun.servers.clone() {
                self.stun_send(server, 0, now);
            }
        }
        let due: Vec<([u8; 12], SocketAddr, u32)> = self
            .stun
            .pending
            .iter()
            .filter(|(_, (_, _, at))| *at <= now)
            .map(|(tid, (server, tries, _))| (*tid, *server, *tries))
            .collect();
        for (tid, server, tries) in due {
            self.stun.pending.remove(&tid);
            if tries < STUN_TRIES {
                self.stun_send(server, tries, now);
            }
        }
    }

    /// A STUN response from a server, for a request of ours: note its mapping. False if the
    /// datagram is not one.
    fn stun_response(&mut self, bytes: &[u8], source: SocketAddr) -> bool {
        let Some(tid) = stun::transaction(bytes) else {
            return false;
        };
        let Some(&(server, _, _)) = self.stun.pending.get(&tid) else {
            return false;
        };
        if server != source {
            return false;
        }
        self.stun.pending.remove(&tid);
        // A server learnt over Nostr is anyone's: its mapping is offered only if it is global
        // unicast, so a lying one never points peers at a private address (NFX-10 §1).
        let learnt = !self.stun.configured.contains(&server);
        if let Some(addr) = stun::mapped(bytes).filter(|a| {
            a.is_ipv4() == self.base.is_ipv4()
                && (!learnt || nfx_proto::stun::is_global_unicast(a.ip()))
        }) {
            self.stun.mapped.insert(server, addr);
        }
        true
    }

    // ---- network ----------------------------------------------------------------------------

    fn receive(&mut self, bytes: &[u8], source: SocketAddr) {
        if self.stun_response(bytes, source) {
            self.publish_status();
            return;
        }
        let Some(input) = received(bytes, source, self.arrival(), Instant::now()) else {
            return;
        };
        if let Some(l) = self
            .links
            .iter_mut()
            .find(|l| !l.conn.dead && l.conn.rtc.accepts(&input))
            && l.conn.rtc.handle_input(input).is_err()
        {
            l.conn.dead = true;
        }
    }

    async fn timeout(&mut self) {
        let now = Instant::now();
        self.stun_tick(now);
        if !self.gathered
            && (now >= self.started + GATHER_TIMEOUT
                || (self.stun.pending.is_empty() && self.stun.next_round > now))
        {
            self.gathered = true;
            // join_waiting announces the rooms it joins; the next round is a period later.
            self.next_presence = now + Duration::from_secs(signal::PRESENCE_INTERVAL);
            self.publish_status();
            self.join_waiting().await;
        }
        for l in &mut self.links {
            if l.conn.dead {
                continue;
            }
            let late = !l.opened && now >= l.deadline;
            let idle = l.opened && now.duration_since(l.conn.active) > IDLE_TIMEOUT;
            if late
                || idle
                || (l.conn.wake <= now && l.conn.rtc.handle_input(Input::Timeout(now)).is_err())
            {
                l.conn.dead = true;
            }
        }
        if self.gathered && now >= self.next_presence {
            self.next_presence = now + Duration::from_secs(signal::PRESENCE_INTERVAL);
            let at = unix_now();
            for r in self.rooms.values_mut() {
                r.presence.prune(at);
            }
            let events: Vec<Event> = self
                .rooms
                .values()
                .filter_map(|r| self.session.connect(&r.room, at).ok())
                .collect();
            for ev in &events {
                self.publish(ev);
            }
        }
        if now >= self.next_refresh {
            self.next_refresh = now + REFRESH_EVERY;
            self.refresh_loaded();
        }
        self.check_subscriptions().await;
        self.publish_status();
    }

    /// Rooms whose rendition is not all in the store yet: what arrived is announced to the
    /// peers connected there.
    fn refresh_loaded(&mut self) {
        for (key, r) in &mut self.rooms {
            if r.swarm.loaded.len() >= r.swarm.segments.len() {
                continue;
            }
            let loaded = self.uploader.loaded(&r.swarm.segments);
            if loaded.len() <= r.swarm.loaded.len() {
                continue;
            }
            let announcement = crate::p2pml::Command::Announcement {
                loaded: announceable(&loaded),
                loading: vec![],
            };
            for l in self
                .links
                .iter_mut()
                .filter(|l| l.opened && !l.conn.dead && &l.conn.swarm == key)
            {
                queue(&mut l.conn, None, &announcement);
            }
            r.swarm.loaded = loaded;
        }
    }

    fn pump_all(&mut self) {
        let now = Instant::now();
        let mut links = std::mem::take(&mut self.links);
        for l in &mut links {
            if l.conn.dead {
                continue;
            }
            let served = l.conn.served;
            let swarm = self.rooms.get(&l.conn.swarm).map(|r| &r.swarm);
            self.uploader.pump(&mut l.conn, swarm, now);
            if !l.opened && l.conn.channel.is_some() {
                l.opened = true;
                self.counts.opened += 1;
            }
            if l.conn.served > served {
                self.counts.served += l.conn.served - served;
                if served == 0
                    && let Some(r) = self.rooms.get_mut(&l.conn.swarm)
                {
                    r.backoff.succeeded(&l.conn.remote);
                }
            }
        }
        for l in links
            .iter_mut()
            .filter(|l| l.conn.dead || !l.conn.rtc.is_alive())
        {
            self.uploader.close(&mut l.conn);
            if l.superseded {
                continue;
            }
            // A connection that never opened failed; one that opened and served nothing is
            // not worth offering again at the next presence either.
            if !l.opened {
                self.counts.failed += 1;
            }
            if (!l.opened || l.conn.served == 0)
                && let Some(r) = self.rooms.get_mut(&l.conn.swarm)
            {
                r.backoff.failed(&l.conn.remote, now);
            }
        }
        links.retain(|l| !l.conn.dead && l.conn.rtc.is_alive());
        self.links = links;
    }

    // ---- signaling --------------------------------------------------------------------------

    fn on_event(&mut self, event: &ns::Event) {
        match event.kind.as_u16() {
            KIND_BEACON => return self.on_beacon(event),
            KIND_STUN_ANNOUNCEMENT => return self.on_announcement(event),
            _ => {}
        }
        // Our own come back from every relay: dropped before anything else.
        if event.pubkey.to_hex() == self.me() {
            return;
        }
        let Ok(ev) = from_nostr(event) else {
            return;
        };
        let Some(key) = ev
            .tag_values("P")
            .next()
            .and_then(|v| v.first())
            .filter(|k| self.rooms.contains_key(*k))
            .cloned()
        else {
            return;
        };
        let now = unix_now();
        let me = self.me().to_owned();
        let Some(room) = self.rooms.get_mut(&key) else {
            return;
        };
        if room.seen.has(&ev.id) {
            return;
        }
        let Ok(Parsed::Ours(r)) = signal::read(&ev, &key, &me, now) else {
            return;
        };
        room.seen.add(&r.id, now);
        match &r.signal {
            Signal::Connect { expiration } => {
                let new = !room.presence.present(&r.sender, now);
                if !room
                    .presence
                    .add(&r.sender, r.created_at, Some(*expiration), now)
                {
                    return;
                }
                if signal::offers_to(&me, &r.sender) {
                    self.maybe_offer(&key, &r.sender);
                } else if new && Instant::now() >= room.reannounce_at {
                    // A newcomer that is to offer heard nothing of this node yet (relays keep
                    // no ephemeral event): tell it now rather than at the next round.
                    room.reannounce_at = Instant::now() + REANNOUNCE_EVERY;
                    if let Ok(ev) = self.session.connect(&room.room, now) {
                        self.publish(&ev);
                    }
                }
            }
            Signal::Disconnect => {
                room.presence.add(&r.sender, r.created_at, None, now);
            }
            Signal::Offer { .. } => self.on_offer(&key, &r),
            Signal::Answer { offer, .. } => {
                let offer = offer.clone();
                self.on_answer(&key, &r, &offer);
            }
        }
    }

    /// A beacon of a watched video: the STUN servers its `stun` endpoint names (none, if it
    /// has none: the signer's newer beacon withdraws what its older one named).
    fn on_beacon(&mut self, event: &ns::Event) {
        let Some(n) = &mut self.nostr_stun else {
            return;
        };
        let Ok(ev) = from_nostr(event) else {
            return;
        };
        // The cheap check first: a beacon of a video this node does not watch costs nothing more.
        let Some(a) = ev
            .tag_values("a")
            .next()
            .and_then(|v| v.first())
            .filter(|a| n.watched.contains(*a))
            .cloned()
        else {
            return;
        };
        let now = unix_now();
        let Ok(b) = Beacon::from_event(&ev, now) else {
            return;
        };
        if format!("{KIND_MANIFEST}:{}:{}", b.creator, b.content.video) != a {
            return;
        }
        let mut addrs: Vec<String> = Vec::new();
        for addr in b.content.endpoints.iter().flat_map(|e| match e {
            Endpoint::Stun { addrs } => addrs.as_slice(),
            _ => &[] as &[String],
        }) {
            if addrs.len() >= MAX_STUN_ADDRS {
                break;
            }
            if !addrs.contains(addr) {
                addrs.push(addr.clone());
            }
        }
        let named = Named {
            created_at: b.created_at,
            expiration: b.expiration,
            heard: 0,
            addrs,
            networks: None,
        };
        if n.note(&b.seeder, format!("beacon {a}"), named, now) {
            self.select_stun(Instant::now(), true);
        }
    }

    /// A STUN service announcement for a network of a room joined.
    fn on_announcement(&mut self, event: &ns::Event) {
        let networks = self.networks();
        let Some(n) = &mut self.nostr_stun else {
            return;
        };
        let Ok(ev) = from_nostr(event) else {
            return;
        };
        if !ev
            .tag_values("n")
            .any(|v| v.first().is_some_and(|x| networks.contains(x)))
        {
            return;
        }
        let now = unix_now();
        let Ok(a) = StunAnnouncement::from_event(&ev, now) else {
            return;
        };
        if !a.networks.iter().any(|x| networks.contains(&x.to_string())) {
            return;
        }
        let named = Named {
            created_at: a.created_at,
            expiration: a.expiration,
            heard: 0,
            addrs: vec![a.addr.clone()],
            networks: Some(a.networks.iter().map(ToString::to_string).collect()),
        };
        if n.note(&a.operator, format!("announcement {}", a.addr), named, now) {
            self.select_stun(Instant::now(), true);
        }
    }

    fn link(&self, key: &str, peer: &str) -> Option<usize> {
        self.links
            .iter()
            .position(|l| !l.conn.dead && l.conn.swarm == key && l.conn.remote == peer)
    }

    /// Room for one more connection in `key`: under the cap in all, and in the room.
    fn has_room(&self, key: &str) -> bool {
        let live = || self.links.iter().filter(|l| !l.conn.dead);
        live().count() < self.max_peers
            && live().filter(|l| l.conn.swarm == key).count() < self.max_per_room
    }

    fn negotiating(&self, key: &str) -> usize {
        self.links
            .iter()
            .filter(|l| !l.conn.dead && !l.opened && l.conn.swarm == key)
            .count()
    }

    /// On a peer's presence: offer if this session's key is the lower one, the room has a
    /// free negotiation, fewer than 4 offers of ours are pending, and no failed offer to the
    /// peer is still backing off.
    fn maybe_offer(&mut self, key: &str, peer: &str) {
        if !signal::offers_to(self.me(), peer) || self.link(key, peer).is_some() {
            return;
        }
        if self.negotiating(key) >= NEGOTIATIONS_PER_ROOM || !self.has_room(key) {
            return;
        }
        let offering = self
            .links
            .iter()
            .filter(|l| !l.conn.dead && l.conn.swarm == key && l.pending.is_some())
            .count();
        let now = Instant::now();
        let Some(room) = self.rooms.get(key) else {
            return;
        };
        if offering >= PENDING_OFFERS_PER_ROOM || !room.backoff.allowed(peer, now) {
            return;
        }
        let mut rtc = self.new_rtc(now);
        let mut api = rtc.sdp_api();
        api.add_channel("nfx".into());
        let Some((offer, pending)) = api.apply() else {
            return;
        };
        let Some(nonce) = random::<32>() else {
            return;
        };
        let Ok(ev) =
            self.session
                .offer(&room.room, peer, &offer.to_sdp_string(), &nonce, unix_now())
        else {
            return;
        };
        self.publish(&ev);
        self.counts.offers += 1;
        self.links.push(Link {
            conn: Conn::new(rtc, key.to_owned(), peer.to_owned(), now),
            offerer: true,
            offer_id: ev.id,
            pending: Some(pending),
            deadline: now + ANSWER_TIMEOUT,
            opened: false,
            superseded: false,
        });
    }

    /// An offer to this session: answer it, unless it repeats one being answered or our own
    /// offer to that peer stands (the lower key's offer stands, NFX-10 §6.6).
    fn on_offer(&mut self, key: &str, r: &Received) {
        let held = self.link(key, &r.sender);
        if let Some(i) = held {
            let l = &self.links[i];
            if !l.opened && (!l.offerer || signal::offers_to(self.me(), &r.sender)) {
                return;
            }
        } else if self.negotiating(key) >= NEGOTIATIONS_PER_ROOM || !self.has_room(key) {
            return;
        }
        let now = Instant::now();
        let Some(room) = self.rooms.get_mut(key) else {
            return;
        };
        if !room.limiter.take(&r.sender, now) {
            return;
        }
        let Ok(sdp) = self.session.open(r) else {
            return;
        };
        let Ok(offer) = SdpOffer::from_sdp_string(&sdp::filter_candidates(&sdp, self.base)) else {
            return;
        };
        let mut rtc = self.new_rtc(now);
        let Ok(answer) = rtc.sdp_api().accept_offer(offer) else {
            return;
        };
        let (Some(nonce), Some(room)) = (random::<32>(), self.rooms.get(key)) else {
            return;
        };
        let Ok(ev) = self.session.answer(
            &room.room,
            &r.sender,
            &r.id,
            &answer.to_sdp_string(),
            &nonce,
            unix_now(),
        ) else {
            return;
        };
        // Glare and the peer's key is lower, or a peer that connects again: the new
        // negotiation replaces the old one.
        if let Some(i) = held {
            self.links[i].conn.dead = true;
            self.links[i].superseded = true;
        }
        self.publish(&ev);
        self.counts.answers += 1;
        self.links.push(Link {
            conn: Conn::new(rtc, key.to_owned(), r.sender.clone(), now),
            offerer: false,
            offer_id: r.id.clone(),
            pending: None,
            deadline: now + ANSWERED_TIMEOUT,
            opened: false,
            superseded: false,
        });
    }

    /// The answer to our pending offer to that peer, and only to it.
    fn on_answer(&mut self, key: &str, r: &Received, offer: &str) {
        let Some(i) = self.links.iter().position(|l| {
            !l.conn.dead
                && l.offerer
                && l.pending.is_some()
                && l.conn.swarm == key
                && l.conn.remote == r.sender
                && l.offer_id == offer
        }) else {
            return;
        };
        let now = Instant::now();
        let Some(room) = self.rooms.get_mut(key) else {
            return;
        };
        if !room.limiter.take(&r.sender, now) {
            return;
        }
        let Ok(sdp) = self.session.open(r) else {
            return;
        };
        let base = self.base;
        let l = &mut self.links[i];
        let answer = SdpAnswer::from_sdp_string(&sdp::filter_candidates(&sdp, base));
        let accepted = match (answer, l.pending.take()) {
            (Ok(answer), Some(pending)) => {
                l.conn.rtc.sdp_api().accept_answer(pending, answer).is_ok()
            }
            _ => false,
        };
        if accepted {
            l.deadline = now + OPEN_TIMEOUT;
        } else {
            l.conn.dead = true;
        }
    }
}

#[cfg(test)]
mod tests;
