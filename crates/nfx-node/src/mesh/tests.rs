//! Unit tests of the mesh endpoint's signaling rules, driven event by event with no relay:
//! the glare rule, the bounds, failure and backoff, and leaving a room; and the STUN servers it
//! learns from beacons, the creator's for routine use and any seeder's for the fallback
//! (NFX-10 §1).

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
use super::{
    Control, MAX_NAMED, MAX_PEERS_PER_ROOM, MeshStatus, NAMED_PER_KEY, NostrStun, RoomState, State,
    Stun, StunFallback,
};
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
        public: None,
        stun: Stun::new(vec![], now),
        nostr_stun: None,
        fallback: StunFallback::default(),
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
            video: "nfx:mainnet:1:salt-flats-dusk".into(),
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
    s.control(Control::Forget(
        vec![room().pubkey().to_owned()],
        "nfx:mainnet:1:salt-flats-dusk".into(),
    ))
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
    // A configured server (`--mesh-stun`): trusted with what it reports.
    let server: SocketAddr = "127.0.0.1:3478".parse().unwrap();
    s.stun.servers = vec![server];
    s.stun.configured = vec![server];
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
/// NAT test's "consistent" router. Or, `forwarded`, behind a DNAT that forwards its public
/// address to the socket and lets in what comes from anywhere.
struct Natted {
    rtc: Rtc,
    public: SocketAddr,
    /// Where the side takes every datagram as sent: its socket's address, or for a node told
    /// its public address, that address ([`State::arrival`]). Its ICE agent sends from it.
    arrives_as: SocketAddr,
    /// A DNAT's forwarded port: no filtering.
    forwarded: bool,
    /// Destinations this side has sent to, as its NAT remembers them.
    sent_to: Vec<SocketAddr>,
    open: bool,
}

