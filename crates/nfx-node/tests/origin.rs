//! The NFX-05 §6 origin: routes, headers and refusals over a local store, then a
//! pull-through origin that fills itself over iroh, skips a lying seeder, and serves
//! real HTTP.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use common::{relay, tmp, vector_store};
use http_body_util::{BodyExt, Empty};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::address_lookup::MemoryLookup;
use iroh_blobs::api::blobs::AddBytesOptions;
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, HashAndFormat};
use nfx_node::gossip::envelope_wire;
use nfx_node::node::{Node, NodeConfig};
use nfx_node::nostr::{sign_beacon, sign_manifest};
use nfx_node::origin::{IMMUTABLE, Origin, SwarmPull, serve};
use nfx_node::store::{ContentStore, FsStore};
use nfx_node::video::rendition_members;
use nfx_proto::Verified;
use nfx_proto::beacon::{Beacon, BeaconContent, Chunks, Endpoint};
use nfx_proto::event::public_key_hex;
use nfx_proto::gossip::{Envelope, Op};
use nfx_proto::hashlist::Role;
use nfx_proto::manifest::{Manifest, Thumb};

async fn call(origin: &Origin, method: Method, path: &str) -> (StatusCode, Response<()>, Bytes) {
    let (parts, body) = origin.respond(&method, path).await.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    let status = parts.status;
    (status, Response::from_parts(parts, ()), bytes)
}

