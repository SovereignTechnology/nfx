//! The iroh side of a peer: one endpoint serving iroh-blobs and `nfx/gossip/1`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
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

use crate::relay_class::RelayClass;
use crate::transfers::TransferLog;
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

/// At most this many external addresses (`NodeConfig::external_addrs`): each one goes into
/// every ticket of every beacon.
pub const MAX_EXTERNAL_ADDRS: usize = 4;

/// IPv4 blocks that are never public: IANA's special-purpose blocks that are not globally
/// reachable, plus multicast and the reserved 240/4 (which holds the broadcast address).
const NOT_PUBLIC_V4: [(Ipv4Addr, u32); 15] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),       // "this network"
    (Ipv4Addr::new(10, 0, 0, 0), 8),      // private
    (Ipv4Addr::new(100, 64, 0, 0), 10),   // shared address space (CGNAT)
    (Ipv4Addr::new(127, 0, 0, 0), 8),     // loopback
    (Ipv4Addr::new(169, 254, 0, 0), 16),  // link-local
    (Ipv4Addr::new(172, 16, 0, 0), 12),   // private
    (Ipv4Addr::new(192, 0, 0, 0), 24),    // IETF protocol assignments
    (Ipv4Addr::new(192, 0, 2, 0), 24),    // documentation
    (Ipv4Addr::new(192, 88, 99, 0), 24),  // 6to4 relay anycast (deprecated)
    (Ipv4Addr::new(192, 168, 0, 0), 16),  // private
    (Ipv4Addr::new(198, 18, 0, 0), 15),   // benchmarking
    (Ipv4Addr::new(198, 51, 100, 0), 24), // documentation
    (Ipv4Addr::new(203, 0, 113, 0), 24),  // documentation
    (Ipv4Addr::new(224, 0, 0, 0), 4),     // multicast
    (Ipv4Addr::new(240, 0, 0, 0), 4),     // reserved, and the broadcast address
];

/// Only global unicast IPv6 (2000::/3) can be public, and within it not these blocks.
const NOT_PUBLIC_V6: [(Ipv6Addr, u32); 4] = [
    // IETF protocol assignments: Teredo, benchmarking, ORCHID and others.
    (Ipv6Addr::new(0x2001, 0, 0, 0, 0, 0, 0, 0), 23),
    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32), // documentation
    // 6to4: it wraps an IPv4 address, which may be a private one.
    (Ipv6Addr::new(0x2002, 0, 0, 0, 0, 0, 0, 0), 16),
    (Ipv6Addr::new(0x3fff, 0, 0, 0, 0, 0, 0, 0), 20), // documentation
];

/// Whether `addr` is a public unicast address that peers on the internet can dial. It fails
/// closed: anything not known to be public is not. So private, shared (CGNAT), loopback,
/// link-local, unique-local, documentation, benchmarking, multicast and reserved addresses
/// are not, nor IPv6 outside 2000::/3 (which takes in IPv4-mapped and NAT64 addresses),
/// 6to4, Teredo and the other IETF blocks, nor any address with port 0.
#[must_use]
pub fn is_public(addr: &SocketAddr) -> bool {
    if addr.port() == 0 {
        return false;
    }
    match addr.ip() {
        IpAddr::V4(ip) => {
            let bits = ip.to_bits();
            !NOT_PUBLIC_V4.iter().any(|&(net, len)| {
                let mask = u32::MAX << (32 - len);
                bits & mask == net.to_bits() & mask
            })
        }
        IpAddr::V6(ip) => {
            let bits = ip.to_bits();
            let within = |net: Ipv6Addr, len: u32| {
                let mask = u128::MAX << (128 - len);
                bits & mask == net.to_bits() & mask
            };
            within(Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3)
                && !NOT_PUBLIC_V6.iter().any(|&(net, len)| within(net, len))
        }
    }
}

/// Whether `ip` is an address of this host or of a network it is on directly: loopback,
/// private (RFC 1918), shared (100.64.0.0/10: carrier NATs and tailnets), link-local, or
/// unique-local (fc00::/7); an IPv4-mapped IPv6 address is read as its IPv4 address. Every
/// such address is also not public ([`is_public`]), but not the other way round:
/// documentation, benchmarking, NAT64, 6to4, Teredo and the other special-purpose blocks are
/// neither, so a relay reached at one of them may be anywhere ([`crate::relay_class`]).
#[must_use]
pub fn is_local(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let shared = v4.to_bits() & (u32::MAX << 22) == Ipv4Addr::new(100, 64, 0, 0).to_bits();
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || shared
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local(),
    }
}