impl Natted {
    /// A side whose socket is at `local`, behind a NAT that maps it to `public`.
    fn new(rtc: Rtc, local: SocketAddr, public: SocketAddr) -> Self {
        Self {
            rtc,
            public,
            arrives_as: local,
            forwarded: false,
            sent_to: vec![],
            open: false,
        }
    }
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
                        assert_eq!(
                            t.source, src.arrives_as,
                            "every packet leaves the one socket"
                        );
                        if t.destination != dst.public {
                            continue;
                        }
                        src.sent_to.push(t.destination);
                        // The other NAT lets it in only if its side has sent to src's mapping
                        // (a DNAT's forwarded port lets in everything).
                        if !dst.forwarded && !dst.sent_to.contains(&src.public) {
                            continue;
                        }
                        let input = Input::Receive(
                            now,
                            Receive {
                                proto: Protocol::Udp,
                                source: src.public,
                                destination: dst.arrives_as,
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
    let mut a = Natted::new(node, node_local, node_public);
    let mut b = Natted::new(web, web_local, web_public);
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
    let mut a = Natted::new(lite, node_public, node_public);
    let mut b = Natted::new(web, web_local, web_public);
    assert!(!punch(&mut a, &mut b));
}

/// What a candidate set comes to, as the status line shows it.
fn kinds(s: &State) -> Vec<String> {
    s.candidates()
        .iter()
        .map(|c| format!("{} {}", c.kind(), c.addr()))
        .collect()
}

/// The `a=candidate` lines of an SDP.
fn candidate_lines(sdp: &str) -> Vec<&str> {
    sdp.lines()
        .filter(|l| l.starts_with("a=candidate:"))
        .collect()
}

#[tokio::test]
async fn with_a_public_address_it_is_offered_first_and_no_address_that_is_not_public() {
    let sa = |s: &str| -> SocketAddr { s.parse().unwrap() };
    // Bound behind a DNAT on a private address. The public address is offered as given
    // (nfxd refuses one that is not public; a documentation address stands in for it here).
    let mut s = state(16).await;
    s.base = sa("10.0.0.28:7845");
    assert_eq!(kinds(&s), ["host 10.0.0.28:7845"], "without one, as before");
    s.public = Some(sa("203.0.113.7:7845"));
    assert_eq!(s.arrival(), sa("203.0.113.7:7845"));
    assert_eq!(
        kinds(&s),
        ["host 203.0.113.7:7845"],
        "the bound address is left out"
    );

    // STUN beside it: a mapping equal to the public address is offered once, a private one
    // (a STUN server inside the DNAT) not at all, and another public one is kept. So is a
    // public one the gateway maps.
    let servers = [
        sa("198.51.100.1:3478"),
        sa("198.51.100.2:3478"),
        sa("198.51.100.3:3478"),
    ];
    s.stun.servers = servers.to_vec();
    s.stun.mapped.insert(servers[0], sa("203.0.113.7:7845"));
    s.stun.mapped.insert(servers[1], sa("192.168.1.2:40000"));
    s.stun.mapped.insert(servers[2], sa("8.8.8.8:41000"));
    s.portmapped = Some(sa("198.18.0.9:7845"));
    assert_eq!(
        kinds(&s),
        ["host 203.0.113.7:7845", "srflx 8.8.8.8:41000"],
        "a benchmarking-range mapping is not public either"
    );
    s.portmapped = Some(sa("8.8.4.4:7845"));
    assert_eq!(
        kinds(&s),
        [
            "host 203.0.113.7:7845",
            "srflx 8.8.8.8:41000",
            "srflx 8.8.4.4:7845"
        ]
    );

    // Every SDP the node sends, offer or answer, names those and nothing derived from the
    // addresses left out: str0m writes no raddr of ours, and its foundations hash the base,
    // which is the public address.
    let mut rtc = s.new_rtc(Instant::now());
    let mut api = rtc.sdp_api();
    api.add_channel("nfx".into());
    let (offer, _) = api.apply().unwrap();
    let offer = offer.to_sdp_string();
    let (_, _, browser) = browser_offer();
    let answer = s
        .new_rtc(Instant::now())
        .sdp_api()
        .accept_offer(SdpOffer::from_sdp_string(&browser).unwrap())
        .unwrap()
        .to_sdp_string();
    for sdp in [&offer, &answer] {
        let lines = candidate_lines(sdp);
        assert_eq!(lines.len(), 3, "{sdp}");
        assert!(lines[0].contains("203.0.113.7 7845 typ host"), "{sdp}");
        assert!(
            lines[1].contains("8.8.8.8 41000 typ srflx raddr 0.0.0.0"),
            "{sdp}"
        );
        assert!(
            lines[2].contains("8.8.4.4 7845 typ srflx raddr 0.0.0.0"),
            "{sdp}"
        );
        for private in ["10.0.0.28", "192.168.1.2", "198.18.0.9"] {
            assert!(!sdp.contains(private), "{private} in {sdp}");
        }
    }
    // The srflx candidates' base is the public address, as every datagram's arrival is
    // (Candidate's equality takes in the base).
    let srflx = |base: &str| Candidate::server_reflexive(sa("8.8.8.8:41000"), sa(base), "udp");
    assert_eq!(s.candidates()[1], srflx("203.0.113.7:7845").unwrap());
    assert_ne!(s.candidates()[1], srflx("10.0.0.28:7845").unwrap());

    // A host on a public address keeps it, beside the public address (as iroh's external
    // addresses keep a node's public direct ones).
    s.stun.servers.clear();
    s.portmapped = None;
    s.base = sa("8.8.4.4:7845");
    assert_eq!(kinds(&s), ["host 203.0.113.7:7845", "host 8.8.4.4:7845"]);
    s.base = sa("203.0.113.7:7845");
    assert_eq!(
        kinds(&s),
        ["host 203.0.113.7:7845"],
        "the same address once"
    );
}

#[tokio::test]
async fn behind_a_dnat_full_ice_connects_through_the_public_address_it_is_told() {
    use str0m::change::SdpAnswer;
    let sa = |s: &str| -> SocketAddr { s.parse().unwrap() };
    // This node in a guest behind a DNAT: no STUN mapping (its STUN server would be itself,
    // through a hairpin) and no gateway to map a port. A browser behind a consistent NAT.
    let (node_local, node_public) = (sa("10.0.0.28:7845"), sa("203.0.113.11:7845"));
    let (web_local, web_public) = (sa("192.168.20.2:6000"), sa("203.0.113.12:6000"));
    let browser_rtc = || {
        let mut rtc = Rtc::builder().build(Instant::now());
        rtc.add_local_candidate(Candidate::host(web_local, "udp").unwrap());
        rtc.add_local_candidate(Candidate::server_reflexive(web_public, web_local, "udp").unwrap());
        rtc
    };
    // Negotiate as the node offers, both sides filtering what they check.
    let negotiate = |s: &State| {
        let mut node = s.new_rtc(Instant::now());
        let mut api = node.sdp_api();
        api.add_channel("nfx".into());
        let (offer, pending) = api.apply().unwrap();
        let offer = offer.to_sdp_string();
        let mut web = browser_rtc();
        let answer = web
            .sdp_api()
            .accept_offer(
                SdpOffer::from_sdp_string(&super::sdp::filter_candidates(&offer, web_local))
                    .unwrap(),
            )
            .unwrap()
            .to_sdp_string();
        node.sdp_api()
            .accept_answer(
                pending,
                SdpAnswer::from_sdp_string(&super::sdp::filter_candidates(&answer, s.base))
                    .unwrap(),
            )
            .unwrap();
        (node, web, offer)
    };
    let dnat = |rtc: Rtc, s: &State| Natted {
        arrives_as: s.arrival(),
        forwarded: true,
        ..Natted::new(rtc, node_local, node_public)
    };

    let mut s = state(16).await;
    s.base = node_local;
    s.public = Some(node_public);
    let (node, web, offer) = negotiate(&s);
    assert_eq!(candidate_lines(&offer).len(), 1, "{offer}");
    assert!(offer.contains("203.0.113.11 7845 typ host"), "{offer}");
    assert!(!offer.contains("10.0.0.28"), "{offer}");
    let mut a = dnat(node, &s);
    let mut b = Natted::new(web, web_local, web_public);
    assert!(
        punch(&mut a, &mut b),
        "the browser checks the public address, the DNAT forwards it, and the node answers"
    );

    // Control: the same node not told its public address offers only the bound one, which
    // the browser cannot reach; the node's own checks reach the browser's NAT from an address
    // its side never sent to, so they are dropped. No connection.
    s.public = None;
    let (node, web, offer) = negotiate(&s);
    assert!(offer.contains("10.0.0.28 7845 typ host"), "{offer}");
    let mut a = dnat(node, &s);
    let mut b = Natted::new(web, web_local, web_public);
    assert!(!punch(&mut a, &mut b));
}

// ---- STUN from Nostr (NFX-10 §1) -----------------------------------------------------------

/// The secret of the watched video's creator: `beacon(CREATOR, …)` is the creator's own beacon.
const CREATOR: u8 = 0x51;

/// The manifest address the STUN tests watch (the room's video, `SWARM`).
fn watched_a() -> String {
    let creator = nfx_proto::event::public_key_hex(&[CREATOR; 32]).unwrap();
    format!("38504:{creator}:nfx:mainnet:1:salt-flats-dusk")
}

/// A beacon for the watched video by seeder `k` (the creator when `k` is [`CREATOR`]), with an
/// `https` endpoint and, when `stun` is not empty, a `stun` endpoint naming it.
fn beacon(k: u8, stun: &[&str], created_at: u64) -> Event {
    use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint};
    use nfx_proto::namespace::VideoAddr;
    let mut endpoints = vec![Endpoint::Https {
        url: "https://seed.example/nfx".into(),
        renditions: vec![],
    }];
    if !stun.is_empty() {
        endpoints.push(Endpoint::Stun {
            addrs: stun.iter().map(ToString::to_string).collect(),
        });
    }
    let content = BeaconContent {
        v: 1,
        video: VideoAddr::parse("nfx:mainnet:1:salt-flats-dusk").unwrap(),
        endpoints,
        skipped: vec![],
        chunks: Chunks::All,
        price_hint: 0,
        accepts_mints: vec![],
        free: true,
    };
    let tags = nfx_proto::beacon::tags(&watched_a(), created_at, 120).unwrap();
    Event::sign(
        &[k; 32],
        created_at,
        nfx_proto::KIND_BEACON,
        tags,
        content.to_content(),
    )
    .unwrap()
}

/// An announcement of `addr` for `network` by operator `k`: valid, and never read by the mesh.
fn announcement(k: u8, addr: &str, network: &str, created_at: u64) -> Event {
    let nets = [nfx_proto::namespace::Namespace::parse(network).unwrap()];
    let tags = nfx_proto::stun::tags(addr, &nets, created_at, 3600).unwrap();
    Event::sign(
        &[k; 32],
        created_at,
        nfx_proto::KIND_STUN_ANNOUNCEMENT,
        tags,
        String::new(),
    )
    .unwrap()
}

fn servers(s: &State) -> Vec<String> {
    s.stun.servers.iter().map(ToString::to_string).collect()
}

/// Only a beacon the video's creator signed names STUN servers the endpoint asks beside its
/// own (NFX-10 §1): global unicast, on a port of 1024 or above, of its family, at most 4, the
/// configured ones first. Strangers' beacons add none, however many keys name a server, and
/// announcements are not even read.
#[tokio::test]
async fn only_the_creator_s_beacon_names_the_stun_servers_it_asks() {
    let mut s = state(16).await;
    s.nostr_stun = Some(NostrStun::default());
    s.nostr_stun.as_mut().unwrap().watched.insert(watched_a());
    let now = unix_now();
    let (x, y) = ("1.1.1.1:3478", "1.0.0.1:3478");

    // Two keys that are not the creator's name a server, then a third: none is asked (keys
    // are free). Nor one that announcements name, the creator's own key's included.
    feed(&mut s, &beacon(1, &[y], now));
    feed(&mut s, &beacon(2, &[y], now));
    assert!(servers(&s).is_empty());
    feed(&mut s, &beacon(3, &[y], now));
    for k in [4, 5, CREATOR] {
        feed(&mut s, &announcement(k, y, "nfx:mainnet:1", now));
    }
    assert!(servers(&s).is_empty());
    // The creator's beacon names one: it is asked, at once.
    feed(&mut s, &beacon(CREATOR, &[x], now));
    assert_eq!(servers(&s), [x]);
    assert!(
        s.stun
            .pending
            .values()
            .any(|(server, _, _)| server.to_string() == x)
    );
    // Not even the creator's: a port below 1024, a private address (a beacon may name one;
    // NFX-10 §1 refuses it as a client), another family. Nor a beacon of a video not watched
    // (it is checked by its `a` before its signature).
    let refused = ["1.0.0.2:53", "10.0.0.1:3478", "[2606:4700::1111]:3478", x];
    feed(&mut s, &beacon(CREATOR, &refused, now + 1));
    assert_eq!(servers(&s), [x]);
    let mut other = beacon(CREATOR, &["8.8.8.8:3478"], now + 2);
    other.tags[1][1] = other.tags[1][1].replace("salt-flats-dusk", "other");
    feed(&mut s, &other);
    assert_eq!(servers(&s), [x]);
    // The creator's newer beacon without a `stun` endpoint withdraws what it named...
    feed(&mut s, &beacon(CREATOR, &[], now + 3));
    assert!(servers(&s).is_empty());
    // ...and its older beacon, replayed, changes nothing.
    feed(&mut s, &beacon(CREATOR, &[x], now - 5));
    assert!(servers(&s).is_empty());
    // At most 4 in all, the configured ones first.
    let own: SocketAddr = "9.9.9.9:3478".parse().unwrap();
    s.stun.configured = vec![own];
    let four = [
        "1.1.1.21:3478",
        "1.1.1.22:3478",
        "1.1.1.23:3478",
        "1.1.1.24:3478",
    ];
    feed(&mut s, &beacon(CREATOR, &four, now + 4));
    let got = servers(&s);
    assert_eq!(got, ["9.9.9.9:3478", four[0], four[1], four[2]]);
    assert_eq!(s.status.lock().unwrap().stun, got, "the status names them");

    // A key that is not the creator's holds at most NAMED_PER_KEY sources; a creator's beacon
    // is kept however many strangers' fill the table (there is one per video watched).
    let n = s.nostr_stun.as_mut().unwrap();
    let source = |addr: &str, creator: bool| super::Named {
        created_at: now,
        expiration: now + 60,
        heard: 0,
        addrs: vec![addr.to_owned()],
        creator,
    };
    let before = n.named.len();
    let mut kept = 0;
    for i in 0..20u8 {
        let a = format!("38504:k:nfx:mainnet:1:v{i}");
        if n.note(
            "k",
            a,
            source(&format!("1.0.0.{}:3478", 100 + i), false),
            now,
        ) {
            kept += 1;
        }
    }
    assert_eq!(kept, NAMED_PER_KEY);
    assert_eq!(n.named.len(), before + NAMED_PER_KEY);
    let mut i = 0u32;
    while n.named.len() < MAX_NAMED {
        let signer = format!("s{i}");
        n.note(
            &signer,
            "38504:x:nfx:mainnet:1:v".into(),
            source(y, false),
            now,
        );
        i += 1;
    }
    let late = source(y, false);
    assert!(!n.note("late", "38504:x:nfx:mainnet:1:v".into(), late, now));
    let theirs = source("1.0.0.9:3478", true);
    assert!(n.note("c", "38504:c:nfx:mainnet:1:w".into(), theirs, now));
    assert!(n.creator_named(now).contains(&"1.0.0.9:3478".to_owned()));
    // Strangers' sources never count as the creator's.
    assert!(!n.creator_named(now).contains(&y.to_owned()));
    // And what expires is no longer counted.
    assert!(
        !n.creator_named(now + 61)
            .contains(&"1.0.0.9:3478".to_owned())
    );
}

/// A mapping a server learnt over Nostr reports is offered only if it is global unicast: a
/// lying server cannot point peers at a private address. A configured server is trusted.
#[tokio::test]
async fn a_learnt_server_s_private_mapping_is_never_offered() {
    let mut s = state(16).await;
    let learnt: SocketAddr = "1.1.1.1:3478".parse().unwrap();
    let configured: SocketAddr = "127.0.0.1:3478".parse().unwrap();
    s.stun.configured = vec![configured];
    s.stun.servers = vec![configured, learnt];
    let respond = |s: &mut State, server: SocketAddr, mapped: [u8; 4], port: u16| {
        s.stun_send(server, 0, Instant::now());
        let (&tid, _) = s
            .stun
            .pending
            .iter()
            .find(|(_, (srv, _, _))| *srv == server)
            .unwrap();
        let mut resp = super::stun::binding_request(&tid).to_vec();
        resp[0..2].copy_from_slice(&0x0101u16.to_be_bytes());
        resp[3] = 12;
        resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0, 1]);
        resp.extend_from_slice(&(port ^ 0x2112).to_be_bytes());
        resp.extend(
            mapped
                .iter()
                .zip([0x21u8, 0x12, 0xa4, 0x42])
                .map(|(a, b)| a ^ b),
        );
        assert!(s.stun_response(&resp, server));
    };
    respond(&mut s, learnt, [192, 168, 1, 2], 40000);
    respond(&mut s, configured, [10, 0, 0, 7], 40001);
    let kinds: Vec<String> = s
        .candidates()
        .iter()
        .map(|c| format!("{} {}", c.kind(), c.addr()))
        .collect();
    assert_eq!(
        kinds,
        [
            format!("host {}", s.base),
            "srflx 10.0.0.7:40001".to_owned()
        ]
    );
    // Nor a documentation address, which routes nowhere.
    respond(&mut s, learnt, [203, 0, 113, 99], 40003);
    assert_eq!(s.candidates().len(), 2);
    // A global unicast one from the same learnt server is offered.
    respond(&mut s, learnt, [1, 1, 1, 99], 40002);
    assert!(
        s.candidates()
            .iter()
            .any(|c| c.addr() == "1.1.1.99:40002".parse::<SocketAddr>().unwrap())
    );
}

