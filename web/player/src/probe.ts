/**
 * Which renditions an origin holds, by asking it (nfx #85). Beacons come from any key
 * (NFX-03), so what one says an origin serves is a hint; the origin itself is
 * authoritative, and answers `404` for a file it does not hold (NFX-05 §6, NFX-03 §4).
 * After the hash list verifies, `open()` (./lib.ts) asks the origin for each allowed
 * rendition's init and offers only the renditions it answers for.
 *
 * This file is plain logic over an injected `fetch`-shaped probe, so unit.ts runs it without
 * a browser: the runner (bounded in parallel and in time, aborted with the session), the
 * byte-capped GET, and reading a verified media playlist for its init's URI.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { probeOrder, sessionRenditions } from './levels';

/** How long all of one origin's probes may take together, in milliseconds. */
export const PROBE_TIMEOUT_MS = 8_000;
/** How many renditions are probed at once on one origin. */
export const PROBE_CONCURRENCY = 6;
/**
 * Most body bytes a probe reads. An init (NFX-05 §1) is a few KiB, so a whole one is read,
 * and lands in the HTTP cache for hls.js (content addresses are immutable, NFX-05 §6.1);
 * a larger or endless body is cut off here.
 */
export const PROBE_MAX_BYTES = 64 * 1024;

/** What one probe found: the origin holds the rendition (`status` 200 or 206), or why not. */
export type ProbeOutcome = { held: true; status: number } | { held: false; why: string };

/** What a probe of one rendition resolves to: the HTTP status its init answered with. */
export type Probe = (id: string, signal: AbortSignal) => Promise<number>;

export interface ProbeOptions {
  /** All probes together, in milliseconds. Default `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Probes at once. Default `PROBE_CONCURRENCY`. */
  concurrency?: number;
  /** Aborting it rejects `probeAll` with its reason and cancels every probe. */
  signal?: AbortSignal;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError');
}

/**
 * Run `probe` for each of `ids`, in that order, at most `concurrency` at once, all under one
 * deadline. Resolves with every id's outcome, in `ids`' order: held when the init answered
 * 200 or 206; otherwise why not (another status, a failure, no answer by the deadline, or
 * not reached by then). A probe still running at the deadline is aborted and counted as not
 * held: a level is offered only on an answer. Rejects only when `signal` aborts.
 */
export async function probeAll(ids: readonly string[], probe: Probe, o: ProbeOptions = {}): Promise<Map<string, ProbeOutcome>> {
  const timeoutMs = o.timeoutMs ?? PROBE_TIMEOUT_MS;
  const asked = o.concurrency ?? PROBE_CONCURRENCY;
  const concurrency = Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : PROBE_CONCURRENCY;
  if (o.signal?.aborted) throw abortReason(o.signal);
  const ctl = new AbortController();
  // Every probe races this, so the deadline holds even for a probe that ignores its signal.
  const stopped = new Promise<never>((_, reject) => {
    ctl.signal.addEventListener('abort', () => reject(abortReason(ctl.signal)), { once: true });
  });
  stopped.catch(() => {});
  let timedOut = false;
  const onAbort = (): void => ctl.abort(o.signal ? abortReason(o.signal) : undefined);
  o.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort(new DOMException('probe timed out', 'TimeoutError'));
  }, timeoutMs);
  const out = new Map<string, ProbeOutcome>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length && !ctl.signal.aborted) {
      const id = ids[next++]!;
      try {
        const running = probe(id, ctl.signal);
        // Settled later, after an abort, it must not surface as an unhandled rejection.
        running.catch(() => {});
        const status = await Promise.race([running, stopped]);
        out.set(id, status === 200 || status === 206 ? { held: true, status } : { held: false, why: `HTTP ${status}` });
      } catch (e) {
        const why = !ctl.signal.aborted ? message(e) : timedOut ? `no answer within ${timeoutMs} ms` : 'aborted';
        out.set(id, { held: false, why });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    // Nothing should still be running; anything that is, is cut loose.
    ctl.abort();
  }
  if (o.signal?.aborted) throw abortReason(o.signal);
  return new Map(ids.map((id): [string, ProbeOutcome] => [id, out.get(id) ?? { held: false, why: `not probed within ${timeoutMs} ms` }]));
}

