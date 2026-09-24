//! The NFX-04 scoped relay: NIP-11, admission, the §2 limits, and ephemeral beacons,
//! exercised through a real WebSocket client.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::rt::TokioIo;
use nfx_node::nostr::{ManifestQuery, Relays, sign_manifest};
use nfx_node::relay::{MANIFESTS_PER_HOUR, ScopedRelay};
use nfx_node::unix_now;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint};
use nfx_proto::event::Event;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::{Namespace, VideoAddr};
use nostr_sdk::prelude::{Client, EventBuilder, Filter, FinalizeEvent as _, Keys, Kind, Timestamp};
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(10);

fn vector() -> (Manifest, Keys, Keys) {
    let v: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
    let event: Event = serde_json::from_value(v["event"].clone()).unwrap();
    let keys = |who: &str| Keys::parse(v["secret_keys_DO_NOT_USE"][who].as_str().unwrap()).unwrap();
    (
        Manifest::from_event(&event).unwrap(),
        keys("creator"),
        keys("seeder"),
    )
}

fn content(manifest: &Manifest) -> BeaconContent {
    BeaconContent {
        v: 1,
        video: manifest.addr.clone(),
        endpoints: vec![Endpoint::Https {
            url: "https://seed.example/nfx".into(),
        }],
        skipped: vec![],
        chunks: Chunks::All,
        price_hint: 0,
        accepts_mints: vec![],
        free: true,
    }
}

/// Send `event` and return the relay's refusal message (panics if it was accepted).
async fn refusal(client: &Client, event: &Event) -> String {
    let event =
        nostr_sdk::prelude::Event::from_json(serde_json::to_string(event).unwrap()).unwrap();
    let out = client.send_event(&event).await.unwrap();
    assert!(out.success.is_empty(), "expected a refusal");
    out.failed.values().next().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_scoped_relay_admits_limits_and_forwards_only_nfx() {
    let (manifest, creator, seeder) = vector();
    let ns = manifest.addr.namespace().clone();
    let relay = Arc::new(ScopedRelay::new(std::slice::from_ref(&ns)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(relay.clone().serve(listener));
    let url = format!("ws://{addr}");

    // NIP-11 (§3).
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(conn);
    let res = sender
        .send_request(
            Request::get("/")
                .header("host", "relay.test")
                .header("accept", "application/nostr+json")
                .body(Empty::<Bytes>::new())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.headers()["access-control-allow-origin"], "*");
    let doc: Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(doc["nfx"]["networks"], serde_json::json!([ns.to_string()]));
    assert_eq!(doc["nfx"]["kinds"], serde_json::json!([38504, 20464]));
    let nips = doc["supported_nips"].as_array().unwrap();
    assert!(nips.contains(&11.into()) && nips.contains(&40.into()));

    let publisher = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();
    let reader = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();
    let client = Client::default();
    client.add_relay(url.as_str()).await.unwrap();
    client.connect().and_wait(WAIT).await;

    // §1: anything but NFX kinds in this namespace is refused.
    let note = EventBuilder::new(Kind::TextNote, "hello")
        .finalize(&creator)
        .unwrap();
    let note: Event = serde_json::from_str(&note.as_json()).unwrap();
    assert!(
        refusal(&client, &note)
            .await
            .starts_with("blocked: out of scope")
    );
    let foreign = Manifest {
        addr: VideoAddr::new(
            Namespace::parse("nfx:testnet:1").unwrap(),
            "salt-flats-dusk",
        )
        .unwrap(),
        ..manifest.clone()
    };
    let (foreign, _) = sign_manifest(&creator, &foreign, unix_now()).await.unwrap();
    assert!(
        refusal(&client, &foreign)
            .await
            .starts_with("blocked: out of scope")
    );
    let bad = EventBuilder::new(Kind::from(38504u16), "")
        .tags([
            nostr_sdk::prelude::Tag::parse(["n", &ns.to_string()]).unwrap(),
            nostr_sdk::prelude::Tag::parse(["d", &manifest.addr.to_string()]).unwrap(),
        ])
        .finalize(&creator)
        .unwrap();
    let bad: Event = serde_json::from_str(&bad.as_json()).unwrap();
    assert!(
        refusal(&client, &bad).await.starts_with("invalid:"),
        "fails NFX-02"
    );

    // A far-future revision would outrank every real one and never leave a capped store.
    let (future, _) = sign_manifest(&creator, &manifest, unix_now() + 3600)
        .await
        .unwrap();
    assert!(
        refusal(&client, &future)
            .await
            .starts_with("invalid: created_at is in the future")
    );

    // §2: 12 manifests per pubkey per hour, then refused.
    let now = unix_now();
    let mut latest = None;
    for i in 0..MANIFESTS_PER_HOUR as u64 {
        let (ev, parsed) = sign_manifest(&creator, &manifest, now - 100 + i)
            .await
            .unwrap();
        assert_eq!(publisher.publish(&ev).await.unwrap(), 1, "revision {i}");
        latest = Some(parsed);
    }
    let (ev, _) = sign_manifest(&creator, &manifest, now).await.unwrap();
    assert!(
        refusal(&client, &ev).await.starts_with("rate-limited:"),
        "13th in an hour"
    );
    let query = ManifestQuery {
        namespace: ns.clone(),
        authors: vec![creator.public_key().to_hex()],
        videos: vec![],
    };
    let manifest = latest.unwrap();
    assert_eq!(
        reader.manifests(&query, WAIT).await.unwrap(),
        vec![manifest.clone()]
    );

    // Beacons: forwarded live. The reader's REQ is ordered before its next fetch on the
    // same connection, so once that fetch returns the subscription is live.
    let mut watch = reader
        .watch_beacons(&ns, &[manifest.a_tag()])
        .await
        .unwrap();
    reader.manifests(&query, WAIT).await.unwrap();
    publisher
        .announce(&seeder, &manifest, &content(&manifest))
        .await
        .unwrap();
    let got = tokio::time::timeout(WAIT, watch.next())
        .await
        .unwrap()
        .unwrap();
    assert!(got.serves(&manifest));

    // §2: one beacon per (pubkey, a) per 20 s.
    let again = nfx_node::nostr::sign_beacon(
        &seeder,
        &manifest.a_tag(),
        &content(&manifest),
        unix_now(),
        120,
    )
    .await
    .unwrap();
    assert!(refusal(&client, &again).await.starts_with("rate-limited:"));

    // Ephemeral: a fresh REQ finds no beacon stored.
    let stored = client
        .fetch_events(
            Filter::new()
                .kind(Kind::from(20464u16))
                .since(Timestamp::from(now - 600)),
        )
        .timeout(WAIT)
        .await
        .unwrap();
    assert!(stored.is_empty(), "beacons are never persisted");
    client.shutdown().await;

    publisher.shutdown().await;
    reader.shutdown().await;
    relay.shutdown();
    server.abort();
}