/// Forgetting a video stops reading its beacons and drops what they named, the creator's and
/// every seeder's.
#[tokio::test]
async fn forgetting_a_video_drops_the_stun_servers_its_beacons_named() {
    let mut s = state(16).await;
    s.nostr_stun = Some(NostrStun::default());
    s.control(Control::Beacons(watched_a())).await;
    assert!(
        s.nostr_stun
            .as_ref()
            .unwrap()
            .watched
            .contains(&watched_a())
    );
    let now = unix_now();
    feed(&mut s, &beacon(CREATOR, &["1.1.1.1:3478"], now));
    feed(&mut s, &beacon(2, &["1.0.0.1:3478"], now));
    assert_eq!(servers(&s), ["1.1.1.1:3478"]);
    assert_eq!(s.nostr_stun.as_ref().unwrap().named.len(), 2);
    s.control(Control::Forget(
        vec![room().pubkey().to_owned()],
        "nfx:mainnet:1:salt-flats-dusk".into(),
    ))
    .await;
    let n = s.nostr_stun.as_ref().unwrap();
    assert!(n.watched.is_empty() && n.named.is_empty());
    assert!(servers(&s).is_empty());
}

/// The creator's first beacon heard may name no STUN server: it is kept until it expires, so
/// its older beacon, replayed, does not name one again. A beacon with more `stun` endpoints
/// than one counts at most 4 addresses.
#[tokio::test]
async fn a_withdrawal_heard_first_holds_and_a_beacon_names_at_most_four() {
    use nfx_proto::beacon::{BeaconContent, Chunks, Endpoint};
    use nfx_proto::namespace::VideoAddr;
    let mut s = state(16).await;
    s.nostr_stun = Some(NostrStun::default());
    s.nostr_stun.as_mut().unwrap().watched.insert(watched_a());
    let now = unix_now();
    feed(&mut s, &beacon(CREATOR, &[], now));
    feed(&mut s, &beacon(CREATOR, &["1.1.1.1:3478"], now - 5));
    assert!(servers(&s).is_empty());
    // Many endpoints in one beacon: the first 4 distinct addresses count, no more.
    let endpoints: Vec<Endpoint> = (0..6u8)
        .map(|i| Endpoint::Stun {
            addrs: vec![format!("1.1.1.{}:3478", i + 31)],
        })
        .collect();
    let content = BeaconContent {
        v: 1,
        video: VideoAddr::parse("nfx:mainnet:1:salt-flats-dusk").unwrap(),
        endpoints,
        skipped: vec![],
        chunks: Chunks::All,
        price_hint: 0,
        accepts_mints: vec![],
        free: true,
    };
    let tags = nfx_proto::beacon::tags(&watched_a(), now + 1, 120).unwrap();
    let many = Event::sign(
        &[CREATOR; 32],
        now + 1,
        nfx_proto::KIND_BEACON,
        tags,
        content.to_content(),
    )
    .unwrap();
    feed(&mut s, &many);
    let held = s.nostr_stun.as_mut().unwrap().creator_named(now);
    assert_eq!(held.len(), super::MAX_STUN_ADDRS, "{held:?}");
}

