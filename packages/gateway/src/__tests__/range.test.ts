import { describe, expect, it } from 'vitest';

import { resolveRange } from '../blossom/range.js';

describe('resolveRange (RFC 7233, hypercore-blob-server semantics)', () => {
  const SIZE = 1000;

  it('no / malformed / non-bytes / multi-range header → full', () => {
    for (const h of [
      undefined,
      '',
      'bytes',
      'items=0-1',
      'bytes=',
      'bytes=-',
      'bytes=0-1,5-6',
      'bytes=a-b',
      'bytes=0-1-2',
    ])
      expect(resolveRange(h, SIZE), String(h)).toEqual({ kind: 'full' });
  });

  it('closed, open-ended and clamped ranges (inclusive offsets)', () => {
    expect(resolveRange('bytes=0-299', SIZE)).toEqual({ kind: 'partial', start: 0, end: 299 });
    expect(resolveRange('bytes=2-', SIZE)).toEqual({ kind: 'partial', start: 2, end: 999 });
    expect(resolveRange('bytes=999-999', SIZE)).toEqual({ kind: 'partial', start: 999, end: 999 });
    expect(resolveRange('bytes=900-5000', SIZE)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(resolveRange(' bytes=0-0 ', SIZE)).toEqual({ kind: 'partial', start: 0, end: 0 });
  });

  it('suffix ranges are the LAST n bytes (blob-server maps them to 0-n; we do not)', () => {
    expect(resolveRange('bytes=-500', SIZE)).toEqual({ kind: 'partial', start: 500, end: 999 });
    expect(resolveRange('bytes=-5000', SIZE)).toEqual({ kind: 'partial', start: 0, end: 999 });
    expect(resolveRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('unsatisfiable: start past the end, start == size, end < start, empty blob', () => {
    expect(resolveRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange('bytes=10-5', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRange('bytes=99999999999999999999-', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });
});
