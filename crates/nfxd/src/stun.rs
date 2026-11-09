//! A minimal STUN Binding responder (RFC 8489), so that a network's own nfxd can be the STUN
//! server its web pages name in `iceServers` (NFX-10 §1): browsers learn their public UDP
//! mapping (a server-reflexive candidate) from it instead of from a third party.
//!
//! It answers one thing: a Binding request (RFC 8489 §6.3.1), with a success response that
//! carries XOR-MAPPED-ADDRESS (§14.2), the request's source address, and nothing else. There
//! is no TURN, no authentication, no other method and no other class:
//!
//! - **Anything else is dropped, silently.** A datagram is answered only if it is a
//!   well-formed STUN message (the first two bits zero, the magic cookie, a length that is a
//!   multiple of 4 and matches the datagram, attributes that tile the body exactly) of type
//!   Binding request, at most [`MAX_REQUEST`] bytes, with no comprehension-required attribute
//!   outside [`IGNORED_REQUIRED`]. RFC 8489 §6.3.1 would answer an unknown
//!   comprehension-required attribute with a 420 error; this responder sends nothing instead,
//!   so the only datagram it ever sends is the success response below. That also drops
//!   CHANGE-REQUEST and RESPONSE-PORT, so no request can send the answer elsewhere.
//! - **Bounded amplification.** The response is built from the request's transaction ID
//!   and its source address only, never from the request's attributes: 32 bytes for an IPv4
//!   source and [`MAX_RESPONSE`] (44) for IPv6, against a request of at least 20. No
//!   SOFTWARE attribute: it would only add bytes and name the software.
//! - **Rate-limited.** Token buckets per source (an IPv4 address, or an IPv6 /64), per
//!   prefix (an IPv4 /24, or an IPv6 /48) and for the whole responder bound what a spoofed
//!   source can make it send to a victim, and how much of the whole one network can take.
//!   An answer is counted only when all three allow it. The whole responder's cap is the
//!   bound on its output: a flood from many prefixes (spoofed or not) can still use it up,
//!   and browsers then gather no server-reflexive candidate and fall back as without STUN.
//! - **No logging, no memory of clients.** Nothing about a client, its address included, is
//!   ever printed. A bucket is kept only until it has refilled, and buckets are swept every
//!   [`SWEEP_EVERY`], so an address is forgotten at most that long after it was last
//!   answered at full rate.
//!
//! The mapping it reports is what the socket sees, so the responder must receive clients'
//! datagrams with their source addresses intact: a DNAT in front of it is fine, a proxy is
//! not. On a host with more than one address of a family, bind it to the address clients
//! reach (not `0.0.0.0` or `[::]`): an answer goes out from the address the route picks,
//! which may not be the one the client sent to, and its NAT would then drop it.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;

/// The magic cookie (RFC 8489 §5).
pub const MAGIC_COOKIE: u32 = 0x2112_A442;
/// The STUN header: type, length, magic cookie, transaction ID.
pub const HEADER_LEN: usize = 20;
/// The largest request answered. Browsers' Binding requests are a few dozen bytes.
pub const MAX_REQUEST: usize = 1280;
/// The largest response ever sent: the header and XOR-MAPPED-ADDRESS for IPv6 (4 + 20).
pub const MAX_RESPONSE: usize = HEADER_LEN + 24;
/// How often buckets that have refilled are forgotten.
pub const SWEEP_EVERY: Duration = Duration::from_secs(10);

const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// Comprehension-required attributes (type below 0x8000) a request may carry and still be
/// answered; their values are ignored. They are what an authenticating or ICE client adds:
/// USERNAME, MESSAGE-INTEGRITY, REALM, NONCE, MESSAGE-INTEGRITY-SHA256, USERHASH, PRIORITY
/// and USE-CANDIDATE. Comprehension-optional attributes (0x8000 and up) are always ignored.
pub const IGNORED_REQUIRED: [u16; 8] = [
    0x0006, 0x0008, 0x0014, 0x0015, 0x001C, 0x001E, 0x0024, 0x0025,
];

/// The Binding success response to `request` from `source`, or `None` if `request` is not
/// a Binding request this responder answers (module docs). Pure: no I/O, no state.
#[must_use]
pub fn respond(request: &[u8], source: SocketAddr) -> Option<Vec<u8>> {
    if request.len() < HEADER_LEN || request.len() > MAX_REQUEST {
        return None;
    }
    let typ = u16::from_be_bytes([request[0], request[1]]);
    let len = usize::from(u16::from_be_bytes([request[2], request[3]]));
    // The first two bits are zero in every STUN message (RFC 8489 §5); the type then must be
    // exactly Binding/request.
    if typ != BINDING_REQUEST
        || len % 4 != 0
        || len != request.len() - HEADER_LEN
        || request[4..8] != MAGIC_COOKIE.to_be_bytes()
    {
        return None;
    }
    if !attributes_ok(&request[HEADER_LEN..]) {
        return None;
    }
    let mut txid = [0u8; 12];
    txid.copy_from_slice(&request[8..20]);
    Some(success(&txid, source))
}

