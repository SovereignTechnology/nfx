//! Minimal ISO BMFF reading for CMAF init segments: walk boxes and produce the RFC 6381
//! CODECS strings of the sample entries (`avc1.PPCCLL` from `avcC`, `mp4a.OO.A` from
//! `esds`). Parsing only; every read is bounds-checked and malformed input is an error.
//!
//! Box header: 32-bit big-endian size, 4-char type. `size == 1` → a 64-bit size follows;
//! `size == 0` → the box extends to the end of its parent.

use crate::{MediaError, Result};

/// One box: its four-character type and its body (the bytes after the header).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mp4Box<'a> {
    pub kind: [u8; 4],
    pub body: &'a [u8],
}

fn bad(what: &str) -> MediaError {
    MediaError::Mp4(what.to_owned())
}

fn be_u32(b: &[u8], at: usize) -> Result<u32> {
    let bytes = b.get(at..at + 4).ok_or_else(|| bad("truncated u32"))?;
    Ok(u32::from_be_bytes(
        bytes.try_into().map_err(|_| bad("truncated u32"))?,
    ))
}

/// The boxes directly inside `data`, in order.
pub fn boxes(data: &[u8]) -> Result<Vec<Mp4Box<'_>>> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off < data.len() {
        let rest = &data[off..];
        if rest.len() < 8 {
            return Err(bad("truncated box header"));
        }
        let size32 = be_u32(rest, 0)?;
        let kind: [u8; 4] = rest[4..8].try_into().map_err(|_| bad("box type"))?;
        let (header, size) = match size32 {
            0 => (8usize, rest.len()),
            1 => {
                let hi = u64::from(be_u32(rest, 8)?);
                let lo = u64::from(be_u32(rest, 12)?);
                let size = usize::try_from((hi << 32) | lo).map_err(|_| bad("box too large"))?;
                (16, size)
            }
            n => (8, usize::try_from(n).map_err(|_| bad("box size"))?),
        };
        if size < header || size > rest.len() {
            return Err(bad("box size out of bounds"));
        }
        out.push(Mp4Box {
            kind,
            body: &rest[header..size],
        });
        off += size;
    }
    Ok(out)
}

/// The body of the first child box of type `kind`.
pub fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Result<Option<&'a [u8]>> {
    Ok(boxes(data)?
        .into_iter()
        .find(|b| &b.kind == kind)
        .map(|b| b.body))
}

fn required<'a>(data: &'a [u8], kind: &[u8; 4]) -> Result<&'a [u8]> {
    child(data, kind)?
        .ok_or_else(|| bad(&format!("missing '{}' box", String::from_utf8_lossy(kind))))
}

/// VisualSampleEntry fields before its child boxes (ISO/IEC 14496-12 §12.1.3).
const VISUAL_SAMPLE_ENTRY_HEADER: usize = 78;
/// AudioSampleEntry fields before its child boxes (§12.2.3).
const AUDIO_SAMPLE_ENTRY_HEADER: usize = 28;

/// RFC 6381 CODECS strings of every track in an init segment, video first.
pub fn init_codecs(init: &[u8]) -> Result<Vec<String>> {
    let moov = required(init, b"moov")?;
    let mut video = Vec::new();
    let mut audio = Vec::new();
    for trak in boxes(moov)?.into_iter().filter(|b| &b.kind == b"trak") {
        let stbl = required(required(required(trak.body, b"mdia")?, b"minf")?, b"stbl")?;
        let stsd = required(stbl, b"stsd")?;
        // Full box: version/flags (4) + entry_count (4), then the sample entries.
        let entries = stsd.get(8..).ok_or_else(|| bad("truncated stsd"))?;
        let entry = *boxes(entries)?.first().ok_or_else(|| bad("empty stsd"))?;
        match &entry.kind {
            b"avc1" | b"avc3" => {
                let children = entry
                    .body
                    .get(VISUAL_SAMPLE_ENTRY_HEADER..)
                    .ok_or_else(|| bad("truncated visual sample entry"))?;
                let avcc = required(children, b"avcC")?;
                let [_, profile, compat, level, ..] = avcc else {
                    return Err(bad("truncated avcC"));
                };
                let prefix = String::from_utf8_lossy(&entry.kind);
                video.push(format!("{prefix}.{profile:02x}{compat:02x}{level:02x}"));
            }
            b"mp4a" => {
                let children = entry
                    .body
                    .get(AUDIO_SAMPLE_ENTRY_HEADER..)
                    .ok_or_else(|| bad("truncated audio sample entry"))?;
                let esds = required(children, b"esds")?;
                audio.push(esds_codec(
                    esds.get(4..).ok_or_else(|| bad("truncated esds"))?,
                )?);
            }
            other => {
                return Err(MediaError::Unsupported(format!(
                    "sample entry '{}' (NFX M1 packages H.264 + AAC)",
                    String::from_utf8_lossy(other)
                )));
            }
        }
    }
    if video.is_empty() {
        return Err(bad("no video track"));
    }
    video.extend(audio);
    Ok(video)
}

