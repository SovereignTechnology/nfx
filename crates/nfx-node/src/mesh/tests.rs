//! Unit tests of the mesh endpoint's signaling rules, driven event by event with no relay:
//! the glare rule, the bounds, failure and backoff, and leaving a room.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nfx_proto::event::Event;
use nfx_proto::signal::{self, Parsed, Room, Session};
use str0m::change::{SdpOffer, SdpPendingOffer};
use str0m::{Candidate, Rtc};
use tokio::net::UdpSocket;

use super::book::{OfferBackoff, PENDING_OFFERS_PER_ROOM, PresenceBook, SeenIds, SenderLimiter};
use super::{Control, MAX_PEERS_PER_ROOM, MeshStatus, RoomState, State, Stun};
use crate::nostr::to_nostr;
use crate::rtc_serve::{Swarm, Uploader};
use crate::unix_now;

const SWARM: &str = "nfx/1/web/nfx:mainnet:1:salt-flats-dusk/720p";
const ME: [u8; 32] = [0x42; 32];

async fn state(max_peers: usize) -> State {
    let socket = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let base = socket.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!(
        "nfx-mesh-unit-{}-{}",
        std::process::id(),
        hex::encode(super::random::<6>().unwrap())
    ));
    let store = Arc::new(crate::store::FsStore::open(&dir).unwrap());
    let now = Instant::now();
    let later = now + Duration::from_secs(3600);
    let mut s = State {
        session: Session::new(ME, [9; 16]).unwrap(),
        client: nostr_sdk::prelude::Client::default(),
        uploader: Uploader::new(socket, store, now),
        base,
        host: Candidate::host(base, "udp").unwrap(),
        stun: Stun::new(vec![], now),
        portmapped: None,
        gathered: true,
        started: now,
        rooms: HashMap::new(),
        waiting: Vec::new(),
        subs: Vec::new(),
        sub_seq: 0,
        next_sub_check: later,
        next_refresh: later,
        links: Vec::new(),
        max_peers,
        max_per_room: MAX_PEERS_PER_ROOM.min(max_peers),
        next_presence: later,
        status: Arc::new(Mutex::new(MeshStatus::default())),
        counts: MeshStatus::default(),
        sent: Vec::new(),
    };
    s.stun.next_round = later;
    let room = Room::derive(SWARM);
    s.rooms.insert(
        room.pubkey().to_owned(),
        RoomState {
            room,
            swarm: Swarm {
                segments: vec![],
                loaded: vec![],
            },
            presence: PresenceBook::default(),
            seen: SeenIds::default(),
            limiter: SenderLimiter::default(),
            backoff: OfferBackoff::default(),
            reannounce_at: now,
        },
    );
    s
}

/// Peer sessions with keys above and below this node's, in a fixed order.
fn peers() -> (Vec<Session>, Vec<Session>) {
    let me = Session::new(ME, [9; 16]).unwrap();
    let (mut hi, mut lo) = (vec![], vec![]);
    for i in 1..=60u8 {
        let s = Session::new([i; 32], [i; 16]).unwrap();
        if signal::offers_to(me.pubkey(), s.pubkey()) {
            hi.push(s);
        } else {
            lo.push(s);
        }
    }
    assert!(hi.len() >= 8 && lo.len() >= 8, "{} {}", hi.len(), lo.len());
    (hi, lo)
}

fn room() -> Room {
    Room::derive(SWARM)
}

fn feed(s: &mut State, ev: &Event) {
    s.on_event(&to_nostr(ev).unwrap());
}

fn tag<'a>(ev: &'a Event, name: &str) -> Option<&'a str> {
    ev.tag_values(name)
        .next()
        .and_then(|v| v.first())
        .map(String::as_str)
}

/// A browser's offer: a full ICE agent on loopback, one data channel.
fn browser_offer() -> (Rtc, SdpPendingOffer, String) {
    let mut rtc = Rtc::builder().build(Instant::now());
    rtc.add_local_candidate(Candidate::host("127.0.0.1:50000".parse().unwrap(), "udp").unwrap());
    let mut api = rtc.sdp_api();
    api.add_channel("webtorrent".into());
    let (offer, pending) = api.apply().unwrap();
    (rtc, pending, offer.to_sdp_string())
}

fn offer_from(peer: &Session, at: u64, nonce: u8) -> Event {
    let (_, _, sdp) = browser_offer();
    let me = Session::new(ME, [9; 16]).unwrap();
    peer.offer(&room(), me.pubkey(), &sdp, &[nonce; 32], at)
        .unwrap()
}

