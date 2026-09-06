import { describe, expect, it } from 'vitest';

import type { NostrEvent, VideoManifest } from '../../contracts/index.js';
import { VIDEOS } from '../../mocks/fixtures.js';
import { buildVideoEvent } from '../../manifest/build.js';
import { buildFollowsEvent } from '../follows.js';
import {
  authorFeed,
  fetchVideo,
  fetchVideos,
  latestFeed,
  relatedVideos,
  searchVideos,
  shortsFeed,
  subscriptionsFeed,
  tagsFeed,
  videoPage,
  watchNewVideos,
} from '../feeds.js';
import { T0, TestSigner, asRaw, rig, sign, tamper } from './helpers.js';
import type { Rig } from './helpers.js';

/** One signer per fixture channel so author-based feeds mean something. */
const channelSigners = new Map<string, TestSigner>();
function signerFor(v: VideoManifest): TestSigner {
  let s = channelSigners.get(v.author);
  if (!s) {
    s = new TestSigner();
    channelSigners.set(v.author, s);
  }
  return s;
}

async function seed(r: Rig): Promise<{ events: NostrEvent[]; byTitle: Map<string, NostrEvent> }> {
  const events: NostrEvent[] = [];
  const byTitle = new Map<string, NostrEvent>();
  for (const v of VIDEOS) {
    const ev = await sign(signerFor(v), buildVideoEvent(v));
    r.pool.store(ev);
    events.push(ev);
    byTitle.set(v.title, ev);
  }
  return { events, byTitle };
}

