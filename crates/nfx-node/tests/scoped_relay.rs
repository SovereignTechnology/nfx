//! The NFX-04 scoped relay: NIP-11, admission, the §2 limits, ephemeral beacons, and its
//! MAYs (mesh signaling, STUN service announcements), exercised through a real WebSocket
//! client.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::Request;
use hyper_util::rt::TokioIo;
use nfx_node::nostr::{ManifestQuery, Relays, sign_deletion, sign_manifest};
use nfx_node::relay::{MANIFESTS_PER_HOUR, ScopedRelay};
use nfx_node::unix_now;
use nfx_proto::Verified;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint};
use nfx_proto::event::Event;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::{Namespace, VideoAddr};
use nostr_sdk::prelude::{Client, EventBuilder, Filter, FinalizeEvent as _, Keys, Kind, Timestamp};
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(10);

fn vector() -> (Verified<Manifest>, Keys, Keys) {
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
            renditions: vec![],
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
    assert_eq!(doc["nfx"]["kinds"], serde_json::json!([38504, 20464, 5]));
    let nips = doc["supported_nips"].as_array().unwrap();
    assert!(nips.contains(&11.into()) && nips.contains(&40.into()));
    assert!(
        nips.contains(&50.into()),
        "search is advertised: it is answered"
    );

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
        ..manifest.clone().into_inner()
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

    // NFX-02 §6 deletions: admitted from the author and applied to the store; a foreign
    // "deletion" is refused.
    let foreign = EventBuilder::new(Kind::from(5u16), "")
        .tags([nostr_sdk::prelude::Tag::parse(["a", &manifest.a_tag()]).unwrap()])
        .finalize(&seeder)
        .unwrap();
    let foreign: Event = serde_json::from_str(&foreign.as_json()).unwrap();
    assert!(refusal(&client, &foreign).await.starts_with("invalid:"));
    // Deletions share the manifest budget (§2), which this creator has spent.
    let del = sign_deletion(&creator, &[manifest.a_tag()], unix_now())
        .await
        .unwrap();
    assert!(refusal(&client, &del).await.starts_with("rate-limited:"));
    // A creator with budget left: published, deleted, gone from the store.
    let other = Keys::generate();
    let (ev, theirs) = sign_manifest(&other, &manifest, unix_now() - 5)
        .await
        .unwrap();
    publisher.publish(&ev).await.unwrap();
    let del = sign_deletion(&other, &[theirs.a_tag()], unix_now())
        .await
        .unwrap();
    assert_eq!(publisher.publish(&del).await.unwrap(), 1);
    let stored_manifests = client
        .fetch_events(
            Filter::new()
                .kind(Kind::from(38504u16))
                .author(other.public_key()),
        )
        .timeout(WAIT)
        .await
        .unwrap();
    assert!(
        stored_manifests.is_empty(),
        "the relay applied the deletion"
    );
    // Replaying the deleted revision does not bring it back.
    assert!(
        refusal(&client, &ev)
            .await
            .starts_with("invalid: deleted by its author")
    );

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

#[tokio::test(flavor = "multi_thread")]
async fn an_allow_list_admits_only_listed_creators_and_their_beacons() {
    let (manifest, creator, seeder) = vector();
    let ns = manifest.addr.namespace().clone();
    // Malformed or empty lists are refused rather than admitting no one.
    assert!(ScopedRelay::with_creators(std::slice::from_ref(&ns), &[]).is_err());
    let upper = creator.public_key().to_hex().to_uppercase();
    assert!(ScopedRelay::with_creators(std::slice::from_ref(&ns), &[upper]).is_err());
    let relay = Arc::new(
        ScopedRelay::with_creators(std::slice::from_ref(&ns), &[creator.public_key().to_hex()])
            .unwrap(),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(relay.clone().serve(listener));
    let publisher = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();
    let client = Client::default();
    client.add_relay(url.as_str()).await.unwrap();
    client.connect().and_wait(WAIT).await;

    // The listed creator: manifest and a beacon for it are admitted.
    let (ev, listed) = sign_manifest(&creator, &manifest, unix_now())
        .await
        .unwrap();
    assert_eq!(publisher.publish(&ev).await.unwrap(), 1);
    let beacon =
        nfx_node::nostr::sign_beacon(&seeder, &listed.a_tag(), &content(&listed), unix_now(), 120)
            .await
            .unwrap();
    assert_eq!(publisher.publish(&beacon).await.unwrap(), 1);

    // Anyone else: their manifest, and beacons for their videos, are refused.
    let stranger = Keys::generate();
    let (ev, theirs) = sign_manifest(&stranger, &manifest, unix_now())
        .await
        .unwrap();
    assert!(
        refusal(&client, &ev)
            .await
            .starts_with("blocked: creator not allowed here")
    );
    let beacon =
        nfx_node::nostr::sign_beacon(&seeder, &theirs.a_tag(), &content(&theirs), unix_now(), 120)
            .await
            .unwrap();
    assert!(
        refusal(&client, &beacon)
            .await
            .starts_with("blocked: creator not allowed here")
    );
    // A deletion by an unlisted creator is refused too, even of its own manifest.
    let del = sign_deletion(&stranger, &[theirs.a_tag()], unix_now())
        .await
        .unwrap();
    assert!(
        refusal(&client, &del)
            .await
            .starts_with("blocked: creator not allowed here")
    );

    client.shutdown().await;
    publisher.shutdown().await;
    relay.shutdown();
    server.abort();
}

/// NIP-50: a `search` matches a manifest's title as well as its description, whatever the case. The
/// store alone matched the content (the description) only, so a video published without one was in
/// the relay and invisible to the desktop app's search.
#[tokio::test(flavor = "multi_thread")]
async fn a_search_matches_a_manifests_title_and_description() {
    let (manifest, creator, _) = vector();
    let ns = manifest.addr.namespace().clone();
    let relay = Arc::new(ScopedRelay::new(std::slice::from_ref(&ns)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(relay.clone().serve(listener));
    let publisher = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();

    let now = unix_now();
    // (video id, title, description, created_at): the newest hit of "salt flats" is the second.
    let videos = [
        ("salt-flats-dusk", "Salt Flats at Dusk", "", now - 30),
        (
            "lantern-walk",
            "Lantern Walk",
            "A slow walk past the salt flats.",
            now - 20,
        ),
        ("city-rain", "City Rain", "", now - 10),
    ];
    for (id, title, description, at) in videos {
        let m = Manifest {
            addr: VideoAddr::new(ns.clone(), id).unwrap(),
            title: title.into(),
            description: description.into(),
            ..manifest.clone().into_inner()
        };
        let (ev, _) = sign_manifest(&creator, &m, at).await.unwrap();
        assert_eq!(publisher.publish(&ev).await.unwrap(), 1, "{id}");
    }

    let client = Client::default();
    client.add_relay(url.as_str()).await.unwrap();
    client.connect().and_wait(WAIT).await;
    let titles = |filter: Filter| {
        let client = &client;
        async move {
            let mut got: Vec<String> = client
                .fetch_events(filter.kind(Kind::from(38504u16)))
                .timeout(WAIT)
                .await
                .unwrap()
                .into_iter()
                .filter_map(|e| {
                    e.tags
                        .iter()
                        .find(|t| t.kind() == "title")
                        .and_then(|t| t.content().map(str::to_owned))
                })
                .collect();
            got.sort();
            got
        }
    };

    // No search: all three, as before.
    assert_eq!(titles(Filter::new()).await.len(), 3);
    // A title word finds a video with no description; a description word finds the other; both here.
    assert_eq!(
        titles(Filter::new().search("salt flats")).await,
        ["Lantern Walk", "Salt Flats at Dusk"]
    );
    // Case never matters, in the query or the text.
    assert_eq!(
        titles(Filter::new().search("  SALT flats ")).await,
        ["Lantern Walk", "Salt Flats at Dusk"]
    );
    // A title alone, with no description to fall back on.
    assert_eq!(titles(Filter::new().search("rain")).await, ["City Rain"]);
    assert_eq!(
        titles(Filter::new().search("lantern")).await,
        ["Lantern Walk"]
    );
    // Nothing matches nothing; `limit` applies after the match, newest first.
    assert!(titles(Filter::new().search("harbour")).await.is_empty());
    assert_eq!(
        titles(Filter::new().search("salt flats").limit(1)).await,
        ["Lantern Walk"]
    );
    // An empty search is no search.
    assert_eq!(titles(Filter::new().search("   ")).await.len(), 3);

    server.abort();
}

/// Serve `relay` on a fresh loopback port: its `ws://` URL, address and task.
async fn start(
    relay: ScopedRelay,
) -> (
    Arc<ScopedRelay>,
    String,
    std::net::SocketAddr,
    tokio::task::JoinHandle<()>,
) {
    let relay = Arc::new(relay);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(relay.clone().serve(listener));
    (relay, format!("ws://{addr}"), addr, server)
}

/// The relay's NIP-11 document.
async fn nip11(addr: std::net::SocketAddr) -> Value {
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
    serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn client(url: &str) -> Client {
    let c = Client::default();
    c.add_relay(url).await.unwrap();
    c.connect().and_wait(WAIT).await;
    c
}

/// Send `event` and return whether the relay accepted it.
async fn accepted(client: &Client, event: &Event) -> bool {
    let event =
        nostr_sdk::prelude::Event::from_json(serde_json::to_string(event).unwrap()).unwrap();
    !client.send_event(&event).await.unwrap().success.is_empty()
}

/// NFX-04 §1 as amended 2026-11-18: without mesh signaling kind 25050 stays out of scope;
/// with it, an nfx-mesh/1 event that passes the reader's sessionless checks is forwarded
/// live and never stored, presence is held to one per 10 s per (sender, room, type), and
/// every other kind-25050 event is refused (another protocol as out of scope).
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_with_mesh_signaling_carries_nfx_mesh_only() {
    use n0_future::StreamExt as _;
    use nfx_proto::signal::{KIND_SIGNAL, Room, Session};
    use nostr_sdk::prelude as ns;

    let net = Namespace::parse("nfx:testnet:1").unwrap();
    let room = Room::derive("nfx/1/web/nfx:testnet:1:salt-flats-dusk/720p");
    let a = Session::new([1; 32], [2; 16]).unwrap();
    let b = Session::new([3; 32], [4; 16]).unwrap();

    // Off (the default): kind 25050 is out of scope and not advertised.
    let (off, url, addr, server) = start(ScopedRelay::new(std::slice::from_ref(&net))).await;
    assert_eq!(
        nip11(addr).await["nfx"]["kinds"],
        serde_json::json!([38504, 20464, 5])
    );
    let c = client(&url).await;
    let connect = a.connect(&room, unix_now()).unwrap();
    assert!(
        refusal(&c, &connect)
            .await
            .starts_with("blocked: out of scope")
    );
    c.shutdown().await;
    off.shutdown();
    server.abort();

    // On.
    let relay = ScopedRelay::with_options(std::slice::from_ref(&net), None, true).unwrap();
    let (relay, url, addr, server) = start(relay).await;
    let doc = nip11(addr).await;
    assert_eq!(
        doc["nfx"]["kinds"],
        serde_json::json!([38504, 20464, 5, 25050])
    );
    assert!(
        doc["nfx"]["roles"]
            .as_array()
            .unwrap()
            .contains(&"signaling".into())
    );

    let watcher = client(&url).await;
    let mut notes = watcher.notifications();
    watcher
        .subscribe(
            ns::Filter::new()
                .kind(ns::Kind::from(KIND_SIGNAL))
                .custom_tag(ns::SingleLetterTag::UPPERCASE_P, room.pubkey())
                .since(ns::Timestamp::from(unix_now() - 60)),
        )
        .await
        .unwrap();
    // The REQ above is ordered before this fetch on the same connection: once it returns,
    // the subscription is live.
    watcher
        .fetch_events(ns::Filter::new().kind(ns::Kind::from(38504u16)).limit(1))
        .timeout(WAIT)
        .await
        .unwrap();

    let sender = client(&url).await;
    assert!(accepted(&sender, &connect).await, "a valid connect");
    let forwarded = tokio::time::timeout(WAIT, async {
        loop {
            match notes.next().await {
                Some(ns::ClientNotification::Event { event, .. })
                    if event.id.to_hex() == connect.id =>
                {
                    return;
                }
                Some(_) => {}
                None => panic!("the notification stream ended"),
            }
        }
    })
    .await;
    assert!(forwarded.is_ok(), "the connect reaches the live subscriber");

    // §2: one presence of a type per (sender, room) per 10 s; another type is not held.
    let again = a.connect(&room, unix_now()).unwrap();
    assert!(refusal(&sender, &again).await.starts_with("rate-limited:"));
    assert!(accepted(&sender, &a.disconnect(&room, unix_now()).unwrap()).await);
    // Another room is another key.
    let other = Room::derive("nfx/1/web/nfx:testnet:1:salt-flats-dusk/360p");
    assert!(accepted(&sender, &a.connect(&other, unix_now()).unwrap()).await);

    // Offers and answers: admitted without decrypting; the relay is no session.
    let offer = a
        .offer(&room, b.pubkey(), "v=0\r\ns=-\r\n", &[9; 32], unix_now())
        .unwrap();
    assert!(accepted(&sender, &offer).await, "a valid offer");

    // Another protocol's 25050 is out of scope; an nfx-mesh/1 one without a room proof
    // is invalid.
    let keys = Keys::generate();
    let tag = |t: &[&str]| ns::Tag::parse(t.iter().copied()).unwrap();
    let foreign = EventBuilder::new(Kind::from(KIND_SIGNAL), "")
        .tags([
            tag(&["t", "connect"]),
            tag(&["P", room.pubkey()]),
            tag(&["i", "other/1"]),
        ])
        .finalize(&keys)
        .unwrap();
    let foreign: Event = serde_json::from_str(&foreign.as_json()).unwrap();
    assert!(
        refusal(&sender, &foreign)
            .await
            .starts_with("blocked: out of scope")
    );
    let now = unix_now();
    let unproven = EventBuilder::new(Kind::from(KIND_SIGNAL), "")
        .tags([
            tag(&["t", "connect"]),
            tag(&["P", room.pubkey()]),
            tag(&["d", &"ab".repeat(16)]),
            tag(&["i", "nfx-mesh/1"]),
            tag(&["y", "nfx"]),
            tag(&["expiration", &(now + 90).to_string()]),
        ])
        .finalize(&keys)
        .unwrap();
    let unproven: Event = serde_json::from_str(&unproven.as_json()).unwrap();
    assert!(refusal(&sender, &unproven).await.starts_with("invalid:"));

    // Ephemeral: a fresh REQ finds none of them stored.
    let stored = sender
        .fetch_events(
            ns::Filter::new()
                .kind(ns::Kind::from(KIND_SIGNAL))
                .since(ns::Timestamp::from(unix_now() - 600)),
        )
        .timeout(WAIT)
        .await
        .unwrap();
    assert!(stored.is_empty(), "signals are never persisted");

    watcher.shutdown().await;
    sender.shutdown().await;
    relay.shutdown();
    server.abort();
}

/// NFX-04 §1 as amended 2026-11-19: without STUN announcements kind 33478 stays out of scope;
/// with them, a valid announcement for one of the relay's networks is admitted, stored (the
/// newest per operator and server) and returned to a later REQ until it expires; one for
/// another network, or that fails a reader's checks, is refused; and a key is held to 12 an
/// hour.
#[tokio::test(flavor = "multi_thread")]
async fn a_relay_with_stun_announcements_admits_rate_limits_and_expires_them() {
    use nfx_node::nostr::sign_stun_announcement;
    use nfx_node::relay::{MayAdmit, STUN_ANNOUNCEMENTS_PER_HOUR};
    use nfx_proto::stun::{KIND_STUN_ANNOUNCEMENT, StunAnnouncement};
    use nostr_sdk::prelude as ns;

    let net = Namespace::parse("nfx:testnet:1").unwrap();
    let operator = Keys::generate();
    let nets = std::slice::from_ref(&net);
    let ad = sign_stun_announcement(&operator, "203.0.113.10:3478", nets, unix_now(), 3)
        .await
        .unwrap();

    // Off (the default): out of scope, and not advertised.
    let (off, url, addr, server) = start(ScopedRelay::new(nets)).await;
    assert_eq!(
        nip11(addr).await["nfx"]["kinds"],
        serde_json::json!([38504, 20464, 5])
    );
    let c = client(&url).await;
    assert!(refusal(&c, &ad).await.starts_with("blocked: out of scope"));
    c.shutdown().await;
    off.shutdown();
    server.abort();

    // On, beside mesh signaling.
    let may = MayAdmit {
        mesh_signaling: true,
        stun_announcements: true,
    };
    let (relay, url, addr, server) = start(ScopedRelay::admitting(nets, None, may).unwrap()).await;
    let doc = nip11(addr).await;
    assert_eq!(
        doc["nfx"]["kinds"],
        serde_json::json!([38504, 20464, 5, 25050, 33478])
    );
    assert_eq!(
        doc["nfx"]["roles"],
        serde_json::json!(["catalog", "availability", "signaling", "stun"])
    );
    let c = client(&url).await;
    assert!(accepted(&c, &ad).await, "a valid announcement");
    let stored = |c: Client| async move {
        let found = c
            .fetch_events(ns::Filter::new().kind(ns::Kind::from(KIND_STUN_ANNOUNCEMENT)))
            .timeout(WAIT)
            .await
            .unwrap();
        found.iter().map(|e| e.id.to_hex()).collect::<Vec<_>>()
    };
    assert_eq!(
        stored(c.clone()).await,
        [ad.id.clone()],
        "stored, as addressable"
    );

    // Another network only: out of scope. A private server: refused by a reader's checks.
    let mainnet = Namespace::parse("nfx:mainnet:1").unwrap();
    let foreign = sign_stun_announcement(
        &operator,
        "203.0.113.11:3478",
        std::slice::from_ref(&mainnet),
        unix_now(),
        600,
    )
    .await
    .unwrap();
    assert!(
        refusal(&c, &foreign)
            .await
            .starts_with("blocked: out of scope")
    );
    let now = unix_now();
    let private = EventBuilder::new(Kind::from(KIND_STUN_ANNOUNCEMENT), "")
        .tags([
            ns::Tag::parse(["d", "192.168.1.2:3478"]).unwrap(),
            ns::Tag::parse(["n", "nfx:testnet:1"]).unwrap(),
            ns::Tag::parse(["expiration", &(now + 600).to_string()]).unwrap(),
        ])
        .finalize(&operator)
        .unwrap();
    let private: Event = serde_json::from_str(&private.as_json()).unwrap();
    assert!(refusal(&c, &private).await.starts_with("invalid:"));
    let read = StunAnnouncement::from_event(&ad, unix_now()).unwrap();
    assert_eq!(read.addr, "203.0.113.10:3478");

    // 12 an hour per key: the first was one of them.
    for i in 1..STUN_ANNOUNCEMENTS_PER_HOUR {
        let more = sign_stun_announcement(
            &operator,
            &format!("198.51.100.{i}:3478"),
            nets,
            unix_now(),
            600,
        )
        .await
        .unwrap();
        assert!(accepted(&c, &more).await, "{i}");
    }
    let over = sign_stun_announcement(&operator, "198.51.100.99:3478", nets, unix_now(), 600)
        .await
        .unwrap();
    assert!(refusal(&c, &over).await.starts_with("rate-limited:"));

    // Expired (NIP-40): never returned again.
    tokio::time::sleep(Duration::from_secs(4)).await;
    let left = stored(c.clone()).await;
    assert_eq!(left.len(), STUN_ANNOUNCEMENTS_PER_HOUR - 1);
    assert!(!left.contains(&ad.id), "the expired one is gone");

    c.shutdown().await;
    relay.shutdown();
    server.abort();
}
