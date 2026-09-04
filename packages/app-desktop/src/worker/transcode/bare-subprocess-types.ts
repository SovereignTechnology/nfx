/**
 * Minimal structural types for the slice of `bare-subprocess@6.1.0` this adapter uses.
 *
 * The package ships an `index.d.ts`, but it drags in `bare-events`/`bare-pipe`/`bare-stream`
 * typings; the adapter only needs `spawn(file, args, { stdio, cwd })` returning a handle
 * with `stdout`/`stderr` readable streams, `exit`/`close`/`error` events and `kill()`.
 * Declaring exactly that surface keeps the adapter compilable and unit-testable under Node
 * with an injected fake (the real addon cannot load under Node — S-C finding 8).
 *
 * Verified against node_modules/bare-subprocess/index.js:
 *   - `spawn()` THROWS SYNCHRONOUSLY when `uv_spawn` fails (binding.c:334 `js_throw_error`),
 *     e.g. ENOENT for a missing binary, with `err.code` = the uv error name (S-C finding 9).
 *   - `'exit'` fires with `(exitCode | null, signalCode | null)`; `'close'` fires after every
 *     stdio pipe has closed — that is the moment stdout/stderr are complete.
 *   - stdio pipes are `bare-pipe` (streamx Duplex): `'data'` chunks are Buffers (Uint8Array).
 */

export interface BareReadable {
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'end' | 'close', listener: () => void): this;
}

export interface BareSubprocessHandle {
  readonly pid: number | null;
  readonly stdout: BareReadable | null;
  readonly stderr: BareReadable | null;
  on(event: 'exit' | 'close', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signum?: number | string): void;
}

export type BareStdio = 'pipe' | 'ignore' | 'inherit';

export interface BareSpawnOptions {
  readonly cwd?: string;
  readonly stdio?: readonly [BareStdio, BareStdio, BareStdio];
  /** Always `false` here — argv only, never a shell string. */
  readonly shell?: false;
  readonly env?: Readonly<Record<string, string>>;
}

export type BareSpawn = (
  file: string,
  args: readonly string[],
  opts: BareSpawnOptions,
) => BareSubprocessHandle;

/** Shape of the error `bare-subprocess` throws from `spawn()` on a uv failure. */
export interface UvError extends Error {
  readonly code?: string;
}
