//! The embedded relay's state directory (issue #114), through a real WebSocket client: what a
//! relay serves after a restart on the same directory.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use nfx_node::nostr::{Relays, sign_beacon, sign_deletion, sign_manifest, sign_stun_announcement};
use nfx_node::relay::{MANIFESTS_PER_HOUR, MayAdmit, Reload, ScopedRelay};
use nfx_node::unix_now;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint};
use nfx_proto::event::Event;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::{Namespace, VideoAddr};
use nostr_sdk::prelude as ns;
use nostr_sdk::prelude::{Client, EventBuilder, Filter, FinalizeEvent as _, Keys, Kind, Tag};
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(10);

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nfx-relay-persist-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.join("relay-manifests")
}

/// The vector manifest, with `id` as its video.
fn video(id: &str) -> Manifest {
    let v: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
    let event: Event = serde_json::from_value(v["event"].clone()).unwrap();
    let m = Manifest::from_event(&event).unwrap().into_inner();
    Manifest {
        addr: VideoAddr::new(m.addr.namespace().clone(), id).unwrap(),
        ..m
    }
}

fn net() -> Namespace {
    video("persist-net").addr.namespace().clone()
}

struct Running {
    relay: Arc<ScopedRelay>,
    url: String,
    server: tokio::task::JoinHandle<()>,
    client: Client,
}

impl Running {
    async fn stop(self) {
        self.client.shutdown().await;
        self.relay.shutdown();
        self.server.abort();
    }

    async fn publish(&self, event: &Event) -> Result<(), String> {
        let event = ns::Event::from_json(serde_json::to_string(event).unwrap()).unwrap();
        let out = self.client.send_event(&event).await.unwrap();
        match out.failed.values().next() {
            Some(why) => Err(why.clone()),
            None => Ok(()),
        }
    }

    /// The ids of the manifests a reader gets, sorted.
    async fn served(&self) -> Vec<String> {
        let events = self
            .client
            .fetch_events(Filter::new().kind(Kind::from(38504u16)))
            .timeout(WAIT)
            .await
            .unwrap();
        let mut ids: Vec<String> = events.into_iter().map(|e| e.id.to_hex()).collect();
        ids.sort();
        ids
    }
}

async fn boot_with(
    dir: &Path,
    nets: &[Namespace],
    creators: Option<&[String]>,
    may: MayAdmit,
) -> (Running, Reload) {
    let (relay, reload) = ScopedRelay::admitting_persisted(nets, creators, may, dir)
        .await
        .unwrap();
    assert_eq!(reload.off, None);
    let relay = Arc::new(relay);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(relay.clone().serve(listener));
    let client = Client::default();
    client.add_relay(url.as_str()).await.unwrap();
    client.connect().and_wait(WAIT).await;
    (
        Running {
            relay,
            url,
            server,
            client,
        },
        reload,
    )
}

async fn boot(dir: &Path) -> (Running, Reload) {
    boot_with(dir, &[net()], None, MayAdmit::default()).await
}

async fn signed(keys: &Keys, id: &str, at: u64) -> Event {
    sign_manifest(keys, &video(id), at).await.unwrap().0
}

fn ids(events: &[&Event]) -> Vec<String> {
    let mut ids: Vec<String> = events.iter().map(|e| e.id.clone()).collect();
    ids.sort();
    ids
}