/// Whether `body` is a sequence of well-formed attributes (type, length, value padded to 4)
/// that ends exactly at its end, with no comprehension-required type this responder does
/// not know.
fn attributes_ok(mut body: &[u8]) -> bool {
    while !body.is_empty() {
        if body.len() < 4 {
            return false;
        }
        let typ = u16::from_be_bytes([body[0], body[1]]);
        let len = usize::from(u16::from_be_bytes([body[2], body[3]]));
        let padded = len.div_ceil(4) * 4;
        if body.len() - 4 < padded {
            return false;
        }
        if typ < 0x8000 && !IGNORED_REQUIRED.contains(&typ) {
            return false;
        }
        body = &body[4 + padded..];
    }
    true
}

/// An IPv4 client reaching a dual-stack socket shows as `::ffff:a.b.c.d`: as IPv4.
fn unmapped(addr: SocketAddr) -> SocketAddr {
    match addr {
        SocketAddr::V6(v6) => match v6.ip().to_ipv4_mapped() {
            Some(v4) => SocketAddr::new(IpAddr::V4(v4), v6.port()),
            None => addr,
        },
        SocketAddr::V4(_) => addr,
    }
}

/// A Binding success response with one attribute, XOR-MAPPED-ADDRESS (`source`).
fn success(txid: &[u8; 12], source: SocketAddr) -> Vec<u8> {
    let source = unmapped(source);
    let cookie = MAGIC_COOKIE.to_be_bytes();
    let port = source.port() ^ (MAGIC_COOKIE >> 16) as u16;
    let mut xma = Vec::with_capacity(20);
    match source.ip() {
        IpAddr::V4(ip) => {
            xma.extend_from_slice(&[0, 0x01]);
            xma.extend_from_slice(&port.to_be_bytes());
            xma.extend(ip.octets().iter().zip(cookie).map(|(a, k)| a ^ k));
        }
        IpAddr::V6(ip) => {
            xma.extend_from_slice(&[0, 0x02]);
            xma.extend_from_slice(&port.to_be_bytes());
            let key = cookie.iter().chain(txid.iter());
            xma.extend(ip.octets().iter().zip(key).map(|(a, k)| a ^ k));
        }
    }
    let attrs_len = 4 + xma.len();
    let mut out = Vec::with_capacity(HEADER_LEN + attrs_len);
    out.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
    out.extend_from_slice(&u16::try_from(attrs_len).unwrap_or(0).to_be_bytes());
    out.extend_from_slice(&cookie);
    out.extend_from_slice(txid);
    out.extend_from_slice(&XOR_MAPPED_ADDRESS.to_be_bytes());
    out.extend_from_slice(&u16::try_from(xma.len()).unwrap_or(0).to_be_bytes());
    out.extend_from_slice(&xma);
    out
}

/// The mapped address in `response`, if it is a Binding success response for `txid` that
/// carries a well-formed XOR-MAPPED-ADDRESS: the client side, for tests and probes.
#[must_use]
pub fn mapped_address(response: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    if response.len() < HEADER_LEN
        || response[0..2] != BINDING_SUCCESS.to_be_bytes()
        || usize::from(u16::from_be_bytes([response[2], response[3]]))
            != response.len() - HEADER_LEN
        || response[4..8] != MAGIC_COOKIE.to_be_bytes()
        || response[8..20] != txid[..]
    {
        return None;
    }
    let mut body = &response[HEADER_LEN..];
    while body.len() >= 4 {
        let typ = u16::from_be_bytes([body[0], body[1]]);
        let len = usize::from(u16::from_be_bytes([body[2], body[3]]));
        let value = body.get(4..4 + len)?;
        if typ == XOR_MAPPED_ADDRESS {
            let port =
                u16::from_be_bytes([*value.get(2)?, *value.get(3)?]) ^ (MAGIC_COOKIE >> 16) as u16;
            let key: Vec<u8> = MAGIC_COOKIE
                .to_be_bytes()
                .iter()
                .chain(txid)
                .copied()
                .collect();
            let ip = match (value.first(), value.get(1), len) {
                (Some(0), Some(1), 8) => {
                    let mut o = [0u8; 4];
                    o.iter_mut()
                        .zip(&value[4..8])
                        .zip(&key)
                        .for_each(|((o, v), k)| *o = v ^ k);
                    IpAddr::from(o)
                }
                (Some(0), Some(2), 20) => {
                    let mut o = [0u8; 16];
                    o.iter_mut()
                        .zip(&value[4..20])
                        .zip(&key)
                        .for_each(|((o, v), k)| *o = v ^ k);
                    IpAddr::from(o)
                }
                _ => return None,
            };
            return Some(SocketAddr::new(ip, port));
        }
        body = body.get(4 + len.div_ceil(4) * 4..)?;
    }
    None
}

