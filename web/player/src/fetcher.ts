/**
 * Fetching one file from several sources (NFX-17 §4.3): each file from one source's bytes
 * only, a give-up for a request that stalls or runs below the floor, a time limit for open
 * sources while the buffer is low, and hedges, the third place kept for the best tier 1, 2
 * or 4 source. Which source comes next is ./sources.ts's.
 *
 * The clock, the sleep and `fetch` are passed in, so tests drive time by hand.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { type FilePlan, type SourceInfo, type SourceSet, hostOf } from './sources';

/** §4.3's numbers, in ms and bits per second. */
export const NO_BYTE_MS = 4_000;
export const RATE_WINDOW_MS = 4_000;
export const FLOOR_BPS = 1_000_000;
export const LOW_BUFFER_S = 4;
export const HEDGE_AFTER_MS = 2_000;
export const MAX_IN_FLIGHT = 3;
export const LINK_MEMORY_MS = 60_000;
/** How long to wait before starting again when every source has failed a file. */
export const ALL_FAILED_WAIT_MS = 10_000;
/** How often the rules are checked while a file is in flight. */
export const TICK_MS = 250;

export interface FileSpec {
  /** Where the file is under each source: `<root>` for the hash list, `<root>/<name>` for the rest. */
  path: string;
  /** Its size from the hash list, when known. */
  size: number | null;
  /** The media time it holds, in seconds; null for the hash list, playlists and inits. */
  mediaTime: number | null;
  /** The rendition it belongs to; null for files every source serves. */
  rendition: string | null;
  /** The most bytes read when `size` is unknown (the hash list's own limit, for the hash list). */
  maxBytes?: number;
}

/** The most bytes read of a file whose size is not known and that names no limit of its own. */
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Bytes received over time, by host and across the session: the floor and the link rate. */
export class Meter {
  /** [time, bytes, host, request id], for the last window. */
  readonly #samples: [number, number, string, number][] = [];
  /** [time, rate]: one request's rate over a full window, for the last 60 s. */
  readonly #rates: [number, number][] = [];

