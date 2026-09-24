//! p2p-media-loader 4.0.0's peer protocol on the WebRTC data channel (NFX-10 §1): the
//! commands a bridge exchanges with browser peers. It is pure (no I/O), and byte-identical
//! to the shipped library: the tests use vectors produced by running its own encoder.
//!
//! Wire shape:
//! - A message is a **command chunk** if it is at least 8 bytes, starts with `cstr` or
//!   `dstr`, and ends with `cend` or `dend`. Anything else is raw segment data, appended
//!   in order to the transfer in progress.
//! - A command is `cmd:u8` then `(name:u8 item)*`. An item is an Int (`0x0N` + N bytes,
//!   big-endian sign-magnitude), a SimilarIntArray (`0x10`, groups by 256-block), or a
//!   String (`0x2L L`, never sent in 4.0.0).
//! - A command longer than one message is split `cstr…dend`, `dstr…dend`, …, `dstr…cend`.

/// The largest data-channel message p2p-media-loader sends.
pub const MAX_MESSAGE: usize = 65_535;
/// The largest integer the JS side can hold exactly (and the 7-byte Int can carry).
pub const MAX_INT: u64 = (1 << 53) - 1;

const CSTR: &[u8; 4] = b"cstr";
const DSTR: &[u8; 4] = b"dstr";
const CEND: &[u8; 4] = b"cend";
const DEND: &[u8; 4] = b"dend";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Full state: segments stored (`loaded`) and being fetched over HTTP (`loading`).
    Announcement {
        loaded: Vec<u64>,
        loading: Vec<u64>,
    },
    /// Ask for segment `id` from byte `from` (0: from the start).
    Request {
        id: u64,
        request: u64,
        from: u64,
    },
    /// `size` bytes of segment `id` follow as raw messages.
    Data {
        id: u64,
        request: u64,
        size: u64,
    },
    Completed {
        id: u64,
        request: u64,
    },
    Absent {
        id: u64,
        request: u64,
    },
    Cancel {
        id: u64,
        request: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtoError {
    #[error("malformed command: {0}")]
    Malformed(&'static str),
    #[error("command framing: {0}")]
    Framing(&'static str),
    #[error("value out of range")]
    Range,
}

/// Whether a data-channel message is a command chunk rather than segment data.
#[must_use]
pub fn is_command_chunk(m: &[u8]) -> bool {
    m.len() >= 8
        && (m[..4] == *CSTR || m[..4] == *DSTR)
        && (m[m.len() - 4..] == *CEND || m[m.len() - 4..] == *DEND)
}

fn int_len(v: u64) -> usize {
    if v == 0 {
        1
    } else {
        (63 - v.leading_zeros() as usize + 2).div_ceil(8)
    }
}

fn put_int(out: &mut Vec<u8>, v: u64) -> Result<(), ProtoError> {
    if v > MAX_INT {
        return Err(ProtoError::Range);
    }
    let n = int_len(v);
    out.push(n as u8);
    out.extend_from_slice(&v.to_be_bytes()[8 - n..]);
    Ok(())
}

fn put_array(out: &mut Vec<u8>, values: &[u64]) -> Result<(), ProtoError> {
    // Groups by 256-block, in first-appearance order, members in input order.
    let mut groups: Vec<(u64, Vec<u8>)> = Vec::new();
    for &v in values {
        let common = v & !0xFF;
        match groups.iter_mut().find(|(c, _)| *c == common) {
            Some((_, members)) => members.push((v & 0xFF) as u8),
            None => groups.push((common, vec![(v & 0xFF) as u8])),
        }
    }
    // The group count is one byte and a group holds at most 256 (unique) values.
    if groups.len() > 255 || groups.iter().any(|(_, m)| m.len() > 256) {
        return Err(ProtoError::Range);
    }
    out.push(0x10);
    out.push(groups.len() as u8);
    for (common, members) in &groups {
        put_int(out, common + (members.len() as u64 & 0xFF))?;
        out.extend_from_slice(members);
    }
    Ok(())
}

/// The unframed payload of `cmd`.
pub fn payload(cmd: &Command) -> Result<Vec<u8>, ProtoError> {
    let mut p = Vec::new();
    let field = |p: &mut Vec<u8>, name: u8, v: u64| {
        p.push(name);
        put_int(p, v)
    };
    match cmd {
        Command::Announcement { loaded, loading } => {
            p.push(0);
            if !loaded.is_empty() {
                p.push(b'l');
                put_array(&mut p, loaded)?;
            }
            if !loading.is_empty() {
                p.push(b'p');
                put_array(&mut p, loading)?;
            }
        }
        Command::Request { id, request, from } => {
            p.push(1);
            field(&mut p, b'i', *id)?;
            field(&mut p, b'r', *request)?;
            if *from > 0 {
                field(&mut p, b'b', *from)?;
            }
        }
        Command::Data { id, request, size } => {
            p.push(2);
            field(&mut p, b'i', *id)?;
            field(&mut p, b's', *size)?;
            field(&mut p, b'r', *request)?;
        }
        Command::Completed { id, request }
        | Command::Absent { id, request }
        | Command::Cancel { id, request } => {
            p.push(match cmd {
                Command::Completed { .. } => 3,
                Command::Absent { .. } => 4,
                _ => 5,
            });
            field(&mut p, b'i', *id)?;
            field(&mut p, b'r', *request)?;
        }
    }
    Ok(p)
}

/// `cmd` as the data-channel messages that carry it, each at most [`MAX_MESSAGE`] bytes
/// (the library's split rule, byte for byte).
pub fn encode(cmd: &Command) -> Result<Vec<Vec<u8>>, ProtoError> {
    Ok(frame(&payload(cmd)?, MAX_MESSAGE))
}

fn frame(p: &[u8], max: usize) -> Vec<Vec<u8>> {
    let whole = |start: &[u8; 4], body: &[u8], end: &[u8; 4]| {
        let mut m = Vec::with_capacity(body.len() + 8);
        m.extend_from_slice(start);
        m.extend_from_slice(body);
        m.extend_from_slice(end);
        m
    };
    if p.len() + 8 <= max {
        return vec![whole(CSTR, p, CEND)];
    }
    let mut n = p.len().div_ceil(max);
    if p.len().div_ceil(n) + 8 > max {
        n += 1;
    }
    let size = p.len().div_ceil(n);
    (0..n)
        .map(|i| {
            let body = &p[(i * size).min(p.len())..((i + 1) * size).min(p.len())];
            let start = if i == 0 { CSTR } else { DSTR };
            let end = if i + 1 == n { CEND } else { DEND };
            whole(start, body, end)
        })
        .collect()
}

/// Reassembles command chunks into commands.
#[derive(Debug, Default)]
pub struct Reassembler {
    joining: Option<Vec<u8>>,
}

impl Reassembler {
    /// Feed one command chunk ([`is_command_chunk`]); a whole command when it completes.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Option<Command>, ProtoError> {
        if !is_command_chunk(chunk) {
            return Err(ProtoError::Framing("not a command chunk"));
        }
        let first = chunk[..4] == *CSTR;
        let last = chunk[chunk.len() - 4..] == *CEND;
        let body = &chunk[4..chunk.len() - 4];
        let mut p = match (self.joining.take(), first) {
            (None, true) => Vec::new(),
            (None, false) => return Err(ProtoError::Framing("no first chunk")),
            (Some(_), true) => return Err(ProtoError::Framing("incomplete joining")),
            (Some(p), false) => p,
        };
        if p.len() + body.len() > 16 * MAX_MESSAGE {
            return Err(ProtoError::Framing("command too long"));
        }
        p.extend_from_slice(body);
        if last {
            decode(&p).map(Some)
        } else {
            self.joining = Some(p);
            Ok(None)
        }
    }
}

enum Item {
    Int(u64),
    Array(Vec<u64>),
    Str,
}

struct Cursor<'a> {
    b: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn byte(&mut self) -> Result<u8, ProtoError> {
        let v = *self
            .b
            .get(self.at)
            .ok_or(ProtoError::Malformed("truncated"))?;
        self.at += 1;
        Ok(v)
    }

    fn bytes(&mut self, n: usize) -> Result<&[u8], ProtoError> {
        let end = self
            .at
            .checked_add(n)
            .ok_or(ProtoError::Malformed("truncated"))?;
        let s = self
            .b
            .get(self.at..end)
            .ok_or(ProtoError::Malformed("truncated"))?;
        self.at = end;
        Ok(s)
    }

    fn int(&mut self) -> Result<u64, ProtoError> {
        let h = self.byte()?;
        let n = usize::from(h & 0x0F);
        if h >> 4 != 0 || n == 0 || n > 7 {
            return Err(ProtoError::Malformed("bad int header"));
        }
        let raw = self.bytes(n)?;
        if raw[0] & 0x80 != 0 {
            return Err(ProtoError::Malformed("negative value"));
        }
        Ok(raw.iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b)))
    }

    fn item(&mut self) -> Result<Item, ProtoError> {
        let h = *self
            .b
            .get(self.at)
            .ok_or(ProtoError::Malformed("truncated"))?;
        match h >> 4 {
            0 => self.int().map(Item::Int),
            1 => {
                self.at += 1;
                let groups = self.byte()?;
                let mut out = Vec::new();
                for _ in 0..groups {
                    let v = self.int()?;
                    let len = match v & 0xFF {
                        0 => 256,
                        n => n as usize,
                    };
                    let common = v & !0xFF;
                    out.extend(self.bytes(len)?.iter().map(|&b| common + u64::from(b)));
                }
                Ok(Item::Array(out))
            }
            2 => {
                self.at += 1;
                let len = (usize::from(h & 0x0F) << 8) | usize::from(self.byte()?);
                self.bytes(len)?;
                Ok(Item::Str)
            }
            _ => Err(ProtoError::Malformed("bad item type")),
        }
    }
}

