//! Seeder lookup (NFX-17): a viewer asks who seeds a video, and seeders answer at once.
//!
//! One ephemeral kind, 20465, with two types told apart by a `t` tag. An `ask` is signed by a
//! throwaway key. A `tell` is signed by a seeder's beacon key, is addressed (`p`) to the ask's
//! signer, and carries that seeder's complete signed kind-20464 beacon as its content. A reader
//! runs the normal NFX-03 check on the embedded beacon, so a tell adds no trust of its own: the
//! wrapper only routes.
//!
//! Pure, like the rest of this crate: callers pass `now`, keys and events.

use crate::beacon::{Beacon, parse_a_tag};
use crate::event::Event;
use crate::hex32::{is_lower_hex, parse_u64_strict};
use crate::namespace::Namespace;
use crate::{Error, KIND_BEACON, Result, Verified};

/// The kind of a lookup event (NFX-17 §1), in the ephemeral range.
pub const KIND_LOOKUP: u16 = 20465;
/// The longest lifetime of an ask, in seconds.
pub const ASK_TTL: u64 = 60;
/// How far before `now` a lookup event's `created_at` may be, in seconds.
pub const MAX_AGE: u64 = 60;
/// How far after `now` a lookup event's `created_at` may be, in seconds.
pub const MAX_FUTURE: u64 = 30;
/// The largest ask a scoped relay carries, in bytes of event JSON (NFX-17 §5).
pub const MAX_ASK_BYTES: usize = 1024;
/// The largest tell content: one beacon, whose NFX-04 §2 limit is 16 KiB.
pub const MAX_TELL_CONTENT: usize = 16 * 1024;
/// The largest tell a scoped relay carries, in bytes of event JSON: the content, escaped.
pub const MAX_TELL_BYTES: usize = 36 * 1024;

const T_ASK: &str = "ask";
const T_TELL: &str = "tell";

fn bad(reason: impl core::fmt::Display) -> Error {
    Error::Event(format!("lookup: {reason}"))
}

/// The two types of lookup event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Type {
    Ask,
    Tell,
}

/// What a lookup event says, from the checks that need no cryptography: its tags, its freshness
/// and the length of a tell's content. **Nothing here is authenticated**, the `sender` and `asker`
/// included, so a limit keyed on them MUST NOT be charged from a `Shape` (NFX-17 §5): an unsigned
/// event would spend someone else's budget. Use [`read`] or [`relayable`] first. The size of the
/// whole event is [`size_ok`]'s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shape {
    pub kind: Type,
    /// The event's signer, as claimed.
    pub sender: String,
    /// Who asked: the signer of an ask, the `p` of a tell.
    pub asker: String,
    /// The `a` tag: the manifest address.
    pub a: String,
    /// The manifest's author, from `a`.
    pub creator: String,
    /// The `n` tag.
    pub namespace: String,
    pub expiration: u64,
}

/// A verified ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    /// The throwaway key to answer. An answer goes to this key and to no other.
    pub asker: String,
    pub a: String,
    pub expiration: u64,
}

/// A verified tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tell {
    pub seeder: String,
    pub asker: String,
    pub a: String,
    pub expiration: u64,
    /// The embedded kind-20464 event, as signed.
    pub event: Event,
    /// The embedded beacon, which passed NFX-03 at the time given to [`read`].
    pub beacon: Verified<Beacon>,
}

/// The outcome of [`read`] for an event that is not an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Ask(Verified<Ask>),
    Tell(Box<Verified<Tell>>),
    /// A type this version does not use: dropped without error (NFX-01 §4).
    Ignored(&'static str),
}

fn required<'a>(ev: &'a Event, name: &str) -> Result<&'a str> {
    match ev.single_tag(name).map_err(bad)? {
        Some(values) => Ok(values[0].as_str()),
        None => Err(bad(format_args!("missing `{name}` tag"))),
    }
}

/// The event's type, or why it is not one this version reads.
fn type_of(ev: &Event) -> Result<core::result::Result<Type, &'static str>> {
    if ev.kind != KIND_LOOKUP {
        return Err(bad("wrong kind"));
    }
    Ok(match required(ev, "t")? {
        T_ASK => Ok(Type::Ask),
        T_TELL => Ok(Type::Tell),
        _ => Err("a type this version does not use"),
    })
}

