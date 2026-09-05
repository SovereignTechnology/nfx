import type { ProcessRunner } from '@sovit/core';

import type { BareSpawn, BareSubprocessHandle, UvError } from './bare-subprocess-types.js';

/**
 * `ProcessRunner` (contracts/media.ts) over `bare-subprocess.spawn` for the desktop Bare
 * worker. The `spawn` function is INJECTED: production passes `require('bare-subprocess').spawn`;
 * tests pass a fake, because no `bare-*` addon loads under Node (S-C finding 8).
 *
 * Contract error shape: rejects with a `ProcessRunnerError` — `{ name: 'ProcessRunnerError',
 * code: 'spawn-failed' | 'aborted', file, errno? }` — identical in shape to
 * `@sovit/core/media`'s class so `isProcessRunnerError()` there recognises it. The class is
 * duplicated here only because `media/` is not yet exported from `@sovit/core` (wired by the
 * orchestrator at merge); replace with an import then.
 *
 * S-C finding 9: `spawn()` throws SYNCHRONOUSLY on ENOENT (Node emits `'error'` instead).
 * Uncaught, that throw took the whole Bare process down in the spike. It is caught here and
 * turned into the rejection above.
 */

export type ProcessRunnerErrorCode = 'spawn-failed' | 'aborted';

export class ProcessRunnerError extends Error {
  override readonly name = 'ProcessRunnerError' as const;
  readonly code: ProcessRunnerErrorCode;
  readonly file: string;
  readonly errno?: string;

  constructor(
    code: ProcessRunnerErrorCode,
    file: string,
    opts: { readonly errno?: string; readonly cause?: unknown; readonly message?: string } = {},
  ) {
    super(opts.message ?? `${code}: ${file}${opts.errno ? ` (${opts.errno})` : ''}`, {
      cause: opts.cause,
    });
    this.code = code;
    this.file = file;
    if (opts.errno !== undefined) this.errno = opts.errno;
  }
}

/** Splits text into lines on `\n` or `\r` (ffmpeg stats use `\r`), buffering partials. */
export class LineSplitter {
  private rest = '';
  constructor(private readonly onLine: (line: string) => void) {}
  push(text: string): void {
    const parts = (this.rest + text).split(/\r\n|\r|\n/);
    this.rest = parts.pop() ?? '';
    for (const p of parts) if (p.length > 0) this.onLine(p);
  }
  flush(): void {
    if (this.rest.length > 0) this.onLine(this.rest);
    this.rest = '';
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface BareProcessRunnerOptions {
  /** Environment for the child; default = inherit (bare-subprocess uses `bare-env`). */
  readonly env?: Readonly<Record<string, string>>;
}

export function createBareProcessRunner(
  spawn: BareSpawn,
  options: BareProcessRunnerOptions = {},
): ProcessRunner {
  return {
    run(file, args, opts) {
      return new Promise((resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(new ProcessRunnerError('aborted', file));
          return;
        }

        let child: BareSubprocessHandle;
        try {
          child = spawn(file, [...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
          });
        } catch (e) {
          // S-C finding 9: synchronous throw on uv_spawn failure (ENOENT, EACCES, ...).
          const uv = e as UvError;
          reject(
            new ProcessRunnerError('spawn-failed', file, {
              ...(typeof uv.code === 'string' ? { errno: uv.code } : {}),
              cause: e,
              message: typeof uv.message === 'string' ? uv.message : String(e),
            }),
          );
          return;
        }

        const stdoutChunks: Uint8Array[] = [];
        const stderrText: string[] = [];
        const stderrDecoder = new TextDecoder();
        const lines = new LineSplitter((l) => opts?.onStderrLine?.(l));
        let settled = false;

        child.stdout?.on('data', (c) => {
          stdoutChunks.push(c);
        });
        child.stderr?.on('data', (c) => {
          const text = stderrDecoder.decode(c, { stream: true });
          stderrText.push(text);
          lines.push(text);
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(
            new ProcessRunnerError('spawn-failed', file, { cause: err, message: err.message }),
          );
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          lines.flush();
          resolve({
            exitCode: code ?? (signal !== null ? -1 : 0),
            stdout: concat(stdoutChunks),
            stderr: stderrText.join(''),
          });
        });
        opts?.signal?.addEventListener('abort', () => {
          if (settled) return;
          settled = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
          reject(new ProcessRunnerError('aborted', file));
        });
      });
    },
  };
}
