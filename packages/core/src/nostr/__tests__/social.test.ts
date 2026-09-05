import { describe, expect, it } from 'vitest';

import type { NostrEvent, RelayConfig } from '../../contracts/index.js';
import { NostrKind } from '../../contracts/index.js';
import { VIDEOS, asSha256 } from '../../mocks/fixtures.js';
import { buildVideoEvent } from '../../manifest/build.js';
import {
  buildCommentEvent,
  fetchComments,
  parseComment,
  postComment,
  watchReplies,
} from '../comments.js';
import { fetchNutzapInfo, normalizeMintUrl, parseNutzapInfo } from '../nutzap-info.js';
import {
  buildReactionEvent,
  classifyReaction,
  countLikesByTarget,
  fetchReactions,
  parseReaction,
  react,
  summarizeReactions,
} from '../reactions.js';
import {
  buildRelayListEvent,
  fetchRelayList,
  normalizeRelayUrl,
  parseRelayList,
} from '../relay-list.js';
import { buildReportEvent, report } from '../report.js';
import type { EventRef } from '../types.js';
import { RELAY_A, T0, TestSigner, asRaw, rig, sign, tamper } from './helpers.js';

const creator = new TestSigner();
let videoEv: NostrEvent;
let video: EventRef;
const ready = (async (): Promise<void> => {
  videoEv = await sign(creator, buildVideoEvent(VIDEOS[0]!));
  video = { id: videoEv.id, pubkey: videoEv.pubkey, kind: videoEv.kind, relayHint: RELAY_A };
})();