/// How many answers the responder may send: per source, per prefix, and in all. Each pair
/// is a token bucket's size (answers at once) and refill (answers a second).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub per_source_burst: f64,
    pub per_source_rate: f64,
    pub per_prefix_burst: f64,
    pub per_prefix_rate: f64,
    pub total_burst: f64,
    pub total_rate: f64,
    /// Sources (and, separately, prefixes) tracked at once. When full, a new one is not
    /// answered until a sweep (at most once a second while full) frees a bucket.
    pub max_tracked: usize,
}

impl Default for Limits {
    /// Generous to a carrier-grade NAT (many viewers behind one IPv4 address, each browser
    /// asking once per gathering and every ~10 s while a candidate is in use), and small in
    /// what one source can make it send: 16 answers a second, 32 bytes each, ~4 kbit/s. One
    /// prefix takes at most a sixteenth of the whole.
    fn default() -> Self {
        Self {
            per_source_burst: 64.0,
            per_source_rate: 16.0,
            per_prefix_burst: 512.0,
            per_prefix_rate: 256.0,
            total_burst: 8192.0,
            total_rate: 4096.0,
            max_tracked: 65_536,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn full(burst: f64, at: Instant) -> Self {
        Self { tokens: burst, at }
    }

    /// Refill to `now`; whether a token is there to take.
    fn refill(&mut self, now: Instant, burst: f64, rate: f64) -> bool {
        let dt = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens = (self.tokens + dt * rate).min(burst);
        self.at = now;
        self.tokens >= 1.0
    }

    /// Whether it would be full at `now`: it then holds nothing worth keeping.
    fn refilled(&self, now: Instant, burst: f64, rate: f64) -> bool {
        self.tokens + now.saturating_duration_since(self.at).as_secs_f64() * rate >= burst
    }
}

/// Token buckets: per source, per prefix, and one for all. The clock is passed in, so tests
/// drive it.
#[derive(Debug)]
pub struct RateLimiter {
    limits: Limits,
    sources: HashMap<IpAddr, Bucket>,
    prefixes: HashMap<IpAddr, Bucket>,
    total: Bucket,
    last_full_sweep: Instant,
}

impl RateLimiter {
    #[must_use]
    pub fn new(limits: Limits, now: Instant) -> Self {
        Self {
            limits,
            sources: HashMap::new(),
            prefixes: HashMap::new(),
            total: Bucket::full(limits.total_burst, now),
            last_full_sweep: now,
        }
    }

    /// Whether an answer to `source` may go out at `now`. If so, it is counted in all three
    /// buckets; if not, in none.
    pub fn allow(&mut self, source: IpAddr, now: Instant) -> bool {
        let l = self.limits;
        let (skey, pkey) = (source_key(source), prefix_key(source));
        let new = !self.sources.contains_key(&skey) || !self.prefixes.contains_key(&pkey);
        if new && (self.sources.len() >= l.max_tracked || self.prefixes.len() >= l.max_tracked) {
            // Full: a flood of new (spoofed) sources costs a sweep a second, not one a
            // datagram.
            if now.saturating_duration_since(self.last_full_sweep) < Duration::from_secs(1) {
                return false;
            }
            self.last_full_sweep = now;
            self.sweep(now);
            if self.sources.len() >= l.max_tracked || self.prefixes.len() >= l.max_tracked {
                return false;
            }
        }
        let s = self
            .sources
            .entry(skey)
            .or_insert_with(|| Bucket::full(l.per_source_burst, now));
        let s_ok = s.refill(now, l.per_source_burst, l.per_source_rate);
        let p = self
            .prefixes
            .entry(pkey)
            .or_insert_with(|| Bucket::full(l.per_prefix_burst, now));
        let p_ok = p.refill(now, l.per_prefix_burst, l.per_prefix_rate);
        let t_ok = self.total.refill(now, l.total_burst, l.total_rate);
        if !(s_ok && p_ok && t_ok) {
            return false;
        }
        for bucket in [
            self.sources.get_mut(&skey),
            self.prefixes.get_mut(&pkey),
            Some(&mut self.total),
        ]
        .into_iter()
        .flatten()
        {
            bucket.tokens -= 1.0;
        }
        true
    }

    /// Forget every source and prefix whose bucket has refilled.
    pub fn sweep(&mut self, now: Instant) {
        let l = self.limits;
        self.sources
            .retain(|_, b| !b.refilled(now, l.per_source_burst, l.per_source_rate));
        self.prefixes
            .retain(|_, b| !b.refilled(now, l.per_prefix_burst, l.per_prefix_rate));
    }

    /// Sources and prefixes tracked now.
    #[must_use]
    pub fn tracked(&self) -> (usize, usize) {
        (self.sources.len(), self.prefixes.len())
    }
}

/// What a source is counted as: an IPv4 address (also when it arrives IPv4-mapped), or the
/// /64 of an IPv6 address, which one subscriber usually holds whole.
#[must_use]
pub fn source_key(ip: IpAddr) -> IpAddr {
    masked(ip, 32, 64)
}

/// The prefix a source belongs to: an IPv4 /24, or an IPv6 /48 (a site).
#[must_use]
pub fn prefix_key(ip: IpAddr) -> IpAddr {
    masked(ip, 24, 48)
}

fn masked(ip: IpAddr, v4_bits: u32, v6_bits: u32) -> IpAddr {
    let ip = unmapped(SocketAddr::new(ip, 0)).ip();
    match ip {
        IpAddr::V4(v4) => IpAddr::V4(Ipv4Addr::from_bits(
            v4.to_bits() & (u32::MAX << (32 - v4_bits)),
        )),
        IpAddr::V6(v6) => IpAddr::V6(Ipv6Addr::from_bits(
            v6.to_bits() & (u128::MAX << (128 - v6_bits)),
        )),
    }
}

/// Whether a receive error is one datagram's (an ICMP error for an earlier answer, or on
/// Windows a datagram larger than the buffer), so the next one can be read at once.
fn transient(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::{ConnectionRefused, ConnectionReset};
    // WSAEMSGSIZE, which Windows returns for a datagram larger than the buffer.
    const WSAEMSGSIZE: i32 = 10040;
    matches!(e.kind(), ConnectionRefused | ConnectionReset)
        || (cfg!(windows) && e.raw_os_error() == Some(WSAEMSGSIZE))
}

/// Answer Binding requests on `socket` until the task is dropped. Errors on one datagram
/// (an ICMP error surfacing as a failed receive, a refused send) never stop it.
pub async fn serve(socket: UdpSocket, limits: Limits) {
    let mut limiter = RateLimiter::new(limits, Instant::now());
    let mut sweep = tokio::time::interval(SWEEP_EVERY);
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // One byte more than the largest request answered, so a longer datagram shows as longer
    // (its header length then disagrees with what was read) instead of fitting by truncation.
    let mut buf = [0u8; MAX_REQUEST + 1];
    loop {
        let received = tokio::select! {
            r = socket.recv_from(&mut buf) => r,
            _ = sweep.tick() => {
                limiter.sweep(Instant::now());
                continue;
            }
        };
        let (n, source) = match received {
            Ok(got) => got,
            Err(e) if transient(&e) => continue,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(10)).await;
                continue;
            }
        };
        let Some(response) = respond(&buf[..n], source) else {
            continue;
        };
        if limiter.allow(source.ip(), Instant::now()) {
            let _ = socket.send_to(&response, source).await;
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::cast_possible_truncation)]

