//! The file channel (NFX-10 §6.10): a WebRTC data channel labelled `nfx-files/1` that carries
//! a video's start-up files (hash list, playlists, init segments, thumbnails, subtitles)
//! between peers, so a page can start with no origin. Media segments never travel here.
//!
//! - [`Message`]: the ten messages, one per data-channel message, a type byte then the body;
//!   [`Message::decode`] refuses every length and type the section does not allow, and
//!   [`Message::encode`] writes exactly what `decode` takes.
//! - [`Have`]: the `have` answer to `list`, `{"whole":[…],"part":[…]}`, renditions named by
//!   their index in the hash list.
//! - [`beacons_answer`] / [`read_beacons_answer`]: a `beacons` answer, 1 to 4 signed kind-20464
//!   events in their compact form (NFX-17 §1.2) as one JSON array.
//! - [`data_messages`]: a file's bytes as `data` messages of at most [`MAX_MESSAGE`] bytes.
//! - [`Requests`]: the server's book of a channel's open requests (at most
//!   [`MAX_OPEN_REQUESTS`]) and of how often it has answered each file (at most twice).
//! - [`Channel`]: one side's reading of a channel: the peer's `hello` first and once, then its
//!   requests through [`Requests`], and every other message passed on.
//!
//! Pure, like the rest of the crate: no I/O, no clock. Verifying the bytes a file arrives with
//! is the caller's (NFX-05 §§4–5), as is every check NFX-03 makes of a beacon.

use std::collections::{BTreeMap, BTreeSet};

use crate::event::Event;
use crate::{Error, KIND_BEACON, Result};

/// The channel's label. A new message type never goes under it: it takes `nfx-files/2`.
pub const LABEL: &str = "nfx-files/1";
/// The `hello` version this label speaks.
pub const VERSION: u8 = 1;
/// `hello` flag bit 0: the sender answers `get` and `list`.
pub const FLAG_FILES: u8 = 1;
/// `hello` flag bit 1: the sender answers `beacons`.
pub const FLAG_BEACONS: u8 = 2;
/// The largest message, in bytes: the most every WebRTC implementation carries in one.
pub const MAX_MESSAGE: usize = 16_384;
/// The most file bytes one `data` message carries (`MAX_MESSAGE` less the type and `req`).
pub const MAX_DATA: usize = MAX_MESSAGE - 5;
/// The most open requests per channel; one more is a protocol error.
pub const MAX_OPEN_REQUESTS: usize = 8;
/// How many times a server answers one file on a channel; a third `get` gets `missing`.
pub const MAX_ANSWERS_PER_FILE: u8 = 2;
/// The bounds of a `have` body's JSON, in bytes.
pub const MIN_HAVE_JSON: usize = 2;
/// The bounds of a `have` body's JSON, in bytes.
pub const MAX_HAVE_JSON: usize = 2_048;
/// A `have` names only the first this many renditions of a hash list: every index is below it.
pub const MAX_HAVE_IDS: usize = 32;
/// The most beacons in a `beacons` answer.
pub const MAX_BEACONS: usize = 4;
/// The largest beacon in a `beacons` answer, in its compact form.
pub const MAX_BEACON_BYTES: usize = 16_384;
/// The largest `beacons` answer, in bytes.
pub const MAX_BEACONS_ANSWER: usize = 65_536;
/// The largest hash list a requester reads.
pub const MAX_HASH_LIST: usize = 16 * 1024 * 1024;
/// The most `data` bytes a server queues per channel ahead of the transport.
pub const MAX_QUEUED: usize = 256 * 1024;
/// A peer that sends no `hello` this long after the channel opens does not speak it.
pub const HELLO_TIMEOUT_MS: u64 = 3_000;

fn bad(reason: impl core::fmt::Display) -> Error {
    Error::Event(format!("file channel: {reason}"))
}