/// The point of it all: a manifest accepted before a restart is served after it, unsent.
#[tokio::test(flavor = "multi_thread")]
async fn an_accepted_manifest_is_served_after_a_restart() {
    let dir = tmp("basic");
    let keys = Keys::generate();
    let now = unix_now();
    let (a, b) = (
        signed(&keys, "persist-one", now - 20).await,
        signed(&keys, "persist-two", now - 10).await,
    );
    let (run, reload) = boot(&dir).await;
    assert_eq!(reload, Reload::default(), "an empty directory");
    run.publish(&a).await.unwrap();
    run.publish(&b).await.unwrap();
    run.stop().await;

    let (run, reload) = boot(&dir).await;
    assert_eq!(reload.served, 2, "{reload}");
    assert_eq!(run.served().await, ids(&[&a, &b]));
    // Through the reader's own path too.
    let reader = Relays::connect(std::slice::from_ref(&run.url), WAIT)
        .await
        .unwrap();
    let query = nfx_node::nostr::ManifestQuery {
        namespace: net(),
        authors: vec![keys.public_key().to_hex()],
        videos: vec![],
    };
    assert_eq!(reader.manifests(&query, WAIT).await.unwrap().len(), 2);
    reader.shutdown().await;
    run.stop().await;
}

/// A file grants nothing: reloaded manifests meet the rules of *this* run. A creator taken off
/// the allow-list, or a namespace no longer served, is not served, and its file stays, so
/// putting the flag back restores it.
#[tokio::test(flavor = "multi_thread")]
async fn a_reload_runs_the_current_admission_rules() {
    let dir = tmp("rules");
    let (alice, bob) = (Keys::generate(), Keys::generate());
    let now = unix_now();
    let (a, b) = (
        signed(&alice, "persist-alice", now - 20).await,
        signed(&bob, "persist-bobby", now - 10).await,
    );
    let (run, _) = boot(&dir).await;
    run.publish(&a).await.unwrap();
    run.publish(&b).await.unwrap();
    run.stop().await;

    let only_alice = [alice.public_key().to_hex()];
    let (run, reload) = boot_with(&dir, &[net()], Some(&only_alice), MayAdmit::default()).await;
    assert_eq!((reload.served, reload.refused), (1, 1), "{reload}");
    assert_eq!(run.served().await, ids(&[&a]));
    run.stop().await;

    let other = Namespace::parse("nfx:persist-other:1").unwrap();
    let (run, reload) = boot_with(&dir, &[other], None, MayAdmit::default()).await;
    assert_eq!((reload.served, reload.refused), (0, 2), "{reload}");
    assert!(run.served().await.is_empty());
    run.stop().await;

    let (run, reload) = boot(&dir).await;
    assert_eq!((reload.served, reload.refused), (2, 0), "{reload}");
    assert_eq!(run.served().await, ids(&[&a, &b]));
    run.stop().await;
}

/// Reloading is not publishing: more manifests than one key may publish in an hour all come
/// back, and the key's budget after the restart is untouched.
#[tokio::test(flavor = "multi_thread")]
async fn a_reload_is_not_held_to_the_publish_budget() {
    let dir = tmp("budget");
    let keys = Keys::generate();
    let now = unix_now();
    let mut all = Vec::new();
    for round in 0..2 {
        let (run, _) = boot(&dir).await;
        for i in 0..MANIFESTS_PER_HOUR {
            let e = signed(&keys, &format!("budget-{round}-{i}"), now - 100).await;
            run.publish(&e).await.unwrap();
            all.push(e);
        }
        run.stop().await;
    }
    let (run, reload) = boot(&dir).await;
    assert_eq!(reload.served, 2 * MANIFESTS_PER_HOUR, "{reload}");
    assert_eq!(run.served().await.len(), 2 * MANIFESTS_PER_HOUR);
    let one_more = signed(&keys, "budget-after", now - 50).await;
    run.publish(&one_more).await.unwrap();
    run.stop().await;
}

