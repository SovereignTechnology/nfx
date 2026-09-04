/**
 * `NostrClient` — the verified façade over a `PoolLike`.
 *
 * Reads: every object the pool hands back passes `verifyIncoming` before a caller sees
 * it (T9). Writes: every event is signed by the `Signer` contract; this class never sees
 * key material.
 */
import type {
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  RelayConfig,
  RelayUrl,
  Signer,
  UnixSeconds,
} from '../contracts/index.js';
import { byNewest, classifyIncoming, dedupeById, nowSeconds } from './event.js';
import type {
  DropReason,
  EventDraft,
  NostrClientOptions,
  PoolLike,
  PublishResult,
  Unsubscribe,
} from './types.js';

export class NoSignerError extends Error {
  constructor() {
    super('this NostrClient has no Signer; write paths are unavailable');
    this.name = 'NoSignerError';
  }
}

export class PublishError extends Error {
  readonly results: readonly PublishResult[];
  constructor(results: readonly PublishResult[]) {
    super(
      results.length === 0
        ? 'no write relays configured'
        : `every write relay rejected the event: ${results.map((r) => `${r.url} (${r.reason ?? '?'})`).join(', ')}`,
    );
    this.name = 'PublishError';
    this.results = results;
  }
}

export interface PublishReport {
  readonly event: NostrEvent;
  readonly results: readonly PublishResult[];
}

export class NostrClient {
  readonly pool: PoolLike;
  readonly relays: readonly RelayConfig[];
  readonly readRelays: readonly RelayUrl[];
  readonly writeRelays: readonly RelayUrl[];
  readonly now: () => UnixSeconds;
  readonly #signer: Signer | undefined;
  readonly #onDropped: ((reason: DropReason, raw: unknown) => void) | undefined;
  readonly #maxWaitMs: number | undefined;

  constructor(opts: NostrClientOptions) {
    this.pool = opts.pool;
    this.relays = opts.relays;
    this.readRelays = opts.relays.filter((r) => r.read).map((r) => r.url);
    this.writeRelays = opts.relays.filter((r) => r.write).map((r) => r.url);
    this.#signer = opts.signer;
    this.now = opts.now ?? nowSeconds;
    this.#onDropped = opts.onDropped;
    this.#maxWaitMs = opts.maxWaitMs;
  }

  get hasSigner(): boolean {
    return this.#signer !== undefined;
  }

  /** The signer, or throw. Callers that need to encrypt/sign go through here. */
  signer(): Signer {
    if (!this.#signer) throw new NoSignerError();
    return this.#signer;
  }

  /** Our pubkey, or `null` when read-only. */
  async me(): Promise<NostrPubkey | null> {
    return this.#signer ? this.#signer.getPublicKey() : null;
  }

  /** The verification boundary for a batch of raw objects. Drops are reported, never returned. */
  verifyAll(raws: readonly unknown[]): NostrEvent[] {
    const out: NostrEvent[] = [];
    for (const raw of raws) {
      const c = classifyIncoming(raw);
      if (c.event) out.push(c.event);
      else this.#onDropped?.(c.reason, raw);
    }
    return out;
  }

  /** Verified, deduped, newest-first results for one filter from the read relays. */
  async query(
    filter: NostrFilter,
    relays: readonly RelayUrl[] = this.readRelays,
  ): Promise<NostrEvent[]> {
    const raws = await this.pool.query(
      relays,
      filter,
      this.#maxWaitMs === undefined ? undefined : { maxWaitMs: this.#maxWaitMs },
    );
    return dedupeById(this.verifyAll(raws)).sort(byNewest);
  }

  /** Union of several filters (issued sequentially per filter; relays are the same). */
  async queryMany(
    filters: readonly NostrFilter[],
    relays: readonly RelayUrl[] = this.readRelays,
  ): Promise<NostrEvent[]> {
    const all: NostrEvent[] = [];
    for (const f of filters) all.push(...(await this.query(f, relays)));
    return dedupeById(all).sort(byNewest);
  }

  /** Newest single event for a filter (`limit: 1` is added). */
  async queryOne(filter: NostrFilter, relays?: readonly RelayUrl[]): Promise<NostrEvent | null> {
    const evs = await this.query({ ...filter, limit: filter.limit ?? 1 }, relays);
    return evs[0] ?? null;
  }

  /** Live subscription. `onEvent` only ever receives verified events. */
  subscribe(
    filters: readonly NostrFilter[],
    onEvent: (ev: NostrEvent) => void,
    opts: { readonly relays?: readonly RelayUrl[]; readonly onEose?: () => void } = {},
  ): Unsubscribe {
    const seen = new Set<string>();
    return this.pool.subscribe(
      opts.relays ?? this.readRelays,
      filters,
      {
        onevent: (raw) => {
          const c = classifyIncoming(raw);
          if (!c.event) {
            this.#onDropped?.(c.reason, raw);
            return;
          }
          if (seen.has(c.event.id)) return;
          seen.add(c.event.id);
          onEvent(c.event);
        },
        ...(opts.onEose ? { oneose: opts.onEose } : {}),
      },
      this.#maxWaitMs === undefined ? undefined : { maxWaitMs: this.#maxWaitMs },
    );
  }

  /** Sign via the `Signer` contract and publish to the write relays. */
  async publish(
    draft: EventDraft,
    relays: readonly RelayUrl[] = this.writeRelays,
  ): Promise<PublishReport> {
    const signer = this.signer();
    const event = await signer.signEvent(draft);
    const results = await this.pool.publish(relays, event);
    if (results.length === 0 || !results.some((r) => r.ok)) throw new PublishError(results);
    return { event, results };
  }
}