#[tokio::test]
async fn the_lower_key_offers_and_its_offer_stands() {
    let mut s = state(16).await;
    let (hi, lo) = peers();
    let now = unix_now();

    // A higher key's presence: this node offers, once.
    feed(&mut s, &hi[0].connect(&room(), now).unwrap());
    assert_eq!(s.links.len(), 1);
    assert!(s.links[0].offerer && s.links[0].pending.is_some());
    let ours = s.sent.last().unwrap().clone();
    assert_eq!(tag(&ours, "t"), Some("offer"));
    assert_eq!(tag(&ours, "p"), Some(hi[0].pubkey()));
    feed(&mut s, &hi[0].connect(&room(), now).unwrap());
    assert_eq!(s.links.len(), 1, "the same presence again");

    // A lower key's presence: it offers, so this node waits, and says once more, out of
    // turn, that it is here (the newcomer heard none of its earlier presence).
    let sent = s.sent.len();
    feed(&mut s, &lo[0].connect(&room(), now).unwrap());
    assert_eq!(s.links.len(), 1);
    assert_eq!(s.sent.len(), sent + 1);
    assert_eq!(tag(s.sent.last().unwrap(), "t"), Some("connect"));
    feed(&mut s, &lo[1].connect(&room(), now).unwrap());
    assert_eq!(s.sent.len(), sent + 1, "at most once per 5 s");

    // Glare: the higher key offers while ours is pending. Ours (the lower key's) stands.
    feed(&mut s, &offer_from(&hi[0], now, 1));
    assert_eq!(s.links.len(), 1);
    assert!(s.links[0].offerer && s.links[0].pending.is_some());

    // The lower key's offer is answered, with `e` naming it.
    let offer = offer_from(&lo[0], now, 2);
    feed(&mut s, &offer);
    assert_eq!(s.links.len(), 2);
    assert!(!s.links[1].offerer);
    let answer = s.sent.last().unwrap().clone();
    assert_eq!(tag(&answer, "t"), Some("answer"));
    assert_eq!(tag(&answer, "e"), Some(offer.id.as_str()));
    // The answer opens for the peer to an SDP that names this node's candidate.
    let Parsed::Ours(r) = signal::read(&answer, room().pubkey(), lo[0].pubkey(), now).unwrap()
    else {
        panic!("ours")
    };
    let sdp = lo[0].open(&r).unwrap();
    assert!(
        sdp.contains(&format!("{} {} typ host", s.base.ip(), s.base.port())),
        "{sdp}"
    );
    // The same event again, or another offer while it is answered: nothing new.
    feed(&mut s, &offer);
    feed(&mut s, &offer_from(&lo[0], now, 3));
    assert_eq!(s.links.len(), 2);
    assert_eq!(s.counts.answers, 1);

    // An answer to another offer is ignored; the one to ours is applied.
    let Parsed::Ours(r) = signal::read(&ours, room().pubkey(), hi[0].pubkey(), now).unwrap() else {
        panic!("ours")
    };
    let mut rtc = Rtc::builder().build(Instant::now());
    rtc.add_local_candidate(Candidate::host("127.0.0.1:50001".parse().unwrap(), "udp").unwrap());
    let their = rtc
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&hi[0].open(&r).unwrap()).unwrap())
        .unwrap()
        .to_sdp_string();
    let me = s.session.pubkey().to_owned();
    let wrong = hi[0]
        .answer(&room(), &me, &"0".repeat(64), &their, &[4; 32], now)
        .unwrap();
    feed(&mut s, &wrong);
    assert!(s.links[0].pending.is_some());
    let right = hi[0]
        .answer(&room(), &me, &ours.id, &their, &[5; 32], now)
        .unwrap();
    feed(&mut s, &right);
    assert!(s.links[0].pending.is_none(), "the answer is applied");
}

#[tokio::test]
async fn offers_and_connections_stay_within_their_bounds() {
    let (hi, lo) = peers();
    let now = unix_now();
    // At most four offers of ours await answers, so answering keeps its slots.
    let mut s = state(16).await;
    for p in &hi[..8] {
        feed(&mut s, &p.connect(&room(), now).unwrap());
    }
    assert_eq!(s.links.len(), PENDING_OFFERS_PER_ROOM);
    feed(&mut s, &offer_from(&lo[0], now, 1));
    assert_eq!(
        s.links.len(),
        PENDING_OFFERS_PER_ROOM + 1,
        "an offer is still answered"
    );

    // At most max_peers connections in all.
    let mut s = state(2).await;
    for p in &hi[..3] {
        feed(&mut s, &p.connect(&room(), now).unwrap());
    }
    assert_eq!(s.links.len(), 2);
    feed(&mut s, &offer_from(&lo[0], now, 1));
    assert_eq!(s.links.len(), 2, "full: the offer is not answered");
    assert_eq!(s.counts.answers, 0);
}

