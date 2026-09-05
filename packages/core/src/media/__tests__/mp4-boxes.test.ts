import { describe, expect, it } from 'vitest';

import { Mp4BoxScanner, isFaststart, parseBoxHeader, parseTopLevelBoxes } from '../mp4-boxes.js';
import { box, concat } from '../testing/fakes.js';

const ftyp = box('ftyp', new TextEncoder().encode('isomiso2'));
const moov = box('moov', new Uint8Array(50));
const mdat = box('mdat', new Uint8Array(500));
const free = box('free', new Uint8Array(0));

function largeBox(type: string, payloadLen: number): Uint8Array {
  const size = 16 + payloadLen;
  const out = new Uint8Array(size);
  out[3] = 1; // size32 = 1 → largesize follows
  out.set(new TextEncoder().encode(type), 4);
  // 64-bit big-endian size in bytes 8..15 (fits in 32 bits here)
  out[12] = (size >>> 24) & 255;
  out[13] = (size >>> 16) & 255;
  out[14] = (size >>> 8) & 255;
  out[15] = size & 255;
  return out;
}

describe('parseBoxHeader', () => {
  it('reads a 32-bit box', () => {
    expect(parseBoxHeader(moov)).toEqual({ type: 'moov', offset: 0, size: 58, headerSize: 8 });
  });
  it('reads a 64-bit largesize box', () => {
    const b = largeBox('mdat', 100);
    expect(parseBoxHeader(b)).toEqual({ type: 'mdat', offset: 0, size: 116, headerSize: 16 });
  });
  it('treats size 0 as "to end of file"', () => {
    const b = new Uint8Array(8);
    b.set(new TextEncoder().encode('mdat'), 4);
    expect(parseBoxHeader(b)?.size).toBe(Infinity);
  });
  it('returns undefined when the header is incomplete', () => {
    expect(parseBoxHeader(moov.subarray(0, 7))).toBeUndefined();
    expect(parseBoxHeader(largeBox('mdat', 4).subarray(0, 12))).toBeUndefined();
  });
  it('throws on a size smaller than its own header', () => {
    const b = new Uint8Array(8);
    b[3] = 4;
    b.set(new TextEncoder().encode('free'), 4);
    expect(() => parseBoxHeader(b)).toThrow(/size 4 < 8/);
  });
});

describe('parseTopLevelBoxes + isFaststart', () => {
  it('faststart when moov precedes mdat', () => {
    const boxes = parseTopLevelBoxes(concat([ftyp, moov, free, mdat]));
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'free', 'mdat']);
    expect(boxes.map((b) => b.offset)).toEqual([0, 16, 74, 82]);
    expect(isFaststart(boxes)).toBe(true);
  });
  it('not faststart when mdat precedes moov', () => {
    expect(isFaststart(parseTopLevelBoxes(concat([ftyp, mdat, moov])))).toBe(false);
  });
  it('not faststart when either box is missing', () => {
    expect(isFaststart(parseTopLevelBoxes(concat([ftyp, moov])))).toBe(false);
    expect(isFaststart(parseTopLevelBoxes(concat([ftyp, mdat])))).toBe(false);
    expect(isFaststart([])).toBe(false);
  });
  it('handles a largesize mdat and a trailing open-ended box', () => {
    const open = new Uint8Array(8 + 20);
    open.set(new TextEncoder().encode('skip'), 4);
    const boxes = parseTopLevelBoxes(concat([ftyp, moov, largeBox('mdat', 300), open]));
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat', 'skip']);
    expect(boxes[2]?.headerSize).toBe(16);
    expect(boxes[3]?.size).toBe(Infinity);
    expect(isFaststart(boxes)).toBe(true);
  });
  it('throws on a truncated trailing header', () => {
    expect(() => parseTopLevelBoxes(concat([ftyp, moov.subarray(0, 5)]))).toThrow(/truncated/);
  });
});

describe('Mp4BoxScanner (streaming)', () => {
  const file = concat([ftyp, moov, free, mdat]);

  it('yields the same boxes as the whole-file parser regardless of chunking', () => {
    for (const chunk of [1, 3, 7, 8, 13, 64, 1000]) {
      const s = new Mp4BoxScanner();
      for (let i = 0; i < file.length; i += chunk) s.feed(file.subarray(i, i + chunk));
      expect(s.boxes).toEqual(parseTopLevelBoxes(file));
      expect(s.faststart()).toBe(true);
    }
  });

  it('decides as soon as both moov and mdat headers are seen', () => {
    const s = new Mp4BoxScanner();
    s.feed(file.subarray(0, 90)); // ftyp + moov + free + first 8 bytes of mdat
    expect(s.decided()).toBe(true);
    expect(s.faststart()).toBe(true);
  });

  it('is not decided while only moov has been seen', () => {
    const s = new Mp4BoxScanner();
    s.feed(file.subarray(0, 40));
    expect(s.decided()).toBe(false);
  });

  it('reports mdat-first files as not faststart', () => {
    const s = new Mp4BoxScanner();
    const bad = concat([ftyp, mdat, moov]);
    for (let i = 0; i < bad.length; i += 5) s.feed(bad.subarray(i, i + 5));
    expect(s.faststart()).toBe(false);
  });

  it('skips box bodies without buffering them', () => {
    const s = new Mp4BoxScanner();
    const big = box('mdat', new Uint8Array(1 << 20));
    s.feed(concat([ftyp, moov]));
    for (let i = 0; i < big.length; i += 4096) s.feed(big.subarray(i, i + 4096));
    expect(s.boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(s.boxes[2]?.size).toBe(big.length);
  });
});
