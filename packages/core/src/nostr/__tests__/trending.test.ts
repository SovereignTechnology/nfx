import { describe, expect, it } from 'vitest';

import type { NostrEvent, NostrEventId, NostrPubkey, UnixSeconds } from '../../contracts/index.js';
import { NostrKind } from '../../contracts/index.js';
import { VIDEOS } from '../../mocks/fixtures.js';
import { buildVideoEvent } from '../../manifest/build.js';
import {
  DEFAULT_DECAY,
  decayWeight,
  fetchPaidStats,
  groupNutzapsByVideo,
  parseNutzap,
  rankTrending,
  scorePaidEvents,
  trendingFeed,
} from '../trending.js';
import { T0, TestSigner, asRaw, rig, sign, tamper } from './helpers.js';

const H = 3600;
const opts = { halfLifeSec: 6 * H, windowSec: 7 * 24 * H };
const pk = (n: number): NostrPubkey => n.toString(16).padStart(2, '0').repeat(32) as NostrPubkey;
const at = (n: number): UnixSeconds => n as UnixSeconds;

describe('decayWeight (pure)', () => {
  it('is 1 at or before now, halves every half-life, and is 0 outside the window', () => {
    expect(decayWeight(0, opts)).toBe(1);
    expect(decayWeight(-100, opts)).toBe(1);
    expect(decayWeight(6 * H, opts)).toBeCloseTo(0.5, 12);
    expect(decayWeight(12 * H, opts)).toBeCloseTo(0.25, 12);
    expect(decayWeight(24 * H, opts)).toBeCloseTo(1 / 16, 12);
    expect(decayWeight(opts.windowSec, opts)).toBeGreaterThan(0);
    expect(decayWeight(opts.windowSec + 1, opts)).toBe(0);
    expect(decayWeight(Number.NaN, opts)).toBe(0);
    expect(decayWeight(Number.POSITIVE_INFINITY, opts)).toBe(0);
    expect(decayWeight(6 * H)).toBeCloseTo(0.5, 12); // defaults
    expect(DEFAULT_DECAY).toEqual(opts);
  });

  it('is monotonically non-increasing in age', () => {
    let prev = 1;
    for (let age = 0; age <= opts.windowSec + H; age += 977) {
      const w = decayWeight(age, opts);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });
});

describe('scorePaidEvents / rankTrending (pure)', () => {
  it('labels paid views as unique payers and sats as claimed sats; decays by age', () => {
    const now = at(T0);
    const s = scorePaidEvents(
      [
        { sats: 100, at: at(T0), payer: pk(1) },
        { sats: 100, at: at(T0 - 6 * H), payer: pk(2) },
        { sats: 100, at: at(T0 - 6 * H), payer: pk(1) }, // same payer twice: one paid view
        { sats: 999, at: at(T0 - 8 * 24 * H), payer: pk(3) }, // outside window: ignored
      ],
      now,
      opts,
    );
    expect(s.paidViews).toBe(2);
    expect(s.paidSats).toBe(300);
    expect(s.nutzaps).toBe(3);
    expect(s.decayedSats).toBeCloseTo(100 + 50 + 50, 9);
    expect(s.satsPerHour).toBeCloseTo(300 / (7 * 24), 9);
    expect(scorePaidEvents([], now, opts)).toEqual({
      paidViews: 0,
      paidSats: 0,
      decayedSats: 0,
      satsPerHour: 0,
      nutzaps: 0,
    });
  });

  it('ranks by decayed sats, then paid views, then id; fresh small beats stale large', () => {
    const now = at(T0);
    const a = 'a'.repeat(64) as NostrEventId;
    const b = 'b'.repeat(64) as NostrEventId;
    const c = 'c'.repeat(64) as NostrEventId;
    const d = 'd'.repeat(64) as NostrEventId;
    const ranked = rankTrending(
      new Map([
        [a, [{ sats: 1000, at: at(T0 - 48 * H), payer: pk(1) }]], // 1000/256 ≈ 3.9
        [b, [{ sats: 10, at: at(T0), payer: pk(2) }]], // 10
        [
          c,
          [
            { sats: 5, at: at(T0), payer: pk(3) },
            { sats: 5, at: at(T0), payer: pk(4) },
          ],
        ], // 10, 2 viewers
        [d, []],
      ]),
      now,
      opts,
    );
    expect(ranked.map((e) => e.videoId)).toEqual([c, b, a]);
  });
});

describe('parseNutzap (NIP-61 kind 9321)', () => {
  const s = new TestSigner();
  const proof = (amount: number): string =>
    JSON.stringify({ amount, C: '02ab', id: '000a', secret: '["P2PK",{}]' });
  const video = 'e'.repeat(64) as NostrEventId;

  it('sums proof amounts and reads e/k/u/p/unit', async () => {
    const ev = await sign(s, {
      kind: 9321,
      created_at: T0,
      tags: [
        ['proof', proof(2)],
        ['proof', proof(3)],
        ['proof', 'not json'],
        ['proof', JSON.stringify({ amount: -1 })],
        ['unit', 'sat'],
        ['u', 'https://mint.example'],
        ['e', video, 'wss://r'],
        ['k', '21'],
        ['p', pk(9)],
      ],
      content: 'nice',
    });
    expect(parseNutzap(ev)).toMatchObject({
      id: ev.id,
      sender: s.pubkey,
      recipient: pk(9),
      videoId: video,
      targetKind: 21,
      mint: 'https://mint.example',
      unit: 'sat',
      claimedAmount: 5,
      comment: 'nice',
      createdAt: T0,
    });
  });

  it('returns null for wrong kind, no recipient or no proofs; unit defaults to sat', async () => {
    expect(
      parseNutzap(
        await sign(s, {
          kind: 1,
          created_at: T0,
          tags: [
            ['p', pk(1)],
            ['proof', proof(1)],
          ],
          content: '',
        }),
      ),
    ).toBeNull();
    expect(
      parseNutzap(
        await sign(s, { kind: 9321, created_at: T0, tags: [['proof', proof(1)]], content: '' }),
      ),
    ).toBeNull();
    expect(
      parseNutzap(await sign(s, { kind: 9321, created_at: T0, tags: [['p', pk(1)]], content: '' })),
    ).toBeNull();
    const z = parseNutzap(
      await sign(s, {
        kind: 9321,
        created_at: T0,
        tags: [
          ['p', pk(1)],
          ['proof', proof(1)],
        ],
        content: '',
      }),
    )!;
    expect(z.unit).toBe('sat');
    expect(z.videoId).toBeUndefined();
  });

  it('groupNutzapsByVideo ignores non-sat units and untargeted zaps', async () => {
    const sat = parseNutzap(
      await sign(s, {
        kind: 9321,
        created_at: T0,
        tags: [
          ['p', pk(1)],
          ['proof', proof(7)],
          ['e', video],
        ],
        content: '',
      }),
    )!;
    const usd = parseNutzap(
      await sign(s, {
        kind: 9321,
        created_at: T0,
        tags: [
          ['p', pk(1)],
          ['proof', proof(7)],
          ['e', video],
          ['unit', 'usd'],
        ],
        content: '',
      }),
    )!;
    const none = parseNutzap(
      await sign(s, {
        kind: 9321,
        created_at: T0,
        tags: [
          ['p', pk(1)],
          ['proof', proof(7)],
        ],
        content: '',
      }),
    )!;
    const g = groupNutzapsByVideo([sat, usd, none]);
    expect([...g.entries()]).toEqual([[video, [{ sats: 7, at: T0, payer: s.pubkey }]]]);
  });
});

describe('trendingFeed against the fake relay', () => {
  const proof = (amount: number): string => JSON.stringify({ amount });
  async function zap(
    from: TestSigner,
    video: NostrEvent,
    sats: number,
    when: number,
  ): Promise<NostrEvent> {
    return sign(from, {
      kind: NostrKind.NutzapPayout,
      created_at: at(when),
      tags: [
        ['proof', proof(sats)],
        ['unit', 'sat'],
        ['u', 'https://mint.example'],
        ['e', video.id],
        ['k', String(video.kind)],
        ['p', video.pubkey],
      ],
      content: '',
    });
  }

  it('ranks videos by decayed claimed sats, pages by offset, and verifies both nutzaps and videos', async () => {
    const r = rig({ now: at(T0 + 1000) });
    const creator = new TestSigner();
    const vids: NostrEvent[] = [];
    for (const v of VIDEOS.slice(0, 4)) {
      const ev = await sign(creator, buildVideoEvent(v));
      r.pool.store(ev);
      vids.push(ev);
    }
    const [v0, v1, v2, v3] = vids as [NostrEvent, NostrEvent, NostrEvent, NostrEvent];
    const alice = new TestSigner();
    const bob = new TestSigner();
    r.pool.store(await zap(alice, v0, 10, T0)); // fresh 10
    r.pool.store(await zap(alice, v1, 1000, T0 - 48 * H)); // stale 1000 → ~3.9
    r.pool.store(await zap(alice, v2, 4, T0)); // 8 total from two payers
    r.pool.store(await zap(bob, v2, 4, T0));
    r.pool.store(await zap(bob, v3, 50_000, T0 - 30 * 24 * H)); // outside window
    // A forged nutzap claiming a fortune for v3, and a forged video: both must be dropped.
    r.pool.inject(asRaw(tamper(await zap(bob, v3, 1_000_000, T0), { content: 'forged' })));
    r.pool.inject(asRaw(tamper(v3, { content: 'forged video' })));

    const page = await trendingFeed(r.client, { limit: 2 });
    expect(page.items.map((v) => v.id)).toEqual([v0.id, v2.id]);
    expect(page.scores.map((s) => [s.paidViews, s.paidSats])).toEqual([
      [1, 10],
      [2, 8],
    ]);
    expect(page.next).toBeDefined();
    const page2 = await trendingFeed(r.client, { limit: 2, cursor: page.next });
    expect(page2.items.map((v) => v.id)).toEqual([v1.id]);
    expect(page2.next).toBeUndefined();
    expect(r.dropped.filter((d) => d.reason === 'bad-signature').length).toBeGreaterThanOrEqual(1);
    // The window is passed to the relay as `since`.
    const zapQuery = r.pool.queries.find((q) => q.filter.kinds?.[0] === NostrKind.NutzapPayout)!;
    expect(zapQuery.filter.since).toBe(T0 + 1000 - DEFAULT_DECAY.windowSec);

    const stats = await fetchPaidStats(r.client, v2.id);
    expect(stats).toMatchObject({ paidViews: 2, paidSats: 8, nutzaps: 2 });
    expect((await fetchPaidStats(r.client, 'f'.repeat(64) as NostrEventId)).nutzaps).toBe(0);
  });

  it('a video whose nutzaps exist but whose event was tampered never appears', async () => {
    const r = rig({ now: at(T0 + 10) });
    const creator = new TestSigner();
    const genuine = await sign(creator, buildVideoEvent(VIDEOS[0]!));
    r.pool.inject(asRaw(tamper(genuine))); // only the forged copy is on the relay
    r.pool.store(await zap(new TestSigner(), genuine, 500, T0));
    const page = await trendingFeed(r.client);
    expect(page.items).toEqual([]);
    expect(page.scores).toEqual([]);
    expect(r.dropped.length).toBe(1);
  });
});
