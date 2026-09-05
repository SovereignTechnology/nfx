import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { NostrPubkey, PaymentEngineSeeder } from '@sovit/core';
import { mocks } from '@sovit/core';
import type { ReplicationStream } from 'hypercore';

import { nodeCrypto } from '../adapters/node/crypto.js';
import { nodeFs } from '../adapters/node/fs.js';
import { createLogger } from '../log/logger.js';
import type { Logger, LogRecord } from '../log/logger.js';
import { BanList } from '../store/ban-list.js';
import { fromHex } from '../util/hex.js';

export const adapters = { fs: nodeFs, crypto: nodeCrypto } as const;

export async function tmpDir(
  prefix = 'nutflix-l2-',
): Promise<{ dir: string; rm: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  // Retry: an in-flight atomic JSON write may still be landing when a test ends.
  const rmRetry = async (): Promise<void> => {
    for (let i = 0; ; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (i >= 20) throw err;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };
  return { dir, rm: rmRetry };
}

export interface CapturedLog {
  readonly logger: Logger;
  readonly lines: string[];
  readonly records: LogRecord[];
}

export function capturedLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): CapturedLog {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  const logger = createLogger({
    level,
    sink: (line, rec) => {
      lines.push(line);
      records.push(rec);
    },
  });
  return { logger, lines, records };
}

export async function loadedBanList(dir: string): Promise<BanList> {
  const b = new BanList({ ...adapters, dataDir: dir });
  await b.load();
  return b;
}

export function pubkey(seed: string): NostrPubkey {
  return mocks.asPubkey(seed);
}

export function noiseKey(seed: number): Uint8Array {
  return fromHex(seed.toString(16).padStart(2, '0').repeat(32));
}

/** A minimal stand-in for the Noise stream (`peer.stream`) — only what PeerSession touches. */
export class FakeStream implements ReplicationStream {
  remotePublicKey: Uint8Array | null;
  publicKey: Uint8Array | null = null;
  destroyed = false;
  destroyCalls = 0;
  /** Test hook: what `PeerSession.mux` reads (Hypercore sets this to the protomux). */
  userData: unknown = undefined;
  private readonly closeListeners: (() => void)[] = [];
  private readonly connectListeners: (() => void)[] = [];

  constructor(remotePublicKey: Uint8Array | null) {
    this.remotePublicKey = remotePublicKey;
  }
  get noiseStream(): ReplicationStream {
    return this;
  }
  get rawStream(): ReplicationStream {
    return this;
  }
  get opened(): Promise<boolean> {
    return Promise.resolve(true);
  }
  destroy(): void {
    this.destroyCalls++;
    if (this.destroyed) return;
    this.destroyed = true;
    // Real streams emit 'close' asynchronously; keep that shape.
    queueMicrotask(() => {
      for (const cb of this.closeListeners.splice(0)) cb();
    });
  }
  on(event: 'close' | 'connect' | 'error', cb: (...args: never[]) => void): this {
    return this.once(event, cb);
  }
  once(event: 'close' | 'connect' | 'error', cb: (...args: never[]) => void): this {
    if (event === 'close') this.closeListeners.push(cb);
    if (event === 'connect') this.connectListeners.push(cb);
    return this;
  }
  pipe<T extends { pipe: unknown }>(dest: T): T {
    return dest;
  }
  /** Test hook: simulate a completed handshake. */
  connect(remotePublicKey: Uint8Array): void {
    this.remotePublicKey = remotePublicKey;
    for (const cb of this.connectListeners.splice(0)) cb();
  }
  /** Test hook: wait for the async close. */
  closed(): Promise<void> {
    return new Promise((r) => {
      queueMicrotask(r);
    });
  }
}

export function honestEngine(windowBlocks = 4): mocks.MockPaymentEngine {
  return new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks } });
}

export type EngineLike = PaymentEngineSeeder;
