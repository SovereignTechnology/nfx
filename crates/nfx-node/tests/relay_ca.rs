//! `NodeConfig::relay_cas`: a network whose iroh relay uses a private CA. A relay-only
//! fetcher reaches the seeder through that relay only when it trusts the CA; without it the
//! TLS handshake fails and so does the fetch. Content: the NFX test-vector video.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::net::Ipv4Addr;
use std::time::Duration;

use common::{tmp, vector_store};
use iroh::RelayUrl;
use iroh::address_lookup::MemoryLookup;
use iroh_blobs::ticket::BlobTicket;
use iroh_relay::server::{CertConfig, RelayConfig, Server, ServerConfig, TlsConfig};
use nfx_node::fetch::Anchor;
use nfx_node::node::{CertificateDer, Node, NodeConfig};
use nfx_node::store::{ContentStore, FsStore};

/// An iroh relay serving TLS with a self-signed certificate (its own CA), and that CA.
async fn tls_relay() -> (Server, RelayUrl, Vec<CertificateDer<'static>>) {
    let (certs, server_config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let mut relay = RelayConfig::new((Ipv4Addr::LOCALHOST, 0));
    relay.tls = Some(TlsConfig::new(
        (Ipv4Addr::LOCALHOST, 0),
        CertConfig::Manual { server_config },
    ));
    let mut config = ServerConfig::default();
    config.relay = Some(relay);
    let server = Server::spawn(config).await.unwrap();
    let url = server.https_url().expect("an https relay");
    (server, url, certs)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_only_fetch_crosses_a_private_ca_relay_only_when_the_ca_is_trusted() {
    let (_relay, url, cas) = tls_relay().await;
    assert!(url.to_string().starts_with("https://"), "{url}");
    let (seed_store, v) = vector_store(&tmp("ca-seed"));
    let video = v.manifest.addr.clone();
    let segs = v.manifest.segs;

    // The seeder trusts the CA and keeps its direct addresses; it is online through the relay.
    let seeder = Node::spawn(NodeConfig {
        relays: vec![url.clone()],
        relay_cas: cas.clone(),
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    seeder.online(Duration::from_secs(10)).await.unwrap();
    let seeded = seeder
        .seed(&seed_store, &v.manifest.root_hex(), &video, segs)
        .await
        .unwrap();
    let meta: BlobTicket = seeded.meta.to_string().parse().unwrap();
    let r720: BlobTicket = seeded.renditions["720p"].to_string().parse().unwrap();
    let anchor = Anchor {
        root: &seeded.root,
        video: &video,
        segs,
    };

    // Without the CA: the relay's TLS is not trusted, so a relay-only node reaches no one.
    let lookup = MemoryLookup::new();
    lookup.add_endpoint_info(seeder.addr());
    let untrusting = Node::spawn(NodeConfig {
        relays: vec![url.clone()],
        relay_only: true,
        lookup: Some(lookup),
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    let refused = FsStore::open(tmp("ca-refused")).unwrap();
    let outcome = tokio::time::timeout(
        Duration::from_secs(45),
        untrusting.fetch(&anchor, &meta, &[("720p".into(), r720.clone())], &refused),
    )
    .await;
    assert!(
        !matches!(outcome, Ok(Ok(_))),
        "a fetch through an untrusted relay succeeded"
    );
    for f in &v.list.files {
        assert!(!refused.has(&f.sha256), "{} stored without trust", f.name);
    }

    // With the CA: the same relay-only fetch succeeds, every file under its sha256.
    let lookup = MemoryLookup::new();
    lookup.add_endpoint_info(seeder.addr());
    let trusting = Node::spawn(NodeConfig {
        relays: vec![url.clone()],
        relay_only: true,
        relay_cas: cas,
        lookup: Some(lookup),
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    trusting.online(Duration::from_secs(10)).await.unwrap();
    let dest = FsStore::open(tmp("ca-dest")).unwrap();
    let list = tokio::time::timeout(
        Duration::from_secs(60),
        trusting.fetch(&anchor, &meta, &[("720p".into(), r720)], &dest),
    )
    .await
    .expect("the trusted fetch finished in time")
    .unwrap();
    assert_eq!(list, v.list);
    for f in &v.list.files {
        assert!(dest.has(&f.sha256), "{} fetched", f.name);
        dest.get(&f.sha256).unwrap(); // re-verified on read
    }
}