/// An offer from `peer` whose one candidate is at `candidate`.
fn offer_at(peer: &Session, candidate: &str, at: u64, nonce: u8) -> Event {
    let mut rtc = Rtc::builder().build(Instant::now());
    rtc.add_local_candidate(Candidate::host(candidate.parse().unwrap(), "udp").unwrap());
    let mut api = rtc.sdp_api();
    api.add_channel("webtorrent".into());
    let (offer, _pending) = api.apply().unwrap();
    let me = Session::new(ME, [9; 16]).unwrap();
    peer.offer(
        &room(),
        me.pubkey(),
        &offer.to_sdp_string(),
        &[nonce; 32],
        at,
    )
    .unwrap()
}

/// A Binding success from `server` for the request pending to it, reporting `mapped`.
fn stun_reply(s: &mut State, server: SocketAddr, mapped: [u8; 4], port: u16) {
    let (&tid, _) = s
        .stun
        .pending
        .iter()
        .find(|(_, (srv, _, _))| *srv == server)
        .expect("a request to that server");
    let mut resp = super::stun::binding_request(&tid).to_vec();
    resp[0..2].copy_from_slice(&0x0101u16.to_be_bytes());
    resp[3] = 12;
    resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0, 1]);
    resp.extend_from_slice(&(port ^ 0x2112).to_be_bytes());
    resp.extend(
        mapped
            .iter()
            .zip([0x21u8, 0x12, 0xa4, 0x42])
            .map(|(a, b)| a ^ b),
    );
    assert!(s.stun_response(&resp, server));
}

