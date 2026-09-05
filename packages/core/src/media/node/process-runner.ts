import { spawn } from 'node:child_process';

import type { ProcessRunner } from '../../contracts/media.js';
import { ProcessRunnerError } from '../errors.js';

/**
 * `ProcessRunner` over `node:child_process.spawn` (gateway / Node hosts).
 *
 * argv only — `shell` is never set, so filenames are never interpreted. stdout is collected
 * as bytes (ffprobe JSON), stderr is decoded and split on `\n` AND `\r` (ffmpeg's stats and
 * `-progress` lines) and streamed to `onStderrLine`.
 */

/** Splits a stream of text into lines on `\n` or `\r`, buffering partial lines. */
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

export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function nodeProcessRunner(): ProcessRunner {
  return {
    run(file, args, opts) {
      return new Promise((resolve, reject) => {
        if (opts?.signal?.aborted) {
          reject(new ProcessRunnerError('aborted', file));
          return;
        }
        const child = spawn(file, [...args], {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
        const stdoutChunks: Uint8Array[] = [];
        const stderrChunks: string[] = [];
        const stderrDecoder = new TextDecoder();
        const lines = new LineSplitter((l) => opts?.onStderrLine?.(l));
        let settled = false;

        child.stdout.on('data', (c: Uint8Array) => {
          stdoutChunks.push(c);
        });
        child.stderr.on('data', (c: Uint8Array) => {
          const text = stderrDecoder.decode(c, { stream: true });
          stderrChunks.push(text);
          lines.push(text);
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          reject(
            new ProcessRunnerError('spawn-failed', file, {
              ...(err.code !== undefined ? { errno: err.code } : {}),
              cause: err,
              message: err.message,
            }),
          );
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          settled = true;
          lines.flush();
          resolve({
            exitCode: code ?? (signal ? -1 : 0),
            stdout: concatChunks(stdoutChunks),
            stderr: stderrChunks.join(''),
          });
        });
        opts?.signal?.addEventListener('abort', () => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new ProcessRunnerError('aborted', file));
        });
      });
    },
  };
}