/// `addr` with its relays and only those of its direct addresses that are public
/// ([`is_public`]): every other direct address (the interface addresses of a host on a home
/// or office network, behind a NAT or a DNAT) and any transport it does not know are dropped.
#[must_use]
pub fn only_public(addr: EndpointAddr) -> EndpointAddr {
    let kept = addr.addrs.into_iter().filter(|t| match t {
        TransportAddr::Relay(_) => true,
        TransportAddr::Ip(ip) => is_public(ip),
        _ => false,
    });
    EndpointAddr::from_parts(addr.id, kept)
}

/// `addr` as [`Node::addr`] advertises it, given the configured external addresses. With
/// none, it is unchanged. Otherwise it is [`only_public`] plus every external address as
/// given.
#[must_use]
pub fn advertised(addr: EndpointAddr, external: &[SocketAddr]) -> EndpointAddr {
    if external.is_empty() {
        return addr;
    }
    let kept = only_public(addr);
    let external = external.iter().copied().map(TransportAddr::Ip);
    EndpointAddr::from_parts(kept.id, kept.addrs.into_iter().chain(external))
}

/// `seen`, the endpoint's own address, as [`Node::addr_for`] gives it to readers of `class`.
/// For a relay on this host's own networks ([`RelayClass::Private`]): [`advertised`], after
/// [`only_public`] when `public_only`. For any other reader ([`RelayClass::Public`]): only its
/// relays and public direct addresses, plus the external addresses as given.
#[must_use]
pub fn advertised_to(
    seen: EndpointAddr,
    external: &[SocketAddr],
    public_only: bool,
    class: RelayClass,
) -> EndpointAddr {
    if public_only || class == RelayClass::Public {
        // With external addresses, `advertised` keeps only public ones itself; without,
        // it returns its input, here already public only.
        advertised(only_public(seen), external)
    } else {
        advertised(seen, external)
    }
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
    /// Bind the endpoint's UDP socket here, a fixed port that a NAT or a firewall can
    /// forward, instead of a random port on every interface. It replaces iroh's default
    /// socket for this address family only; the other family keeps its default. `None`:
    /// iroh's defaults, as before. Refused with `relay_only`.
    pub bind_addr: Option<SocketAddr>,
    /// Addresses at which this endpoint is reachable directly from outside, such as a public
    /// address whose UDP port is forwarded to `bind_addr` (at most [`MAX_EXTERNAL_ADDRS`]).
    /// They are advertised as given. With any set, [`Node::addr`] (tickets and beacons)
    /// leaves out every direct address that is not public ([`advertised`]). Refused with
    /// `relay_only`.
    pub external_addrs: Vec<SocketAddr>,
    /// Never publish a direct address that is not public: [`Node::addr`] (tickets, beacons)
    /// leaves out every private, shared, loopback and link-local address even with no
    /// external address set ([`only_public`]). For a viewer that seeds what its user
    /// watches: what it announces must not map the user's home network. Off: as before,
    /// every direct address iroh found is published unless `external_addrs` is set.
    pub public_addrs_only: bool,
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
            .field("bind_addr", &self.bind_addr)
            .field("external_addrs", &self.external_addrs)
            .field("public_addrs_only", &self.public_addrs_only)
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
    /// `NodeConfig::external_addrs`: with any, only public direct addresses are advertised.
    external: Vec<SocketAddr>,
    /// `NodeConfig::public_addrs_only`: only public direct addresses are advertised.
    public_only: bool,
    /// Where fetched bytes came from, per video and seeder (nfx #99).
    transfers: Arc<TransferLog>,
}

