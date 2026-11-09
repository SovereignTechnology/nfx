//! Signaling over Nostr (NFX-10 §6): kind-25050 events with `i` = `nfx-mesh/1`, through
//! which mesh peers find each other and exchange WebRTC offers and answers on stock relays,
//! with no tracker. Signaling-compatible with the NIP-DC draft §§2, 4–6 (its room proof,
//! presence, offer and answer); not a NIP-DC implementation.
//!
//! - [`Room`]: one per stream swarm (NFX-10 §2), its key derived from the swarm ID.
//! - [`Session`]: a page's (or node's) per-session key and id; it builds every event, and
//!   opens the offers and answers sent to it.
//! - [`read`]: the reader's checks, in an order that does the cheap ones first and decrypts
//!   nothing: an event of another protocol, of a type nfx-mesh/1 does not use, or addressed
//!   to another session is [`Parsed::Ignored`]; anything else that fails is an error.
//!
//! Pure: callers pass `now`, the session secret and every NIP-44 nonce.

use k256::schnorr::SigningKey;

use crate::event::{Event, public_key_hex, sign_digest, verify_digest};
use crate::hex32::{decode, is_lower_hex, parse_u64_strict};
use crate::{Error, Result, nip44, sha256};

/// The signaling kind (ephemeral; the NIP-DC draft's).
pub const KIND_SIGNAL: u16 = 25050;
/// The `i` tag: the protocol identifier. Readers ignore every other.
pub const PROTOCOL: &str = "nfx-mesh/1";
/// The `y` tag: the application.
pub const APP: &str = "nfx";
/// The label the room secret is derived under.
pub const ROOM_LABEL: &str = "nfx/1/web/room";
/// A presence's lifetime: `expiration - created_at` is at most this, and senders use it.
pub const PRESENCE_TTL: u64 = 90;
/// How often a session repeats its presence, in seconds.
pub const PRESENCE_INTERVAL: u64 = 30;
/// Oldest `created_at` accepted, in seconds before `now`.
pub const MAX_AGE: u64 = 60;
/// Newest `created_at` accepted, in seconds after `now`.
pub const MAX_FUTURE: u64 = 30;
/// Largest offer or answer `content` (the NIP-44 payload), in bytes.
pub const MAX_CONTENT: usize = 32 * 1024;

/// A mesh room: the key pair of one stream swarm.
#[derive(Clone)]
pub struct Room {
    secret: [u8; 32],
    pubkey: String,
}

impl core::fmt::Debug for Room {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Room")
            .field("pubkey", &self.pubkey)
            .finish_non_exhaustive()
    }
}

/// `h_0` of the room derivation: `sha256(utf8(ROOM_LABEL) || 0x00 || utf8(stream swarm ID))`.
#[must_use]
pub fn room_h0(stream_swarm_id: &str) -> [u8; 32] {
    let mut pre = Vec::with_capacity(ROOM_LABEL.len() + 1 + stream_swarm_id.len());
    pre.extend_from_slice(ROOM_LABEL.as_bytes());
    pre.push(0);
    pre.extend_from_slice(stream_swarm_id.as_bytes());
    sha256(&pre)
}

/// Whether `h` is a secp256k1 secret key: `0 < h < n`, read big-endian.
#[must_use]
pub fn is_valid_scalar(h: &[u8; 32]) -> bool {
    SigningKey::from_bytes(&(*h).into()).is_ok()
}

impl Room {
    /// The room of a stream swarm: the first of `h_0`, `sha256(h_0)`, `sha256(sha256(h_0))`, …
    /// that is a valid secret key.
    #[must_use]
    pub fn derive(stream_swarm_id: &str) -> Self {
        let mut h = room_h0(stream_swarm_id);
        while !is_valid_scalar(&h) {
            h = sha256(&h);
        }
        Self::from_secret(h).expect("a valid scalar")
    }

    /// A room from its secret (tests and vectors).
    pub fn from_secret(secret: [u8; 32]) -> Result<Self> {
        let pubkey = public_key_hex(&secret)?;
        Ok(Self { secret, pubkey })
    }

    /// The room public key, 64 lowercase hex: the `P` tag.
    #[must_use]
    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }

    /// The room secret. Not a secret from anyone who has the manifest (NFX-10 §6.1).
    #[must_use]
    pub fn secret(&self) -> &[u8; 32] {
        &self.secret
    }
}

