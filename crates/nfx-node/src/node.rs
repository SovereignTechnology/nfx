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
        if let Some(lookup) = cfg.lookup {
            builder = builder.address_lookup(lookup);
        }
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
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&blobs, None))
            .accept(GOSSIP_ALPN, gossip.clone())
            .spawn();
        Ok(Self {
            router,
            blobs,
            gossip,
            relays: cfg.relays,
        })
    }

    /// Dial `addr` for `alpn`, within [`CONNECT_TIMEOUT`]. Only direct IP addresses and
    /// this network's own relays are used: a ticket from an untrusted beacon cannot make
    /// the node contact a relay host of the sender's choosing.
    pub async fn dial(&self, addr: &EndpointAddr, alpn: &[u8]) -> Result<Connection> {
        let addrs = addr.addrs.iter().filter(|a| match a {
            TransportAddr::Ip(_) => true,
            TransportAddr::Relay(url) => self.relays.contains(url),
            _ => false,
        });
        let addr = EndpointAddr::from_parts(addr.id, addrs.cloned());
        tokio::time::timeout(CONNECT_TIMEOUT, self.endpoint().connect(addr, alpn))
            .await
            .map_err(|_| NodeError::Transport("connect timed out".into()))?
            .map_err(NodeError::transport)
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
    pub fn gossip(&self) -> &Gossip {
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