describe('NIP-22 comments', () => {
  it('builds root/parent tags per spec for top-level and reply', async () => {
    await ready;
    const top = buildCommentEvent({ video, content: 'hi' }, T0);
    expect(top).toEqual({
      kind: 1111,
      created_at: T0,
      content: 'hi',
      tags: [
        ['E', video.id, RELAY_A, video.pubkey],
        ['K', '21'],
        ['P', video.pubkey],
        ['e', video.id, RELAY_A, video.pubkey],
        ['k', '21'],
        ['p', video.pubkey],
      ],
    });
    const parentSigner = new TestSigner();
    const parentEv = await sign(parentSigner, top);
    const reply = buildCommentEvent(
      {
        video: { ...video, relayHint: undefined },
        content: 'yo',
        parent: { id: parentEv.id, pubkey: parentEv.pubkey, kind: 1111 },
      },
      T0,
    );
    expect(reply.tags).toEqual([
      ['E', video.id, '', video.pubkey],
      ['K', '21'],
      ['P', video.pubkey],
      ['e', parentEv.id, '', parentEv.pubkey],
      ['k', '1111'],
      ['p', parentEv.pubkey],
    ]);
    const parsedReply = parseComment(await sign(parentSigner, reply))!;
    expect(parsedReply).toMatchObject({
      rootId: video.id,
      rootKind: 21,
      parent: parentEv.id,
      content: 'yo',
    });
    const parsedTop = parseComment(parentEv)!;
    expect(parsedTop.parent).toBeUndefined();
    expect(parsedTop.rootId).toBe(video.id);
  });

  it('parseComment reads the legacy A-shaped root the mock adapter emits, and rejects non-comments', async () => {
    const s = new TestSigner();
    const legacy = await sign(s, {
      kind: 1111,
      created_at: T0,
      tags: [
        ['A', `21:${'a'.repeat(64)}`],
        ['K', '21'],
      ],
      content: 'x',
    });
    expect(parseComment(legacy)?.rootId).toBe('a'.repeat(64));
    expect(
      parseComment(
        await sign(s, { kind: 1111, created_at: T0, tags: [['I', 'https://x']], content: '' }),
      ),
    ).toBeNull();
    expect(
      parseComment(
        await sign(s, { kind: 1, created_at: T0, tags: [['E', 'a'.repeat(64)]], content: '' }),
      ),
    ).toBeNull();
  });

  it('fetchComments returns verified comments with like counts, sorts, pages, and drops tampered ones', async () => {
    await ready;
    const r = rig();
    const alice = new TestSigner();
    const bob = new TestSigner();
    const c1 = await sign(
      alice,
      buildCommentEvent({ video, content: 'first' }, (T0 - 30) as typeof T0),
    );
    const c2 = await sign(
      bob,
      buildCommentEvent({ video, content: 'second' }, (T0 - 20) as typeof T0),
    );
    const c3 = await sign(
      alice,
      buildCommentEvent(
        { video, content: 'reply', parent: { id: c2.id, pubkey: c2.pubkey, kind: 1111 } },
        (T0 - 10) as typeof T0,
      ),
    );
    for (const c of [c1, c2, c3]) r.pool.store(c);
    r.pool.inject(asRaw(tamper(c2, { content: 'forged comment' })));
    // likes: two on c1 (alice, bob), one dislike on c2, bob likes c1 twice (counted once)
    r.pool.store(
      await sign(alice, buildReactionEvent({ id: c1.id, pubkey: c1.pubkey, kind: 1111 }, '+', T0)),
    );
    r.pool.store(
      await sign(bob, buildReactionEvent({ id: c1.id, pubkey: c1.pubkey, kind: 1111 }, '', T0)),
    );
    r.pool.store(
      await sign(
        bob,
        buildReactionEvent(
          { id: c1.id, pubkey: c1.pubkey, kind: 1111 },
          '+',
          (T0 + 1) as typeof T0,
        ),
      ),
    );
    r.pool.store(
      await sign(bob, buildReactionEvent({ id: c2.id, pubkey: c2.pubkey, kind: 1111 }, '-', T0)),
    );
    r.pool.inject(
      asRaw(
        tamper(
          await sign(
            bob,
            buildReactionEvent({ id: c2.id, pubkey: c2.pubkey, kind: 1111 }, '+', T0),
          ),
        ),
      ),
    );

    const fresh = await fetchComments(r.client, video.id);
    expect(fresh.items.map((c) => [c.content, c.reactions, c.parent])).toEqual([
      ['reply', 0, c2.id],
      ['second', 0, undefined],
      ['first', 2, undefined],
    ]);
    expect(fresh.items.some((c) => c.content === 'forged comment')).toBe(false);
    expect(fresh.items[0]?.event).toEqual(c3);
    const top = await fetchComments(r.client, video.id, { sort: 'top' });
    expect(top.items.map((c) => c.content)).toEqual(['first', 'reply', 'second']);
    const p1 = await fetchComments(r.client, video.id, { limit: 2 });
    expect(p1.items.length).toBe(2);
    const p2 = await fetchComments(r.client, video.id, { limit: 2, cursor: p1.next });
    expect(p2.items.map((c) => c.content)).toEqual(['first']);
    expect(p2.next).toBeUndefined();
    expect(r.dropped.length).toBeGreaterThanOrEqual(2);
    expect(r.pool.queries[0]?.filter).toMatchObject({ kinds: [1111], '#E': [video.id] });
  });

  it('postComment signs via the signer and returns Comment shape', async () => {
    await ready;
    const r = rig();
    const c = await postComment(r.client, { video, content: 'mine' });
    expect(c).toMatchObject({ author: r.signer.pubkey, content: 'mine', reactions: 0 });
    expect(c.parent).toBeUndefined();
    const reply = await postComment(r.client, {
      video,
      content: 'r',
      parent: { id: c.id, pubkey: c.author, kind: 1111 },
    });
    expect(reply.parent).toBe(c.id);
    expect((await fetchComments(r.client, video.id)).items.length).toBe(2);
  });

  it('watchReplies delivers only verified replies to my comments from others', async () => {
    await ready;
    const r = rig();
    const me = r.signer;
    const mine = await sign(me, buildCommentEvent({ video, content: 'mine' }, T0));
    const got: string[] = [];
    const stop = watchReplies(r.client, me.pubkey, T0, (c) => got.push(c.content));
    const other = new TestSigner();
    const reply = await sign(
      other,
      buildCommentEvent(
        { video, content: 'reply!', parent: { id: mine.id, pubkey: me.pubkey, kind: 1111 } },
        (T0 + 1) as typeof T0,
      ),
    );
    r.pool.store(reply);
    r.pool.inject(asRaw(tamper(reply, { content: 'forged' })));
    r.pool.store(
      await sign(
        me,
        buildCommentEvent(
          { video, content: 'self-reply', parent: { id: mine.id, pubkey: me.pubkey, kind: 1111 } },
          (T0 + 2) as typeof T0,
        ),
      ),
    );
    stop();
    expect(got).toEqual(['reply!']);
  });
});

