/**
 * `PoolLike` backed by `nostr-tools` `SimplePool` (2.25.2).
 *
 * Constructing a `SimplePool` opens no sockets — `WebSocket` is only resolved when a
 * relay is first ensured — so tests may construct this adapter. They must not call
 * `query`/`subscribe`/`publish` on a real pool; use `FakeRelayPool` for that, or inject
 * a `PoolBackend` stub here to test the mapping.
 */
import type { Event as WireEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';
import { SimplePool } from 'nostr-tools/pool';

import type { NostrEvent, NostrFilter, RelayUrl } from '../contracts/index.js';
import { toWire } from './event.js';
import type { PoolLike, PublishResult, SubscriptionHandlers, Unsubscribe } from './types.js';

/** The subset of `AbstractSimplePool` the adapter uses. Injected so tests can stub it. */
export interface PoolBackend {
  querySync(relays: string[], filter: Filter, params?: { maxWait?: number }): Promise<WireEvent[]>;
  subscribeMap(
    requests: { url: string; filter: Filter }[],
    params: {
      onevent: (evt: WireEvent) => void;
      oneose?: () => void;
      onclose?: (reasons: { url: string; reason: string }[]) => void;
      maxWait?: number;
    },
  ): { close: (reason?: string) => void };
  publish(relays: string[], event: WireEvent): Promise<string>[];
  destroy(): void;
}

/** `NostrFilter` is readonly; `nostr-tools` wants mutable arrays. Copy, don't cast. */
export function toWireFilter(f: NostrFilter): Filter {
  const out: Filter = {};
  if (f.ids) out.ids = [...f.ids];
  if (f.authors) out.authors = [...f.authors];
  if (f.kinds) out.kinds = [...f.kinds];
  if (f.since !== undefined) out.since = f.since;
  if (f.until !== undefined) out.until = f.until;
  if (f.limit !== undefined) out.limit = f.limit;
  if (f.search !== undefined) out.search = f.search;
  for (const k of Object.keys(f)) {
    if (k.startsWith('#')) {
      const v = f[k as `#${string}`];
      if (v) out[k as `#${string}`] = [...v];
    }
  }
  return out;
}

export class SimplePoolAdapter implements PoolLike {
  readonly #backend: PoolBackend;

  constructor(backend: PoolBackend = new SimplePool()) {
    this.#backend = backend;
  }

  async query(
    relays: readonly RelayUrl[],
    filter: NostrFilter,
    opts?: { readonly maxWaitMs?: number },
  ): Promise<readonly unknown[]> {
    if (relays.length === 0) return [];
    const params = opts?.maxWaitMs === undefined ? undefined : { maxWait: opts.maxWaitMs };
    return this.#backend.querySync([...relays], toWireFilter(filter), params);
  }

  subscribe(
    relays: readonly RelayUrl[],
    filters: readonly NostrFilter[],
    handlers: SubscriptionHandlers,
    opts?: { readonly maxWaitMs?: number },
  ): Unsubscribe {
    const requests: { url: string; filter: Filter }[] = [];
    for (const url of relays)
      for (const f of filters) requests.push({ url, filter: toWireFilter(f) });
    if (requests.length === 0) {
      handlers.oneose?.();
      return () => undefined;
    }
    const sub = this.#backend.subscribeMap(requests, {
      onevent: (evt) => {
        handlers.onevent(evt);
      },
      ...(handlers.oneose ? { oneose: handlers.oneose } : {}),
      ...(handlers.onclose
        ? {
            onclose: (reasons: { url: string; reason: string }[]) => {
              handlers.onclose?.(reasons.map((r) => `${r.url}: ${r.reason}`).join('; '));
            },
          }
        : {}),
      ...(opts?.maxWaitMs === undefined ? {} : { maxWait: opts.maxWaitMs }),
    });
    return () => {
      sub.close('unsubscribed');
    };
  }

  async publish(relays: readonly RelayUrl[], event: NostrEvent): Promise<readonly PublishResult[]> {
    if (relays.length === 0) return [];
    const settled = await Promise.allSettled(this.#backend.publish([...relays], toWire(event)));
    return relays.map((url, i) => {
      const s = settled[i];
      if (s === undefined) return { url, ok: false, reason: 'no result' };
      return s.status === 'fulfilled'
        ? { url, ok: true, reason: s.value }
        : { url, ok: false, reason: describe(s.reason) };
    });
  }

  close(): void {
    this.#backend.destroy();
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'publish failed';
}
