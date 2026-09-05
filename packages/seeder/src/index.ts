/**
 * @sovit/seeder — Corestore + Hyperblobs seeder daemon (build-plan §2.1, §2.3, §7).
 * Issued against CONTRACTS_VERSION = 2. Public API documented in docs/lanes/L2.md.
 */
export const PACKAGE = '@sovit/seeder' as const;

// Façade
export { Seeder } from './seeder.js';
export type { SeederDeps, SeederEvent, SeederStats } from './seeder.js';
export { resolveConfig } from './config.js';
export type { ResolvedSeederConfig, SeederConfig } from './config.js';

// Blobs / CAS
export { BlobStore, DEFAULT_CORE_NAME } from './blobs/blob-store.js';
export type { PutError, PutOptions, PutResult, SeedCore } from './blobs/blob-store.js';
export { CasIndex, CAS_INDEX_FILE } from './store/cas-index.js';
export type { CasEntry } from './store/cas-index.js';
export { DiskCap } from './store/disk-cap.js';

// Network / sessions
export { PeerSession } from './net/peer-session.js';
export type { CutReason, PeerSessionInfo } from './net/peer-session.js';
export { SessionRegistry } from './net/session-registry.js';
export type { SessionEvent } from './net/session-registry.js';
export { RateLimiter, DEFAULT_RATE_LIMITS } from './net/rate-limit.js';
export type { AdmitResult, RateLimitConfig } from './net/rate-limit.js';
export { SwarmManager } from './net/swarm.js';
export type { SwarmConfig } from './net/swarm.js';
export { BanList, BAN_FILE } from './store/ban-list.js';
export type { PersistedBan } from './store/ban-list.js';

// Payment
export { FlushScheduler } from './payment/flush-scheduler.js';
export type { FlushResult, FlushTrigger } from './payment/flush-scheduler.js';
export { attachPayBridge } from './payment/pay-bridge.js';

// Logging (the only output path)
export { createLogger, silentLogger } from './log/logger.js';
export type { Logger, LogFields, LogLevel, LogRecord, LogSink } from './log/logger.js';
export { redact, redactString, REDACTED } from './log/redact.js';

// Host / CLI
export {
  renderSystemdUnit,
  sdNotify,
  installShutdownHooks,
  HARDENING_DIRECTIVES,
} from './host/systemd.js';
export type { SystemdUnitOptions } from './host/systemd.js';
export { runMelt, parseMeltArgs, MELT_USAGE } from './cli/melt.js';
export type { MeltCliDeps } from './cli/melt.js';
export {
  runDaemon,
  parseDaemonEnv,
  ENV_DATA_DIR,
  ENV_DISK_CAP,
  ENV_MAX_STREAMS,
} from './cli/daemon.js';

// Adapters
export type { SeederFs, FileStat } from './adapters/fs.js';
export type { SeederCrypto, Sha256Hasher } from './adapters/crypto.js';
export type { SeederProcess, SignalName } from './adapters/process.js';
export { nodeAdapters, nodeFs, nodeCrypto, nodeProcess } from './adapters/node/index.js';
export type { SeederAdapters } from './adapters/node/index.js';
export { toHex, fromHex } from './util/hex.js';
