//! The mesh endpoint end to end on loopback (NFX-10 §6, issue #71): an in-process Nostr relay
//! that carries kind 25050 (nostr-sdk's local relay; NFX-04's scoped relay carries it only
//! with mesh signaling on), the endpoint serving the test-vector video, and a browser-like
//! peer built from str0m (full ICE), nfx-proto's signaling and nostr-sdk. The peer finds the
//! endpoint by its room alone, negotiates through the relay (either side offering, by the
//! glare rule), opens the data
//! channel, asks for a segment with p2p-media-loader's protocol and checks its sha256. The
//! same behind a DNAT: the endpoint bound on loopback and told a public address, which the
//! peer alone reaches, through a DNAT in the test. Then two endpoints in one room, which find
//! and connect to each other the same way; and an endpoint with two STUN servers, one of which
//! lies about its mapping, which a browser still reaches. And the file channel (§§6.9-6.10):
//! a browser that holds only the manifest meets the endpoint in the video room and takes the
//! hash list, a `have` and the start-up files from it, never a segment; and on a stream-room
//! connection the endpoint, as offerer, opens the file channel after the first.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use n0_future::{Stream, StreamExt};
use nfx_node::mesh::{Mesh, MeshConfig, MeshStatus};
use nfx_node::p2pml::{self, Command, Reassembler};
use nfx_node::store::ContentStore;
use nfx_node::unix_now;
use nfx_proto::event::Event;
use nfx_proto::file_channel::{self as fc, Message};
use nfx_proto::hashlist::{HashList, Role};
use nfx_proto::namespace::VideoAddr;
use nfx_proto::signal::{self, Parsed, Received, Room, Session, Signal};
use nostr_sdk::prelude as ns;
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event as RtcEvent, Input, Output, Rtc};
use tokio::net::UdpSocket;

const WAIT: Duration = Duration::from_secs(60);

