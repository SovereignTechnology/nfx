/**
 * The Nostr signaler's bookkeeping (NFX-10 §§6.5–6.6), as plain data: no network, no WASM,
 * no engine. `./signal-nostr.ts` uses it, and `unit.ts` tests it.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Bounds on what relays and other peers can make a session hold or do (NFX-10 §6.5). */
export const LIMITS = {
  /** Peers whose presence one room holds. */
  peersPerRoom: 256,
  /** Negotiations in flight in one room (one per peer at most). */
  negotiationsPerRoom: 16,
  /** Of those, offers of ours awaiting an answer, so offers never starve answering. */
  pendingOffersPerRoom: 4,
  /** An offer unanswered this long has failed (an honest answer takes ICE gathering, at most 5 s, and two relay trips). */
  answerTimeoutMs: 15_000,
  /** After an offer to a peer fails, the next waits this long, doubling per failure up to the max. */
  offerBackoffMs: 30_000,
  offerBackoffMaxMs: 600_000,
  /** Offers and answers decrypted per sender per window. */
  directedPerSender: 8,
  directedWindowMs: 30_000,
  /** Event ids remembered to take each event once. */
  seenIds: 4096,
  /** Relay messages longer than this are dropped unparsed. */
  maxMessage: 70 * 1024,
} as const;

/** Unix seconds. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The glare rule: whether `me` offers to `peer` (the lower lowercase-hex key offers). */
export function offersTo(me: string, peer: string): boolean {
  return me < peer;
}

/** What a room knows of one peer's presence. */
interface Presence {
  createdAt: number;
  /** 0 after a disconnect (a tombstone, kept until the disconnect is no longer fresh). */
  expiration: number;
}

/** How long a disconnect is kept, so a replayed older connect cannot bring its peer back. */
const TOMBSTONE_SECONDS = 60;

/**
 * Presence per sender session key (NFX-10 §6.5): the newest event by `created_at` wins, and a
 * `disconnect` wins a tie with a `connect` of the same second. At most `max` peers; a new one
 * beyond that is refused until one expires.
 */
export class PresenceBook {
  readonly #peers = new Map<string, Presence>();

  constructor(private readonly max: number = LIMITS.peersPerRoom) {}

  /** Take a connect (with its expiration) or a disconnect (`expiration` null). True if it is now the peer's newest. */
  add(peer: string, createdAt: number, expiration: number | null, now: number): boolean {
    const held = this.#peers.get(peer);
    const leaving = expiration === null;
    if (held) {
      if (createdAt < held.createdAt) return false;
      if (createdAt === held.createdAt && (!leaving || held.expiration === 0)) return false;
    } else if (this.#peers.size >= this.max) {
      this.prune(now);
      if (this.#peers.size >= this.max) return false;
    }
    this.#peers.set(peer, { createdAt, expiration: leaving ? 0 : expiration });
    return true;
  }

  /** Whether `peer` is present at `now`. */
  present(peer: string, now: number): boolean {
    const p = this.#peers.get(peer);
    return p !== undefined && p.expiration > now;
  }

  /** Forget peers whose presence ended (a disconnect once no event older than it is fresh). */
  prune(now: number): void {
    for (const [k, p] of this.#peers) {
      const until = p.expiration === 0 ? p.createdAt + TOMBSTONE_SECONDS : p.expiration;
      if (until <= now) this.#peers.delete(k);
    }
  }

  get size(): number {
    return this.#peers.size;
  }
}

/**
 * The ids of the last `max` events taken, so each is taken once whichever relays deliver it.
 * Only ids of events that verified are added: a relay that sends a forged event under a real
 * event's id must not make the real one look like a duplicate.
 */
export class SeenIds {
  readonly #ids = new Set<string>();

  constructor(private readonly max: number = LIMITS.seenIds) {}

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Remember a verified event's id. */
  add(id: string): void {
    if (this.#ids.has(id)) return;
    this.#ids.add(id);
    if (this.#ids.size > this.max) {
      const oldest = this.#ids.values().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
  }
}

/**
 * When this session may next offer to each peer: after a failed offer, `base` doubling per
 * failure up to `max`, so a peer that announces itself and never answers (or a key ground to
 * be offered to) costs one offer per backoff, not one per presence. A peer that connects is
 * forgotten. At most `maxPeers` are held; the oldest entry goes first.
 */
export class OfferBackoff {
  readonly #peers = new Map<string, { failures: number; until: number }>();

  constructor(
    private readonly base: number = LIMITS.offerBackoffMs,
    private readonly max: number = LIMITS.offerBackoffMaxMs,
    private readonly maxPeers: number = LIMITS.peersPerRoom,
  ) {}

  allowed(peer: string, nowMs: number): boolean {
    const p = this.#peers.get(peer);
    return p === undefined || nowMs >= p.until;
  }

  failed(peer: string, nowMs: number): void {
    const failures = (this.#peers.get(peer)?.failures ?? 0) + 1;
    this.#peers.delete(peer);
    if (this.#peers.size >= this.maxPeers) {
      const oldest = this.#peers.keys().next().value;
      if (oldest !== undefined) this.#peers.delete(oldest);
    }
    const wait = Math.min(this.base * 2 ** Math.min(failures - 1, 20), this.max);
    this.#peers.set(peer, { failures, until: nowMs + wait });
  }

  connected(peer: string): void {
    this.#peers.delete(peer);
  }
}

/** At most `n` events per sender per `windowMs`, for the expensive ones (decryption). */
export class SenderLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly n: number = LIMITS.directedPerSender,
    private readonly windowMs: number = LIMITS.directedWindowMs,
    private readonly maxSenders: number = LIMITS.peersPerRoom,
  ) {}

  take(sender: string, nowMs: number): boolean {
    let w = this.#windows.get(sender);
    if (w === undefined || nowMs - w.start >= this.windowMs) {
      if (w === undefined && this.#windows.size >= this.maxSenders) {
        for (const [k, v] of this.#windows) if (nowMs - v.start >= this.windowMs) this.#windows.delete(k);
        if (this.#windows.size >= this.maxSenders) return false;
      }
      w = { start: nowMs, count: 0 };
      this.#windows.set(sender, w);
    }
    if (w.count >= this.n) return false;
    w.count += 1;
    return true;
  }
}

/** The id and pubkey of an event (JSON text), if well formed, without trusting anything else. */
export function eventHead(json: string): { id: string; pubkey: string } | null {
  try {
    const { id, pubkey } = JSON.parse(json) as { id?: unknown; pubkey?: unknown };
    const hex = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
    return hex(id) && hex(pubkey) ? { id, pubkey } : null;
  } catch {
    return null;
  }
}

/** The id of an event (JSON text), if it has a well-formed one. */
export function eventId(json: string): string | null {
  try {
    const id = (JSON.parse(json) as { id?: unknown }).id;
    return typeof id === 'string' && /^[0-9a-f]{64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The UTF-8 length of `text`, counted only as far as `limit` matters. */
export function overBytes(text: string, limit: number): boolean {
  if (text.length > limit) return true; // UTF-8 never takes fewer bytes than UTF-16 code units
  if (text.length * 3 <= limit) return false; // nor more than 3 per code unit
  return new TextEncoder().encode(text).length > limit;
}