/**
 * GET `url` and resolve with its status, having read at most `maxBytes` of the body (and
 * none of an error's). No `Range` header: it is not CORS-safelisted in every browser, and a
 * preflight would cost a round trip and depend on the origin answering `OPTIONS`, which
 * NFX-05 §6 does not require. `cache: 'no-cache'`: the origin is asked, never only the
 * HTTP cache, so a copy cached in an earlier session cannot vouch for an origin that no
 * longer holds the file (the answer is cached again, for hls.js). Rejects on a network
 * failure, or when `signal` aborts.
 */
export async function probeStatus(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  signal: AbortSignal,
  maxBytes: number = PROBE_MAX_BYTES,
): Promise<number> {
  const res = await fetchFn(url, { signal, credentials: 'omit', cache: 'no-cache' });
  const body = res.body;
  if (body === null) return res.status;
  const reader = body.getReader();
  if (!res.ok) {
    void reader.cancel().catch(() => {});
    return res.status;
  }
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return res.status;
    read += value.byteLength;
    if (read >= maxBytes) {
      void reader.cancel().catch(() => {});
      return res.status;
    }
  }
}

/** `#EXT-X-MAP` with its `URI` (NFX-05 §3: a tag has at most one `URI` attribute). */
const MAP_URI = /#EXT-X-MAP:[^\r\n]*?\bURI="([^"\r\n]*)"/;

/**
 * The URL of a media playlist's init (its `#EXT-X-MAP` URI), resolved against the
 * playlist's own URL; without one, its first media segment's, which is then what tells
 * whether the origin holds the rendition. Null when it names neither. `text` must be a
 * playlist that verified against the hash list (NFX-05 §3 makes its URIs content names).
 */
export function initUrl(text: string, playlistUrl: string): string | null {
  const map = MAP_URI.exec(text)?.[1];
  const first = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  const uri = map ?? first;
  if (uri === undefined || uri === '') return null;
  try {
    return new URL(uri, playlistUrl).href;
  } catch {
    return null;
  }
}

/**
 * The outcomes in a short line for a log or an `origin` event: at most `max` renditions,
 * each id cut to 64 characters (ids come from the creator, statuses from the origin).
 */
export function describe(outcomes: ReadonlyMap<string, ProbeOutcome>, max = 8): string {
  const parts = [...outcomes].map(([id, o]) => `${id.length > 64 ? `${id.slice(0, 64)}…` : id}: ${o.held ? `HTTP ${o.status}` : o.why.slice(0, 120)}`);
  return parts.slice(0, max).join('; ') + (parts.length > max ? `; and ${parts.length - max} more` : '');
}

/** What `selectRenditions` found on one origin. */
export interface Selection {
  /** The session's renditions there: allowed, and held by the origin's own answers, in the caller's order. */
  renditions: string[];
  /** Each rendition asked for, in the order asked, with its outcome. */
  outcomes: Map<string, ProbeOutcome>;
  /** Allowed renditions past `MAX_RENDITIONS`, not asked for (so not offered). */
  unasked: number;
}

/**
 * One origin's part of `open()`'s rule (`OpenCommon`): of the hash list's renditions
 * (`ids`), the allowed ones (`wanted`, or all) that the origin holds, by asking it (`probe`
 * per rendition, run by `probeAll`). `hint` (what beacons claim it serves) orders the
 * asking and nothing else. Throws a `RangeError`, before any probe, for an id of `wanted`
 * the hash list lacks; rejects when `o.signal` aborts.
 */
export async function selectRenditions(
  ids: readonly string[],
  wanted: readonly string[] | null,
  hint: readonly string[] | null,
  probe: Probe,
  o: ProbeOptions = {},
): Promise<Selection> {
  const allowed = sessionRenditions(ids, wanted, null);
  const asked = probeOrder(allowed, hint);
  const outcomes = await probeAll(asked, probe, o);
  const held = asked.filter((id) => outcomes.get(id)?.held === true);
  return { renditions: sessionRenditions(ids, wanted, held), outcomes, unasked: allowed.length - asked.length };
}