/// Decode an unframed payload.
pub fn decode(p: &[u8]) -> Result<Command, ProtoError> {
    let mut c = Cursor { b: p, at: 0 };
    let kind = c.byte()?;
    let mut ints: Vec<(u8, u64)> = Vec::new();
    let mut arrays: Vec<(u8, Vec<u64>)> = Vec::new();
    while c.at < p.len() {
        let name = c.byte()?;
        match c.item()? {
            Item::Int(v) => ints.push((name, v)),
            Item::Array(v) => arrays.push((name, v)),
            Item::Str => {}
        }
    }
    let int = |name: u8| ints.iter().rev().find(|(n, _)| *n == name).map(|(_, v)| *v);
    let need = |name: u8| int(name).ok_or(ProtoError::Malformed("missing field"));
    let array = |name: u8| -> Result<Vec<u64>, ProtoError> {
        if int(name).is_some() {
            return Err(ProtoError::Malformed("expected an array"));
        }
        Ok(arrays
            .iter()
            .rev()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default())
    };
    Ok(match kind {
        0 => Command::Announcement {
            loaded: array(b'l')?,
            loading: array(b'p')?,
        },
        1 => Command::Request {
            id: need(b'i')?,
            request: need(b'r')?,
            from: int(b'b').unwrap_or(0),
        },
        2 => Command::Data {
            id: need(b'i')?,
            request: need(b'r')?,
            size: need(b's')?,
        },
        3 => Command::Completed {
            id: need(b'i')?,
            request: need(b'r')?,
        },
        4 => Command::Absent {
            id: need(b'i')?,
            request: need(b'r')?,
        },
        5 => Command::Cancel {
            id: need(b'i')?,
            request: need(b'r')?,
        },
        _ => return Err(ProtoError::Malformed("unknown command")),
    })
}

