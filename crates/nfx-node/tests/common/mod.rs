//! Shared fixtures: the NFX test-vector video in a fresh store, a self-hosted iroh relay,
//! and scratch directories.

#![allow(clippy::unwrap_used, clippy::expect_used, dead_code)]

use std::net::Ipv4Addr;
use std::path::PathBuf;

use base64::Engine as _;
use iroh::RelayUrl;
use nfx_node::store::{ContentStore, FsStore};
use nfx_proto::event::Event;
use nfx_proto::hashlist::HashList;
use nfx_proto::manifest::Manifest;
use serde_json::Value;

pub struct Vector {
    pub manifest: Manifest,
    pub list: HashList,
    pub seeder_secret: [u8; 32],
}

/// The test-vector video, written into a fresh store.
pub fn vector_store(dir: &PathBuf) -> (FsStore, Vector) {
    let m: Value =
        serde_json::from_str(include_str!("../../../../spec/test-vectors/manifest.json")).unwrap();
    let manifest =
        Manifest::from_event(&serde_json::from_value::<Event>(m["event"].clone()).unwrap())
            .unwrap();
    let hl: Value =
        serde_json::from_str(include_str!("../../../../spec/test-vectors/hashlist.json")).unwrap();
    let list: HashList = serde_json::from_value(hl["hashlist"].clone()).unwrap();
    let store = FsStore::open(dir).unwrap();
    assert_eq!(store.put(&list.render()).unwrap(), manifest.root_hex());
    for b64 in hl["fabricated"].as_object().unwrap().values() {
        store
            .put(
                &base64::engine::general_purpose::STANDARD
                    .decode(b64.as_str().unwrap())
                    .unwrap(),
            )
            .unwrap();
    }
    for text in hl["playlists"].as_object().unwrap().values() {
        store.put(text.as_str().unwrap().as_bytes()).unwrap();
    }
    let mut seeder_secret = [0u8; 32];
    hex::decode_to_slice(
        m["secret_keys_DO_NOT_USE"]["seeder"].as_str().unwrap(),
        &mut seeder_secret,
    )
    .unwrap();
    (
        store,
        Vector {
            manifest,
            list,
            seeder_secret,
        },
    )
}

pub async fn relay() -> (iroh_relay::server::Server, RelayUrl) {
    use iroh_relay::server::{RelayConfig, Server, ServerConfig};
    let mut config = ServerConfig::default();
    config.relay = Some(RelayConfig::new((Ipv4Addr::LOCALHOST, 0)));
    let server = Server::spawn(config).await.unwrap();
    let url = format!("http://{}", server.http_addr().unwrap())
        .parse()
        .unwrap();
    (server, url)
}

pub fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nfx-node-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}
