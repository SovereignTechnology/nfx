//! Spike S1 (ADR 0008, A1): can iroh 1.2 + iroh-blobs 0.103 + iroh-gossip 0.101 do what
//! NFX-06 needs? One process, one self-hosted relay. Every fetcher is built with
//! `clear_ip_transports()`, so all of its traffic must go through that relay.
//!
//! Pass criteria (plan, A1/S1), each printed as PASS/FAIL:
//!   1. serve a per-rendition HashSeq plus the `meta` collection
//!   2. fetch by ticket and re-anchor every file to the signed sha256 hash list
//!   3. per-request intercept refuses/holds requests (the M2 window gate)
//!   4. `nfx/pay/1` works on the same endpoint and correlates with blob requests
//!   5. gossip on the video's topic under ALPN `nfx/gossip/1`
//!   6. the self-hosted relay carries all of it
//!
//! Plus: a tampered segment passes iroh's BLAKE3 check but fails sha256 re-anchoring.

use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail, ensure};
use base64::Engine as _;
use iroh::address_lookup::MemoryLookup;
use iroh::endpoint::{Connection, presets};
use iroh::protocol::{AcceptError, ProtocolHandler, Router};
use iroh::{Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl};
use iroh_blobs::api::blobs::AddBytesOptions;
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::provider::events::{
    AbortReason, ConnectMode, EventMask, EventSender, ProviderMessage, RequestMode,
};
use iroh_blobs::store::mem::MemStore;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, BlobsProtocol, Hash, HashAndFormat};
use iroh_gossip::api::Event;
use iroh_gossip::{Gossip, TopicId};
use n0_future::StreamExt;
use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint as BeaconEndpoint};
use nfx_proto::event::Event as NostrEvent;
use nfx_proto::gossip::{Envelope, Op};
use nfx_proto::hashlist::{HashList, Role, verify_file};
use nfx_proto::manifest::Manifest;
use nfx_proto::sha256;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Notify;

const PAY_ALPN: &[u8] = b"nfx/pay/1";
const GOSSIP_ALPN: &[u8] = b"nfx/gossip/1";
const WINDOW: u64 = 2;

// ---------------------------------------------------------------- the test-vector video

struct Video {
    manifest: Manifest,
    list: HashList,
    hashlist_bytes: Vec<u8>,
    /// sha256 hex -> bytes, for every file in the hash list.
    files: HashMap<String, Vec<u8>>,
    seeder_secret: [u8; 32],
}

fn load_video() -> Result<Video> {
    let manifest_v: serde_json::Value =
        serde_json::from_str(include_str!("../../../../spec/test-vectors/manifest.json"))?;
    let event: NostrEvent = serde_json::from_value(manifest_v["event"].clone())?;
    let manifest = Manifest::from_event(&event)?;
    let hl: serde_json::Value =
        serde_json::from_str(include_str!("../../../../spec/test-vectors/hashlist.json"))?;
    let list: HashList = serde_json::from_value(hl["hashlist"].clone())?;
    let hashlist_bytes = list.render();
    ensure!(
        sha256(&hashlist_bytes) == manifest.root,
        "vector hash list does not match root"
    );

    let mut files = HashMap::new();
    for b64 in hl["fabricated"].as_object().context("fabricated")?.values() {
        let bytes =
            base64::engine::general_purpose::STANDARD.decode(b64.as_str().context("b64")?)?;
        files.insert(hex::encode(sha256(&bytes)), bytes);
    }
    for text in hl["playlists"].as_object().context("playlists")?.values() {
        let bytes = text.as_str().context("playlist")?.as_bytes().to_vec();
        files.insert(hex::encode(sha256(&bytes)), bytes);
    }
    for f in &list.files {
        ensure!(
            files.contains_key(&f.sha256),
            "missing bytes for {}",
            f.name
        );
    }
    let mut seeder_secret = [0u8; 32];
    hex::decode_to_slice(
        manifest_v["secret_keys_DO_NOT_USE"]["seeder"]
            .as_str()
            .context("seeder key")?,
        &mut seeder_secret,
    )?;
    Ok(Video {
        manifest,
        list,
        hashlist_bytes,
        files,
        seeder_secret,
    })
}