/// Replaceable across a restart: the newest is what comes back, and the older copy, re-sent
/// afterwards, does not displace it, then or at the next restart.
#[tokio::test(flavor = "multi_thread")]
async fn an_older_revision_cannot_come_back() {
    let dir = tmp("replace");
    let keys = Keys::generate();
    let now = unix_now();
    let older = signed(&keys, "persist-replace", now - 100).await;
    let newer = signed(&keys, "persist-replace", now - 50).await;
    let (run, _) = boot(&dir).await;
    run.publish(&older).await.unwrap();
    run.publish(&newer).await.unwrap();
    run.stop().await;

    let (run, reload) = boot(&dir).await;
    assert_eq!(reload.served, 1, "{reload}");
    assert_eq!(run.served().await, ids(&[&newer]));
    assert!(run.publish(&older).await.is_err(), "refused: it is older");
    assert_eq!(run.served().await, ids(&[&newer]));
    run.stop().await;

    let (run, _) = boot(&dir).await;
    assert_eq!(run.served().await, ids(&[&newer]));
    run.stop().await;
}

/// A deletion the relay honoured stays honoured: the manifest is gone after a restart, a
/// replay of it is refused, and a later revision republishes the video (NFX-02 §6). The same
/// holds for an address the relay held nothing for when the deletion came.
#[tokio::test(flavor = "multi_thread")]
async fn a_honoured_deletion_survives_a_restart() {
    let dir = tmp("deletion");
    let keys = Keys::generate();
    let now = unix_now();
    let held = signed(&keys, "persist-deleted", now - 100).await;
    let unseen = signed(&keys, "persist-unseen", now - 100).await;
    let kept = signed(&keys, "persist-kept", now - 100).await;
    let a_tags = [video("persist-deleted").addr, video("persist-unseen").addr]
        .map(|addr| format!("38504:{}:{addr}", keys.public_key().to_hex()));
    let deletion = sign_deletion(&keys, &a_tags, now - 50).await.unwrap();
    let (run, _) = boot(&dir).await;
    run.publish(&held).await.unwrap();
    run.publish(&kept).await.unwrap();
    run.publish(&deletion).await.unwrap();
    assert_eq!(run.served().await, ids(&[&kept]));
    run.stop().await;

    let (run, reload) = boot(&dir).await;
    assert_eq!((reload.served, reload.deletions), (1, 2), "{reload}");
    assert_eq!(run.served().await, ids(&[&kept]));
    for replay in [&held, &unseen] {
        let why = run.publish(replay).await.unwrap_err();
        assert!(why.contains("deleted by its author"), "{why}");
    }
    assert_eq!(run.served().await, ids(&[&kept]));
    let revived = signed(&keys, "persist-deleted", now - 10).await;
    run.publish(&revived).await.unwrap();
    run.stop().await;

    let (run, _) = boot(&dir).await;
    assert_eq!(run.served().await, ids(&[&kept, &revived]));
    run.stop().await;
}

/// NIP-40: a manifest that expires while the relay is down is not served after, and its file
/// goes. The one that has not expired stays. The older revision the expired one replaced
/// cannot be re-sent in its place; a newer one can.
#[tokio::test(flavor = "multi_thread")]
async fn an_expired_manifest_is_not_served_after_a_reload() {
    let dir = tmp("expired");
    let keys = Keys::generate();
    let now = unix_now();
    let expiring = |id: &'static str, at: u64| {
        let keys = keys.clone();
        async move {
            let m = video(id);
            let mut tags: Vec<Tag> = m
                .tags()
                .into_iter()
                .map(|t| Tag::parse(t).unwrap())
                .collect();
            tags.push(Tag::parse(["expiration", &at.to_string()]).unwrap());
            let ev = EventBuilder::new(Kind::from(38504u16), m.description.clone())
                .tags(tags)
                .custom_created_at(ns::Timestamp::from_secs(now - 5))
                .finalize(&keys)
                .unwrap();
            serde_json::from_str::<Event>(&ev.as_json()).unwrap()
        }
    };
    let replaced = signed(&keys, "persist-soon", now - 10).await;
    let soon = expiring("persist-soon", now + 3).await;
    let later = expiring("persist-later", now + 3600).await;
    let (run, _) = boot(&dir).await;
    run.publish(&replaced).await.unwrap();
    run.publish(&soon).await.unwrap();
    run.publish(&later).await.unwrap();
    run.stop().await;
    let records = || {
        std::fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                let name = e.as_ref().unwrap().file_name();
                name.to_str().unwrap().ends_with(".json")
            })
            .count()
    };
    assert_eq!(records(), 2);

    while unix_now() <= now + 3 {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let (run, reload) = boot(&dir).await;
    assert_eq!((reload.served, reload.expired), (1, 1), "{reload}");
    assert_eq!(run.served().await, ids(&[&later]));
    assert_eq!(records(), 1);
    assert!(run.publish(&replaced).await.is_err(), "it cannot come back");
    assert_eq!(run.served().await, ids(&[&later]));
    let newer = signed(&keys, "persist-soon", unix_now()).await;
    run.publish(&newer).await.unwrap();
    run.stop().await;

    let (run, _) = boot(&dir).await;
    assert_eq!(run.served().await, ids(&[&later, &newer]));
    run.stop().await;
}

