/**
 * RFC 7233 single byte-range resolution for `GET /<sha256>` (BUD-01 "Range requests").
 *
 * Semantics borrowed from `hypercore-blob-server@1.15.0` `_onblob()` (read, not embedded —
 * see docs/lanes/L3.md): offsets are zero-indexed and INCLUSIVE, `end` is clamped to
 * `size - 1`, an unsatisfiable range is 416 with `Content-Range: bytes STAR/<size>` (a
 * literal asterisk — spelled out here because it would close this comment). Two
 * deliberate differences from its `parseRange()`:
 *   - suffix ranges (`bytes=-500`, "the last 500 bytes") are honoured per RFC 7233 §2.1;
 *     blob-server maps them to `bytes=0-500`, which is a different range;
 *   - `start === size` is unsatisfiable (blob-server's `start > length` lets it through
 *     and then computes a negative length).
 * Multi-range (`bytes=0-1,5-6`) and non-`bytes` units are IGNORED (RFC 7233 §3.1: a
 * server MAY ignore a Range header it does not support), i.e. the full blob is served.
 */

export type RangeResolution =
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' };

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/**
 * Resolve a `Range` header value against a blob of `size` bytes.
 * `undefined`/absent, malformed, multi-range or non-bytes → `full`.
 */
export function resolveRange(header: string | undefined, size: number): RangeResolution {
  if (header === undefined) return { kind: 'full' };
  const m = RANGE_RE.exec(header.trim());
  if (m === null) return { kind: 'full' };
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return { kind: 'full' };
  if (size <= 0) return { kind: 'unsatisfiable' };

  if (a === '') {
    // suffix-byte-range-spec: last `b` bytes
    const n = Number(b);
    if (!Number.isSafeInteger(n) || n === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - n);
    return { kind: 'partial', start, end: size - 1 };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  let end = b === '' ? size - 1 : Number(b);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  if (end > size - 1) end = size - 1;
  return { kind: 'partial', start, end };
}