#[tokio::test]
async fn a_failed_offer_backs_off_and_events_that_fail_the_checks_are_not_taken() {
    let (hi, _) = peers();
    let now = unix_now();
    let mut s = state(16).await;

    // Stale or forged presence is dropped, and a forgery does not hide the real event.
    feed(&mut s, &hi[0].connect(&room(), now - 120).unwrap());
    assert!(s.links.is_empty(), "too old");
    let real = hi[0].connect(&room(), now).unwrap();
    let mut forged = real.clone();
    forged.sig = "0".repeat(128);
    feed(&mut s, &forged);
    assert!(s.links.is_empty());
    feed(&mut s, &real);
    assert_eq!(s.links.len(), 1, "the real event is taken");

    // Unanswered past its deadline: failed, and the next presence brings no offer.
    s.links[0].deadline = Instant::now() - Duration::from_secs(1);
    s.timeout().await;
    s.pump_all();
    assert!(s.links.is_empty());
    assert_eq!(s.counts.failed, 1);
    feed(&mut s, &hi[0].connect(&room(), now + 1).unwrap());
    assert!(s.links.is_empty(), "backing off");
}

#[tokio::test]
async fn leaving_a_room_says_so_and_drops_its_connections() {
    let (hi, _) = peers();
    let mut s = state(16).await;
    feed(&mut s, &hi[0].connect(&room(), unix_now()).unwrap());
    assert_eq!(s.links.len(), 1);
    s.control(Control::Forget(vec![room().pubkey().to_owned()]))
        .await;
    assert!(s.rooms.is_empty());
    let bye = s.sent.last().unwrap();
    assert_eq!(tag(bye, "t"), Some("disconnect"));
    assert_eq!(tag(bye, "P"), Some(room().pubkey()));
    s.pump_all();
    assert!(s.links.is_empty());
    assert_eq!(s.counts.failed, 0, "leaving is no failure");
}

#[tokio::test]
async fn gathering_offers_the_mapping_a_stun_server_reports() {
    let mut s = state(16).await;
    let server: SocketAddr = "127.0.0.1:3478".parse().unwrap();
    s.stun.servers = vec![server];
    let now = Instant::now();
    s.stun_send(server, 0, now);
    let (&tid, _) = s.stun.pending.iter().next().unwrap();
    // A response from the server for that transaction, naming a public mapping.
    let mut resp = super::stun::binding_request(&tid).to_vec();
    resp[0..2].copy_from_slice(&0x0101u16.to_be_bytes());
    resp[3] = 12;
    let port = 40000u16 ^ 0x2112;
    let cookie = [0x21u8, 0x12, 0xa4, 0x42];
    resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0, 1]);
    resp.extend_from_slice(&port.to_be_bytes());
    resp.extend([203u8, 0, 113, 9].iter().zip(cookie).map(|(a, b)| a ^ b));
    // From anywhere else it is not taken.
    assert!(!s.stun_response(&resp, "127.0.0.1:9999".parse().unwrap()));
    assert!(s.stun_response(&resp, server));
    let kinds: Vec<String> = s
        .candidates()
        .iter()
        .map(|c| format!("{} {}", c.kind(), c.addr()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            format!("host {}", s.base),
            "srflx 203.0.113.9:40000".to_owned()
        ]
    );
    // A second answer to the same transaction is not taken.
    assert!(!s.stun_response(&resp, server));
}

/// One side of the simulated punch: an ICE agent behind a NAT that maps its one socket to one
/// public address for every destination (endpoint-independent mapping) and lets in only what
/// comes from an address the side has sent to (address- and port-dependent filtering): the
/// NAT test's "consistent" router.
struct Natted {
    rtc: Rtc,
    local: SocketAddr,
    public: SocketAddr,
    /// Destinations this side has sent to, as its NAT remembers them.
    sent_to: Vec<SocketAddr>,
    open: bool,
}