fn shape_of(ev: &Event, kind: Type, now: u64) -> Result<Shape> {
    if !is_lower_hex(&ev.pubkey, 64) {
        return Err(bad("pubkey is not 64 lowercase hex"));
    }
    let namespace = Namespace::parse(required(ev, "n")?)?;
    let a = required(ev, "a")?;
    let (creator, addr) = parse_a_tag(a)?;
    if addr.namespace() != &namespace {
        return Err(bad("`a` names a different network than `n`"));
    }
    let expiration =
        parse_u64_strict(required(ev, "expiration")?).ok_or_else(|| bad("bad `expiration`"))?;
    if now.saturating_sub(ev.created_at) > MAX_AGE || ev.created_at.saturating_sub(now) > MAX_FUTURE
    {
        return Err(bad(
            "`created_at` is not within 60 s before to 30 s after now",
        ));
    }
    if expiration <= ev.created_at {
        return Err(bad("`expiration` is not after `created_at`"));
    }
    if now >= expiration {
        return Err(bad("expired"));
    }
    let asker = match kind {
        Type::Ask => {
            if expiration - ev.created_at > ASK_TTL {
                return Err(bad("an ask lives at most 60 s"));
            }
            if ev.single_tag("p").map_err(bad)?.is_some() {
                return Err(bad("an ask carries no `p`"));
            }
            if !ev.content.is_empty() {
                return Err(bad("an ask's content is empty"));
            }
            ev.pubkey.clone()
        }
        Type::Tell => {
            let p = required(ev, "p")?;
            if !is_lower_hex(p, 64) {
                return Err(bad("`p` is not 64 lowercase hex"));
            }
            if ev.content.is_empty() {
                return Err(bad("a tell carries a beacon"));
            }
            if ev.content.len() > MAX_TELL_CONTENT {
                return Err(bad("content over 16384 bytes"));
            }
            p.to_owned()
        }
    };
    Ok(Shape {
        kind,
        sender: ev.pubkey.clone(),
        asker,
        a: a.to_owned(),
        creator,
        namespace: namespace.to_string(),
        expiration,
    })
}

/// Whether an event of `kind`, `event_json_bytes` long, is within a scoped relay's size limit.
#[must_use]
pub fn size_ok(kind: Type, event_json_bytes: usize) -> bool {
    event_json_bytes
        <= match kind {
            Type::Ask => MAX_ASK_BYTES,
            Type::Tell => MAX_TELL_BYTES,
        }
}

/// The checks of a lookup event that need no cryptography. Another type is an error here.
pub fn shape(ev: &Event, now: u64) -> Result<Shape> {
    let kind = type_of(ev)?.map_err(bad)?;
    shape_of(ev, kind, now)
}

fn verified(ev: &Event, shape: Shape, now: u64) -> Result<Parsed> {
    ev.verify()?;
    match shape.kind {
        Type::Ask => Ok(Parsed::Ask(Verified::new(Ask {
            asker: shape.asker,
            a: shape.a,
            expiration: shape.expiration,
        }))),
        Type::Tell => {
            let event: Event =
                serde_json::from_str(&ev.content).map_err(|_| bad("content is not an event"))?;
            // One spelling: every implementation reads the same bytes as the same event.
            if serde_json::to_string(&event).map_err(bad)? != ev.content {
                return Err(bad("the embedded beacon is not in its compact form"));
            }
            if event.kind != KIND_BEACON {
                return Err(bad("the embedded event is not a beacon"));
            }
            if event.pubkey != ev.pubkey {
                return Err(bad("the tell's signer is not the beacon's"));
            }
            if required(&event, "a")? != shape.a {
                return Err(bad("the embedded beacon serves another video"));
            }
            let beacon = Beacon::from_event(&event, now)?;
            if beacon.expiration != shape.expiration {
                return Err(bad("`expiration` is not the embedded beacon's"));
            }
            // A seeder signs both on one clock. Without this, a beacon dated up to NFX-03's 15 min
            // ahead would hold a place in a viewer's table for that long.
            if beacon.created_at > ev.created_at {
                return Err(bad("the embedded beacon is newer than the tell"));
            }
            Ok(Parsed::Tell(Box::new(Verified::new(Tell {
                seeder: shape.sender,
                asker: shape.asker,
                a: shape.a,
                expiration: shape.expiration,
                event,
                beacon,
            }))))
        }
    }
}

