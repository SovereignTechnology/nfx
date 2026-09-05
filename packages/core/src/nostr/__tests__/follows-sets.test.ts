import { describe, expect, it } from 'vitest';

import { NostrKind } from '../../contracts/index.js';
import { asEventId } from '../../mocks/fixtures.js';
import {
  buildFollowsEvent,
  fetchFollows,
  fetchSubscriptions,
  parseFollows,
  setSubscribed,
} from '../follows.js';
import {
  SetId,
  buildSetEvent,
  fetchHistory,
  fetchLiked,
  fetchPlaylists,
  fetchSet,
  fetchWatchLater,
  parseHistoryItems,
  parseSet,
  playlistToSetInput,
  recordProgress,
  savePlaylist,
  setLiked,
  setWatchLater,
  toPlaylist,
} from '../sets.js';
import { T0, TestSigner, asRaw, rig, sign, tamper } from './helpers.js';

const A = new TestSigner();
const B = new TestSigner();
const C = new TestSigner();

describe('kind 3 follows', () => {
  it('parses p tags with hints/petnames, skips junk and dupes; builds back', () => {
    const tags = [
      ['p', A.pubkey, 'wss://r', 'alice'],
      ['p', B.pubkey, ''],
      ['p', 'nothex'],
      ['p', A.pubkey],
      ['e', C.pubkey],
      ['p'],
    ];
    const f = parseFollows({ tags });
    expect(f).toEqual([
      { pubkey: A.pubkey, relayHint: 'wss://r', petname: 'alice' },
      { pubkey: B.pubkey },
    ]);
    expect(buildFollowsEvent(f, T0).tags).toEqual([
      ['p', A.pubkey, 'wss://r', 'alice'],
      ['p', B.pubkey],
    ]);
    expect(buildFollowsEvent([{ pubkey: B.pubkey, relayHint: 'wss://x' }], T0).tags).toEqual([
      ['p', B.pubkey, 'wss://x'],
    ]);
  });

  it('fetchFollows verifies; a tampered follow list is dropped', async () => {
    const { pool, client, signer, dropped } = rig();
    const ev = await sign(signer, buildFollowsEvent([{ pubkey: A.pubkey }], T0));
    pool.store(ev);
    pool.inject(asRaw(tamper(ev, { tags: [['p', C.pubkey]], created_at: T0 + 1 })));
    // newer impostor wins the relay's limit:1, then gets dropped: nothing believed
    expect(await fetchFollows(client, signer.pubkey)).toEqual([]);
    expect(dropped.length).toBe(1);
    pool.clear();
    pool.store(ev);
    pool.inject(asRaw(tamper(ev, { tags: [['p', C.pubkey]], created_at: T0 - 1 })));
    expect((await fetchFollows(client, signer.pubkey)).map((f) => f.pubkey)).toEqual([A.pubkey]);
    expect(dropped.length).toBe(1);
  });
});

describe('subscriptions (channel set with kind-3 fallback)', () => {
  it('falls back to kind 3, then prefers the channel set once it exists; toggles idempotently', async () => {
    const { pool, client, signer } = rig();
    expect(await fetchSubscriptions(client, signer.pubkey)).toEqual({
      pubkeys: [],
      source: 'none',
    });
    pool.store(
      await sign(signer, buildFollowsEvent([{ pubkey: A.pubkey }], (T0 - 5) as typeof T0)),
    );
    expect(await fetchSubscriptions(client, signer.pubkey)).toEqual({
      pubkeys: [A.pubkey],
      source: 'follows',
    });

    const ev = await setSubscribed(client, B.pubkey, true);
    expect(ev?.kind).toBe(NostrKind.ChannelSet);
    expect(ev?.tags).toEqual([
      ['d', SetId.Channels],
      ['title', 'Channels'],
      ['p', A.pubkey],
      ['p', B.pubkey],
    ]);
    expect(await fetchSubscriptions(client, signer.pubkey)).toEqual({
      pubkeys: [A.pubkey, B.pubkey],
      source: 'channel-set',
    });
    expect(await setSubscribed(client, B.pubkey, true)).toBeNull(); // no-op, no publish
    expect(pool.published.length).toBe(1);
    await setSubscribed(client, A.pubkey, false);
    expect((await fetchSubscriptions(client, signer.pubkey)).pubkeys).toEqual([B.pubkey]);
  });

  it('a tampered channel set from the relay is dropped (falls through to kind 3)', async () => {
    const { pool, client, signer, dropped } = rig();
    pool.store(await sign(signer, buildFollowsEvent([{ pubkey: A.pubkey }], T0)));
    const set = await sign(
      signer,
      await buildSetEvent(
        { kind: NostrKind.ChannelSet, d: SetId.Channels, publicItems: [['p', B.pubkey]] },
        signer,
        T0,
      ),
    );
    pool.inject(
      asRaw(
        tamper(set, {
          tags: [
            ['d', SetId.Channels],
            ['p', C.pubkey],
          ],
        }),
      ),
    );
    expect(await fetchSubscriptions(client, signer.pubkey)).toEqual({
      pubkeys: [A.pubkey],
      source: 'follows',
    });
    expect(dropped.length).toBe(1);
  });
});

