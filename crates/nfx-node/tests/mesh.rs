//! The mesh endpoint end to end on loopback (NFX-10 §6, issue #71): an in-process Nostr relay
//! that carries kind 25050 (nostr-sdk's local relay; NFX-04's scoped relay refuses it), the
//! endpoint serving the test-vector video, and a browser-like peer built from str0m (full
//! ICE), nfx-proto's signaling and nostr-sdk. The peer finds the endpoint by its room alone,
//! negotiates through the relay (either side offering, by the glare rule), opens the data
//! channel, asks for a segment with p2p-media-loader's protocol and checks its sha256. Then
//! two endpoints in one room, which find and connect to each other the same way.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

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
    async fn negotiate(&mut self, mesh: &str) -> Rtc {
        if signal::offers_to(self.session.pubkey(), mesh) {
            let mut rtc = self.rtc();
            let mut api = rtc.sdp_api();
            api.add_channel("webtorrent".into());
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
                    return rtc;
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
                    return rtc;
                }
            }
        }
    }

    /// Drive `rtc` over the socket until the data channel is open, then ask for segment 0
    /// and return its bytes once `Completed` arrives.
    async fn fetch_segment_0(&self, rtc: &mut Rtc) -> Vec<u8> {
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
                        self.socket
                            .send_to(&t.contents, t.destination)
                            .await
                            .unwrap();
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
            match tokio::time::timeout(wait, self.socket.recv_from(&mut buf)).await {
                Ok(Ok((n, source))) => {
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
                _ => rtc.handle_input(Input::Timeout(Instant::now())).unwrap(),
            }
        }
    }
}

/// A browser offers (its key is the lower) or answers (the higher), and either way fetches a
/// verified segment from the endpoint.
async fn a_browser_fetches_a_segment(browser_offers: bool) {
    let (_relay, url) = relay().await;
    let d = dir(if browser_offers { "offers" } else { "answers" });
    let (store, v) = common::vector_store(&d);
    let store = Arc::new(store);
    let mesh = Mesh::start(store.clone(), config(&url)).await.unwrap();
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
    let mut rtc = browser.negotiate(mesh.session_key()).await;
    let bytes = browser.fetch_segment_0(&mut rtc).await;
    let want = first_segment(&v.list, &*store, "720p");
    assert_eq!(hex::encode(nfx_proto::sha256(&bytes)), want);
    let s = until(&mesh, "served", |s| s.served >= 1 && s.open >= 1).await;
    assert_eq!(s.failed, 0);
    if browser_offers {
        assert_eq!((s.offers, s.answers), (0, 1));
    } else {
        assert_eq!((s.offers, s.answers), (1, 0));
    }
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
    a_browser_fetches_a_segment(true).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_whose_key_is_higher_answers_and_fetches_a_segment() {
    a_browser_fetches_a_segment(false).await;
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
    ] {
        let err = Mesh::start(store.clone(), cfg.clone())
            .await
            .err()
            .expect("refused")
            .to_string();
        assert!(err.contains(why), "{cfg:?}: {err}");
    }
    let _ = std::fs::remove_dir_all(&d);
}