/// The type of a signaling event (`t`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Type {
    Connect,
    Disconnect,
    Offer,
    Answer,
}

impl Type {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connect => "connect",
            Self::Disconnect => "disconnect",
            Self::Offer => "offer",
            Self::Answer => "answer",
        }
    }

    fn parse(t: &str) -> Option<Self> {
        Some(match t {
            "connect" => Self::Connect,
            "disconnect" => Self::Disconnect,
            "offer" => Self::Offer,
            "answer" => Self::Answer,
            _ => return None,
        })
    }
}

/// What a valid signaling event says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// Presence until `expiration`.
    Connect {
        expiration: u64,
    },
    Disconnect,
    /// An SDP offer to this session (NIP-44 payload; [`Session::open`]).
    Offer {
        content: String,
    },
    /// An SDP answer to the offer whose event id is `offer`.
    Answer {
        offer: String,
        content: String,
    },
}

/// A valid signaling event of the room, for this reader.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Received {
    pub id: String,
    /// The sender's session key.
    pub sender: String,
    /// The sender's session id (`d`).
    pub session: String,
    pub created_at: u64,
    pub signal: Signal,
}

/// The outcome of [`read`] for an event that is not an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Ours(Received),
    /// Not this reader's: another protocol identifier, a type nfx-mesh/1 does not use, or a
    /// directed event for another session. Dropped silently.
    Ignored(&'static str),
}

fn bad(reason: impl core::fmt::Display) -> Error {
    Error::Event(format!("signal: {reason}"))
}

/// The room-proof challenge of NIP-DC §§5–6: for presence, the JSON of
/// `["nip-dc-presence-v1", t, P, d, i, y, version, expiration, content]` (absent tags as
/// `""`); for directed events, the JSON of `[p, content]`.
pub fn challenge(t: &str, tags: &[Vec<String>], content: &str) -> Result<String> {
    fn value<'a>(tags: &'a [Vec<String>], name: &str) -> &'a str {
        tags.iter()
            .find(|tag| tag.first().is_some_and(|n| n == name))
            .and_then(|tag| tag.get(1))
            .map_or("", String::as_str)
    }
    let first = |name: &str| value(tags, name);
    let json = if t == "connect" || t == "disconnect" {
        serde_json::to_string(&[
            "nip-dc-presence-v1",
            t,
            first("P"),
            first("d"),
            first("i"),
            first("y"),
            first("version"),
            first("expiration"),
            content,
        ])
    } else {
        let p = first("p");
        if p.is_empty() {
            return Err(bad("a directed event's room proof needs its p"));
        }
        serde_json::to_string(&[p, content])
    };
    Ok(json.expect("serializing strings cannot fail"))
}

/// The room-proof id (NIP-DC §2.1): sha256 of the NIP-01 JSON of
/// `[0, P, created_at, kind, pubkey, challenge, ""]`.
#[must_use]
pub fn roomproof_id(
    room: &str,
    created_at: u64,
    kind: u16,
    pubkey: &str,
    challenge: &str,
) -> [u8; 32] {
    let json = serde_json::to_string(&(0u8, room, created_at, kind, pubkey, challenge, ""))
        .expect("serializing strings and integers cannot fail");
    sha256(json.as_bytes())
}

/// A session: the key every event is signed with and the session id (`d`). Fresh and random
/// for each page session (or node run), never a user's identity key.
#[derive(Clone)]
pub struct Session {
    secret: [u8; 32],
    pubkey: String,
    id: String,
}

impl core::fmt::Debug for Session {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Session")
            .field("pubkey", &self.pubkey)
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

impl Session {
    /// A session from 32 random bytes (a valid secret key) and 16 random bytes (its id).
    pub fn new(secret: [u8; 32], id: [u8; 16]) -> Result<Self> {
        let pubkey = public_key_hex(&secret)?;
        Ok(Self {
            secret,
            pubkey,
            id: hex::encode(id),
        })
    }

    /// The session's public key, 64 lowercase hex.
    #[must_use]
    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }

