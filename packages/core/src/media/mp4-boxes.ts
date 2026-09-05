/**
 * Top-level ISO BMFF (MP4) box walking — pure functions, no I/O.
 *
 * A "faststart" MP4 is one whose `moov` box precedes `mdat`, so a range-playing client can
 * parse the index before it has the media. ffmpeg's `-movflags +faststart` promises this;
 * we VERIFY it by reading the box order rather than trusting the flag.
 *
 * Box header: 32-bit big-endian size, 4-char type. `size === 1` → 64-bit `largesize`
 * follows; `size === 0` → box extends to end of file. `uuid` boxes carry a 16-byte
 * extended type after the header (we do not need it, but must account for its length
 * only when descending — we never descend).
 */

export interface Mp4Box {
  readonly type: string;
  /** Absolute byte offset of the box start. */
  readonly offset: number;
  /** Total box size including header. `Infinity` for a size-0 box (to end of file). */
  readonly size: number;
  readonly headerSize: 8 | 16;
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function readU32(b: Uint8Array, o: number): number {
  return (
    (b[o] ?? 0) * 0x1_00_00_00 +
    (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0))
  );
}

function readU64(b: Uint8Array, o: number): number {
  const hi = readU32(b, o);
  const lo = readU32(b, o + 4);
  const v = hi * 0x1_0000_0000 + lo;
  if (v > MAX_SAFE) throw new RangeError('mp4: largesize exceeds 2^53');
  return v;
}

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
}

/**
 * Parses a header at `offset` if enough bytes are present. Returns `undefined` when fewer
 * than 8 (or 16 for largesize) bytes are available — the streaming scanner then waits.
 * Throws on a malformed size (smaller than its own header).
 */
export function parseBoxHeader(bytes: Uint8Array, offset = 0): Mp4Box | undefined {
  if (bytes.length - offset < 8) return undefined;
  const size32 = readU32(bytes, offset);
  const type = fourcc(bytes, offset + 4);
  if (size32 === 1) {
    if (bytes.length - offset < 16) return undefined;
    const size = readU64(bytes, offset + 8);
    if (size < 16) throw new RangeError(`mp4: box '${type}' largesize ${size} < 16`);
    return { type, offset, size, headerSize: 16 };
  }
  if (size32 === 0) return { type, offset, size: Infinity, headerSize: 8 };
  if (size32 < 8) throw new RangeError(`mp4: box '${type}' size ${size32} < 8`);
  return { type, offset, size: size32, headerSize: 8 };
}

/** Walks every top-level box of a fully-loaded file. */
export function parseTopLevelBoxes(bytes: Uint8Array): readonly Mp4Box[] {
  const out: Mp4Box[] = [];
  let off = 0;
  while (off < bytes.length) {
    const box = parseBoxHeader(bytes, off);
    if (!box) throw new RangeError(`mp4: truncated box header at ${off}`);
    out.push(box);
    if (box.size === Infinity) break;
    off += box.size;
  }
  return out;
}

/**
 * `true` iff both `moov` and `mdat` exist and the first `moov` precedes the first `mdat`.
 * Files with no `mdat` (e.g. empty) or no `moov` (corrupt) are NOT faststart.
 */
export function isFaststart(boxes: readonly Mp4Box[]): boolean {
  const moov = boxes.findIndex((b) => b.type === 'moov');
  const mdat = boxes.findIndex((b) => b.type === 'mdat');
  return moov >= 0 && mdat >= 0 && moov < mdat;
}

/**
 * Incremental top-level scanner: feed chunks, get headers back, never buffers box bodies.
 * Lets the pipeline decide faststart after reading only the first few KiB of a multi-GB
 * file: stop feeding as soon as `decided()` is true.
 */
export class Mp4BoxScanner {
  readonly boxes: Mp4Box[] = [];
  private pending: Uint8Array = new Uint8Array(0);
  private position = 0; // absolute offset of pending[0]
  private skip = 0; // bytes of the current box body still to discard
  private openEnded = false;

  feed(chunk: Uint8Array): void {
    if (this.openEnded) return;
    let data: Uint8Array;
    if (this.pending.length === 0) data = chunk;
    else {
      data = new Uint8Array(this.pending.length + chunk.length);
      data.set(this.pending, 0);
      data.set(chunk, this.pending.length);
    }
    let off = 0;
    while (off < data.length) {
      if (this.skip > 0) {
        const take = Math.min(this.skip, data.length - off);
        this.skip -= take;
        off += take;
        continue;
      }
      const box = parseBoxHeader(data, off);
      if (!box) break; // need more bytes for the header
      const abs: Mp4Box = { ...box, offset: this.position + off };
      this.boxes.push(abs);
      if (abs.size === Infinity) {
        this.openEnded = true;
        off = data.length;
        break;
      }
      this.skip = abs.size;
      // the header bytes themselves count towards the box size
      const take = Math.min(this.skip, data.length - off);
      this.skip -= take;
      off += take;
    }
    this.pending = off < data.length ? data.slice(off) : new Uint8Array(0);
    this.position += off;
  }

  /** Both `moov` and `mdat` have been seen (order is then final). */
  decided(): boolean {
    return this.boxes.some((b) => b.type === 'moov') && this.boxes.some((b) => b.type === 'mdat');
  }

  faststart(): boolean {
    return isFaststart(this.boxes);
  }
}
