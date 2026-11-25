//! NFX-17 §3 end to end: a seeder answers a viewer's ask through a real scoped relay.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use n0_future::StreamExt as _;
use nfx_node::lookup::Answerer;
use nfx_node::nostr::sign_beacon;
use nfx_node::relay::{MayAdmit, ScopedRelay};
use nfx_node::unix_now;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint};
use nfx_proto::event::Event;
use nfx_proto::lookup::{self, KIND_LOOKUP, Parsed};
use nfx_proto::manifest::Manifest;
use nostr_sdk::prelude as ns;
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(15);

#[tokio::test(flavor = "multi_thread")]
async fn a_seeder_answers_an_ask_at_once_and_only_for_what_it_announces() {
    let v: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
    let event: Event = serde_json::from_value(v["event"].clone()).unwrap();
    let manifest = Manifest::from_event(&event).unwrap();
    let seeder = ns::Keys::parse(v["secret_keys_DO_NOT_USE"]["seeder"].as_str().unwrap()).unwrap();
    let a = manifest.a_tag();
    let net = manifest.addr.namespace().clone();

    let may = MayAdmit {
        seeder_lookup: true,
        ..MayAdmit::default()
    };
    let relay = Arc::new(ScopedRelay::admitting(std::slice::from_ref(&net), None, may).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(relay.clone().serve(listener));

    let content = BeaconContent {
        v: 1,
        video: manifest.addr.clone(),
        endpoints: vec![Endpoint::Https {
            url: "https://seed.example/nfx".into(),
            renditions: vec![],
        }],
        skipped: vec![],
        chunks: Chunks::All,
        price_hint: 0,
        accepts_mints: vec![],
        free: true,
    };
    let beacon = sign_beacon(&seeder, &a, &content, unix_now(), 60)
        .await
        .unwrap();
    let answerer = Answerer::start(
        std::slice::from_ref(&url),
        seeder.secret_key().to_secret_bytes(),
    )
    .await
    .unwrap();
    answerer.serve(&a, beacon.clone(), content);

    let viewer = ns::Client::default();
    viewer.add_relay(url.as_str()).await.unwrap();
    viewer.connect().and_wait(WAIT).await;
    let asker = [31u8; 32];
    let first = lookup::ask(&asker, &a, unix_now()).unwrap();
    let mut notes = viewer.notifications();
    viewer
        .subscribe(
            ns::Filter::new()
                .kind(ns::Kind::from(KIND_LOOKUP))
                .custom_tag(ns::SingleLetterTag::LOWERCASE_P, first.pubkey.as_str()),
        )
        .await
        .unwrap();

    // The seeder subscribes within its check interval. Ask until it has, as a viewer re-asks.
    let started = Instant::now();
    let told = tokio::time::timeout(WAIT, async {
        let mut at = unix_now();
        loop {
            let ask = lookup::ask(&asker, &a, at).unwrap();
            let sent = ns::Event::from_json(serde_json::to_string(&ask).unwrap()).unwrap();
            let _ = viewer.send_event(&sent).await;
            let heard = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    match notes.next().await {
                        Some(ns::ClientNotification::Event { event, .. }) => {
                            return Some(*event);
                        }
                        Some(_) => {}
                        None => return None,
                    }
                }
            })
            .await;
            if let Ok(Some(event)) = heard {
                return event;
            }
            at = unix_now().max(at + 1);
        }
    })
    .await
    .expect("an answer");
    assert!(started.elapsed() < WAIT);

    let told: Event = serde_json::from_str(&told.as_json()).unwrap();
    let Parsed::Tell(tell) = lookup::read(&told, unix_now()).unwrap() else {
        panic!("a tell")
    };
    assert_eq!(tell.asker, first.pubkey, "addressed to the ask's signer");
    assert_eq!(tell.seeder, seeder.public_key().to_hex());
    assert_eq!(tell.event, beacon, "the beacon it announced");

    // Once it stops announcing the video, it stops answering for it.
    answerer.forget(&a);
    let other = [32u8; 32];
    let ask = lookup::ask(&other, &a, unix_now()).unwrap();
    let mut quiet = viewer.notifications();
    viewer
        .subscribe(
            ns::Filter::new()
                .kind(ns::Kind::from(KIND_LOOKUP))
                .custom_tag(ns::SingleLetterTag::LOWERCASE_P, ask.pubkey.as_str()),
        )
        .await
        .unwrap();
    let sent = ns::Event::from_json(serde_json::to_string(&ask).unwrap()).unwrap();
    viewer.send_event(&sent).await.unwrap();
    let answered = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match quiet.next().await {
                Some(ns::ClientNotification::Event { event, .. })
                    if event
                        .tags
                        .iter()
                        .any(|t| t.kind() == "p" && t.content() == Some(ask.pubkey.as_str())) =>
                {
                    return;
                }
                Some(_) => {}
                None => return,
            }
        }
    })
    .await;
    assert!(answered.is_err(), "no answer for a video it dropped");

    answerer.shutdown().await;
    viewer.shutdown().await;
    relay.shutdown();
    server.abort();
}