    /// The session id, 32 lowercase hex.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    fn build(
        &self,
        room: &Room,
        t: Type,
        created_at: u64,
        directed: Option<(&str, Option<&str>)>,
        expiration: Option<u64>,
        content: String,
    ) -> Result<Event> {
        let mut tags = vec![
            vec!["t".to_owned(), t.as_str().to_owned()],
            vec!["P".to_owned(), room.pubkey.clone()],
            vec!["d".to_owned(), self.id.clone()],
            vec!["i".to_owned(), PROTOCOL.to_owned()],
            vec!["y".to_owned(), APP.to_owned()],
        ];
        if let Some((to, offer)) = directed {
            if !is_lower_hex(to, 64) {
                return Err(bad("the receiver is not 64 lowercase hex"));
            }
            tags.push(vec!["p".to_owned(), to.to_owned()]);
            if let Some(offer) = offer {
                if !is_lower_hex(offer, 64) {
                    return Err(bad("the offer id is not 64 lowercase hex"));
                }
                tags.push(vec!["e".to_owned(), offer.to_owned()]);
            }
        }
        if let Some(expiration) = expiration {
            tags.push(vec!["expiration".to_owned(), expiration.to_string()]);
        }
        let ch = challenge(t.as_str(), &tags, &content)?;
        let id = roomproof_id(&room.pubkey, created_at, KIND_SIGNAL, &self.pubkey, &ch);
        let sig = sign_digest(&room.secret, &id)?;
        tags.push(vec![
            "roomproof".to_owned(),
            hex::encode(id),
            hex::encode(sig),
        ]);
        Event::sign(&self.secret, created_at, KIND_SIGNAL, tags, content)
    }

    /// This session's presence in `room`, signed at `created_at` (send it at once: relays
    /// refuse ephemeral events older than about 60 s), expiring [`PRESENCE_TTL`] later.
    pub fn connect(&self, room: &Room, created_at: u64) -> Result<Event> {
        self.build(
            room,
            Type::Connect,
            created_at,
            None,
            Some(created_at + PRESENCE_TTL),
            String::new(),
        )
    }

    /// This session leaving `room`.
    pub fn disconnect(&self, room: &Room, created_at: u64) -> Result<Event> {
        self.build(
            room,
            Type::Disconnect,
            created_at,
            None,
            None,
            String::new(),
        )
    }

    fn encrypt_sdp(&self, to: &str, sdp: &str, nonce: &[u8; 32]) -> Result<String> {
        if !is_sdp(sdp) {
            return Err(bad("not an SDP"));
        }
        let content = nip44::encrypt(&nip44::conversation_key(&self.secret, to)?, sdp, nonce)?;
        if content.len() > MAX_CONTENT {
            return Err(bad("the SDP is too large for one event"));
        }
        Ok(content)
    }

    /// An offer of `sdp` (complete, with every candidate) to the session `to`, encrypted
    /// with NIP-44 under `nonce` (fresh and random for every message).
    pub fn offer(
        &self,
        room: &Room,
        to: &str,
        sdp: &str,
        nonce: &[u8; 32],
        created_at: u64,
    ) -> Result<Event> {
        let content = self.encrypt_sdp(to, sdp, nonce)?;
        self.build(
            room,
            Type::Offer,
            created_at,
            Some((to, None)),
            None,
            content,
        )
    }

    /// The answer `sdp` to the offer event `offer_id` from the session `to`.
    pub fn answer(
        &self,
        room: &Room,
        to: &str,
        offer_id: &str,
        sdp: &str,
        nonce: &[u8; 32],
        created_at: u64,
    ) -> Result<Event> {
        let content = self.encrypt_sdp(to, sdp, nonce)?;
        self.build(
            room,
            Type::Answer,
            created_at,
            Some((to, Some(offer_id))),
            None,
            content,
        )
    }

    /// The SDP of an offer or answer [`read`] accepted for this session: NIP-44 v2 from the
    /// sender, whose plaintext must be an SDP.
    pub fn open(&self, received: &Received) -> Result<String> {
        let content = match &received.signal {
            Signal::Offer { content } | Signal::Answer { content, .. } => content,
            _ => return Err(bad("only offers and answers carry an SDP")),
        };
        let sdp = nip44::decrypt(
            &nip44::conversation_key(&self.secret, &received.sender)?,
            content,
        )?;
        if !is_sdp(&sdp) {
            return Err(bad("the plaintext is not an SDP"));
        }
        Ok(sdp)
    }
}

/// An SDP's first line is `v=0`.
fn is_sdp(s: &str) -> bool {
    s.starts_with("v=0\r\n") || s.starts_with("v=0\n")
}