describe('feeds', () => {
  it('latest/shorts/author/tags pages are verified manifests, newest first, and page without gaps or dupes', async () => {
    const r = await (async () => {
      const x = rig();
      await seed(x);
      return x;
    })();
    const all = await latestFeed(r.client, { limit: 100 });
    expect(all.items.length).toBe(VIDEOS.length);
    expect(all.next).toBeUndefined();
    for (let i = 1; i < all.items.length; i++)
      expect(all.items[i - 1]!.publishedAt).toBeGreaterThanOrEqual(all.items[i]!.publishedAt);

    const p1 = await latestFeed(r.client, { limit: 5 });
    expect(p1.items.length).toBe(5);
    expect(p1.next).toBeDefined();
    const p2 = await latestFeed(r.client, { limit: 5, cursor: p1.next });
    const p3 = await latestFeed(r.client, { limit: 5, cursor: p2.next });
    const ids = [...p1.items, ...p2.items, ...p3.items].map((v) => v.id);
    expect(new Set(ids).size).toBe(VIDEOS.length);
    expect(p3.next).toBeUndefined();
    expect(await latestFeed(r.client, { limit: 5, cursor: 'garbage' })).toEqual(p1);

    const shorts = await shortsFeed(r.client);
    expect(shorts.items.length).toBe(VIDEOS.filter((v) => v.kind === 22).length);
    expect(shorts.items.every((v) => v.kind === 22)).toBe(true);

    const orbital = VIDEOS[0]!;
    const byAuthor = await authorFeed(r.client, signerFor(orbital).pubkey);
    expect(byAuthor.items.length).toBe(VIDEOS.filter((v) => v.author === orbital.author).length);

    const ceramics = await tagsFeed(r.client, [' Ceramics ']);
    expect(ceramics.items.length).toBe(VIDEOS.filter((v) => v.tags.includes('ceramics')).length);
    expect((await tagsFeed(r.client, ['  '])).items).toEqual([]);
    expect((await videoPage(r.client, { kinds: [1] })).items).toEqual([]);
  });

  it('same-second events page correctly via the seen-ids cursor', async () => {
    const r = rig();
    const s = new TestSigner();
    const v = VIDEOS[0]!;
    for (let i = 0; i < 4; i++) {
      r.pool.store(
        await sign(s, buildVideoEvent({ ...v, title: `same-second ${i}` }, { createdAt: T0 })),
      );
    }
    const a = await latestFeed(r.client, { limit: 3 });
    const b = await latestFeed(r.client, { limit: 3, cursor: a.next });
    expect(a.items.length).toBe(3);
    expect(b.items.length).toBe(1);
    expect(new Set([...a.items, ...b.items].map((x) => x.id)).size).toBe(4);
  });

  it('every feed drops a tampered video event (T9)', async () => {
    const r = rig();
    const { byTitle } = await seed(r);
    const genuine = byTitle.get(VIDEOS[0]!.title)!;
    const impostor = tamper(genuine, {
      tags: genuine.tags.map((t) => (t[0] === 'title' ? ['title', 'Impostor'] : t)),
      created_at: T0 + 100,
    });
    r.pool.inject(asRaw(impostor));
    const author = signerFor(VIDEOS[0]!).pubkey;
    const checks = [
      latestFeed(r.client, { limit: 100 }),
      authorFeed(r.client, author),
      tagsFeed(r.client, ['space']),
      searchVideos(r.client, 'Hohmann'),
    ];
    for (const page of await Promise.all(checks)) {
      expect(page.items.some((v) => v.title === 'Impostor')).toBe(false);
      expect(page.items.some((v) => v.id === genuine.id)).toBe(true);
    }
    expect(await fetchVideos(r.client, [impostor.id, genuine.id])).toHaveLength(1);
    expect(r.dropped.length).toBe(5);
    expect(r.dropped.every((d) => d.reason === 'bad-signature')).toBe(true);
  });

  it('subscriptionsFeed follows the channel set / kind 3 and drops tampered items', async () => {
    const r = rig();
    const { byTitle } = await seed(r);
    const kiln = VIDEOS[1]!;
    const viewer = r.signer;
    expect((await subscriptionsFeed(r.client, viewer.pubkey)).items).toEqual([]);
    r.pool.store(await sign(viewer, buildFollowsEvent([{ pubkey: signerFor(kiln).pubkey }], T0)));
    const page = await subscriptionsFeed(r.client, viewer.pubkey);
    expect(page.items.every((v) => v.author === signerFor(kiln).pubkey)).toBe(true);
    expect(page.items.length).toBe(VIDEOS.filter((v) => v.author === kiln.author).length);
    r.pool.inject(asRaw(tamper(byTitle.get(kiln.title)!)));
    expect((await subscriptionsFeed(r.client, viewer.pubkey)).items.length).toBe(page.items.length);
    expect(r.dropped.length).toBe(1);
  });

  it('fetchVideo(s) keeps requested order and returns null for unknown ids', async () => {
    const r = rig();
    const { events } = await seed(r);
    const want = [events[3]!.id, events[0]!.id, events[7]!.id];
    expect((await fetchVideos(r.client, want)).map((v) => v.id)).toEqual(want);
    expect(await fetchVideo(r.client, events[5]!.id)).toMatchObject({ id: events[5]!.id });
    expect(await fetchVideo(r.client, 'f'.repeat(64) as NostrEvent['id'])).toBeNull();
    expect(await fetchVideos(r.client, [])).toEqual([]);
  });

  it('searchVideos passes NIP-50 search + structured filters and applies duration bounds client-side', async () => {
    const r = rig();
    await seed(r);
    const hits = await searchVideos(r.client, 'Low Tide', { minDurationSec: 2000 });
    expect(hits.items.map((v) => v.title)).toEqual([
      'Low Tide Sessions #02: modular + field recordings',
    ]);
    const q = r.pool.queries.at(-1)!.filter;
    expect(q.search).toBe('Low Tide');
    expect(q.kinds).toEqual([21, 22]);
    const author = signerFor(VIDEOS[0]!).pubkey;
    const byAuthor = await searchVideos(r.client, 'a', {
      author,
      tags: ['space'],
      since: (T0 - 999_999) as typeof T0,
    });
    expect(r.pool.queries.at(-1)!.filter).toMatchObject({
      authors: [author],
      '#t': ['space'],
      since: T0 - 999_999,
    });
    expect(byAuthor.items.every((v) => v.author === author)).toBe(true);
    expect((await searchVideos(r.client, '   ')).items).toEqual([]);
    expect((await searchVideos(r.client, 'Low Tide', { maxDurationSec: 10 })).items).toEqual([]);
  });

  it('relatedVideos prefers tag overlap then same author and never returns the video itself', async () => {
    const r = rig();
    await seed(r);
    const orbital = (await latestFeed(r.client, { limit: 100 })).items.find((v) =>
      v.title.startsWith('Hohmann'),
    )!;
    const rel = await relatedVideos(r.client, orbital, 3);
    // Derived from the fixtures, not hard-coded: the old `toBe(3)` only held because
    // `fakeHex64` used to give two channels the same pubkey (fixed by the orchestrator).
    // (Events are re-signed by `signerFor`, so compare by title/fixture author, not event id.)
    const fixture = VIDEOS.find((v) => v.title === orbital.title)!;
    const candidates = VIDEOS.filter(
      (v) =>
        v.title !== fixture.title &&
        (v.author === fixture.author || v.tags.some((t) => fixture.tags.includes(t))),
    ).length;
    expect(candidates).toBeGreaterThanOrEqual(2);
    expect(rel.length).toBe(Math.min(3, candidates));
    expect(rel.every((v) => v.id !== orbital.id)).toBe(true);
    expect(rel[0]!.tags).toContain('physics'); // two-tag overlap ranks first
  });

  it('watchNewVideos delivers verified new videos live and ignores tampered ones', async () => {
    const r = rig();
    const s = new TestSigner();
    const got: string[] = [];
    const stop = watchNewVideos(r.client, [s.pubkey], T0, (v) => got.push(v.title));
    const ev = await sign(
      s,
      buildVideoEvent({ ...VIDEOS[0]!, title: 'fresh' }, { createdAt: (T0 + 1) as typeof T0 }),
    );
    r.pool.store(ev);
    r.pool.inject(asRaw(tamper(ev, { content: 'x' })));
    r.pool.store(
      await sign(
        new TestSigner(),
        buildVideoEvent(
          { ...VIDEOS[0]!, title: 'other author' },
          { createdAt: (T0 + 1) as typeof T0 },
        ),
      ),
    );
    stop();
    r.pool.store(
      await sign(
        s,
        buildVideoEvent(
          { ...VIDEOS[0]!, title: 'after stop' },
          { createdAt: (T0 + 2) as typeof T0 },
        ),
      ),
    );
    expect(got).toEqual(['fresh']);
    expect(r.dropped.length).toBe(1);
    expect(watchNewVideos(r.client, [], T0, () => undefined)).toBeTypeOf('function');
  });
});
