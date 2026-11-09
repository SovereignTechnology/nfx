//! `nfxd run`: seed, fetch, serve and relay, in one process.
//!
//! Every video is named by its manifest's `a` tag. The manifest is found on the
//! configured relays and verified there (NFX-02), and everything after that is anchored
//! to its `root`:
//! - **seed**: the files are already in the store; announce them (NFX-03, TTL 120,
//!   republished every 60 s).
//! - **fetch**: take the whole video over iroh from seeders learned from verified
//!   beacons, then seed it (a free M1 peer gives back what it watched).
//! - **pull**: hold the video on the origin only, filling misses from the swarm
//!   (NFX-05 §6.2).
//! - **gossip** (NFX-06 §4): every seeded video's swarm hears a signed `here` envelope
//!   with each beacon, and every fetched, pulled or watched video learns seeders from
//!   the swarm as well as from beacons, once it knows a first peer to join through.
//! - **watch** (at runtime, [`Daemon::watch`]): what a viewer does. Hold the video on the
//!   origin so playback can start from on-demand pulls, and fetch it whole in the
//!   background to seed it.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use iroh::RelayUrl;
use nfx_node::bridge::Bridge;
use nfx_node::gossip::{Announcer, Listener, envelope_wire};
use nfx_node::node::{Node, NodeConfig};
use nfx_node::nostr::{BEACON_TTL, ManifestQuery, Relays};
use nfx_node::origin::{Origin, SwarmPull, serve};
use nfx_node::relay::ScopedRelay;
use nfx_node::seed::Seeded;
use nfx_node::store::{ContentStore as _, FsStore};
use nfx_node::tracker::Tracker;
use nfx_node::unix_now;
use nfx_proto::Verified;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint, parse_a_tag};
use nfx_proto::gossip::{Envelope, MAX_ENVELOPE_BYTES, Op};
use nfx_proto::hashlist::HashList;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::Namespace;
use nostr_sdk::prelude::Keys;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::{Error, Result};

/// How often a missing manifest or an unfetched video is retried.
pub const RETRY: Duration = Duration::from_secs(2);
/// How often a namespace's seeder scores are refreshed: NFX-16 §2 reads at most hourly.
pub const RATING_REFRESH: Duration = Duration::from_secs(60 * 60);
/// How soon a failed refresh is retried.
pub const RATING_RETRY: Duration = Duration::from_secs(10 * 60);
/// How often the rating task looks for a namespace it has no scores for yet.
const RATING_TICK: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a node with `iroh_relays` and no `iroh_external` waits to reach one before it
/// seeds without it, with a warning. An iroh relay is extra reachability, never a
/// requirement: beacons name it once it connects. A node with an external address does not
/// wait at all.
pub const RELAY_WAIT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Signs beacons. Required to seed or fetch (a fetched video is seeded).
    pub keys: Option<Keys>,
    pub store: PathBuf,
    /// The node's own state (iroh-blobs' index). Default: `<store>/.nfxd`. Kept on disk so
    /// seeded files are imported by reference, not copied into memory.
    pub state: Option<PathBuf>,
    /// Nostr relays (scoped relays, NFX-04).
    pub relays: Vec<String>,
    /// iroh relays this network runs (NFX-06 §1). Empty: direct connections only.
    pub iroh_relays: Vec<RelayUrl>,
    /// Extra CA roots for those relays' TLS (`--iroh-relay-ca`), beside the compiled-in ones.
    pub iroh_relay_cas: Vec<nfx_node::node::CertificateDer<'static>>,
    /// No direct IP transports: every iroh byte crosses a relay. For proving the relay
    /// path, and for hosts that must not expose UDP.
    pub relay_only: bool,
    /// Bind iroh's UDP socket here (`--iroh-bind`): a fixed port that a NAT or a firewall can
    /// forward. Default: a random port on every interface.
    pub iroh_bind: Option<SocketAddr>,
    /// Where peers on the internet reach this node directly (`--iroh-external`, at most
    /// `nfx_node::node::MAX_EXTERNAL_ADDRS`), such as the public address whose UDP port is
    /// forwarded to `iroh_bind`. Advertised as given; with any set, no interface address that
    /// is not public is advertised. Needs `iroh_bind`.
    pub iroh_external: Vec<SocketAddr>,
    pub seed: Vec<String>,
    pub fetch: Vec<String>,
    pub pull: Vec<String>,
    /// Serve the origin here (HTTP; TLS belongs in front).
    pub origin: Option<SocketAddr>,
    /// An origin with no listener, reached through [`Daemon::origin`] (the desktop app's
    /// `nfx://` scheme). Ignored when `origin` is set, which also provides one.
    pub internal_origin: bool,
    /// The origin's public URL, announced as an `https` endpoint when set.
    pub https_url: Option<String>,
    /// Embed a scoped relay listening here (NFX-04 §7).
    pub embed_relay: Option<SocketAddr>,
    /// After a [`Daemon::watch`] plays, fetch the whole video and seed it: announce it
    /// publicly, signed with this node's key, with this node's addresses. Off by default:
    /// a viewer shares only when it chooses to, and otherwise announces nothing.
    pub seed_watched: bool,
    /// Never ask the local gateway to open a port (see `NodeConfig::no_portmapper`).
    pub no_portmapper: bool,
    /// Embed a WebTorrent tracker for the browser mesh (NFX-10 §2) listening here. It
    /// admits exactly the per-rendition swarms of the videos this node seeds or holds.
    pub embed_tracker: Option<SocketAddr>,
    /// Be a bridge seeder (NFX-10 §2): join those swarms as a WebRTC peer and serve the
    /// stored segments to browsers. UDP on this address, a specific one browsers can reach.
    /// Needs `embed_tracker`.
    pub bridge: Option<SocketAddr>,
    /// The embedded tracker's public URL (`wss://`, behind TLS), announced in beacons as the
    /// bridge's `webrtc` endpoint. Needs `bridge`.
    pub tracker_public_url: Option<String>,
    /// Namespaces the embedded relay serves; by default those of the videos above.
    pub namespaces: Vec<Namespace>,
    /// When non-empty, the embedded relay admits only these creators (x-only pubkey, 64
    /// lowercase hex): their manifests and deletions, and beacons for their videos. It
    /// limits which videos the relay carries, not who may seed them.
    pub allow_creators: Vec<String>,
    /// Join each video's gossip swarm (NFX-06 §4). Off by default: joining lets any swarm
    /// member point this node's endpoint at hosts of its choosing, because iroh-gossip
    /// feeds members' advertised addresses to it unfiltered (independent audit M1, M3).
    /// Nostr beacons carry discovery without it. Refused with `relay_only`.
    pub gossip: bool,
    /// iroh endpoints to bootstrap every video's gossip swarm from, besides the seeders
    /// learned from relay beacons. Each needs an address this node may use (a direct one,
    /// or one of `iroh_relays`). Requires `gossip`.
    pub gossip_peers: Vec<iroh::EndpointAddr>,
    /// How often a seeded video is checked for its creator's deletion (NFX-02 §6).
    /// Default: every beacon republish (60 s).
    pub deletion_check_every: Option<Duration>,
    /// The user's own Nostr key (x-only, 64 lowercase hex). When set, seeder ratings
    /// (NFX-16) by it, the authors it follows and `rating_trusted`, less those it mutes,
    /// order the seeders this node pulls from. Unset (the default): no rating is read, and
    /// seeders are tried as before. Ratings never change what this node grants a watcher.
    pub rating_root: Option<String>,
    /// More authors whose ratings count (NFX-16 §4), 64 lowercase hex. Needs `rating_root`.
    pub rating_trusted: Vec<String>,
    /// General Nostr relays to read follow lists, mute lists and ratings from (NFX-16 §2);
    /// scoped relays (NFX-04) carry neither kind. Needed with `rating_root`.
    pub general_relays: Vec<String>,
}

