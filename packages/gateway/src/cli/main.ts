/**
 * Entry point behind the canonical unit's
 *   `ExecStart=/usr/bin/node --jitless /opt/nutflix/packages/gateway/dist/index.js --config /etc/nutflix/gateway.json`
 * (deploy/systemd/nutflix-gateway.service, `Type=simple`).
 *
 *   --config <path>   JSON config (`config.ts`); `NUTFLIX_GATEWAY_CONFIG` is the fallback
 *   --dev-mocks       run on `@sovit/core` mocks (development only, see cli/dev-mocks.ts)
 *   --check           validate the config and exit 0/78 without starting anything
 *
 * Exit codes: 0 clean, 1 runtime failure, 78 (EX_CONFIG) bad/missing config or providers.
 * Every line of output goes through `@sovit/seeder`'s redacting logger to stdout (journald
 * under systemd). SIGTERM/SIGINT/SIGHUP → one graceful `Gateway.close()` (seeder shutdown
 * hooks); `sdNotify` is a no-op without `NOTIFY_SOCKET` and harmless under `Type=simple`.
 *
 * TLS is never terminated here — a reverse proxy in front does that (unit header). The
 * gateway reads `X-Forwarded-For` only when `http.trustProxy` is true.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import type { Logger, SeederProcess } from '@sovit/seeder';
import { createLogger, installShutdownHooks, nodeProcess, sdNotify } from '@sovit/seeder';

import type { ConfigResult, GatewayConfig } from '../config.js';
import { ENV, isLoopbackHost, parseConfigText } from '../config.js';
import { Gateway } from '../gateway.js';
import type { RuntimeDeps } from './providers.js';
import { MISSING_PROVIDERS_REASON, getRuntimeDeps } from './providers.js';

export const EXIT_CONFIG = 78;

export interface MainOptions {
  readonly proc?: SeederProcess;
  readonly readFile?: (path: string) => Promise<string>;
  /** Test seam: replaces `getRuntimeDeps`. */
  readonly providers?: (config: GatewayConfig) => RuntimeDeps | undefined;
  /** Test seam: replaces the `--dev-mocks` loader. */
  readonly devMocks?: (config: GatewayConfig) => Promise<RuntimeDeps>;
  /** Called with the running gateway (tests keep a handle to close it). */
  readonly onStarted?: (gw: Gateway) => void;
}

export interface ParsedArgs {
  readonly config: string | undefined;
  readonly devMocks: boolean;
  readonly check: boolean;
  readonly help: boolean;
}

export const USAGE =
  'usage: nutflix-gateway --config <gateway.json> [--check] [--dev-mocks]\n' +
  `  env: ${ENV.configPath}, ${ENV.listenHost}, ${ENV.listenPort}, ${ENV.dataDir}, ${ENV.diskCapBytes}, ${ENV.logLevel}, ${ENV.publicUrl}, STATE_DIRECTORY`;

export function parseCliArgs(argv: readonly string[]): ParsedArgs | { readonly error: string } {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        config: { type: 'string' },
        'dev-mocks': { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      config: values.config,
      devMocks: values['dev-mocks'],
      check: values.check,
      help: values.help,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid arguments' };
  }
}

export async function loadConfig(
  path: string,
  proc: Pick<SeederProcess, 'env'>,
  read: (p: string) => Promise<string>,
): Promise<ConfigResult> {
  let text: string;
  try {
    text = await read(path);
  } catch {
    return { ok: false, errors: ['$: config file could not be read'] };
  }
  return parseConfigText(text, (n) => proc.env(n));
}

/** Run the daemon. Resolves with the exit code when it exits WITHOUT starting; otherwise never (signals exit). */
export async function main(argv: readonly string[], o: MainOptions = {}): Promise<number> {
  const proc = o.proc ?? nodeProcess;
  const read = o.readFile ?? ((p: string) => readFile(p, 'utf8'));
  const bootLog: Logger = createLogger({
    sink: (line) => {
      proc.writeStdout(line);
    },
    level: 'info',
    bindings: { component: 'gateway-cli' },
  });

  const args = parseCliArgs(argv);
  if ('error' in args) {
    bootLog.error('bad arguments', { error: args.error });
    proc.writeStdout(USAGE);
    return EXIT_CONFIG;
  }
  if (args.help) {
    proc.writeStdout(USAGE);
    return 0;
  }
  const configPath = args.config ?? proc.env(ENV.configPath);
  if (configPath === undefined) {
    bootLog.error('no config: pass --config <path> or set ' + ENV.configPath);
    return EXIT_CONFIG;
  }
  const loaded = await loadConfig(configPath, proc, read);
  if (!loaded.ok) {
    // Errors name paths and expected shapes only — never values (config.ts).
    bootLog.error('invalid config — refusing to start', { errors: loaded.errors });
    return EXIT_CONFIG;
  }
  const config = loaded.config;
  if (args.check) {
    bootLog.info('config ok', { dataDir: config.dataDir, listen: config.listen });
    return 0;
  }

  const logger = createLogger({
    sink: (line) => {
      proc.writeStdout(line);
    },
    level: config.logLevel,
  });

  let deps: RuntimeDeps | undefined;
  if (args.devMocks) {
    // The mocks accept worthless proofs and every token: they may only ever face this box.
    if (!isLoopbackHost(config.listen.host)) {
      logger.error('refusing to start', {
        reason: 'dev-mocks-requires-loopback',
        host: config.listen.host,
      });
      return EXIT_CONFIG;
    }
    logger.warn(
      'DEV MOCKS ENABLED: MockPaymentEngine + accept-all BlossomAuth + no-op pay/1 — never expose this listener',
    );
    deps = await (o.devMocks ?? (async (c) => (await import('./dev-mocks.js')).devMockDeps(c)))(
      config,
    );
  } else {
    deps = (o.providers ?? getRuntimeDeps)(config);
  }
  if (deps === undefined) {
    logger.error('refusing to start', { reason: MISSING_PROVIDERS_REASON });
    return EXIT_CONFIG;
  }

  let gw: Gateway;
  try {
    gw = await Gateway.create(config, { ...deps, logger });
    const addr = await gw.listen();
    logger.info('gateway up', { host: addr.host, port: addr.port, devMocks: args.devMocks });
  } catch (err) {
    logger.error('gateway failed to start', { error: err });
    return 1;
  }
  installShutdownHooks({ proc, logger, close: () => gw.close() });
  await sdNotify(proc, 'READY=1', logger);
  o.onStarted?.(gw);
  return new Promise<number>(() => undefined);
}
