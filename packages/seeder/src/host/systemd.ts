/**
 * systemd integration (build-plan §7 "Host and supply-chain hardening").
 *
 *   - `renderSystemdUnit()` produces the hardened unit for the seeder daemon.
 *   - `sdNotify()` sends READY/STOPPING/STATUS to systemd via the `systemd-notify` binary
 *     (Node's `dgram` cannot speak AF_UNIX, and no native module is allowed — S-A rules).
 *   - `installShutdownHooks()` turns SIGTERM/SIGINT/SIGHUP into one graceful `close()`.
 *
 * `MemoryDenyWriteExecute` is deliberately left OFF. §7 says "test against the JS engine's
 * JIT": tested 2026-09-04 with `systemd-run --user -p MemoryDenyWriteExecute=yes node …`
 * on Node 22.22.0 — V8 aborts at startup (`Check failed: 12 == errno`, ENOMEM on the JIT
 * mapping); `node --jitless` survives. Operators who want it can add the directive AND
 * `--jitless` to ExecStart at a throughput cost. Details in docs/lanes/L2.md.
 */
import type { SeederProcess, SignalName } from '../adapters/process.js';
import type { Logger } from '../log/logger.js';

export interface SystemdUnitOptions {
  /** Dedicated unprivileged user/group the daemon runs as. */
  readonly user: string;
  readonly group?: string;
  /** Absolute command line of the shell-supplied entry that calls `runDaemon()`. */
  readonly execStart: string;
  /** Data dir (Corestore, ban list, CAS index); becomes the only writable path. */
  readonly dataDir: string;
  readonly workingDirectory?: string;
  readonly description?: string;
  /** Environment assignments (never secrets — keys come from the passphrase-encrypted file). */
  readonly environment?: Readonly<Record<string, string>>;
}

export const HARDENING_DIRECTIVES: readonly string[] = [
  'NoNewPrivileges=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectKernelLogs=yes',
  'ProtectControlGroups=yes',
  'ProtectClock=yes',
  'ProtectHostname=yes',
  'ProtectProc=invisible',
  'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
  'RestrictNamespaces=yes',
  'RestrictRealtime=yes',
  'RestrictSUIDSGID=yes',
  'LockPersonality=yes',
  'SystemCallArchitectures=native',
  'SystemCallFilter=@system-service',
  'SystemCallFilter=~@privileged @resources',
  'CapabilityBoundingSet=',
  'AmbientCapabilities=',
  'UMask=0077',
  // MemoryDenyWriteExecute=yes  -- breaks V8's JIT; see module comment.
];

export function renderSystemdUnit(o: SystemdUnitOptions): string {
  const env = Object.entries(o.environment ?? {}).map(
    ([k, v]) => `Environment=${k}=${v.replace(/"/g, '\\"')}`,
  );
  return [
    '[Unit]',
    `Description=${o.description ?? 'Nutflix seeder (@sovit/seeder)'}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=notify',
    'NotifyAccess=all',
    `User=${o.user}`,
    `Group=${o.group ?? o.user}`,
    `WorkingDirectory=${o.workingDirectory ?? o.dataDir}`,
    `ExecStart=${o.execStart}`,
    `Environment=NUTFLIX_SEEDER_DATA_DIR=${o.dataDir}`,
    ...env,
    'Restart=on-failure',
    'RestartSec=5s',
    'TimeoutStopSec=30s',
    'KillSignal=SIGTERM',
    `ReadWritePaths=${o.dataDir}`,
    ...HARDENING_DIRECTIVES,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export type SdState = 'READY=1' | 'STOPPING=1' | `STATUS=${string}` | 'WATCHDOG=1';

/** No-op unless `NOTIFY_SOCKET` is set (i.e. we were started by systemd with Type=notify). */
export async function sdNotify(
  proc: SeederProcess,
  state: SdState,
  log?: Logger,
): Promise<boolean> {
  if (proc.env('NOTIFY_SOCKET') === undefined) return false;
  try {
    const args = state.startsWith('STATUS=')
      ? [`--status=${state.slice('STATUS='.length)}`]
      : state === 'READY=1'
        ? ['--ready']
        : [state];
    const r = await proc.run('systemd-notify', args);
    if (r.code !== 0) log?.warn('systemd-notify failed', { state, code: r.code });
    return r.code === 0;
  } catch (err) {
    log?.warn('systemd-notify unavailable', { state, error: err });
    return false;
  }
}

export interface ShutdownHooksOptions {
  readonly proc: SeederProcess;
  readonly logger: Logger;
  /** Graceful close. Called at most once. */
  readonly close: () => Promise<void>;
  /** Hard timeout for `close()`; exit 1 when exceeded. Default 25 s (under TimeoutStopSec). */
  readonly timeoutMs?: number;
  readonly signals?: readonly SignalName[];
}

/** Returns a function that removes the hooks (tests). */
export function installShutdownHooks(o: ShutdownHooksOptions): () => void {
  const signals = o.signals ?? ['SIGTERM', 'SIGINT', 'SIGHUP'];
  let closing = false;
  const offs: (() => void)[] = [];

  const onSignal = (signal: SignalName): void => {
    if (closing) {
      o.logger.warn('shutdown already in progress', { signal });
      return;
    }
    closing = true;
    o.logger.info('shutdown requested', { signal });
    void sdNotify(o.proc, 'STOPPING=1', o.logger);
    const timer = setTimeout(() => {
      o.logger.error('graceful close timed out — exiting hard');
      o.proc.exit(1);
    }, o.timeoutMs ?? 25_000);
    o.close().then(
      () => {
        clearTimeout(timer);
        o.logger.info('closed cleanly');
        o.proc.exit(0);
      },
      (err: unknown) => {
        clearTimeout(timer);
        o.logger.error('close failed', { error: err });
        o.proc.exit(1);
      },
    );
  };

  for (const s of signals)
    offs.push(
      o.proc.onSignal(s, () => {
        onSignal(s);
      }),
    );
  return () => {
    for (const off of offs) off();
  };
}