/// One message of the channel. `Data` borrows its bytes from the message it was read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Message<'a> {
    /// Type 0: ask for one file by its sha256 (the manifest's `root` asks for the hash list).
    Get { req: u32, sha: [u8; 32] },
    /// Type 1: some of the answer's bytes, in order: 1 to [`MAX_DATA`].
    Data { req: u32, bytes: &'a [u8] },
    /// Type 2: the answer is complete.
    End { req: u32 },
    /// Type 3: the server does not hold the file, or will not serve it.
    Missing { req: u32 },
    /// Type 4: sent first by each side; `version` is always [`VERSION`] once decoded.
    Hello { version: u8, flags: u8 },
    /// Type 5: the requester ends an open request.
    Cancel { req: u32 },
    /// Type 6: the server is over a limit now; ask elsewhere.
    Busy { req: u32 },
    /// Type 7: which renditions of hash list `root` does the server hold?
    List { req: u32, root: [u8; 32] },
    /// Type 8: the answer to `list`.
    Have { req: u32, have: Have },
    /// Type 9: ask for the server's beacons of the channel's video.
    Beacons { req: u32 },
}

/// The ten type bytes, in the order of the table.
pub const TYPES: [&str; 10] = [
    "get", "data", "end", "missing", "hello", "cancel", "busy", "list", "have", "beacons",
];

fn req_of(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

fn exactly(body: &[u8], n: usize, name: &str) -> Result<()> {
    if body.len() == n {
        Ok(())
    } else {
        Err(bad(format!(
            "`{name}` is {} bytes after its type, not {n}",
            body.len()
        )))
    }
}

impl<'a> Message<'a> {
    /// Read one data-channel message. Any error is a protocol error: the receiver closes the
    /// channel (and a video-room connection with it).
    pub fn decode(msg: &'a [u8]) -> Result<Self> {
        let Some((&t, body)) = msg.split_first() else {
            return Err(bad("an empty message"));
        };
        if msg.len() > MAX_MESSAGE {
            return Err(bad(format!("a message of {} bytes", msg.len())));
        }
        let sha = |b: &[u8]| -> [u8; 32] {
            let mut s = [0; 32];
            s.copy_from_slice(&b[4..36]);
            s
        };
        Ok(match t {
            0 => {
                exactly(body, 36, "get")?;
                Self::Get {
                    req: req_of(body),
                    sha: sha(body),
                }
            }
            1 => {
                if body.len() < 5 {
                    return Err(bad("`data` carries no byte"));
                }
                Self::Data {
                    req: req_of(body),
                    bytes: &body[4..],
                }
            }
            2 => {
                exactly(body, 4, "end")?;
                Self::End { req: req_of(body) }
            }
            3 => {
                exactly(body, 4, "missing")?;
                Self::Missing { req: req_of(body) }
            }
            4 => {
                exactly(body, 2, "hello")?;
                if body[0] != VERSION {
                    return Err(bad(format!("`hello` of version {}", body[0])));
                }
                Self::Hello {
                    version: body[0],
                    flags: body[1],
                }
            }
            5 => {
                exactly(body, 4, "cancel")?;
                Self::Cancel { req: req_of(body) }
            }
            6 => {
                exactly(body, 4, "busy")?;
                Self::Busy { req: req_of(body) }
            }
            7 => {
                exactly(body, 36, "list")?;
                Self::List {
                    req: req_of(body),
                    root: sha(body),
                }
            }
            8 => {
                if body.len() < 4 + MIN_HAVE_JSON || body.len() > 4 + MAX_HAVE_JSON {
                    return Err(bad(format!(
                        "`have` JSON of {} bytes",
                        body.len().saturating_sub(4)
                    )));
                }
                Self::Have {
                    req: req_of(body),
                    have: Have::parse(&body[4..])?,
                }
            }
            9 => {
                exactly(body, 4, "beacons")?;
                Self::Beacons { req: req_of(body) }
            }
            other => return Err(bad(format!("unknown type {other}"))),
        })
    }

    /// Write the message. Refuses what [`decode`](Self::decode) would refuse.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let with_req = |t: u8, req: u32, rest: &[u8]| {
            let mut out = Vec::with_capacity(5 + rest.len());
            out.push(t);
            out.extend_from_slice(&req.to_le_bytes());
            out.extend_from_slice(rest);
            out
        };
        Ok(match self {
            Self::Get { req, sha } => with_req(0, *req, sha),
            Self::Data { req, bytes } => {
                if bytes.is_empty() || bytes.len() > MAX_DATA {
                    return Err(bad(format!("`data` of {} bytes", bytes.len())));
                }
                with_req(1, *req, bytes)
            }
            Self::End { req } => with_req(2, *req, &[]),
            Self::Missing { req } => with_req(3, *req, &[]),
            Self::Hello { version, flags } => {
                if *version != VERSION {
                    return Err(bad(format!("`hello` of version {version}")));
                }
                vec![4, *version, *flags]
            }
            Self::Cancel { req } => with_req(5, *req, &[]),
            Self::Busy { req } => with_req(6, *req, &[]),
            Self::List { req, root } => with_req(7, *req, root),
            Self::Have { req, have } => with_req(8, *req, have.to_json()?.as_bytes()),
            Self::Beacons { req } => with_req(9, *req, &[]),
        })
    }

    /// The request a message names, except `hello`, which names none.
    #[must_use]
    pub fn req(&self) -> Option<u32> {
        match self {
            Self::Get { req, .. }
            | Self::Data { req, .. }
            | Self::End { req }
            | Self::Missing { req }
            | Self::Cancel { req }
            | Self::Busy { req }
            | Self::List { req, .. }
            | Self::Have { req, .. }
            | Self::Beacons { req } => Some(*req),
            Self::Hello { .. } => None,
        }
    }
}