/// Run both sides until each sees the data channel open (true) or 30 simulated seconds pass.
/// A packet to a private address never crosses (the NATs route nothing between their LANs).
fn punch(a: &mut Natted, b: &mut Natted) -> bool {
    use str0m::net::{Protocol, Receive};
    use str0m::{Event as RtcEvent, Input, Output};
    let start = Instant::now();
    let mut now = start;
    while now < start + Duration::from_secs(30) {
        let mut wake = now + Duration::from_millis(50);
        for flip in [false, true] {
            let (src, dst) = if flip {
                (&mut *b, &mut *a)
            } else {
                (&mut *a, &mut *b)
            };
            while let Ok(out) = src.rtc.poll_output() {
                match out {
                    Output::Transmit(t) => {
                        assert_eq!(t.source, src.local, "every packet leaves the one socket");
                        if t.destination != dst.public {
                            continue;
                        }
                        src.sent_to.push(t.destination);
                        // The other NAT lets it in only if its side has sent to src's mapping.
                        if !dst.sent_to.contains(&src.public) {
                            continue;
                        }
                        let input = Input::Receive(
                            now,
                            Receive {
                                proto: Protocol::Udp,
                                source: src.public,
                                destination: dst.local,
                                contents: (&t.contents[..]).try_into().unwrap(),
                            },
                        );
                        if dst.rtc.accepts(&input) {
                            let _ = dst.rtc.handle_input(input);
                        }
                    }
                    Output::Event(RtcEvent::ChannelOpen(..)) => src.open = true,
                    Output::Event(_) => {}
                    Output::Timeout(t) => {
                        wake = wake.min(t);
                        break;
                    }
                }
            }
        }
        if a.open && b.open {
            return true;
        }
        now = wake.max(now + Duration::from_millis(1));
        let _ = a.rtc.handle_input(str0m::Input::Timeout(now));
        let _ = b.rtc.handle_input(str0m::Input::Timeout(now));
    }
    false
}

#[tokio::test]
async fn full_ice_punches_through_two_consistent_nats_where_ice_lite_cannot() {
    use str0m::change::SdpAnswer;
    let sa = |s: &str| -> SocketAddr { s.parse().unwrap() };
    // This node behind NAT A, its socket's mapping learnt from STUN; a browser behind NAT B.
    let (node_local, node_public) = (sa("192.168.10.2:5000"), sa("203.0.113.11:5000"));
    let (web_local, web_public) = (sa("192.168.20.2:6000"), sa("203.0.113.12:6000"));
    let mut s = state(16).await;
    s.base = node_local;
    s.host = Candidate::host(node_local, "udp").unwrap();
    s.stun.servers = vec![sa("203.0.113.1:3478")];
    s.stun.mapped.insert(sa("203.0.113.1:3478"), node_public);
    let browser_rtc = || {
        let mut rtc = Rtc::builder().build(Instant::now());
        rtc.add_local_candidate(Candidate::host(web_local, "udp").unwrap());
        rtc.add_local_candidate(Candidate::server_reflexive(web_public, web_local, "udp").unwrap());
        rtc
    };

    // The node offers, as its agent is built for a room: host and srflx candidates.
    let mut node = s.new_rtc(Instant::now());
    let mut api = node.sdp_api();
    api.add_channel("nfx".into());
    let (offer, pending) = api.apply().unwrap();
    let offer = offer.to_sdp_string();
    assert!(offer.contains("203.0.113.11 5000 typ srflx"), "{offer}");
    let mut web = browser_rtc();
    let answer = web
        .sdp_api()
        .accept_offer(
            SdpOffer::from_sdp_string(&super::sdp::filter_candidates(&offer, web_local)).unwrap(),
        )
        .unwrap()
        .to_sdp_string();
    node.sdp_api()
        .accept_answer(
            pending,
            SdpAnswer::from_sdp_string(&super::sdp::filter_candidates(&answer, node_local))
                .unwrap(),
        )
        .unwrap();
    let mut a = Natted {
        rtc: node,
        local: node_local,
        public: node_public,
        sent_to: vec![],
        open: false,
    };
    let mut b = Natted {
        rtc: web,
        local: web_local,
        public: web_public,
        sent_to: vec![],
        open: false,
    };
    assert!(punch(&mut a, &mut b), "both ends check, so both NATs open");

    // Control: an ICE-lite agent (the bridge's), told as the NAT's public address the way
    // `--bridge-public` tells it, sends no checks, so its NAT never lets the browser's in.
    let mut lite = Rtc::builder().set_ice_lite(true).build(Instant::now());
    lite.add_local_candidate(Candidate::host(node_public, "udp").unwrap());
    let mut web = browser_rtc();
    let mut api = web.sdp_api();
    api.add_channel("webtorrent".into());
    let (offer, pending) = api.apply().unwrap();
    let answer = lite
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&offer.to_sdp_string()).unwrap())
        .unwrap();
    web.sdp_api().accept_answer(pending, answer).unwrap();
    let mut a = Natted {
        rtc: lite,
        local: node_public,
        public: node_public,
        sent_to: vec![],
        open: false,
    };
    let mut b = Natted {
        rtc: web,
        local: web_local,
        public: web_public,
        sent_to: vec![],
        open: false,
    };
    assert!(!punch(&mut a, &mut b));
}
