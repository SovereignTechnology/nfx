//! `nfxd stun`: a STUN server and nothing else (NFX-10 §1). A Binding round trip in process
//! and through the binary; an announcement signed, tagged and expiring as NFX-10 §1 says,
//! sent to a relay; and the settings it refuses.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{BufRead as _, BufReader};
use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use nfx_node::unix_now;
use nfx_proto::event::Event;
use nfx_proto::namespace::Namespace;
use nfx_proto::stun::{KIND_STUN_ANNOUNCEMENT, MAX_TTL, StunAnnouncement};
use nfxd::stun::{Limits, mapped_address};
use nfxd::stun_server::{Announce, StunConfig, StunServer};
use nostr_sdk::prelude as ns;
use tokio::net::UdpSocket;

const TX: [u8; 12] = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8];

fn binding_request(txid: [u8; 12]) -> Vec<u8> {
    let mut r = vec![0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42];
    r.extend_from_slice(&txid);
    r
}

/// Ask `server` for this client's mapping; `None` if no answer comes within 2 s.
async fn ask(server: SocketAddr) -> (SocketAddr, Option<SocketAddr>) {
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    client.connect(server).await.unwrap();
    client.send(&binding_request(TX)).await.unwrap();
    let mut buf = [0u8; 1500];
    let got = tokio::time::timeout(Duration::from_secs(2), client.recv(&mut buf))
        .await
        .ok()
        .and_then(Result::ok)
        .and_then(|n| mapped_address(&buf[..n], &TX));
    (client.local_addr().unwrap(), got)
}

fn config(bind: &str) -> StunConfig {
    StunConfig {
        bind: bind.parse().unwrap(),
        public: None,
        announce: None,
        limits: Limits::default(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_binding_round_trip_and_nothing_announced_without_announce() {
    let server = StunServer::start(config("127.0.0.1:0")).await.unwrap();
    let (me, mapped) = ask(server.local_addr()).await;
    assert_eq!(
        mapped,
        Some(me),
        "the server reports the client's own address"
    );
    // Loopback is not an address to announce, and none was asked for.
    assert_eq!(server.public_addr(), None);
    assert_eq!(server.announced(), None);
    server.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_announcement_is_signed_tagged_and_expires_in_24_hours() {
    let relay = ns::LocalRelay::builder().build();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();
    let keys = ns::Keys::generate();
    let testnet = Namespace::parse("nfx:testnet:1").unwrap();
    let mainnet = Namespace::parse("nfx:mainnet:1").unwrap();
    let public: SocketAddr = "203.0.113.10:3478".parse().unwrap();
    let before = unix_now();
    let server = StunServer::start(StunConfig {
        public: Some(public),
        announce: Some(Announce {
            keys: keys.clone(),
            relays: vec![url.clone()],
            networks: vec![testnet.clone(), mainnet.clone()],
        }),
        ..config("127.0.0.1:0")
    })
    .await
    .unwrap();
    assert_eq!(server.public_addr(), Some(public));
    // It still answers on the bound address.
    let (me, mapped) = ask(server.local_addr()).await;
    assert_eq!(mapped, Some(me));

    let deadline = Instant::now() + Duration::from_secs(30);
    let announced = loop {
        if let Some(a) = server.announced() {
            break a;
        }
        assert!(
            Instant::now() < deadline,
            "not announced: {:?}",
            server.announce_failure()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(announced.relays, 1);
    assert_eq!(announced.expiration - announced.created_at, MAX_TTL);

    let client = ns::Client::default();
    client.add_relay(url.as_str()).await.unwrap();
    client.connect().and_wait(Duration::from_secs(5)).await;
    let found = client
        .fetch_events(ns::Filter::new().kind(ns::Kind::from(KIND_STUN_ANNOUNCEMENT)))
        .timeout(Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    let ev: Event = serde_json::from_str(&found.iter().next().unwrap().as_json()).unwrap();
    ev.verify().unwrap();
    let a = StunAnnouncement::from_event(&ev, unix_now()).unwrap();
    assert_eq!(a.operator, keys.public_key().to_hex());
    assert_eq!(a.addr, public.to_string());
    assert_eq!(a.networks, [testnet, mainnet]);
    assert!(a.created_at >= before && a.created_at <= unix_now());
    assert_eq!(a.expiration, a.created_at + MAX_TTL);
    assert_eq!(ev.content, "");
    // It expires: a day on, no reader takes it.
    assert!(StunAnnouncement::from_event(&ev, a.expiration).is_err());

    server.shutdown();
    client.shutdown().await;
    relay.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn what_cannot_work_is_refused_before_anything_is_sent() {
    let net = Namespace::parse("nfx:testnet:1").unwrap();
    let announce = |relays: Vec<&str>, networks: Vec<Namespace>| Announce {
        keys: ns::Keys::generate(),
        relays: relays.into_iter().map(String::from).collect(),
        networks,
    };
    let public = Some("203.0.113.10:3478".parse().unwrap());
    for (cfg, why) in [
        (
            StunConfig {
                public: Some("192.168.1.2:3478".parse().unwrap()),
                ..config("127.0.0.1:0")
            },
            "--public",
        ),
        (
            // Nothing to announce: loopback, and no --public.
            StunConfig {
                announce: Some(announce(vec!["ws://127.0.0.1:1"], vec![net.clone()])),
                ..config("127.0.0.1:0")
            },
            "--announce",
        ),
        (
            StunConfig {
                public,
                announce: Some(announce(vec![], vec![net.clone()])),
                ..config("127.0.0.1:0")
            },
            "--relay",
        ),
        (
            StunConfig {
                public,
                announce: Some(announce(vec!["https://relay.example"], vec![net.clone()])),
                ..config("127.0.0.1:0")
            },
            "--relay",
        ),
        (
            StunConfig {
                public,
                announce: Some(announce(vec!["ws://127.0.0.1:1"], vec![])),
                ..config("127.0.0.1:0")
            },
            "--network",
        ),
        (
            StunConfig {
                public,
                announce: Some(announce(
                    vec!["ws://127.0.0.1:1"],
                    vec![net.clone(), net.clone()],
                )),
                ..config("127.0.0.1:0")
            },
            "--network",
        ),
    ] {
        let err = StunServer::start(cfg)
            .await
            .err()
            .expect("refused")
            .to_string();
        assert!(err.contains(why), "{why}: {err}");
    }
}

/// The binary: `nfxd stun --bind` prints its address and answers there; flags that need
/// `--announce`, or a missing `--bind`, are refused.
#[test]
fn the_binary_answers_on_its_bound_address() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_nfxd"))
        .args(["stun", "--bind", "127.0.0.1:0"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let line = lines.next().unwrap().unwrap();
    let addr: SocketAddr = line
        .strip_prefix("stun: udp ")
        .unwrap_or_else(|| panic!("{line}"))
        .parse()
        .unwrap();
    let rt = tokio::runtime::Runtime::new().unwrap();
    let (me, mapped) = rt.block_on(ask(addr));
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(mapped, Some(me));

    for (args, why) in [
        (vec!["stun"], "--bind is required"),
        (
            vec![
                "stun",
                "--bind",
                "127.0.0.1:0",
                "--network",
                "nfx:testnet:1",
            ],
            "need --announce",
        ),
        (vec!["stun", "--bind", "127.0.0.1"], "not an ip:port"),
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_nfxd"))
            .args(&args)
            .output()
            .unwrap();
        assert!(!out.status.success(), "{args:?}");
        let err = String::from_utf8_lossy(&out.stderr);
        assert!(err.contains(why), "{args:?}: {err}");
    }
}