/// Where each video stands, by `a` tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoState {
    /// Looking for the manifest on the relays.
    Resolving,
    /// Manifest found; waiting for a seeder or fetching.
    Fetching,
    /// Seeding (and on the origin, when there is one).
    Seeding,
    /// Seeding, but the last beacon reached no relay (the reason).
    Unannounced(String),
    /// Ready to seed, and waiting at most [`RELAY_WAIT`] to reach one of the `iroh_relays`
    /// first, so that the first beacons name it (which relay, and for how long). Only a node
    /// with no `iroh_external` waits.
    AwaitingRelay(String),
    /// Withdrawn by its creator (NFX-02 §6): no longer announced. Stored bytes stay.
    Deleted,
    /// On the origin only.
    Serving,
    Failed(String),
}

pub struct Daemon {
    node: Arc<Node>,
    relays: Arc<Relays>,
    embedded: Option<Arc<ScopedRelay>>,
    /// The embedded relay's URL, as this host reaches it.
    pub relay_url: Option<String>,
    /// The embedded tracker's URL, as this host reaches it.
    pub tracker_url: Option<String>,
    /// The bridge's UDP address.
    pub bridge_addr: Option<SocketAddr>,
    pub origin_addr: Option<SocketAddr>,
    state: Arc<Mutex<BTreeMap<String, VideoState>>>,
    shared: Arc<Shared>,
    /// This node's own beacons are never learned as sources.
    own: Option<String>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
    /// Addresses whose beacon watch and swarm learner run.
    watching: Mutex<std::collections::BTreeSet<String>>,
    /// Addresses being fetched, seeded or served.
    handled: Mutex<std::collections::BTreeSet<String>>,
    seed_watched: bool,
}

struct Shared {
    node: Arc<Node>,
    relays: Arc<Relays>,
    store: Arc<FsStore>,
    keys: Option<Keys>,
    pull: Arc<SwarmPull>,
    origin: Option<Arc<Origin>>,
    https_url: Option<String>,
    deletion_check_every: Duration,
    gossip: bool,
    gossip_peers: Vec<iroh::EndpointAddr>,
    tracker: Option<Arc<Tracker>>,
    bridge: Option<Arc<Bridge>>,
    tracker_public_url: Option<String>,
    /// Renditions the bridge serves, by `a` tag, for the `webrtc` beacon endpoint.
    bridged: Mutex<BTreeMap<String, Vec<String>>>,
    /// This node's own pubkey: its own beacons and envelopes are never learned.
    own: Option<String>,
    state: Arc<Mutex<BTreeMap<String, VideoState>>>,
    /// Why seeding waits for an iroh relay ([`come_online`]); `None` once one is reached,
    /// after [`RELAY_WAIT`], or when there is nothing to wait for.
    relay_wait: watch::Receiver<Option<String>>,
}

