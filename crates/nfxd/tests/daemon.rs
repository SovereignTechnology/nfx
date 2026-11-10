//! `nfxd` end to end, in one process: a fetcher with an origin and an embedded scoped
//! relay, and a seeder that finds that relay. The fetcher learns the seeder from a
//! verified beacon, fetches over iroh, serves the video over HTTP, and becomes a seeder.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use std::net::{Ipv4Addr, SocketAddr};
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::RelayUrl;
use nfx_node::nostr::{ManifestQuery, Relays, sign_manifest};
use nfx_node::store::{ContentStore, FsStore};
use nfx_node::unix_now;
use nfx_proto::Verified;
use nfx_proto::event::Event;
use nfx_proto::hashlist::{HashList, Role};
use nfx_proto::manifest::{License, Manifest};
use nfxd::daemon::{Config, Daemon, VideoState};
use nfxd::key;
use nfxd::package::Package;
use nostr_sdk::prelude::Keys;
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(60);

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nfxd-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The test-vector video as an `nfx-package` output directory.
fn vector_package(dir: &Path) -> (Event, Verified<Manifest>, HashList) {
    let m: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
    let event: Event = serde_json::from_value(m["event"].clone()).unwrap();
    let manifest = Manifest::from_event(&event).unwrap();
    let hl: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/hashlist.json")).unwrap();
    let list: HashList = serde_json::from_value(hl["hashlist"].clone()).unwrap();
    let store = FsStore::open(dir.join("store")).unwrap();
    store.put(&list.render()).unwrap();
    for b64 in hl["fabricated"].as_object().unwrap().values() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_str().unwrap())
            .unwrap();
        store.put(&bytes).unwrap();
    }
    for text in hl["playlists"].as_object().unwrap().values() {
        store.put(text.as_str().unwrap().as_bytes()).unwrap();
    }
    let meta = serde_json::json!({
        "root": manifest.root_hex(),
        "video": manifest.addr.to_string(),
        "segs": manifest.segs,
    });
    std::fs::write(dir.join("nfx.json"), meta.to_string()).unwrap();
    (event, manifest, list)
}

async fn iroh_relay() -> (iroh_relay::server::Server, RelayUrl) {
    use iroh_relay::server::{RelayConfig, Server, ServerConfig};
    let mut config = ServerConfig::default();
    config.relay = Some(RelayConfig::new((Ipv4Addr::LOCALHOST, 0)));
    let server = Server::spawn(config).await.unwrap();
    let url = format!("http://{}", server.http_addr().unwrap())
        .parse()
        .unwrap();
    (server, url)
}

async fn get(addr: SocketAddr, path: &str) -> (StatusCode, Bytes) {
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(conn);
    let res = sender
        .send_request(
            Request::get(path)
                .header("host", "origin.test")
                .body(Empty::<Bytes>::new())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    (status, res.into_body().collect().await.unwrap().to_bytes())
}

async fn until_state(daemon: &Daemon, a: &str, want: &VideoState) {
    until_state_within(daemon, a, want, WAIT).await;
}

async fn until_state_within(daemon: &Daemon, a: &str, want: &VideoState, limit: Duration) {
    tokio::time::timeout(limit, async {
        loop {
            let state = daemon.state();
            match state.get(a) {
                Some(s) if s == want => return,
                Some(VideoState::Failed(e)) => panic!("{a} failed: {e}"),
                _ => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{a} never reached {want:?}: {:?}", daemon.state()));
}

#[test]
fn key_files_are_private_and_never_overwritten() {
    let dir = tmp("keys");
    let path = dir.join("seeder.key");
    let keys = key::create(&path).unwrap();
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    assert_eq!(key::load(&path).unwrap().public_key(), keys.public_key());
    assert!(key::create(&path).is_err(), "never overwrite a key");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    let err = key::load(&path).unwrap_err().to_string();
    assert!(err.contains("chmod 600"), "{err}");
    assert!(
        !err.contains(&keys.secret_key().to_secret_hex()),
        "the secret never appears in an error"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_https_url_is_refused_at_start_not_silently_every_minute() {
    let err = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("bad-url"),
        https_url: Some("http://origin.example/".into()),
        ..Config::default()
    })
    .await
    .err()
    .expect("refused");
    assert!(err.to_string().contains("--https-url"), "{err}");

    // Relay-only without a relay could never reach anyone: refused at start.
    let err = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("relay-only"),
        relay_only: true,
        ..Config::default()
    })
    .await
    .err()
    .expect("refused");
    assert!(err.to_string().contains("--relay-only"), "{err}");

    // CA roots for relays this node does not use would trust nothing in particular.
    let (certs, _) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let err = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("ca-no-relay"),
        iroh_relay_cas: certs,
        ..Config::default()
    })
    .await
    .err()
    .expect("refused");
    assert!(err.to_string().contains("--iroh-relay-ca"), "{err}");

    // An allow-list with no embedded relay would restrict nothing.
    let err = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("allow-no-relay"),
        allow_creators: vec!["ab".repeat(32)],
        ..Config::default()
    })
    .await
    .err()
    .expect("refused");
    assert!(err.to_string().contains("--allow-creator"), "{err}");

    // Gossip peers: a relay-only node does not gossip, and a peer reachable only through a
    // relay this network does not run would be dropped at every join.
    let peer = |relay: &str| {
        iroh::EndpointAddr::from_parts(
            iroh::SecretKey::from([7u8; 32]).public(),
            [iroh::TransportAddr::Relay(relay.parse().unwrap())],
        )
    };
    let ours: iroh::RelayUrl = "https://relay.ours.example/".parse().unwrap();
    for (name, relay_only, gossip, relay, why) in [
        (
            "gossip-relay-only",
            true,
            true,
            "https://relay.ours.example/",
            "relay-only",
        ),
        (
            "gossip-off",
            false,
            false,
            "https://relay.ours.example/",
            "needs --gossip",
        ),
        (
            "gossip-foreign",
            false,
            true,
            "https://relay.attacker.example/",
            "no direct address",
        ),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp(name),
            relay_only,
            gossip,
            iroh_relays: vec![ours.clone()],
            gossip_peers: vec![peer(relay)],
            ..Config::default()
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains(why), "{name}: {err}");
    }

    let ok = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("good-url"),
        https_url: Some("https://origin.example/nfx".into()),
        ..Config::default()
    })
    .await
    .expect("a valid https URL starts");
    ok.shutdown().await;
}

