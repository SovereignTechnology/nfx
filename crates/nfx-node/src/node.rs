//! The iroh side of a peer: one endpoint serving iroh-blobs and `nfx/gossip/1`.

use std::path::PathBuf;
use std::time::Duration;

use iroh::address_lookup::MemoryLookup;
use iroh::endpoint::{Connection, presets};
use iroh::protocol::Router;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr,
};
use iroh_blobs::BlobsProtocol;
use iroh_blobs::api::Store;
use iroh_blobs::store::GcConfig;
use iroh_gossip::Gossip;

use crate::{GOSSIP_ALPN, NodeError, Result};

/// How often iroh-blobs deletes untagged blobs. Seeded content is tagged; anything fetched
/// is read back into the NFX store and then left untagged, so it does not accumulate and
/// is not re-served by BLAKE3 hash for long.
pub const GC_INTERVAL: Duration = Duration::from_secs(60);
/// Upper bound for dialling a peer.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Default)]
pub struct NodeConfig {
    /// The iroh identity. `None` generates a fresh one (a transport identity only;
    /// the long-term identity is the nostr key, NFX-06 §1).
    pub secret_key: Option<[u8; 32]>,
    /// The relays this network runs (NFX-06 §1, NFX-11 §4). Empty disables relaying.
    pub relays: Vec<RelayUrl>,
    /// No UDP/IP transports at all: every connection goes through a relay.
    pub relay_only: bool,
    /// Directory for iroh-blobs' own index. `None` keeps it in memory, which also means
    /// seeded files are copied into RAM: long-running nodes should set it.
    pub blobs_dir: Option<PathBuf>,
    /// Extra address lookup (e.g. peers known out of band).
    pub lookup: Option<MemoryLookup>,
}

/// The secret key is never printed.
impl std::fmt::Debug for NodeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeConfig")
            .field("secret_key", &self.secret_key.map(|_| "<redacted>"))
            .field("relays", &self.relays)
            .field("relay_only", &self.relay_only)
            .field("blobs_dir", &self.blobs_dir)
            .field("lookup", &self.lookup.is_some())
            .finish()
    }
}

pub struct Node {
    router: Router,
    blobs: Store,
    gossip: Gossip,
    relays: Vec<RelayUrl>,
    relay_only: bool,
    /// Addresses learned out of band (gossip bootstrap peers), filtered by [`Node::trusted`].
    book: MemoryLookup,
}

impl Node {
    pub async fn spawn(cfg: NodeConfig) -> Result<Self> {
        let mut builder = Endpoint::builder(presets::Minimal);
        builder = if cfg.relays.is_empty() {
            builder.relay_mode(RelayMode::Disabled)
        } else {
            builder.relay_mode(RelayMode::Custom(
                cfg.relays.iter().cloned().collect::<RelayMap>(),
            ))
        };
        if let Some(key) = cfg.secret_key {
            builder = builder.secret_key(SecretKey::from(key));
        }
        if cfg.relay_only {
            builder = builder.clear_ip_transports();
        }
        // The configured lookup doubles as the node's address book (clones share state).
        let book = cfg.lookup.clone().unwrap_or_default();
        builder = builder.address_lookup(book.clone());
        let endpoint = builder.bind().await.map_err(NodeError::transport)?;
        let gc = || GcConfig {
            interval: GC_INTERVAL,
            add_protected: None,
        };
        let blobs: Store = match &cfg.blobs_dir {
            Some(dir) => {
                let mut opts = iroh_blobs::store::fs::options::Options::new(dir);
                opts.gc = Some(gc());
                iroh_blobs::store::fs::FsStore::load_with_opts(dir.join("blobs.db"), opts)
                    .await
                    .map_err(NodeError::transport)?
                    .into()
            }
            None => {
                iroh_blobs::store::mem::MemStore::new_with_opts(iroh_blobs::store::mem::Options {
                    gc_config: Some(gc()),
                })
                .into()
            }
        };
        let gossip = Gossip::builder().alpn(GOSSIP_ALPN).spawn(endpoint.clone());
        let mut router =
            Router::builder(endpoint).accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None));
        // A relay-only node never gossips (see `join_swarm`), so it does not accept it either.
        if !cfg.relay_only {
            router = router.accept(GOSSIP_ALPN, gossip.clone());
        }
        Ok(Self {
            router: router.spawn(),
            blobs,
            gossip,
            relays: cfg.relays,
            relay_only: cfg.relay_only,
            book,
        })
    }

    /// Dial `addr` for `alpn`, within [`CONNECT_TIMEOUT`]. Only direct IP addresses and
    /// this network's own relays are used: a ticket from an untrusted beacon cannot make
    /// the node contact a relay host of the sender's choosing.
    pub async fn dial(&self, addr: &EndpointAddr, alpn: &[u8]) -> Result<Connection> {
        let addr = self.trusted(addr);
        tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint().connect(addr, alpn))
            .await
            .map_err(|_| NodeError::Transport("connect timed out".into()))?
            .map_err(NodeError::transport)
    }

    /// `addr` with only the transports this node may use for it: direct IP addresses
    /// (none on a relay-only node) and this network's own relays.
    #[must_use]
    pub fn trusted(&self, addr: &EndpointAddr) -> EndpointAddr {
        let addrs = addr.addrs.iter().filter(|a| match a {
            TransportAddr::Ip(_) => !self.relay_only,
            TransportAddr::Relay(url) => self.relays.contains(url),
            _ => false,
        });
        EndpointAddr::from_parts(addr.id, addrs.cloned())
    }

    /// Remember how to reach a peer (filtered by [`Node::trusted`]), so that it can be
    /// dialled by id alone, as gossip does. Returns false when nothing usable was left.
    pub fn learn_addr(&self, addr: &EndpointAddr) -> bool {
        let addr = self.trusted(addr);
        if addr.addrs.is_empty() {
            return false;
        }
        self.book.add_endpoint_info(addr);
        true
    }

    #[must_use]
    pub fn relay_only(&self) -> bool {
        self.relay_only
    }

    #[must_use]
    pub fn id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    /// What to publish: the endpoint id plus its home relay and any direct addresses.
    #[must_use]
    pub fn addr(&self) -> EndpointAddr {
        self.router.endpoint().addr()
    }

    #[must_use]
    pub fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    #[must_use]
    pub fn blobs(&self) -> &Store {
        &self.blobs
    }

    #[must_use]
    pub(crate) fn gossip(&self) -> &Gossip {
        &self.gossip
    }

    /// Wait until the endpoint has reached its home relay (or give up after `limit`).
    pub async fn online(&self, limit: Duration) -> Result<()> {
        tokio::time::timeout(limit, self.router.endpoint().online())
            .await
            .map_err(|_| NodeError::Transport("endpoint never came online".into()))
    }

    pub async fn shutdown(self) -> Result<()> {
        self.router.shutdown().await.map_err(NodeError::transport)
    }
}
