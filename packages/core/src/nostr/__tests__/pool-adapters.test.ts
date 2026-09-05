import { SimplePool } from 'nostr-tools/pool';
import { describe, expect, it } from 'vitest';

import type { Event as WireEvent } from 'nostr-tools/core';

import type { NostrEvent, RelayUrl } from '../../contracts/index.js';
import { FakeRelayPool } from '../fake-relay.js';
import type { PoolBackend } from '../simple-pool-adapter.js';
import { SimplePoolAdapter, toWireFilter } from '../simple-pool-adapter.js';
import { RELAY_A, RELAY_B, T0, TestSigner, sign } from './helpers.js';

describe('SimplePoolAdapter', () => {
  it('constructs over a real SimplePool without touching the network', () => {
    const real = new SimplePool();
    const adapter = new SimplePoolAdapter(real);
    expect(real.listConnectionStatus().size).toBe(0);
    adapter.close();
    expect(real.listConnectionStatus().size).toBe(0);
  });

  it('maps query/subscribe/publish onto the backend with copied, mutable filters', async () => {
    const log: string[] = [];
    let onevent: ((e: WireEvent) => void) | undefined;
    let closed = '';
    const backend: PoolBackend = {
      querySync: (relays, filter, params) => {
        log.push(`query ${relays.join(',')} ${JSON.stringify(filter)} ${params?.maxWait ?? '-'}`);
        return Promise.resolve([{ id: 'raw' } as unknown as WireEvent]);
      },
      subscribeMap: (requests, params) => {
        log.push(`sub ${requests.map((r) => `${r.url}:${JSON.stringify(r.filter)}`).join(' ')}`);
        onevent = params.onevent;
        params.oneose?.();
        return {
          close: (reason) => {
            closed = reason ?? '';
          },
        };
      },
      publish: (relays, event) => {
        log.push(`pub ${relays.join(',')} ${event.id}`);
        return [Promise.resolve('ok'), Promise.reject(new Error('rate limited'))];
      },
      destroy: () => log.push('destroy'),
    };
    const adapter = new SimplePoolAdapter(backend);
    const raws = await adapter.query([RELAY_A], { kinds: [1], '#t': ['x'] }, { maxWaitMs: 500 });
    expect(raws).toEqual([{ id: 'raw' }]);
    const got: unknown[] = [];
    let eose = false;
    const stop = adapter.subscribe([RELAY_A, RELAY_B], [{ kinds: [1] }, { kinds: [2] }], {
      onevent: (r) => got.push(r),
      oneose: () => {
        eose = true;
      },
    });
    onevent?.({ id: 'live' } as unknown as WireEvent);
    stop();
    const signer = new TestSigner();
    const ev = await sign(signer, { kind: 1, created_at: T0, tags: [], content: '' });
    const res = await adapter.publish([RELAY_A, RELAY_B], ev);
    adapter.close();
    expect(log).toEqual([
      `query ${RELAY_A} {"kinds":[1],"#t":["x"]} 500`,
      `sub ${RELAY_A}:{"kinds":[1]} ${RELAY_A}:{"kinds":[2]} ${RELAY_B}:{"kinds":[1]} ${RELAY_B}:{"kinds":[2]}`,
      `pub ${RELAY_A},${RELAY_B} ${ev.id}`,
      'destroy',
    ]);
    expect(got).toEqual([{ id: 'live' }]);
    expect(eose).toBe(true);
    expect(closed).toBe('unsubscribed');
    expect(res).toEqual([
      { url: RELAY_A, ok: true, reason: 'ok' },
      { url: RELAY_B, ok: false, reason: 'rate limited' },
    ]);
  });

  it('short-circuits with no relays', async () => {
    const backend: PoolBackend = {
      querySync: () => Promise.reject(new Error('must not be called')),
      subscribeMap: () => {
        throw new Error('must not be called');
      },
      publish: () => {
        throw new Error('must not be called');
      },
      destroy: () => undefined,
    };
    const adapter = new SimplePoolAdapter(backend);
    expect(await adapter.query([], { kinds: [1] })).toEqual([]);
    let eose = false;
    adapter.subscribe([], [{ kinds: [1] }], {
      onevent: () => undefined,
      oneose: () => {
        eose = true;
      },
    })();
    expect(eose).toBe(true);
    const signer = new TestSigner();
    expect(
      await adapter.publish(
        [],
        await sign(signer, { kind: 1, created_at: T0, tags: [], content: '' }),
      ),
    ).toEqual([]);
  });

  it('toWireFilter copies every array so the readonly contract filter is never aliased', () => {
    const tags = ['a'];
    const f = toWireFilter({
      ids: ['i'],
      authors: ['p'] as never,
      kinds: [1],
      since: 1 as never,
      until: 2 as never,
      limit: 3,
      search: 's',
      '#t': tags,
    });
    expect(f).toEqual({
      ids: ['i'],
      authors: ['p'],
      kinds: [1],
      since: 1,
      until: 2,
      limit: 3,
      search: 's',
      '#t': ['a'],
    });
    expect(f['#t']).not.toBe(tags);
  });
});