/// A single tag's value: `Ok(None)` if absent, an error if repeated or empty-valued.
fn single<'a>(ev: &'a Event, name: &str) -> Result<Option<&'a str>> {
    match ev.single_tag(name).map_err(bad)? {
        None => Ok(None),
        Some(values) => Ok(Some(values[0].as_str())),
    }
}

fn required<'a>(ev: &'a Event, name: &str) -> Result<&'a str> {
    single(ev, name)?.ok_or_else(|| bad(format!("missing `{name}` tag")))
}

/// Check a kind-25050 event received on `room`'s subscription by the session `me` (its
/// public key), at `now` (NFX-10 §6.5). Cheap checks come first; the signature and the
/// room proof are verified only for events this reader would use; nothing is decrypted
/// ([`Session::open`] does that).
pub fn read(ev: &Event, room: &str, me: &str, now: u64) -> Result<Parsed> {
    if ev.kind != KIND_SIGNAL {
        return Err(bad("not kind 25050"));
    }
    // Other applications use 25050 too (NIP-DC with other protocol ids, hashtree): not ours.
    let mut protocols = ev.tag_values("i");
    match (protocols.next(), protocols.next()) {
        (Some([i, ..]), None) if i == PROTOCOL => {}
        _ => return Ok(Parsed::Ignored("not nfx-mesh/1")),
    }
    let Some(t) = Type::parse(required(ev, "t")?) else {
        return Ok(Parsed::Ignored("a type nfx-mesh/1 does not use"));
    };
    if required(ev, "y")? != APP {
        return Err(bad("y is not nfx"));
    }
    if required(ev, "P")? != room {
        return Err(bad("another room"));
    }
    let session = required(ev, "d")?;
    if !is_lower_hex(session, 32) {
        return Err(bad("d is not 32 lowercase hex"));
    }
    if ev.created_at.saturating_add(MAX_AGE) < now {
        return Err(bad("too old"));
    }
    if ev.created_at > now.saturating_add(MAX_FUTURE) {
        return Err(bad("created in the future"));
    }
    let p = single(ev, "p")?;
    let expiration = single(ev, "expiration")?;
    let signal = match t {
        Type::Connect | Type::Disconnect => {
            if p.is_some() {
                return Err(bad("presence is not directed"));
            }
            if !ev.content.is_empty() {
                return Err(bad("presence content is not empty"));
            }
            if t == Type::Disconnect {
                if expiration.is_some() {
                    return Err(bad("a disconnect has no expiration"));
                }
                Signal::Disconnect
            } else {
                let expiration = expiration
                    .and_then(parse_u64_strict)
                    .ok_or_else(|| bad("a connect needs one decimal expiration"))?;
                if expiration <= ev.created_at || expiration - ev.created_at > PRESENCE_TTL {
                    return Err(bad("expiration is not within 90 s after created_at"));
                }
                if expiration <= now {
                    return Err(bad("expired presence"));
                }
                Signal::Connect { expiration }
            }
        }
        Type::Offer | Type::Answer => {
            let to = p.ok_or_else(|| bad("a directed event needs one p"))?;
            if !is_lower_hex(to, 64) {
                return Err(bad("p is not 64 lowercase hex"));
            }
            if expiration.is_some() {
                return Err(bad("an offer or answer has no expiration"));
            }
            if ev.content.len() > MAX_CONTENT {
                return Err(bad("content over 32 KiB"));
            }
            if ev.content.is_empty() || ev.content.starts_with('#') {
                return Err(bad("content is not a NIP-44 v2 payload"));
            }
            if to != me {
                return Ok(Parsed::Ignored("addressed to another session"));
            }
            let content = ev.content.clone();
            if t == Type::Offer {
                if single(ev, "e")?.is_some() {
                    return Err(bad("an offer has no e"));
                }
                Signal::Offer { content }
            } else {
                let offer = required(ev, "e")?;
                if !is_lower_hex(offer, 64) {
                    return Err(bad("e is not 64 lowercase hex"));
                }
                Signal::Answer {
                    offer: offer.to_owned(),
                    content,
                }
            }
        }
    };
    ev.verify()?;
    let proof = ev.tag_values("roomproof").collect::<Vec<_>>();
    let [[id, sig, ..]] = proof.as_slice() else {
        return Err(bad("needs exactly one roomproof with an id and a sig"));
    };
    let ch = challenge(t.as_str(), &ev.tags, &ev.content)?;
    let want = roomproof_id(room, ev.created_at, KIND_SIGNAL, &ev.pubkey, &ch);
    if decode::<32>(id) != Some(want) {
        return Err(bad("roomproof id does not match"));
    }
    verify_digest(room, &want, sig).map_err(|_| bad("roomproof signature"))?;
    Ok(Parsed::Ours(Received {
        id: ev.id.clone(),
        sender: ev.pubkey.clone(),
        session: session.to_owned(),
        created_at: ev.created_at,
        signal,
    }))
}

