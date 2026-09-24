//! Seed, fetch, tamper and gossip, in one process against a self-hosted relay (the same
//! code as the `iroh-relay` binary). The fetcher has no IP transports, so every byte it
//! receives crosses the relay. Content: the NFX test-vector video (`spec/test-vectors/`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use common::{relay, tmp, vector_store};
use iroh::address_lookup::MemoryLookup;
use iroh_blobs::api::blobs::AddBytesOptions;
use iroh_blobs::api::proto::BlobStatus;
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, HashAndFormat};
use nfx_node::NodeError;
use nfx_node::fetch::Anchor;
use nfx_node::gossip::envelope_wire;
use nfx_node::node::{Node, NodeConfig};
use nfx_node::store::{ContentStore, FsStore};
use nfx_node::video::rendition_members;
use nfx_proto::beacon::{BeaconContent, Chunks};
use nfx_proto::event::public_key_hex;
use nfx_proto::gossip::{Envelope, Op};

#[tokio::test(flavor = "multi_thread")]
async fn seed_fetch_tamper_and_gossip_over_a_self_hosted_relay() {
    let (_relay, url) = relay().await;
    let (seed_store, v) = vector_store(&tmp("seed"));
    let video = v.manifest.addr.clone();
    let segs = v.manifest.segs;

    // Seeder: normal endpoint on the relay.
    let seeder = Node::spawn(NodeConfig {
        relays: vec![url.clone()],
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    seeder.online(Duration::from_secs(10)).await.unwrap();
    let seeded = seeder
        .seed(&seed_store, &v.manifest.root_hex(), &video, segs)
        .await
        .unwrap();
    assert_eq!(seeded.renditions.keys().collect::<Vec<_>>(), ["720p"]);

    // Fetcher: relay-only, learns the seeder's address from the ticket.
    let lookup = MemoryLookup::new();
    lookup.add_endpoint_info(seeder.addr());
    let fetcher = Node::spawn(NodeConfig {
        relays: vec![url.clone()],
        relay_only: true,
        lookup: Some(lookup),
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    fetcher.online(Duration::from_secs(10)).await.unwrap();
    let dest = FsStore::open(tmp("dest")).unwrap();
    let anchor = Anchor {
        root: &seeded.root,
        video: &video,
        segs,
    };
    // Tickets travel as strings in beacons: round-trip them.
    let meta: BlobTicket = seeded.meta.to_string().parse().unwrap();
    let r720: BlobTicket = seeded.renditions["720p"].to_string().parse().unwrap();
    let list = fetcher
        .fetch(&anchor, &meta, &[("720p".into(), r720.clone())], &dest)
        .await
        .unwrap();
    assert_eq!(list, v.list);
    for f in &v.list.files {
        assert!(dest.has(&f.sha256), "{} fetched", f.name);
        dest.get(&f.sha256).unwrap(); // re-verified on read
    }

    // A lying seeder: same playlist, but segment 1's bytes are flipped. iroh's BLAKE3 is
    // consistent with the lie; the sha256 re-anchor is not.
    let liar = Node::spawn(NodeConfig {
        relays: vec![url.clone()],
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    liar.online(Duration::from_secs(10)).await.unwrap();
    let playlist = v.list.files.iter().find(|f| f.name == "r720.m3u8").unwrap();
    let members = rendition_members(&v.list, &seed_store.get(&playlist.sha256).unwrap()).unwrap();
    let mut hashes = Vec::new();
    for (i, sha) in members.iter().enumerate() {
        let mut bytes = seed_store.get(sha).unwrap();
        if i == 2 {
            bytes[0] ^= 1;
        }
        hashes.push(liar.blobs().add_bytes(bytes).await.unwrap().hash);
    }
    let seq: HashSeq = hashes.iter().copied().collect();
    let seq_hash = liar
        .blobs()
        .add_bytes_with_opts(AddBytesOptions {
            data: seq.into_inner(),
            format: BlobFormat::HashSeq,
        })
        .await
        .unwrap()
        .hash;
    liar.blobs()
        .tags()
        .create(HashAndFormat::hash_seq(seq_hash))
        .await
        .unwrap();
    let bad_ticket = BlobTicket::new(liar.addr(), seq_hash, BlobFormat::HashSeq);
    let clean = FsStore::open(tmp("clean")).unwrap();
    let lookup2 = MemoryLookup::new();
    lookup2.add_endpoint_info(seeder.addr());
    lookup2.add_endpoint_info(liar.addr());
    let victim = Node::spawn(NodeConfig {
        relays: vec![url.clone()],
        relay_only: true,
        lookup: Some(lookup2),
        ..NodeConfig::default()
    })
    .await
    .unwrap();
    victim.online(Duration::from_secs(10)).await.unwrap();
    let err = victim
        .fetch(&anchor, &meta, &[("720p".into(), bad_ticket)], &clean)
        .await
        .unwrap_err();
    match &err {
        NodeError::Poisoned { what, expected, .. } => {
            assert_eq!(what, "720p member 2");
            assert_eq!(expected, &members[2]);
        }
        other => panic!("expected Poisoned, got {other}"),
    }
    // Members that verified before the lie may be stored (they are the right bytes);
    // the poisoned one never is, and everything stored re-verifies.
    assert!(
        !clean.has(&members[2]),
        "the poisoned member is never stored"
    );
    for sha in &members {
        if clean.has(sha) {
            clean.get(sha).unwrap();
        }
    }

    // A bloated seeder: member 2 is 5 MiB where the hash list says 27 bytes. The fetcher
    // asks for at most the listed size, so the blob never completes and is refused: a
    // lying beacon wastes time, not bytes (NFX-06 §2).
    let mut hashes = Vec::new();
    for (i, sha) in members.iter().enumerate() {
        let bytes = if i == 2 {
            vec![0u8; 5 << 20]
        } else {
            seed_store.get(sha).unwrap()
        };
        hashes.push(liar.blobs().add_bytes(bytes).await.unwrap().hash);
    }
    let big = hashes[2];
    let seq: HashSeq = hashes.iter().copied().collect();
    let seq_hash = liar
        .blobs()
        .add_bytes_with_opts(AddBytesOptions {
            data: seq.into_inner(),
            format: BlobFormat::HashSeq,
        })
        .await
        .unwrap()
        .hash;
    let bloated = BlobTicket::new(liar.addr(), seq_hash, BlobFormat::HashSeq);
    let err = victim
        .fetch(&anchor, &meta, &[("720p".into(), bloated)], &clean)
        .await
        .unwrap_err();
    assert!(matches!(err, NodeError::Collection(_)), "{err}");
    let status = victim.blobs().status(big).await.unwrap();
    assert!(
        !matches!(status, BlobStatus::Complete { .. }),
        "the oversized member was never downloaded whole: {status:?}"
    );
    assert!(!clean.has(&members[2]));

    // Gossip: the fetcher joins the video's swarm via the seeder; the seeder announces a
    // signed envelope carrying its real tickets.
    let mut seeder_swarm = seeder.join_swarm(&video, vec![]).await.unwrap();
    let mut fetcher_swarm = fetcher.join_swarm(&video, vec![seeder.id()]).await.unwrap();
    tokio::time::timeout(Duration::from_secs(15), fetcher_swarm.joined())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(15), seeder_swarm.joined())
        .await
        .unwrap()
        .unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let envelope = Envelope {
        op: Op::Here,
        pubkey: public_key_hex(&v.seeder_secret).unwrap(),
        beacon: BeaconContent {
            v: 1,
            video: video.clone(),
            endpoints: vec![seeder.beacon_endpoint(&seeded)],
            skipped: vec![],
            chunks: Chunks::All,
            price_hint: 0,
            accepts_mints: vec![],
            free: true,
        },
        created_at: now,
    };
    seeder_swarm
        .announce(&envelope_wire(&envelope, &v.seeder_secret).unwrap())
        .await
        .unwrap();
    let got = tokio::time::timeout(Duration::from_secs(15), fetcher_swarm.next_envelope(now))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got, envelope);
    assert_eq!(fetcher_swarm.rejected, 0);

    for n in [seeder, fetcher, liar, victim] {
        n.shutdown().await.unwrap();
    }
}