/// A reader's check of a kind-20465 event at `now` (NFX-17 §2). A type this version does not use
/// is [`Parsed::Ignored`]. Whether a tell is addressed to this reader is the caller's check.
pub fn read(ev: &Event, now: u64) -> Result<Parsed> {
    match type_of(ev)? {
        Ok(kind) => verified(ev, shape_of(ev, kind, now)?, now),
        Err(why) => Ok(Parsed::Ignored(why)),
    }
}

/// A scoped relay's check (NFX-17 §5): everything a reader checks, and another type is refused.
pub fn relayable(ev: &Event, now: u64) -> Result<Parsed> {
    verified(ev, shape(ev, now)?, now)
}

/// The tags of an ask for the manifest address `manifest_a`, with the longest allowed lifetime.
pub fn ask_tags(manifest_a: &str, created_at: u64) -> Result<Vec<Vec<String>>> {
    let (_, addr) = parse_a_tag(manifest_a)?;
    let expiration = created_at
        .checked_add(ASK_TTL)
        .ok_or_else(|| bad("`expiration` overflows"))?;
    Ok(vec![
        vec!["n".into(), addr.namespace().to_string()],
        vec!["a".into(), manifest_a.to_owned()],
        vec!["t".into(), T_ASK.into()],
        vec!["expiration".into(), expiration.to_string()],
    ])
}

/// The tags of a tell carrying `beacon`, addressed to `asker`.
pub fn tell_tags(beacon: &Event, asker: &str) -> Result<Vec<Vec<String>>> {
    if beacon.kind != KIND_BEACON {
        return Err(bad("the embedded event is not a beacon"));
    }
    if !is_lower_hex(asker, 64) {
        return Err(bad("`p` is not 64 lowercase hex"));
    }
    Ok(vec![
        vec!["n".into(), required(beacon, "n")?.to_owned()],
        vec!["a".into(), required(beacon, "a")?.to_owned()],
        vec!["t".into(), T_TELL.into()],
        vec!["p".into(), asker.to_owned()],
        vec![
            "expiration".into(),
            required(beacon, "expiration")?.to_owned(),
        ],
    ])
}

/// A tell's content: the beacon as compact JSON, members in NIP-01 order.
pub fn tell_content(beacon: &Event) -> Result<String> {
    let content = serde_json::to_string(beacon).map_err(bad)?;
    if content.len() > MAX_TELL_CONTENT {
        return Err(bad("content over 16384 bytes"));
    }
    Ok(content)
}

/// Sign an ask with a throwaway key.
pub fn ask(secret_key: &[u8; 32], manifest_a: &str, created_at: u64) -> Result<Event> {
    let tags = ask_tags(manifest_a, created_at)?;
    Event::sign(secret_key, created_at, KIND_LOOKUP, tags, String::new())
}

