//! A STUN Binding client's two messages (RFC 8489): the request the mesh endpoint sends from
//! its own socket to a `--mesh-stun` server, and the success response that names the address
//! the server saw it at (its server-reflexive candidate). Nothing else: no authentication, no
//! TURN, no FINGERPRINT check (the transaction id, random per request, is what ties a response
//! to its request).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// The magic cookie, in network order.
const MAGIC: [u8; 4] = [0x21, 0x12, 0xa4, 0x42];
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const HEADER: usize = 20;

/// A Binding request with transaction id `tid`, and no attributes.
#[must_use]
pub fn binding_request(tid: &[u8; 12]) -> [u8; HEADER] {
    let mut m = [0u8; HEADER];
    m[..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    m[4..8].copy_from_slice(&MAGIC);
    m[8..].copy_from_slice(tid);
    m
}

/// The transaction id of a datagram that is a well-formed STUN message (RFC 8489 §5: a
/// first byte of 0 to 3, which RFC 7983 tells apart from DTLS and RTP on a shared socket,
/// the magic cookie, a length that matches and is a multiple of 4).
#[must_use]
pub fn transaction(packet: &[u8]) -> Option<[u8; 12]> {
    if packet.len() < HEADER || packet[0] > 3 || packet[4..8] != MAGIC {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    if len % 4 != 0 || packet.len() != HEADER + len {
        return None;
    }
    packet[8..HEADER].try_into().ok()
}

/// The mapped address in a Binding success response: XOR-MAPPED-ADDRESS, or failing that
/// MAPPED-ADDRESS. `None` for anything else (a request, an error response, a malformed one).
#[must_use]
pub fn mapped(packet: &[u8]) -> Option<SocketAddr> {
    let tid = transaction(packet)?;
    if u16::from_be_bytes([packet[0], packet[1]]) != BINDING_SUCCESS {
        return None;
    }
    let mut plain = None;
    let mut at = HEADER;
    while at + 4 <= packet.len() {
        let kind = u16::from_be_bytes([packet[at], packet[at + 1]]);
        let len = usize::from(u16::from_be_bytes([packet[at + 2], packet[at + 3]]));
        let value = packet.get(at + 4..at + 4 + len)?;
        match kind {
            XOR_MAPPED_ADDRESS => return address(value, Some(&tid)),
            MAPPED_ADDRESS if plain.is_none() => plain = address(value, None),
            _ => {}
        }
        at += 4 + len.div_ceil(4) * 4;
    }
    plain
}

/// An address attribute's value: `0, family, port, address`, XORed with the cookie (and the
/// transaction id, for IPv6) when `xor` names the transaction.
fn address(v: &[u8], xor: Option<&[u8; 12]>) -> Option<SocketAddr> {
    let mut mask = [0u8; 16];
    if let Some(tid) = xor {
        mask[..4].copy_from_slice(&MAGIC);
        mask[4..].copy_from_slice(tid);
    }
    let port = u16::from_be_bytes([v.get(2)? ^ mask[0], v.get(3)? ^ mask[1]]);
    let ip = match (v.get(1)?, v.len()) {
        (0x01, 8) => {
            let mut b = [0u8; 4];
            for (i, x) in b.iter_mut().enumerate() {
                *x = v[4 + i] ^ mask[i];
            }
            IpAddr::V4(Ipv4Addr::from(b))
        }
        (0x02, 20) => {
            let mut b = [0u8; 16];
            for (i, x) in b.iter_mut().enumerate() {
                *x = v[4 + i] ^ mask[i];
            }
            IpAddr::V6(Ipv6Addr::from(b))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        let s: String = s.split_whitespace().collect();
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0))
            .collect()
    }

    /// RFC 5769 §2.2's IPv4 Binding success response: its header, SOFTWARE and
    /// XOR-MAPPED-ADDRESS as published, then MESSAGE-INTEGRITY and FINGERPRINT attributes whose
    /// values are placeholders (this client checks neither; it must only step over them).
    const RFC5769_V4: &str = "0101 003c 2112a442 b7e7a701 bc34d686 fa87dfae
        8022 000b 74657374 20766563 746f7220
        0020 0008 0001a147 e112a643
        0008 0014 2b91f599 fd9e9019 38dd3c13 34b15e1a 5c22e2a7
        8028 0004 c07d4c96";
    /// RFC 5769 §2.3's IPv6 response, the same way.
    const RFC5769_V6: &str = "0101 0048 2112a442 b7e7a701 bc34d686 fa87dfae
        8022 000b 74657374 20766563 746f7220
        0020 0014 0002a147 0113a9fa a5d3f179 bc25f4b5 bed2b9d9
        0008 0014 a382954e 4be67bf1 1784c97c 8292c275 bfe3ed41
        8028 0004 c8fb0b4c";

    #[test]
    fn reads_the_rfc_5769_responses() {
        let v4 = unhex(RFC5769_V4);
        assert_eq!(
            transaction(&v4),
            Some([
                0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae
            ])
        );
        assert_eq!(mapped(&v4), Some("192.0.2.1:32853".parse().unwrap()));
        let v6 = unhex(RFC5769_V6);
        assert_eq!(
            mapped(&v6),
            Some(
                "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
                    .parse()
                    .unwrap()
            )
        );
    }

    #[test]
    fn a_request_is_a_well_formed_message_but_maps_nothing() {
        let tid = [7u8; 12];
        let req = binding_request(&tid);
        assert_eq!(transaction(&req), Some(tid));
        assert_eq!(mapped(&req), None);
    }

    #[test]
    fn malformed_messages_are_refused() {
        let v4 = unhex(RFC5769_V4);
        // A length that does not match.
        assert_eq!(transaction(&v4[..v4.len() - 4]), None);
        // No magic cookie (an RFC 3489 message or something else).
        let mut bad = v4.clone();
        bad[4] ^= 1;
        assert_eq!(transaction(&bad), None);
        // DTLS (20 to 63) or RTP (128 to 191) by its first byte (RFC 7983).
        for first in [0x16, 0x80] {
            let mut bad = v4.clone();
            bad[0] = first;
            assert_eq!(transaction(&bad), None);
        }
        // An attribute that runs past the end.
        let mut bad = binding_request(&[1; 12]).to_vec();
        bad[0..2].copy_from_slice(&BINDING_SUCCESS.to_be_bytes());
        bad[3] = 8;
        bad.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0, 1, 0, 0]);
        assert_eq!(mapped(&bad), None);
        // Only a MAPPED-ADDRESS (RFC 3489 style): taken as it is.
        let mut plain = binding_request(&[1; 12]).to_vec();
        plain[0..2].copy_from_slice(&BINDING_SUCCESS.to_be_bytes());
        plain[3] = 12;
        plain.extend_from_slice(&[0x00, 0x01, 0x00, 0x08, 0, 1, 0x1f, 0x90, 198, 51, 100, 7]);
        assert_eq!(mapped(&plain), Some("198.51.100.7:8080".parse().unwrap()));
    }
}
