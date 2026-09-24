//! `spec/test-vectors/tickets.json` against iroh itself. The Python generator encodes the
//! tickets from the layout in NFX-06 §2 without iroh; here iroh-blobs must decode them to
//! the same fields, re-encode them byte for byte, and hash the collections identically.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;
use std::str::FromStr;

use iroh::{EndpointAddr, RelayUrl, SecretKey};
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, Hash};
use serde_json::Value;

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).unwrap();
    out
}

#[test]
fn tickets_and_collections_match_iroh() {
    let v: Value =
        serde_json::from_str(include_str!("../../../spec/test-vectors/tickets.json")).unwrap();

    // The endpoint id is the ed25519 public key of the published seed.
    let seed = hex32(v["secret_keys_DO_NOT_USE"]["iroh_node"].as_str().unwrap());
    let id = SecretKey::from_bytes(&seed).public();
    let ep = &v["endpoint"];
    assert_eq!(*id.as_bytes(), hex32(ep["endpoint_id"].as_str().unwrap()));
    let relay = RelayUrl::from_str(ep["relay_url"].as_str().unwrap()).unwrap();
    assert_eq!(
        relay.to_string(),
        ep["relay_url"],
        "relay URL is in normal form"
    );
    let direct: Vec<SocketAddr> = ep["direct_addresses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().parse().unwrap())
        .collect();

    for (cid, col) in v["collections"].as_object().unwrap() {
        // Members: BLAKE3 of each file, as iroh-blobs addresses it.
        let hashes: Vec<Hash> = col["members"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| Hash::from_bytes(hex32(m["blake3"].as_str().unwrap())))
            .collect();
        let seq: HashSeq = hashes.iter().copied().collect();
        assert_eq!(
            hex::encode(seq.clone().into_inner()),
            col["hash_seq"],
            "{cid}"
        );
        let address = Hash::new(seq.into_inner());
        assert_eq!(address.to_hex().to_string(), col["blake3"], "{cid}");

        // The ticket: decode, compare fields, re-encode byte for byte, and build it afresh.
        let t = &v["tickets"][cid];
        let text = t["string"].as_str().unwrap();
        let ticket = BlobTicket::from_str(text).expect("iroh decodes the ticket");
        assert_eq!(ticket.addr().id, id, "{cid}");
        assert_eq!(ticket.addr().relay_urls().collect::<Vec<_>>(), [&relay]);
        assert_eq!(
            ticket.addr().ip_addrs().copied().collect::<Vec<_>>(),
            direct
        );
        assert_eq!(ticket.format(), BlobFormat::HashSeq);
        assert_eq!(ticket.hash(), address);
        assert_eq!(ticket.to_string(), text, "{cid}: re-encodes identically");
        let mut addr = EndpointAddr::new(id).with_relay_url(relay.clone());
        for a in &direct {
            addr = addr.with_ip_addr(*a);
        }
        let built = BlobTicket::new(addr, address, BlobFormat::HashSeq);
        assert_eq!(
            built.to_string(),
            text,
            "{cid}: iroh builds the same string"
        );
        let bytes = iroh_tickets::Ticket::encode_bytes(&built);
        assert_eq!(
            hex::encode(bytes),
            t["bytes"],
            "{cid}: the documented byte layout"
        );
    }
}