/// Aborts its task when dropped (a loop's helper dies with the loop).
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Largest envelope this node broadcasts. iroh-gossip refuses frames of 4096 bytes or
/// more, and a refused frame stalls that neighbour's send queue for good (independent
/// audit H1), so an envelope near NFX's 4 KiB limit is not sent at all.
const MAX_SENT_ENVELOPE: usize = MAX_ENVELOPE_BYTES - 64;
/// A gossip send not done by then is dropped: gossip never holds up a relay beacon.
const GOSSIP_SEND_TIMEOUT: Duration = Duration::from_secs(1);

/// A swarm member's envelope (NFX-06 §4): a `here` becomes a gossip-ranked pull source
/// for `manifest`, and a `bye` withdraws it. This node's own envelopes are ignored.
fn hear(
    pull: &SwarmPull,
    own: Option<&str>,
    env: &Verified<Envelope>,
    manifest: &Verified<Manifest>,
) {
    if Some(env.pubkey.as_str()) == own {
        return;
    }
    match env.op {
        Op::Here => {
            if let Some(presence) = env.presence_for(manifest, unix_now()) {
                pull.learn_gossip(&presence);
            }
        }
        Op::Bye => pull.forget_gossip(&manifest.a_tag(), &env.pubkey),
    }
}

/// Broadcast one envelope, bounded in size and time.
async fn gossip_send(
    announcer: &Announcer,
    op: Op,
    pubkey: &str,
    beacon: BeaconContent,
    secret: &[u8; 32],
) {
    let env = Envelope {
        op,
        pubkey: pubkey.to_owned(),
        beacon,
        created_at: unix_now(),
    };
    if let Ok(wire) = envelope_wire(&env, secret)
        && wire.len() <= MAX_SENT_ENVELOPE
    {
        let _ = tokio::time::timeout(GOSSIP_SEND_TIMEOUT, announcer.announce(&wire)).await;
    }
}

impl Shared {
    /// Open `manifest`'s browser-mesh swarms on the embedded tracker, from its hash list in
    /// the store (verified against the manifest again here).
    /// With a bridge, it also joins them.
    async fn admit_swarms(&self, manifest: &Verified<Manifest>) {
        if let Some(tracker) = &self.tracker
            && let Ok(bytes) = self.store.get(&manifest.root_hex())
            && let Ok(list) = HashList::verify_for(&bytes, manifest)
        {
            let _ = tracker.admit(&list);
            if let Some(bridge) = &self.bridge
                && let Ok(renditions) = bridge.serve(&list, &*self.store).await
            {
                self.bridged
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(manifest.a_tag(), renditions);
            }
        }
    }

