import { describe, expect, it } from 'vitest';

import type { NostrPubkey } from '../../contracts/index.js';
import { lookupNip05, parseNip05, verifyNip05 } from '../nip05.js';
import {
  buildProfileEvent,
  fetchProfile,
  fetchProfiles,
  parseProfile,
  publishProfile,
} from '../profiles.js';
import type { FetchLike } from '../types.js';
import { T0, TestSigner, asRaw, rig, sign, tamper } from './helpers.js';

function fakeFetch(
  table: Record<string, { status?: number; body?: unknown; throws?: boolean }>,
  log: string[] = [],
): FetchLike {
  return (url, init) => {
    log.push(`${url} ${init.redirect}`);
    const hit = table[url];
    if (!hit) return Promise.resolve({ status: 404, json: () => Promise.resolve({}) });
    if (hit.throws) return Promise.reject(new Error('network'));
    return Promise.resolve({ status: hit.status ?? 200, json: () => Promise.resolve(hit.body) });
  };
}

describe('parseNip05', () => {
  it('normalises and validates', () => {
    expect(parseNip05('Bob@Example.COM')).toEqual({
      local: 'bob',
      domain: 'example.com',
      normalized: 'bob@example.com',
      display: 'bob@example.com',
    });
    expect(parseNip05('example.com')).toMatchObject({ local: '_', display: 'example.com' });
    expect(parseNip05('_@example.com')?.display).toBe('example.com');
    expect(parseNip05('bob+x@example.com')).toBeNull();
    expect(parseNip05('bob@localhost')).toBeNull();
    expect(parseNip05('@example.com')).toBeNull();
    expect(parseNip05('bob@exa mple.com')).toBeNull();
  });
});

describe('lookupNip05 / verifyNip05 (injected fetch, no sockets)', () => {
  const pk = 'ab'.repeat(32) as NostrPubkey;
  const url = 'https://example.com/.well-known/nostr.json?name=bob';

  it('resolves a matching name with relays and never follows redirects', async () => {
    const log: string[] = [];
    const f = fakeFetch(
      {
        [url]: {
          body: {
            names: { bob: pk },
            relays: { [pk]: ['wss://r.example', 'https://not-a-relay'] },
          },
        },
      },
      log,
    );
    expect(await lookupNip05('Bob@example.com', f)).toEqual({
      pubkey: pk,
      relays: ['wss://r.example'],
    });
    expect(log).toEqual([`${url} manual`]);
    expect(await verifyNip05('bob@example.com', pk, f)).toBe(true);
    expect(await verifyNip05('bob@example.com', 'cd'.repeat(32) as NostrPubkey, f)).toBe(false);
  });

  it.each([
    ['redirect status', { status: 301, body: { names: { bob: pk } } }],
    ['non-200', { status: 500 }],
    ['throwing fetch', { throws: true }],
    ['no names', { body: {} }],
    ['upper-case hex', { body: { names: { bob: pk.toUpperCase() } } }],
    ['npub instead of hex', { body: { names: { bob: 'npub1xyz' } } }],
    ['array body', { body: [] }],
    ['other name only', { body: { names: { alice: pk } } }],
  ])('fails closed on %s', async (_label, resp) => {
    const f = fakeFetch({ [url]: resp });
    expect(await lookupNip05('bob@example.com', f)).toBeNull();
    expect(await verifyNip05('bob@example.com', pk, f)).toBe(false);
  });

  it('does not fetch at all for an invalid identifier', async () => {
    const log: string[] = [];
    expect(await lookupNip05('bad id', fakeFetch({}, log))).toBeNull();
    expect(log).toEqual([]);
  });
});