/// Sign a tell carrying `beacon` with the key that signed the beacon.
pub fn tell(secret_key: &[u8; 32], beacon: &Event, asker: &str, created_at: u64) -> Result<Event> {
    let tags = tell_tags(beacon, asker)?;
    let expiration =
        parse_u64_strict(required(beacon, "expiration")?).ok_or_else(|| bad("bad `expiration`"))?;
    if beacon.created_at > created_at || created_at >= expiration {
        return Err(bad("a tell is dated within its beacon's lifetime"));
    }
    Event::sign(
        secret_key,
        created_at,
        KIND_LOOKUP,
        tags,
        tell_content(beacon)?,
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use crate::beacon;

    const NOW: u64 = 1_790_000_000;
    const SEEDER: [u8; 32] = [7; 32];
    const ASKER: [u8; 32] = [9; 32];

    fn manifest_a() -> String {
        format!("38504:{}:nfx:testnet:1:clip-one", "a".repeat(64))
    }

    fn signed_beacon(created_at: u64, ttl: u64) -> Event {
        let content = serde_json::json!({
            "v": 1,
            "video": "nfx:testnet:1:clip-one",
            "endpoints": [{"t": "https", "url": "https://seed.example/nfx"}],
            "chunks": "all",
            "price_hint": 0,
            "free": true,
        })
        .to_string();
        let tags = beacon::tags(&manifest_a(), created_at, ttl).unwrap();
        Event::sign(&SEEDER, created_at, KIND_BEACON, tags, content).unwrap()
    }

    #[test]
    fn an_ask_and_its_tell_round_trip() {
        let a = manifest_a();
        let q = ask(&ASKER, &a, NOW).unwrap();
        let Parsed::Ask(got) = read(&q, NOW).unwrap() else {
            panic!("an ask")
        };
        assert_eq!(got.asker, q.pubkey);
        assert_eq!(got.a, a);

        let b = signed_beacon(NOW - 5, 60);
        let t = tell(&SEEDER, &b, &got.asker, NOW + 1).unwrap();
        let Parsed::Tell(told) = read(&t, NOW + 1).unwrap() else {
            panic!("a tell")
        };
        assert_eq!(told.asker, q.pubkey);
        assert_eq!(told.seeder, b.pubkey);
        assert_eq!(told.event, b, "the beacon arrives exactly as it was signed");
        assert_eq!(told.beacon.expiration, NOW + 55);
    }

    #[test]
    fn a_tell_cannot_outlive_its_beacon() {
        let b = signed_beacon(NOW - 5, 60);
        let t = tell(&SEEDER, &b, &"c".repeat(64), NOW).unwrap();
        assert!(read(&t, NOW + 54).is_ok());
        assert!(read(&t, NOW + 55).is_err(), "expires with the beacon");
    }

    #[test]
    fn a_relay_refuses_a_type_a_reader_ignores() {
        let tags = vec![
            vec!["n".to_owned(), "nfx:testnet:1".to_owned()],
            vec!["a".to_owned(), manifest_a()],
            vec!["t".to_owned(), "hello".to_owned()],
            vec!["expiration".to_owned(), (NOW + 60).to_string()],
        ];
        let ev = Event::sign(&ASKER, NOW, KIND_LOOKUP, tags, String::new()).unwrap();
        assert!(matches!(read(&ev, NOW), Ok(Parsed::Ignored(_))));
        assert!(relayable(&ev, NOW).is_err());
        assert!(shape(&ev, NOW).is_err());
    }

    #[test]
    fn the_shape_check_names_who_asked_without_any_signature() {
        let a = manifest_a();
        let mut q = ask(&ASKER, &a, NOW).unwrap();
        q.sig = "0".repeat(128);
        let s = shape(&q, NOW).unwrap();
        assert_eq!((s.kind, s.asker.as_str()), (Type::Ask, q.pubkey.as_str()));
        assert!(read(&q, NOW).is_err(), "the full check still refuses it");
    }

    #[test]
    fn a_tell_cannot_carry_a_beacon_dated_after_it() {
        let b = signed_beacon(NOW + 800, 120);
        assert!(tell(&SEEDER, &b, &"c".repeat(64), NOW).is_err());
        let tags = tell_tags(&b, &"c".repeat(64)).unwrap();
        let content = tell_content(&b).unwrap();
        let t = Event::sign(&SEEDER, NOW, KIND_LOOKUP, tags, content).unwrap();
        assert!(
            read(&t, NOW).is_err(),
            "it would hold a table slot for 15 min"
        );
    }

    #[test]
    fn the_embedded_beacon_has_one_spelling() {
        let b = signed_beacon(NOW - 5, 60);
        let tags = tell_tags(&b, &"c".repeat(64)).unwrap();
        let spaced = serde_json::to_string_pretty(&b).unwrap();
        let t = Event::sign(&SEEDER, NOW, KIND_LOOKUP, tags, spaced).unwrap();
        assert!(read(&t, NOW).is_err());
    }

    #[test]
    fn a_malformed_pubkey_is_refused_before_it_can_key_a_limit() {
        let mut q = ask(&ASKER, &manifest_a(), NOW).unwrap();
        q.pubkey = "not a key".to_owned();
        assert!(shape(&q, NOW).is_err());
    }

    #[test]
    fn size_limits_are_by_type() {
        assert!(size_ok(Type::Ask, MAX_ASK_BYTES));
        assert!(!size_ok(Type::Ask, MAX_ASK_BYTES + 1));
        assert!(size_ok(Type::Tell, MAX_TELL_BYTES));
        assert!(!size_ok(Type::Tell, MAX_TELL_BYTES + 1));
    }

    #[test]
    fn an_oversized_beacon_cannot_be_wrapped() {
        let mut b = signed_beacon(NOW, 60);
        b.content = "x".repeat(MAX_TELL_CONTENT);
        assert!(tell_content(&b).is_err());
    }
}