describe('NIP-51 sets: private items go through Signer.nip44* only', () => {
  const v1 = asEventId('v1');
  const v2 = asEventId('v2');

  it('buildSetEvent encrypts private items to our own pubkey and never puts plaintext in the event', async () => {
    const s = new TestSigner();
    const draft = await buildSetEvent(
      {
        kind: NostrKind.VideoSet,
        d: 'wl',
        title: 'T',
        description: 'D',
        image: 'https://i',
        publicItems: [['e', v1]],
        privateItems: [['e', v2]],
      },
      s,
      T0,
    );
    expect(draft.tags).toEqual([
      ['d', 'wl'],
      ['title', 'T'],
      ['description', 'D'],
      ['image', 'https://i'],
      ['e', v1],
    ]);
    expect(draft.content).not.toContain(v2);
    expect(s.calls).toEqual([
      { method: 'getPublicKey' },
      { method: 'nip44Encrypt', peer: s.pubkey },
    ]);
    const ev = await sign(s, draft);
    const parsed = await parseSet(ev, s);
    expect(parsed).toMatchObject({
      d: 'wl',
      title: 'T',
      description: 'D',
      image: 'https://i',
      publicItems: [['e', v1]],
      privateItems: [['e', v2]],
      privateStatus: 'decrypted',
    });
    expect(s.calls.at(-1)).toEqual({ method: 'nip44Decrypt', peer: s.pubkey });
    expect(await buildSetEvent({ kind: 30005, d: 'x', publicItems: [] }, s, T0)).toMatchObject({
      content: '',
    });
    await expect(buildSetEvent({ kind: 30005, d: 'x', publicItems: [[]] }, s, T0)).rejects.toThrow(
      /non-empty/,
    );
  });

  it('parseSet reports locked / unsupported / failed / none without throwing', async () => {
    const s = new TestSigner();
    const other = new TestSigner();
    const ev = await sign(
      s,
      await buildSetEvent(
        { kind: 30005, d: 'p', publicItems: [], privateItems: [['e', v1]] },
        s,
        T0,
      ),
    );
    expect((await parseSet(ev))?.privateStatus).toBe('locked');
    expect((await parseSet(ev, other))?.privateStatus).toBe('locked');
    expect(other.calls.some((c) => c.method === 'nip44Decrypt')).toBe(false);
    const legacy = await sign(s, {
      kind: 30005,
      created_at: T0,
      tags: [['d', 'l']],
      content: 'abc?iv=def',
    });
    expect((await parseSet(legacy, s))?.privateStatus).toBe('unsupported');
    const garbage = await sign(s, {
      kind: 30005,
      created_at: T0,
      tags: [['d', 'g']],
      content: `fake44:${s.pubkey}:${Buffer.from('{"not":"tags"}').toString('base64')}`,
    });
    expect((await parseSet(garbage, s))?.privateStatus).toBe('failed');
    const empty = await sign(s, {
      kind: 30005,
      created_at: T0,
      tags: [
        ['d', 'e'],
        ['e', v1],
      ],
      content: '',
    });
    expect(await parseSet(empty, s)).toMatchObject({
      privateStatus: 'none',
      publicItems: [['e', v1]],
    });
    expect(
      await parseSet(await sign(s, { kind: 30005, created_at: T0, tags: [], content: '' }), s),
    ).toBeNull();
  });

  it('fetchSet drops a tampered set from the relay', async () => {
    const { pool, client, signer, dropped } = rig();
    const ev = await sign(
      signer,
      await buildSetEvent({ kind: 30005, d: 'mine', publicItems: [['e', v1]] }, signer, T0),
    );
    pool.store(ev);
    pool.inject(
      asRaw(
        tamper(ev, {
          tags: [
            ['d', 'mine'],
            ['e', v2],
          ],
          created_at: T0 + 1,
        }),
      ),
    );
    expect(await fetchSet(client, signer.pubkey, 30005, 'mine')).toBeNull();
    expect(dropped.length).toBe(1);
    pool.clear();
    pool.store(ev);
    pool.inject(
      asRaw(
        tamper(ev, {
          tags: [
            ['d', 'mine'],
            ['e', v2],
          ],
          created_at: T0 - 1,
        }),
      ),
    );
    const set = await fetchSet(client, signer.pubkey, 30005, 'mine');
    expect(set?.publicItems).toEqual([['e', v1]]);
    expect(dropped.length).toBe(1);
  });

  it('playlists: public vs private, listing excludes the library sets, save round-trips', async () => {
    const { pool, client, signer } = rig();
    const pub = await savePlaylist(client, {
      id: 'faves',
      title: 'Faves',
      description: 'd',
      videoIds: [v1, v2],
      isPrivate: false,
    });
    expect(pub).toEqual({
      id: 'faves',
      author: signer.pubkey,
      title: 'Faves',
      description: 'd',
      videoIds: [v1, v2],
      isPrivate: false,
    });
    const priv = await savePlaylist(client, {
      id: 'secret',
      title: 'Secret',
      videoIds: [v2],
      isPrivate: true,
    });
    expect(priv).toEqual({
      id: 'secret',
      author: signer.pubkey,
      title: 'Secret',
      videoIds: [v2],
      isPrivate: true,
    });
    const privEvent = pool.events().find((e) => e.tags.some((t) => t[1] === 'secret'))!;
    expect(privEvent.tags.some((t) => t[0] === 'e')).toBe(false);
    expect(privEvent.content).not.toContain(v2);
    await setWatchLater(client, v1, true);
    const lists = await fetchPlaylists(client, signer.pubkey);
    expect(lists.map((p) => p.id).sort()).toEqual(['faves', 'secret']);
    expect(playlistToSetInput({ id: 'x', title: 'X', videoIds: [v1], isPrivate: true })).toEqual({
      kind: 30005,
      d: 'x',
      title: 'X',
      publicItems: [],
      privateItems: [['e', v1]],
    });
    // Someone else's private playlist lists as private with no ids.
    const readOnly = rig({ signer: null });
    readOnly.pool.store(privEvent);
    const theirs = await fetchPlaylists(readOnly.client, signer.pubkey);
    expect(theirs).toEqual([
      { id: 'secret', author: signer.pubkey, title: 'Secret', videoIds: [], isPrivate: true },
    ]);
    expect(toPlaylist((await parseSet(privEvent))!).isPrivate).toBe(true);
  });

  it('watch later / liked: private, append-order, idempotent', async () => {
    const { pool, client, signer } = rig();
    expect(await fetchWatchLater(client)).toEqual([]);
    await setWatchLater(client, v1, true);
    await setWatchLater(client, v2, true);
    await setWatchLater(client, v1, true); // no-op
    expect(pool.published.length).toBe(2);
    expect(await fetchWatchLater(client)).toEqual([v1, v2]);
    await setWatchLater(client, v1, false);
    expect(await fetchWatchLater(client)).toEqual([v2]);
    for (const e of pool.events()) {
      expect(e.tags.filter((t) => t[0] === 'e')).toEqual([]);
      expect(e.content).not.toContain(v1);
    }
    expect(
      signer.calls
        .filter((c) => c.method === 'nip44Encrypt')
        .every((c) => c.peer === signer.pubkey),
    ).toBe(true);
    await setLiked(client, v2, true);
    expect(await fetchLiked(client)).toEqual([v2]);
    await setLiked(client, v2, false);
    expect(await fetchLiked(client)).toEqual([]);
    const anon = rig({ signer: null });
    expect(await fetchWatchLater(anon.client)).toEqual([]);
  });

  it('history: upsert per video, newest first, capped, private', async () => {
    const { pool, client } = rig();
    await recordProgress(client, v1, 10);
    await recordProgress(client, v2, 20);
    await recordProgress(client, v1, 30);
    const h = await fetchHistory(client);
    expect(h.map((e) => [e.videoId, e.positionSec])).toEqual([
      [v1, 30],
      [v2, 20],
    ]);
    expect(pool.events().every((e) => e.tags.every((t) => t[0] === 'd'))).toBe(true);
    await recordProgress(client, asEventId('v3'), 1, 2);
    expect((await fetchHistory(client)).map((e) => e.videoId)).toEqual([asEventId('v3'), v1]);
    expect(
      parseHistoryItems([
        ['watched', v1, '1.5', '10'],
        ['watched', 'bad', '1', '1'],
        ['watched', v2, '-1', '1'],
        ['e', v2],
      ]),
    ).toEqual([{ videoId: v1, positionSec: 1.5, at: 10 }]);
  });

  it('a tampered private set from the relay is dropped (never reaches decrypt)', async () => {
    const { pool, client, signer, dropped } = rig();
    await setWatchLater(client, v1, true);
    const real = pool.events()[0]!;
    const forged = `fake44:${signer.pubkey}:${Buffer.from(JSON.stringify([['e', v2]])).toString('base64')}`;
    pool.inject(asRaw(tamper(real, { created_at: real.created_at + 10, content: forged })));
    let before = signer.calls.length;
    expect(await fetchWatchLater(client)).toEqual([]); // impostor hid the real one under limit:1 and was dropped
    expect(dropped.length).toBe(1);
    expect(signer.calls.slice(before).filter((c) => c.method === 'nip44Decrypt').length).toBe(0);
    pool.clear();
    pool.store(real);
    pool.inject(asRaw(tamper(real, { created_at: real.created_at - 10, content: forged })));
    before = signer.calls.length;
    expect(await fetchWatchLater(client)).toEqual([v1]);
    expect(dropped.length).toBe(1);
    // exactly one decrypt happened — for the genuine event
    expect(signer.calls.slice(before).filter((c) => c.method === 'nip44Decrypt').length).toBe(1);
  });
});