fn header<'a>(r: &'a Response<()>, name: &str) -> &'a str {
    r.headers().get(name).map_or("", |v| v.to_str().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn routes_headers_and_refusals() {
    let (store, v) = vector_store(&tmp("origin-static"));
    let store = Arc::new(store);
    let origin = Origin::new(store.clone(), None);
    origin.hold(&v.manifest).await.unwrap();
    let root = v.manifest.root_hex();

    // The hash list, every listed file by content name, and the convenience URLs.
    let (status, r, body) = call(&origin, Method::GET, &format!("/{root}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&r, "content-type"), "application/json");
    assert_eq!(header(&r, "cache-control"), IMMUTABLE);
    assert_eq!(header(&r, "access-control-allow-origin"), "*");
    assert_eq!(header(&r, "x-content-type-options"), "nosniff");
    assert!(
        r.headers().get("vary").is_none(),
        "hits must not vary (§6.1)"
    );
    assert_eq!(body.as_ref(), v.list.render().as_slice());
    for f in &v.list.files {
        let ext = f.name.rsplit_once('.').unwrap().1;
        for path in [
            format!("/{}.{ext}", f.sha256),
            format!("/{}", f.sha256),
            format!("/{root}/{}.{ext}", f.sha256),
        ] {
            let (status, r, body) = call(&origin, Method::GET, &path).await;
            assert_eq!(status, StatusCode::OK, "{path}");
            assert_eq!(body.as_ref(), store.get(&f.sha256).unwrap().as_slice());
            let want = match f.role {
                Role::PlaylistMaster | Role::Playlist => "application/vnd.apple.mpegurl",
                Role::Init => "video/mp4",
                Role::Segment => "video/iso.segment",
                Role::Thumb => "image/jpeg",
                Role::Subtitle => "text/vtt; charset=utf-8",
            };
            assert_eq!(header(&r, "content-type"), want, "{}", f.name);
        }
    }
    let master = v
        .list
        .files
        .iter()
        .find(|f| f.role == Role::PlaylistMaster)
        .unwrap();
    let (status, _, body) = call(&origin, Method::GET, &format!("/{root}/master.m3u8")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_ref(), store.get(&master.sha256).unwrap().as_slice());

    // HEAD: same headers and length, no body.
    let seg = v
        .list
        .files
        .iter()
        .find(|f| f.role == Role::Segment)
        .unwrap();
    let (status, r, body) = call(&origin, Method::HEAD, &format!("/{}.m4s", seg.sha256)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&r, "content-length"), seg.size.to_string());
    assert!(body.is_empty());

    // Not an open proxy: a stored but unlisted blob is not served, nor is a listed file
    // under a root that does not list it.
    let stray = store.put(b"stored, never listed").unwrap();
    let other_root = "0".repeat(64);
    for path in [
        format!("/{stray}"),
        format!("/{root}/{stray}.m4s"),
        format!("/{other_root}/{}.m4s", seg.sha256),
        format!("/{other_root}/master.m3u8"),
        format!("/{}", seg.sha256.to_uppercase()),
        format!("/{}.M4S", seg.sha256),
        format!("/{}..m4s", seg.sha256),
        format!("/{}.m4s/", seg.sha256),
        format!("//{}.m4s", seg.sha256),
        format!("/%2e%2e/{}", seg.sha256),
        "/../etc/passwd".into(),
        "/".into(),
        String::new(),
    ] {
        let (status, r, _) = call(&origin, Method::GET, &path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path:?}");
        assert_eq!(
            header(&r, "cache-control"),
            "no-store",
            "errors are not content"
        );
    }

    // Methods.
    let (status, r, _) = call(&origin, Method::POST, &format!("/{root}")).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(header(&r, "allow"), "GET, HEAD, OPTIONS");
    let (status, r, _) = call(&origin, Method::OPTIONS, &format!("/{root}")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(header(&r, "access-control-allow-origin"), "*");

    // Query strings would make each variant a separate year-long CDN object.
    let (status, r, _) = call(&origin, Method::GET, &format!("/{}.m4s?x=1", seg.sha256)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(header(&r, "cache-control"), "no-store");

    // The extension is ignored for lookup, but a download keeps an honest name.
    let (status, r, _) = call(&origin, Method::GET, &format!("/{}.exe", seg.sha256)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header(&r, "content-disposition"),
        format!("inline; filename=\"{}.m4s\"", seg.sha256)
    );

    // A store file that rotted on disk is never served: it is dropped, and with no swarm
    // to pull from the origin says so (no-store).
    let path = store.path_of(&seg.sha256).unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] ^= 1;
    std::fs::write(&path, &bytes).unwrap();
    let (status, r, body) = call(&origin, Method::GET, &format!("/{}.m4s", seg.sha256)).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(header(&r, "cache-control"), "no-store");
    assert_ne!(body.as_ref(), bytes.as_slice());
    assert!(!store.has(&seg.sha256), "the rotted copy is removed");

    // A creator-chosen thumb MIME outside the allow-list is served as opaque bytes.
    let thumb = v.list.files.iter().find(|f| f.role == Role::Thumb).unwrap();
    let html_thumb = Manifest {
        thumb: Some(Thumb {
            sha256: thumb.sha256.clone(),
            mime: "text/html".into(),
        }),
        ..v.manifest.clone().into_inner()
    };
    // Signed, as `hold` only takes a verified manifest.
    let keys = nostr_sdk::prelude::Keys::generate();
    let (_, html_thumb) = sign_manifest(&keys, &html_thumb, nfx_node::unix_now())
        .await
        .unwrap();
    let (store2, _) = vector_store(&tmp("origin-thumb"));
    let origin2 = Origin::new(Arc::new(store2), None);
    origin2.hold(&html_thumb).await.unwrap();
    let (status, r, _) = call(&origin2, Method::GET, &format!("/{}.jpg", thumb.sha256)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&r, "content-type"), "application/octet-stream");
    assert!(header(&r, "content-security-policy").contains("sandbox"));
}

/// One request over a fresh HTTP/1.1 connection.
async fn http(
    addr: std::net::SocketAddr,
    method: Method,
    path: &str,
) -> (StatusCode, Response<()>, Bytes) {
    let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(conn);
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "origin.test")
        .body(Empty::<Bytes>::new())
        .unwrap();
    let (parts, body) = sender.send_request(req).await.unwrap().into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (parts.status, Response::from_parts(parts, ()), bytes)
}

/// A beacon for `manifest` signed by `seeder` at `at` (lifetime 60 s), verified at `at`.
async fn beacon_at(
    manifest: &Manifest,
    seeder: &nostr_sdk::prelude::Keys,
    endpoint: Endpoint,
    at: u64,
) -> Verified<Beacon> {
    let content = BeaconContent {
        v: 1,
        video: manifest.addr.clone(),
        endpoints: vec![endpoint],
        skipped: vec![],
        chunks: Chunks::All,
        price_hint: 0,
        accepts_mints: vec![],
        free: true,
    };
    let event = sign_beacon(seeder, &manifest.a_tag(), &content, at, 60)
        .await
        .unwrap();
    Beacon::from_event(&event, at).unwrap()
}

async fn beacon(
    manifest: &Manifest,
    seeder: &nostr_sdk::prelude::Keys,
    endpoint: Endpoint,
) -> Verified<Beacon> {
    beacon_at(manifest, seeder, endpoint, nfx_node::unix_now()).await
}

#[tokio::test(flavor = "multi_thread")]
async fn pull_through_skips_a_liar_and_serves_verified_bytes_over_http() {
    let (_relay, url) = relay().await;
    let (seed_store, v) = vector_store(&tmp("pt-seed"));
    let manifest = v.manifest.clone();
    let spawn = |relay_only: bool, lookup: Option<MemoryLookup>| {
        let url = url.clone();
        async move {
            let node = Node::spawn(NodeConfig {
                relays: vec![url],
                relay_only,
                lookup,
                ..NodeConfig::default()
            })
            .await
            .unwrap();
            node.online(Duration::from_secs(10)).await.unwrap();
            node
        }
    };

    let seeder = spawn(false, None).await;
    let seeded = seeder
        .seed(
            &seed_store,
            &manifest.root_hex(),
            &manifest.addr,
            manifest.segs,
        )
        .await
        .unwrap();

    // A liar: the honest meta ticket, but a 720p collection whose segment 1 is flipped.
    let liar = spawn(false, None).await;
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
    // The liar serves an honest meta collection of its own (NFX-06 §2: every ticket names
    // the endpoint's own node) and a lying rendition.
    let liar_seeded = liar
        .seed(
            &seed_store,
            &manifest.root_hex(),
            &manifest.addr,
            manifest.segs,
        )
        .await
        .unwrap();
    let liar_tickets = BTreeMap::from([
        ("meta".to_string(), liar_seeded.meta.to_string()),
        (
            "720p".to_string(),
            BlobTicket::new(liar.addr(), seq_hash, BlobFormat::HashSeq).to_string(),
        ),
    ]);

    // The origin's node is relay-only: every byte it pulls crosses the relay.
    let lookup = MemoryLookup::new();
    lookup.add_endpoint_info(seeder.addr());
    lookup.add_endpoint_info(liar.addr());
    let node = Arc::new(spawn(true, Some(lookup)).await);
    let pull = Arc::new(SwarmPull::new(node.clone()));
    // An unreachable seeder, learned first: it costs one failed dial, then waits on cooldown.
    let nowhere = iroh::EndpointAddr::new(iroh::SecretKey::from_bytes(&[7u8; 32]).public());
    let who: BTreeMap<&str, nostr_sdk::prelude::Keys> =
        ["unreachable", "liar", "honest", "borrowed", "stale"]
            .into_iter()
            .map(|n| (n, nostr_sdk::prelude::Keys::generate()))
            .collect();
    let pk = |n: &str| who[n].public_key().to_hex();
    pull.learn(
        &beacon(
            &manifest,
            &who["unreachable"],
            Endpoint::Iroh {
                node: nowhere.id.to_string(),
                relay: String::new(),
                addrs: vec![],
                tickets: BTreeMap::from([(
                    "meta".to_string(),
                    BlobTicket::new(nowhere, seeded.meta.hash(), BlobFormat::HashSeq).to_string(),
                )]),
            },
        )
        .await,
    );
    pull.learn(
        &beacon(
            &manifest,
            &who["liar"],
            Endpoint::Iroh {
                node: liar.id().to_string(),
                relay: String::new(),
                addrs: vec![],
                tickets: liar_tickets,
            },
        )
        .await,
    );
    pull.learn(&beacon(&manifest, &who["honest"], seeder.beacon_endpoint(&seeded)).await);
    assert_eq!(
        pull.sources(&manifest.a_tag()),
        [pk("unreachable"), pk("liar"), pk("honest")]
    );
    // An endpoint whose tickets name another node is ignored (NFX-06 §2).
    pull.learn(
        &beacon(
            &manifest,
            &who["borrowed"],
            Endpoint::Iroh {
                node: liar.id().to_string(),
                relay: String::new(),
                addrs: vec![],
                tickets: BTreeMap::from([("meta".to_string(), seeded.meta.to_string())]),
            },
        )
        .await,
    );
    assert_eq!(
        pull.sources(&manifest.a_tag()),
        [pk("unreachable"), pk("liar"), pk("honest")]
    );
    // An expired beacon is not a source.
    // Verified while it was fresh, learned after it lapsed.
    let stale = beacon_at(
        &manifest,
        &who["stale"],
        seeder.beacon_endpoint(&seeded),
        nfx_node::unix_now() - 120,
    )
    .await;
    pull.learn(&stale);
    assert_eq!(
        pull.sources(&manifest.a_tag()),
        [pk("unreachable"), pk("liar"), pk("honest")]
    );

    let store = Arc::new(FsStore::open(tmp("pt-origin")).unwrap());
    let origin = Arc::new(Origin::new(store.clone(), Some(pull.clone())));
    origin.hold(&manifest).await.unwrap(); // pulls the meta collection
    assert!(store.has(&manifest.root_hex()));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(serve(origin.clone(), listener));

    // Four concurrent misses for the rendition: one pull, the liar is tried first, caught
    // and forgotten, the honest seeder fills the store, and every response is verified.
    let segments: Vec<_> = v
        .list
        .files
        .iter()
        .filter(|f| matches!(f.role, Role::Segment | Role::Init))
        .cloned()
        .collect();
    let mut tasks = Vec::new();
    for f in segments.clone() {
        tasks.push(tokio::spawn(async move {
            let ext = f.name.rsplit_once('.').unwrap().1.to_owned();
            let got = http(addr, Method::GET, &format!("/{}.{ext}", f.sha256)).await;
            (f, got)
        }));
    }
    for task in tasks {
        let (f, (status, r, body)) = task.await.unwrap();
        assert_eq!(status, StatusCode::OK, "{}", f.name);
        assert_eq!(header(&r, "cache-control"), IMMUTABLE);
        assert_eq!(body.as_ref(), seed_store.get(&f.sha256).unwrap().as_slice());
    }
    assert_eq!(
        pull.sources(&manifest.a_tag()),
        [pk("honest"), pk("unreachable")],
        "the liar is forgotten; the unreachable seeder waits at the back"
    );

    // A stored copy that rots is dropped and pulled again from the swarm.
    let path = store.path_of(&segments[1].sha256).unwrap();
    std::fs::write(&path, b"rot").unwrap();
    let (status, _, body) = http(addr, Method::GET, &format!("/{}.m4s", segments[1].sha256)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.as_ref(),
        seed_store.get(&segments[1].sha256).unwrap().as_slice()
    );

    // HEAD over the wire keeps the length; unlisted is 404 no-store.
    let head_path = format!("/{}.m4s", segments[1].sha256);
    let (status, r, body) = http(addr, Method::HEAD, &head_path).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header(&r, "content-length"), segments[1].size.to_string());
    assert!(body.is_empty());
    let (status, r, _) = http(addr, Method::GET, &format!("/{}", "f".repeat(64))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(header(&r, "cache-control"), "no-store");

    server.abort();
    drop(origin);
    drop(pull);
    for n in [seeder, liar] {
        n.shutdown().await.unwrap();
    }
    Arc::try_unwrap(node)
        .ok()
        .unwrap()
        .shutdown()
        .await
        .unwrap();
}

/// An iroh endpoint whose one `meta` ticket names it (NFX-06 §2); nothing listens there.
fn idle_endpoint(seed: u8) -> Endpoint {
    let id = iroh::SecretKey::from_bytes(&[seed; 32]).public();
    let ticket = BlobTicket::new(
        iroh::EndpointAddr::new(id),
        iroh_blobs::Hash::new([seed]),
        BlobFormat::HashSeq,
    );
    Endpoint::Iroh {
        node: id.to_string(),
        relay: String::new(),
        addrs: vec![],
        tickets: BTreeMap::from([("meta".to_string(), ticket.to_string())]),
    }
}

/// A `here` from the swarm, signed with `secret`, as a pull source for `manifest`.
fn presence(manifest: &Manifest, secret: [u8; 32], endpoint: Endpoint) -> Verified<Beacon> {
    let now = nfx_node::unix_now();
    let env = Envelope {
        op: Op::Here,
        pubkey: public_key_hex(&secret).unwrap(),
        beacon: BeaconContent {
            v: 1,
            video: manifest.addr.clone(),
            endpoints: vec![endpoint],
            skipped: vec![],
            chunks: Chunks::All,
            price_hint: 0,
            accepts_mints: vec![],
            free: true,
        },
        created_at: now,
    };
    let wire = envelope_wire(&env, &secret).unwrap();
    Envelope::verify(&wire, &manifest.addr, now)
        .unwrap()
        .presence_for(&manifest.a_tag())
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn gossip_never_displaces_a_source_heard_from_a_relay() {
    let (_, v) = vector_store(&tmp("gossip-rank"));
    let manifest = v.manifest.clone();
    let a = manifest.a_tag();
    let node = Arc::new(Node::spawn(NodeConfig::default()).await.unwrap());
    let pull = SwarmPull::new(node.clone());

    // One seeder heard from a relay, then a flood of fresh gossip identities.
    let relayed = nostr_sdk::prelude::Keys::generate();
    pull.learn(&beacon(&manifest, &relayed, idle_endpoint(1)).await);
    for i in 0..20u8 {
        pull.learn_gossip(&presence(&manifest, [i + 10; 32], idle_endpoint(i + 10)));
    }
    let known = pull.sources(&a);
    assert_eq!(known.len(), nfx_node::origin::MAX_SOURCES_PER_VIDEO);
    assert!(
        known.contains(&relayed.public_key().to_hex()),
        "the relay's seeder stays"
    );

    // A table full of relay sources admits no gossip at all.
    let pull = SwarmPull::new(node.clone());
    for i in 0..nfx_node::origin::MAX_SOURCES_PER_VIDEO {
        let keys = nostr_sdk::prelude::Keys::generate();
        pull.learn(&beacon(&manifest, &keys, idle_endpoint(100 + i as u8)).await);
    }
    let before = pull.sources(&a);
    pull.learn_gossip(&presence(&manifest, [9; 32], idle_endpoint(9)));
    assert_eq!(pull.sources(&a), before);

    // Gossip about a seeder a relay later vouches for is promoted, not duplicated.
    let pull = SwarmPull::new(node.clone());
    let both = nostr_sdk::prelude::Keys::generate();
    let secret: [u8; 32] = both.secret_key().to_secret_bytes();
    pull.learn_gossip(&presence(&manifest, secret, idle_endpoint(2)));
    pull.learn(&beacon(&manifest, &both, idle_endpoint(2)).await);
    assert_eq!(pull.sources(&a), [both.public_key().to_hex()]);
    for i in 0..20u8 {
        pull.learn_gossip(&presence(&manifest, [i + 40; 32], idle_endpoint(i + 40)));
    }
    assert!(pull.sources(&a).contains(&both.public_key().to_hex()));
}
