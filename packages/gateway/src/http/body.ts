/**
 * Bounded request-body readers (SECURITY.md T11). Every read has a byte cap and an idle
 * timeout between chunks (slow-loris on the body phase — Node's `requestTimeout` is
 * disabled on the server so multi-GB uploads can take as long as they legitimately need
 * while an idle sender still gets cut).
 *
 * `spoolToFile` streams a body to disk while hashing it with `node:crypto` (sha256 is the
 * one hash the lane brief allows the gateway to call — BUD-02 "compute the sha256 hash
 * over the exact bytes received"). The file is then handed to `seeder.putFile`, which
 * re-hashes and chunks it into blocks.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';

export interface BodyLimits {
  readonly maxBytes: number;
  readonly idleMs: number;
}

export type BodyFailure = 'too-large' | 'idle-timeout' | 'aborted' | 'io';

export type TextBodyResult =
  | { readonly ok: true; readonly text: string; readonly size: number }
  | { readonly ok: false; readonly reason: BodyFailure };

export type SpoolResult =
  | { readonly ok: true; readonly size: number; readonly sha256: string }
  | { readonly ok: false; readonly reason: BodyFailure };

/**
 * Drive `req` chunk by chunk with cap + idle timeout, calling `onChunk` for each.
 * Resolves with the failure reason or `null` on a clean end. Never rejects.
 */
function consume(
  req: Readable,
  limits: BodyLimits,
  onChunk: (chunk: Buffer) => Promise<void> | void,
): Promise<{ readonly failure: BodyFailure | null; readonly size: number }> {
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    let pending: Promise<void> = Promise.resolve();

    const finish = (failure: BodyFailure | null): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      // On failure stop READING but do not destroy: the caller still owes the client a
      // status line (413/408); it answers with `Connection: close`, and Node discards
      // whatever body is left once the response is flushed.
      if (failure !== null) req.pause();
      void pending.then(
        () => {
          resolve({ failure, size });
        },
        () => {
          resolve({ failure: failure ?? 'io', size });
        },
      );
    };
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        finish('idle-timeout');
      }, limits.idleMs);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > limits.maxBytes) {
        finish('too-large');
        return;
      }
      arm();
      req.pause();
      pending = pending
        .then(() => onChunk(chunk))
        .then(
          () => {
            if (!done) req.resume();
          },
          () => {
            finish('io');
          },
        );
    };
    const onEnd = (): void => {
      finish(null);
    };
    const onError = (): void => {
      finish('io');
    };
    const onAborted = (): void => {
      finish('aborted');
    };
    const onClose = (): void => {
      // 'close' before 'end' = the client went away mid-body.
      if (!done) finish('aborted');
    };
    arm();
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

/** Read a small (JSON) body into a string. */
export async function readTextBody(req: Readable, limits: BodyLimits): Promise<TextBodyResult> {
  const parts: Buffer[] = [];
  const r = await consume(req, limits, (c) => {
    parts.push(c);
  });
  if (r.failure !== null) return { ok: false, reason: r.failure };
  return { ok: true, text: Buffer.concat(parts).toString('utf8'), size: r.size };
}

/**
 * Stream a body to `path` while hashing. On any failure the partial file is removed.
 * `expectedSize` (from `Content-Length`) is enforced as an upper bound only — the actual
 * byte count is returned and it is the caller's job to compare.
 */
export async function spoolToFile(
  req: Readable,
  path: string,
  limits: BodyLimits,
): Promise<SpoolResult> {
  const hash = createHash('sha256');
  const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const st = { ioError: false };
  out.on('error', () => {
    st.ioError = true;
  });
  const opened = new Promise<boolean>((resolve) => {
    out.once('open', () => {
      resolve(true);
    });
    out.once('error', () => {
      resolve(false);
    });
  });
  if (!(await opened)) return { ok: false, reason: 'io' };

  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      if (st.ioError) {
        reject(new Error('spool write failed'));
        return;
      }
      hash.update(chunk);
      if (out.write(chunk)) resolve();
      else out.once('drain', resolve);
    });
  const r = await consume(req, limits, write);
  const closed = new Promise<void>((resolve) => {
    out.end(() => {
      resolve();
    });
  });
  await closed;
  if (r.failure !== null || st.ioError) {
    await unlink(path).catch(() => undefined);
    return { ok: false, reason: r.failure ?? 'io' };
  }
  return { ok: true, size: r.size, sha256: hash.digest('hex') };
}

/** Bounded read of an async iterable (e.g. a mirror fetch body) to a file, hashing. */
export async function spoolIterableToFile(
  source: AsyncIterable<Uint8Array>,
  path: string,
  maxBytes: number,
): Promise<SpoolResult> {
  const hash = createHash('sha256');
  const out = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const st: { failure: BodyFailure | null } = { failure: null };
  out.on('error', () => {
    st.failure = 'io';
  });
  let size = 0;
  try {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.byteLength;
      if (size > maxBytes) {
        st.failure = 'too-large';
        break;
      }
      hash.update(buf);
      if (!out.write(buf))
        await new Promise<void>((resolve) => {
          out.once('drain', resolve);
        });
      if (st.failure !== null) break;
    }
  } catch {
    st.failure ??= 'io';
  }
  await new Promise<void>((resolve) => {
    out.end(() => {
      resolve();
    });
  });
  if (st.failure !== null) {
    await unlink(path).catch(() => undefined);
    return { ok: false, reason: st.failure };
  }
  return { ok: true, size, sha256: hash.digest('hex') };
}