impl Video {
    fn bytes_of(&self, role: Role) -> Vec<(String, Vec<u8>)> {
        self.list
            .files
            .iter()
            .filter(|f| f.role == role)
            .map(|f| (f.sha256.clone(), self.files[&f.sha256].clone()))
            .collect()
    }
}

// ---------------------------------------------------------------- the window gate

#[derive(Default)]
struct GateState {
    conns: HashMap<u64, EndpointId>,
    served: HashMap<EndpointId, u64>,
    paid: HashMap<EndpointId, u64>,
    banned: HashSet<EndpointId>,
    free: HashSet<EndpointId>,
    media: HashSet<Hash>,
    rendition_seqs: HashSet<Hash>,
    held: u64,
    refused: u64,
}

#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    paid_changed: Notify,
}

impl Gate {
    /// NFX-07 window rule at the blob layer: chunk n (1-based, per endpoint) is served
    /// only while n <= paid + WINDOW; otherwise the request is held until a pay arrives,
    /// and refused as RateLimited after 10 s. Bulk rendition HashSeq requests are
    /// refused unless the peer is a free seeder; metadata is always free.
    async fn decide(&self, conn: u64, hash: Hash, only_root: bool) -> Result<(), AbortReason> {
        let (id, is_media, is_seq, free) = {
            let s = self.state.lock().unwrap();
            let Some(id) = s.conns.get(&conn).copied() else {
                return Err(AbortReason::Permission);
            };
            (
                id,
                s.media.contains(&hash),
                s.rendition_seqs.contains(&hash),
                s.free.contains(&id),
            )
        };
        if free || (!is_media && !is_seq) || (is_seq && only_root) {
            return Ok(());
        }
        if is_seq {
            self.state.lock().unwrap().refused += 1;
            return Err(AbortReason::Permission);
        }
        let n = {
            let mut s = self.state.lock().unwrap();
            let served = s.served.entry(id).or_default();
            *served += 1;
            *served
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut counted_hold = false;
        loop {
            let notified = self.paid_changed.notified();
            let paid = self
                .state
                .lock()
                .unwrap()
                .paid
                .get(&id)
                .copied()
                .unwrap_or(0);
            if n <= paid + WINDOW {
                return Ok(());
            }
            if !counted_hold {
                self.state.lock().unwrap().held += 1;
                counted_hold = true;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(AbortReason::RateLimited);
            }
        }
    }

    fn pay(&self, id: EndpointId, upto: u64) -> Result<u64, &'static str> {
        let mut s = self.state.lock().unwrap();
        let paid = s.paid.entry(id).or_default();
        if upto <= *paid {
            return Err("stale");
        }
        *paid = upto;
        drop(s);
        self.paid_changed.notify_waiters();
        Ok(upto)
    }
}

fn gate_events(gate: Arc<Gate>) -> EventSender {
    let mask = EventMask {
        connected: ConnectMode::Intercept,
        get: RequestMode::Intercept,
        ..EventMask::DEFAULT
    };
    let (tx, mut rx) = EventSender::channel(64, mask);
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                ProviderMessage::ClientConnected(msg) => {
                    let res = match msg.endpoint_id {
                        Some(id) if !gate.state.lock().unwrap().banned.contains(&id) => {
                            gate.state
                                .lock()
                                .unwrap()
                                .conns
                                .insert(msg.connection_id, id);
                            Ok(())
                        }
                        _ => {
                            gate.state.lock().unwrap().refused += 1;
                            Err(AbortReason::Permission)
                        }
                    };
                    msg.tx.send(res).await.ok();
                }
                ProviderMessage::GetRequestReceived(msg) => {
                    let gate = gate.clone();
                    tokio::spawn(async move {
                        let res = gate
                            .decide(
                                msg.connection_id,
                                msg.request.hash,
                                msg.request.ranges.is_blob(),
                            )
                            .await;
                        msg.tx.send(res).await.ok();
                    });
                }
                _ => {}
            }
        }
    });
    tx
}