impl Node {
    pub async fn spawn(cfg: NodeConfig) -> Result<Self> {
        if cfg.relay_only && (cfg.bind_addr.is_some() || !cfg.external_addrs.is_empty()) {
            return Err(NodeError::Transport(
                "a relay-only node binds no UDP socket and has no external address".into(),
            ));
        }
        if cfg.external_addrs.len() > MAX_EXTERNAL_ADDRS {
            return Err(NodeError::Transport(format!(
                "more than {MAX_EXTERNAL_ADDRS} external addresses"
            )));
        }
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
        if let Some(addr) = cfg.bind_addr {
            builder = builder.bind_addr(addr).map_err(NodeError::transport)?;
        }
        for addr in &cfg.external_addrs {
            builder = builder.external_addr(*addr);
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
            external: cfg.external_addrs,
            public_only: cfg.public_addrs_only,
            transfers: Arc::default(),
        })
    }

    /// Where this node's fetched bytes came from, per video and seeder: what a viewer's
    /// "stats for nerds" shows (nfx #99). Read on request only.
    pub fn transfers(&self) -> &TransferLog {
        &self.transfers
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

    /// What this node advertises at most (tickets and beacons for a relay on this host's own
    /// networks, `gossip peer:` lines): the endpoint id plus its home relay and its direct
    /// addresses. With external addresses configured, those are always in it and the other
    /// direct addresses only when public ([`advertised`]), so an interface address behind a
    /// NAT or a DNAT is never published. With `public_addrs_only`, the same holds with no
    /// external address ([`only_public`]). Anything any other reader gets is
    /// [`Node::addr_for`] with [`RelayClass::Public`]. iroh itself still tells a peer that is
    /// already connected all of its candidates (NAT traversal, gossip peer data): this filters
    /// what reaches the world, not what a connected peer learns.
    #[must_use]
    pub fn addr(&self) -> EndpointAddr {
        self.addr_for(RelayClass::Private)
    }

    /// What to publish where `class` reads it (NFX-03 §4 as amended 2026-11-26): for a relay
    /// reached at an address of this host's own networks, [`Node::addr`]; for any other reader
    /// (a relay reached at a public address, a gossip swarm), only the home relay, public
    /// direct addresses and the external addresses, so that no LAN, VPN, tailnet or loopback
    /// address reaches the world ([`advertised_to`]).
    #[must_use]
    pub fn addr_for(&self, class: RelayClass) -> EndpointAddr {
        advertised_to(
            self.router.endpoint().addr(),
            &self.external,
            self.public_only,
            class,
        )
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

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_public_unicast_addresses_with_a_port_count_as_public() {
        for public in [
            "8.8.8.8:7843",
            "1.0.0.1:1",
            "172.15.255.255:1",  // just below 172.16/12
            "172.32.0.0:1",      // just above it
            "100.63.255.255:1",  // just below 100.64/10
            "100.128.0.0:1",     // just above it
            "192.0.1.255:1",     // between 192.0.0/24 and 192.0.2/24
            "198.17.255.255:1",  // just below 198.18/15
            "198.20.0.0:1",      // just above it
            "223.255.255.255:1", // just below multicast
            "[2001:4860:4860::8888]:7843",
            "[2001:200::1]:1",  // just above 2001::/23
            "[2003::1]:1",      // just above 6to4
            "[3ffe:ffff::1]:1", // just below 3fff::/20
        ] {
            assert!(is_public(&sa(public)), "{public} is public");
        }
        for not in [
            "0.0.0.0:1",
            "0.1.2.3:1",
            "10.1.2.3:1",
            "100.64.0.0:1",
            "100.127.255.255:1",
            "127.0.0.1:1",
            "127.1.2.3:1",
            "169.254.10.20:1",
            "172.16.0.1:1",
            "172.31.255.255:1",
            "192.0.0.9:1",
            "192.0.2.1:1",
            "192.88.99.1:1",
            "192.168.1.1:1",
            "198.18.0.1:1",
            "198.19.255.255:1",
            "198.51.100.7:1",
            "203.0.113.7:1",
            "224.0.0.1:1",
            "239.255.255.250:1",
            "240.0.0.1:1",
            "255.255.255.255:1",
            "8.8.8.8:0",
            "[::]:1",
            "[::1]:1",
            "[::ffff:8.8.8.8]:1",
            "[64:ff9b::808:808]:1",
            "[fc00::1]:1",
            "[fd12:3456::1]:1",
            "[fe80::1]:1",
            "[ff02::1]:1",
            "[2001::1]:1",
            "[2001:1ff:ffff::1]:1",
            "[2001:db8::1]:1",
            "[2002:c0a8:101::1]:1",
            "[3fff::1]:1",
            "[2001:4860:4860::8888]:0",
        ] {
            assert!(!is_public(&sa(not)), "{not} is not public");
        }
        // Never public where the standard library's stable predicates say otherwise.
        for a in 0..=255u8 {
            for b in [0, 2, 16, 31, 51, 64, 88, 127, 168, 254, 255] {
                for c in [0, 2, 99, 100, 113, 255] {
                    let ip = Ipv4Addr::new(a, b, c, 1);
                    let std_says_not = ip.is_unspecified()
                        || ip.is_private()
                        || ip.is_loopback()
                        || ip.is_link_local()
                        || ip.is_documentation()
                        || ip.is_multicast()
                        || ip.is_broadcast();
                    if std_says_not {
                        assert!(!is_public(&SocketAddr::new(ip.into(), 1)), "{ip}");
                    }
                }
            }
        }
        for ip in [Ipv6Addr::LOCALHOST, Ipv6Addr::UNSPECIFIED] {
            assert!(!is_public(&SocketAddr::new(ip.into(), 1)), "{ip}");
        }
    }

    #[test]
    fn with_an_external_address_only_public_ones_are_advertised() {
        let id = runtime_id();
        let relay: RelayUrl = "https://relay.example/".parse().unwrap();
        let ip = |s: &str| TransportAddr::Ip(sa(s));
        let seen = EndpointAddr::from_parts(
            id,
            [
                TransportAddr::Relay(relay.clone()),
                ip("10.1.2.3:7843"),
                ip("127.0.0.1:7843"),
                ip("[fe80::1]:7843"),
                ip("[fd00::5]:7843"),
                ip("8.8.8.8:40000"),
            ],
        );
        // Without one, nothing changes.
        assert_eq!(advertised(seen.clone(), &[]), seen);
        // With one: the relay, the public address and the external one; no interface
        // address. The external address is kept as given even where it is not public.
        let external = [sa("203.0.113.7:7843")];
        let out = advertised(seen.clone(), &external);
        let want = EndpointAddr::from_parts(
            id,
            [
                TransportAddr::Relay(relay.clone()),
                ip("8.8.8.8:40000"),
                ip("203.0.113.7:7843"),
            ],
        );
        assert_eq!(out, want);
        // Before iroh has reported any address, the external one is there already.
        let bare = EndpointAddr::from_parts(id, []);
        assert_eq!(
            advertised(bare, &external).ip_addrs().collect::<Vec<_>>(),
            [&external[0]]
        );
    }

    /// An endpoint id from a key made at run time: no key material in the source.
    fn runtime_id() -> EndpointId {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        SecretKey::from(seed).public()
    }

    #[test]
    fn only_public_keeps_relays_and_public_addresses() {
        let id = runtime_id();
        let relay: RelayUrl = "https://relay.example/".parse().unwrap();
        let ip = |s: &str| TransportAddr::Ip(sa(s));
        let seen = EndpointAddr::from_parts(
            id,
            [
                TransportAddr::Relay(relay.clone()),
                ip("192.168.1.20:7843"),
                ip("10.1.2.3:7843"),
                ip("100.64.0.3:7843"),
                ip("127.0.0.1:7843"),
                ip("[fe80::1]:7843"),
                ip("[fd00::5]:7843"),
                ip("8.8.8.8:40000"),
                ip("[2001:4860:4860::8888]:40000"),
            ],
        );
        let want = EndpointAddr::from_parts(
            id,
            [
                TransportAddr::Relay(relay),
                ip("8.8.8.8:40000"),
                ip("[2001:4860:4860::8888]:40000"),
            ],
        );
        assert_eq!(only_public(seen), want);
        // Nothing public at all: the id alone, never an empty-but-wrong list.
        let home = EndpointAddr::from_parts(id, [ip("192.168.1.20:7843")]);
        assert_eq!(only_public(home), EndpointAddr::from_parts(id, []));
    }

    #[test]
    fn a_relay_on_this_hosts_networks_hears_every_address_and_any_other_only_public_ones() {
        let id = runtime_id();
        let relay: RelayUrl = "https://relay.example/".parse().unwrap();
        let ip = |s: &str| TransportAddr::Ip(sa(s));
        let seen = EndpointAddr::from_parts(
            id,
            [
                TransportAddr::Relay(relay.clone()),
                ip("192.168.1.20:7843"),
                ip("100.100.1.2:7843"),
                ip("[fd7a:115c:a1e0::5]:7843"),
                ip("8.8.8.8:40000"),
            ],
        );
        let public = EndpointAddr::from_parts(
            id,
            [TransportAddr::Relay(relay.clone()), ip("8.8.8.8:40000")],
        );
        // No external address: the relay's class decides.
        assert_eq!(
            advertised_to(seen.clone(), &[], false, RelayClass::Private),
            seen
        );
        assert_eq!(
            advertised_to(seen.clone(), &[], false, RelayClass::Public),
            public
        );
        // `public_addrs_only`: public only, whoever reads it.
        for class in [RelayClass::Private, RelayClass::Public] {
            assert_eq!(advertised_to(seen.clone(), &[], true, class), public);
        }
        // An external address is kept as given for every reader, and with one even a relay on
        // this host's networks hears no private address (as `advertised` always did).
        let external = [sa("203.0.113.7:7843")];
        let with_external = EndpointAddr::from_parts(
            id,
            [
                TransportAddr::Relay(relay),
                ip("8.8.8.8:40000"),
                ip("203.0.113.7:7843"),
            ],
        );
        for (only, class) in [
            (false, RelayClass::Private),
            (false, RelayClass::Public),
            (true, RelayClass::Public),
        ] {
            assert_eq!(
                advertised_to(seen.clone(), &external, only, class),
                with_external
            );
        }
    }

    #[test]
    fn local_addresses_are_this_hosts_and_its_own_networks_only() {
        for local in [
            "127.0.0.1",
            "::1",
            "10.0.0.1",
            "172.16.5.4",
            "192.168.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "169.254.1.1",
            "fe80::1",
            "fc00::1",
            "fdff:ffff::1",
            "::ffff:10.0.0.1",
        ] {
            let ip: IpAddr = local.parse().unwrap();
            assert!(is_local(ip), "{local}");
            assert!(!is_public(&SocketAddr::new(ip, 443)), "{local}");
        }
        for other in [
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.0.1",
            "172.32.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "::",
            "2001:db8::1",
            "64:ff9b::a00:1",
            "2002:a00:1::1",
            "fe00::1",
            "ff02::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_local(other.parse().unwrap()), "{other}");
        }
    }

    /// A real endpoint bound to loopback: its address goes to a relay on this host and to no
    /// other.
    #[tokio::test]
    async fn a_node_names_its_loopback_address_only_to_a_relay_on_this_host() {
        let node = Node::spawn(NodeConfig {
            no_portmapper: true,
            bind_addr: Some(sa("127.0.0.1:0")),
            ..NodeConfig::default()
        })
        .await
        .unwrap();
        let bound = node
            .endpoint()
            .bound_sockets()
            .into_iter()
            .find(|a| a.ip().is_loopback())
            .expect("the loopback socket");
        // iroh reports its bound address shortly after binding.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !node.addr().ip_addrs().any(|a| *a == bound) && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let private: Vec<SocketAddr> = node
            .addr_for(RelayClass::Private)
            .ip_addrs()
            .copied()
            .collect();
        assert!(private.contains(&bound), "{private:?} lacks {bound}");
        assert_eq!(node.addr(), node.addr_for(RelayClass::Private));
        let public = node.addr_for(RelayClass::Public);
        assert!(public.ip_addrs().all(is_public), "{public:?}");
        assert!(!public.ip_addrs().any(|a| *a == bound), "{public:?}");
        assert_eq!(public.id, node.id());
        node.shutdown().await.unwrap();
    }

    /// A real endpoint: whatever interface addresses iroh finds, a `public_addrs_only` node
    /// publishes none that is not public, and still publishes an external address as given.
    #[tokio::test]
    async fn a_public_addrs_only_node_never_publishes_a_private_address() {
        let node = Node::spawn(NodeConfig {
            no_portmapper: true,
            public_addrs_only: true,
            ..NodeConfig::default()
        })
        .await
        .unwrap();
        // iroh reports its interface addresses shortly after binding.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while node.endpoint().addr().ip_addrs().next().is_none()
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let seen: Vec<SocketAddr> = node.endpoint().addr().ip_addrs().copied().collect();
        let private = seen.iter().filter(|a| !is_public(a)).count();
        // Shown with --nocapture: whether this host's iroh saw any non-public address.
        eprintln!(
            "iroh saw {} direct address(es), {private} not public",
            seen.len()
        );
        assert!(node.addr().ip_addrs().all(is_public), "{:?}", node.addr());
        node.shutdown().await.unwrap();

        let external = sa("127.0.0.2:7843");
        let node = Node::spawn(NodeConfig {
            no_portmapper: true,
            public_addrs_only: true,
            bind_addr: Some(sa("127.0.0.1:0")),
            external_addrs: vec![external],
            ..NodeConfig::default()
        })
        .await
        .unwrap();
        // The external address as given (127.0.0.2 is not public); every other one public.
        let ips: Vec<SocketAddr> = node.addr().ip_addrs().copied().collect();
        assert!(ips.contains(&external), "{ips:?}");
        assert!(
            ips.iter().all(|a| *a == external || is_public(a)),
            "{ips:?}"
        );
        node.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn a_relay_only_node_takes_no_bind_or_external_address() {
        for cfg in [
            NodeConfig {
                relay_only: true,
                bind_addr: Some(sa("0.0.0.0:7843")),
                ..NodeConfig::default()
            },
            NodeConfig {
                relay_only: true,
                external_addrs: vec![sa("203.0.113.7:7843")],
                ..NodeConfig::default()
            },
            NodeConfig {
                external_addrs: vec![sa("203.0.113.7:7843"); MAX_EXTERNAL_ADDRS + 1],
                ..NodeConfig::default()
            },
        ] {
            assert!(Node::spawn(cfg).await.is_err());
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
