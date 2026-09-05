import { DEFAULT_BLOCK_SIZE } from '@sovit/core';
import type { PricePolicy } from '@sovit/core';

import type { RateLimitConfig } from './net/rate-limit.js';
import { DEFAULT_RATE_LIMITS } from './net/rate-limit.js';
import type { SwarmConfig } from './net/swarm.js';

export interface SeederConfig {
  /** Ban list, CAS index and (by default) the Corestore live here. */
  readonly dataDir: string;
  /** Corestore directory. Default `<dataDir>/corestore`. */
  readonly storageDir?: string;
  /** Hyperblobs block size. Default 64 KiB (assumption A9, manifest.ts). */
  readonly blockSize?: number;
  /** Payload-byte cap for stored blobs (see DiskCap). */
  readonly diskCapBytes: number;
  readonly rateLimits?: Partial<RateLimitConfig>;
  /** `null`/absent = no swarm (direct replication streams only, e.g. gateway WS bridge). */
  readonly swarm?: SwarmConfig | null;
  /**
   * Price policy `PAY` messages are verified against. One per seeder for now — see
   * docs/lanes/L2.md ("PAY has no core key").
   */
  readonly policy?: PricePolicy;
  /** Swap batch triggers; default from the engine's `config` when it has one, else 64 / 60 s. */
  readonly flushEveryBlocks?: number;
  readonly flushEveryMs?: number;
}

export interface ResolvedSeederConfig {
  readonly dataDir: string;
  readonly storageDir: string;
  readonly blockSize: number;
  readonly diskCapBytes: number;
  readonly rateLimits: RateLimitConfig;
  readonly swarm: SwarmConfig | null;
  readonly policy: PricePolicy | null;
  readonly flushEveryBlocks: number;
  readonly flushEveryMs: number;
}

export function resolveConfig(
  c: SeederConfig,
  join: (...p: string[]) => string,
  engineDefaults?: { readonly flushEveryBlocks: number; readonly flushEveryMs: number },
): ResolvedSeederConfig {
  return {
    dataDir: c.dataDir,
    storageDir: c.storageDir ?? join(c.dataDir, 'corestore'),
    blockSize: c.blockSize ?? DEFAULT_BLOCK_SIZE,
    diskCapBytes: c.diskCapBytes,
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...c.rateLimits },
    swarm: c.swarm ?? null,
    policy: c.policy ?? null,
    flushEveryBlocks: c.flushEveryBlocks ?? engineDefaults?.flushEveryBlocks ?? 64,
    flushEveryMs: c.flushEveryMs ?? engineDefaults?.flushEveryMs ?? 60_000,
  };
}
