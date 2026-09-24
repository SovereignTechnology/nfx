//! Manifests and beacons through a real Nostr relay (nostr-sdk's in-process relay).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::Duration;

use nfx_node::nostr::{ManifestQuery, Relays, sign_beacon, sign_manifest};
use nfx_node::unix_now;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint};
use nfx_proto::event::Event;
use nfx_proto::manifest::Manifest;
use nostr_sdk::prelude::{EventBuilder, FinalizeEvent as _, Keys, Kind, MockRelay, Tag, Timestamp};
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

#[tokio::test(flavor = "multi_thread")]
async fn manifests_and_beacons_round_trip_through_a_relay() {
    let relay = MockRelay::run().await.unwrap();
    let url = relay.url().await.to_string();
    let (vector, creator, seeder) = vector();

    let publisher = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();
    let reader = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();

    // Two revisions of one manifest: readers see only the newer.
    let now = unix_now();
    let (first, _) = sign_manifest(&creator, &vector, now - 60).await.unwrap();
    let revised = Manifest {
        title: "Salt Flats at Dusk (director's cut)".into(),
        ..vector.clone()
    };
    let (second, second_parsed) = sign_manifest(&creator, &revised, now - 30).await.unwrap();
    assert_eq!(publisher.publish(&first).await.unwrap(), 1);
    assert_eq!(publisher.publish(&second).await.unwrap(), 1);

    // A kind-38504 event on the same namespace that fails NFX-02 (no `root`): a relay
    // stores it, readers drop it.
    let broken = EventBuilder::new(Kind::from(38504u16), "")
        .tags([
            Tag::parse(["d", "nfx:mainnet:1:broken"]).unwrap(),
            Tag::parse(["n", "nfx:mainnet:1"]).unwrap(),
            Tag::parse(["title", "x"]).unwrap(),
        ])
        .custom_created_at(Timestamp::from(now))
        .finalize(&creator)
        .unwrap();
    let broken: Event = serde_json::from_str(&broken.as_json()).unwrap();
    assert_eq!(publisher.publish(&broken).await.unwrap(), 1);

    let query = ManifestQuery {
        namespace: vector.addr.namespace().clone(),
        authors: vec![creator.public_key().to_hex()],
        videos: vec![],
    };
    let found = reader.manifests(&query, WAIT).await.unwrap();
    assert_eq!(found, vec![second_parsed.clone()]);
    let by_video = ManifestQuery {
        authors: vec![],
        videos: vec![vector.addr.clone()],
        ..query.clone()
    };
    assert_eq!(reader.manifests(&by_video, WAIT).await.unwrap(), found);
    let stranger = ManifestQuery {
        authors: vec![seeder.public_key().to_hex()],
        ..query
    };
    assert!(reader.manifests(&stranger, WAIT).await.unwrap().is_empty());

    // Beacons: the reader watches the manifest's address; the seeder announces until the
    // subscription is live (a beacon is ephemeral, so one sent before the REQ is gone).
    let manifest = second_parsed;
    let mut watch = reader
        .watch_beacons(manifest.addr.namespace(), &[manifest.a_tag()])
        .await
        .unwrap();
    let first_seen = tokio::time::timeout(WAIT, async {
        loop {
            publisher
                .announce(&seeder, &manifest, &content(&manifest))
                .await
                .unwrap();
            if let Ok(Some(b)) =
                tokio::time::timeout(Duration::from_millis(300), watch.next()).await
            {
                break b;
            }
        }
    })
    .await
    .unwrap();
    assert!(first_seen.serves(&manifest));
    assert_eq!(first_seen.seeder, seeder.public_key().to_hex());
    assert_eq!(first_seen.content, content(&manifest));

    // Older than what the table holds: skipped (NFX-03 §2). Newer: delivered.
    let t = first_seen.created_at;
    for at in [t - 30, t + 1] {
        let ev = sign_beacon(&seeder, &manifest.a_tag(), &content(&manifest), at, 120)
            .await
            .unwrap();
        publisher.publish(&ev).await.unwrap();
    }
    let next = tokio::time::timeout(WAIT, watch.next())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next.created_at, t + 1);
    assert_eq!(watch.rejected, 0);
    assert_eq!(watch.live(unix_now()).len(), 1);
    assert!(
        watch.live(t + 1 + 120).is_empty(),
        "expired beacons leave the table"
    );

    // An empty watch list is refused (relays disagree on what `#a: []` means).
    assert!(
        reader
            .watch_beacons(manifest.addr.namespace(), &[])
            .await
            .is_err()
    );

    // Out-of-range TTLs are refused before signing.
    for ttl in [59, 121] {
        assert!(
            sign_beacon(&seeder, &manifest.a_tag(), &content(&manifest), t, ttl)
                .await
                .is_err()
        );
    }

    publisher.shutdown().await;
    reader.shutdown().await;
}