// ---------------------------------------------------------------- pay/1 on the same endpoint

#[derive(Debug, Clone)]
struct PayProtocol {
    gate: Arc<Gate>,
}

impl std::fmt::Debug for Gate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Gate")
    }
}

impl ProtocolHandler for PayProtocol {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let peer = conn.remote_id();
        let (mut send, recv) = conn.accept_bi().await.map_err(AcceptError::from_err)?;
        let mut lines = BufReader::new(recv).lines();
        while let Some(line) = lines.next_line().await? {
            let msg: serde_json::Value =
                serde_json::from_str(&line).map_err(AcceptError::from_err)?;
            let reply = match msg["t"].as_str() {
                Some("hello") => serde_json::json!({
                    "t": "quote", "price_per_chunk": 1,
                    "mints": ["https://mint.example"], "window": WINDOW,
                }),
                Some("pay") => match self.gate.pay(peer, msg["upto_chunk"].as_u64().unwrap_or(0)) {
                    Ok(upto) => {
                        serde_json::json!({"t": "ack", "accepted_upto": upto, "spent_total": upto})
                    }
                    Err(code) => serde_json::json!({"t": "rej", "code": code, "detail": "spike"}),
                },
                _ => serde_json::json!({"t": "rej", "code": "stale", "detail": "unknown message"}),
            };
            send.write_all(format!("{reply}\n").as_bytes())
                .await
                .map_err(AcceptError::from_err)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- nodes

async fn spawn_relay() -> Result<(iroh_relay::server::Server, RelayUrl)> {
    use iroh_relay::server::{RelayConfig, Server, ServerConfig};
    let mut config = ServerConfig::default();
    config.relay = Some(RelayConfig::new((Ipv4Addr::LOCALHOST, 0)));
    let server = Server::spawn(config).await?;
    let url: RelayUrl =
        format!("http://{}", server.http_addr().context("relay http addr")?).parse()?;
    Ok((server, url))
}

struct Peer {
    store: MemStore,
    router: Router,
    gossip: Gossip,
}

async fn peer(
    relay: &RelayMap,
    lookup: Option<&MemoryLookup>,
    relay_only: bool,
    events: Option<EventSender>,
    pay: Option<PayProtocol>,
) -> Result<Peer> {
    let mut builder =
        Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Custom(relay.clone()));
    if relay_only {
        builder = builder.clear_ip_transports();
    }
    if let Some(lookup) = lookup {
        builder = builder.address_lookup(lookup.clone());
    }
    let endpoint = builder.bind().await?;
    tokio::time::timeout(Duration::from_secs(10), endpoint.online())
        .await
        .context("endpoint never reached the self-hosted relay")?;
    let store = MemStore::new();
    let gossip = Gossip::builder().alpn(GOSSIP_ALPN).spawn(endpoint.clone());
    let mut router = Router::builder(endpoint)
        .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store, events))
        .accept(GOSSIP_ALPN, gossip.clone());
    if let Some(pay) = pay {
        router = router.accept(PAY_ALPN, pay);
    }
    Ok(Peer {
        store,
        router: router.spawn(),
        gossip,
    })
}

impl Peer {
    fn id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    fn relay_addr(&self, relay: &RelayUrl) -> EndpointAddr {
        EndpointAddr::new(self.id()).with_relay_url(relay.clone())
    }

    async fn add(&self, bytes: Vec<u8>) -> Result<Hash> {
        Ok(self.store.add_bytes(bytes).await?.hash)
    }