    /// Close them again (the creator deleted the video, NFX-02 §6).
    async fn forget_swarms(&self, manifest: &Verified<Manifest>) {
        if let Some(tracker) = &self.tracker
            && let Ok(bytes) = self.store.get(&manifest.root_hex())
            && let Ok(list) = HashList::verify_for(&bytes, manifest)
        {
            if let Some(bridge) = &self.bridge {
                let _ = bridge.forget(&list).await;
                self.bridged
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&manifest.a_tag());
            }
            let _ = tracker.forget(&list);
        }
    }

    /// The bootstrap for a video's swarm: configured peers plus known seeders' endpoints.
    fn swarm_peers(&self, a: &str) -> Vec<iroh::EndpointAddr> {
        let mut peers = self.gossip_peers.clone();
        for p in self.pull.peers(a) {
            if !peers.iter().any(|q| q.id == p.id) {
                peers.push(p);
            }
        }
        peers
    }

    /// Learn seeders of `a` from its gossip swarm (NFX-06 §4) until the swarm closes. It
    /// joins once a first peer is known, from configuration or a beacon.
    async fn learn_from_swarm(self: Arc<Self>, a: String) {
        if !self.gossip || self.node.relay_only() {
            return;
        }
        let Ok(manifest) = self.resolve(&a).await else {
            return;
        };
        let peers = loop {
            let p = self.swarm_peers(&a);
            if !p.is_empty() {
                break p;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        };
        let Ok(swarm) = self.node.join_swarm(&manifest.addr, peers).await else {
            return;
        };
        let (_announcer, mut listener) = swarm.split();
        while let Some(env) = listener.next_envelope().await {
            hear(&self.pull, self.own.as_deref(), &env, &manifest);
        }
    }

    /// Join `manifest`'s swarm to announce into it, when gossip is on.
    async fn join_gossip(&self, manifest: &Verified<Manifest>) -> Option<(Announcer, Listener)> {
        if !self.gossip || self.node.relay_only() {
            return None;
        }
        let peers = self.swarm_peers(&manifest.a_tag());
        let mut swarm = self
            .node
            .join_swarm(&manifest.addr, peers.clone())
            .await
            .ok()?;
        // With peers to join through, wait (briefly) to be connected, or the first envelope
        // reaches nobody.
        if !peers.is_empty() {
            let _ = tokio::time::timeout(Duration::from_secs(5), swarm.joined()).await;
        }
        Some(swarm.split())
    }

    fn set(&self, a: &str, s: VideoState) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(a.to_owned(), s);
    }

    /// The current manifest at `a`, retried until a relay has it.
    async fn resolve(&self, a: &str) -> Result<Verified<Manifest>> {
        let (creator, video) = parse_a_tag(a)?;
        let query = ManifestQuery {
            namespace: video.namespace().clone(),
            authors: vec![creator],
            videos: vec![video],
        };
        loop {
            // A relay that is down or slow now is retried like a manifest not there yet.
            if let Ok(found) = self.relays.manifests(&query, CONNECT_TIMEOUT).await
                && let Some(m) = found.into_iter().next()
            {
                return Ok(m);
            }
            tokio::time::sleep(RETRY).await;
        }
    }

    /// Wait, at most [`RELAY_WAIT`] from start, until an iroh relay is reached, so that the
    /// first beacons name it. Meanwhile `a`'s state says why.
    async fn until_online(&self, a: &str) {
        let mut wait = self.relay_wait.clone();
        loop {
            let why = wait.borrow_and_update().clone();
            match why {
                None => return,
                Some(why) => self.set(a, VideoState::AwaitingRelay(why)),
            }
            if wait.changed().await.is_err() {
                return; // shutting down
            }
        }
    }

    async fn seed_and_announce(&self, a: &str, manifest: &Verified<Manifest>) -> Result<()> {
        let keys = self
            .keys
            .clone()
            .ok_or_else(|| Error::Config("seeding needs --key".into()))?;
        self.until_online(a).await;
        let seeded = self
            .node
            .seed(
                &*self.store,
                &manifest.root_hex(),
                &manifest.addr,
                manifest.segs,
            )
            .await?;
        if let Some(origin) = &self.origin {
            origin.hold(manifest).await?;
        }
        self.admit_swarms(manifest).await;
        self.set(a, VideoState::Seeding);
        // The video's gossip swarm, when on: announce into it, and learn from it.
        let secret = keys.secret_key().to_secret_bytes();
        let pubkey = keys.public_key().to_hex();
        let (announcer, _learning) = match self.join_gossip(manifest).await {
            Some((announcer, mut listener)) => {
                let (pull, own, manifest) = (self.pull.clone(), self.own.clone(), manifest.clone());
                let learning = AbortOnDrop(tokio::spawn(async move {
                    while let Some(env) = listener.next_envelope().await {
                        hear(&pull, own.as_deref(), &env, &manifest);
                    }
                }));
                (Some(announcer), Some(learning))
            }
            None => (None, None),
        };
        let mut announce = tokio::time::interval(Duration::from_secs(BEACON_TTL / 2));
        let mut check = tokio::time::interval(self.deletion_check_every);
        loop {
            tokio::select! {
                _ = announce.tick() => {
                    let content = self.beacon(&seeded, manifest);
                    // The relay beacon first: gossip is optional and never holds it up. A
                    // refused or unreachable relay is retried at the next tick (beacons are
                    // hints), but it shows: a node that cannot announce is invisible.
                    match self.relays.announce(&keys, manifest, &content).await {
                        Ok(_) => self.set(a, VideoState::Seeding),
                        Err(e) => self.set(a, VideoState::Unannounced(e.to_string())),
                    }
                    if let Some(announcer) = &announcer {
                        gossip_send(announcer, Op::Here, &pubkey, content, &secret).await;
                    }
                }
                _ = check.tick() => {
                    // Only an actual deletion stops seeding: a relay that forgot the
                    // manifest (a restart) is not one.
                    if matches!(self.relays.deleted(manifest, CONNECT_TIMEOUT).await, Ok(true)) {
                        if let Some(announcer) = &announcer {
                            let content = self.beacon(&seeded, manifest);
                            gossip_send(announcer, Op::Bye, &pubkey, content, &secret).await;
                        }
                        self.forget_swarms(manifest).await;
                        self.set(a, VideoState::Deleted);
                        return Ok(());
                    }
                }
            }
        }
    }

    fn beacon(&self, seeded: &Seeded, manifest: &Manifest) -> BeaconContent {
        let mut endpoints = vec![self.node.beacon_endpoint(seeded)];
        if let Some(url) = &self.https_url {
            endpoints.push(Endpoint::Https { url: url.clone() });
        }
        if let Some(url) = &self.tracker_public_url
            && self.bridge.as_ref().is_some_and(|b| b.is_running())
            && let Some(renditions) = self
                .bridged
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&manifest.a_tag())
        {
            endpoints.push(Endpoint::Webrtc {
                tracker_urls: vec![url.clone()],
                renditions: renditions.clone(),
            });
        }
        BeaconContent {
            v: 1,
            video: manifest.addr.clone(),
            endpoints,
            skipped: vec![],
            chunks: Chunks::All,
            price_hint: 0,
            accepts_mints: vec![],
            free: true,
        }
    }

    async fn run_seed(self: Arc<Self>, a: String) -> Result<()> {
        let manifest = self.resolve(&a).await?;
        self.seed_and_announce(&a, &manifest).await
    }

    async fn run_fetch(self: Arc<Self>, a: String) -> Result<()> {
        let manifest = self.resolve(&a).await?;
        self.set(&a, VideoState::Fetching);
        while self
            .pull
            .fetch_video(&manifest, &*self.store)
            .await
            .is_err()
        {
            tokio::time::sleep(RETRY).await;
        }
        self.seed_and_announce(&a, &manifest).await
    }

    async fn run_pull(self: Arc<Self>, a: String) -> Result<()> {
        let origin = self
            .origin
            .clone()
            .ok_or_else(|| Error::Config("--pull needs --origin".into()))?;
        let manifest = self.resolve(&a).await?;
        self.set(&a, VideoState::Fetching);
        while origin.hold(&manifest).await.is_err() {
            tokio::time::sleep(RETRY).await;
        }
        self.admit_swarms(&manifest).await;
        self.set(&a, VideoState::Serving);
        // A deletion by its creator withdraws its mesh swarms too (NFX-02 §6).
        let mut check = tokio::time::interval(self.deletion_check_every);
        loop {
            check.tick().await;
            if matches!(
                self.relays.deleted(&manifest, CONNECT_TIMEOUT).await,
                Ok(true)
            ) {
                self.forget_swarms(&manifest).await;
                self.set(&a, VideoState::Deleted);
                return Ok(());
            }
        }
    }
}