fn dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("nfx-mesh-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

async fn relay() -> (ns::LocalRelay, String) {
    let relay = ns::LocalRelay::builder()
        .rate_limit(ns::RateLimit {
            max_reqs: 500,
            notes_per_minute: 100_000,
        })
        .build();
    relay.run().await.unwrap();
    let url = relay.url().await.to_string();
    (relay, url)
}

fn config(url: &str) -> MeshConfig {
    MeshConfig {
        bind: "127.0.0.1:0".parse().unwrap(),
        ..MeshConfig::new(vec![url.to_owned()])
    }
}

async fn until(mesh: &Mesh, what: &str, ok: impl Fn(&MeshStatus) -> bool) -> MeshStatus {
    let deadline = Instant::now() + WAIT;
    loop {
        let s = mesh.status();
        if ok(&s) {
            return s;
        }
        assert!(Instant::now() < deadline, "{what}: {s:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The first segment of `rendition`, by its sha256 (the content name in the playlist).
fn first_segment(list: &HashList, store: &dyn ContentStore, rendition: &str) -> String {
    let r = list.renditions.iter().find(|r| r.id == rendition).unwrap();
    let file = list
        .files
        .iter()
        .find(|f| f.role == Role::Playlist && f.name == r.playlist)
        .unwrap();
    let text = String::from_utf8(store.get(&file.sha256).unwrap()).unwrap();
    let mut after = false;
    for line in text.lines() {
        if line.starts_with("#EXTINF") {
            after = true;
        } else if after && !line.starts_with('#') {
            return line.split('.').next().unwrap().to_owned();
        }
    }
    panic!("no segment")
}

fn to_nostr(ev: &Event) -> ns::Event {
    ns::Event::from_json(serde_json::to_string(ev).unwrap()).unwrap()
}

/// A browser-like peer: a session in one room, its relay client and its UDP socket.
struct Browser {
    session: Session,
    room: Room,
    client: ns::Client,
    notes: Pin<Box<dyn Stream<Item = ns::ClientNotification> + Send>>,
    socket: UdpSocket,
    addr: SocketAddr,
    /// The DNAT in front of the endpoint, when there is one.
    dnat: Option<Dnat>,
    /// The label of the one channel its offers carry, and whether it offers whatever the
    /// order of keys (a session that wants start-up files in a video room, §6.9).
    offer_label: &'static str,
    always_offers: bool,
}

/// An answer on the file channel.
#[derive(Debug, PartialEq)]
enum Got {
    File(Vec<u8>),
    Have(fc::Have),
    Missing,
    Busy,
}

/// A DNAT in front of the endpoint, as the browser's datagrams meet it. What the browser
/// sends to `public` reaches the endpoint's socket at `bind` with the browser's own source
/// address (no SNAT), and what the endpoint sends the browser arrives as from `public`, as
/// conntrack rewrites it. Nothing else crosses: the endpoint's bound address stands for a
/// private one the browser cannot reach, and the browser's own NAT lets in only what comes
/// from an address it has sent to (`opened`).
struct Dnat {
    public: SocketAddr,
    bind: SocketAddr,
    opened: bool,
}

impl Browser {
    async fn join(url: &str, room: Room, session: Session) -> Self {
        let client = ns::Client::default();
        client.add_relay(url).await.unwrap();
        client.connect().and_wait(Duration::from_secs(5)).await;
        let notes = client.notifications();
        let filter = ns::Filter::new()
            .kind(ns::Kind::from(signal::KIND_SIGNAL))
            .custom_tag(ns::SingleLetterTag::UPPERCASE_P, room.pubkey())
            .since(ns::Timestamp::from(unix_now() - 60));
        client.subscribe(filter).await.unwrap();
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = socket.local_addr().unwrap();
        Self {
            session,
            room,
            client,
            notes,
            socket,
            addr,
            dnat: None,
            offer_label: "webtorrent",
            always_offers: false,
        }
    }

    async fn send(&self, ev: &Event) {
        self.client.send_event(&to_nostr(ev)).await.unwrap();
    }

    /// The next valid signal for this session from `from`, announcing presence every second
    /// meanwhile (so a subscription that came up after the first one still hears it).
    async fn next_from(&mut self, from: &str) -> Received {
        let deadline = Instant::now() + WAIT;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            assert!(Instant::now() < deadline, "no signal from {from}");
            tokio::select! {
                _ = tick.tick() => {
                    let ev = self.session.connect(&self.room, unix_now()).unwrap();
                    self.send(&ev).await;
                }
                n = self.notes.next() => {
                    let Some(ns::ClientNotification::Event { event, .. }) = n else { continue };
                    let ev: Event = serde_json::from_str(&event.as_json()).unwrap();
                    if ev.pubkey != from {
                        continue;
                    }
                    if let Ok(Parsed::Ours(r)) =
                        signal::read(&ev, self.room.pubkey(), self.session.pubkey(), unix_now())
                    {
                        return r;
                    }
                }
            }
        }
    }

    fn rtc(&self) -> Rtc {
        let mut rtc = Rtc::builder().build(Instant::now());
        rtc.add_local_candidate(Candidate::host(self.addr, "udp").unwrap());
        rtc
    }

    /// Negotiate with `mesh` through the relay, whichever side the glare rule makes offer.
    /// Returns the connection and the endpoint's SDP (its answer or offer).
    async fn negotiate(&mut self, mesh: &str) -> (Rtc, String) {
        if self.always_offers || signal::offers_to(self.session.pubkey(), mesh) {
            let mut rtc = self.rtc();
            let mut api = rtc.sdp_api();
            api.add_channel(self.offer_label.into());
            let (offer, pending): (SdpOffer, SdpPendingOffer) = api.apply().unwrap();
            let sdp = offer.to_sdp_string();
            // The offer goes again, freshly signed, every 3 s until it is answered: one sent
            // before the endpoint's subscription reached the relay is lost (relays keep no
            // ephemeral event). The endpoint answers the first it gets and ignores repeats.
            let mut sent = Vec::new();
            let mut last: Option<Instant> = None;
            let start = Instant::now();
            loop {
                assert!(start.elapsed() < WAIT, "no answer");
                if last.is_none_or(|t| t.elapsed() >= Duration::from_secs(3)) {
                    let ev = self
                        .session
                        .offer(&self.room, mesh, &sdp, &rand_bytes(), unix_now())
                        .unwrap();
                    self.send(&ev).await;
                    sent.push(ev.id);
                    last = Some(Instant::now());
                }
                let Ok(r) =
                    tokio::time::timeout(Duration::from_secs(1), self.next_from(mesh)).await
                else {
                    continue;
                };
                if let Signal::Answer { offer, .. } = &r.signal
                    && sent.contains(offer)
                {
                    let sdp = self.session.open(&r).unwrap();
                    rtc.sdp_api()
                        .accept_answer(pending, SdpAnswer::from_sdp_string(&sdp).unwrap())
                        .unwrap();
                    return (rtc, sdp);
                }
            }
        } else {
            loop {
                let r = self.next_from(mesh).await;
                if let Signal::Offer { .. } = r.signal {
                    let sdp = self.session.open(&r).unwrap();
                    assert!(sdp.contains("typ host"), "{sdp}");
                    let mut rtc = self.rtc();
                    let answer = rtc
                        .sdp_api()
                        .accept_offer(SdpOffer::from_sdp_string(&sdp).unwrap())
                        .unwrap();
                    let ev = self
                        .session
                        .answer(
                            &self.room,
                            mesh,
                            &r.id,
                            &answer.to_sdp_string(),
                            &[8; 32],
                            unix_now(),
                        )
                        .unwrap();
                    self.send(&ev).await;
                    return (rtc, sdp);
                }
            }
        }
    }

    /// Where a datagram for `to` goes: there, or through the DNAT; `None` where it cannot (off
    /// loopback, where a candidate a lying STUN server reported may point).
    fn route_out(&mut self, to: SocketAddr) -> Option<SocketAddr> {
        match &mut self.dnat {
            None => to.ip().is_loopback().then_some(to),
            Some(d) if to == d.public => {
                d.opened = true;
                Some(d.bind)
            }
            Some(_) => None,
        }
    }

    /// Where a datagram from `from` seems to come from: there, or through the DNAT; `None`
    /// when it would not get in.
    fn route_in(&self, from: SocketAddr) -> Option<SocketAddr> {
        match &self.dnat {
            None => Some(from),
            Some(d) if from == d.bind && d.opened => Some(d.public),
            Some(_) => None,
        }
    }

    /// One step of the connection: hand `rtc` the next datagram (or a timeout) by `wake`.
    async fn step(&mut self, rtc: &mut Rtc, wake: Instant, buf: &mut [u8]) {
        let wait = wake
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(100));
        let got = tokio::time::timeout(wait, self.socket.recv_from(buf)).await;
        match got
            .ok()
            .and_then(Result::ok)
            .and_then(|(n, from)| self.route_in(from).map(|source| (n, source)))
        {
            Some((n, source)) => {
                let input = Input::Receive(
                    Instant::now(),
                    Receive {
                        proto: Protocol::Udp,
                        source,
                        destination: self.addr,
                        contents: (&buf[..n]).try_into().unwrap(),
                    },
                );
                rtc.handle_input(input).unwrap();
            }
            None => rtc.handle_input(Input::Timeout(Instant::now())).unwrap(),
        }
    }

    /// Drive `rtc` until a file channel is open (whichever side opened it) and the
    /// endpoint's `hello` has come, then send `asks` (each one message) and gather the last
    /// answer of each request. Returns the endpoint's `hello` flags, the labels of every
    /// channel that opened, in order, and the answers by `req`.
    async fn ask_files(
        &mut self,
        rtc: &mut Rtc,
        asks: &[Message<'_>],
    ) -> (u8, Vec<String>, HashMap<u32, Got>) {
        let deadline = Instant::now() + WAIT;
        let mut files: Option<ChannelId> = None;
        let mut labels = Vec::new();
        let mut flags = None;
        let mut sent = false;
        let mut partial: HashMap<u32, Vec<u8>> = HashMap::new();
        let mut got = HashMap::new();
        let mut buf = vec![0u8; 2048];
        while got.len() < asks.len() {
            assert!(
                Instant::now() < deadline,
                "no answers on the file channel: {got:?}"
            );
            let wake = loop {
                match rtc.poll_output().unwrap() {
                    Output::Timeout(t) => break t,
                    Output::Transmit(t) => {
                        if let Some(to) = self.route_out(t.destination) {
                            self.socket.send_to(&t.contents, to).await.unwrap();
                        }
                    }
                    Output::Event(RtcEvent::ChannelOpen(id, label)) => {
                        if label == fc::LABEL {
                            files = Some(id);
                            let hello = Message::Hello {
                                version: 1,
                                flags: 0,
                            };
                            rtc.channel(id)
                                .unwrap()
                                .write(true, &hello.encode().unwrap())
                                .unwrap();
                        }
                        labels.push(label);
                    }
                    Output::Event(RtcEvent::ChannelData(d)) if Some(d.id) == files => {
                        match Message::decode(&d.data).unwrap() {
                            Message::Hello { flags: f, .. } => flags = Some(f),
                            Message::Data { req, bytes } => {
                                partial.entry(req).or_default().extend_from_slice(bytes);
                            }
                            Message::End { req } => {
                                got.insert(
                                    req,
                                    Got::File(partial.remove(&req).unwrap_or_default()),
                                );
                            }
                            Message::Missing { req } => {
                                got.insert(req, Got::Missing);
                            }
                            Message::Busy { req } => {
                                got.insert(req, Got::Busy);
                            }
                            Message::Have { req, have } => {
                                got.insert(req, Got::Have(have));
                            }
                            other => panic!("the endpoint sent {other:?}"),
                        }
                    }
                    Output::Event(_) => {}
                }
            };
            if let (Some(id), Some(_), false) = (files, flags, sent) {
                sent = true;
                for m in asks {
                    rtc.channel(id)
                        .unwrap()
                        .write(true, &m.encode().unwrap())
                        .unwrap();
                }
                continue;
            }
            self.step(rtc, wake, &mut buf).await;
        }
        (flags.unwrap(), labels, got)
    }

    /// Drive `rtc` over the socket until the data channel is open, then ask for segment 0
    /// and return its bytes once `Completed` arrives.
    async fn fetch_segment_0(&mut self, rtc: &mut Rtc) -> Vec<u8> {
        let deadline = Instant::now() + WAIT;
        let mut channel: Option<ChannelId> = None;
        let mut asked = false;
        let mut commands = Reassembler::default();
        let mut data = Vec::new();
        let mut announced = false;
        let mut buf = vec![0u8; 2048];
        loop {
            assert!(Instant::now() < deadline, "no segment");
            let wake = loop {
                match rtc.poll_output().unwrap() {
                    Output::Timeout(t) => break t,
                    Output::Transmit(t) => {
                        if let Some(to) = self.route_out(t.destination) {
                            self.socket.send_to(&t.contents, to).await.unwrap();
                        }
                    }
                    Output::Event(RtcEvent::ChannelOpen(id, _)) => channel = Some(id),
                    Output::Event(RtcEvent::ChannelData(d)) => {
                        if !p2pml::is_command_chunk(&d.data) {
                            data.extend_from_slice(&d.data);
                            continue;
                        }
                        match commands.feed(&d.data).unwrap() {
                            Some(Command::Announcement { loaded, .. }) => {
                                assert!(loaded.contains(&0), "segment 0 is announced");
                                announced = true;
                            }
                            Some(Command::Completed { id: 0, request: 1 }) => return data,
                            Some(Command::Absent { .. }) => panic!("absent"),
                            _ => {}
                        }
                    }
                    Output::Event(_) => {}
                }
            };
            if let (Some(id), true, false) = (channel, announced, asked) {
                asked = true;
                for m in p2pml::encode(&Command::Request {
                    id: 0,
                    request: 1,
                    from: 0,
                })
                .unwrap()
                {
                    rtc.channel(id).unwrap().write(true, &m).unwrap();
                }
                continue;
            }
            let wait = wake
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(100));
            let got = tokio::time::timeout(wait, self.socket.recv_from(&mut buf)).await;
            match got
                .ok()
                .and_then(Result::ok)
                .and_then(|(n, from)| self.route_in(from).map(|source| (n, source)))
            {
                Some((n, source)) => {
                    let input = Input::Receive(
                        Instant::now(),
                        Receive {
                            proto: Protocol::Udp,
                            source,
                            destination: self.addr,
                            contents: (&buf[..n]).try_into().unwrap(),
                        },
                    );
                    rtc.handle_input(input).unwrap();
                }
                None => rtc.handle_input(Input::Timeout(Instant::now())).unwrap(),
            }
        }
    }
}

/// A browser offers (its key is the lower) or answers (the higher), and either way fetches a
/// verified segment from the endpoint. With `public`, the endpoint is told that address and
/// the browser reaches it only through a DNAT that maps it onto the endpoint's socket.
async fn a_browser_fetches_a_segment(browser_offers: bool, public: Option<SocketAddr>) {
    let (_relay, url) = relay().await;
    let d = dir(match (browser_offers, public.is_some()) {
        (true, false) => "offers",
        (false, false) => "answers",
        (true, true) => "dnat-offers",
        (false, true) => "dnat-answers",
    });
    let (store, v) = common::vector_store(&d);
    let store = Arc::new(store);
    let mesh = Mesh::start(
        store.clone(),
        MeshConfig {
            public,
            ..config(&url)
        },
    )
    .await
    .unwrap();
    assert_eq!(mesh.public_addr(), public);
    let ids = mesh.serve(&v.list, &*store, None).await.unwrap();
    assert_eq!(ids, vec!["720p".to_owned()]);
    until(&mesh, "the room is joined", |s| s.gathered && s.rooms == 1).await;

    let video = VideoAddr::parse(&v.list.video).unwrap();
    let room = Room::derive(&video.web_stream_swarm_id("720p"));
    let session = loop {
        let s = Session::new(rand_bytes(), rand_bytes()).unwrap();
        if signal::offers_to(s.pubkey(), mesh.session_key()) == browser_offers {
            break s;
        }
    };
    let mut browser = Browser::join(&url, room, session).await;
    browser.dnat = public.map(|public| Dnat {
        public,
        bind: mesh.local_addr(),
        opened: false,
    });
    let (mut rtc, sdp) = browser.negotiate(mesh.session_key()).await;
    let candidates: Vec<&str> = sdp
        .lines()
        .filter(|l| l.starts_with("a=candidate:"))
        .collect();
    let bound = mesh.local_addr();
    let told = public.unwrap_or(bound);
    assert_eq!(candidates.len(), 1, "{sdp}");
    assert!(
        candidates[0].contains(&format!("{} {} typ host", told.ip(), told.port())),
        "{sdp}"
    );
    if public.is_some() {
        // The bound address never reaches the peer.
        assert!(!sdp.contains(&bound.ip().to_string()), "{sdp}");
    }
    let bytes = browser.fetch_segment_0(&mut rtc).await;
    let want = first_segment(&v.list, &*store, "720p");
    assert_eq!(hex::encode(nfx_proto::sha256(&bytes)), want);
    let s = until(&mesh, "served", |s| s.served >= 1 && s.open >= 1).await;
    assert_eq!(s.failed, 0);
    assert_eq!(s.candidates, [format!("host {told}")]);
    if let Some(d) = &browser.dnat {
        assert!(d.opened, "the browser sent to the public address");
    }
    if browser_offers {
        assert_eq!((s.offers, s.answers), (0, 1));
    } else {
        assert_eq!((s.offers, s.answers), (1, 0));
    }
    mesh.shutdown().await;
    browser.client.shutdown().await;
    let _ = std::fs::remove_dir_all(&d);
}

fn sha32(hex_: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(hex_, &mut out).unwrap();
    out
}

/// What the browser asks the endpoint on the file channel, and what it must get: the hash
/// list, `have` naming the one rendition whole, the init and the thumbnail; `missing` for a
/// segment and for a file of no video; `missing` for `beacons` (the endpoint does not set
/// that bit).
fn check_start_up_files(v: &common::Vector, store: &dyn ContentStore, got: &HashMap<u32, Got>) {
    let root = v.manifest.root_hex();
    let file = |role: Role| {
        v.list
            .files
            .iter()
            .find(|f| f.role == role)
            .unwrap()
            .sha256
            .clone()
    };
    assert_eq!(
        got[&1],
        Got::File(store.get(&root).unwrap()),
        "the hash list"
    );
    assert_eq!(
        got[&2],
        Got::Have(fc::Have {
            whole: vec!["720p".into()],
            part: vec![],
        })
    );
    assert_eq!(got[&3], Got::File(store.get(&file(Role::Init)).unwrap()));
    assert_eq!(got[&4], Got::File(store.get(&file(Role::Thumb)).unwrap()));
    assert_eq!(got[&5], Got::Missing, "a segment never travels here");
    assert_eq!(got[&6], Got::Missing, "a file of no video");
    assert_eq!(got[&7], Got::Missing, "no beacons bit");
}

fn start_up_asks(v: &common::Vector) -> Vec<Message<'static>> {
    let file = |role: Role| sha32(&v.list.files.iter().find(|f| f.role == role).unwrap().sha256);
    let root = sha32(&v.manifest.root_hex());
    vec![
        Message::Get { req: 1, sha: root },
        Message::List { req: 2, root },
        Message::Get {
            req: 3,
            sha: file(Role::Init),
        },
        Message::Get {
            req: 4,
            sha: file(Role::Thumb),
        },
        Message::Get {
            req: 5,
            sha: file(Role::Segment),
        },
        Message::Get {
            req: 6,
            sha: [7; 32],
        },
        Message::Beacons { req: 7 },
    ]
}

/// A browser that holds only the manifest: it joins the video room (NFX-10 §6.9), offers
/// with the file channel as the only channel whatever the order of keys, and takes the
/// start-up files from the endpoint.
#[tokio::test(flavor = "multi_thread")]
async fn a_browser_with_only_the_manifest_takes_the_start_up_files_in_the_video_room() {
    let (_relay, url) = relay().await;
    let d = dir("video-room");
    let (store, v) = common::vector_store(&d);
    let store = Arc::new(store);
    let mesh = Mesh::start(store.clone(), config(&url)).await.unwrap();
    mesh.serve(&v.list, &*store, None).await.unwrap();
    until(&mesh, "the stream room is joined", |s| {
        s.gathered && s.rooms == 1
    })
    .await;
    let a = v.manifest.a_tag();
    mesh.serve_files(&a, &v.manifest.root_hex(), &v.list)
        .await
        .unwrap();
    until(&mesh, "the video room is joined", |s| {
        s.rooms == 1 && s.video_rooms == 1
    })
    .await;

    // Whatever the order of keys: in a video room the one that wants files offers.
    let session = loop {
        let s = Session::new(rand_bytes(), rand_bytes()).unwrap();
        if !signal::offers_to(s.pubkey(), mesh.session_key()) {
            break s;
        }
    };
    let mut browser = Browser::join(&url, Room::video(&a).unwrap(), session).await;
    browser.offer_label = fc::LABEL;
    browser.always_offers = true;
    let (mut rtc, _) = browser.negotiate(mesh.session_key()).await;
    let asks = start_up_asks(&v);
    let (flags, labels, got) = browser.ask_files(&mut rtc, &asks).await;
    assert_eq!(flags, fc::FLAG_FILES);
    assert_eq!(labels, [fc::LABEL]);
    check_start_up_files(&v, &*store, &got);
    let s = until(&mesh, "open", |s| s.open >= 1).await;
    assert_eq!(
        (s.offers, s.answers, s.failed),
        (0, 1, 0),
        "the endpoint never offers there"
    );

    // Forgotten: it leaves the video room.
    mesh.forget_files(&a).await.unwrap();
    until(&mesh, "the video room is left", |s| {
        s.rooms == 1 && s.video_rooms == 0
    })
    .await;
    mesh.shutdown().await;
    browser.client.shutdown().await;
    let _ = std::fs::remove_dir_all(&d);
}

/// On a stream-room connection the endpoint, as offerer, opens the file channel once the
/// first channel is open, and serves the same start-up files on it.
#[tokio::test(flavor = "multi_thread")]
async fn the_endpoint_that_offers_opens_the_file_channel_after_the_first() {
    let (_relay, url) = relay().await;
    let d = dir("stream-room-files");
    let (store, v) = common::vector_store(&d);
    let store = Arc::new(store);
    let mesh = Mesh::start(store.clone(), config(&url)).await.unwrap();
    mesh.serve(&v.list, &*store, None).await.unwrap();
    mesh.serve_files(&v.manifest.a_tag(), &v.manifest.root_hex(), &v.list)
        .await
        .unwrap();
    until(&mesh, "both rooms are joined", |s| {
        s.gathered && s.rooms == 1 && s.video_rooms == 1
    })
    .await;
    let video = VideoAddr::parse(&v.list.video).unwrap();
    let room = Room::derive(&video.web_stream_swarm_id("720p"));
    // The endpoint's key is the lower: it offers.
    let session = loop {
        let s = Session::new(rand_bytes(), rand_bytes()).unwrap();
        if signal::offers_to(mesh.session_key(), s.pubkey()) {
            break s;
        }
    };
    let mut browser = Browser::join(&url, room, session).await;
    let (mut rtc, _) = browser.negotiate(mesh.session_key()).await;
    let asks = start_up_asks(&v);
    let (flags, labels, got) = browser.ask_files(&mut rtc, &asks).await;
    assert_eq!(flags, fc::FLAG_FILES);
    assert_eq!(
        labels,
        ["nfx", fc::LABEL],
        "the file channel opens after the first"
    );
    check_start_up_files(&v, &*store, &got);
    mesh.shutdown().await;
    browser.client.shutdown().await;
    let _ = std::fs::remove_dir_all(&d);
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).unwrap();
    b
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_whose_key_is_lower_offers_and_fetches_a_segment() {
    a_browser_fetches_a_segment(true, None).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_whose_key_is_higher_answers_and_fetches_a_segment() {
    a_browser_fetches_a_segment(false, None).await;
}

/// The public address of the test's DNAT (a documentation address: nothing is ever sent to
/// it, the DNAT maps it onto the endpoint's socket).
const PUBLIC: &str = "203.0.113.7:7845";

#[tokio::test(flavor = "multi_thread")]
async fn behind_a_dnat_a_browser_that_offers_reaches_the_endpoint_through_its_public_address() {
    a_browser_fetches_a_segment(true, Some(PUBLIC.parse().unwrap())).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn behind_a_dnat_a_browser_that_answers_reaches_the_endpoint_through_its_public_address() {
    a_browser_fetches_a_segment(false, Some(PUBLIC.parse().unwrap())).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn two_endpoints_in_one_room_find_and_connect_to_each_other() {
    let (_relay, url) = relay().await;
    let (da, db) = (dir("a"), dir("b"));
    let (sa, v) = common::vector_store(&da);
    let (sb, _) = common::vector_store(&db);
    let (sa, sb) = (Arc::new(sa), Arc::new(sb));
    let a = Mesh::start(sa.clone(), config(&url)).await.unwrap();
    let b = Mesh::start(sb.clone(), config(&url)).await.unwrap();
    a.serve(&v.list, &*sa, None).await.unwrap();
    b.serve(&v.list, &*sb, None).await.unwrap();
    let sa_ = until(&a, "a connects", |s| s.open >= 1).await;
    let sb_ = until(&b, "b connects", |s| s.open >= 1).await;
    // Exactly one side offered: the lower key's.
    assert_eq!(sa_.offers + sb_.offers, 1, "{sa_:?} {sb_:?}");
    assert_eq!(sa_.answers + sb_.answers, 1, "{sa_:?} {sb_:?}");
    a.shutdown().await;
    b.shutdown().await;
    let _ = std::fs::remove_dir_all(&da);
    let _ = std::fs::remove_dir_all(&db);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stun_mapping_is_offered_and_settings_that_cannot_work_are_refused() {
    let (_relay, url) = relay().await;
    // A STUN server that reports a fixed public mapping.
    let stun = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let stun_addr = stun.local_addr().unwrap();
    let responder = tokio::spawn(async move {
        let mut buf = [0u8; 512];
        loop {
            let Ok((n, from)) = stun.recv_from(&mut buf).await else {
                return;
            };
            if n != 20 || buf[0..2] != [0, 1] {
                continue;
            }
            let mut resp = buf[..20].to_vec();
            resp[0..2].copy_from_slice(&[0x01, 0x01]);
            resp[3] = 12;
            let port = 41000u16 ^ 0x2112;
            resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0, 1]);
            resp.extend_from_slice(&port.to_be_bytes());
            resp.extend(
                [198u8, 51, 100, 23]
                    .iter()
                    .zip([0x21u8, 0x12, 0xa4, 0x42])
                    .map(|(a, b)| a ^ b),
            );
            let _ = stun.send_to(&resp, from).await;
        }
    });
    let d = dir("stun");
    let (store, _) = common::vector_store(&d);
    let store: Arc<dyn ContentStore + Send + Sync> = Arc::new(store);
    let mesh = Mesh::start(
        store.clone(),
        MeshConfig {
            stun: vec![stun_addr],
            ..config(&url)
        },
    )
    .await
    .unwrap();
    let s = until(&mesh, "gathered", |s| s.gathered).await;
    assert_eq!(
        s.candidates,
        vec![
            format!("host {}", mesh.local_addr()),
            "srflx 198.51.100.23:41000".to_owned()
        ]
    );
    mesh.shutdown().await;
    responder.abort();

    // What cannot work is refused at start.
    for (cfg, why) in [
        (MeshConfig::new(vec![]), "1 to 8 relays"),
        (MeshConfig::new(vec![url.clone(); 9]), "1 to 8 relays"),
        (
            MeshConfig::new(vec!["https://relay.example".into()]),
            "wss://",
        ),
        (
            MeshConfig::new(vec!["wss://u:p@relay.example".into()]),
            "credentials",
        ),
        (
            MeshConfig {
                stun: vec!["[2001:db8::1]:3478".parse().unwrap()],
                ..config(&url)
            },
            "family",
        ),
        (
            MeshConfig {
                stun: vec![stun_addr; 5],
                ..config(&url)
            },
            "at most 4",
        ),
        (
            MeshConfig {
                max_peers: 0,
                ..config(&url)
            },
            "connection cap",
        ),
    ]
    .into_iter()
    .chain(
        [
            "[2001:db8::7]:7845",
            "203.0.113.7:0",
            "0.0.0.0:7845",
            "224.0.0.1:7845",
            "255.255.255.255:7845",
            "169.254.1.1:7845",
        ]
        .map(|public| {
            (
                MeshConfig {
                    public: Some(public.parse().unwrap()),
                    ..config(&url)
                },
                "public address",
            )
        }),
    ) {
        let err = Mesh::start(store.clone(), cfg.clone())
            .await
            .err()
            .expect("refused")
            .to_string();
        assert!(err.contains(why), "{cfg:?}: {err}");
    }
    let _ = std::fs::remove_dir_all(&d);
}

/// A STUN server on loopback that answers every Binding request with `report`, or with the
/// request's true source when `report` is `None` (IPv4 only).
async fn stun_server(report: Option<SocketAddr>) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let stun = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = stun.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut buf = [0u8; 512];
        loop {
            let Ok((n, from)) = stun.recv_from(&mut buf).await else {
                return;
            };
            if n != 20 || buf[0..2] != [0, 1] {
                continue;
            }
            let SocketAddr::V4(mapped) = report.unwrap_or(from) else {
                continue;
            };
            let mut resp = buf[..20].to_vec();
            resp[0..2].copy_from_slice(&[0x01, 0x01]);
            resp[3] = 12;
            resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0, 1]);
            resp.extend_from_slice(&(mapped.port() ^ 0x2112).to_be_bytes());
            resp.extend(
                mapped
                    .ip()
                    .octets()
                    .iter()
                    .zip([0x21u8, 0x12, 0xa4, 0x42])
                    .map(|(a, b)| a ^ b),
            );
            let _ = stun.send_to(&resp, from).await;
        }
    });
    (addr, task)
}

