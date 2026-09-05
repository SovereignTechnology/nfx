/**
 * @sovit/gateway — `@sovit/seeder` + WS bridge + Blossom HTTP + upstream paying
 * (build-plan §5). Issued against CONTRACTS_VERSION = 3. Public API in docs/lanes/L3.md.
 *
 * This module is BOTH the library entry and the daemon entry: the canonical systemd unit
 * runs `node --jitless …/dist/index.js --config /etc/nutflix/gateway.json`, so when this
 * file is the process's main module it hands `argv` to `cli/main.ts`. Importing it from
 * code has no side effects.
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { main } from './cli/main.js';

export const PACKAGE = '@sovit/gateway' as const;

// Façade
export { Gateway } from './gateway.js';
export type {
  GatewayAddress,
  GatewayDeps,
  GatewayIdentity,
  GatewayStats,
  PayProtocolFactory,
} from './gateway.js';

// Config
export {
  DEFAULT_BLOSSOM,
  DEFAULT_HTTP_LIMITS,
  DEFAULT_UPSTREAM,
  DEFAULT_WS_LIMITS,
  ENV,
  applyEnvOverrides,
  gatewayPolicy,
  gatewayPrice,
  isLoopbackHost,
  parseConfigText,
  validateConfig,
} from './config.js';
export type {
  BlossomConfig,
  ConfigResult,
  GatewayConfig,
  HttpLimits,
  ListenConfig,
  UpstreamConfig,
  WsLimits,
} from './config.js';

// Auth boundary (interface only — LOCKED until Stage 2)
export type {
  BlossomAuth,
  BlossomAuthRequest,
  BlossomAuthResult,
  BlossomVerb,
} from './auth/index.js';

// Blossom
export { BlossomHandler, sha256FromUrlPath, UPLOAD_SPOOL_DIR } from './blossom/handler.js';
export type { BlobDescriptor, BlossomHandlerOptions, MirrorFetch } from './blossom/handler.js';
export { resolveRange } from './blossom/range.js';
export type { RangeResolution } from './blossom/range.js';
export { OwnerIndex, ReportStore, OWNERS_FILE, REPORTS_FILE } from './blossom/store.js';
export type { StoredReport } from './blossom/store.js';

// WS bridge
export { WsDuplex } from './ws/ws-duplex.js';
export type { WsDuplexOptions } from './ws/ws-duplex.js';
export { WsBridge } from './ws/bridge.js';
export type { UpgradeRefusal, WsBridgeOptions } from './ws/bridge.js';

// Upstream paying
export { UpstreamPayer, helloPolicyResolver } from './upstream/payer.js';
export type {
  UpstreamPayerOptions,
  UpstreamPayerStats,
  UpstreamPolicyResolver,
} from './upstream/payer.js';

// HTTP helpers
export { readTextBody, spoolIterableToFile, spoolToFile } from './http/body.js';
export type { BodyFailure, BodyLimits, SpoolResult, TextBodyResult } from './http/body.js';

// CLI
export { main, parseCliArgs, loadConfig, EXIT_CONFIG, USAGE } from './cli/main.js';
export type { MainOptions, ParsedArgs } from './cli/main.js';
export { getRuntimeDeps, MISSING_PROVIDERS_REASON } from './cli/providers.js';
export type { RuntimeDeps } from './cli/providers.js';

/** True when `moduleUrl` is the script Node was started with (symlinks resolved). */
export function isMainModule(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
