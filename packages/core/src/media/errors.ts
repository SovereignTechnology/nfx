/**
 * Error shapes for the media pipeline and its process runners.
 *
 * `contracts/media.ts` defines no error union, so the pipeline signals failure by REJECTING
 * with a `MediaError` carrying a stable `code`. Runners (Node `child_process`, Bare
 * `bare-subprocess`) reject with `ProcessRunnerError` — never a bare synchronous throw
 * (S-C finding 9: `bare-subprocess.spawn()` throws synchronously on ENOENT).
 */

export type ProcessRunnerErrorCode = 'spawn-failed' | 'aborted';

export interface ProcessRunnerErrorShape {
  readonly name: 'ProcessRunnerError';
  readonly code: ProcessRunnerErrorCode;
  /** The executable that was (or could not be) spawned. */
  readonly file: string;
  /** OS error code when known, e.g. `ENOENT`, `EACCES`. */
  readonly errno?: string;
}

export class ProcessRunnerError extends Error implements ProcessRunnerErrorShape {
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

export function isProcessRunnerError(e: unknown): e is ProcessRunnerErrorShape {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { name?: unknown }).name === 'ProcessRunnerError' &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { file?: unknown }).file === 'string'
  );
}

export type MediaErrorCode =
  | 'ffmpeg-not-found'
  | 'process-failed'
  | 'probe-parse'
  | 'no-video-stream'
  | 'not-faststart'
  | 'hash-mismatch'
  | 'unsupported-input'
  | 'aborted';

export class MediaError extends Error {
  override readonly name = 'MediaError' as const;
  readonly code: MediaErrorCode;
  /** Captured stderr of the failing process, when there is one. Never logged by us. */
  readonly stderr?: string;

  constructor(
    code: MediaErrorCode,
    message: string,
    opts: { readonly cause?: unknown; readonly stderr?: string } = {},
  ) {
    super(message, { cause: opts.cause });
    this.code = code;
    if (opts.stderr !== undefined) this.stderr = opts.stderr;
  }
}