impl Daemon {
    pub async fn start(cfg: Config) -> Result<Self> {
        let all: Vec<&String> = cfg.seed.iter().chain(&cfg.fetch).chain(&cfg.pull).collect();
        let mut by_namespace: BTreeMap<String, (Namespace, Vec<String>)> = BTreeMap::new();
        for a in &all {
            let (_, video) = parse_a_tag(a)?;
            by_namespace
                .entry(video.namespace().to_string())
                .or_insert_with(|| (video.namespace().clone(), vec![]));
        }
        for a in cfg.fetch.iter().chain(&cfg.pull) {
            let (_, video) = parse_a_tag(a)?;
            if let Some((_, watched)) = by_namespace.get_mut(&video.namespace().to_string()) {
                watched.push(a.clone());
            }
        }
        if cfg.keys.is_none() && !(cfg.seed.is_empty() && cfg.fetch.is_empty()) {
            return Err(Error::Config("--seed and --fetch need --key".into()));
        }
        if cfg.relay_only && cfg.iroh_relays.is_empty() {
            return Err(Error::Config("--relay-only needs --iroh-relay".into()));
        }
        // CA roots for relays that are not there would trust nothing in particular.
        if !cfg.iroh_relay_cas.is_empty() && cfg.iroh_relays.is_empty() {
            return Err(Error::Config("--iroh-relay-ca needs --iroh-relay".into()));
        }
        check_iroh_addrs(&cfg)?;
        // The allow-list governs the embedded relay; without one it would govern nothing.
        if !cfg.allow_creators.is_empty() && cfg.embed_relay.is_none() {
            return Err(Error::Config("--allow-creator needs --embed-relay".into()));
        }
        if cfg.relay_only && (cfg.gossip || !cfg.gossip_peers.is_empty()) {
            return Err(Error::Config(
                "--gossip, --gossip-peer: a relay-only node does not gossip".into(),
            ));
        }
        if cfg.bridge.is_some() && cfg.embed_tracker.is_none() {
            return Err(Error::Config("--bridge needs --embed-tracker".into()));
        }
        if let Some(url) = &cfg.tracker_public_url {
            if cfg.bridge.is_none() {
                return Err(Error::Config("--tracker-url needs --bridge".into()));
            }
            // Browsers dial it: wss://, or ws:// on loopback for tests (as the player).
            let loopback = ["ws://localhost", "ws://127.0.0.1", "ws://[::1]"]
                .iter()
                .any(|p| url.starts_with(p) && url[p.len()..].starts_with([':', '/']));
            if !(url.starts_with("wss://") || loopback) || url.contains(['?', '#', '@', ' ']) {
                return Err(Error::Config(format!(
                    "--tracker-url {url}: not a wss:// URL"
                )));
            }
        }
        if !cfg.gossip && !cfg.gossip_peers.is_empty() {
            return Err(Error::Config("--gossip-peer needs --gossip".into()));
        }
        // A peer with no address this node may dial would be dropped silently at every join.
        if let Some(p) = cfg.gossip_peers.iter().find(|p| {
            !p.addrs.iter().any(|t| match t {
                iroh::TransportAddr::Ip(_) => true,
                iroh::TransportAddr::Relay(url) => cfg.iroh_relays.contains(url),
                _ => false,
            })
        }) {
            return Err(Error::Config(format!(
                "--gossip-peer {}: no direct address, and no relay among --iroh-relay",
                p.id
            )));
        }
        if !cfg.pull.is_empty() && cfg.origin.is_none() && !cfg.internal_origin {
            return Err(Error::Config("--pull needs --origin".into()));
        }
        if let Some(key) = cfg
            .rating_root
            .iter()
            .chain(&cfg.rating_trusted)
            .find(|k| !is_x_only(k))
        {
            return Err(Error::Config(format!(
                "rating key {key}: not 64 lowercase hex"
            )));
        }
        if cfg.rating_root.is_none() && !cfg.rating_trusted.is_empty() {
            return Err(Error::Config("--rating-trusted needs --rating-root".into()));
        }
        if cfg.rating_root.is_some() && cfg.general_relays.is_empty() {
            return Err(Error::Config("--rating-root needs --general-relay".into()));
        }
        if cfg.rating_root.is_none() && !cfg.general_relays.is_empty() {
            return Err(Error::Config("--general-relay needs --rating-root".into()));
        }
        if let Some(url) = &cfg.https_url {
            // Checked the way every reader will check it (NFX-03 §4): a bad URL would
            // otherwise make every beacon fail, every minute, forever.
            let probe = BeaconContent {
                v: 1,
                video: nfx_proto::namespace::VideoAddr::parse("nfx:mainnet:1:https-url-probe")?,
                endpoints: vec![Endpoint::Https { url: url.clone() }],
                skipped: vec![],
                chunks: Chunks::All,
                price_hint: 0,
                accepts_mints: vec![],
                free: true,
            };
            let json: serde_json::Value = serde_json::from_str(&probe.to_content())
                .map_err(|e| Error::Config(e.to_string()))?;
            let parsed = BeaconContent::from_json(&json)
                .map_err(|e| Error::Config(format!("--https-url {url}: {e}")))?;
            if parsed.endpoints.is_empty() {
                return Err(Error::Config(format!(
                    "--https-url {url}: not an https URL"
                )));
            }
        }

        let mut tasks = Vec::new();
        let (tracker, tracker_url) = match cfg.embed_tracker {
            None => (None, None),
            Some(addr) => {
                let listener = tokio::net::TcpListener::bind(addr).await?;
                let mut local = listener.local_addr()?;
                if local.ip().is_unspecified() {
                    local.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
                }
                let tracker = Arc::new(Tracker::new());
                tasks.push(tokio::spawn(tracker.clone().serve(listener)));
                (Some(tracker), Some(format!("ws://{local}")))
            }
        };
        let mut relays = cfg.relays.clone();
        let (embedded, relay_url) = match cfg.embed_relay {
            None => (None, None),
            Some(addr) => {
                let namespaces: Vec<Namespace> = if cfg.namespaces.is_empty() {
                    by_namespace.values().map(|(ns, _)| ns.clone()).collect()
                } else {
                    cfg.namespaces.clone()
                };
                if namespaces.is_empty() {
                    return Err(Error::Config(
                        "the embedded relay needs --namespace or a video".into(),
                    ));
                }
                let listener = tokio::net::TcpListener::bind(addr).await?;
                let mut local = listener.local_addr()?;
                if local.ip().is_unspecified() {
                    local.set_ip(std::net::Ipv4Addr::LOCALHOST.into());
                }
                let relay = Arc::new(if cfg.allow_creators.is_empty() {
                    ScopedRelay::new(&namespaces)
                } else {
                    ScopedRelay::with_creators(&namespaces, &cfg.allow_creators)
                        .map_err(|e| Error::Config(format!("--allow-creator: {e}")))?
                });
                tasks.push(tokio::spawn(relay.clone().serve(listener)));
                let url = format!("ws://{local}");
                // The host speaks to its own relay through the same door (NFX-04 §7).
                relays.push(url.clone());
                (Some(relay), Some(url))
            }
        };

        let state = cfg.state.clone().unwrap_or_else(|| cfg.store.join(".nfxd"));
        std::fs::create_dir_all(state.join("iroh-blobs"))?;
        let node = Arc::new(
            Node::spawn(NodeConfig {
                relays: cfg.iroh_relays.clone(),
                relay_only: cfg.relay_only,
                relay_cas: cfg.iroh_relay_cas.clone(),
                blobs_dir: Some(state.join("iroh-blobs")),
                no_portmapper: cfg.no_portmapper,
                bind_addr: cfg.iroh_bind,
                external_addrs: cfg.iroh_external.clone(),
                ..NodeConfig::default()
            })
            .await?,
        );
        // An iroh relay is extra reachability, never a requirement. A node with an external
        // address seeds at once; any other waits at most RELAY_WAIT for one, so that its first
        // beacons name it, then seeds without it. Beacons name it whenever it connects.
        let (relay_status, relay_wait) = watch::channel(None);
        if !cfg.iroh_relays.is_empty()
            && cfg.iroh_external.is_empty()
            && node.online(CONNECT_TIMEOUT).await.is_err()
        {
            let relays = cfg
                .iroh_relays
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            relay_status.send_replace(Some(format!(
                "iroh relay {relays} not reached in {} s; seeding without it in {} s at most",
                CONNECT_TIMEOUT.as_secs(),
                RELAY_WAIT.saturating_sub(CONNECT_TIMEOUT).as_secs()
            )));
            tasks.push(tokio::spawn(come_online(
                node.clone(),
                relay_status,
                relays,
            )));
        }
        let relays = Arc::new(Relays::connect(&relays, CONNECT_TIMEOUT).await?);
        let store = Arc::new(FsStore::open(&cfg.store)?);
        let pull = Arc::new(SwarmPull::new(node.clone()));
        let bridge = match (cfg.bridge, &tracker) {
            (Some(addr), Some(tracker)) => Some(Arc::new(
                Bridge::start(tracker, store.clone(), addr)
                    .await
                    .map_err(|e| Error::Config(format!("--bridge: {e}")))?,
            )),
            _ => None,
        };
        let bridge_addr = bridge.as_ref().map(|b| b.local_addr());

        let (origin, origin_addr) = match cfg.origin {
            None if cfg.internal_origin => (
                Some(Arc::new(Origin::new(store.clone(), Some(pull.clone())))),
                None,
            ),
            None => (None, None),
            Some(addr) => {
                let listener = tokio::net::TcpListener::bind(addr).await?;
                let local = listener.local_addr()?;
                let origin = Arc::new(Origin::new(store.clone(), Some(pull.clone())));
                tasks.push(tokio::spawn(serve(origin.clone(), listener)));
                (Some(origin), Some(local))
            }
        };

        let state = Arc::new(Mutex::new(BTreeMap::new()));
        let shared = Arc::new(Shared {
            node: node.clone(),
            relays: relays.clone(),
            store,
            keys: cfg.keys.clone(),
            pull: pull.clone(),
            origin,
            https_url: cfg.https_url.clone(),
            bridge,
            tracker_public_url: cfg.tracker_public_url.clone(),
            bridged: Mutex::new(BTreeMap::new()),
            deletion_check_every: cfg
                .deletion_check_every
                .unwrap_or(Duration::from_secs(BEACON_TTL / 2))
                .max(Duration::from_millis(100)),
            gossip: cfg.gossip,
            gossip_peers: cfg.gossip_peers.clone(),
            tracker,
            own: cfg.keys.as_ref().map(|k| k.public_key().to_hex()),
            state: state.clone(),
            relay_wait,
        });

        // Beacons for everything we fetch or pull feed the pull sources.
        let own = cfg.keys.as_ref().map(|k| k.public_key().to_hex());
        let mut rated: std::collections::BTreeSet<String> =
            cfg.namespaces.iter().map(ToString::to_string).collect();
        rated.extend(by_namespace.keys().cloned());
        for (namespace, watched) in by_namespace.into_values() {
            if watched.is_empty() {
                continue;
            }
            let mut watch = relays.watch_beacons(&namespace, &watched).await?;
            let (pull, own) = (pull.clone(), own.clone());
            tasks.push(tokio::spawn(async move {
                while let Some(beacon) = watch.next().await {
                    if Some(&beacon.seeder) != own.as_ref() {
                        pull.learn(&beacon);
                    }
                }
            }));
        }

        if let Some(root) = &cfg.rating_root {
            let general = Relays::connect(&cfg.general_relays, CONNECT_TIMEOUT).await?;
            tasks.push(tokio::spawn(rate_seeders(
                general,
                pull.clone(),
                root.clone(),
                cfg.rating_trusted.clone(),
                rated,
            )));
        }

        type Job = fn(
            Arc<Shared>,
            String,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>>;
        let jobs: [(&Vec<String>, Job); 3] = [
            (&cfg.seed, |s, a| Box::pin(s.run_seed(a))),
            (&cfg.fetch, |s, a| Box::pin(s.run_fetch(a))),
            (&cfg.pull, |s, a| Box::pin(s.run_pull(a))),
        ];
        for a in cfg.fetch.iter().chain(&cfg.pull) {
            tasks.push(tokio::spawn(shared.clone().learn_from_swarm(a.clone())));
        }
        for (list, job) in jobs {
            for a in list {
                shared.set(a, VideoState::Resolving);
                let (shared, a) = (shared.clone(), a.clone());
                tasks.push(tokio::spawn(async move {
                    if let Err(e) = job(shared.clone(), a.clone()).await {
                        shared.set(&a, VideoState::Failed(e.to_string()));
                    }
                }));
            }
        }

        Ok(Self {
            node,
            relays,
            embedded,
            relay_url,
            tracker_url,
            bridge_addr,
            origin_addr,
            state,
            shared,
            own,
            tasks: Mutex::new(tasks),
            watching: Mutex::new(cfg.fetch.iter().chain(&cfg.pull).cloned().collect()),
            seed_watched: cfg.seed_watched,
            handled: Mutex::new(
                cfg.seed
                    .iter()
                    .chain(&cfg.fetch)
                    .chain(&cfg.pull)
                    .cloned()
                    .collect(),
            ),
        })
    }

    /// The seeders currently known for a video (`a` tag), from beacons and gossip.
    #[must_use]
    pub fn sources(&self, a: &str) -> Vec<String> {
        self.shared.pull.sources(a)
    }

    /// The origin (TCP or internal), when there is one.
    #[must_use]
    pub fn origin(&self) -> Option<Arc<Origin>> {
        self.shared.origin.clone()
    }

    fn spawn(&self, task: impl std::future::Future<Output = ()> + Send + 'static) {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(tokio::spawn(task));
    }

    /// Watch a video, as a viewer: learn seeders from its beacons, resolve its manifest,
    /// and hold it on the origin, so playback can start while misses are pulled on demand.
    /// With `seed_watched` (and a key) it is then fetched whole in the background and
    /// seeded; otherwise it is only served here and never announced. Returns the manifest
    /// once the origin holds it, or an error after `timeout`. Watching twice is harmless.
    pub async fn watch(&self, a: &str, timeout: Duration) -> Result<Verified<Manifest>> {
        let origin = self
            .shared
            .origin
            .clone()
            .ok_or_else(|| Error::Config("watching needs an origin".into()))?;
        let (_, video) = parse_a_tag(a)?;
        let watching = |a: &str| {
            self.watching
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(a)
        };
        if !watching(a) {
            // Recorded only once the beacon watch runs: a relay that is down now leaves
            // nothing behind, and the next watch tries again.
            let mut beacons = self
                .relays
                .watch_beacons(video.namespace(), &[a.to_owned()])
                .await?;
            let first = self
                .watching
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(a.to_owned());
            if first {
                self.state
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .entry(a.to_owned())
                    .or_insert(VideoState::Resolving);
                let (pull, own) = (self.shared.pull.clone(), self.own.clone());
                self.spawn(async move {
                    while let Some(beacon) = beacons.next().await {
                        if Some(&beacon.seeder) != own.as_ref() {
                            pull.learn(&beacon);
                        }
                    }
                });
                self.spawn(self.shared.clone().learn_from_swarm(a.to_owned()));
            }
        }
        let shared = self.shared.clone();
        let hold = async {
            let manifest = shared.resolve(a).await?;
            while origin.hold(&manifest).await.is_err() {
                tokio::time::sleep(RETRY).await;
            }
            shared.admit_swarms(&manifest).await;
            Ok::<_, Error>(manifest)
        };
        let manifest = tokio::time::timeout(timeout, hold)
            .await
            .map_err(|_| Error::Config(format!("no seeder served {a} in time")))??;
        // The first watch that plays starts the full fetch (or marks it served), whichever
        // watch that is.
        let first = self
            .handled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(a.to_owned());
        if first {
            if self.seed_watched && shared.keys.is_some() {
                let (shared, a) = (shared.clone(), a.to_owned());
                self.spawn(async move {
                    if let Err(e) = shared.clone().run_fetch(a.clone()).await {
                        shared.set(&a, VideoState::Failed(e.to_string()));
                    }
                });
            } else {
                shared.set(a, VideoState::Serving);
            }
        }
        Ok(manifest)
    }

    /// Each video's state, by `a` tag.
    #[must_use]
    pub fn state(&self) -> BTreeMap<String, VideoState> {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// The embedded tracker, when there is one.
    #[must_use]
    pub fn tracker(&self) -> Option<&Arc<Tracker>> {
        self.shared.tracker.as_ref()
    }

    #[must_use]
    pub fn node(&self) -> &Node {
        &self.node
    }

    /// Stop everything: tasks, the embedded relay, the relay clients and the node, whose
    /// blobs store is released even while a pending call still holds this daemon, so a
    /// new daemon can open the same store at once.
    pub async fn shutdown(&self) {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap_or_else(PoisonError::into_inner));
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            let _ = task.await;
        }
        if let Some(relay) = &self.embedded {
            relay.shutdown();
        }
        self.relays.shutdown().await;
        let _ = self.node.close().await;
    }
}

