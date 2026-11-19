//! STUN servers named over Nostr (NFX-10 §1): the STUN service announcement (kind 33478),
//! which an operator who runs a STUN server signs with its own key, and the rules every
//! client uses to pick STUN servers from what beacons and announcements name.
//!
//! STUN itself never travels over Nostr: it measures the public UDP mapping of the socket
//! WebRTC uses, which only a datagram to an outside server can reveal. What Nostr carries is
//! who runs STUN servers, and for which networks.
//!
//! - [`StunAnnouncement::from_event`]: a reader's checks of an announcement at `now`.
//! - [`tags`]: the tags a sender writes.
//! - [`is_global_unicast`] and [`usable`]: the addresses a client may take from Nostr.
//! - [`select`]: which STUN servers a client uses, its own first, at most [`MAX_SERVERS`].
//!
//! Pure: callers pass `now`.

use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr};

use crate::beacon::is_stun_addr;
use crate::event::Event;
use crate::hex32::parse_u64_strict;
use crate::namespace::Namespace;
use crate::{Error, MAX_CLOCK_SKEW, Result, Verified};

/// The STUN service announcement's kind (addressable: one per operator key and server).
/// The digits echo 3478, STUN's default port (RFC 8489).
pub const KIND_STUN_ANNOUNCEMENT: u16 = 33478;
/// The longest an announcement lives, `expiration - created_at`, in seconds (24 h).
pub const MAX_TTL: u64 = 24 * 60 * 60;
/// How often a sender signs its announcement again (12 h), so a fresh one is always out
/// before the last one expires.
pub const REANNOUNCE_EVERY: u64 = 12 * 60 * 60;
/// Most networks (`n` tags) one announcement names.
pub const MAX_NETWORKS: usize = 8;
/// Most STUN servers a client uses in all, its own included (NFX-10 §1's abuse bound).
pub const MAX_SERVERS: usize = 4;

/// An announcement that passed NFX-10 §1 at time `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StunAnnouncement {
    /// The signer: the operator's key, 64 lowercase hex.
    pub operator: String,
    /// The server, `ip:port` in canonical form and global unicast (the `d` tag).
    pub addr: String,
    /// The networks it serves (the `n` tags), in the order given.
    pub networks: Vec<Namespace>,
    pub created_at: u64,
    pub expiration: u64,
}

impl StunAnnouncement {
    /// Verify a kind-33478 event at `now` (unix seconds): the NIP-01 id and signature;
    /// exactly one `d`, a [`usable`] address; 1 to [`MAX_NETWORKS`] distinct `n`, each a
    /// namespace (NFX-01 §2); exactly one `expiration`, a plain decimal with
    /// `created_at < expiration ≤ created_at + MAX_TTL`, after `now`; `created_at` at most
    /// [`MAX_CLOCK_SKEW`] ahead of `now` (so `expiration` is at most 24 h ahead, give or take
    /// that skew); empty content. Other tags are ignored.
    pub fn from_event(event: &Event, now: u64) -> Result<Verified<Self>> {
        if event.kind != KIND_STUN_ANNOUNCEMENT {
            return Err(bad("wrong kind"));
        }
        event.verify()?;
        let addr = one(event, "d")?;
        if !is_stun_addr(addr) {
            return Err(bad("`d` is not an ip:port in canonical form"));
        }
        if !usable(addr) {
            return Err(bad("`d` is not a global unicast address"));
        }
        let mut networks: Vec<Namespace> = Vec::new();
        for values in event.tag_values("n") {
            let Some(raw) = values.first() else {
                return Err(bad("`n` tag has no value"));
            };
            let ns = Namespace::parse(raw)?;
            if networks.contains(&ns) {
                return Err(bad("`n` names a network twice"));
            }
            networks.push(ns);
        }
        if networks.is_empty() || networks.len() > MAX_NETWORKS {
            return Err(bad("1 to 8 `n` tags"));
        }
        let expiration =
            parse_u64_strict(one(event, "expiration")?).ok_or_else(|| bad("bad `expiration`"))?;
        if expiration <= event.created_at {
            return Err(bad("`expiration` is not after `created_at`"));
        }
        if expiration - event.created_at > MAX_TTL {
            return Err(bad("`expiration` more than 24 h after `created_at`"));
        }
        if event.created_at > now.saturating_add(MAX_CLOCK_SKEW) {
            return Err(bad("`created_at` more than 15 min ahead"));
        }
        if expiration <= now {
            return Err(bad("expired"));
        }
        if !event.content.is_empty() {
            return Err(bad("content is not empty"));
        }
        Ok(Verified::new(Self {
            operator: event.pubkey.clone(),
            addr: addr.to_owned(),
            networks,
            created_at: event.created_at,
            expiration,
        }))
    }