  add(now: number, bytes: number, host: string, request: number): void {
    this.#samples.push([now, bytes, host, request]);
    const cut = now - RATE_WINDOW_MS;
    while ((this.#samples[0]?.[0] ?? now) <= cut) this.#samples.shift();
  }

  /** Bits per second received from `host` over the window ending at `now`. */
  hostRate(host: string, now: number): number {
    let b = 0;
    for (const [t, n, h] of this.#samples) if (h === host && t > now - RATE_WINDOW_MS) b += n;
    return (b * 8 * 1000) / RATE_WINDOW_MS;
  }

  /** Bits per second one request received over the window ending at `now`. */
  requestRate(request: number, now: number): number {
    let b = 0;
    for (const [t, n, , r] of this.#samples) if (r === request && t > now - RATE_WINDOW_MS) b += n;
    return (b * 8 * 1000) / RATE_WINDOW_MS;
  }

  /** Note one request's rate over a full window, for the link rate. */
  observe(rate: number, now: number): void {
    this.#rates.push([now, rate]);
    while ((this.#rates[0]?.[0] ?? now) <= now - LINK_MEMORY_MS) this.#rates.shift();
  }

  /** The fastest any one request received over a window in the last 60 s; null if none yet. */
  link(now: number): number | null {
    let best: number | null = null;
    for (const [t, r] of this.#rates) if (t > now - LINK_MEMORY_MS && r > 0 && (best === null || r > best)) best = r;
    return best;
  }
}

export interface FetchDeps {
  sources: SourceSet;
  meter: Meter;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** ms */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Seconds of media buffered ahead of playback. */
  bufferAhead: () => number;
  /** Whether `bytes` are the file's (its hash). */
  verify: (bytes: Uint8Array) => boolean;
  log?: (message: string) => void;
  /** Told of each source whose bytes did not verify. */
  onReject?: (source: string) => void;
  /** Reject once every source has failed the file, instead of waiting and trying again. */
  once?: boolean;
}

interface Attempt {
  id: number;
  source: SourceInfo;
  host: string;
  ctl: AbortController;
  started: number;
  lastByte: number;
  firstByte: number | null;
  received: number;
  chunks: Uint8Array[];
  /** 'running' until the body ends or fails. */
  state: 'running' | 'done' | 'failed';
  status: number | null;
}

let nextId = 0;

/** The floor (§4.3): 1 Mbit/s, or a quarter of the link rate when that is lower. */
export function floor(link: number | null): number {
  return link === null ? FLOOR_BPS : Math.min(FLOOR_BPS, link / 4);
}

/**
 * `file`, verified, from the first source that delivers it, and that source's URL. Rejects
 * only when `signal` aborts: when every source has failed, it waits and starts again.
 */
export async function fetchFile(
  file: FileSpec,
  deps: FetchDeps,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; source: string }> {
  const { sources, meter } = deps;
  const fileRate = file.size !== null && file.mediaTime !== null && file.mediaTime > 0 ? (file.size * 8) / file.mediaTime : null;
  let plan: FilePlan = sources.plan(file.rendition);
  const live: Attempt[] = [];
  let lastStart = -Infinity;
  const stop = (a: Attempt): void => {
    a.ctl.abort();
    const i = live.indexOf(a);
    if (i >= 0) live.splice(i, 1);
  };
  const onAbort = (): void => {
    for (const a of [...live]) stop(a);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  // A sleep that an abort ends at once.
  const pause = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const fin = (): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', fin);
        resolve();
      };
      signal?.addEventListener('abort', fin, { once: true });
      void deps.sleep(ms).then(fin);
    });

  const start = (source: SourceInfo): void => {
    const host = hostOf(source.url) ?? source.url;
    const now = deps.now();
    const a: Attempt = {
      id: ++nextId,
      source,
      host,
      ctl: new AbortController(),
      started: now,
      lastByte: now,
      firstByte: null,
      received: 0,
      chunks: [],
      state: 'running',
      status: null,
    };
    live.push(a);
    lastStart = now;
    void read(a, `${source.url}/${file.path}`);
  };

  const read = async (a: Attempt, url: string): Promise<void> => {
    try {
      const res = await deps.fetch(url, { signal: a.ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      a.status = res.status;
      if (!res.ok || res.body === null) {
        a.state = 'failed';
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const t = deps.now();
        a.firstByte ??= t;
        a.lastByte = t;
        a.received += value.byteLength;
        a.chunks.push(value);
        meter.add(t, value.byteLength, a.host, a.id);
        if (a.received > (file.size ?? file.maxBytes ?? DEFAULT_MAX_BYTES)) {
          a.state = 'failed';
          a.status = -1; // longer than the hash list says: not this file
          a.ctl.abort();
          return;
        }
      }
      a.state = 'done';
    } catch {
      if (a.state === 'running') a.state = 'failed';
    }
  };

  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      const now = deps.now();

      // Finished requests: the first copy that verifies wins; the rest are abandoned.
      for (const a of [...live]) {
        if (a.state === 'running') continue;
        stop(a);
        if (a.state === 'done') {
          const bytes = concat(a.chunks, a.received);
          if (deps.verify(bytes)) {
            const took = Math.max(now - a.started, 1);
            const realTime = fileRate === null || (a.received * 8 * 1000) / took >= fileRate;
            sources.outcome(a.source.url, { kind: 'delivered', realTime }, now);
            for (const other of [...live]) stop(other);
            return { bytes, source: a.source.url };
          }
          sources.outcome(a.source.url, { kind: 'bad-bytes' }, now);
          deps.onReject?.(a.source.url);
          deps.log?.(`${a.source.url}: ${file.path} did not verify; source stopped for the session`);
        } else if (a.status === 404 && file.rendition !== null) {
          sources.outcome(a.source.url, { kind: 'not-held', rendition: file.rendition }, now);
        } else if (a.status === -1) {
          sources.outcome(a.source.url, { kind: 'bad-bytes' }, now);
        } else {
          sources.outcome(a.source.url, { kind: 'error' }, now);
        }
      }

      // Give-ups (§4.3).
      const link = meter.link(now);
      const low = deps.bufferAhead() < LOW_BUFFER_S;
      for (const a of [...live]) {
        const ran = now - a.started;
        const sinceFirst = a.firstByte === null ? 0 : now - a.firstByte;
        if (sinceFirst >= RATE_WINDOW_MS) meter.observe(meter.requestRate(a.id, now), now);
        const tooSlow = sinceFirst >= RATE_WINDOW_MS && meter.hostRate(a.host, now) < floor(link);
        const overTime =
          a.source.tier === 3 && file.mediaTime !== null && low && ran > Math.max(4_000, 2_000 * file.mediaTime);
        if (now - a.lastByte >= NO_BYTE_MS || tooSlow || overTime) {
          stop(a);
          sources.outcome(a.source.url, { kind: 'give-up' }, now);
        }
      }

      // Hedges: a request that has run 2 s, slow or silent, is joined by another source.
      const newest = live[live.length - 1];
      if (newest && live.length < MAX_IN_FLIGHT && now - lastStart >= HEDGE_AFTER_MS) {
        const silent = now - newest.lastByte >= HEDGE_AFTER_MS;
        const rate = meter.requestRate(newest.id, now);
        const share = link === null ? null : link / live.length;
        const slow =
          low && (share === null || rate < share / 2) && (fileRate === null || rate < fileRate);
        if (silent || slow) {
          const next = live.length === MAX_IN_FLIGHT - 1 ? (sources.reserved(plan, now) ?? sources.next(plan, now)) : sources.next(plan, now);
          if (next) start(next);
        }
      }

      // Nothing in flight: the next source, or, when none is left, wait and start again.
      if (live.length === 0) {
        const next = sources.next(plan, now);
        if (next) start(next);
        else if (deps.once) {
          throw new Error(`every source failed ${file.path}`);
        } else {
          deps.log?.(`every source failed ${file.path}; trying again in ${ALL_FAILED_WAIT_MS / 1000} s`);
          await pause(ALL_FAILED_WAIT_MS);
          sources.wake();
          plan = sources.plan(file.rendition);
          continue;
        }
      }
      await pause(TICK_MS);
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    for (const a of [...live]) stop(a);
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
