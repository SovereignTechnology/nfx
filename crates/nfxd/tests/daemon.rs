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
    tokio::time::timeout(WAIT, async {
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
    for (name, relay_only, relay) in [
        ("gossip-relay-only", true, "https://relay.ours.example/"),
        ("gossip-foreign", false, "https://relay.attacker.example/"),
    ] {
        let err = Daemon::start(Config {
            keys: Some(Keys::generate()),
            store: tmp(name),
            relay_only,
            iroh_relays: vec![ours.clone()],
            gossip_peers: vec![peer(relay)],
            ..Config::default()
        })
        .await
        .err()
        .expect("refused");
        assert!(err.to_string().contains("--gossip-peer"), "{name}: {err}");
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

    // B fetches from A over iroh, verified, and starts seeding it too.
    until_state(&b, &a, &VideoState::Seeding).await;
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