fn asks(s: &State, server: SocketAddr) -> bool {
    s.stun.pending.values().any(|(a, _, _)| *a == server)
}

/// NFX-10 §1's fallback: with its own STUN silent, the node asks the server of a seeder's
/// beacon only at the address of a peer it is signaling with, never one an announcement
/// names (announcements are not even read); the mapping goes to that peer's connection only;
/// and its own server's mapping ends it.
#[tokio::test]
async fn own_stun_failing_falls_back_only_to_a_signaled_seeder_s_server() {
    let mut s = state(16).await;
    s.base = "192.168.1.5:40000".parse().unwrap();
    s.nostr_stun = Some(NostrStun::default());
    s.nostr_stun.as_mut().unwrap().watched.insert(watched_a());
    let own: SocketAddr = "9.9.9.9:3478".parse().unwrap();
    s.stun.configured = vec![own];
    s.stun.servers = vec![own];
    let now = unix_now();
    let key = room().pubkey().to_owned();
    let (seeder, announced): (SocketAddr, SocketAddr) = (
        "1.1.1.1:3478".parse().unwrap(),
        "8.8.8.8:3478".parse().unwrap(),
    );
    let (_, lo) = peers();

    // A seeder's beacon names one server, an operator announces another: neither is asked
    // beside its own (the seeder is not the creator).
    feed(&mut s, &beacon(1, &["1.1.1.1:3478"], now));
    feed(
        &mut s,
        &announcement(2, "8.8.8.8:3478", "nfx:mainnet:1", now),
    );
    assert_eq!(servers(&s), [own.to_string()]);

    // A peer at the announced server's address: an announcement is never taken.
    feed(&mut s, &offer_at(&lo[0], "8.8.8.8:50000", now, 1));
    assert!(s.fallback.servers.is_empty() && !asks(&s, announced));
    // A peer at another address: that seeder is not one it is signaling with.
    feed(&mut s, &offer_at(&lo[1], "1.0.0.1:50000", now, 2));
    assert!(s.fallback.servers.is_empty() && !asks(&s, seeder));

    // A peer at the beacon's address, but in a room of another video: not a seeder of this one.
    s.rooms.get_mut(&key).unwrap().video = "nfx:mainnet:1:another-video".into();
    feed(&mut s, &offer_at(&lo[2], "1.1.1.1:50000", now, 3));
    assert!(s.fallback.servers.is_empty() && !asks(&s, seeder));
    s.rooms.get_mut(&key).unwrap().video = "nfx:mainnet:1:salt-flats-dusk".into();

    // A peer at the beacon's address: asked at once, one server, counted in the status.
    s.select_fallback(Instant::now(), true);
    assert_eq!(s.fallback.servers.len(), 1);
    assert_eq!(s.fallback.servers[0].1, seeder);
    assert!(asks(&s, seeder));
    assert!(s.status.lock().unwrap().stun.contains(&seeder.to_string()));

    // Its mapping is for that peer's connection alone, never every SDP.
    stun_reply(&mut s, seeder, [1, 2, 3, 4], 41000);
    let mapping: SocketAddr = "1.2.3.4:41000".parse().unwrap();
    assert!(!s.candidates().iter().any(|c| c.addr() == mapping));
    assert_eq!(s.fallback_mappings(&key, lo[2].pubkey()), [mapping]);
    assert!(s.fallback_mappings(&key, lo[1].pubkey()).is_empty());
    assert!(s.no_mapping(), "a fallback's mapping is not its own");

    // A mapping from its own server ends the fallback, and what it reported.
    s.stun_send(own, 0, Instant::now());
    stun_reply(&mut s, own, [5, 6, 7, 8], 42000);
    assert!(s.fallback.servers.is_empty() && s.fallback.mapped.is_empty());
    assert!(s.fallback_mappings(&key, lo[2].pubkey()).is_empty());
}