    /// Store a raw HashSeq (NFX-06 §2: no names, no metadata blob) and keep it alive.
    async fn add_seq(&self, members: &[Hash]) -> Result<Hash> {
        let seq: HashSeq = members.iter().copied().collect();
        let tag = self
            .store
            .add_bytes_with_opts(AddBytesOptions {
                data: seq.into_inner(),
                format: BlobFormat::HashSeq,
            })
            .await?;
        self.store
            .tags()
            .create(HashAndFormat::hash_seq(tag.hash))
            .await?;
        Ok(tag.hash)
    }

    async fn fetch(&self, addr: &EndpointAddr, content: HashAndFormat) -> Result<Duration> {
        let t = Instant::now();
        let conn = self
            .router
            .endpoint()
            .connect(addr.clone(), iroh_blobs::ALPN)
            .await?;
        self.store.remote().fetch(conn, content).await?;
        Ok(t.elapsed())
    }

    /// The HashSeq's member hashes, from the local store.
    async fn seq_members(&self, seq: Hash) -> Result<Vec<Hash>> {
        let bytes = self.store.get_bytes(seq).await?;
        let seq = HashSeq::try_from(bytes)?;
        Ok(seq.iter().collect())
    }

    /// Re-anchor: every member's bytes must hash (sha256) to the expected hash-list entry, in order.
    async fn reanchor(&self, members: &[Hash], expected_sha256: &[String]) -> Result<()> {
        ensure!(
            members.len() == expected_sha256.len(),
            "member count {} != {}",
            members.len(),
            expected_sha256.len()
        );
        for (i, (h, want)) in members.iter().zip(expected_sha256).enumerate() {
            let bytes = self.store.get_bytes(*h).await?;
            verify_file(want, &bytes).map_err(|e| anyhow!("member {i}: {e}"))?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- the run

fn report(results: &mut Vec<(String, bool, String)>, name: &str, r: Result<String>) {
    match r {
        Ok(detail) => results.push((name.into(), true, detail)),
        Err(e) => results.push((name.into(), false, format!("{e:#}"))),
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[tokio::main]
async fn main() -> Result<()> {
    let video = load_video()?;
    let mut results = Vec::new();

    let (relay_server, relay_url) = spawn_relay().await?;
    let relay_map: RelayMap = relay_url.clone().into();
    println!("self-hosted relay: {relay_url}");

    // Provider A: normal endpoint (IP + relay), gate + pay/1 + gossip on one endpoint.
    let gate = Arc::new(Gate::default());
    let a = peer(
        &relay_map,
        None,
        false,
        Some(gate_events(gate.clone())),
        Some(PayProtocol { gate: gate.clone() }),
    )
    .await?;
    let a_addr = a.relay_addr(&relay_url);

    // Per-rendition HashSeq: init then segments in hash-list order. Meta: hash list, then playlists.
    let inits = video.bytes_of(Role::Init);
    let segs = video.bytes_of(Role::Segment);
    let media: Vec<(String, Vec<u8>)> = inits.into_iter().chain(segs).collect();
    let mut media_hashes = Vec::new();
    for (_, bytes) in &media {
        media_hashes.push(a.add(bytes.clone()).await?);
    }
    let rendition = a.add_seq(&media_hashes).await?;
    let mut meta_members = vec![a.add(video.hashlist_bytes.clone()).await?];
    let mut meta_sha = vec![video.manifest.root_hex()];
    for f in video
        .list
        .files
        .iter()
        .filter(|f| matches!(f.role, Role::PlaylistMaster | Role::Playlist))
    {
        meta_members.push(a.add(video.files[&f.sha256].clone()).await?);
        meta_sha.push(f.sha256.clone());
    }
    let meta = a.add_seq(&meta_members).await?;
    // A tampered rendition: segment 1's bytes flipped. iroh will happily serve it.
    let mut tampered_hashes = media_hashes.clone();
    let mut bad = media[2].1.clone();
    bad[0] ^= 1;
    tampered_hashes[2] = a.add(bad).await?;
    let tampered = a.add_seq(&tampered_hashes).await?;
    {
        let mut s = gate.state.lock().unwrap();
        s.media.extend(
            media_hashes
                .iter()
                .copied()
                .chain(tampered_hashes.iter().copied()),
        );
        s.rendition_seqs.extend([rendition, tampered]);
    }
    let media_sha: Vec<String> = media.iter().map(|(sha, _)| sha.clone()).collect();

    let t_rendition = BlobTicket::new(a_addr.clone(), rendition, BlobFormat::HashSeq);
    let t_meta = BlobTicket::new(a_addr.clone(), meta, BlobFormat::HashSeq);
    let t_tampered = BlobTicket::new(a_addr.clone(), tampered, BlobFormat::HashSeq);
    println!(
        "provider {}  (EndpointId renders as {} hex chars)",
        a.id(),
        a.id().to_string().len()
    );
    println!(
        "rendition ticket: {} chars  prefix {}",
        t_rendition.to_string().len(),
        &t_rendition.to_string()[..24]
    );
    println!("meta ticket:      {} chars", t_meta.to_string().len());
    report(
        &mut results,
        "1 serve rendition HashSeq + meta collection",
        Ok(format!(
            "rendition = {} members (init + {} segments), meta = {} members (hash list + {} playlists)",
            media_hashes.len(),
            media_hashes.len() - 1,
            meta_members.len(),
            meta_members.len() - 1
        )),
    );

    // Mirror D (free seeder): relay-only, fetches both collections whole, by ticket string.
    let lookup = MemoryLookup::new();
    lookup.add_endpoint_info(a_addr.clone());
    let d = peer(&relay_map, Some(&lookup), true, None, None).await?;
    gate.state.lock().unwrap().free.insert(d.id());
    let r = async {
        let meta_ticket: BlobTicket = t_meta.to_string().parse()?;
        let dt_meta = d.fetch(meta_ticket.addr(), HashAndFormat::hash_seq(meta_ticket.hash())).await?;
        let members = d.seq_members(meta_ticket.hash()).await?;
        d.reanchor(&members, &meta_sha).await?;
        let list_bytes = d.store.get_bytes(members[0]).await?;
        let list = HashList::verify_for(&list_bytes, &video.manifest)?;
        for m in &members[1..] {
            list.check_playlist(&d.store.get_bytes(*m).await?)?;
        }
        let ticket: BlobTicket = t_rendition.to_string().parse()?;
        let dt = d.fetch(ticket.addr(), HashAndFormat::hash_seq(ticket.hash())).await?;
        let members = d.seq_members(ticket.hash()).await?;
        d.reanchor(&members, &media_sha).await?;
        Ok(format!("meta {dt_meta:?}, rendition {dt:?} over the relay; hash list verified against the manifest root; every member re-anchored to sha256 in order"))
    }
    .await;
    report(&mut results, "2 fetch by ticket + re-anchor to sha256", r);

    let r = async {
        let ticket: BlobTicket = t_tampered.to_string().parse()?;
        d.fetch(ticket.addr(), HashAndFormat::hash_seq(ticket.hash()))
            .await?;
        let members = d.seq_members(ticket.hash()).await?;
        match d.reanchor(&members, &media_sha).await {
            Err(e) => Ok(format!(
                "iroh BLAKE3 transfer succeeded, sha256 re-anchor rejected it: {e}"
            )),
            Ok(()) => bail!("tampered rendition was accepted"),
        }
    }
    .await;
    report(&mut results, "+ tampered segment rejected on iroh", r);

    // Watcher B (paying): relay-only, fetches chunk by chunk; the gate holds chunk 3.
    let b = peer(&relay_map, Some(&lookup), true, None, None).await?;
    let r = async {
        // Bulk rendition fetch is refused for a paying (non-free) peer.
        let bulk = b.fetch(&a_addr, HashAndFormat::hash_seq(rendition)).await;
        ensure!(bulk.is_err(), "bulk rendition fetch should be refused for a paying peer");
        // The HashSeq blob alone (the member list) is free.
        b.fetch(&a_addr, HashAndFormat::raw(rendition)).await?;
        let members = b.seq_members(rendition).await?;
        ensure!(members == media_hashes);

        // pay/1 on the same endpoint.
        let pay_conn = b.router.endpoint().connect(a_addr.clone(), PAY_ALPN).await?;
        let (mut send, recv) = pay_conn.open_bi().await?;
        let mut lines = BufReader::new(recv).lines();
        send.write_all(b"{\"t\":\"hello\",\"video\":\"nfx:mainnet:1:salt-flats-dusk\",\"session\":\"00112233445566778899aabbccddeeff\"}\n").await?;
        let quote: serde_json::Value = serde_json::from_str(&lines.next_line().await?.context("quote")?)?;
        ensure!(quote["t"] == "quote" && quote["window"] == WINDOW, "bad quote {quote}");

        b.fetch(&a_addr, HashAndFormat::raw(members[0])).await?; // chunk 1
        b.fetch(&a_addr, HashAndFormat::raw(members[1])).await?; // chunk 2
        let third = {
            let b_store = b.store.clone();
            let ep = b.router.endpoint().clone();
            let (addr, h) = (a_addr.clone(), members[2]);
            tokio::spawn(async move {
                let conn = ep.connect(addr, iroh_blobs::ALPN).await?;
                b_store.remote().fetch(conn, HashAndFormat::raw(h)).await?;
                anyhow::Ok(())
            })
        };
        tokio::time::sleep(Duration::from_millis(1500)).await;
        ensure!(!third.is_finished(), "chunk 3 was served without payment");
        let held = gate.state.lock().unwrap().held;
        send.write_all(b"{\"t\":\"pay\",\"upto_chunk\":2,\"token\":\"spike-no-ecash\"}\n").await?;
        let ack: serde_json::Value = serde_json::from_str(&lines.next_line().await?.context("ack")?)?;
        ensure!(ack["t"] == "ack" && ack["accepted_upto"] == 2, "bad ack {ack}");
        tokio::time::timeout(Duration::from_secs(5), third).await.context("chunk 3 never released")???;
        b.fetch(&a_addr, HashAndFormat::raw(members[3])).await?; // chunk 4: 4 <= 2 + WINDOW
        send.write_all(b"{\"t\":\"pay\",\"upto_chunk\":2,\"token\":\"spike-no-ecash\"}\n").await?;
        let rej: serde_json::Value = serde_json::from_str(&lines.next_line().await?.context("rej")?)?;
        ensure!(rej["code"] == "stale", "replayed pay should be stale, got {rej}");
        b.reanchor(&members, &media_sha).await?;
        Ok(format!(
            "bulk HashSeq refused; chunks 1-2 served unpaid (window {WINDOW}); chunk 3 held {held}x until `pay upto 2` over nfx/pay/1, then released; chunk 4 served; replayed pay -> stale; all 4 re-anchored"
        ))
    }
    .await;
    report(
        &mut results,
        "3+4 window gate via intercept + pay/1 on same endpoint",
        r,
    );

    // Banned peer C: refused at connection time.
    let c = peer(&relay_map, Some(&lookup), true, None, None).await?;
    gate.state.lock().unwrap().banned.insert(c.id());
    let r = async {
        match c.fetch(&a_addr, HashAndFormat::raw(meta)).await {
            Err(e) => Ok(format!("refused: {e:#}")),
            Ok(_) => bail!("banned peer was served"),
        }
    }
    .await;
    report(
        &mut results,
        "3b banned peer refused (ClientConnected intercept)",
        r,
    );

    // Gossip: B joins the video's topic via A over the relay; A broadcasts a signed envelope.
    let topic = TopicId::from_bytes(video.manifest.addr.swarm_topic());
    let r = async {
        let content = BeaconContent {
            v: 1,
            video: video.manifest.addr.clone(),
            endpoints: vec![BeaconEndpoint::Iroh {
                node: a.id().to_string(),
                relay: relay_url.to_string(),
                addrs: vec![],
                tickets: [("720p".to_string(), t_rendition.to_string()), ("meta".to_string(), t_meta.to_string())]
                    .into_iter()
                    .collect(),
            }],
            skipped: vec![],
            chunks: Chunks::All,
            price_hint: 1,
            accepts_mints: vec!["https://mint.example".into()],
            free: false,
        };
        let mut env = Envelope {
            op: Op::Here,
            pubkey: nfx_proto::event::public_key_hex(&video.seeder_secret)?,
            beacon: content,
            created_at: now(),
        };
        let sig = env.sign(&video.seeder_secret)?;
        let body: serde_json::Value = serde_json::from_str(&env.canon_body()?)?;
        let mut wire = body.as_object().unwrap().clone();
        wire.insert("sig".into(), sig.into());
        let wire = serde_json::to_string(&wire)?;

        let mut a_topic = a.gossip.subscribe(topic, vec![]).await?;
        let mut b_topic = b.gossip.subscribe_and_join(topic, vec![a.id()]).await?;
        tokio::time::timeout(Duration::from_secs(10), a_topic.joined()).await??;
        a_topic.broadcast(wire.clone().into_bytes().into()).await?;
        let received = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(ev) = b_topic.next().await {
                if let Event::Received(msg) = ev? {
                    return anyhow::Ok(msg);
                }
            }
            bail!("gossip stream ended")
        })
        .await??;
        let got = Envelope::verify(std::str::from_utf8(&received.content)?, &video.manifest.addr, now())?;
        env.created_at = got.created_at;
        ensure!(got == env, "envelope changed in transit");
        Ok(format!(
            "B joined topic {} via A over the relay; envelope ({} bytes on the wire, limit {}) verified by nfx-proto; delivered_from = {} (transport hop, not the author)",
            &hex::encode(video.manifest.addr.swarm_topic())[..12],
            wire.len(),
            b.gossip.max_message_size(),
            received.delivered_from.fmt_short()
        ))
    }
    .await;
    report(
        &mut results,
        "5 gossip on the video topic, ALPN nfx/gossip/1",
        r,
    );

    // Negative control for criterion 6: a relay-only peer that was online stops reaching A
    // the moment the relay goes away. If this fetch succeeded, "relay-only" would be a lie.
    let f = peer(&relay_map, Some(&lookup), true, None, None).await?;
    relay_server.shutdown().await?;
    let control = tokio::time::timeout(
        Duration::from_secs(15),
        f.fetch(&a_addr, HashAndFormat::raw(meta)),
    )
    .await;
    let all_ok = results.iter().all(|(_, ok, _)| *ok);
    let control_failed = !matches!(control, Ok(Ok(_)));
    results.push((
        "6 self-hosted relay carries everything".into(),
        all_ok && control_failed,
        format!(
            "fetchers B, C, D had no IP transports; control: with the relay shut down, a relay-only peer's fetch {}",
            match &control {
                Err(_) => "timed out (15 s)".to_string(),
                Ok(Err(e)) => format!("failed: {e:#}"),
                Ok(Ok(_)) => "SUCCEEDED (so something bypassed the relay)".to_string(),
            }
        ),
    ));
    f.router.shutdown().await.ok();

    println!();
    let mut failed = 0;
    for (name, ok, detail) in &results {
        println!(
            "{} {name}\n     {detail}",
            if *ok { "PASS" } else { "FAIL" }
        );
        failed += usize::from(!ok);
    }
    {
        let s = gate.state.lock().unwrap();
        println!(
            "\ngate: held={} refused={} served={:?}",
            s.held,
            s.refused,
            s.served.values().collect::<Vec<_>>()
        );
    }
    for p in [a, b, c, d] {
        p.router.shutdown().await.ok();
    }
    if failed > 0 {
        bail!("{failed} criteria failed");
    }
    Ok(())
}