describe('FakeRelayPool', () => {
  const signer = new TestSigner();
  const mk = (
    kind: number,
    created_at: number,
    tags: string[][] = [],
    content = '',
  ): Promise<NostrEvent> => sign(signer, { kind, created_at: created_at, tags, content });

  it('applies replaceable and addressable semantics', async () => {
    const pool = new FakeRelayPool();
    pool.store(await mk(0, T0, [], 'old'));
    pool.store(await mk(0, T0 + 1, [], 'new'));
    pool.store(await mk(0, T0 - 1, [], 'older')); // ignored
    pool.store(await mk(30005, T0, [['d', 'x']], 'x1'));
    pool.store(await mk(30005, T0 + 1, [['d', 'x']], 'x2'));
    pool.store(await mk(30005, T0, [['d', 'y']], 'y1'));
    pool.store(await mk(1, T0, [], 'n1'));
    pool.store(await mk(1, T0, [], 'n2')); // regular: both kept
    expect(
      pool
        .events()
        .map((e) => e.content)
        .sort(),
    ).toEqual(['n1', 'n2', 'new', 'x2', 'y1']);
  });

  it('matches NIP-01 filters, sorts newest-first, applies limit and naive search', async () => {
    const pool = new FakeRelayPool();
    pool.store(
      await mk(
        21,
        T0 - 2,
        [
          ['title', 'Raku firing'],
          ['t', 'ceramics'],
        ],
        'desc',
      ),
    );
    pool.store(
      await mk(
        21,
        T0 - 1,
        [
          ['title', 'Pods'],
          ['t', 'devops'],
        ],
        'kubernetes',
      ),
    );
    pool.store(await mk(22, T0, [['title', 'Short']], 'x'));
    const all = await pool.query([RELAY_A], { kinds: [21, 22] });
    expect((all as NostrEvent[]).map((e) => e.created_at)).toEqual([T0, T0 - 1, T0 - 2]);
    expect((await pool.query([RELAY_A], { kinds: [21, 22], limit: 2 })).length).toBe(2);
    expect(
      ((await pool.query([RELAY_A], { '#t': ['ceramics'] })) as NostrEvent[])[0]?.content,
    ).toBe('desc');
    expect(((await pool.query([RELAY_A], { search: 'RAKU' })) as NostrEvent[]).length).toBe(1);
    expect(((await pool.query([RELAY_A], { search: 'kube' })) as NostrEvent[]).length).toBe(1);
    expect((await pool.query([RELAY_A], { kinds: [21], since: T0 })).length).toBe(0);
    expect((await pool.query([], { kinds: [21] })).length).toBe(0);
  });

  it('serves injected junk only to filters its claimed fields match', async () => {
    const pool = new FakeRelayPool();
    pool.inject({ kind: 7, tags: [['e', 'abc']], id: 'x' });
    expect((await pool.query([RELAY_A], { kinds: [7], '#e': ['abc'] })).length).toBe(1);
    expect((await pool.query([RELAY_A], { kinds: [1] })).length).toBe(0);
    expect((await pool.query([RELAY_A], { kinds: [7], '#e': ['zzz'] })).length).toBe(0);
    expect((await pool.query([RELAY_A], { ids: ['y'] })).length).toBe(0);
  });

  it('live subscriptions get stored events, eose, then future matches until unsubscribed', async () => {
    const pool = new FakeRelayPool();
    pool.store(await mk(1, T0 - 1, [], 'before'));
    const got: string[] = [];
    let eose = 0;
    const stop = pool.subscribe([RELAY_A], [{ kinds: [1] }], {
      onevent: (raw) => got.push((raw as NostrEvent).content),
      oneose: () => {
        eose += 1;
      },
    });
    pool.store(await mk(1, T0, [], 'during'));
    pool.store(await mk(2, T0, [], 'other-kind'));
    stop();
    pool.store(await mk(1, T0 + 1, [], 'after'));
    expect(got).toEqual(['before', 'during']);
    expect(eose).toBe(1);
  });

  it('publish honours rejectPublish per relay and stores only when someone accepted', async () => {
    const pool = new FakeRelayPool({
      rejectPublish: (_e, url) => (url === RELAY_B ? 'nope' : null),
    });
    const ev = await mk(1, T0);
    const res = await pool.publish([RELAY_A, RELAY_B] as RelayUrl[], ev);
    expect(res).toEqual([
      { url: RELAY_A, ok: true },
      { url: RELAY_B, ok: false, reason: 'nope' },
    ]);
    expect(pool.events().length).toBe(1);
    const all = new FakeRelayPool({ rejectPublish: () => 'no' });
    await all.publish([RELAY_A], ev);
    expect(all.events().length).toBe(0);
  });
});
