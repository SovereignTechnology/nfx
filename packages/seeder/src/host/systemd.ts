/**
 * systemd integration (build-plan §7 "Host and supply-chain hardening").
 *
 *   - `sdNotify()` sends READY/STOPPING/STATUS to systemd via the `systemd-notify` binary
 *     (Node's `dgram` cannot speak AF_UNIX, and no native module is allowed — S-A rules).
 *     A no-op without `NOTIFY_SOCKET`, so it is harmless under the canonical `Type=simple`.
 *   - `installShutdownHooks()` turns SIGTERM/SIGINT/SIGHUP into one graceful `close()`.
 *
 * THE UNIT FILE IS NOT RENDERED HERE. The canonical, tested unit is
 * `deploy/systemd/nutflix-seeder.service` (L9; `MemoryDenyWriteExecute=yes` + `node
 * --jitless`, `AF_NETLINK`, `Type=simple` — see `deploy/systemd/MDWE-RESULTS.md` and
 * `deploy/systemd/README.md`). The v2 `renderSystemdUnit()` / `HARDENING_DIRECTIVES` and
 * the duplicate `packages/seeder/systemd/` copy had drifted from it on all four of those
 * facts and were removed in the v3 re-issue (docs/lanes/L2.md "v3 re-issue"): a second
 * source of truth for a file this package cannot edit is only a second copy to drift.
 */
import type { SeederProcess, SignalName } from '../adapters/process.js';
import type { Logger } from '../log/logger.js';

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