/// Only manifests reach the disk. A relay taking every kind it can (beacons, mesh signaling,
/// STUN announcements) writes one file here: the manifest.
#[tokio::test(flavor = "multi_thread")]
async fn ephemeral_and_other_kinds_never_reach_the_disk() {
    use nfx_proto::signal::{Room, Session};

    let dir = tmp("kinds");
    let keys = Keys::generate();
    let now = unix_now();
    let may = MayAdmit {
        mesh_signaling: true,
        stun_announcements: true,
    };
    let m = video("persist-kinds");
    let (manifest, verified) = sign_manifest(&keys, &m, now - 10).await.unwrap();
    let content = BeaconContent {
        v: 1,
        video: m.addr.clone(),
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
    let beacon = sign_beacon(&keys, &verified.a_tag(), &content, now, 60)
        .await
        .unwrap();
    let room = Room::derive("nfx/1/web/nfx:testnet:1:persist-kinds/720p");
    let signal = Session::new([1; 32], [2; 16])
        .unwrap()
        .connect(&room, now)
        .unwrap();
    let stun = sign_stun_announcement(&keys, "1.1.1.1:3478", &[net()], now, 600)
        .await
        .unwrap();

    let (run, _) = boot_with(&dir, &[net()], None, may).await;
    for event in [&manifest, &beacon, &signal, &stun] {
        run.publish(event).await.unwrap();
    }
    run.stop().await;

    let files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1, "{files:?}");
    let on_disk: Value = serde_json::from_slice(&std::fs::read(&files[0]).unwrap()).unwrap();
    assert_eq!(on_disk["id"].as_str(), Some(manifest.id.as_str()));
    assert_eq!(on_disk["kind"].as_u64(), Some(38504));
}

/// A damaged directory does not stop a relay: it starts, serves what is valid, and accepts.
#[tokio::test(flavor = "multi_thread")]
async fn a_damaged_file_does_not_stop_the_relay() {
    let dir = tmp("damaged");
    let keys = Keys::generate();
    let now = unix_now();
    let (good, bad) = (
        signed(&keys, "persist-good", now - 20).await,
        signed(&keys, "persist-bad0", now - 10).await,
    );
    let (run, _) = boot(&dir).await;
    run.publish(&good).await.unwrap();
    run.publish(&bad).await.unwrap();
    run.stop().await;
    // Truncate one of the two to half its length.
    let victim = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| std::fs::read_to_string(p).unwrap().contains(&bad.id))
        .unwrap();
    let bytes = std::fs::read(&victim).unwrap();
    std::fs::write(&victim, &bytes[..bytes.len() / 2]).unwrap();

    let (run, reload) = boot(&dir).await;
    assert_eq!((reload.served, reload.corrupt), (1, 1), "{reload}");
    assert_eq!(reload.notes.len(), 1, "a clear line: {:?}", reload.notes);
    assert_eq!(run.served().await, ids(&[&good]));
    run.publish(&bad).await.unwrap();
    assert_eq!(run.served().await, ids(&[&good, &bad]));
    run.stop().await;
}