/// The fallback keeps to 4 STUN servers in all, one per seeder, and stops asking a server
/// once no peer it signals with is at its address.
#[tokio::test]
async fn the_fallback_keeps_to_four_servers_and_to_peers_still_there() {
    let mut s = state(16).await;
    s.base = "192.168.1.5:40000".parse().unwrap();
    s.nostr_stun = Some(NostrStun::default());
    s.nostr_stun.as_mut().unwrap().watched.insert(watched_a());
    let own: Vec<SocketAddr> = ["9.9.9.9:3478", "9.9.9.10:3478"]
        .iter()
        .map(|a| a.parse().unwrap())
        .collect();
    s.stun.configured.clone_from(&own);
    s.stun.servers.clone_from(&own);
    let now = unix_now();
    let (_, lo) = peers();
    // Three seeders, the first naming two servers at its address.
    feed(&mut s, &beacon(1, &["1.1.1.1:3478", "1.1.1.1:19302"], now));
    feed(&mut s, &beacon(2, &["1.0.0.1:3478"], now));
    feed(&mut s, &beacon(3, &["8.8.8.8:3478"], now));
    for (i, addr) in ["1.1.1.1:50000", "1.0.0.1:50000", "8.8.8.8:50000"]
        .iter()
        .enumerate()
    {
        let n = u8::try_from(i).unwrap();
        feed(&mut s, &offer_at(&lo[i], addr, now, n + 1));
    }
    let got: Vec<String> = s
        .fallback
        .servers
        .iter()
        .map(|(_, a)| a.to_string())
        .collect();
    assert_eq!(got.len(), 2, "two of its own, so two more: {got:?}");
    assert_eq!(got[0], "1.1.1.1:3478", "one per seeder");

    // The peers go: their links die and they hold no presence, so the servers are dropped.
    for l in &mut s.links {
        l.conn.dead = true;
    }
    s.select_fallback(Instant::now(), false);
    assert!(s.fallback.peers.is_empty() && s.fallback.servers.is_empty());
}