    use std::net::SocketAddrV6;

    use super::*;

    fn request(txid: [u8; 12], attrs: &[u8]) -> Vec<u8> {
        let mut r = Vec::new();
        r.extend_from_slice(&BINDING_REQUEST.to_be_bytes());
        r.extend_from_slice(&(attrs.len() as u16).to_be_bytes());
        r.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        r.extend_from_slice(&txid);
        r.extend_from_slice(attrs);
        r
    }

    fn attr(typ: u16, value: &[u8]) -> Vec<u8> {
        let mut a = Vec::new();
        a.extend_from_slice(&typ.to_be_bytes());
        a.extend_from_slice(&(value.len() as u16).to_be_bytes());
        a.extend_from_slice(value);
        a.resize(a.len().div_ceil(4) * 4, 0);
        a
    }

    /// Decode a response this module built, checking its shape: exactly one attribute,
    /// XOR-MAPPED-ADDRESS. Returns (transaction ID, mapped address).
    fn decode(resp: &[u8]) -> ([u8; 12], SocketAddr) {
        assert_eq!(u16::from_be_bytes([resp[0], resp[1]]), BINDING_SUCCESS);
        assert_eq!(
            usize::from(u16::from_be_bytes([resp[2], resp[3]])),
            resp.len() - HEADER_LEN
        );
        assert_eq!(resp[4..8], MAGIC_COOKIE.to_be_bytes());
        assert_eq!(u16::from_be_bytes([resp[20], resp[21]]), XOR_MAPPED_ADDRESS);
        let len = usize::from(u16::from_be_bytes([resp[22], resp[23]]));
        assert_eq!(resp.len(), HEADER_LEN + 4 + len, "one attribute only");
        let txid: [u8; 12] = resp[8..20].try_into().unwrap();
        (txid, mapped_address(resp, &txid).unwrap())
    }

