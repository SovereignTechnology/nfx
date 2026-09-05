import type { Sats } from '@sovit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlushScheduler } from '../payment/flush-scheduler.js';
import type { FlushResult, FlushTrigger } from '../payment/flush-scheduler.js';
import { capturedLogger, honestEngine } from './helpers.js';

function fakeEngine(): {
  flush: () => Promise<FlushResult>;
  calls: number;
  resolveNext: (() => void)[];
} {
  const state = {
    calls: 0,
    resolveNext: [] as (() => void)[],
    flush: (): Promise<FlushResult> => {
      state.calls++;
      return new Promise<FlushResult>((resolve) => {
        state.resolveNext.push(() => {
          resolve({ swapped: 1 as Sats, nutzapped: 1 as Sats, failed: 0 });
        });
      });
    },
  };
  return state;
}

describe('FlushScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes every T ms', async () => {
    const engine = honestEngine();
    const s = new FlushScheduler(engine, {
      everyBlocks: 1000,
      everyMs: 500,
      logger: capturedLogger().logger,
    });
    const triggers: FlushTrigger[] = [];
    s.onFlush((_r, t) => triggers.push(t));
    s.start();
    await vi.advanceTimersByTimeAsync(499);
    expect(s.flushes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.flushes).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.flushes).toBe(3);
    expect(triggers).toEqual(['timer', 'timer', 'timer']);
    await s.stop({ flush: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.flushes).toBe(3);
  });

  it('flushes every N paid blocks and resets the timer', async () => {
    const engine = honestEngine();
    const s = new FlushScheduler(engine, {
      everyBlocks: 8,
      everyMs: 1000,
      logger: capturedLogger().logger,
    });
    const triggers: FlushTrigger[] = [];
    s.onFlush((_r, t) => triggers.push(t));
    s.start();
    await vi.advanceTimersByTimeAsync(900);
    s.notePaidBlocks(5);
    expect(s.pendingBlocks).toBe(5);
    s.notePaidBlocks(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.flushes).toBe(1);
    expect(s.pendingBlocks).toBe(0);
    // timer was re-armed at the block flush: no timer flush at t=1000
    await vi.advanceTimersByTimeAsync(150);
    expect(s.flushes).toBe(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(s.flushes).toBe(2);
    expect(triggers).toEqual(['blocks', 'timer']);
    await s.stop();
    expect(triggers.at(-1)).toBe('stop');
  });

  it('serialises concurrent flushes and coalesces extra requests', async () => {
    const engine = fakeEngine();
    const s = new FlushScheduler(engine, {
      everyBlocks: 1,
      everyMs: 60_000,
      logger: capturedLogger().logger,
    });
    const p1 = s.flush('manual');
    const p2 = s.flush('manual');
    s.notePaidBlocks(1);
    expect(engine.calls).toBe(1);
    expect(p1).toBe(p2);
    engine.resolveNext[0]!();
    await p1;
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.calls).toBe(2); // one coalesced follow-up, not three
    engine.resolveNext[1]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.flushes).toBe(2);
  });

  it('logs and survives a failing engine flush', async () => {
    const { logger, records } = capturedLogger();
    const s = new FlushScheduler(
      { flush: () => Promise.reject(new Error('mint down')) },
      { everyBlocks: 1, everyMs: 60_000, logger },
    );
    const r = await s.flush();
    expect(r.failed).toBe(-1);
    expect(records.some((x) => x.level === 'error' && x.msg === 'flush failed')).toBe(true);
  });

  it('validates configuration', () => {
    expect(
      () =>
        new FlushScheduler(honestEngine(), {
          everyBlocks: 0,
          everyMs: 1,
          logger: capturedLogger().logger,
        }),
    ).toThrow();
    expect(
      () =>
        new FlushScheduler(honestEngine(), {
          everyBlocks: 1,
          everyMs: 0,
          logger: capturedLogger().logger,
        }),
    ).toThrow();
  });
});