describe('NIP-25 reactions', () => {
  it('classifies and builds per spec', async () => {
    await ready;
    expect(classifyReaction('+')).toBe('like');
    expect(classifyReaction('')).toBe('like');
    expect(classifyReaction('-')).toBe('dislike');
    expect(classifyReaction('🔥')).toBe('emoji');
    expect(buildReactionEvent(video, '+', T0)).toEqual({
      kind: 7,
      created_at: T0,
      content: '+',
      tags: [
        ['e', video.id, RELAY_A, video.pubkey],
        ['p', video.pubkey],
        ['k', '21'],
      ],
    });
    const ev = await sign(new TestSigner(), buildReactionEvent(video, '🔥', T0));
    expect(parseReaction(ev)).toMatchObject({
      target: video.id,
      targetAuthor: video.pubkey,
      kind: 'emoji',
      content: '🔥',
    });
    expect(
      parseReaction(await sign(creator, { kind: 7, created_at: T0, tags: [], content: '+' })),
    ).toBeNull();
  });

  it('summarizes newest-per-pubkey; fetchReactions verifies and reports mine', async () => {
    await ready;
    const r = rig();
    const alice = new TestSigner();
    const a1 = await sign(alice, buildReactionEvent(video, '+', T0));
    const a2 = await sign(alice, buildReactionEvent(video, '-', (T0 + 5) as typeof T0));
    const mine = await sign(r.signer, buildReactionEvent(video, '🔥', T0));
    r.pool.store(a1);
    r.pool.store(a2);
    r.pool.store(mine);
    r.pool.inject(asRaw(tamper(await sign(new TestSigner(), buildReactionEvent(video, '+', T0)))));
    const s = await fetchReactions(r.client, video.id, r.signer.pubkey);
    expect(s.likes).toBe(0);
    expect(s.dislikes).toBe(1);
    expect([...s.emoji.entries()]).toEqual([['🔥', 1]]);
    expect(s.mine?.content).toBe('🔥');
    expect(r.dropped.length).toBe(1);
    expect(summarizeReactions([]).mine).toBeUndefined();
    const likes = await countLikesByTarget(r.client, [video.id, 'f'.repeat(64) as typeof video.id]);
    expect(likes.get(video.id)).toBe(0);
    expect((await countLikesByTarget(r.client, [])).size).toBe(0);
  });

  it('react publishes through the signer', async () => {
    await ready;
    const r = rig();
    const ev = await react(r.client, video);
    expect(ev.kind).toBe(NostrKind.Reaction);
    expect(ev.content).toBe('+');
    expect((await fetchReactions(r.client, video.id)).likes).toBe(1);
  });
});

describe('NIP-61 kind 10019', () => {
  it('parses relays, mints (normalised, deduped) and the P2PK pubkey; refuses the Nostr key', async () => {
    const s = new TestSigner();
    const p2pk = `02${'ab'.repeat(32)}`;
    const ev = await sign(s, {
      kind: 10019,
      created_at: T0,
      tags: [
        ['relay', 'wss://r1'],
        ['relay', 'http://nope'],
        ['mint', 'https://Mint.Example/', 'sat', 'usd'],
        ['mint', 'https://mint.example'],
        ['mint', 'ftp://x'],
        ['pubkey', p2pk],
      ],
      content: '',
    });
    expect(parseNutzapInfo(ev)).toMatchObject({
      pubkey: s.pubkey,
      relays: ['wss://r1'],
      mints: [{ url: 'https://mint.example', units: ['sat', 'usd'] }],
      p2pk,
    });
    const xonly = await sign(s, {
      kind: 10019,
      created_at: T0,
      tags: [
        ['mint', 'https://m'],
        ['pubkey', 'cd'.repeat(32)],
      ],
      content: '',
    });
    expect(parseNutzapInfo(xonly)?.p2pk).toBe(`02${'cd'.repeat(32)}`);
    const self = await sign(s, {
      kind: 10019,
      created_at: T0,
      tags: [
        ['mint', 'https://m'],
        ['pubkey', s.pubkey],
      ],
      content: '',
    });
    expect(parseNutzapInfo(self)).toBeNull();
    expect(
      parseNutzapInfo(
        await sign(s, { kind: 10019, created_at: T0, tags: [['pubkey', p2pk]], content: '' }),
      ),
    ).toBeNull();
    expect(
      parseNutzapInfo(
        await sign(s, { kind: 10019, created_at: T0, tags: [['mint', 'https://m']], content: '' }),
      ),
    ).toBeNull();
    expect(normalizeMintUrl('not a url')).toBeNull();
    expect(normalizeMintUrl('https://a.example/x/#frag')).toBe('https://a.example/x');
  });

  it('fetchNutzapInfo takes the newest verified event; tampered dropped', async () => {
    const r = rig();
    const s = new TestSigner();
    const good = await sign(s, {
      kind: 10019,
      created_at: T0,
      tags: [
        ['mint', 'https://m'],
        ['pubkey', `02${'ab'.repeat(32)}`],
      ],
      content: '',
    });
    r.pool.store(good);
    r.pool.inject(
      asRaw(
        tamper(good, {
          tags: [
            ['mint', 'https://evil'],
            ['pubkey', `02${'ee'.repeat(32)}`],
          ],
          created_at: T0 + 1,
        }),
      ),
    );
    expect(await fetchNutzapInfo(r.client, s.pubkey)).toBeNull(); // forged "newer" 10019 is dropped, not believed
    expect(r.dropped.length).toBe(1);
    r.pool.clear();
    r.pool.store(good);
    expect((await fetchNutzapInfo(r.client, s.pubkey))?.mints[0]?.url).toBe('https://m');
    expect(await fetchNutzapInfo(r.client, new TestSigner().pubkey)).toBeNull();
  });
});