    const TX: [u8; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    #[test]
    fn answers_a_bare_binding_request() {
        let from: SocketAddr = "203.0.113.7:51000".parse().unwrap();
        let resp = respond(&request(TX, &[]), from).unwrap();
        assert_eq!(resp.len(), HEADER_LEN + 12);
        assert_eq!(decode(&resp), (TX, from));
    }

    #[test]
    fn rfc5769_ipv4_and_ipv6_xor_mapped_address() {
        // RFC 5769 §2.2 and §2.3: the responses' XOR-MAPPED-ADDRESS bytes for these sources
        // and this transaction ID.
        let txid = [
            0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
        ];
        let v4 = respond(&request(txid, &[]), "192.0.2.1:32853".parse().unwrap()).unwrap();
        assert_eq!(
            v4[20..],
            [
                0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43
            ]
        );
        let v6 = respond(
            &request(txid, &[]),
            "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
                .parse()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            v6[20..],
            [
                0x00, 0x20, 0x00, 0x14, 0x00, 0x02, 0xa1, 0x47, 0x01, 0x13, 0xa9, 0xfa, 0xa5, 0xd3,
                0xf1, 0x79, 0xbc, 0x25, 0xf4, 0xb5, 0xbe, 0xd2, 0xb9, 0xd9
            ]
        );
        assert_eq!(v6.len(), MAX_RESPONSE);
    }

    #[test]
    fn an_ipv4_mapped_source_is_reported_as_ipv4() {
        let mapped = SocketAddr::V6(SocketAddrV6::new(
            Ipv4Addr::new(198, 51, 100, 9).to_ipv6_mapped(),
            4000,
            0,
            0,
        ));
        let (_, got) = decode(&respond(&request(TX, &[]), mapped).unwrap());
        assert_eq!(got, "198.51.100.9:4000".parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn ignores_known_and_optional_attributes() {
        let attrs = [
            attr(0x0006, b"user:name"),
            attr(0x0024, &[0, 0, 0, 1]),
            attr(0x8022, b"some client"),
            attr(0x8028, &[0, 0, 0, 0]),
            attr(0x0008, &[0; 20]),
        ]
        .concat();
        let from: SocketAddr = "203.0.113.7:1".parse().unwrap();
        let resp = respond(&request(TX, &attrs), from).unwrap();
        // Built from the transaction ID and the source only, never from what was sent.
        assert_eq!(resp, respond(&request(TX, &[]), from).unwrap());
    }

    #[test]
    fn drops_everything_else() {
        let from: SocketAddr = "203.0.113.7:1".parse().unwrap();
        let ok = request(TX, &[]);
        let with = |f: &dyn Fn(&mut Vec<u8>)| {
            let mut r = ok.clone();
            f(&mut r);
            r
        };
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("empty", vec![]),
            ("short header", ok[..19].to_vec()),
            (
                "RFC 3489 (no cookie)",
                with(&|r| r[4..8].copy_from_slice(&[0, 0, 0, 0])),
            ),
            ("top bits set", with(&|r| r[0] |= 0xc0)),
            (
                "success response",
                with(&|r| r[0..2].copy_from_slice(&BINDING_SUCCESS.to_be_bytes())),
            ),
            (
                "indication",
                with(&|r| r[0..2].copy_from_slice(&0x0011u16.to_be_bytes())),
            ),
            (
                "error response",
                with(&|r| r[0..2].copy_from_slice(&0x0111u16.to_be_bytes())),
            ),
            (
                "allocate (TURN)",
                with(&|r| r[0..2].copy_from_slice(&0x0003u16.to_be_bytes())),
            ),
            (
                "length too long",
                with(&|r| r[2..4].copy_from_slice(&4u16.to_be_bytes())),
            ),
            ("length not a multiple of 4", request(TX, &[0, 0, 0])),
            ("trailing bytes", [ok.clone(), vec![0, 0, 0, 0]].concat()),
            ("truncated attribute header", request(TX, &[0x80, 0x22])),
            (
                "attribute overruns",
                request(TX, &[0x80, 0x22, 0x00, 0x08, b'a', b'b', b'c', b'd']),
            ),
            (
                "unknown required attribute",
                request(TX, &attr(0x0003, &[0, 0, 0, 0])),
            ),
            ("CHANGE-REQUEST", request(TX, &attr(0x0003, &[0, 0, 0, 6]))),
            (
                "RESPONSE-PORT",
                request(TX, &attr(0x0027, &[0x0d, 0x96, 0, 0])),
            ),
            (
                "MAPPED-ADDRESS in a request",
                request(TX, &attr(0x0001, &[0; 8])),
            ),
            (
                "too large",
                request(TX, &attr(0x8022, &vec![b'x'; MAX_REQUEST])),
            ),
        ];
        for (name, bytes) in cases {
            assert_eq!(respond(&bytes, from), None, "{name}");
        }
    }

    /// xorshift64*: deterministic, so a failure names its seed and iteration.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    /// An independent oracle for "a Binding request this responder answers", written
    /// differently from `respond`: the whole datagram as header fields, then the attribute
    /// list walked by offsets.
    fn answerable(b: &[u8]) -> bool {
        if b.len() < 20 || b.len() > MAX_REQUEST {
            return false;
        }
        let declared = (usize::from(b[2]) << 8) | usize::from(b[3]);
        if b[0] != 0 || b[1] != 1 || b[4..8] != [0x21, 0x12, 0xa4, 0x42] || declared + 20 != b.len()
        {
            return false;
        }
        let mut at = 20;
        while at < b.len() {
            if at + 4 > b.len() {
                return false;
            }
            let t = (u16::from(b[at]) << 8) | u16::from(b[at + 1]);
            let l = (usize::from(b[at + 2]) << 8) | usize::from(b[at + 3]);
            let next = at + 4 + l + (4 - l % 4) % 4;
            if next > b.len() || (t < 0x8000 && !IGNORED_REQUIRED.contains(&t)) {
                return false;
            }
            at = next;
        }
        true
    }

    /// Random datagrams, and valid requests mutated at random: never a panic; an answer
    /// exactly when the independent oracle says so; and every answer a Binding success with
    /// one attribute, for the request's own transaction ID and source (an IPv4-mapped one
    /// as IPv4), no larger than `MAX_RESPONSE`.
    #[test]
    fn fuzz_random_and_mutated_datagrams() {
        let sources: [SocketAddr; 4] = [
            "203.0.113.200:65535".parse().unwrap(),
            "[2001:db8::42]:1".parse().unwrap(),
            "0.0.0.0:0".parse().unwrap(),
            "[::ffff:192.0.2.9]:3478".parse().unwrap(),
        ];
        let seeds = [
            request(TX, &[]),
            request(
                TX,
                &[attr(0x0006, b"u:p"), attr(0x8028, &[1, 2, 3, 4])].concat(),
            ),
        ];
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut answered = 0;
        for i in 0..200_000 {
            let bytes: Vec<u8> = if i % 2 == 0 {
                let len = match rng.below(4) {
                    0 => rng.below(HEADER_LEN + 8),
                    1 => HEADER_LEN + 4 * rng.below(8),
                    _ => rng.below(MAX_REQUEST + 64),
                };
                let mut b: Vec<u8> = (0..len).map(|_| rng.next() as u8).collect();
                if b.len() >= 8 && rng.below(2) == 0 {
                    // Often a plausible header, so the attribute walk is reached.
                    b[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
                    let body_len = (b.len() - HEADER_LEN.min(b.len())) as u16;
                    b[2..4].copy_from_slice(&body_len.to_be_bytes());
                    b[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
                }
                b
            } else {
                let mut b = seeds[rng.below(seeds.len())].clone();
                for _ in 0..=rng.below(4) {
                    match rng.below(3) {
                        0 => {
                            let at = rng.below(b.len());
                            b[at] ^= 1 << rng.below(8);
                        }
                        1 => b.truncate(rng.below(b.len() + 1)),
                        _ => b.extend((0..rng.below(9)).map(|_| rng.next() as u8)),
                    }
                    if b.is_empty() {
                        break;
                    }
                }
                b
            };
            let source = sources[rng.below(sources.len())];
            let resp = respond(&bytes, source);
            assert_eq!(
                resp.is_some(),
                answerable(&bytes),
                "iteration {i}: {bytes:02x?}"
            );
            if let Some(resp) = resp {
                answered += 1;
                assert!(resp.len() <= MAX_RESPONSE, "iteration {i}");
                let (txid, mapped) = decode(&resp);
                assert_eq!(txid[..], bytes[8..20], "iteration {i}");
                assert_eq!(mapped, unmapped(source), "iteration {i}");
            }
        }
        assert!(
            answered > 1000,
            "the fuzz reached the answering path only {answered} times"
        );
    }

    fn limits(source: (f64, f64), prefix: (f64, f64), total: (f64, f64), max: usize) -> Limits {
        Limits {
            per_source_burst: source.0,
            per_source_rate: source.1,
            per_prefix_burst: prefix.0,
            per_prefix_rate: prefix.1,
            total_burst: total.0,
            total_rate: total.1,
            max_tracked: max,
        }
    }

    #[test]
    fn rate_limit_per_source_per_prefix_and_in_all() {
        let t0 = Instant::now();
        let ip = |s: &str| -> IpAddr { s.parse().unwrap() };
        let mut rl = RateLimiter::new(limits((3.0, 1.0), (1e6, 0.0), (1e6, 0.0), 1000), t0);
        let a = ip("203.0.113.1");
        assert_eq!((0..5).filter(|_| rl.allow(a, t0)).count(), 3, "a's burst");
        assert!(rl.allow(ip("203.0.113.2"), t0), "b has its own bucket");
        // One second later a has one token again.
        let t1 = t0 + Duration::from_secs(1);
        assert!(rl.allow(a, t1));
        assert!(!rl.allow(a, t1));

        // A prefix: 4 at once across all its sources; another /24 is not held back.
        let mut rl = RateLimiter::new(limits((100.0, 0.0), (4.0, 0.0), (1e6, 0.0), 1000), t0);
        let in_24 = (0..10u8)
            .filter(|i| rl.allow(IpAddr::from([198, 51, 100, *i]), t0))
            .count();
        assert_eq!(in_24, 4);
        assert!(rl.allow(ip("198.51.101.1"), t0));
        let mut rl = RateLimiter::new(limits((100.0, 0.0), (4.0, 0.0), (1e6, 0.0), 1000), t0);
        let in_48 = (0..10u16)
            .filter(|i| {
                rl.allow(
                    IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 7, *i, 0, 0, 0, 1)),
                    t0,
                )
            })
            .count();
        assert_eq!(in_48, 4, "ten /64s of one /48");

        // The whole responder: 5 at once from 20 prefixes, then 10 a second.
        let mut rl = RateLimiter::new(limits((10.0, 0.0), (10.0, 0.0), (5.0, 10.0), 1000), t0);
        let many = (0..20u8)
            .filter(|i| rl.allow(IpAddr::from([198, 51, *i, 1]), t0))
            .count();
        assert_eq!(many, 5);
        let later = (20..40u8)
            .filter(|i| {
                rl.allow(
                    IpAddr::from([198, 51, *i, 1]),
                    t0 + Duration::from_millis(500),
                )
            })
            .count();
        assert_eq!(later, 5, "0.5 s at 10/s");
    }

    #[test]
    fn a_denied_answer_costs_its_source_nothing() {
        let t0 = Instant::now();
        let ip = |s: &str| -> IpAddr { s.parse().unwrap() };
        let a = ip("203.0.113.1");
        let mut rl = RateLimiter::new(limits((2.0, 0.0), (100.0, 0.0), (3.0, 0.3), 1000), t0);
        // Two other sources empty the whole responder's bucket.
        assert_eq!(
            (0..2).filter(|_| rl.allow(ip("198.51.100.1"), t0)).count(),
            2
        );
        assert!(rl.allow(ip("198.51.100.2"), t0));
        // a is denied, again and again, while it is empty.
        for _ in 0..10 {
            assert!(!rl.allow(a, t0));
        }
        // Once there is room again, a still has its whole burst: no denial was charged to it.
        let t10 = t0 + Duration::from_secs(10);
        assert_eq!((0..5).filter(|_| rl.allow(a, t10)).count(), 2);
    }

    #[test]
    fn ipv6_counts_by_64_and_mapped_v4_as_v4() {
        let t0 = Instant::now();
        let mut rl = RateLimiter::new(limits((2.0, 0.0), (100.0, 0.0), (100.0, 0.0), 100), t0);
        let ok = (0..10u16)
            .filter(|i| {
                rl.allow(
                    IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 1, *i, 0, 0, 1)),
                    t0,
                )
            })
            .count();
        assert_eq!(ok, 2, "one /64, one bucket");
        assert!(
            rl.allow(
                IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 0, 2, 0, 0, 0, 1)),
                t0
            ),
            "another /64"
        );
        let v4: IpAddr = "192.0.2.5".parse().unwrap();
        let mapped = IpAddr::V6(Ipv4Addr::new(192, 0, 2, 5).to_ipv6_mapped());
        assert!(rl.allow(v4, t0));
        assert!(rl.allow(mapped, t0));
        assert!(!rl.allow(v4, t0), "the mapped form shares the IPv4 bucket");
        assert_eq!(prefix_key(mapped), "192.0.2.0".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn the_tables_are_bounded_and_forget() {
        let t0 = Instant::now();
        let mut rl = RateLimiter::new(limits((2.0, 1.0), (2.0, 1.0), (1e9, 1e9), 4), t0);
        for i in 0..4u8 {
            assert!(rl.allow(IpAddr::from([198, 51, i, 1]), t0));
        }
        let new: IpAddr = "198.51.200.1".parse().unwrap();
        assert!(!rl.allow(new, t0), "full: a new source waits");
        assert_eq!(rl.tracked(), (4, 4));
        // Still full and within the second: no sweep yet, whatever the buckets hold.
        assert!(!rl.allow(new, t0 + Duration::from_millis(900)));
        // 2 s later every bucket has refilled: the next new source sweeps them out.
        let t2 = t0 + Duration::from_secs(2);
        assert!(rl.allow(new, t2));
        assert_eq!(rl.tracked(), (1, 1));
        // The periodic sweep forgets a source once its bucket is full again, full table or not.
        rl.sweep(t2 + Duration::from_millis(100));
        assert_eq!(rl.tracked(), (1, 1), "not refilled yet");
        rl.sweep(t2 + Duration::from_secs(2));
        assert_eq!(rl.tracked(), (0, 0));
    }

    async fn responder(
        limits: Limits,
        bind: &str,
    ) -> Option<(SocketAddr, tokio::task::JoinHandle<()>)> {
        let socket = UdpSocket::bind(bind).await.ok()?;
        let addr = socket.local_addr().unwrap();
        Some((addr, tokio::spawn(serve(socket, limits))))
    }

    async fn reply(client: &UdpSocket) -> Option<Vec<u8>> {
        let mut buf = [0u8; 1500];
        let n = tokio::time::timeout(Duration::from_millis(500), client.recv(&mut buf))
            .await
            .ok()?
            .ok()?;
        Some(buf[..n].to_vec())
    }

    #[tokio::test]
    async fn a_binding_round_trip_on_loopback_v4_v6_and_dual_stack() {
        for (server, client) in [
            ("127.0.0.1:0", "127.0.0.1:0"),
            ("[::1]:0", "[::1]:0"),
            // An IPv4 client of a dual-stack socket: answered as IPv4.
            ("[::]:0", "127.0.0.1:0"),
        ] {
            let Some((addr, task)) = responder(Limits::default(), server).await else {
                assert!(server.starts_with('['), "IPv4 loopback must bind");
                continue; // no IPv6 here
            };
            let target = if client.starts_with('[') || !server.starts_with('[') {
                addr
            } else {
                SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), addr.port())
            };
            let c = UdpSocket::bind(client).await.unwrap();
            c.connect(target).await.unwrap();
            c.send(&request(TX, &[])).await.unwrap();
            let Some(resp) = reply(&c).await else {
                // A host whose [::] is IPv6-only (net.ipv6.bindv6only) has no dual stack.
                assert_eq!(server, "[::]:0", "no answer");
                task.abort();
                continue;
            };
            assert_eq!(
                mapped_address(&resp, &TX),
                Some(c.local_addr().unwrap()),
                "{server}"
            );
            task.abort();
        }
    }

    #[tokio::test]
    async fn malformed_datagrams_get_nothing_and_do_not_stop_it() {
        let (addr, task) = responder(Limits::default(), "127.0.0.1:0").await.unwrap();
        let c = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        c.connect(addr).await.unwrap();
        let mut response_class = request(TX, &[]);
        response_class[0..2].copy_from_slice(&BINDING_SUCCESS.to_be_bytes());
        // A valid header and attributes, 1300 bytes: over the limit, and longer than the
        // buffer, so it can only be read truncated (the length then disagrees).
        let oversized = request(TX, &attr(0x8022, &[b'x'; 1300 - HEADER_LEN - 4]));
        assert_eq!(oversized.len(), 1300);
        for junk in [
            vec![],
            vec![0u8; 3],
            b"GET / HTTP/1.1\r\n\r\n".to_vec(),
            response_class,
            vec![0xff; 1500],
            oversized,
        ] {
            c.send(&junk).await.unwrap();
        }
        assert_eq!(reply(&c).await, None, "nothing for any of them");
        let tx2 = [7u8; 12];
        c.send(&request(tx2, &[])).await.unwrap();
        let resp = reply(&c).await.expect("still answering");
        assert_eq!(mapped_address(&resp, &tx2), Some(c.local_addr().unwrap()));
        task.abort();
    }

    #[tokio::test]
    async fn the_rate_limit_holds_on_the_wire_per_source_address() {
        let (addr, task) = responder(
            limits((3.0, 0.0), (100.0, 0.0), (1000.0, 0.0), 16),
            "127.0.0.1:0",
        )
        .await
        .unwrap();
        let c = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        c.connect(addr).await.unwrap();
        for i in 0..8u8 {
            c.send(&request([i; 12], &[])).await.unwrap();
        }
        let mut got = 0;
        while let Some(resp) = reply(&c).await {
            assert!(mapped_address(&resp, resp[8..20].try_into().unwrap()).is_some());
            got += 1;
        }
        assert_eq!(got, 3, "the burst, then nothing");
        // Another port on the same address shares the bucket: it is per source address.
        let c2 = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        c2.connect(addr).await.unwrap();
        c2.send(&request(TX, &[])).await.unwrap();
        assert_eq!(reply(&c2).await, None);
        task.abort();
    }

    #[test]
    fn mapped_address_refuses_what_is_not_our_answer() {
        let from: SocketAddr = "203.0.113.7:51000".parse().unwrap();
        let resp = respond(&request(TX, &[]), from).unwrap();
        assert_eq!(mapped_address(&resp, &TX), Some(from));
        assert_eq!(mapped_address(&resp, &[0; 12]), None, "another transaction");
        assert_eq!(mapped_address(&resp[..resp.len() - 1], &TX), None);
        assert_eq!(mapped_address(&request(TX, &[]), &TX), None, "a request");
        let mut rng = Rng(7);
        for _ in 0..50_000 {
            let mut r = resp.clone();
            let at = rng.below(r.len());
            r[at] ^= 1 << rng.below(8);
            let _ = mapped_address(&r, &TX); // never panics
        }
    }
}
