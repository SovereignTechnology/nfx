/**
 * Batch swap / nutzap scheduler: calls `PaymentEngineSeeder.flush()` every
 * `everyBlocks` paid blocks OR every `everyMs`, whichever comes first (build-plan §2.3
 * "swaps at mint asynchronously in batches"; contract `PaymentEngineConfig.flushEvery*`).
 *
 * Flushes are serialised — a flush requested while one is running is coalesced into one
 * follow-up flush. Timer functions are the globals (`setTimeout`/`clearTimeout`, present on
 * Bare and Node) so vitest fake timers drive the tests.
 */
import type { PaymentEngineSeeder } from '@sovit/core';

import type { Logger } from '../log/logger.js';

export interface FlushSchedulerOptions {
  readonly everyBlocks: number;
  readonly everyMs: number;
  readonly logger: Logger;
}

export type FlushResult = Awaited<ReturnType<PaymentEngineSeeder['flush']>>;

export class FlushScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private blocksSinceFlush = 0;
  private running: Promise<FlushResult> | null = null;
  private pendingAgain = false;
  private started = false;
  private readonly listeners = new Set<(r: FlushResult, trigger: FlushTrigger) => void>();
  private readonly log: Logger;
  flushes = 0;

  constructor(
    private readonly engine: Pick<PaymentEngineSeeder, 'flush'>,
    readonly options: FlushSchedulerOptions,
  ) {
    if (!(options.everyBlocks > 0)) throw new Error('everyBlocks must be > 0');
    if (!(options.everyMs > 0)) throw new Error('everyMs must be > 0');
    this.log = options.logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.arm();
  }

  async stop(opts: { readonly flush?: boolean } = {}): Promise<void> {
    this.started = false;
    this.disarm();
    if (opts.flush ?? true) await this.flush('stop');
    else if (this.running) await this.running;
  }

  onFlush(cb: (r: FlushResult, trigger: FlushTrigger) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Called with the block count of every accepted `PAY`. */
  notePaidBlocks(blocks: number): void {
    if (blocks <= 0) return;
    this.blocksSinceFlush += blocks;
    if (this.blocksSinceFlush >= this.options.everyBlocks) void this.flush('blocks');
  }

  get pendingBlocks(): number {
    return this.blocksSinceFlush;
  }

  /** Flush now (serialised). Safe to call any time. */
  flush(trigger: FlushTrigger = 'manual'): Promise<FlushResult> {
    if (this.running) {
      this.pendingAgain = true;
      return this.running;
    }
    this.blocksSinceFlush = 0;
    this.disarm();
    this.running = this.engine
      .flush()
      .then((r) => {
        this.flushes++;
        this.log.info('flush', { trigger, ...r });
        for (const cb of this.listeners) cb(r, trigger);
        return r;
      })
      .catch((err: unknown) => {
        this.log.error('flush failed', { trigger, error: err });
        return { swapped: 0, nutzapped: 0, failed: -1 } as FlushResult;
      })
      .finally(() => {
        this.running = null;
        if (this.started) this.arm();
        if (this.pendingAgain) {
          this.pendingAgain = false;
          void this.flush('coalesced');
        }
      });
    return this.running;
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush('timer');
    }, this.options.everyMs);
  }

  private disarm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export type FlushTrigger = 'blocks' | 'timer' | 'manual' | 'stop' | 'coalesced';
