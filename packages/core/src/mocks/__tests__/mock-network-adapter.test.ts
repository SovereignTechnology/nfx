import { describe, expect, it } from 'vitest';

import type { PeerSpend } from '../../contracts/index.js';
import { CHANNELS, fakeHex64, ME, MINTS, VIDEOS } from '../fixtures.js';
import { MockNetworkAdapter } from '../mock-network-adapter.js';
import { MockWallet } from '../mock-wallet.js';

describe('fixtures', () => {
  it('are deterministic and internally consistent', () => {
    expect(VIDEOS.length).toBe(12);
    for (const v of VIDEOS) {
      expect(v.id).toMatch(/^[0-9a-f]{64}$/);
      expect(CHANNELS.some((c) => c.pubkey === v.author)).toBe(true);
      expect(v.renditions.length).toBe(v.kind === 22 ? 1 : 3);
      for (const r of v.renditions)
        expect(r.hyper.blob.blockLength).toBe(Math.ceil(r.size / 65_536));
      expect(v.price.split.seeder + v.price.split.creator).toBe(100);
      expect(v.event.tags.filter((t) => t[0] === 'imeta').length).toBe(v.renditions.length);
    }
  });

  it('fakeHex64 does not collide across fixture ids (L4 finding: channels shared pubkeys)', () => {
    const pubkeys = new Set(CHANNELS.map((c) => c.pubkey));
    expect(pubkeys.size).toBe(CHANNELS.length);
    const ids = new Set(VIDEOS.map((v) => v.id));
    expect(ids.size).toBe(VIDEOS.length);
    const cores = new Set(VIDEOS.flatMap((v) => v.renditions.map((r) => r.hyper.core)));
    expect(cores.size).toBe(VIDEOS.reduce((n, v) => n + v.renditions.length, 0));
    const many = new Set<string>();
    for (let i = 0; i < 5000; i++) many.add(fakeHex64(`pk:x${i}`));
    expect(many.size).toBe(5000);
  });
});

describe('MockNetworkAdapter', () => {
  it('feeds page and filter', async () => {
    const a = new MockNetworkAdapter();
    const p1 = await a.feed({ source: 'trending', limit: 5 });
    expect(p1.items.length).toBe(5);
    expect(p1.next).toBeDefined();
    const p2 = await a.feed({ source: 'trending', limit: 5, cursor: p1.next! });
    expect(p2.items[0]?.id).not.toBe(p1.items[0]?.id);
    const shorts = await a.feed({ source: 'shorts' });
    expect(shorts.items.every((v) => v.kind === 22)).toBe(true);
    const subs = await a.feed({ source: 'subscriptions' });
    const subd = await a.subscriptions();
    expect(subs.items.every((v) => subd.includes(v.author))).toBe(true);
  });

  it('search + related + stats', async () => {
    const a = new MockNetworkAdapter();
    expect((await a.search({ text: 'ceramics' })).items.length).toBeGreaterThan(0);
    const v = VIDEOS[0]!;
    const rel = await a.related(v.id, 3);
    expect(rel.length).toBe(3);
    expect(rel.every((r) => r.id !== v.id)).toBe(true);
    expect((await a.stats(v.id)).seedersOnline).toBeGreaterThan(0);
  });

  it('reactions (v4): like/dislike counts, newest reaction wins, unreact returns to neutral', async () => {
    const a = new MockNetworkAdapter();
    const v = VIDEOS[0]!;
    const base = await a.stats(v.id);
    expect(base.myReaction).toBeUndefined();
    expect(base.reactions).toBe(base.likes + base.dislikes);

    await a.react(v.id, '+');
    const liked = await a.stats(v.id);
    expect(liked).toMatchObject({
      myReaction: 'like',
      likes: base.likes + 1,
      dislikes: base.dislikes,
    });

    await a.react(v.id, '-'); // replaces the like, never stacks
    const disliked = await a.stats(v.id);
    expect(disliked).toMatchObject({
      myReaction: 'dislike',
      likes: base.likes,
      dislikes: base.dislikes + 1,
    });

    await a.unreact(v.id); // neutral — un-like/un-dislike is NOT a `-` reaction
    const neutral = await a.stats(v.id);
    expect(neutral.myReaction).toBeUndefined();
    expect(neutral).toMatchObject({ likes: base.likes, dislikes: base.dislikes });
    expect((await a.library.liked()).some((x) => x.id === v.id)).toBe(false);
  });

  it('comments: sort, page, and post', async () => {
    const a = new MockNetworkAdapter();
    const v = VIDEOS[1]!;
    const top = await a.comments(v.id, 'top');
    for (let i = 1; i < top.items.length; i++)
      expect(top.items[i - 1]!.reactions).toBeGreaterThanOrEqual(top.items[i]!.reactions);
    const mine = await a.comment(v.id, 'hello');
    expect(mine.author).toBe(ME);
    expect((await a.comments(v.id, 'new')).items[0]?.id).toBe(mine.id);
  });

  it('play: charges the wallet and reports per-peer spend; pause stops paying', async () => {
    let tickFn: (() => void) | null = null;
    const wallet = new MockWallet({ balances: { [MINTS.a]: 1000 } });
    const a = new MockNetworkAdapter({
      wallet,
      setInterval: (fn) => ((tickFn = fn), () => (tickFn = null)),
      blocksPerSecond: 4,
    });
    const v = VIDEOS[0]!; // 1 sat/block on mint a
    const s = await a.play(v.id);
    let peers: readonly PeerSpend[] = [];
    s.onPeers((p) => (peers = p));
    (tickFn as unknown as () => void)();
    expect(await wallet.balance(MINTS.a)).toBe(996);
    expect(peers.reduce((n, p) => n + p.blocks, 0)).toBe(4);
    s.pause();
    (tickFn as unknown as () => void)();
    expect(await wallet.balance(MINTS.a)).toBe(996);
    await s.close();
    expect(tickFn).toBeNull();
  });

  it('error states are reachable by option', async () => {
    const v = VIDEOS[0]!;
    await expect(new MockNetworkAdapter({ failWith: 'no-seeders' }).play(v.id)).rejects.toThrow(
      /no-seeders/,
    );
    await expect(new MockNetworkAdapter({ failWith: 'no-balance' }).play(v.id)).rejects.toThrow(
      /no-balance/,
    );
    expect((await new MockNetworkAdapter({ failWith: 'no-signer' }).signer()).pubkey).toBeNull();
    await expect(
      new MockNetworkAdapter({ failWith: 'relay-down' }).feed({ source: 'trending' }),
    ).rejects.toThrow(/relay-down/);
  });

  it('wallet: quote → poll → balance, and send/receive round-trip', async () => {
    const w = new MockWallet({ balances: { [MINTS.a]: 10 }, quotePollsUntilPaid: 2 });
    const q = await w.mintQuote(MINTS.a, 90 as never);
    expect((await w.pollQuote(q)).state).toBe('UNPAID');
    expect((await w.pollQuote(q)).state).toBe('ISSUED');
    expect(await w.balance(MINTS.a)).toBe(100);
    const set = await w.send(6 as never, { p2pk: '02aa' as never, mint: MINTS.a });
    expect(set.proofs.map((p) => p.amount)).toEqual([4, 2]);
    expect(await w.balance(MINTS.a)).toBe(94);
    await expect(w.send(1000 as never, { p2pk: '02aa' as never, mint: MINTS.a })).rejects.toThrow(
      /insufficient/,
    );
    expect((await w.history({ limit: 1 }))[0]?.direction).toBe('out');
  });
});