    /// Whether it names `network`: a client of that network may use it.
    #[must_use]
    pub fn serves(&self, network: &Namespace) -> bool {
        self.networks.contains(network)
    }

    /// Its address (NIP-01 `a` form): `33478:<operator>:<d>`, one per operator and server.
    #[must_use]
    pub fn coordinate(&self) -> String {
        format!("{KIND_STUN_ANNOUNCEMENT}:{}:{}", self.operator, self.addr)
    }
}

/// The tags of an announcement for `addr` serving `networks`, signed at `created_at` to live
/// `ttl` seconds (1 to [`MAX_TTL`]); checked as a reader checks them.
pub fn tags(
    addr: &str,
    networks: &[Namespace],
    created_at: u64,
    ttl: u64,
) -> Result<Vec<Vec<String>>> {
    if !is_stun_addr(addr) || !usable(addr) {
        return Err(bad("not a global unicast ip:port in canonical form"));
    }
    let distinct: BTreeSet<String> = networks.iter().map(ToString::to_string).collect();
    if networks.is_empty() || networks.len() > MAX_NETWORKS || distinct.len() != networks.len() {
        return Err(bad("1 to 8 distinct networks"));
    }
    if !(1..=MAX_TTL).contains(&ttl) {
        return Err(bad("a lifetime of 1 s to 24 h"));
    }
    let expiration = created_at
        .checked_add(ttl)
        .ok_or_else(|| bad("`expiration` overflows"))?;
    let mut out = vec![vec!["d".to_owned(), addr.to_owned()]];
    out.extend(networks.iter().map(|n| vec!["n".to_owned(), n.to_string()]));
    out.push(vec!["expiration".to_owned(), expiration.to_string()]);
    Ok(out)
}

/// Whether `ip` is global unicast, as NFX-10 §1 uses the term: for IPv4 none of "this
/// network" (0/8), private (10/8, 172.16/12, 192.168/16), shared (100.64/10), loopback
/// (127/8), link-local (169.254/16), IETF protocol assignments (192.0.0/24), benchmarking
/// (198.18/15), multicast (224/4) and reserved (240/4, the broadcast address included); for
/// IPv6, inside 2000::/3. An address named over Nostr that is not must never be contacted:
/// it would point a client at its own network. Documentation blocks pass: they reach
/// nothing, and point nowhere local.
#[must_use]
pub fn is_global_unicast(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v6) => (v6.segments()[0] & 0xe000) == 0x2000,
    }
}

/// Whether a client may take `addr` from Nostr: an `ip:port` in the canonical form of the
/// `stun` endpoint ([`is_stun_addr`]) whose address is [`is_global_unicast`].
#[must_use]
pub fn usable(addr: &str) -> bool {
    is_stun_addr(addr)
        && addr
            .parse::<SocketAddr>()
            .is_ok_and(|a| is_global_unicast(a.ip()))
}

/// The STUN servers a client uses (NFX-10 §1), at most `max` (NFX-10 says [`MAX_SERVERS`]):
///
/// 1. its own (`own`, as given, each once) first;
/// 2. then the servers named over Nostr, as `(key, addr)` pairs (a beacon's signer and each
///    address of its `stun` endpoint; an announcement's operator and its `d`): only
///    [`usable`] addresses, not its own, each counted once per distinct key, ranked by that
///    count (most first; ties in the order first named);
/// 3. a server named by one key alone is taken only when the client has none of its own and
///    no named server has two keys or more: a lone stranger's key adds no server beside a
///    better one.
pub fn select<'a, I>(own: &[String], named: I, max: usize) -> Vec<String>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut out: Vec<String> = Vec::new();
    for s in own {
        if out.len() < max && !out.contains(s) {
            out.push(s.clone());
        }
    }
    // By first naming: the address and the distinct keys that name it.
    let mut ranked: Vec<(&str, BTreeSet<&str>)> = Vec::new();
    for (key, addr) in named {
        if !usable(addr) || own.iter().any(|o| o == addr) {
            continue;
        }
        match ranked.iter_mut().find(|(a, _)| *a == addr) {
            Some((_, keys)) => {
                keys.insert(key);
            }
            None => ranked.push((addr, BTreeSet::from([key]))),
        }
    }
    // Stable: equal counts keep the order first named.
    ranked.sort_by_key(|(_, keys)| core::cmp::Reverse(keys.len()));
    let corroborated = ranked.first().is_some_and(|(_, k)| k.len() >= 2);
    let lone_ok = own.is_empty() && !corroborated;
    for (addr, keys) in ranked {
        if out.len() >= max {
            break;
        }
        if keys.len() >= 2 || lone_ok {
            out.push(addr.to_owned());
        }
    }
    out
}

