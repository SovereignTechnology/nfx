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
pub use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::{PemObject, SectionKind};

use crate::{GOSSIP_ALPN, NodeError, Result};

/// At most this many CA certificates (`NodeConfig::relay_cas`), as the nutflix-pear iroh
/// helper allows.
pub const MAX_RELAY_CAS: usize = 4;
/// At most this many DER bytes per CA certificate.
pub const MAX_RELAY_CA_DER: usize = 8192;
/// At most this many bytes of PEM text in one file.
pub const MAX_RELAY_CA_PEM: usize = 64 * 1024;

/// The CA certificates of a PEM file for `NodeConfig::relay_cas`: one to `MAX_RELAY_CAS`
/// `CERTIFICATE` blocks of at most `MAX_RELAY_CA_DER` bytes each, in at most
/// `MAX_RELAY_CA_PEM` bytes. Any other block (a private key given by mistake) is refused,
/// not skipped. Errors name the rule only, never the file's content.
pub fn relay_cas_from_pem(pem: &[u8]) -> Result<Vec<CertificateDer<'static>>> {
    let bad = |why: &str| NodeError::Relay(format!("relay CA file: {why}"));
    if pem.len() > MAX_RELAY_CA_PEM {
        return Err(bad("over 64 KiB"));
    }
    let mut out = Vec::new();
    for item in <(SectionKind, Vec<u8>)>::pem_slice_iter(pem) {
        let (kind, der) = item.map_err(|_| bad("not valid PEM"))?;
        if kind != SectionKind::Certificate {
            return Err(bad("a block that is not a CERTIFICATE"));
        }
        if der.is_empty() || der.len() > MAX_RELAY_CA_DER {
            return Err(bad("a certificate over 8192 bytes, or empty"));
        }
        if out.len() == MAX_RELAY_CAS {
            return Err(bad("more than 4 certificates"));
        }
        out.push(CertificateDer::from(der));
    }
    if out.is_empty() {
        return Err(bad("no CERTIFICATE block"));
    }
    Ok(out)
}

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
    /// Extra address lookup, trusted as given: the operator's peers known out of band. It
    /// bypasses [`Node::trusted`], so never fill it from the network.
    pub lookup: Option<MemoryLookup>,
    /// Never ask the local gateway (UPnP, PCP, NAT-PMP) to open a port. A node that only
    /// fetches, such as a viewer that shares nothing, needs no inbound port.
    pub no_portmapper: bool,
    /// Extra CA roots for the TLS of this network's iroh relays, beside the compiled-in
    /// Mozilla roots (`relay_cas_from_pem`). For a network whose relays use a private CA,
    /// such as a test network. Empty: the compiled-in roots only, as before. It changes what
    /// relay certificates are trusted, never how peers authenticate each other (iroh's own
    /// keys do that).
    pub relay_cas: Vec<CertificateDer<'static>>,
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
            .field("no_portmapper", &self.no_portmapper)
            .field("relay_cas", &self.relay_cas.len())
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
        if cfg.no_portmapper {
            builder = builder.portmapper_config(iroh::endpoint::PortmapperConfig::Disabled);
        }
        if !cfg.relay_cas.is_empty() {
            builder = builder.ca_tls_config(
                iroh::tls::CaTlsConfig::default().with_extra_roots(cfg.relay_cas.clone()),
            );
        }
        if let Some(lookup) = cfg.lookup {
            builder = builder.address_lookup(lookup);
        }
        // The node's own book, filled only through `learn_addr` (filtered).
        let book = MemoryLookup::new();
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
        self.close().await
    }

    /// Stop accepting, close the endpoint and release the blobs store, even while other
    /// holders of this node remain (their calls then fail). A node reopened on the same
    /// `blobs_dir` afterwards finds its database free.
    pub async fn close(&self) -> Result<()> {
        let routed = self.router.shutdown().await.map_err(NodeError::transport);
        // The router's shutdown normally stops the store already (then this reports that
        // the store is gone); calling it anyway makes the release independent of that.
        let _ = self.blobs.shutdown().await;
        routed
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use base64::Engine as _;

    use super::*;

    fn pem_block(label: &str, der: &[u8]) -> String {
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        let body: Vec<&str> = b64
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        format!(
            "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
            body.join("\n")
        )
    }

    fn a_ca() -> Vec<u8> {
        let (certs, _) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
        certs[0].to_vec()
    }

    #[test]
    fn relay_cas_from_pem_reads_one_to_four_certificates() {
        let der = a_ca();
        let one = relay_cas_from_pem(pem_block("CERTIFICATE", &der).as_bytes()).unwrap();
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].as_ref(), der.as_slice());
        // Text around the blocks is ignored, as PEM allows.
        let four = format!(
            "a comment\n{}",
            pem_block("CERTIFICATE", &der).repeat(MAX_RELAY_CAS)
        );
        assert_eq!(relay_cas_from_pem(four.as_bytes()).unwrap().len(), 4);
    }

    #[test]
    fn relay_cas_from_pem_refuses_what_it_should_and_never_echoes_content() {
        let der = a_ca();
        let five = pem_block("CERTIFICATE", &der).repeat(MAX_RELAY_CAS + 1);
        let key = format!(
            "{}{}",
            pem_block("CERTIFICATE", &der),
            pem_block("PRIVATE KEY", b"0123456789-secret-key-bytes")
        );
        let big = pem_block("CERTIFICATE", &vec![0x30; MAX_RELAY_CA_DER + 1]);
        let huge = "x".repeat(MAX_RELAY_CA_PEM + 1);
        let broken = "-----BEGIN CERTIFICATE-----\n!!!not base64!!!\n-----END CERTIFICATE-----\n";
        for (input, why) in [
            (five.as_str(), "more than 4"),
            (key.as_str(), "not a CERTIFICATE"),
            (big.as_str(), "over 8192"),
            (huge.as_str(), "over 64 KiB"),
            (broken, "not valid PEM"),
            ("no pem at all", "no CERTIFICATE"),
            ("", "no CERTIFICATE"),
        ] {
            let err = relay_cas_from_pem(input.as_bytes())
                .unwrap_err()
                .to_string();
            assert!(err.contains(why), "{why}: {err}");
            assert!(!err.contains("secret-key"), "the content leaked: {err}");
            assert!(!err.contains("not base64"), "the content leaked: {err}");
        }
    }

    #[test]
    fn the_config_debug_prints_only_how_many_cas() {
        let cfg = NodeConfig {
            relay_cas: vec![CertificateDer::from(a_ca())],
            ..NodeConfig::default()
        };
        let text = format!("{cfg:?}");
        assert!(text.contains("relay_cas: 1"), "{text}");
    }
}