/// Split segment bytes into data messages of at most `max` bytes, none of which could be
/// mistaken for a command chunk (a chunk that would be is shortened by a byte).
#[must_use]
pub fn data_chunks(bytes: &[u8], max: usize) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while !rest.is_empty() {
        let mut len = rest.len().min(max.max(9));
        while len >= 8 && is_command_chunk(&rest[..len]) {
            len -= 1;
        }
        out.push(&rest[..len]);
        rest = &rest[len..];
    }
    out
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn h(s: &str) -> Vec<u8> {
        hex::decode(s.replace(' ', "")).unwrap()
    }

    fn one(cmd: &Command) -> Vec<u8> {
        let mut m = encode(cmd).unwrap();
        assert_eq!(m.len(), 1);
        m.remove(0)
    }

    /// Vectors produced by p2p-media-loader-core 4.0.0's own encoder under node 22.
    #[test]
    fn commands_are_byte_identical_to_the_library() {
        let r = |id, request, from| Command::Request { id, request, from };
        assert_eq!(one(&r(42, 7, 0)), h("637374720169012a72010763656e64"));
        assert_eq!(
            one(&r(42, 7, 131_072)),
            h("637374720169012a720107620302000063656e64")
        );
        assert_eq!(
            one(&r(3, 999_999_999, 0)),
            h("637374720169010372043b9ac9ff63656e64")
        );
        assert_eq!(
            one(&Command::Data {
                id: 42,
                request: 7,
                size: 1_234_567
            }),
            h("637374720269012a730312d68772010763656e64")
        );
        assert_eq!(
            one(&Command::Completed { id: 42, request: 7 }),
            h("637374720369012a72010763656e64")
        );
        assert_eq!(
            one(&Command::Absent { id: 42, request: 7 }),
            h("637374720469012a72010763656e64")
        );
        assert_eq!(
            one(&Command::Cancel { id: 42, request: 7 }),
            h("637374720569012a72010763656e64")
        );
        let ann = |loaded: Vec<u64>, loading: Vec<u64>| Command::Announcement { loaded, loading };
        assert_eq!(one(&ann(vec![], vec![])), h("637374720063656e64"));
        assert_eq!(
            one(&ann(vec![0, 1, 2, 3, 4], vec![5])),
            h("63737472006c10010105000102030470100101010563656e64")
        );
        assert_eq!(
            one(&ann(vec![1000, 1001, 1002, 255, 256], vec![1003])),
            h("63737472006c1003020303e8e9ea0101ff02010100701001020301eb63656e64")
        );
        let full: Vec<u64> = (512..768).collect();
        let m = one(&ann(full.clone(), vec![]));
        assert_eq!(m.len(), 271);
        assert_eq!(m[..12], h("63737472006c100102020000")[..]);
        // Every vector decodes back to its command.
        for cmd in [
            r(42, 7, 131_072),
            ann(vec![1000, 1001, 1002, 255, 256], vec![1003]),
            ann(full, vec![]),
        ] {
            let mut re = Reassembler::default();
            let mut got = None;
            for chunk in encode(&cmd).unwrap() {
                got = re.feed(&chunk).unwrap();
            }
            assert_eq!(got, Some(cmd));
        }
    }

    #[test]
    fn integers_use_the_library_widths() {
        for (v, n) in [
            (0u64, 1),
            (127, 1),
            (128, 2),
            (32_767, 2),
            (32_768, 3),
            (999_999_999, 4),
            (1 << 31, 5),
            (MAX_INT, 7),
        ] {
            assert_eq!(int_len(v), n, "{v}");
        }
        assert_eq!(
            put_int(&mut Vec::new(), MAX_INT + 1),
            Err(ProtoError::Range)
        );
    }

    #[test]
    fn long_commands_split_as_the_library_does() {
        // max = 16: the library's own output for {l:[0..19]}.
        let p = payload(&Command::Announcement {
            loaded: (0..20).collect(),
            loading: vec![],
        })
        .unwrap();
        let msgs = frame(&p, 16);
        assert_eq!(
            msgs,
            vec![
                h("63737472006c1001011400010264656e64"),
                h("64737472030405060708090a0b64656e64"),
                h("647374720c0d0e0f1011121363656e64"),
            ]
        );
        let mut re = Reassembler::default();
        assert_eq!(re.feed(&msgs[0]).unwrap(), None);
        assert_eq!(re.feed(&msgs[1]).unwrap(), None);
        assert!(re.feed(&msgs[2]).unwrap().is_some());
    }

    #[test]
    fn malformed_input_is_an_error_never_a_panic() {
        let mut re = Reassembler::default();
        assert!(
            re.feed(&h("64737472 00 63656e64")).is_err(),
            "no first chunk"
        );
        let mut re = Reassembler::default();
        re.feed(&h("63737472 00 64656e64")).unwrap();
        assert!(
            re.feed(&h("63737472 00 63656e64")).is_err(),
            "incomplete joining"
        );
        for bad in [
            "",
            "09",
            "01 69 00",
            "01 69 08 0000000000000000",
            "01 69 01 80 72 01 07",
            "01 69 012a",
            "00 6c 01 05",
            "00 6c 10 01 01 05 0001",
            "07",
            "01 69 30",
        ] {
            assert!(decode(&h(bad)).is_err(), "{bad}");
        }
        // Unknown field names are ignored, as by the library.
        assert_eq!(
            decode(&h("0369012a7201077a0101")).unwrap(),
            Command::Completed { id: 42, request: 7 }
        );
    }

    #[test]
    fn data_never_looks_like_a_command() {
        let mut evil = b"cstr".to_vec();
        evil.extend_from_slice(&[0u8; 20]);
        evil.extend_from_slice(b"cend");
        let chunks = data_chunks(&evil, 1024);
        assert!(chunks.iter().all(|c| !is_command_chunk(c)));
        assert_eq!(chunks.concat(), evil);
        let big = vec![7u8; 100_000];
        let chunks = data_chunks(&big, 16_384);
        assert!(chunks.iter().all(|c| c.len() <= 16_384));
        assert_eq!(chunks.concat(), big);
    }
}