/// Which renditions of a hash list a server holds: `whole` with every file their media
/// playlist names, `part` with that playlist and init and at least one segment but not all.
/// Renditions are named by their index in the hash list's `renditions` (0 for the first):
/// distinct, each below [`MAX_HAVE_IDS`], none in both. Whether an index is below that hash
/// list's length is for the reader to check against it (it ignores a `have` that is not).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Have {
    pub whole: Vec<u8>,
    pub part: Vec<u8>,
}

impl Have {
    fn check(&self) -> Result<()> {
        let mut seen = BTreeSet::new();
        for &i in self.whole.iter().chain(&self.part) {
            if usize::from(i) >= MAX_HAVE_IDS {
                return Err(bad(format!(
                    "`have` names rendition {i}, past the first {MAX_HAVE_IDS}"
                )));
            }
            if !seen.insert(i) {
                return Err(bad(format!("`have` names rendition {i} twice")));
            }
        }
        Ok(())
    }

    /// Whether every index names a rendition of a hash list with `renditions` renditions.
    pub fn fits(&self, renditions: usize) -> bool {
        self.whole
            .iter()
            .chain(&self.part)
            .all(|&i| usize::from(i) < renditions)
    }

    /// Read a `have` body. Members other than `whole` and `part` are ignored.
    pub fn parse(json: &[u8]) -> Result<Self> {
        let v: serde_json::Value =
            serde_json::from_slice(json).map_err(|_| bad("`have` is not JSON"))?;
        let obj = v
            .as_object()
            .ok_or_else(|| bad("`have` is not an object"))?;
        let list = |key: &str| -> Result<Vec<u8>> {
            obj.get(key)
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| bad(format!("`have` has no `{key}` array")))?
                .iter()
                .map(|x| {
                    // A number with an integer value 0 to 31, as JSON readers see it: `1.0`
                    // is 1 (a JavaScript reader cannot tell them apart); `1.5`, `-1` and
                    // strings are refused.
                    x.as_f64()
                        .filter(|v| v.fract() == 0.0 && (0.0..MAX_HAVE_IDS as f64).contains(v))
                        .and_then(|v| u8::try_from(v as u64).ok())
                        .ok_or_else(|| {
                            bad(format!(
                                "`have` `{key}` holds something other than an index below {MAX_HAVE_IDS}"
                            ))
                        })
                })
                .collect()
        };
        let have = Self {
            whole: list("whole")?,
            part: list("part")?,
        };
        have.check()?;
        Ok(have)
    }

    /// The body a server sends: `{"whole":[…],"part":[…]}`, compact.
    pub fn to_json(&self) -> Result<String> {
        self.check()?;
        // `whole` then `part`, as the section writes it (`json!` would sort the members).
        let list = |v: &[u8]| v.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
        let s = format!(
            r#"{{"whole":[{}],"part":[{}]}}"#,
            list(&self.whole),
            list(&self.part)
        );
        if s.len() > MAX_HAVE_JSON {
            return Err(bad(format!("`have` of {} bytes", s.len())));
        }
        Ok(s)
    }
}

