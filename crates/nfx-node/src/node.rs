//! The iroh side of a peer: one endpoint serving iroh-blobs and `nfx/gossip/1`.

use std::path::PathBuf;
use std::time::Duration;

use iroh::address_lookup::MemoryLookup;
use iroh::endpoint::presets;
use iroh::protocol::Router;
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey};
use iroh_blobs::BlobsProtocol;
use iroh_blobs::api::Store;
use iroh_gossip::Gossip;

use crate::{GOSSIP_ALPN, NodeError, Result};

#[derive(Debug, Clone, Default)]
pub struct NodeConfig {
    /// The iroh identity. `None` generates a fresh one (a transport identity only;
    /// the long-term identity is the nostr key, NFX-06 §1).
    pub secret_key: Option<[u8; 32]>,
    /// The relays this network runs (NFX-06 §1, NFX-11 §4). Empty disables relaying.
    pub relays: Vec<RelayUrl>,
    /// No UDP/IP transports at all: every connection goes through a relay.
    pub relay_only: bool,
    /// Directory for iroh-blobs' own index. `None` keeps it in memory.
    pub blobs_dir: Option<PathBuf>,
    /// Extra address lookup (e.g. peers known out of band).
    pub lookup: Option<MemoryLookup>,
}

pub struct Node {
    router: Router,
    blobs: Store,
    gossip: Gossip,
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
        let blobs: Store = match &cfg.blobs_dir {
            Some(dir) => iroh_blobs::store::fs::FsStore::load(dir)
                .await
                .map_err(NodeError::transport)?
                .into(),
            None => iroh_blobs::store::mem::MemStore::new().into(),
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
        })
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
