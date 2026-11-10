//! What of a peer's SDP reaches the ICE agent. A full agent sends connectivity checks to every
//! candidate the remote SDP names, so a stranger's offer or answer decides where this node
//! sends packets. Before str0m reads one, its candidate lines are cut to those worth
//! checking: UDP, of the socket's address family, an address a peer can really have, and at
//! most [`MAX_REMOTE_CANDIDATES`], none on a well-known port. (A browser's agent checks
//! whatever a page's peer names; this is narrower.)

use std::net::{IpAddr, SocketAddr};

use str0m::Candidate;
use str0m::net::Protocol;

/// Remote candidates kept from one SDP.
pub const MAX_REMOTE_CANDIDATES: usize = 8;

/// Remote candidates on a port below this are not checked: a browser's or a node's ICE ports
/// are ephemeral or mapped ones, and a well-known port is a service a stranger's SDP would
/// point this node's checks at (DNS, NTP, SNMP, SSDP, and so on).
pub const MIN_REMOTE_PORT: u16 = 1024;

/// Whether this node, its socket at `local`, sends checks to a remote candidate at `addr`:
/// the same family, a port of at least [`MIN_REMOTE_PORT`], not unspecified, multicast,
/// broadcast, link-local or an IPv4-mapped IPv6 address, and loopback exactly when `local` is
/// loopback (a socket on loopback reaches nothing else, and one off it must not be pointed at
/// its own host).
#[must_use]
pub fn checkable(addr: SocketAddr, local: SocketAddr) -> bool {
    if addr.port() < MIN_REMOTE_PORT || addr.is_ipv4() != local.is_ipv4() {
        return false;
    }
    let ip = addr.ip();
    if ip.is_loopback() != local.ip().is_loopback() {
        return false;
    }
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_unspecified() || v4.is_multicast() || v4.is_broadcast() || v4.is_link_local())
        }
        IpAddr::V6(v6) => {
            !(v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unicast_link_local()
                || v6.to_ipv4_mapped().is_some())
        }
    }
}

/// `sdp` with its `a=candidate` lines cut to the ones [`checkable`] from `local`, UDP only,
/// at most [`MAX_REMOTE_CANDIDATES`], in their order. A line str0m cannot read (an mDNS
/// `.local` name, say) is dropped too; every other line is kept as it is.
#[must_use]
pub fn filter_candidates(sdp: &str, local: SocketAddr) -> String {
    let mut out = String::with_capacity(sdp.len());
    let mut kept = 0;
    for line in sdp.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']);
        if let Some(cand) = body.strip_prefix("a=")
            && cand.starts_with("candidate:")
        {
            let keep = kept < MAX_REMOTE_CANDIDATES
                && Candidate::from_sdp_string(cand)
                    .is_ok_and(|c| c.proto() == Protocol::Udp && checkable(c.addr(), local));
            if keep {
                kept += 1;
                out.push_str(line);
            }
            continue;
        }
        out.push_str(line);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sa(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn checks_go_only_where_a_peer_can_be() {
        let lan = sa("192.168.1.5:40000");
        for (addr, ok) in [
            ("203.0.113.9:5000", true),
            ("192.168.1.9:5000", true),
            ("10.0.0.2:5000", true),
            ("203.0.113.9:0", false),
            ("203.0.113.9:53", false),
            ("203.0.113.9:1023", false),
            ("203.0.113.9:1024", true),
            ("0.0.0.0:5000", false),
            ("127.0.0.1:5000", false),
            ("169.254.1.1:5000", false),
            ("224.0.0.1:5000", false),
            ("255.255.255.255:5000", false),
            ("[2001:db8::1]:5000", false),
        ] {
            assert_eq!(checkable(sa(addr), lan), ok, "{addr}");
        }
        let lo = sa("127.0.0.1:40000");
        assert!(checkable(sa("127.0.0.1:5000"), lo));
        assert!(!checkable(sa("192.168.1.9:5000"), lo));
        let v6 = sa("[2001:db8::5]:40000");
        assert!(checkable(sa("[2001:db8::1]:5000"), v6));
        assert!(!checkable(sa("[fe80::1]:5000"), v6));
        assert!(!checkable(sa("[::ffff:192.0.2.1]:5000"), v6));
        assert!(!checkable(sa("[ff02::1]:5000"), v6));
    }

    #[test]
    fn only_checkable_udp_candidates_survive_and_at_most_eight() {
        let mut sdp = String::from("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");
        sdp.push_str("a=candidate:1 1 udp 2113937151 abcd.local 50000 typ host\r\n");
        sdp.push_str("a=candidate:2 1 tcp 1518280447 203.0.113.9 9 typ host tcptype active\r\n");
        sdp.push_str("a=candidate:3 1 udp 2113937151 127.0.0.1 50001 typ host\r\n");
        sdp.push_str(
            "a=candidate:4 1 udp 1677729535 203.0.113.9 50002 typ srflx raddr 0.0.0.0 rport 0\r\n",
        );
        for i in 0..10 {
            sdp.push_str(&format!(
                "a=candidate:{} 1 udp 2113937151 192.168.1.{} 5000 typ host\r\n",
                10 + i,
                10 + i
            ));
        }
        sdp.push_str("a=end-of-candidates\r\n");
        let out = filter_candidates(&sdp, sa("192.168.1.5:40000"));
        let kept: Vec<&str> = out
            .lines()
            .filter(|l| l.starts_with("a=candidate:"))
            .collect();
        assert_eq!(kept.len(), MAX_REMOTE_CANDIDATES);
        assert!(kept[0].contains("203.0.113.9 50002 typ srflx"), "{kept:?}");
        assert!(
            !out.contains(".local") && !out.contains("tcp") && !out.contains("127.0.0.1 50001")
        );
        assert!(out.starts_with("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n"));
        assert!(out.ends_with("a=end-of-candidates\r\n"));
    }
}