/// A `beacons` answer: the events as one JSON array of their compact forms, 1 to
/// [`MAX_BEACONS`] kind-20464 events of at most [`MAX_BEACON_BYTES`] each, the whole at most
/// [`MAX_BEACONS_ANSWER`]. The server's own beacon goes first.
pub fn beacons_answer(beacons: &[Event]) -> Result<Vec<u8>> {
    if beacons.is_empty() || beacons.len() > MAX_BEACONS {
        return Err(bad(format!(
            "a `beacons` answer of {} events",
            beacons.len()
        )));
    }
    let mut parts = Vec::with_capacity(beacons.len());
    for ev in beacons {
        if ev.kind != KIND_BEACON {
            return Err(bad(
                "a `beacons` answer holds an event that is not a beacon",
            ));
        }
        let one = serde_json::to_string(ev).map_err(bad)?;
        if one.len() > MAX_BEACON_BYTES {
            return Err(bad(format!("a beacon of {} bytes", one.len())));
        }
        parts.push(one);
    }
    let all = format!("[{}]", parts.join(","));
    if all.len() > MAX_BEACONS_ANSWER {
        return Err(bad(format!("a `beacons` answer of {} bytes", all.len())));
    }
    Ok(all.into_bytes())
}

/// Read a `beacons` answer: its events, in order, each in its compact form, before any NFX-03
/// check (the caller makes those, at its own clock). Refuses what [`beacons_answer`] would not
/// write, so every reader takes the same bytes as the same events.
pub fn read_beacons_answer(bytes: &[u8]) -> Result<Vec<Event>> {
    if bytes.len() > MAX_BEACONS_ANSWER {
        return Err(bad(format!("a `beacons` answer of {} bytes", bytes.len())));
    }
    let events: Vec<Event> = serde_json::from_slice(bytes)
        .map_err(|_| bad("a `beacons` answer is not an event array"))?;
    if beacons_answer(&events)? != bytes {
        return Err(bad("a `beacons` answer is not in its compact form"));
    }
    Ok(events)
}

/// A file's bytes as the `data` messages that carry it, in order, then its `end`.
pub fn data_messages(req: u32, file: &[u8]) -> Result<Vec<Vec<u8>>> {
    if file.is_empty() {
        return Err(bad("an empty file"));
    }
    let mut out: Vec<Vec<u8>> = file
        .chunks(MAX_DATA)
        .map(|bytes| Message::Data { req, bytes }.encode())
        .collect::<Result<_>>()?;
    out.push(Message::End { req }.encode()?);
    Ok(out)
}

/// What a requester asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asked {
    /// A `get` of this sha256.
    File([u8; 32]),
    /// A `list` of this hash list.
    List([u8; 32]),
    /// A `beacons`.
    Beacons,
}

/// What the server should do with a request it accepted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admit {
    /// Serve it (if it holds and may serve it).
    Serve,
    /// Answer `missing` now: the file was answered twice on this channel already.
    Missing,
}

/// The server's book of one channel: the requests open now and how often each file has been
/// answered. A request is open from its arrival until the server's `end`, `missing`, `busy` or
/// `have` for it, or the requester's `cancel`.
#[derive(Debug, Default)]
pub struct Requests {
    open: BTreeMap<u32, Asked>,
    answered: BTreeMap<[u8; 32], u8>,
}

impl Requests {
    /// A request arrived. An error is a protocol error: a ninth open request, a `req` already
    /// open, or a second open `get` of one file.
    pub fn arrive(&mut self, req: u32, asked: Asked) -> Result<Admit> {
        if self.open.contains_key(&req) {
            return Err(bad(format!("request {req} is already open")));
        }
        if self.open.len() >= MAX_OPEN_REQUESTS {
            return Err(bad(format!("more than {MAX_OPEN_REQUESTS} open requests")));
        }
        if let Asked::File(sha) = asked {
            if self.open.values().any(|a| *a == Asked::File(sha)) {
                return Err(bad("two open requests for one file"));
            }
            let n = self.answered.entry(sha).or_insert(0);
            if *n >= MAX_ANSWERS_PER_FILE {
                // Answered at once, so it is never open.
                return Ok(Admit::Missing);
            }
            *n += 1;
        }
        self.open.insert(req, asked);
        Ok(Admit::Serve)
    }

    /// The server answered `req` for the last time (`end`, `missing`, `busy` or `have`), or the
    /// requester cancelled it. Whether it was open.
    pub fn close(&mut self, req: u32) -> bool {
        self.open.remove(&req).is_some()
    }

    /// Whether `req` is open (so its answers may still be sent).
    #[must_use]
    pub fn is_open(&self, req: u32) -> bool {
        self.open.contains_key(&req)
    }

