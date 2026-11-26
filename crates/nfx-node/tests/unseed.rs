//! A seeded video's iroh-blobs tags are named after its root: seeding it again replaces them
//! rather than adding more, nothing else is tagged for good, and `unseed` drops them all, so
//! garbage collection can free what the video held.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use common::{tmp, vector_store};
use n0_future::StreamExt as _;
use nfx_node::node::{Node, NodeConfig};
use nfx_node::seed::tag_prefix;

async fn tag_names(node: &Node) -> Vec<String> {
    let mut tags = node.blobs().tags().list().await.unwrap();
    let mut names = Vec::new();
    while let Some(tag) = tags.next().await {
        names.push(String::from_utf8_lossy(tag.unwrap().name.as_ref()).into_owned());
    }
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seeded_video_is_tagged_by_its_root_and_unseed_lets_it_go() {
    let dir = tmp("unseed");
    let (store, v) = vector_store(&dir.join("store"));
    let root = v.manifest.root_hex();
    std::fs::create_dir_all(dir.join("blobs")).unwrap();
    let node = Node::spawn(NodeConfig {
        blobs_dir: Some(dir.join("blobs")),
        no_portmapper: true,
        ..NodeConfig::default()
    })
    .await
    .unwrap();

    let seeded = node
        .seed(&store, &root, &v.manifest.addr, v.manifest.segs)
        .await
        .unwrap();
    let prefix = tag_prefix(&root);
    let want: Vec<String> = std::iter::once(format!("{prefix}meta"))
        .chain(seeded.renditions.keys().map(|id| format!("{prefix}r/{id}")))
        .collect();
    assert_eq!(tag_names(&node).await, want, "one tag per collection");

    // Seeding again (a restart) replaces the tags.
    node.seed(&store, &root, &v.manifest.addr, v.manifest.segs)
        .await
        .unwrap();
    assert_eq!(tag_names(&node).await, want, "no tag added");

    assert_eq!(node.unseed(&root).await.unwrap(), want.len() as u64);
    assert!(tag_names(&node).await.is_empty());
    assert_eq!(node.unseed(&root).await.unwrap(), 0, "harmless twice");
    assert!(node.unseed("../not-a-root").await.is_err());
    // The store's files are the caller's: unseeding leaves them.
    assert!(nfx_node::store::ContentStore::has(&store, &root));

    let _ = node.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}
