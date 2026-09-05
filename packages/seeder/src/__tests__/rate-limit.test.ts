import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../net/rate-limit.js';

describe('RateLimiter', () => {
  it('enforces the global stream cap', () => {
    const rl = new RateLimiter({
      maxStreams: 2,
      maxStreamsPerKey: 5,
      connectsPerWindow: 100,
      windowMs: 1000,
    });
    const a = rl.admit('a');
    const b = rl.admit('b');
    expect(a.ok && b.ok).toBe(true);
    const c = rl.admit('c');
    expect(c).toEqual({ ok: false, reason: 'global-cap' });
    if (a.ok) a.release();
    expect(rl.admit('c').ok).toBe(true);
    expect(rl.activeStreams).toBe(2);
  });

  it('enforces the per-key concurrent cap', () => {
    const rl = new RateLimiter({
      maxStreams: 10,
      maxStreamsPerKey: 1,
      connectsPerWindow: 100,
      windowMs: 1000,
    });
    const a1 = rl.admit('a');
    expect(a1.ok).toBe(true);
    expect(rl.admit('a')).toEqual({ ok: false, reason: 'per-key-cap' });
    expect(rl.admit('b').ok).toBe(true);
    if (a1.ok) {
      a1.release();
      a1.release(); // idempotent
    }
    expect(rl.activeFor('a')).toBe(0);
    expect(rl.admit('a').ok).toBe(true);
  });

  it('enforces the per-key connect rate over a sliding window', () => {
    let t = 0;
    const rl = new RateLimiter(
      { maxStreams: 100, maxStreamsPerKey: 100, connectsPerWindow: 3, windowMs: 1000 },
      () => t,
    );
    for (let i = 0; i < 3; i++) {
      const r = rl.admit('k');
      expect(r.ok).toBe(true);
      if (r.ok) r.release();
    }
    expect(rl.admit('k')).toEqual({ ok: false, reason: 'connect-rate' });
    expect(rl.admit('other').ok).toBe(true);
    t = 1001;
    expect(rl.admit('k').ok).toBe(true);
    rl.prune();
    expect(rl.admit('k').ok).toBe(true);
  });
});