/// `--iroh-bind` and `--iroh-external`, checked before anything binds.
fn check_iroh_addrs(cfg: &Config) -> Result<()> {
    if cfg.relay_only && (cfg.iroh_bind.is_some() || !cfg.iroh_external.is_empty()) {
        return Err(Error::Config(
            "--iroh-bind, --iroh-external: a relay-only node has no direct address".into(),
        ));
    }
    if let Some(addr) = cfg.iroh_bind
        && addr.port() == 0
    {
        return Err(Error::Config(format!(
            "--iroh-bind {addr}: port 0 is not a fixed port"
        )));
    }
    // An external address points at the bound port; a random one cannot be forwarded.
    if !cfg.iroh_external.is_empty() && cfg.iroh_bind.is_none() {
        return Err(Error::Config("--iroh-external needs --iroh-bind".into()));
    }
    if cfg.iroh_external.len() > nfx_node::node::MAX_EXTERNAL_ADDRS {
        return Err(Error::Config(format!(
            "--iroh-external: at most {} addresses",
            nfx_node::node::MAX_EXTERNAL_ADDRS
        )));
    }
    for addr in &cfg.iroh_external {
        let ip = addr.ip();
        let broadcast = matches!(ip, std::net::IpAddr::V4(v4) if v4.is_broadcast());
        if addr.port() == 0 || ip.is_unspecified() || ip.is_multicast() || broadcast {
            return Err(Error::Config(format!(
                "--iroh-external {addr}: not an address a peer can dial"
            )));
        }
    }
    Ok(())
}

