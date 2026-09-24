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

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use iroh::RelayUrl;
use nfx_node::node::{Node, NodeConfig};
use nfx_node::nostr::{BEACON_TTL, ManifestQuery, Relays};
use nfx_node::origin::{Origin, SwarmPull, serve};
use nfx_node::relay::ScopedRelay;
use nfx_node::seed::Seeded;
use nfx_node::store::FsStore;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint, parse_a_tag};
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::Namespace;
use nostr_sdk::prelude::Keys;
use tokio::task::JoinHandle;

use crate::{Error, Result};

/// How often a missing manifest or an unfetched video is retried.
pub const RETRY: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

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
    /// No direct IP transports: every iroh byte crosses a relay. For proving the relay
    /// path, and for hosts that must not expose UDP.
    pub relay_only: bool,
    pub seed: Vec<String>,
    pub fetch: Vec<String>,
    pub pull: Vec<String>,
    /// Serve the origin here (HTTP; TLS belongs in front).
    pub origin: Option<SocketAddr>,
    /// The origin's public URL, announced as an `https` endpoint when set.
    pub https_url: Option<String>,
    /// Embed a scoped relay listening here (NFX-04 §7).
    pub embed_relay: Option<SocketAddr>,
    /// Namespaces the embedded relay serves; by default those of the videos above.
    pub namespaces: Vec<Namespace>,
    /// How often a seeded video is checked for its creator's deletion (NFX-02 §6).
    /// Default: every beacon republish (60 s).
    pub deletion_check_every: Option<Duration>,
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
    pub origin_addr: Option<SocketAddr>,
    state: Arc<Mutex<BTreeMap<String, VideoState>>>,
    tasks: Vec<JoinHandle<()>>,
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
    state: Arc<Mutex<BTreeMap<String, VideoState>>>,
}

impl Shared {
    fn set(&self, a: &str, s: VideoState) {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(a.to_owned(), s);
    }

    /// The current manifest at `a`, retried until a relay has it.
    async fn resolve(&self, a: &str) -> Result<Manifest> {
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

    async fn seed_and_announce(&self, a: &str, manifest: &Manifest) -> Result<()> {
        let keys = self
            .keys
            .clone()
            .ok_or_else(|| Error::Config("seeding needs --key".into()))?;
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
        self.set(a, VideoState::Seeding);
        let mut announce = tokio::time::interval(Duration::from_secs(BEACON_TTL / 2));
        let mut check = tokio::time::interval(self.deletion_check_every);
        loop {
            tokio::select! {
                _ = announce.tick() => {
                    // A refused or unreachable relay is retried at the next tick (beacons are
                    // hints), but it shows: a node that cannot announce is invisible.
                    match self
                        .relays
                        .announce(&keys, manifest, &self.beacon(&seeded, manifest))
                        .await
                    {
                        Ok(_) => self.set(a, VideoState::Seeding),
                        Err(e) => self.set(a, VideoState::Unannounced(e.to_string())),
                    }
                }
                _ = check.tick() => {
                    // Only an actual deletion stops seeding: a relay that forgot the
                    // manifest (a restart) is not one.
                    if matches!(self.relays.deleted(manifest, CONNECT_TIMEOUT).await, Ok(true)) {
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
        self.set(&a, VideoState::Serving);
        Ok(())
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
        if !cfg.pull.is_empty() && cfg.origin.is_none() {
            return Err(Error::Config("--pull needs --origin".into()));
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
                let relay = Arc::new(ScopedRelay::new(&namespaces));
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
                blobs_dir: Some(state.join("iroh-blobs")),
                ..NodeConfig::default()
            })
            .await?,
        );
        if !cfg.iroh_relays.is_empty() {
            // Tickets carry the home relay; best effort, direct addresses still work.
            let _ = node.online(CONNECT_TIMEOUT).await;
        }
        let relays = Arc::new(Relays::connect(&relays, CONNECT_TIMEOUT).await?);
        let store = Arc::new(FsStore::open(&cfg.store)?);
        let pull = Arc::new(SwarmPull::new(node.clone()));

        let (origin, origin_addr) = match cfg.origin {
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
            deletion_check_every: cfg
                .deletion_check_every
                .unwrap_or(Duration::from_secs(BEACON_TTL / 2))
                .max(Duration::from_millis(100)),
            state: state.clone(),
        });

        // Beacons for everything we fetch or pull feed the pull sources.
        let own = cfg.keys.as_ref().map(|k| k.public_key().to_hex());
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
            origin_addr,
            state,
            tasks,
        })
    }

    /// Each video's state, by `a` tag.
    #[must_use]
    pub fn state(&self) -> BTreeMap<String, VideoState> {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    #[must_use]
    pub fn node(&self) -> &Node {
        &self.node
    }

    pub async fn shutdown(self) {
        for task in &self.tasks {
            task.abort();
        }
        for task in self.tasks {
            let _ = task.await;
        }
        if let Some(relay) = &self.embedded {
            relay.shutdown();
        }
        if let Ok(relays) = Arc::try_unwrap(self.relays) {
            relays.shutdown().await;
        }
        if let Ok(node) = Arc::try_unwrap(self.node) {
            let _ = node.shutdown().await;
        }
    }
}