#[tokio::test]
async fn a_package_becomes_a_verified_open_manifest() {
    let dir = tmp("package");
    let (_, vector, list) = vector_package(&dir);
    let package = Package::open(&dir).unwrap();
    assert_eq!(package.list, list);
    let m = package
        .manifest(
            "Salt Flats",
            "",
            Some("alt text"),
            &["travel".into()],
            1_790_000_000,
        )
        .unwrap();
    let keys = Keys::generate();
    let (event, parsed) = sign_manifest(&keys, &m, unix_now()).await.unwrap();
    assert_eq!(Manifest::from_event(&event).unwrap(), parsed);
    assert_eq!(parsed.root, vector.root);
    assert_eq!(parsed.license, License::Open);
    assert_eq!(parsed.price_hint, Some(0));
    assert_eq!(
        parsed.duration, vector.duration,
        "summed from the playlist's segments"
    );
    let thumb = list.files.iter().find(|f| f.role == Role::Thumb).unwrap();
    assert_eq!(parsed.thumb.as_ref().unwrap().sha256, thumb.sha256);

    // A store that does not match nfx.json is refused.
    std::fs::write(
        dir.join("nfx.json"),
        serde_json::json!({"root": "0".repeat(64), "video": vector.addr.to_string(), "segs": 7})
            .to_string(),
    )
    .unwrap();
    assert!(Package::open(&dir).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn fetch_serve_and_reseed_through_an_embedded_relay() {
    let (_iroh, iroh_url) = iroh_relay().await;
    let seed_dir = tmp("seed");
    let (event, manifest, list) = vector_package(&seed_dir);
    let a = manifest.a_tag();

    // B: fetcher + origin + embedded relay. Nothing is seeding yet.
    let b_keys = Keys::generate();
    let b_store_dir = tmp("b-store");
    let b = Daemon::start(Config {
        keys: Some(b_keys.clone()),
        store: b_store_dir.clone(),
        iroh_relays: vec![iroh_url.clone()],
        fetch: vec![a.clone()],
        origin: Some("127.0.0.1:0".parse().unwrap()),
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        embed_tracker: Some("127.0.0.1:0".parse().unwrap()),
        deletion_check_every: Some(Duration::from_millis(500)),
        ..Config::default()
    })
    .await
    .unwrap();
    let relay_url = b.relay_url.clone().unwrap();

    // The creator publishes the manifest to B's relay; a watcher counts seeders.
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(client.publish(&event).await.unwrap(), 1);
    let mut watch = client
        .watch_beacons(manifest.addr.namespace(), std::slice::from_ref(&a))
        .await
        .unwrap();
    let query = ManifestQuery {
        namespace: manifest.addr.namespace().clone(),
        authors: vec![manifest.author.clone()],
        videos: vec![manifest.addr.clone()],
    };
    assert_eq!(
        client.manifests(&query, WAIT).await.unwrap(),
        vec![manifest.clone()]
    );
    until_state(&b, &a, &VideoState::Fetching).await;

    // A: a seeder that speaks only to B's relay.
    let a_keys = Keys::generate();
    let seeder = Daemon::start(Config {
        keys: Some(a_keys.clone()),
        store: seed_dir.join("store"),
        relays: vec![relay_url.clone()],
        iroh_relays: vec![iroh_url.clone()],
        seed: vec![a.clone()],
        deletion_check_every: Some(Duration::from_millis(500)),
        ..Config::default()
    })
    .await
    .unwrap();
    until_state(&seeder, &a, &VideoState::Seeding).await;

    // B fetches from A over iroh, verified, and starts seeding it too. Its tracker opens
    // the video's browser-mesh swarms, one per rendition (NFX-10 §2), and nothing else.
    let tracker = b.tracker().expect("embedded tracker");
    let swarm = manifest.addr.web_tracker_infohash("720p");
    until_state(&b, &a, &VideoState::Seeding).await;
    assert!(
        b.tracker_url
            .as_deref()
            .unwrap()
            .starts_with("ws://127.0.0.1:")
    );
    assert!(tracker.admits(&swarm));
    assert!(!tracker.admits(&manifest.addr.web_tracker_infohash("1080p")));
    let b_store = FsStore::open(&b_store_dir).unwrap();
    for f in &list.files {
        assert!(b_store.has(&f.sha256), "{} fetched", f.name);
    }

    // B's origin serves the video.
    let origin = b.origin_addr.unwrap();
    let root = manifest.root_hex();
    let (status, body) = get(origin, &format!("/{root}/master.m3u8")).await;
    assert_eq!(status, StatusCode::OK);
    let master = list
        .files
        .iter()
        .find(|f| f.role == Role::PlaylistMaster)
        .unwrap();
    assert_eq!(
        body.as_ref(),
        b_store.get(&master.sha256).unwrap().as_slice()
    );
    let seg = list.files.iter().find(|f| f.role == Role::Segment).unwrap();
    let (status, body) = get(origin, &format!("/{root}/{}.m4s", seg.sha256)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), b_store.get(&seg.sha256).unwrap().as_slice());

    // Both seeders' beacons reach the relay.
    let want: BTreeSet<String> =
        [a_keys.public_key().to_hex(), b_keys.public_key().to_hex()].into();
    let mut seen = BTreeSet::new();
    tokio::time::timeout(WAIT, async {
        while seen != want {
            let beacon = watch.next().await.unwrap();
            assert!(beacon.serves(&manifest));
            seen.insert(beacon.seeder.clone());
        }
    })
    .await
    .unwrap_or_else(|_| panic!("seeders seen: {seen:?}"));
    assert_eq!(watch.rejected, 0);

    // The creator withdraws the video (NFX-02 §6): both seeders stop announcing it.
    let m: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
    let creator = Keys::parse(m["secret_keys_DO_NOT_USE"]["creator"].as_str().unwrap()).unwrap();
    let del = nfx_node::nostr::sign_deletion(&creator, std::slice::from_ref(&a), unix_now())
        .await
        .unwrap();
    assert_eq!(client.publish(&del).await.unwrap(), 1);
    until_state(&seeder, &a, &VideoState::Deleted).await;
    until_state(&b, &a, &VideoState::Deleted).await;
    assert!(!tracker.admits(&swarm), "a deleted video's swarms close");
    assert!(client.manifests(&query, WAIT).await.unwrap().is_empty());

    client.shutdown().await;
    seeder.shutdown().await;
    b.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_watches_plays_through_its_origin_and_then_seeds() {
    let (_iroh, iroh_url) = iroh_relay().await;
    let seed_dir = tmp("watch-seed");
    let (event, manifest, list) = vector_package(&seed_dir);
    let a = manifest.a_tag();

    // A seeder with an embedded relay; the manifest is published once the viewer watches,
    // so the viewer sees the seeder's first beacon (beacons are ephemeral, NFX-03 §5).
    let seeder = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: seed_dir.join("store"),
        iroh_relays: vec![iroh_url.clone()],
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        ..Config::default()
    })
    .await
    .unwrap();
    let relay_url = seeder.relay_url.clone().unwrap();
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();

    // The viewer: no TCP listener, an internal origin (the desktop app's nfx:// scheme).
    let viewer = std::sync::Arc::new(
        Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp("watch-viewer"),
            relays: vec![relay_url.clone()],
            iroh_relays: vec![iroh_url.clone()],
            internal_origin: true,
            seed_watched: true,
            ..Config::default()
        })
        .await
        .unwrap(),
    );
    assert!(viewer.origin_addr.is_none(), "no listener");
    let watching = {
        let (viewer, a) = (viewer.clone(), a.clone());
        tokio::spawn(async move { viewer.watch(&a, WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    client.publish(&event).await.unwrap();
    let watched = watching.await.unwrap().unwrap();
    assert_eq!(watched.root, manifest.root);
    assert_eq!(
        viewer.watch(&a, WAIT).await.unwrap().root,
        manifest.root,
        "idempotent"
    );

    // Playback reads through the origin; a segment not yet held is pulled on demand.
    let origin = viewer.origin().unwrap();
    let root = manifest.root_hex();
    let master = origin
        .respond(&hyper::Method::GET, &format!("/{root}/master.m3u8"))
        .await;
    assert_eq!(master.status(), StatusCode::OK);
    let seg = list.files.iter().find(|f| f.role == Role::Segment).unwrap();
    let res = origin
        .respond(&hyper::Method::GET, &format!("/{root}/{}.m4s", seg.sha256))
        .await;
    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        body.as_ref(),
        FsStore::open(seed_dir.join("store"))
            .unwrap()
            .get(&seg.sha256)
            .unwrap()
            .as_slice()
    );

    // Then the viewer fetches the whole video and gives it back.
    until_state(&viewer, &a, &VideoState::Seeding).await;

    client.shutdown().await;
    std::sync::Arc::try_unwrap(viewer)
        .ok()
        .expect("sole owner")
        .shutdown()
        .await;
    seeder.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_learns_a_seeder_it_can_only_hear_through_gossip() {
    let (_iroh, iroh_url) = iroh_relay().await;
    let dir_a = tmp("gossip-a");
    let (event, manifest, _) = vector_package(&dir_a);
    let dir_b = tmp("gossip-b");
    vector_package(&dir_b);
    let a = manifest.a_tag();
    let start = |store: PathBuf, relays: Vec<String>, peers: Vec<iroh::EndpointAddr>| {
        let (iroh_url, a) = (iroh_url.clone(), a.clone());
        async move {
            Daemon::start(Config {
                keys: Some(Keys::generate()),
                store,
                relays,
                iroh_relays: vec![iroh_url],
                seed: vec![a],
                embed_relay: Some("127.0.0.1:0".parse().unwrap()),
                gossip: true,
                gossip_peers: peers,
                ..Config::default()
            })
            .await
            .unwrap()
        }
    };

    // Seeder A, whose relay the viewer uses; the viewer watches before the manifest is
    // published so it catches A's first beacon.
    let seeder_a = start(dir_a.join("store"), vec![], vec![]).await;
    let relay_a = seeder_a.relay_url.clone().unwrap();
    let viewer = std::sync::Arc::new(
        Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp("gossip-viewer"),
            relays: vec![relay_a.clone()],
            iroh_relays: vec![iroh_url.clone()],
            internal_origin: true,
            gossip: true,
            ..Config::default()
        })
        .await
        .unwrap(),
    );
    let watching = {
        let (viewer, a) = (viewer.clone(), a.clone());
        tokio::spawn(async move { viewer.watch(&a, WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let client_a = Relays::connect(std::slice::from_ref(&relay_a), Duration::from_secs(10))
        .await
        .unwrap();
    client_a.publish(&event).await.unwrap();
    watching.await.unwrap().unwrap();
    let a_seeder = seeder_a.state(); // A is seeding; the viewer knows it from its beacon
    assert_eq!(a_seeder[&a], VideoState::Seeding);
    tokio::time::sleep(Duration::from_secs(3)).await; // the viewer's learner joins via A

    // Seeder B speaks only to its own relay, which the viewer never sees, and joins the
    // video's swarm through A. The viewer can learn B only through gossip.
    let seeder_b = start(dir_b.join("store"), vec![], vec![seeder_a.node().addr()]).await;
    let relay_b = seeder_b.relay_url.clone().unwrap();
    let client_b = Relays::connect(std::slice::from_ref(&relay_b), Duration::from_secs(10))
        .await
        .unwrap();
    client_b.publish(&event).await.unwrap();
    until_state(&seeder_b, &a, &VideoState::Seeding).await;

    let seeders_known = tokio::time::timeout(WAIT, async {
        loop {
            let known = viewer.sources(&a);
            if known.len() >= 2 {
                break known;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the viewer never heard B: {:?}", viewer.sources(&a)));
    assert_eq!(seeders_known.len(), 2, "A from its beacon, B from gossip");

    client_a.shutdown().await;
    client_b.shutdown().await;
    std::sync::Arc::try_unwrap(viewer)
        .ok()
        .expect("sole owner")
        .shutdown()
        .await;
    seeder_b.shutdown().await;
    seeder_a.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_watch_that_timed_out_does_not_stop_a_later_one_from_seeding() {
    let (_iroh, iroh_url) = iroh_relay().await;
    let seed_dir = tmp("rewatch-seed");
    let (event, manifest, _) = vector_package(&seed_dir);
    let a = manifest.a_tag();
    let seeder = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: seed_dir.join("store"),
        iroh_relays: vec![iroh_url.clone()],
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        deletion_check_every: Some(Duration::from_millis(500)),
        ..Config::default()
    })
    .await
    .unwrap();
    let relay_url = seeder.relay_url.clone().unwrap();
    let viewer = std::sync::Arc::new(
        Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp("rewatch-viewer"),
            relays: vec![relay_url.clone()],
            iroh_relays: vec![iroh_url.clone()],
            internal_origin: true,
            seed_watched: true,
            ..Config::default()
        })
        .await
        .unwrap(),
    );
    // Nothing is published yet: the first watch times out.
    assert!(viewer.watch(&a, Duration::from_secs(1)).await.is_err());

    // Published now; a second watch plays, and the viewer goes on to fetch and seed.
    let watching = {
        let (viewer, a) = (viewer.clone(), a.clone());
        tokio::spawn(async move { viewer.watch(&a, WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    client.publish(&event).await.unwrap();
    assert_eq!(watching.await.unwrap().unwrap().root, manifest.root);
    until_state(&viewer, &a, &VideoState::Seeding).await;

    client.shutdown().await;
    viewer.shutdown().await;
    seeder.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_frees_the_store_while_a_watch_is_still_pending() {
    let (_iroh, iroh_url) = iroh_relay().await;
    let dir = tmp("restart");
    let (_, manifest, _) = vector_package(&dir);
    let relay = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("restart-relay"),
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        namespaces: vec![manifest.addr.namespace().clone()],
        ..Config::default()
    })
    .await
    .unwrap();
    let cfg = || Config {
        keys: Some(Keys::generate()),
        store: dir.join("store"),
        relays: vec![relay.relay_url.clone().unwrap()],
        iroh_relays: vec![iroh_url.clone()],
        internal_origin: true,
        ..Config::default()
    };
    let old = std::sync::Arc::new(Daemon::start(cfg()).await.unwrap());
    // A watch for a video nobody published holds the daemon (the desktop app's case).
    let pending = {
        let (old, a) = (old.clone(), manifest.a_tag());
        tokio::spawn(async move { old.watch(&a, Duration::from_secs(300)).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    old.shutdown().await;
    // The same store and blobs database open at once.
    let new = Daemon::start(cfg())
        .await
        .expect("the old daemon released its store");
    pending.abort();
    new.shutdown().await;
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_that_does_not_share_plays_but_never_announces() {
    let (_iroh, iroh_url) = iroh_relay().await;
    let seed_dir = tmp("private-seed");
    let (event, manifest, _) = vector_package(&seed_dir);
    let a = manifest.a_tag();
    let seeder_keys = Keys::generate();
    let seeder = Daemon::start(Config {
        keys: Some(seeder_keys.clone()),
        store: seed_dir.join("store"),
        iroh_relays: vec![iroh_url.clone()],
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        ..Config::default()
    })
    .await
    .unwrap();
    let relay_url = seeder.relay_url.clone().unwrap();
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    let mut beacons = client
        .watch_beacons(manifest.addr.namespace(), std::slice::from_ref(&a))
        .await
        .unwrap();
    // The default: a key, but no sharing, and no portmapper.
    let viewer_keys = Keys::generate();
    let viewer = std::sync::Arc::new(
        Daemon::start(Config {
            keys: Some(viewer_keys.clone()),
            store: tmp("private-viewer"),
            relays: vec![relay_url.clone()],
            iroh_relays: vec![iroh_url.clone()],
            internal_origin: true,
            no_portmapper: true,
            ..Config::default()
        })
        .await
        .unwrap(),
    );
    let watching = {
        let (viewer, a) = (viewer.clone(), a.clone());
        tokio::spawn(async move { viewer.watch(&a, WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    client.publish(&event).await.unwrap();
    assert_eq!(watching.await.unwrap().unwrap().root, manifest.root);
    until_state(&viewer, &a, &VideoState::Serving).await;

    // Only the seeder ever announces it.
    let seen = tokio::time::timeout(Duration::from_secs(4), async {
        let mut seen = BTreeSet::new();
        while let Some(b) = beacons.next().await {
            seen.insert(b.seeder.clone());
        }
        seen
    })
    .await
    .unwrap_or_default();
    assert!(
        !seen.contains(&viewer_keys.public_key().to_hex()),
        "the viewer announced"
    );
    assert_eq!(
        viewer.state()[&a],
        VideoState::Serving,
        "served, never seeding"
    );

    client.shutdown().await;
    viewer.shutdown().await;
    seeder.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn rating_settings_that_cannot_work_are_refused_at_start() {
    // NFX-16: ratings are read only with the user's key and general relays, and every
    // key is 64 lowercase hex by the time it reaches the daemon.
    let root = "ab".repeat(32);
    let relay = || vec!["wss://relay.example".to_string()];
    for (name, rating_root, rating_trusted, general_relays, why) in [
        (
            "rating-no-relay",
            Some(root.clone()),
            vec![],
            vec![],
            "--rating-root needs --general-relay",
        ),
        (
            "relay-no-root",
            None,
            vec![],
            relay(),
            "--general-relay needs --rating-root",
        ),
        (
            "trusted-no-root",
            None,
            vec![root.clone()],
            vec![],
            "--rating-trusted needs --rating-root",
        ),
        (
            "root-uppercase",
            Some("AB".repeat(32)),
            vec![],
            relay(),
            "not 64 lowercase hex",
        ),
        (
            "trusted-short",
            Some(root.clone()),
            vec!["ab".to_string()],
            relay(),
            "not 64 lowercase hex",
        ),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp(name),
            rating_root,
            rating_trusted,
            general_relays,
            ..Config::default()
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains(why), "{name}: {err}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn iroh_bind_and_external_addresses_that_cannot_work_are_refused_at_start() {
    let sa = |s: &str| -> SocketAddr { s.parse().unwrap() };
    let relay: RelayUrl = "https://relay.ours.example/".parse().unwrap();
    for (name, relay_only, bind, external, why) in [
        (
            "bind-relay-only",
            true,
            Some(sa("0.0.0.0:7843")),
            vec![],
            "relay-only node has no direct address",
        ),
        (
            "bind-port-0",
            false,
            Some(sa("0.0.0.0:0")),
            vec![],
            "--iroh-bind 0.0.0.0:0: port 0 is not a fixed port",
        ),
        (
            "external-no-bind",
            false,
            None,
            vec![sa("203.0.113.7:7843")],
            "--iroh-external needs --iroh-bind",
        ),
        (
            "external-five",
            false,
            Some(sa("0.0.0.0:7843")),
            vec![sa("203.0.113.7:7843"); 5],
            "at most 4",
        ),
        (
            "external-unspecified",
            false,
            Some(sa("0.0.0.0:7843")),
            vec![sa("0.0.0.0:7843")],
            "--iroh-external 0.0.0.0:7843: not an address a peer can dial",
        ),
        (
            "external-port-0",
            false,
            Some(sa("0.0.0.0:7843")),
            vec![sa("203.0.113.7:0")],
            "not an address a peer can dial",
        ),
        (
            "external-multicast",
            false,
            Some(sa("0.0.0.0:7843")),
            vec![sa("224.0.0.1:7843")],
            "not an address a peer can dial",
        ),
        (
            "external-broadcast",
            false,
            Some(sa("0.0.0.0:7843")),
            vec![sa("255.255.255.255:7843")],
            "not an address a peer can dial",
        ),
        (
            "external-v6-unspecified",
            false,
            Some(sa("[::]:7843")),
            vec![sa("[::]:7843")],
            "not an address a peer can dial",
        ),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp(name),
            relay_only,
            iroh_relays: vec![relay.clone()],
            iroh_bind: bind,
            iroh_external: external,
            ..Config::default()
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains(why), "{name}: {err}");
    }

    // A fixed port that is taken is an error, never a quiet fallback to a random one.
    let taken = std::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let err = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("bind-taken"),
        iroh_bind: Some(taken.local_addr().unwrap()),
        ..Config::default()
    })
    .await
    .err()
    .expect("refused");
    drop(taken);
    assert!(!err.to_string().is_empty());

    // Bound and advertised: the external address, and no loopback or private address.
    let port = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let external = sa(&format!("203.0.113.7:{port}"));
    let ok = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("bind-ok"),
        iroh_bind: Some(sa(&format!("0.0.0.0:{port}"))),
        iroh_external: vec![external],
        ..Config::default()
    })
    .await
    .expect("starts");
    let advertised: Vec<SocketAddr> = ok.node().addr().ip_addrs().copied().collect();
    assert!(advertised.contains(&external), "{advertised:?}");
    assert!(
        advertised
            .iter()
            .all(|a| *a == external || nfx_node::node::is_public(a)),
        "{advertised:?}"
    );
    ok.shutdown().await;
}

/// Wait until `a`'s state matches `want`, failing after `limit`.
async fn until_matches(
    daemon: &Daemon,
    a: &str,
    limit: Duration,
    want: impl Fn(&VideoState) -> bool,
) {
    tokio::time::timeout(limit, async {
        loop {
            match daemon.state().get(a) {
                Some(s) if want(s) => return,
                Some(VideoState::Failed(e)) => panic!("{a} failed: {e}"),
                _ => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{a}: {:?}", daemon.state()));
}

/// An iroh relay URL on loopback with nothing behind it (yet), and its port.
fn relay_not_up() -> (u16, RelayUrl) {
    let port = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    (port, format!("http://127.0.0.1:{port}").parse().unwrap())
}

/// The iroh endpoint of the next beacon `watch` hears.
async fn next_iroh_endpoint(watch: &mut nfx_node::nostr::BeaconWatch) -> (String, Vec<String>) {
    let beacon = tokio::time::timeout(WAIT, watch.next())
        .await
        .expect("a beacon")
        .expect("a beacon");
    beacon
        .content
        .endpoints
        .iter()
        .find_map(|e| match e {
            nfx_proto::beacon::Endpoint::Iroh { relay, addrs, .. } => {
                Some((relay.clone(), addrs.clone()))
            }
            _ => None,
        })
        .expect("an iroh endpoint")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seeder_with_an_external_address_seeds_at_once_whatever_its_iroh_relay_does() {
    let (_, dead) = relay_not_up();
    let seed_dir = tmp("external-no-wait");
    let (event, manifest, _) = vector_package(&seed_dir);
    let a = manifest.a_tag();
    let port = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let external: SocketAddr = format!("203.0.113.7:{port}").parse().unwrap();
    let started = std::time::Instant::now();
    let seeder = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: seed_dir.join("store"),
        iroh_relays: vec![dead],
        iroh_bind: Some(format!("0.0.0.0:{port}").parse().unwrap()),
        iroh_external: vec![external],
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        ..Config::default()
    })
    .await
    .unwrap();
    // No wait for the relay at start (a node without an external address waits 10 s there).
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "start took {:?}",
        started.elapsed()
    );
    let relay_url = seeder.relay_url.clone().unwrap();
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    let mut beacons = client
        .watch_beacons(manifest.addr.namespace(), std::slice::from_ref(&a))
        .await
        .unwrap();
    client.publish(&event).await.unwrap();
    // Nor before seeding: it seeds and announces its external address, with no relay.
    until_state_within(&seeder, &a, &VideoState::Seeding, Duration::from_secs(20)).await;
    let (relay, addrs) = next_iroh_endpoint(&mut beacons).await;
    assert!(relay.is_empty(), "{relay}");
    assert!(addrs.contains(&external.to_string()), "{addrs:?}");
    client.shutdown().await;
    seeder.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seeder_whose_iroh_relay_never_comes_up_seeds_without_it_after_the_wait() {
    let (_, dead) = relay_not_up();
    let seed_dir = tmp("relay-never");
    let (event, manifest, _) = vector_package(&seed_dir);
    let a = manifest.a_tag();
    let seeder = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: seed_dir.join("store"),
        iroh_relays: vec![dead],
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        ..Config::default()
    })
    .await
    .unwrap();
    let started = std::time::Instant::now();
    let relay_url = seeder.relay_url.clone().unwrap();
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    let mut beacons = client
        .watch_beacons(manifest.addr.namespace(), std::slice::from_ref(&a))
        .await
        .unwrap();
    client.publish(&event).await.unwrap();
    until_matches(
        &seeder,
        &a,
        WAIT,
        |s| matches!(s, VideoState::AwaitingRelay(why) if why.contains("127.0.0.1")),
    )
    .await;
    // The wait is bounded: it seeds without the relay, announcing its direct addresses.
    until_state_within(
        &seeder,
        &a,
        &VideoState::Seeding,
        nfxd::daemon::RELAY_WAIT + Duration::from_secs(30),
    )
    .await;
    assert!(
        started.elapsed() + Duration::from_secs(5)
            >= nfxd::daemon::RELAY_WAIT - Duration::from_secs(10),
        "it waited for the relay first: {:?}",
        started.elapsed()
    );
    let (relay, addrs) = next_iroh_endpoint(&mut beacons).await;
    assert!(relay.is_empty(), "{relay}");
    assert!(!addrs.is_empty(), "direct addresses still announced");
    client.shutdown().await;
    seeder.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seeder_waits_for_an_iroh_relay_that_comes_up_late_and_then_seeds_through_it() {
    // The relay's port: free now, taken only later.
    let (port, late) = relay_not_up();
    let seed_dir = tmp("late-relay");
    let (event, manifest, list) = vector_package(&seed_dir);
    let a = manifest.a_tag();
    let seeder_keys = Keys::generate();
    // Start waits a first 10 s for the relay, then goes on without it.
    let seeder = Daemon::start(Config {
        keys: Some(seeder_keys.clone()),
        store: seed_dir.join("store"),
        iroh_relays: vec![late.clone()],
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        ..Config::default()
    })
    .await
    .unwrap();
    let relay_url = seeder.relay_url.clone().unwrap();
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    let mut beacons = client
        .watch_beacons(manifest.addr.namespace(), std::slice::from_ref(&a))
        .await
        .unwrap();
    client.publish(&event).await.unwrap();

    // The manifest is found, the relay is not: the seeder waits (at most RELAY_WAIT) and says
    // why, and announces nothing meanwhile.
    until_matches(
        &seeder,
        &a,
        WAIT,
        |s| matches!(s, VideoState::AwaitingRelay(why) if why.contains("not reached")),
    )
    .await;
    let early = tokio::time::timeout(Duration::from_secs(3), beacons.next()).await;
    assert!(early.is_err(), "announced before the relay");

    // The relay comes up: the seeder seeds and announces.
    let _relay = {
        use iroh_relay::server::{RelayConfig, Server, ServerConfig};
        let mut config = ServerConfig::default();
        config.relay = Some(RelayConfig::new((Ipv4Addr::LOCALHOST, port)));
        Server::spawn(config).await.unwrap()
    };
    until_state_within(&seeder, &a, &VideoState::Seeding, Duration::from_secs(120)).await;

    // Its tickets carry the relay: a relay-only fetcher, which dials nothing else, fetches
    // the video through them.
    let fetcher_dir = tmp("late-relay-fetcher");
    let fetcher = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: fetcher_dir.clone(),
        relays: vec![relay_url.clone()],
        iroh_relays: vec![late.clone()],
        relay_only: true,
        fetch: vec![a.clone()],
        ..Config::default()
    })
    .await
    .unwrap();
    until_state_within(&fetcher, &a, &VideoState::Seeding, Duration::from_secs(120)).await;
    let store = FsStore::open(&fetcher_dir).unwrap();
    for f in &list.files {
        assert!(store.has(&f.sha256), "{} fetched", f.name);
    }

    client.shutdown().await;
    fetcher.shutdown().await;
    seeder.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn bridge_public_addresses_and_caps_that_cannot_work_are_refused_at_start() {
    let sa = |s: &str| -> SocketAddr { s.parse().unwrap() };
    let tracker = Some(sa("127.0.0.1:0"));
    for (name, bridge, public, max_peers, why) in [
        (
            "public-no-bridge",
            None,
            Some(sa("203.0.113.7:7844")),
            None,
            "--bridge-public needs --bridge",
        ),
        (
            "public-unspecified",
            Some(sa("127.0.0.1:0")),
            Some(sa("0.0.0.0:7844")),
            None,
            "--bridge-public 0.0.0.0:7844: not an address a browser can dial",
        ),
        (
            "public-port-0",
            Some(sa("127.0.0.1:0")),
            Some(sa("203.0.113.7:0")),
            None,
            "not an address a browser can dial",
        ),
        (
            "public-multicast",
            Some(sa("127.0.0.1:0")),
            Some(sa("239.1.2.3:7844")),
            None,
            "not an address a browser can dial",
        ),
        (
            "cap-no-bridge",
            None,
            None,
            Some(16),
            "--bridge-max-peers needs --bridge",
        ),
        (
            "cap-zero",
            Some(sa("127.0.0.1:0")),
            None,
            Some(0),
            "--bridge-max-peers 0: not 1 to 1024",
        ),
        (
            "cap-huge",
            Some(sa("127.0.0.1:0")),
            None,
            Some(1025),
            "--bridge-max-peers 1025: not 1 to 1024",
        ),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp(name),
            embed_tracker: tracker,
            bridge,
            bridge_public: public,
            bridge_max_peers: max_peers,
            ..Config::default()
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains(why), "{name}: {err}");
    }

    // Bound on loopback, told to browsers as the public address in front of it.
    let public = sa("203.0.113.7:7844");
    let ok = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("bridge-public-ok"),
        embed_tracker: tracker,
        bridge: Some(sa("127.0.0.1:0")),
        bridge_public: Some(public),
        bridge_max_peers: Some(16),
        ..Config::default()
    })
    .await
    .expect("starts");
    assert_eq!(ok.bridge_public, Some(public));
    let bound = ok.bridge_addr.unwrap();
    assert!(bound.ip().is_loopback() && bound.port() != 0, "{bound}");
    ok.shutdown().await;

    // Without --bridge-public, browsers are told the bound address, as before.
    let plain = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("bridge-plain"),
        embed_tracker: tracker,
        bridge: Some(sa("127.0.0.1:0")),
        ..Config::default()
    })
    .await
    .expect("starts");
    assert_eq!(plain.bridge_public, plain.bridge_addr);
    plain.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stun_settings_that_cannot_work_are_refused_at_start() {
    let sa = |s: &str| -> SocketAddr { s.parse().unwrap() };
    for (name, stun, public, why) in [
        (
            "stun-public-alone",
            None,
            Some(sa("203.0.113.7:3478")),
            "--stun-public needs --stun",
        ),
        (
            "stun-public-unspecified",
            Some(sa("127.0.0.1:0")),
            Some(sa("0.0.0.0:3478")),
            "--stun-public 0.0.0.0:3478: not an address a browser can reach",
        ),
        (
            "stun-public-port-0",
            Some(sa("127.0.0.1:0")),
            Some(sa("203.0.113.7:0")),
            "not an address a browser can reach",
        ),
        // Readers refuse a zone or an IPv4 address written as IPv6 (NFX-10 §1); announcing
        // one would make them refuse every beacon of this node.
        (
            "stun-public-zone",
            Some(sa("127.0.0.1:0")),
            Some(SocketAddr::V6(std::net::SocketAddrV6::new(
                "fe80::1".parse().unwrap(),
                3478,
                0,
                2,
            ))),
            "not an address a browser can reach",
        ),
        (
            "stun-public-mapped",
            Some(sa("127.0.0.1:0")),
            Some(sa("[::ffff:203.0.113.7]:3478")),
            "not an address a browser can reach",
        ),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp(name),
            stun,
            stun_public: public,
            ..Config::default()
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains(why), "{name}: {err}");
    }
    // The stun port is free again after a start that failed later on (the tracker's port
    // was taken).
    let stun_port = std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    let taken_tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let err = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("stun-then-tracker-taken"),
        stun: Some(stun_port),
        embed_tracker: Some(taken_tcp.local_addr().unwrap()),
        ..Config::default()
    })
    .await
    .err()
    .expect("refused");
    assert!(err.to_string().contains("io:"), "{err}");
    std::net::UdpSocket::bind(stun_port).expect("the stun port was let go");
    // A port already taken fails the start, not later.
    let taken = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let err = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("stun-taken"),
        stun: Some(taken.local_addr().unwrap()),
        ..Config::default()
    })
    .await
    .err()
    .expect("refused");
    assert!(err.to_string().contains("io:"), "{err}");
    // Bound on every interface and told nothing public: it answers, and announces nothing.
    let quiet = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("stun-quiet"),
        stun: Some(sa("0.0.0.0:0")),
        ..Config::default()
    })
    .await
    .expect("starts");
    assert!(quiet.stun_addr.is_some());
    assert_eq!(quiet.stun_public, None);
    quiet.shutdown().await;
    // Bound on loopback (or any address that is not public) and told nothing: the same.
    let local = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("stun-loopback"),
        stun: Some(sa("127.0.0.1:0")),
        ..Config::default()
    })
    .await
    .expect("starts");
    assert!(local.stun_addr.is_some());
    assert_eq!(local.stun_public, None);
    local.shutdown().await;
}

/// The next beacon `watch` hears.
async fn next_beacon(
    watch: &mut nfx_node::nostr::BeaconWatch,
) -> Verified<nfx_proto::beacon::Beacon> {
    tokio::time::timeout(WAIT, watch.next())
        .await
        .expect("a beacon")
        .expect("a beacon")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seeder_answers_stun_and_announces_it_in_its_beacons() {
    let seed_dir = tmp("stun-seeder");
    let (event, manifest, _) = vector_package(&seed_dir);
    let a = manifest.a_tag();
    let public: SocketAddr = "203.0.113.7:3478".parse().unwrap();
    let seeder = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: seed_dir.join("store"),
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        stun: Some("127.0.0.1:0".parse().unwrap()),
        stun_public: Some(public),
        ..Config::default()
    })
    .await
    .unwrap();
    let stun = seeder.stun_addr.unwrap();
    assert!(stun.ip().is_loopback() && stun.port() != 0, "{stun}");
    assert_eq!(seeder.stun_public, Some(public));

    // A real Binding round trip with the running daemon.
    let client = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    client.connect(stun).await.unwrap();
    let txid = [0x5a; 12];
    let mut request = vec![0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42];
    request.extend_from_slice(&txid);
    client.send(&request).await.unwrap();
    let mut buf = [0u8; 1500];
    let n = tokio::time::timeout(Duration::from_secs(5), client.recv(&mut buf))
        .await
        .expect("an answer")
        .unwrap();
    assert_eq!(
        nfxd::stun::mapped_address(&buf[..n], &txid),
        Some(client.local_addr().unwrap())
    );

    // Its beacons carry the public address as a `stun` endpoint, beside the iroh one.
    let relay_url = seeder.relay_url.clone().unwrap();
    let relays = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    let mut beacons = relays
        .watch_beacons(manifest.addr.namespace(), std::slice::from_ref(&a))
        .await
        .unwrap();
    relays.publish(&event).await.unwrap();
    until_state(&seeder, &a, &VideoState::Seeding).await;
    let beacon = next_beacon(&mut beacons).await;
    let stun_endpoints: Vec<_> = beacon
        .content
        .endpoints
        .iter()
        .filter_map(|e| match e {
            nfx_proto::beacon::Endpoint::Stun { addrs } => Some(addrs.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(stun_endpoints, [vec![public.to_string()]]);
    assert!(
        beacon
            .content
            .endpoints
            .iter()
            .any(|e| matches!(e, nfx_proto::beacon::Endpoint::Iroh { .. }))
    );
    relays.shutdown().await;
    seeder.shutdown().await;

    // Shut down, it answers no more.
    client.send(&request).await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(500), client.recv(&mut buf))
            .await
            .map_or(true, |r| r.is_err()),
        "an answer after shutdown"
    );
}

/// A two-rendition video (720p and 360p, three 2 s segments each, fabricated bytes) as an
/// `nfx-package` output directory, and its open manifest signed by `creator`.
async fn two_rendition_package(
    dir: &Path,
    creator: &Keys,
) -> (Event, Verified<Manifest>, HashList) {
    use nfx_proto::hashlist::{FileEntry, Rendition};
    let store = FsStore::open(dir.join("store")).unwrap();
    let video = "nfx:testnet:1:two-renditions";
    let entry = |name: String, role: Role, bytes: &[u8], dur_ms: Option<u64>| FileEntry {
        name,
        role,
        sha256: hex::encode(nfx_proto::sha256(bytes)),
        size: bytes.len() as u64,
        dur_ms,
    };
    let mut files = Vec::new();
    let mut playlists = Vec::new();
    let mut renditions = Vec::new();
    let mut media = Vec::new();
    for (id, res) in [("720p", "1280x720"), ("360p", "640x360")] {
        let init = format!("init of {id}").into_bytes();
        let mut text = format!(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI=\"{}.mp4\"\n#EXT-X-INDEPENDENT-SEGMENTS\n",
            hex::encode(nfx_proto::sha256(&init))
        );
        media.push(entry(format!("init-{id}.mp4"), Role::Init, &init, None));
        store.put(&init).unwrap();
        for i in 0..3 {
            let seg = format!("{id} segment {i} ").repeat(64).into_bytes();
            text.push_str(&format!(
                "#EXTINF:2.000,\n{}.m4s\n",
                hex::encode(nfx_proto::sha256(&seg))
            ));
            media.push(entry(
                format!("{id}-seg{i}.m4s"),
                Role::Segment,
                &seg,
                Some(2000),
            ));
            store.put(&seg).unwrap();
        }
        text.push_str("#EXT-X-ENDLIST\n");
        let name = format!("r{id}.m3u8");
        playlists.push(entry(name.clone(), Role::Playlist, text.as_bytes(), None));
        store.put(text.as_bytes()).unwrap();
        renditions.push(Rendition {
            id: id.into(),
            playlist: name,
            bandwidth: 1_000_000,
            codecs: Some("avc1.64001f,mp4a.40.2".into()),
            resolution: Some(res.into()),
        });
    }
    let mut master = String::from("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n");
    for (p, r) in playlists.iter().zip(&renditions) {
        master.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION={}\n{}.m3u8\n",
            r.resolution.as_deref().unwrap(),
            p.sha256
        ));
    }
    store.put(master.as_bytes()).unwrap();
    files.push(entry(
        "master.m3u8".into(),
        Role::PlaylistMaster,
        master.as_bytes(),
        None,
    ));
    files.extend(playlists);
    files.extend(media);
    let list = HashList {
        v: 1,
        video: video.into(),
        files,
        renditions,
    };
    let bytes = list.render();
    let root = store.put(&bytes).unwrap();
    let meta = serde_json::json!({ "root": root, "video": video, "segs": list.files.len() });
    std::fs::write(dir.join("nfx.json"), meta.to_string()).unwrap();
    let package = Package::open(dir).unwrap();
    let now = unix_now();
    let manifest = package
        .manifest("Two renditions", "a test video", None, &[], now)
        .unwrap();
    let (event, manifest) = sign_manifest(creator, &manifest, now).await.unwrap();
    (event, manifest, list)
}

