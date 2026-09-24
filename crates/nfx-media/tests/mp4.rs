//! CODECS from hand-built init segments, plus malformed-input handling.

#![allow(clippy::unwrap_used)]

use nfx_media::MediaError;
use nfx_media::mp4::{boxes, init_codecs};

fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = u32::try_from(body.len() + 8)
        .unwrap()
        .to_be_bytes()
        .to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

fn descriptor(tag: u8, body: &[u8], long_size: bool) -> Vec<u8> {
    let mut out = vec![tag];
    let n = u8::try_from(body.len()).unwrap();
    if long_size {
        out.extend_from_slice(&[0x80, 0x80, 0x80, n]); // 4-byte 7-bit size, as ffmpeg writes
    } else {
        out.push(n);
    }
    out.extend_from_slice(body);
    out
}

fn trak(entry: &[u8]) -> Vec<u8> {
    let mut stsd = vec![0, 0, 0, 0, 0, 0, 0, 1];
    stsd.extend_from_slice(entry);
    bx(
        b"trak",
        &bx(b"mdia", &bx(b"minf", &bx(b"stbl", &bx(b"stsd", &stsd)))),
    )
}

fn avc1(profile: u8, compat: u8, level: u8) -> Vec<u8> {
    let mut body = vec![0u8; 78];
    body.extend(bx(b"avcC", &[1, profile, compat, level, 0xff, 0xe1]));
    bx(b"avc1", &body)
}

fn mp4a(asc: &[u8], long_size: bool) -> Vec<u8> {
    let mut dcd = vec![0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    dcd.extend(descriptor(0x05, asc, long_size));
    let mut es = vec![0, 1, 0]; // ES_ID, flags
    es.extend(descriptor(0x04, &dcd, long_size));
    let mut esds = vec![0, 0, 0, 0];
    esds.extend(descriptor(0x03, &es, long_size));
    let mut body = vec![0u8; 28];
    body.extend(bx(b"esds", &esds));
    bx(b"mp4a", &body)
}

fn init(traks: &[Vec<u8>]) -> Vec<u8> {
    let mut out = bx(b"ftyp", b"iso6\0\0\0\0");
    out.extend(bx(b"moov", &traks.concat()));
    out
}

#[test]
fn h264_high_and_aac_lc() {
    let data = init(&[
        trak(&avc1(0x64, 0x00, 0x28)),
        trak(&mp4a(&[0x12, 0x10], true)),
    ]);
    assert_eq!(init_codecs(&data).unwrap(), ["avc1.640028", "mp4a.40.2"]);
}

#[test]
fn video_first_even_when_audio_track_comes_first() {
    let data = init(&[
        trak(&mp4a(&[0x12, 0x10], false)),
        trak(&avc1(0x4d, 0x40, 0x1f)),
    ]);
    assert_eq!(init_codecs(&data).unwrap(), ["avc1.4d401f", "mp4a.40.2"]);
}

#[test]
fn aac_object_type_escape() {
    // AOT 31 escape: 5 bits 11111, then 6 bits → 32 + 10 = 42.
    let escaped = [0b1111_1001, 0b0100_0000];
    let data = init(&[trak(&avc1(0x64, 0, 0x1e)), trak(&mp4a(&escaped, false))]);
    assert_eq!(init_codecs(&data).unwrap()[1], "mp4a.40.42");
}

#[test]
fn large_and_to_end_box_sizes() {
    // 64-bit size header.
    let mut big = 1u32.to_be_bytes().to_vec();
    big.extend_from_slice(b"free");
    big.extend_from_slice(&20u64.to_be_bytes());
    big.extend_from_slice(&[0, 0, 0, 0]);
    // size 0: extends to the end.
    let mut tail = 0u32.to_be_bytes().to_vec();
    tail.extend_from_slice(b"mdat");
    tail.extend_from_slice(&[9, 9, 9]);
    let data = [big, tail].concat();
    let parsed = boxes(&data).unwrap();
    assert_eq!(
        parsed.iter().map(|b| b.kind).collect::<Vec<_>>(),
        [*b"free", *b"mdat"]
    );
    assert_eq!(parsed[0].body.len(), 4);
    assert_eq!(parsed[1].body, &[9, 9, 9]);
}

#[test]
fn malformed_input_is_an_error_not_a_panic() {
    let good = init(&[trak(&avc1(0x64, 0, 0x28))]);
    for cut in 0..good.len() {
        let _ = init_codecs(&good[..cut]); // must not panic at any truncation
    }
    let mut lying = bx(b"moov", &[0; 8]);
    lying[3] = 200; // size claims more than exists
    assert!(matches!(init_codecs(&lying), Err(MediaError::Mp4(_))));
    let mut tiny = bx(b"moov", &[]);
    tiny[3] = 4; // smaller than its own header
    assert!(boxes(&tiny).is_err());
    assert!(
        matches!(init_codecs(&bx(b"ftyp", b"x")), Err(MediaError::Mp4(_))),
        "no moov"
    );
    let hevc = {
        let mut body = vec![0u8; 78];
        body.extend(bx(b"hvcC", &[1, 2, 3, 4]));
        bx(b"hvc1", &body)
    };
    assert!(matches!(
        init_codecs(&init(&[trak(&hevc)])),
        Err(MediaError::Unsupported(_))
    ));
}
