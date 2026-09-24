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
fn vector_package(dir: &Path) -> (Event, Manifest, HashList) {
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
    assert_eq!(parsed.thumb.unwrap().sha256, thumb.sha256);

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
            seen.insert(beacon.seeder);
        }
    })
    .await
    .unwrap_or_else(|_| panic!("seeders seen: {seen:?}"));
    assert_eq!(watch.rejected, 0);

    client.shutdown().await;
    seeder.shutdown().await;
    b.shutdown().await;
}
