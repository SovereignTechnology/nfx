//! The real `nutflixd` binary: a manifest published to its embedded relay is served after the
//! process is killed and started again on the same `--state`, with nothing re-sent (issue
//! #114). Without `--state` a restart forgets it, as it always has.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs::File;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use nfx_node::nostr::{ManifestQuery, Relays, sign_manifest};
use nfx_node::unix_now;
use nfx_proto::event::Event;
use nfx_proto::manifest::Manifest;
use nfx_proto::namespace::VideoAddr;
use nostr_sdk::prelude::Keys;
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(30);

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "nutflixd-relay-restart-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn free_port() -> u16 {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn video() -> Manifest {
    let v: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/manifest.json")).unwrap();
    let event: Event = serde_json::from_value(v["event"].clone()).unwrap();
    let m = Manifest::from_event(&event).unwrap().into_inner();
    Manifest {
        addr: VideoAddr::new(m.addr.namespace().clone(), "restart-video").unwrap(),
        ..m
    }
}

/// A running `nutflixd`, killed if the test ends early.
struct Nutflixd(Child);

impl Nutflixd {
    fn start(root: &Path, state: Option<&Path>, port: u16, log: &str) -> Self {
        let namespace = video().addr.namespace().to_string();
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_nutflixd"));
        cmd.arg("run")
            .arg("--store")
            .arg(root.join("store"))
            .args(["--embed-relay", &format!("127.0.0.1:{port}")])
            .args(["--namespace", &namespace]);
        if let Some(state) = state {
            cmd.arg("--state").arg(state);
        }
        let log = File::create(root.join(log)).unwrap();
        // Guarded from here on: a failed assertion below must not leave it running.
        let mut nutflixd = Self(
            cmd.stdout(Stdio::null())
                .stderr(Stdio::from(log))
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + WAIT;
        while TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err() {
            assert!(
                nutflixd.0.try_wait().unwrap().is_none(),
                "nutflixd exited before listening"
            );
            assert!(Instant::now() < deadline, "nutflixd did not listen in time");
            std::thread::sleep(Duration::from_millis(50));
        }
        nutflixd
    }

    /// SIGKILL: no shutdown path gets to run.
    fn kill(mut self) {
        self.0.kill().unwrap();
        self.0.wait().unwrap();
    }
}

impl Drop for Nutflixd {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn read_back(url: &str, author: &str) -> Vec<String> {
    let reader = Relays::connect(&[url.to_owned()], WAIT).await.unwrap();
    let query = ManifestQuery {
        namespace: video().addr.namespace().clone(),
        authors: vec![author.to_owned()],
        videos: vec![],
    };
    let found = reader.manifests(&query, WAIT).await.unwrap();
    reader.shutdown().await;
    found.iter().map(|m| m.addr.to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manifest_outlives_a_killed_nutflixd_on_the_same_state() {
    let root = tmp("state");
    let state = root.join("state");
    let port = free_port();
    let url = format!("ws://127.0.0.1:{port}");
    let keys = Keys::generate();
    let author = keys.public_key().to_hex();
    let (event, _) = sign_manifest(&keys, &video(), unix_now() - 10)
        .await
        .unwrap();

    let nutflixd = Nutflixd::start(&root, Some(&state), port, "first.log");
    let publisher = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();
    assert_eq!(publisher.publish(&event).await.unwrap(), 1);
    // Killed the moment the relay said OK, before anything else can give it time to finish a
    // write: an OK means it is on disk.
    nutflixd.kill();
    publisher.shutdown().await;

    let dir = state.join("relay-manifests");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);

    let nutflixd = Nutflixd::start(&root, Some(&state), port, "second.log");
    assert_eq!(
        read_back(&url, &author).await,
        [video().addr.to_string()],
        "served after the restart with nothing re-sent"
    );
    nutflixd.kill();
    let log = std::fs::read_to_string(root.join("second.log")).unwrap();
    assert!(log.contains("1 manifests reloaded"), "{log}");

    // A truncated file: it still starts, says so, and takes the manifest again.
    let file = std::fs::read_dir(&dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let bytes = std::fs::read(&file).unwrap();
    std::fs::write(&file, &bytes[..bytes.len() / 2]).unwrap();
    let nutflixd = Nutflixd::start(&root, Some(&state), port, "third.log");
    assert!(read_back(&url, &author).await.is_empty());
    let publisher = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();
    assert_eq!(publisher.publish(&event).await.unwrap(), 1);
    publisher.shutdown().await;
    assert_eq!(read_back(&url, &author).await.len(), 1);
    nutflixd.kill();
    let log = std::fs::read_to_string(root.join("third.log")).unwrap();
    assert!(log.contains("not a valid event; removed"), "{log}");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_state_a_restart_forgets_and_nothing_is_written() {
    let root = tmp("no-state");
    let port = free_port();
    let url = format!("ws://127.0.0.1:{port}");
    let keys = Keys::generate();
    let author = keys.public_key().to_hex();
    let (event, _) = sign_manifest(&keys, &video(), unix_now() - 10)
        .await
        .unwrap();

    let nutflixd = Nutflixd::start(&root, None, port, "first.log");
    let publisher = Relays::connect(std::slice::from_ref(&url), WAIT)
        .await
        .unwrap();
    assert_eq!(publisher.publish(&event).await.unwrap(), 1);
    publisher.shutdown().await;
    assert_eq!(read_back(&url, &author).await.len(), 1);
    nutflixd.kill();
    assert!(
        !root.join("store/.nutflixd/relay-manifests").exists(),
        "the default state directory keeps no manifests"
    );

    let nutflixd = Nutflixd::start(&root, None, port, "second.log");
    assert!(read_back(&url, &author).await.is_empty());
    nutflixd.kill();
}
