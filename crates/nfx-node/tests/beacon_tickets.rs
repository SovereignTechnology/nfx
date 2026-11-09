//! A beacon's tickets name the node's address as it is when the beacon is made, not as it
//! was when seeding started: a seeder whose iroh relay comes up only after it began seeding
//! names the relay in its next beacon.
//! Content: the NFX test-vector video (`spec/test-vectors/`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::net::Ipv4Addr;
use std::time::Duration;

use common::{tmp, vector_store};
use iroh::RelayUrl;
use iroh_blobs::ticket::BlobTicket;
use nfx_node::node::{Node, NodeConfig};
use nfx_proto::beacon::Endpoint;

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_reached_after_seeding_started_is_in_the_next_beacons_tickets() {
    let (seed_store, v) = vector_store(&tmp("late-relay-tickets"));
    // The relay's port: free now, taken only after seeding started.
    let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let late: RelayUrl = format!("http://127.0.0.1:{port}").parse().unwrap();
    let seeder = Node::spawn(NodeConfig {
        relays: vec![late.clone()],
        no_portmapper: true,
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    let seeded = seeder
        .seed(
            &seed_store,
            &v.manifest.root_hex(),
            &v.manifest.addr,
            v.manifest.segs,
        )
        .await
        .unwrap();
    // Made with no relay reached: the tickets fixed at seeding name none.
    assert_eq!(seeded.meta.addr().relay_urls().count(), 0);

    let _relay = {
        use iroh_relay::server::{RelayConfig, Server, ServerConfig};
        let mut config = ServerConfig::default();
        config.relay = Some(RelayConfig::new((Ipv4Addr::LOCALHOST, port)));
        Server::spawn(config).await.unwrap()
    };
    seeder.online(Duration::from_secs(90)).await.unwrap();

    let Endpoint::Iroh { relay, tickets, .. } = seeder.beacon_endpoint(&seeded) else {
        panic!("an iroh endpoint");
    };
    assert_eq!(relay.parse::<RelayUrl>().unwrap(), late);
    assert_eq!(
        tickets.len(),
        seeded.renditions.len() + 1,
        "meta and each rendition"
    );
    for (id, ticket) in &tickets {
        let ticket: BlobTicket = ticket.parse().unwrap();
        assert_eq!(
            ticket.addr().relay_urls().collect::<Vec<_>>(),
            [&late],
            "{id}"
        );
        // The same content as the tickets made at seeding.
        let fixed = if id == "meta" {
            &seeded.meta
        } else {
            &seeded.renditions[id]
        };
        assert_eq!(ticket.hash_and_format(), fixed.hash_and_format(), "{id}");
    }
    seeder.shutdown().await.unwrap();
}