/// Two STUN servers, one honest and one that lies about the mapping: the endpoint offers the
/// lie as one more candidate, ICE tries it and fails that pair only, and the browser still
/// connects through the others and fetches a verified segment (NFX-10 §1: a lying server costs
/// a failed pair).
#[tokio::test(flavor = "multi_thread")]
async fn a_lying_stun_server_costs_a_candidate_and_the_browser_still_connects() {
    let (_relay, url) = relay().await;
    let (honest, honest_task) = stun_server(None).await;
    let lie: SocketAddr = "198.51.100.23:41000".parse().unwrap();
    let (liar, liar_task) = stun_server(Some(lie)).await;
    let d = dir("liar");
    let (store, v) = common::vector_store(&d);
    let store = Arc::new(store);
    let mesh = Mesh::start(
        store.clone(),
        MeshConfig {
            stun: vec![liar, honest],
            ..config(&url)
        },
    )
    .await
    .unwrap();
    mesh.serve(&v.list, &*store, None).await.unwrap();
    let s = until(&mesh, "both servers answered", |s| {
        s.gathered && s.rooms == 1 && s.candidates.len() == 2
    })
    .await;
    // The honest mapping is the socket's own address, offered once; the lie is offered too.
    assert_eq!(
        s.candidates,
        [
            format!("host {}", mesh.local_addr()),
            format!("srflx {lie}")
        ]
    );
    assert_eq!(s.stun, [liar.to_string(), honest.to_string()]);

    let video = VideoAddr::parse(&v.list.video).unwrap();
    let room = Room::derive(&video.web_stream_swarm_id("720p"));
    let session = Session::new(rand_bytes(), rand_bytes()).unwrap();
    let mut browser = Browser::join(&url, room, session).await;
    let (mut rtc, sdp) = browser.negotiate(mesh.session_key()).await;
    assert!(
        sdp.contains(&format!("{} {} typ srflx", lie.ip(), lie.port())),
        "{sdp}"
    );
    let bytes = browser.fetch_segment_0(&mut rtc).await;
    let want = first_segment(&v.list, &*store, "720p");
    assert_eq!(hex::encode(nfx_proto::sha256(&bytes)), want);
    let s = until(&mesh, "served", |s| s.served >= 1 && s.open >= 1).await;
    assert_eq!(s.failed, 0);
    mesh.shutdown().await;
    browser.client.shutdown().await;
    honest_task.abort();
    liar_task.abort();
    let _ = std::fs::remove_dir_all(&d);
}