/// Reads MPEG-4 descriptors (ISO/IEC 14496-1 §8.3): tag, then a 1–4 byte 7-bit size.
struct Descriptors<'a> {
    data: &'a [u8],
}

impl<'a> Descriptors<'a> {
    fn next(&mut self) -> Result<Option<(u8, &'a [u8])>> {
        let Some((&tag, mut rest)) = self.data.split_first() else {
            return Ok(None);
        };
        let mut size = 0usize;
        for i in 0..4 {
            let (&byte, tail) = rest
                .split_first()
                .ok_or_else(|| bad("truncated descriptor size"))?;
            rest = tail;
            size = (size << 7) | usize::from(byte & 0x7f);
            if byte & 0x80 == 0 {
                break;
            }
            if i == 3 {
                return Err(bad("descriptor size too long"));
            }
        }
        let body = rest
            .get(..size)
            .ok_or_else(|| bad("descriptor overruns its box"))?;
        self.data = &rest[size..];
        Ok(Some((tag, body)))
    }

    fn find(mut self, want: u8) -> Result<Option<&'a [u8]>> {
        while let Some((tag, body)) = self.next()? {
            if tag == want {
                return Ok(Some(body));
            }
        }
        Ok(None)
    }
}

/// `mp4a.<objectTypeIndication hex>.<audioObjectType>` from an ES_Descriptor.
fn esds_codec(es: &[u8]) -> Result<String> {
    let es_desc = Descriptors { data: es }
        .find(0x03)?
        .ok_or_else(|| bad("no ES_Descriptor"))?;
    let flags = *es_desc
        .get(2)
        .ok_or_else(|| bad("truncated ES_Descriptor"))?;
    let mut at = 3;
    if flags & 0x80 != 0 {
        at += 2; // dependsOn_ES_ID
    }
    if flags & 0x40 != 0 {
        at += 1 + usize::from(*es_desc.get(at).ok_or_else(|| bad("truncated URL"))?);
    }
    if flags & 0x20 != 0 {
        at += 2; // OCR_ES_Id
    }
    let rest = es_desc
        .get(at..)
        .ok_or_else(|| bad("truncated ES_Descriptor"))?;
    let dcd = Descriptors { data: rest }
        .find(0x04)?
        .ok_or_else(|| bad("no DecoderConfigDescriptor"))?;
    let oti = *dcd
        .first()
        .ok_or_else(|| bad("truncated DecoderConfigDescriptor"))?;
    // objectTypeIndication(1) streamType(1) bufferSizeDB(3) maxBitrate(4) avgBitrate(4)
    let dsi = match dcd.get(13..) {
        Some(tail) => Descriptors { data: tail }.find(0x05)?,
        None => None,
    };
    let Some(asc) = dsi.filter(|d| !d.is_empty()) else {
        return Ok(format!("mp4a.{oti:02x}"));
    };
    let mut aot = u32::from(asc[0] >> 3);
    if aot == 31 {
        let second = *asc
            .get(1)
            .ok_or_else(|| bad("truncated AudioSpecificConfig"))?;
        aot = 32 + ((u32::from(asc[0] & 0x07) << 3) | u32::from(second >> 5));
    }
    Ok(format!("mp4a.{oti:02x}.{aot}"))
}
