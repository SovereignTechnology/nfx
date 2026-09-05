/**
 * Per-key rate limits + global stream cap (build-plan §7, threat T11).
 *
 * Two independent controls, both keyed by an opaque string (the seeder uses the Noise key
 * hex at connection time and the Nostr pubkey once `HELLO` binds one):
 *
 *   - concurrent streams per key (`maxStreamsPerKey`) and globally (`maxStreams`)
 *   - connection attempts per key in a sliding window (`connectsPerWindow` / `windowMs`)
 *
 * Exceeding either REFUSES the new connection (destroy, no ban). Bans are a payment
 * decision and live in the ban list, not here. Clock is injectable for tests.
 */
export interface RateLimitConfig {
  /** Global cap on concurrent replication streams. */
  readonly maxStreams: number;
  /** Concurrent streams a single key may hold. */
  readonly maxStreamsPerKey: number;
  /** Connection attempts allowed per key per `windowMs`. */
  readonly connectsPerWindow: number;
  readonly windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  maxStreams: 64,
  maxStreamsPerKey: 2,
  connectsPerWindow: 10,
  windowMs: 60_000,
};

export type AdmitResult =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: 'global-cap' | 'per-key-cap' | 'connect-rate' };

export class RateLimiter {
  private readonly active = new Map<string, number>();
  private readonly attempts = new Map<string, number[]>();
  private total = 0;

  constructor(
    readonly config: RateLimitConfig = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get activeStreams(): number {
    return this.total;
  }

  activeFor(key: string): number {
    return this.active.get(key) ?? 0;
  }

  /**
   * Try to admit a new stream for `key`. On success the caller MUST call `release()` when
   * the stream closes. Order of checks: global cap → per-key cap → connect rate.
   */
  admit(key: string): AdmitResult {
    if (this.total >= this.config.maxStreams) return { ok: false, reason: 'global-cap' };
    const cur = this.active.get(key) ?? 0;
    if (cur >= this.config.maxStreamsPerKey) return { ok: false, reason: 'per-key-cap' };
    if (!this.recordAttempt(key)) return { ok: false, reason: 'connect-rate' };

    this.active.set(key, cur + 1);
    this.total++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const n = (this.active.get(key) ?? 1) - 1;
        if (n <= 0) this.active.delete(key);
        else this.active.set(key, n);
        this.total--;
      },
    };
  }

  /** Sliding-window attempt counter. Returns false when the window is exhausted. */
  private recordAttempt(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.config.windowMs;
    const list = (this.attempts.get(key) ?? []).filter((x) => x > cutoff);
    if (list.length >= this.config.connectsPerWindow) {
      this.attempts.set(key, list);
      return false;
    }
    list.push(t);
    this.attempts.set(key, list);
    return true;
  }

  /** Drop attempt history older than the window (call occasionally; memory hygiene). */
  prune(): void {
    const cutoff = this.now() - this.config.windowMs;
    for (const [k, list] of this.attempts) {
      const kept = list.filter((x) => x > cutoff);
      if (kept.length === 0) this.attempts.delete(k);
      else this.attempts.set(k, kept);
    }
  }
}