describe('kind 0 profiles', () => {
  it('parses the common fields and sets nip05Status unverified/none', async () => {
    const s = new TestSigner();
    const ev = await sign(
      s,
      buildProfileEvent(
        {
          name: 'bob',
          displayName: 'Bob!',
          about: 'hi',
          picture: 'https://p',
          banner: 'https://b',
          nip05: 'bob@example.com',
          lud16: 'bob@ln',
        },
        T0,
      ),
    );
    expect(JSON.parse(ev.content)).toEqual({
      name: 'bob',
      display_name: 'Bob!',
      about: 'hi',
      picture: 'https://p',
      banner: 'https://b',
      nip05: 'bob@example.com',
      lud16: 'bob@ln',
    });
    expect(parseProfile(ev, T0)).toStrictEqual({
      pubkey: s.pubkey,
      name: 'bob',
      displayName: 'Bob!',
      about: 'hi',
      picture: 'https://p',
      banner: 'https://b',
      nip05: 'bob@example.com',
      lud16: 'bob@ln',
      nip05Status: 'unverified',
      fetchedAt: T0,
    });
    const bare = await sign(s, {
      kind: 0,
      created_at: T0,
      tags: [],
      content: '{"displayName":"alt key","name":""}',
    });
    expect(parseProfile(bare, T0)).toStrictEqual({
      pubkey: s.pubkey,
      displayName: 'alt key',
      nip05Status: 'none',
      fetchedAt: T0,
    });
    expect(
      parseProfile(await sign(s, { kind: 0, created_at: T0, tags: [], content: 'not json' }), T0),
    ).toBeNull();
    expect(
      parseProfile(await sign(s, { kind: 0, created_at: T0, tags: [], content: '[1]' }), T0),
    ).toBeNull();
    expect(
      parseProfile(await sign(s, { kind: 1, created_at: T0, tags: [], content: '{}' }), T0),
    ).toBeNull();
  });

  it('fetchProfile returns the newest verified kind 0, drops a tampered one, and runs NIP-05 when fetch is given', async () => {
    const { pool, client, signer, dropped } = rig();
    const old = await sign(signer, buildProfileEvent({ name: 'old' }, (T0 - 10) as typeof T0));
    const cur = await sign(signer, buildProfileEvent({ name: 'cur', nip05: 'me@example.com' }, T0));
    pool.store(old);
    pool.store(cur);
    // The relay also serves an impostor edit claiming to be NEWER: with `limit: 1` a
    // relay returns only that one, and the boundary drops it — nothing is believed.
    pool.inject(
      asRaw(
        tamper(cur, { content: '{"name":"evil","nip05":"me@example.com"}', created_at: T0 + 5 }),
      ),
    );
    expect(await fetchProfile(client, signer.pubkey)).toBeNull();
    expect(dropped.length).toBe(1);
    pool.clear();
    pool.store(old);
    pool.store(cur);
    // An impostor edit claiming to be OLDER is simply outranked by the genuine one.
    pool.inject(asRaw(tamper(cur, { content: '{"name":"evil"}', created_at: T0 - 5 })));
    const p = await fetchProfile(client, signer.pubkey);
    expect(p?.name).toBe('cur');
    expect(p?.nip05Status).toBe('unverified');
    expect(dropped.length).toBe(1);

    const good = fakeFetch({
      'https://example.com/.well-known/nostr.json?name=me': {
        body: { names: { me: signer.pubkey } },
      },
    });
    expect((await fetchProfile(client, signer.pubkey, { fetch: good }))?.nip05Status).toBe(
      'verified',
    );
    const wrong = fakeFetch({
      'https://example.com/.well-known/nostr.json?name=me': {
        body: { names: { me: 'cd'.repeat(32) } },
      },
    });
    expect((await fetchProfile(client, signer.pubkey, { fetch: wrong }))?.nip05Status).toBe(
      'failed',
    );
    expect(await fetchProfile(client, new TestSigner().pubkey)).toBeNull();
  });

  it('fetchProfiles batches by author and keeps the newest per author; tampered dropped', async () => {
    const { pool, client, signer, dropped } = rig();
    const other = new TestSigner();
    pool.store(await sign(signer, buildProfileEvent({ name: 'a' }, T0)));
    pool.store(await sign(other, buildProfileEvent({ name: 'b' }, T0)));
    pool.inject(
      asRaw(tamper(await sign(other, buildProfileEvent({ name: 'b2' }, (T0 + 1) as typeof T0)))),
    );
    const m = await fetchProfiles(client, [signer.pubkey, other.pubkey, signer.pubkey]);
    expect([...m.values()].map((p) => p.name).sort()).toEqual(['a', 'b']);
    expect(dropped.length).toBe(1);
    expect((await fetchProfiles(client, [])).size).toBe(0);
  });

  it('publishProfile signs through the signer', async () => {
    const { client, signer, pool } = rig();
    const ev = await publishProfile(client, { name: 'me' });
    expect(ev.kind).toBe(0);
    expect(ev.pubkey).toBe(signer.pubkey);
    expect(pool.events().length).toBe(1);
  });
});