    /// How many requests are open.
    #[must_use]
    pub fn open_count(&self) -> usize {
        self.open.len()
    }
}

/// A message read by [`Channel::read`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Read<'a> {
    /// The peer's `hello`: the bits it set of [`FLAG_FILES`] and [`FLAG_BEACONS`] (other bits
    /// are ignored).
    Hello { flags: u8 },
    /// A request for us to serve: `get`, `list` or `beacons`.
    Request {
        req: u32,
        asked: Asked,
        admit: Admit,
    },
    /// The peer cancelled a request it had open with us (`false`: it was not open, as when an
    /// answer and the `cancel` crossed).
    Cancelled { req: u32, was_open: bool },
    /// An answer to one of our requests (`data`, `end`, `missing`, `busy`, `have`); matching it
    /// to an open request of ours is the caller's.
    Answer(Message<'a>),
}

/// One side's reading of a channel. Every error is a protocol error: close the channel.
#[derive(Debug, Default)]
pub struct Channel {
    peer_flags: Option<u8>,
    requests: Requests,
}

impl Channel {
    /// Read the peer's next message.
    pub fn read<'a>(&mut self, bytes: &'a [u8]) -> Result<Read<'a>> {
        let m = Message::decode(bytes)?;
        if let Message::Hello { flags, .. } = m {
            if self.peer_flags.is_some() {
                return Err(bad("a second `hello`"));
            }
            let flags = flags & (FLAG_FILES | FLAG_BEACONS);
            self.peer_flags = Some(flags);
            return Ok(Read::Hello { flags });
        }
        if self.peer_flags.is_none() {
            return Err(bad("a message before `hello`"));
        }
        let req = m.req().unwrap_or_default();
        let asked = match m {
            Message::Get { sha, .. } => Asked::File(sha),
            Message::List { root, .. } => Asked::List(root),
            Message::Beacons { .. } => Asked::Beacons,
            Message::Cancel { req } => {
                return Ok(Read::Cancelled {
                    req,
                    was_open: self.requests.close(req),
                });
            }
            other => return Ok(Read::Answer(other)),
        };
        let admit = self.requests.arrive(req, asked)?;
        Ok(Read::Request { req, asked, admit })
    }

    /// The flags of the peer's `hello`, once it has arrived.
    #[must_use]
    pub fn peer_flags(&self) -> Option<u8> {
        self.peer_flags
    }

    /// We sent our last answer to `req` (`end`, `missing`, `busy` or `have`). Whether it was open.
    pub fn answered(&mut self, req: u32) -> bool {
        self.requests.close(req)
    }

    /// The requests the peer has open with us.
    #[must_use]
    pub fn requests(&self) -> &Requests {
        &self.requests
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn every_message_round_trips_and_has_its_one_length() {
        let sha = [7; 32];
        let have = Have {
            whole: vec![1],
            part: vec![0],
        };
        let msgs = [
            Message::Get { req: 1, sha },
            Message::Data {
                req: 2,
                bytes: b"abc",
            },
            Message::End { req: 3 },
            Message::Missing { req: 4 },
            Message::Hello {
                version: 1,
                flags: FLAG_FILES | FLAG_BEACONS,
            },
            Message::Cancel { req: 5 },
            Message::Busy { req: 6 },
            Message::List { req: 7, root: sha },
            Message::Have { req: 8, have },
            Message::Beacons { req: 9 },
        ];
        for m in &msgs {
            let b = m.encode().unwrap();
            assert_eq!(&Message::decode(&b).unwrap(), m);
            if !matches!(m, Message::Data { .. } | Message::Have { .. }) {
                let mut longer = b.clone();
                longer.push(0);
                assert!(Message::decode(&longer).is_err(), "{m:?} + 1 byte");
                assert!(
                    Message::decode(&b[..b.len() - 1]).is_err(),
                    "{m:?} - 1 byte"
                );
            }
        }
        assert_eq!(Message::Get { req: 1, sha }.encode().unwrap().len(), 37);
    }

    #[test]
    fn refused_messages() {
        for bad in [
            vec![],
            vec![10, 0, 0, 0, 0],
            vec![255],
            vec![1, 0, 0, 0, 0],
            vec![4, 2, 0],
            vec![8, 0, 0, 0, 0, b'{'],
        ] {
            assert!(Message::decode(&bad).is_err(), "{bad:?}");
        }
        let mut big = vec![1, 0, 0, 0, 0];
        big.resize(MAX_MESSAGE + 1, 0);
        assert!(Message::decode(&big).is_err());
        big.truncate(MAX_MESSAGE);
        assert!(Message::decode(&big).is_ok());
    }

    #[test]
    fn have_takes_distinct_indices_only() {
        assert!(Have::parse(br#"{"whole":[],"part":[]}"#).is_ok());
        assert!(Have::parse(br#"{"whole":[],"part":[],"x":1}"#).is_ok());
        let all = Have::parse(br#"{"whole":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"part":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31]}"#).unwrap();
        assert_eq!(all.to_json().unwrap().len(), 107, "the largest `have`");
        assert!(all.fits(32) && !all.fits(31));
        assert_eq!(
            Have::parse(br#"{"whole":[1.0],"part":[]}"#).unwrap().whole,
            [1],
            "1.0 is 1"
        );
        for bad in [
            &br#"{"whole":[1],"part":[1]}"#[..],
            br#"{"whole":[2,2],"part":[]}"#,
            br#"{"whole":[32],"part":[]}"#,
            br#"{"whole":[-1],"part":[]}"#,
            br#"{"whole":[1.5],"part":[]}"#,
            br#"{"whole":["720p"],"part":[]}"#,
            br#"{"whole":[]}"#,
            br#"[]"#,
        ] {
            assert!(
                Have::parse(bad).is_err(),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
        let past = Have {
            whole: vec![32],
            part: vec![],
        };
        assert!(past.to_json().is_err());
    }

    #[test]
    fn a_file_spans_data_messages_then_end() {
        let file = vec![9u8; MAX_DATA * 2 + 1];
        let msgs = data_messages(42, &file).unwrap();
        assert_eq!(msgs.len(), 4);
        assert!(msgs.iter().all(|m| m.len() <= MAX_MESSAGE));
        let mut got = Vec::new();
        for m in &msgs[..3] {
            let Message::Data { req: 42, bytes } = Message::decode(m).unwrap() else {
                panic!("data")
            };
            got.extend_from_slice(bytes);
        }
        assert_eq!(got, file);
        assert_eq!(Message::decode(&msgs[3]).unwrap(), Message::End { req: 42 });
    }

    #[test]
    fn a_channel_takes_hello_first_and_once() {
        let mut ch = Channel::default();
        let get = Message::Get {
            req: 1,
            sha: [1; 32],
        }
        .encode()
        .unwrap();
        assert!(ch.read(&get).is_err(), "before hello");
        let mut ch = Channel::default();
        assert_eq!(ch.read(&[4, 1, 0xFF]).unwrap(), Read::Hello { flags: 3 });
        assert!(matches!(
            ch.read(&get).unwrap(),
            Read::Request {
                req: 1,
                admit: Admit::Serve,
                ..
            }
        ));
        assert_eq!(ch.requests().open_count(), 1);
        assert_eq!(
            ch.read(&Message::Cancel { req: 1 }.encode().unwrap())
                .unwrap(),
            Read::Cancelled {
                req: 1,
                was_open: true
            }
        );
        assert!(matches!(
            ch.read(&Message::End { req: 5 }.encode().unwrap()).unwrap(),
            Read::Answer(Message::End { req: 5 })
        ));
        assert!(ch.read(&[4, 1, 0]).is_err(), "a second hello");
    }

    #[test]
    fn the_server_book_bounds_open_requests_and_repeats() {
        let mut book = Requests::default();
        for req in 0..8 {
            assert_eq!(
                book.arrive(req, Asked::File([req as u8; 32])).unwrap(),
                Admit::Serve
            );
        }
        assert!(book.arrive(8, Asked::Beacons).is_err());
        assert!(book.close(0));
        assert!(!book.close(0));
        assert!(book.arrive(1, Asked::Beacons).is_err(), "1 is open");
        assert!(
            book.arrive(9, Asked::File([1; 32])).is_err(),
            "one file twice open"
        );
        // File 0: answered once, asked again, then a third time.
        assert_eq!(book.arrive(10, Asked::File([0; 32])).unwrap(), Admit::Serve);
        book.close(10);
        assert_eq!(
            book.arrive(11, Asked::File([0; 32])).unwrap(),
            Admit::Missing
        );
        assert!(!book.is_open(11));
    }
}