/// The glare rule (NFX-10 §6.6): whether `me` sends the offer to `peer` (the lower
/// lowercase-hex session key offers; the other waits for it).
#[must_use]
pub fn offers_to(me: &str, peer: &str) -> bool {
    me < peer
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const SDP: &str = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";

    fn pair() -> (Room, Session, Session) {
        let room = Room::derive("nfx/1/web/nfx:regtest:1:x/720p");
        let a = Session::new([1; 32], [2; 16]).unwrap();
        let b = Session::new([3; 32], [4; 16]).unwrap();
        (room, a, b)
    }

    #[test]
    fn an_offer_and_its_answer_round_trip() {
        let (room, a, b) = pair();
        let offer = a.offer(&room, b.pubkey(), SDP, &[5; 32], 1000).unwrap();
        let Parsed::Ours(got) = read(&offer, room.pubkey(), b.pubkey(), 1000).unwrap() else {
            panic!("ours")
        };
        assert_eq!(b.open(&got).unwrap(), SDP);
        assert_eq!(
            read(&offer, room.pubkey(), a.pubkey(), 1000).unwrap(),
            Parsed::Ignored("addressed to another session")
        );
        let answer = b
            .answer(&room, a.pubkey(), &offer.id, SDP, &[6; 32], 1001)
            .unwrap();
        let Parsed::Ours(got) = read(&answer, room.pubkey(), a.pubkey(), 1001).unwrap() else {
            panic!("ours")
        };
        assert_eq!(
            got.signal,
            Signal::Answer {
                offer: offer.id.clone(),
                content: answer.content.clone()
            }
        );
        assert_eq!(a.open(&got).unwrap(), SDP);
    }

    #[test]
    fn presence_lives_ninety_seconds_and_freshness_is_sixty_and_thirty() {
        let (room, a, b) = pair();
        let c = a.connect(&room, 1000).unwrap();
        for (now, ok) in [(969, false), (970, true), (1060, true), (1061, false)] {
            assert_eq!(
                read(&c, room.pubkey(), b.pubkey(), now).is_ok(),
                ok,
                "now {now}"
            );
        }
        assert!(matches!(
            read(&c, room.pubkey(), b.pubkey(), 1000).unwrap(),
            Parsed::Ours(Received {
                signal: Signal::Connect { expiration: 1090 },
                ..
            })
        ));
        let d = a.disconnect(&room, 1000).unwrap();
        assert!(matches!(
            read(&d, room.pubkey(), b.pubkey(), 1000).unwrap(),
            Parsed::Ours(_)
        ));
        assert!(read(&c, Room::derive("other").pubkey(), b.pubkey(), 1000).is_err());
    }

    #[test]
    fn builders_refuse_what_readers_would_drop() {
        let (room, a, b) = pair();
        assert!(
            a.offer(&room, b.pubkey(), "not an sdp", &[5; 32], 1)
                .is_err()
        );
        assert!(
            a.offer(&room, &b.pubkey().to_uppercase(), SDP, &[5; 32], 1)
                .is_err()
        );
        let huge = format!("{SDP}a=x:{}\r\n", "y".repeat(30_000));
        assert!(a.offer(&room, b.pubkey(), &huge, &[5; 32], 1).is_err());
        assert!(
            b.answer(&room, a.pubkey(), "abc", SDP, &[6; 32], 1)
                .is_err()
        );
    }

    #[test]
    fn the_lower_key_offers() {
        let (_, a, b) = pair();
        assert_ne!(
            offers_to(a.pubkey(), b.pubkey()),
            offers_to(b.pubkey(), a.pubkey())
        );
        assert!(offers_to("0a", "0b"));
    }
}