/// Wait for the node's home relay until [`RELAY_WAIT`] has passed since start
/// (`Daemon::start` waited the first [`CONNECT_TIMEOUT`]), then clear `status` so seeding
/// goes ahead, with a warning naming `relays` if none was reached. iroh keeps redialling
/// them meanwhile and after; the beacons name one as soon as it connects.
async fn come_online(node: Arc<Node>, status: watch::Sender<Option<String>>, relays: String) {
    let reached = node
        .online(RELAY_WAIT.saturating_sub(CONNECT_TIMEOUT))
        .await
        .is_ok();
    status.send_replace(None);
    if !reached {
        eprintln!(
            "nfxd: warning: iroh relay {relays} not reached in {} s; seeding without it \
             (beacons name it once it connects)",
            RELAY_WAIT.as_secs()
        );
        node.endpoint().online().await;
        eprintln!("nfxd: iroh relay reached; the next beacons name it");
    }
}

fn is_x_only(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Keep the pull's seeder scores (NFX-16 §4) current: for every namespace configured or
/// heard in a beacon, fetch the inputs from the general relays and score them, then again
/// after [`RATING_REFRESH`], or after [`RATING_RETRY`] when the fetch failed. A failed
/// fetch keeps the scores already held.
async fn rate_seeders(
    general: Relays,
    pull: Arc<SwarmPull>,
    root: String,
    trusted: Vec<String>,
    configured: std::collections::BTreeSet<String>,
) {
    let mut due: BTreeMap<String, tokio::time::Instant> = BTreeMap::new();
    let mut tick = tokio::time::interval(RATING_TICK);
    loop {
        tick.tick().await;
        let mut namespaces = configured.clone();
        namespaces.extend(pull.namespaces());
        for namespace in namespaces {
            if due
                .get(&namespace)
                .is_some_and(|at| tokio::time::Instant::now() < *at)
            {
                continue;
            }
            let now = unix_now();
            let wait = match general
                .rating_inputs(&root, &trusted, &namespace, now, CONNECT_TIMEOUT)
                .await
            {
                Ok(inputs) => {
                    // Up to MAX_RATING_EVENTS signature checks: off the async workers.
                    let ns = namespace.clone();
                    let scored = tokio::task::spawn_blocking(move || {
                        nfx_proto::rating::score(&inputs.events, &ns, now, &inputs.admitted)
                    })
                    .await;
                    match scored {
                        Ok(scored) => {
                            pull.set_scores(
                                &namespace,
                                scored
                                    .scores
                                    .into_iter()
                                    .map(|(seeder, s)| (seeder, s.score))
                                    .collect(),
                            );
                            RATING_REFRESH
                        }
                        Err(_) => RATING_RETRY,
                    }
                }
                Err(_) => RATING_RETRY,
            };
            due.insert(namespace, tokio::time::Instant::now() + wait);
        }
    }
}
