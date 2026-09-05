/**
 * Daemon runner: create + start a Seeder, install signal hooks, tell systemd we are READY.
 *
 * There is no self-executing `main()` here on purpose: a real `PaymentEngineSeeder`
 * arrives in Stage 2 (`core/src/payment/`, locked) and the shell that owns it (L6 desktop
 * worker, or the gateway/service entry) calls `runDaemon()` with it. Config comes from
 * `parseDaemonEnv()` so the systemd unit only needs environment assignments.
 */
import type { SeederProcess } from '../adapters/process.js';
import type { SeederConfig } from '../config.js';
import { installShutdownHooks, sdNotify } from '../host/systemd.js';
import type { Logger } from '../log/logger.js';
import { Seeder } from '../seeder.js';
import type { SeederDeps } from '../seeder.js';

export const ENV_DATA_DIR = 'NUTFLIX_SEEDER_DATA_DIR' as const;
export const ENV_DISK_CAP = 'NUTFLIX_SEEDER_DISK_CAP_BYTES' as const;
export const ENV_MAX_STREAMS = 'NUTFLIX_SEEDER_MAX_STREAMS' as const;

export type DaemonEnv =
  | { readonly ok: true; readonly config: SeederConfig }
  | { readonly ok: false; readonly error: string };

export function parseDaemonEnv(proc: Pick<SeederProcess, 'env'>): DaemonEnv {
  const dataDir = proc.env(ENV_DATA_DIR);
  if (dataDir === undefined || dataDir === '')
    return { ok: false, error: `${ENV_DATA_DIR} is required` };
  const capRaw = proc.env(ENV_DISK_CAP);
  const cap = capRaw === undefined ? 50 * 1024 ** 3 : Number(capRaw);
  if (!Number.isFinite(cap) || cap < 0)
    return { ok: false, error: `${ENV_DISK_CAP} must be a byte count` };
  const maxRaw = proc.env(ENV_MAX_STREAMS);
  const maxStreams = maxRaw === undefined ? undefined : Number(maxRaw);
  if (maxStreams !== undefined && !(Number.isInteger(maxStreams) && maxStreams > 0))
    return { ok: false, error: `${ENV_MAX_STREAMS} must be a positive integer` };
  return {
    ok: true,
    config: {
      dataDir,
      diskCapBytes: cap,
      swarm: {},
      ...(maxStreams !== undefined ? { rateLimits: { maxStreams } } : {}),
    },
  };
}

export interface RunDaemonOptions {
  readonly config: SeederConfig;
  readonly deps: SeederDeps;
  readonly proc: SeederProcess;
  readonly logger: Logger;
  /** Cores to open on boot (default: the `blobs` core). */
  readonly cores?: readonly string[];
}

/** Resolves with the running seeder; the process exits through the signal hooks. */
export async function runDaemon(o: RunDaemonOptions): Promise<Seeder> {
  const seeder = await Seeder.create(o.config, { ...o.deps, logger: o.logger });
  for (const name of o.cores ?? ['blobs']) await seeder.openCore(name);
  seeder.start();
  installShutdownHooks({ proc: o.proc, logger: o.logger, close: () => seeder.close() });
  await sdNotify(o.proc, 'READY=1', o.logger);
  o.logger.info('daemon ready', { ...seeder.stats() });
  return seeder;
}