/// The files of one rendition: its init and segments.
fn rendition_files<'a>(list: &'a HashList, id: &str) -> Vec<&'a nfx_proto::hashlist::FileEntry> {
    let prefix = (format!("init-{id}."), format!("{id}-seg"));
    list.files
        .iter()
        .filter(|f| f.name.starts_with(&prefix.0) || f.name.starts_with(&prefix.1))
        .collect()
}

/// The next beacon `watch` hears from `seeder`.
async fn next_beacon_from(
    watch: &mut nfx_node::nostr::BeaconWatch,
    seeder: &str,
) -> Verified<nfx_proto::beacon::Beacon> {
    loop {
        let beacon = next_beacon(watch).await;
        if beacon.seeder == seeder {
            return beacon;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_node_holds_serves_and_announces_only_the_renditions_it_names() {
    use nfx_proto::beacon::{Chunks, Endpoint};
    let (_iroh, iroh_url) = iroh_relay().await;
    let seed_dir = tmp("held-seed");
    let creator = Keys::generate();
    let (event, manifest, list) = two_rendition_package(&seed_dir, &creator).await;
    let a = manifest.a_tag();
    assert_eq!(list.renditions.len(), 2);
    let (r720, r360) = (
        rendition_files(&list, "720p"),
        rendition_files(&list, "360p"),
    );
    assert_eq!((r720.len(), r360.len()), (4, 4));

    // A seeds every rendition, and runs the relay everyone else uses.
    let a_keys = Keys::generate();
    let seeder = Daemon::start(Config {
        keys: Some(a_keys.clone()),
        store: seed_dir.join("store"),
        iroh_relays: vec![iroh_url.clone()],
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        ..Config::default()
    })
    .await
    .unwrap();
    let relay_url = seeder.relay_url.clone().unwrap();
    let client = Relays::connect(std::slice::from_ref(&relay_url), Duration::from_secs(10))
        .await
        .unwrap();
    let mut beacons = client
        .watch_beacons(manifest.addr.namespace(), std::slice::from_ref(&a))
        .await
        .unwrap();
    assert_eq!(client.publish(&event).await.unwrap(), 1);
    until_state(&seeder, &a, &VideoState::Seeding).await;

    // B fetches only 360p, serves it on its origin and bridge, and seeds it.
    let b_keys = Keys::generate();
    let b_store_dir = tmp("held-b-store");
    let https = "https://origin.example/nfx";
    let b = Daemon::start(Config {
        keys: Some(b_keys.clone()),
        store: b_store_dir.clone(),
        relays: vec![relay_url.clone()],
        iroh_relays: vec![iroh_url.clone()],
        fetch: vec![a.clone()],
        renditions: [(a.clone(), vec!["360p".to_owned()])].into(),
        origin: Some("127.0.0.1:0".parse().unwrap()),
        https_url: Some(https.into()),
        embed_tracker: Some("127.0.0.1:0".parse().unwrap()),
        bridge: Some("127.0.0.1:0".parse().unwrap()),
        tracker_public_url: Some("ws://127.0.0.1:1/announce".into()),
        ..Config::default()
    })
    .await
    .unwrap();
    until_state(&b, &a, &VideoState::Seeding).await;

    // B holds the hash list, every playlist, and 360p's files, and none of 720p's.
    let b_store = FsStore::open(&b_store_dir).unwrap();
    assert!(b_store.has(&manifest.root_hex()));
    for f in list.files.iter().filter(|f| !r720.contains(f)) {
        assert!(b_store.has(&f.sha256), "{} fetched", f.name);
    }
    for f in &r720 {
        assert!(!b_store.has(&f.sha256), "{} not fetched", f.name);
    }

    // Its origin serves the meta files and 360p, and answers 404 for 720p's files.
    let origin = b.origin_addr.unwrap();
    let root = manifest.root_hex();
    assert_eq!(
        get(origin, &format!("/{root}/master.m3u8")).await.0,
        StatusCode::OK
    );
    for f in list.files.iter().filter(|f| f.role == Role::Playlist) {
        assert_eq!(
            get(origin, &format!("/{}.m3u8", f.sha256)).await.0,
            StatusCode::OK
        );
    }
    for f in &r360 {
        assert_eq!(
            get(origin, &format!("/{root}/{}.m4s", f.sha256)).await.0,
            StatusCode::OK,
            "{}",
            f.name
        );
    }
    for f in &r720 {
        assert_eq!(
            get(origin, &format!("/{root}/{}.m4s", f.sha256)).await.0,
            StatusCode::NOT_FOUND,
            "{}",
            f.name
        );
        assert_eq!(
            get(origin, &format!("/{}", f.sha256)).await.0,
            StatusCode::NOT_FOUND
        );
    }

    // Its beacons tell the truth: a ticket for 360p and meta only, the origin and the bridge
    // name 360p, and `chunks` counts the 7 of 11 files it holds.
    let beacon = next_beacon_from(&mut beacons, &b_keys.public_key().to_hex()).await;
    let content = &beacon.content;
    let tickets = content.endpoints.iter().find_map(|e| match e {
        Endpoint::Iroh { tickets, .. } => Some(tickets.keys().cloned().collect::<Vec<_>>()),
        _ => None,
    });
    assert_eq!(tickets.unwrap(), ["360p", "meta"]);
    assert!(content.endpoints.contains(&Endpoint::Https {
        url: https.into(),
        renditions: vec!["360p".into()],
    }));
    let webrtc = content.endpoints.iter().find_map(|e| match e {
        Endpoint::Webrtc { renditions, .. } => Some(renditions.clone()),
        _ => None,
    });
    assert_eq!(
        webrtc.unwrap(),
        ["360p"],
        "the bridge joins 360p's swarm only"
    );
    assert_eq!(content.chunks, Chunks::Count(7));
    assert_eq!(list.files.len(), 11);
    // Its tracker still admits both swarms: browsers watching 720p may meet there.
    let tracker = b.tracker().unwrap();
    for id in ["720p", "360p"] {
        assert!(
            tracker.admits(&manifest.addr.web_tracker_infohash(id)),
            "{id}"
        );
    }

    // A, which holds everything, says so.
    let full = next_beacon_from(&mut beacons, &a_keys.public_key().to_hex()).await;
    let tickets = full.content.endpoints.iter().find_map(|e| match e {
        Endpoint::Iroh { tickets, .. } => Some(tickets.keys().cloned().collect::<Vec<_>>()),
        _ => None,
    });
    assert_eq!(tickets.unwrap(), ["360p", "720p", "meta"]);
    assert_eq!(full.content.chunks, Chunks::All);

    // A fetcher asking for a rendition the hash list lacks fails, naming those it has.
    let c = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: tmp("held-c-store"),
        relays: vec![relay_url.clone()],
        iroh_relays: vec![iroh_url.clone()],
        fetch: vec![a.clone()],
        renditions: [(a.clone(), vec!["1080p".to_owned()])].into(),
        ..Config::default()
    })
    .await
    .unwrap();
    let failed = tokio::time::timeout(WAIT, async {
        loop {
            if let Some(VideoState::Failed(why)) = c.state().get(&a) {
                return why.clone();
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the fetch fails");
    assert!(
        failed.contains("no rendition \"1080p\"") && failed.contains("720p, 360p"),
        "{failed}"
    );
    c.shutdown().await;

    // B's store, holding 360p only, seeds as 360p; seeding it whole is refused.
    b.shutdown().await;
    let d_keys = Keys::generate();
    let d = Daemon::start(Config {
        keys: Some(d_keys.clone()),
        store: b_store_dir.clone(),
        relays: vec![relay_url.clone()],
        seed: vec![a.clone()],
        renditions: [(a.clone(), vec!["360p".to_owned()])].into(),
        ..Config::default()
    })
    .await
    .unwrap();
    until_state(&d, &a, &VideoState::Seeding).await;
    let beacon = next_beacon_from(&mut beacons, &d_keys.public_key().to_hex()).await;
    assert_eq!(beacon.content.chunks, Chunks::Count(7));
    d.shutdown().await;
    let whole = Daemon::start(Config {
        keys: Some(Keys::generate()),
        store: b_store_dir.clone(),
        relays: vec![relay_url.clone()],
        seed: vec![a.clone()],
        ..Config::default()
    })
    .await
    .unwrap();
    tokio::time::timeout(WAIT, async {
        while !matches!(whole.state().get(&a), Some(VideoState::Failed(_))) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("seeding a rendition it does not hold fails");
    whole.shutdown().await;

    client.shutdown().await;
    seeder.shutdown().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn held_renditions_that_cannot_work_are_refused_at_start() {
    let a = "38504:0be0a67acefacebe95ed0d4253828d5524d8f314e7d65d2f153c1fb6b820250f:nfx:testnet:1:two-renditions".to_owned();
    for (renditions, why) in [
        (
            [(
                "38504:aa:nfx:testnet:1:another-video".to_owned(),
                vec!["720p".to_owned()],
            )]
            .into(),
            "not a video to seed, fetch or pull",
        ),
        ([(a.clone(), vec![])].into(), "no rendition named"),
        (
            [(a.clone(), vec!["meta".to_owned()])].into(),
            "is not a rendition id",
        ),
        (
            [(a.clone(), vec![String::new()])].into(),
            "is not a rendition id",
        ),
        (
            [(a.clone(), vec!["720p".to_owned(), "720p".to_owned()])].into(),
            "named twice",
        ),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp("held-refused"),
            fetch: vec![a.clone()],
            renditions,
            ..Config::default()
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains(why), "{err}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn mesh_settings_that_cannot_work_are_refused_at_start() {
    let sa = |s: &str| -> SocketAddr { s.parse().unwrap() };
    let relay = || vec!["ws://127.0.0.1:9".to_owned()];
    for (name, cfg, why) in [
        (
            "mesh-bind-alone",
            Config {
                mesh_bind: Some(sa("127.0.0.1:0")),
                ..Config::default()
            },
            "--mesh-bind needs --mesh-relay",
        ),
        (
            "mesh-stun-alone",
            Config {
                mesh_stun: vec![sa("203.0.113.7:3478")],
                ..Config::default()
            },
            "--mesh-stun needs --mesh-relay",
        ),
        (
            "mesh-peers-alone",
            Config {
                mesh_max_peers: Some(4),
                ..Config::default()
            },
            "--mesh-max-peers needs --mesh-relay",
        ),
        (
            "mesh-relay-scheme",
            Config {
                mesh_relays: vec!["https://relay.example".into()],
                ..Config::default()
            },
            "--mesh-relay https://relay.example: not a wss:// or ws:// URL",
        ),
        (
            "mesh-relay-credentials",
            Config {
                mesh_relays: vec!["wss://u:p@relay.example".into()],
                ..Config::default()
            },
            "no credentials",
        ),
        (
            "mesh-relays-nine",
            Config {
                mesh_relays: vec!["wss://relay.example".into(); 9],
                ..Config::default()
            },
            "--mesh-relay: at most 8",
        ),
        (
            "mesh-stun-five",
            Config {
                mesh_relays: relay(),
                mesh_stun: vec![sa("203.0.113.7:3478"); 5],
                ..Config::default()
            },
            "--mesh-stun: at most 4",
        ),
        (
            "mesh-stun-family",
            Config {
                mesh_relays: relay(),
                mesh_stun: vec![sa("[2001:db8::7]:3478")],
                ..Config::default()
            },
            "not a unicast address of --mesh-bind's family",
        ),
        (
            "mesh-stun-port-0",
            Config {
                mesh_relays: relay(),
                mesh_stun: vec![sa("203.0.113.7:0")],
                ..Config::default()
            },
            "not a unicast address",
        ),
        (
            "mesh-peers-0",
            Config {
                mesh_relays: relay(),
                mesh_max_peers: Some(0),
                ..Config::default()
            },
            "--mesh-max-peers 0: not 1 to 1024",
        ),
        (
            "mesh-relay-only",
            Config {
                mesh_relays: relay(),
                relay_only: true,
                iroh_relays: vec!["https://relay.example".parse().unwrap()],
                ..Config::default()
            },
            "a relay-only node opens no direct UDP",
        ),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp(name),
            ..cfg
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains(why), "{name}: {err}");
    }
}

/// The next signaling event on `notes` from `session` in `room` whose `t` is `t`.
async fn next_signal(
    notes: &mut std::pin::Pin<
        Box<dyn n0_future::Stream<Item = nostr_sdk::prelude::ClientNotification> + Send>,
    >,
    room: &str,
    session: &str,
    t: &str,
) {
    use n0_future::StreamExt as _;
    use nfx_proto::signal::{self, Parsed, Signal};
    let deadline = std::time::Instant::now() + WAIT;
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        let n = tokio::time::timeout(left, notes.next())
            .await
            .unwrap_or_else(|_| panic!("no {t} from {session}"));
        let Some(nostr_sdk::prelude::ClientNotification::Event { event, .. }) = n else {
            continue;
        };
        let ev: Event = serde_json::from_str(&event.as_json()).unwrap();
        if ev.pubkey != session {
            continue;
        }
        let me = "0".repeat(64);
        if let Ok(Parsed::Ours(r)) = signal::read(&ev, room, &me, unix_now()) {
            let got = match r.signal {
                Signal::Connect { .. } => "connect",
                Signal::Disconnect => "disconnect",
                Signal::Offer { .. } => "offer",
                Signal::Answer { .. } => "answer",
            };
            if got == t {
                return;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seeder_with_the_mesh_is_present_in_its_room_and_leaves_it_on_shutdown() {
    use nostr_sdk::prelude as ns;
    // A general relay for the signaling: the embedded scoped relay refuses kind 25050.
    let general = ns::LocalRelay::builder().build();
    general.run().await.unwrap();
    let general_url = general.url().await.to_string();

    let seed_dir = tmp("mesh-seeder");
    let (event, manifest, _) = vector_package(&seed_dir);
    let a = manifest.a_tag();
    let keys = Keys::generate();
    let seeder = Daemon::start(Config {
        keys: Some(keys.clone()),
        store: seed_dir.join("store"),
        seed: vec![a.clone()],
        embed_relay: Some("127.0.0.1:0".parse().unwrap()),
        mesh_relays: vec![general_url.clone()],
        mesh_bind: Some("127.0.0.1:0".parse().unwrap()),
        no_portmapper: true,
        ..Config::default()
    })
    .await
    .unwrap();
    let session = seeder.mesh_session.clone().unwrap();
    assert_eq!(session.len(), 64);
    assert_ne!(
        session,
        keys.public_key().to_hex(),
        "the session key is not the node's"
    );
    assert!(seeder.mesh_addr.unwrap().ip().is_loopback());

    // Listen in the 720p room before the video is seeded.
    let room = nfx_proto::signal::Room::derive(&manifest.addr.web_stream_swarm_id("720p"));
    let listener = ns::Client::default();
    listener.add_relay(general_url.as_str()).await.unwrap();
    listener.connect().and_wait(Duration::from_secs(5)).await;
    let mut notes = listener.notifications();
    listener
        .subscribe(
            ns::Filter::new()
                .kind(ns::Kind::from(nfx_proto::signal::KIND_SIGNAL))
                .custom_tag(ns::SingleLetterTag::UPPERCASE_P, room.pubkey()),
        )
        .await
        .unwrap();

    let relays = Relays::connect(
        std::slice::from_ref(seeder.relay_url.as_ref().unwrap()),
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    relays.publish(&event).await.unwrap();
    until_state(&seeder, &a, &VideoState::Seeding).await;
    next_signal(&mut notes, room.pubkey(), &session, "connect").await;
    let status = seeder.mesh_status().unwrap();
    assert_eq!(status.rooms, 1, "{status:?}");
    assert!(status.gathered, "{status:?}");
    assert_eq!(
        status.candidates,
        vec![format!("host {}", seeder.mesh_addr.unwrap())]
    );

    relays.shutdown().await;
    seeder.shutdown().await;
    next_signal(&mut notes, room.pubkey(), &session, "disconnect").await;
    listener.shutdown().await;
}