/// With no STUN server of its own, the node falls back too (NFX-10 §1): asking none, it has no
/// mapping once gathering ends, so a seeder's server at a signaled peer's address is asked.
/// The creator's server, asked and silent, leaves it so; its mapping ends the fallback.
#[tokio::test]
async fn with_no_stun_server_of_its_own_it_falls_back_too() {
    let mut s = state(16).await;
    s.base = "192.168.1.5:40000".parse().unwrap();
    s.nostr_stun = Some(NostrStun::default());
    s.nostr_stun.as_mut().unwrap().watched.insert(watched_a());
    let now = unix_now();
    let (seeder, creator): (SocketAddr, SocketAddr) = (
        "1.1.1.1:3478".parse().unwrap(),
        "1.0.0.1:3478".parse().unwrap(),
    );
    let (_, lo) = peers();
    assert!(s.no_mapping(), "no server at all, and gathering has ended");

    // A seeder's beacon is not asked beside nothing; at a signaled peer's address it is.
    feed(&mut s, &beacon(1, &["1.1.1.1:3478"], now));
    assert!(servers(&s).is_empty());
    feed(&mut s, &offer_at(&lo[0], "1.1.1.1:50000", now, 1));
    let got: Vec<SocketAddr> = s.fallback.servers.iter().map(|(_, a)| *a).collect();
    assert_eq!(got, [seeder]);
    assert!(asks(&s, seeder));

    // The creator names a server: asked beside it, and while it is silent the fallback holds.
    feed(&mut s, &beacon(CREATOR, &["1.0.0.1:3478"], now));
    assert_eq!(servers(&s), [creator.to_string()]);
    assert!(asks(&s, creator));
    assert_eq!(s.fallback.servers.len(), 1);
    assert!(s.no_mapping());

    // The creator's server reports a mapping: the fallback ends.
    stun_reply(&mut s, creator, [5, 6, 7, 8], 42000);
    assert!(!s.no_mapping());
    assert!(s.fallback.servers.is_empty() && s.fallback.mapped.is_empty());
}
