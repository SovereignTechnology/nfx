//! A seeder behind a DNAT: it binds a fixed UDP port on every interface and advertises an
//! external address in front of it (`NodeConfig::bind_addr`, `external_addrs`). A fetcher
//! with no relay and no address book reaches it through that address alone, and nothing the
//! seeder advertises is one of its interface addresses.
//! Content: the NFX test-vector video (`spec/test-vectors/`).
//!
//! Linux only: it routes all of 127/8 to the loopback interface, so 127.0.0.2 stands in for
//! a DNAT's public address in front of a socket bound on every interface. Other systems may
//! not.

#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::net::{Ipv4Addr, SocketAddr};

use common::{tmp, vector_store};
use iroh::{EndpointAddr, TransportAddr};
use iroh_blobs::BlobFormat;
use iroh_blobs::ticket::BlobTicket;
use nfx_node::fetch::Anchor;
use nfx_node::node::{Node, NodeConfig, is_public};
use nfx_node::store::{ContentStore, FsStore};
use nfx_proto::beacon::Endpoint;

#[tokio::test(flavor = "multi_thread")]
async fn a_fetcher_with_no_relay_reaches_a_seeder_through_its_external_address_alone() {
    let (seed_store, v) = vector_store(&tmp("external-seed"));
    let video = v.manifest.addr.clone();
    let segs = v.manifest.segs;

    // A fixed port, as an operator forwards one. (Free a moment ago; the bind proves it.)
    let port = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let external = SocketAddr::from((Ipv4Addr::new(127, 0, 0, 2), port));
    let seeder = Node::spawn(NodeConfig {
        bind_addr: Some((Ipv4Addr::UNSPECIFIED, port).into()),
        external_addrs: vec![external],
        no_portmapper: true,
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    assert!(
        seeder
            .endpoint()
            .bound_sockets()
            .contains(&(Ipv4Addr::UNSPECIFIED, port).into()),
        "bound on the fixed port: {:?}",
        seeder.endpoint().bound_sockets()
    );
    let seeded = seeder
        .seed(&seed_store, &v.manifest.root_hex(), &video, segs)
        .await
        .unwrap();

    // What the seeder publishes: the external address, and no interface address (the
    // loopback and private ones it is bound on), in its tickets and in its beacon.
    for ticket in std::iter::once(&seeded.meta).chain(seeded.renditions.values()) {
        let addrs: Vec<SocketAddr> = ticket.addr().ip_addrs().copied().collect();
        assert!(addrs.contains(&external), "{addrs:?}");
        assert!(
            addrs.iter().all(|a| *a == external || is_public(a)),
            "an interface address is advertised: {addrs:?}"
        );
        assert_eq!(ticket.addr().relay_urls().count(), 0, "no relay");
    }
    let Endpoint::Iroh { addrs, relay, .. } = seeder.beacon_endpoint(&seeded) else {
        panic!("an iroh endpoint");
    };
    assert!(relay.is_empty());
    assert!(addrs.contains(&external.to_string()), "{addrs:?}");
    for a in &addrs {
        let a: SocketAddr = a.parse().unwrap();
        assert!(a == external || is_public(&a), "beacon advertises {a}");
    }

    // A fetcher with no relay and no address book, given only the external address.
    let fetcher = Node::spawn(NodeConfig {
        no_portmapper: true,
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    let only = EndpointAddr::from_parts(seeder.id(), [TransportAddr::Ip(external)]);
    let meta = BlobTicket::new(only.clone(), seeded.meta.hash(), BlobFormat::HashSeq);
    let r720 = BlobTicket::new(only, seeded.renditions["720p"].hash(), BlobFormat::HashSeq);
    let dest = FsStore::open(tmp("external-dest")).unwrap();
    let anchor = Anchor {
        root: &seeded.root,
        video: &video,
        segs,
    };
    let list = fetcher
        .fetch(&anchor, &meta, &[("720p".into(), r720)], &dest)
        .await
        .unwrap();
    assert_eq!(list, v.list);
    for f in &v.list.files {
        assert!(dest.has(&f.sha256), "{} fetched", f.name);
        dest.get(&f.sha256).unwrap(); // re-verified on read
    }

    for n in [seeder, fetcher] {
        n.shutdown().await.unwrap();
    }
}
