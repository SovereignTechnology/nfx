import { describe, expect, it } from 'vitest';

import type { NostrEvent } from '../../contracts/index.js';
import { NoSignerError, NostrClient, PublishError } from '../client.js';
import { FakeRelayPool } from '../fake-relay.js';
import { RELAYS, RELAY_A, RELAY_B, T0, TestSigner, asRaw, rig, sign, tamper } from './helpers.js';

const draft = (
  content: string,
  created_at: number = T0,
): { kind: number; created_at: typeof T0; tags: string[][]; content: string } => ({
  kind: 1,
  created_at: created_at as typeof T0,
  tags: [],
  content,
});

describe('NostrClient reads', () => {
  it('query returns only verified events, deduped and newest-first; tampered ones are dropped and reported', async () => {
    const { pool, client, signer, dropped } = rig();
    const good1 = await sign(signer, draft('one', T0 - 10));
    const good2 = await sign(signer, draft('two', T0));
    const bad = tamper(await sign(signer, draft('three')));
    pool.store(good1);
    pool.store(good2);
    pool.inject(asRaw(bad));
    pool.inject(asRaw(good1)); // duplicate
    pool.inject({ kind: 1, garbage: true });
    const out = await client.query({ kinds: [1] });
    expect(out.map((e) => e.content)).toEqual(['two', 'one']);
    expect(dropped.map((d) => d.reason).sort()).toEqual(['bad-signature', 'malformed']);
    expect(pool.queries[0]?.relays).toEqual([RELAY_A, RELAY_B]);
  });

  it('queryOne adds limit 1; queryMany unions filters', async () => {
    const { pool, client, signer } = rig();
    pool.store(await sign(signer, draft('a', T0 - 1)));
    pool.store(await sign(signer, { ...draft('b'), kind: 2 }));
    const one = await client.queryOne({ kinds: [1, 2] });
    expect(one?.content).toBe('b');
    expect(pool.queries.at(-1)?.filter.limit).toBe(1);
    const many = await client.queryMany([{ kinds: [1] }, { kinds: [2] }]);
    expect(many.map((e) => e.content)).toEqual(['b', 'a']);
  });

  it('subscribe delivers verified events live, drops tampered ones, and dedupes', async () => {
    const { pool, client, signer, dropped } = rig();
    const seen: string[] = [];
    const stop = client.subscribe([{ kinds: [1] }], (ev) => seen.push(ev.content));
    const ok = await sign(signer, draft('live'));
    pool.store(ok);
    pool.inject(asRaw(ok));
    pool.inject(asRaw(tamper(ok)));
    expect(seen).toEqual(['live']);
    expect(dropped.length).toBe(1);
    stop();
    pool.store(await sign(signer, draft('after-unsub')));
    expect(seen).toEqual(['live']);
  });
});

describe('NostrClient writes', () => {
  it('signs through the Signer and publishes to write relays only', async () => {
    const { pool, client, signer } = rig();
    const r = await client.publish(draft('hi'));
    expect(signer.calls.some((c) => c.method === 'signEvent')).toBe(true);
    expect(r.event.pubkey).toBe(signer.pubkey);
    expect(r.results).toEqual([{ url: RELAY_A, ok: true }]);
    expect(pool.published[0]?.relays).toEqual([RELAY_A]);
    expect(pool.events().map((e) => e.id)).toEqual([r.event.id]);
  });

  it('throws NoSignerError when read-only', async () => {
    const { client } = rig({ signer: null });
    expect(client.hasSigner).toBe(false);
    await expect(client.me()).resolves.toBeNull();
    await expect(client.publish(draft('x'))).rejects.toBeInstanceOf(NoSignerError);
  });

  it('throws PublishError when every write relay rejects, and when none is configured', async () => {
    const signer = new TestSigner();
    const pool = new FakeRelayPool({ rejectPublish: () => 'blocked: no' });
    const client = new NostrClient({ pool, relays: RELAYS, signer });
    await expect(client.publish(draft('x'))).rejects.toBeInstanceOf(PublishError);
    const none = new NostrClient({
      pool: new FakeRelayPool(),
      relays: [{ url: RELAY_A, read: true, write: false }],
      signer,
    });
    await expect(none.publish(draft('x'))).rejects.toThrow(/no write relays/);
  });

  it('exposes the verification helper for adapters', async () => {
    const { client, signer } = rig();
    const ev = await sign(signer, draft('v'));
    const out: NostrEvent[] = client.verifyAll([asRaw(ev), asRaw(tamper(ev)), 42]);
    expect(out.length).toBe(1);
  });
});