/// The single value of a required tag.
fn one<'a>(event: &'a Event, name: &str) -> Result<&'a str> {
    match event.single_tag(name).map_err(|e| bad(&e))? {
        Some(values) => Ok(values[0].as_str()),
        None => Err(bad(&format!("missing `{name}` tag"))),
    }
}

fn bad(reason: &str) -> Error {
    Error::Event(format!("stun announcement: {reason}"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const SECRET: [u8; 32] = [7u8; 32];
    const NOW: u64 = 1_790_000_000;

    fn ns(s: &str) -> Namespace {
        Namespace::parse(s).unwrap()
    }

    fn announcement(tags: Vec<Vec<String>>, created_at: u64, content: &str) -> Event {
        Event::sign(
            &SECRET,
            created_at,
            KIND_STUN_ANNOUNCEMENT,
            tags,
            content.into(),
        )
        .unwrap()
    }

    fn good() -> Vec<Vec<String>> {
        tags("203.0.113.10:3478", &[ns("nfx:testnet:1")], NOW, MAX_TTL).unwrap()
    }

    #[test]
    fn a_sender_s_announcement_reads_back() {
        let ev = announcement(good(), NOW, "");
        let a = StunAnnouncement::from_event(&ev, NOW + 10).unwrap();
        assert_eq!(a.addr, "203.0.113.10:3478");
        assert_eq!(a.networks, [ns("nfx:testnet:1")]);
        assert_eq!(a.expiration, NOW + MAX_TTL);
        assert!(a.serves(&ns("nfx:testnet:1")));
        assert!(!a.serves(&ns("nfx:mainnet:1")));
        assert_eq!(
            a.coordinate(),
            format!("33478:{}:203.0.113.10:3478", ev.pubkey)
        );
        // It expires.
        assert!(StunAnnouncement::from_event(&ev, NOW + MAX_TTL).is_err());
        // Signed ahead of the reader's clock: within the skew, and no further.
        assert!(StunAnnouncement::from_event(&ev, NOW - MAX_CLOCK_SKEW).is_ok());
        assert!(StunAnnouncement::from_event(&ev, NOW - MAX_CLOCK_SKEW - 1).is_err());
    }

    #[test]
    fn a_sender_refuses_what_a_reader_would() {
        let t = |addr: &str, nets: &[&str], ttl: u64| {
            tags(
                addr,
                &nets.iter().map(|n| ns(n)).collect::<Vec<_>>(),
                NOW,
                ttl,
            )
        };
        assert!(t("10.0.0.1:3478", &["nfx:testnet:1"], 60).is_err());
        assert!(t("203.0.113.010:3478", &["nfx:testnet:1"], 60).is_err());
        assert!(t("203.0.113.10:3478", &[], 60).is_err());
        assert!(t("203.0.113.10:3478", &["nfx:testnet:1", "nfx:testnet:1"], 60).is_err());
        let nine: Vec<String> = (1..=9).map(|i| format!("nfx:t{i}:1")).collect();
        let nine: Vec<&str> = nine.iter().map(String::as_str).collect();
        assert!(t("203.0.113.10:3478", &nine, 60).is_err());
        assert!(t("203.0.113.10:3478", &["nfx:testnet:1"], 0).is_err());
        assert!(t("203.0.113.10:3478", &["nfx:testnet:1"], MAX_TTL + 1).is_err());
        assert!(t("[2001:db8::1]:3478", &nine[..8], MAX_TTL).is_ok());
    }

    #[test]
    fn a_reader_refuses_a_bad_shape() {
        let set = |name: &str, value: &str| {
            let mut t = good();
            for tag in &mut t {
                if tag[0] == name {
                    tag[1] = value.into();
                }
            }
            t
        };
        let mut no_n = good();
        no_n.retain(|t| t[0] != "n");
        let mut two_d = good();
        two_d.push(vec!["d".into(), "203.0.113.11:3478".into()]);
        for (why, tags, content) in [
            ("private d", set("d", "192.168.1.2:3478"), ""),
            ("hostname d", set("d", "stun.example:3478"), ""),
            ("bad n", set("n", "nutflix:testnet:1"), ""),
            ("no n", no_n, ""),
            ("two d", two_d, ""),
            (
                "expiration too far",
                set("expiration", &(NOW + MAX_TTL + 1).to_string()),
                "",
            ),
            ("expiration before", set("expiration", &NOW.to_string()), ""),
            ("expiration not decimal", set("expiration", "+90000"), ""),
            ("content", good(), "hello"),
        ] {
            let ev = announcement(tags, NOW, content);
            assert!(StunAnnouncement::from_event(&ev, NOW + 1).is_err(), "{why}");
        }
        // Another kind, or a forged signature.
        let mut ev = announcement(good(), NOW, "");
        ev.kind = 33477;
        assert!(StunAnnouncement::from_event(&ev, NOW + 1).is_err());
        let mut ev = announcement(good(), NOW, "");
        ev.created_at += 1;
        assert!(StunAnnouncement::from_event(&ev, NOW + 1).is_err());
    }

    #[test]
    fn global_unicast_is_what_points_nowhere_local() {
        for yes in [
            "8.8.8.8",
            "203.0.113.10",
            "198.51.100.7",
            "100.63.255.255",
            "100.128.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "223.255.255.255",
            "2001:db8::1",
            "2a01:4f8::1",
            "3fff:ffff::1",
        ] {
            assert!(is_global_unicast(yes.parse().unwrap()), "{yes}");
        }
        for no in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.0.9",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "4000::1",
        ] {
            assert!(!is_global_unicast(no.parse().unwrap()), "{no}");
        }
        assert!(usable("203.0.113.10:3478"));
        assert!(!usable("203.0.113.10:0"));
        assert!(!usable("[::ffff:203.0.113.10]:3478"));
    }

    #[test]
    fn selection_ranks_by_distinct_keys_and_takes_a_lone_key_last() {
        let own = |v: &[&str]| v.iter().map(ToString::to_string).collect::<Vec<_>>();
        let (x, y, z) = ("203.0.113.1:3478", "203.0.113.2:3478", "203.0.113.3:3478");
        // Ranked by distinct keys; a key counts once however often it names a server.
        let named = [
            ("k1", x),
            ("k1", y),
            ("k2", y),
            ("k3", y),
            ("k2", x),
            ("k4", z),
            ("k5", z),
            ("k6", z),
            ("k6", z),
        ];
        assert_eq!(select(&[], named, MAX_SERVERS), [y, z, x]);
        // A lone key: used when nothing better exists, never beside something better.
        assert_eq!(select(&[], [("k1", x)], MAX_SERVERS), [x]);
        assert_eq!(select(&[], [("k1", x), ("k1", x)], MAX_SERVERS), [x]);
        assert_eq!(
            select(&[], [("k1", x), ("k2", y), ("k3", y)], MAX_SERVERS),
            [y]
        );
        assert_eq!(
            select(&own(&["192.0.2.9:3478"]), [("k1", x)], 4),
            ["192.0.2.9:3478"]
        );
        // At most `max` in all, the client's own first and never twice.
        let many: Vec<(String, String)> = (1..=6)
            .flat_map(|i| {
                let a = format!("203.0.113.{i}:3478");
                [(format!("a{i}"), a.clone()), (format!("b{i}"), a)]
            })
            .collect();
        let pairs = many.iter().map(|(k, a)| (k.as_str(), a.as_str()));
        assert_eq!(
            select(&own(&["203.0.113.4:3478"]), pairs, MAX_SERVERS),
            [
                "203.0.113.4:3478",
                "203.0.113.1:3478",
                "203.0.113.2:3478",
                "203.0.113.3:3478"
            ]
        );
        // Private, loopback and non-canonical addresses are refused, however many keys.
        let refused = [
            "10.0.0.1:3478",
            "127.0.0.1:3478",
            "[::1]:3478",
            "203.0.113.010:3478",
        ];
        let pairs = refused.iter().flat_map(|a| [("k1", *a), ("k2", *a)]);
        assert!(select(&[], pairs, MAX_SERVERS).is_empty());
    }
}