describe('NIP-65 kind 10002', () => {
  it('parses markers, merges duplicates, normalises; builds back', async () => {
    const s = new TestSigner();
    const ev = await sign(s, {
      kind: 10002,
      created_at: T0,
      tags: [
        ['r', 'wss://a.example/'],
        ['r', 'wss://b.example', 'write'],
        ['r', 'wss://c.example', 'read'],
        ['r', 'wss://b.example', 'read'],
        ['r', 'https://not-a-relay'],
        ['r'],
      ],
      content: '',
    });
    const cfg = parseRelayList(ev);
    expect(cfg).toEqual([
      { url: 'wss://a.example', read: true, write: true },
      { url: 'wss://b.example', read: true, write: true },
      { url: 'wss://c.example', read: true, write: false },
    ]);
    const rebuilt = buildRelayListEvent(
      [
        ...cfg,
        { url: 'wss://d' as RelayConfig['url'], read: false, write: true },
        { url: 'wss://e' as RelayConfig['url'], read: false, write: false },
      ],
      T0,
    );
    expect(rebuilt.tags).toEqual([
      ['r', 'wss://a.example'],
      ['r', 'wss://b.example'],
      ['r', 'wss://c.example', 'read'],
      ['r', 'wss://d', 'write'],
    ]);
    expect(normalizeRelayUrl('WSS://X.Example/path/#f')).toBe('wss://x.example/path');
    expect(normalizeRelayUrl('nope')).toBeNull();
    expect(
      parseRelayList(
        await sign(s, { kind: 1, created_at: T0, tags: [['r', 'wss://a']], content: '' }),
      ),
    ).toEqual([]);
  });

  it('fetchRelayList verifies', async () => {
    const r = rig();
    const s = new TestSigner();
    const ev = await sign(s, {
      kind: 10002,
      created_at: T0,
      tags: [['r', 'wss://a']],
      content: '',
    });
    r.pool.store(ev);
    r.pool.inject(asRaw(tamper(ev, { tags: [['r', 'wss://evil']], created_at: T0 + 1 })));
    expect(await fetchRelayList(r.client, s.pubkey)).toEqual([]); // forged relay list dropped, not believed
    expect(r.dropped.length).toBe(1);
    r.pool.clear();
    r.pool.store(ev);
    expect((await fetchRelayList(r.client, s.pubkey)).map((c) => c.url)).toEqual(['wss://a']);
  });
});

describe('NIP-56 reports', () => {
  it('builds e/p (+x/server) tags with the type marker and publishes', async () => {
    await ready;
    expect(
      buildReportEvent(
        {
          target: video,
          type: 'malware',
          reason: 'bad',
          blob: { sha256: asSha256('b'), server: 'https://s' },
        },
        T0,
      ),
    ).toEqual({
      kind: 1984,
      created_at: T0,
      content: 'bad',
      tags: [
        ['e', video.id, 'malware'],
        ['p', video.pubkey],
        ['x', asSha256('b'), 'malware'],
        ['server', 'https://s'],
      ],
    });
    const r = rig();
    const ev = await report(r.client, { target: video, type: 'spam' });
    expect(ev.kind).toBe(1984);
    expect(ev.content).toBe('');
    expect(ev.pubkey).toBe(r.signer.pubkey);
  });
});
