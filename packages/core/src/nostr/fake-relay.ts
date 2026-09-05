/**
 * In-memory `PoolLike` for tests and for shells that want an offline mode.
 *
 * Behaves like a well-mannered relay: NIP-01 filter matching (via `nostr-tools`
 * `matchFilter`), replaceable/addressable-event semantics, live subscriptions, `limit`
 * applied newest-first, and a naive NIP-50 `search` over content + `title` tags.
 *
 * It also behaves like a MALICIOUS relay on request: `inject(raw)` stores any object
 * verbatim (tampered, unsigned, malformed) so tests can prove the read paths drop it.
 * Never opens a socket.
 */
import { matchFilter } from 'nostr-tools/filter';

import type { NostrEvent, NostrFilter, RelayUrl } from '../contracts/index.js';
import { byNewest, tagValue, toWire } from './event.js';
import { toWireFilter } from './simple-pool-adapter.js';
import type { PoolLike, PublishResult, SubscriptionHandlers, Unsubscribe } from './types.js';

interface Stored {
  readonly raw: unknown;
  /** Present when the object is a structurally sane event we can index. */
  readonly ev: NostrEvent | null;
}

interface LiveSub {
  readonly filters: readonly NostrFilter[];
  readonly handlers: SubscriptionHandlers;
}

export interface FakeRelayPoolOptions {
  /** Return a reason string to reject a publish (simulates `["OK", id, false, reason]`). */
  readonly rejectPublish?: (event: NostrEvent, url: RelayUrl) => string | null;
}

export class FakeRelayPool implements PoolLike {
  #store: Stored[] = [];
  readonly #subs = new Set<LiveSub>();
  readonly #opts: FakeRelayPoolOptions;
  /** Every query issued, for asserting relay selection and filter shape. */
  readonly queries: { readonly relays: readonly RelayUrl[]; readonly filter: NostrFilter }[] = [];
  /** Every publish issued. */
  readonly published: { readonly relays: readonly RelayUrl[]; readonly event: NostrEvent }[] = [];
  closed = false;

  constructor(opts: FakeRelayPoolOptions = {}) {
    this.#opts = opts;
  }

  /** Store a well-formed event with relay semantics (replaceable kinds replace). */
  store(ev: NostrEvent): void {
    const key = replaceableKey(ev);
    if (key !== null) {
      const existing = this.#store.find((s) => s.ev && replaceableKey(s.ev) === key);
      if (existing?.ev && byNewest(existing.ev, ev) <= 0) return; // existing is newer or same
      this.#store = this.#store.filter((s) => s !== existing);
    }
    this.#store.push({ raw: ev, ev });
    this.#deliver(ev);
  }

  /** Store ANYTHING verbatim — the malicious-relay path. Bypasses all semantics. */
  inject(raw: unknown): void {
    this.#store.push({ raw, ev: null });
    for (const s of this.#subs) s.handlers.onevent(raw);
  }

  /** Verified, indexable events currently stored (not injected junk). */
  events(): readonly NostrEvent[] {
    return this.#store.flatMap((s) => (s.ev ? [s.ev] : []));
  }

  clear(): void {
    this.#store = [];
  }

  query(relays: readonly RelayUrl[], filter: NostrFilter): Promise<readonly unknown[]> {
    this.queries.push({ relays, filter });
    if (relays.length === 0) return Promise.resolve([]);
    return Promise.resolve(this.#match(filter));
  }

  subscribe(
    relays: readonly RelayUrl[],
    filters: readonly NostrFilter[],
    handlers: SubscriptionHandlers,
  ): Unsubscribe {
    if (relays.length === 0 || filters.length === 0) {
      handlers.oneose?.();
      return () => undefined;
    }
    const sub: LiveSub = { filters, handlers };
    this.#subs.add(sub);
    for (const f of filters) for (const raw of this.#match(f)) handlers.onevent(raw);
    handlers.oneose?.();
    return () => {
      this.#subs.delete(sub);
    };
  }

  publish(relays: readonly RelayUrl[], event: NostrEvent): Promise<readonly PublishResult[]> {
    this.published.push({ relays, event });
    const results: PublishResult[] = relays.map((url) => {
      const reason = this.#opts.rejectPublish?.(event, url) ?? null;
      return reason === null ? { url, ok: true } : { url, ok: false, reason };
    });
    if (results.some((r) => r.ok)) this.store(event);
    return Promise.resolve(results);
  }

  close(): void {
    this.closed = true;
    this.#subs.clear();
  }

  #match(filter: NostrFilter): unknown[] {
    const wire = toWireFilter(filter);
    const search = filter.search?.trim().toLowerCase();
    const hits: Stored[] = [];
    for (const s of this.#store) {
      if (!s.ev) {
        // Injected junk: hand it back only when the filter would plausibly match its
        // claimed fields, so a tamper test looks like a real relay answering a real query.
        if (claimsMatch(s.raw, wire)) hits.push(s);
        continue;
      }
      if (!matchFilter(wire, toWire(s.ev))) continue;
      if (search !== undefined && search !== '' && !textMatches(s.ev, search)) continue;
      hits.push(s);
    }
    hits.sort((a, b) => claimedAt(b) - claimedAt(a) || (a.ev && b.ev ? byNewest(a.ev, b.ev) : 0));
    const limited = filter.limit === undefined ? hits : hits.slice(0, Math.max(0, filter.limit));
    return limited.map((s) => s.raw);
  }

  #deliver(ev: NostrEvent): void {
    const wire = toWire(ev);
    for (const s of this.#subs) {
      if (s.filters.some((f) => matchFilter(toWireFilter(f), wire))) s.handlers.onevent(ev);
    }
  }
}

function textMatches(ev: NostrEvent, needle: string): boolean {
  if (ev.content.toLowerCase().includes(needle)) return true;
  const title = tagValue(ev, 'title');
  return title?.toLowerCase().includes(needle) ?? false;
}

/** Replaceable (kind 0, 3, 10000–19999) → kind:pubkey; addressable (30000–39999) → +d. */
function replaceableKey(ev: NostrEvent): string | null {
  const k = ev.kind;
  if (k === 0 || k === 3 || (k >= 10_000 && k < 20_000)) return `${k}:${ev.pubkey}`;
  if (k >= 30_000 && k < 40_000) return `${k}:${ev.pubkey}:${tagValue(ev, 'd') ?? ''}`;
  return null;
}

/** `created_at` as claimed by a stored object (junk included), for relay-like ordering. */
function claimedAt(s: Stored): number {
  if (s.ev) return s.ev.created_at;
  const r = s.raw as { created_at?: unknown } | null;
  return typeof r?.created_at === 'number' ? r.created_at : 0;
}

/** Best-effort filter match against an untrusted object's claimed fields. */
function claimsMatch(raw: unknown, filter: ReturnType<typeof toWireFilter>): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (filter.kinds && !(typeof r['kind'] === 'number' && filter.kinds.includes(r['kind']))) {
    return false;
  }
  if (filter.ids && !(typeof r['id'] === 'string' && filter.ids.includes(r['id']))) return false;
  if (
    filter.authors &&
    !(typeof r['pubkey'] === 'string' && filter.authors.includes(r['pubkey']))
  ) {
    return false;
  }
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue;
    const wanted = filter[key as `#${string}`];
    if (!wanted) continue;
    const name = key.slice(1);
    const tags = r['tags'];
    if (!Array.isArray(tags)) return false;
    const ok = tags.some(
      (t: unknown) =>
        Array.isArray(t) && t[0] === name && typeof t[1] === 'string' && wanted.includes(t[1]),
    );
    if (!ok) return false;
  }
  return true;
}
