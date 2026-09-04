import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import { NostrKind } from '../../contracts/index.js';
import {
  classifyIncoming,
  isWellFormedTag,
  tagValue,
  tagValues,
  toWire,
  verifyIncoming,
} from '../event.js';
import { T0, TestSigner, asRaw, sign, tamper } from './helpers.js';

const signer = new TestSigner();
const draft = {
  kind: 1,
  created_at: T0,
  tags: [
    ['t', 'x'],
    ['p', signer.pubkey],
  ],
  content: 'hello',
};

describe('verifyIncoming (T9 boundary)', () => {
  it('accepts a correctly signed event and returns a frozen fresh copy', async () => {
    const ev = await sign(signer, draft);
    const out = verifyIncoming(asRaw(ev));
    expect(out).not.toBeNull();
    expect(out).not.toBe(ev);
    expect(out).toEqual(ev);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out!.tags)).toBe(true);
    expect(Object.isFrozen(out!.tags[0])).toBe(true);
    expect(Object.getOwnPropertySymbols(out!)).toEqual([]);
  });

  it.each([
    ['content', (e: Awaited<ReturnType<typeof sign>>) => tamper(e)],
    ['tags', (e: Awaited<ReturnType<typeof sign>>) => tamper(e, { tags: [['t', 'y']] })],
    ['kind', (e: Awaited<ReturnType<typeof sign>>) => tamper(e, { kind: 2 })],
    ['created_at', (e: Awaited<ReturnType<typeof sign>>) => tamper(e, { created_at: T0 + 1 })],
    [
      'pubkey',
      (e: Awaited<ReturnType<typeof sign>>) => tamper(e, { pubkey: new TestSigner().pubkey }),
    ],
    [
      'sig',
      (e: Awaited<ReturnType<typeof sign>>) =>
        tamper(e, { sig: e.sig.replace(/^./, (c) => (c === '0' ? '1' : '0')) }),
    ],
    [
      'id',
      (e: Awaited<ReturnType<typeof sign>>) =>
        tamper(e, { id: e.id.replace(/^./, (c) => (c === '0' ? '1' : '0')) as typeof e.id }),
    ],
  ])('drops an event whose %s was tampered', async (_field, mutate) => {
    const ev = await sign(signer, draft);
    const bad = mutate(ev);
    expect(verifyIncoming(asRaw(bad))).toBeNull();
    expect(classifyIncoming(asRaw(bad)).reason).toBe('bad-signature');
  });

  it('is not fooled by the nostr-tools verified-symbol cache on a spread-tampered object', async () => {
    const ev = toWire(await sign(signer, draft));
    expect(verifyEvent(ev)).toBe(true); // nostr-tools now caches `true` on the object
    expect(Object.getOwnPropertySymbols(ev).length).toBe(1);
    const spread = { ...ev, content: 'evil' }; // spread copies the symbol
    expect(Object.getOwnPropertySymbols(spread).length).toBe(1);
    expect(verifyEvent(spread)).toBe(true); // the raw library call IS fooled …
    expect(verifyIncoming(spread)).toBeNull(); // … the boundary is not
  });

  it.each([
    ['null', null],
    ['string', 'nope'],
    [
      'no sig',
      { kind: 1, created_at: T0, tags: [], content: '', pubkey: signer.pubkey, id: 'a'.repeat(64) },
    ],
    [
      'short id',
      {
        kind: 1,
        created_at: T0,
        tags: [],
        content: '',
        pubkey: signer.pubkey,
        id: 'ab',
        sig: 'c'.repeat(128),
      },
    ],
    [
      'bad pubkey',
      {
        kind: 1,
        created_at: T0,
        tags: [],
        content: '',
        pubkey: 'zz',
        id: 'a'.repeat(64),
        sig: 'c'.repeat(128),
      },
    ],
    [
      'float created_at',
      {
        kind: 1,
        created_at: 1.5,
        tags: [],
        content: '',
        pubkey: signer.pubkey,
        id: 'a'.repeat(64),
        sig: 'c'.repeat(128),
      },
    ],
    [
      'non-string tag item',
      {
        kind: 1,
        created_at: T0,
        tags: [['t', 1]],
        content: '',
        pubkey: signer.pubkey,
        id: 'a'.repeat(64),
        sig: 'c'.repeat(128),
      },
    ],
  ])('rejects malformed input: %s', (_label, raw) => {
    expect(classifyIncoming(raw).reason).toBe('malformed');
    expect(verifyIncoming(raw)).toBeNull();
  });

  it('rejects an empty tag even when the signature over it is valid (T15 tag shape)', async () => {
    const ev = await sign(signer, { ...draft, tags: [[]] });
    expect(classifyIncoming(asRaw(ev)).reason).toBe('bad-tag');
  });
});

describe('tag helpers', () => {
  it('isWellFormedTag', () => {
    expect(isWellFormedTag(['e'])).toBe(true);
    expect(isWellFormedTag([])).toBe(false);
    expect(isWellFormedTag(['e', 1])).toBe(false);
    expect(isWellFormedTag('e')).toBe(false);
  });
  it('tagValue / tagValues / toWire', async () => {
    const ev = await sign(signer, {
      ...draft,
      tags: [['t', 'a'], ['t', 'b'], ['x'], ['k', String(NostrKind.Video)]],
    });
    expect(tagValue(ev, 't')).toBe('a');
    expect(tagValues(ev, 't')).toEqual(['a', 'b']);
    expect(tagValue(ev, 'x')).toBeUndefined();
    expect(tagValue(ev, 'nope')).toBeUndefined();
    const w = toWire(ev);
    expect(w.tags).toEqual(ev.tags);
    expect(w.tags).not.toBe(ev.tags);
  });
});
