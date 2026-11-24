/**
 * A relay's NIP-11 information document, read the way a page may: a `GET` of the relay's URL
 * with `https:` for `wss:` (`http:` for `ws:`) and `Accept: application/nostr+json`, bounded
 * in time and size, and its `nfx` object (NFX-04 §3) read defensively. No WASM, and nothing
 * kept between sessions: `RelayInfoCache` holds one session's answers.
 *
 * A relay's document is untrusted: it decides nothing here but what the reader makes of its
 * fields. Every failure (no answer, a status other than 200, a redirect, a body over 64 KiB,
 * not UTF-8, not JSON, not an object) is the same answer: no document.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { RelayInfo, RelayInfoOptions, RelayNfx } from './api';

/** How long one document may take, body included (ms). */
export const RELAY_INFO_TIMEOUT_MS = 3_000;
/** The most bytes of one document read. */
export const RELAY_INFO_MAX_BYTES = 64 * 1024;
/** The most relays one cache holds: a session signals through at most 8. */
const MAX_CACHED = 64;
const MAX_LIST = 64;
const MAX_KINDS = 256;
const MAX_STRING = 128;
const MIN_STUN_PORT = 1024;

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The URL of a relay's NIP-11 document: its own URL with `https:` for `wss:` and `http:` for
 * `ws:`, the same host, port and path. Null for any other URL, or one with credentials.
 */
export function relayInfoUrl(relay: string): string | null {
  let u: URL;
  try {
    u = new URL(relay);
  } catch {
    return null;
  }
  const scheme = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : null;
  if (scheme === null || u.username || u.password) return null;
  return `${scheme}//${u.host}${u.pathname}`;
}

function strings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const v of raw as unknown[]) {
    if (out.length >= MAX_LIST) break;
    if (typeof v === 'string' && v.length <= MAX_STRING && !out.includes(v)) out.push(v);
  }
  return out;
}

function kinds(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = new Set<number>();
  for (const v of raw as unknown[]) {
    if (out.size >= MAX_KINDS) break;
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 65535) out.add(v);
  }
  return [...out];
}

/**
 * What a reader keeps of a parsed NIP-11 document (`JSON.parse` of its body): its `nfx` object,
 * read defensively (`RelayNfx`). Null when `doc` is not a JSON object.
 */
export function parseRelayInfo(doc: unknown): RelayInfo | null {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const raw = (doc as { nfx?: unknown }).nfx;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { nfx: null };
  const f = raw as Record<string, unknown>;
  const nfx: RelayNfx = {};
  const networks = strings(f.networks);
  if (networks !== undefined) nfx.networks = networks;
  const k = kinds(f.kinds);
  if (k !== undefined) nfx.kinds = k;
  const roles = strings(f.roles);
  if (roles !== undefined) nfx.roles = roles;
  const port = f.stun_port;
  if (typeof port === 'number' && Number.isSafeInteger(port) && port >= MIN_STUN_PORT && port <= 65535) nfx.stun_port = port;
  return { nfx };
}

/** The body of `res`, or null once it passes `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > maxBytes) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(read);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * The NIP-11 document of `relay` (a `wss:` or `ws:` URL), as `parseRelayInfo` reads it, or
 * null on any failure: no answer within `timeoutMs` (default 3 s, the body included), a
 * status other than 200, a redirect, a body over 64 KiB, not UTF-8 JSON, or not an object.
 * No credentials, no referrer, not from the HTTP cache. `Accept: application/nostr+json` is a
 * CORS-safelisted header, so there is no preflight; NIP-11 asks relays to allow any origin.
 * Never rejects.
 */
export async function fetchRelayInfo(
  relay: string,
  options: RelayInfoOptions = {},
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<RelayInfo | null> {
  const url = relayInfoUrl(relay);
  if (url === null || options.signal?.aborted) return null;
  const ctl = new AbortController();
  const onAbort = (): void => ctl.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(onAbort, options.timeoutMs ?? RELAY_INFO_TIMEOUT_MS);
  // The fetch and the body read race the timer, so a stand-in fetch that ignores the signal
  // cannot hold this past it.
  const gaveUp = new Promise<null>((resolve) => ctl.signal.addEventListener('abort', () => resolve(null), { once: true }));
  const read = async (): Promise<RelayInfo | null> => {
    const res = await fetchFn(url, {
      headers: { Accept: 'application/nostr+json' },
      signal: ctl.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const length = res.headers.get('content-length');
    if (length !== null && !(Number(length) <= RELAY_INFO_MAX_BYTES)) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readCapped(res, RELAY_INFO_MAX_BYTES);
    if (bytes === null) return null;
    return parseRelayInfo(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  };
  try {
    return await Promise.race([read().catch(() => null), gaveUp]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    ctl.abort();
  }
}

/**
 * One session's NIP-11 documents, by relay URL: each relay is asked at most once, and every
 * caller of `get` shares that answer. At most 64 relays; past that, `get` answers null.
 * `destroy` gives up on every one still being read.
 */
export class RelayInfoCache {
  readonly #docs = new Map<string, Promise<RelayInfo | null>>();
  readonly #ctl = new AbortController();
  readonly #timeoutMs: number | undefined;
  readonly #fetch: FetchFn | undefined;

  constructor(options: { timeoutMs?: number; fetch?: FetchFn } = {}) {
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch;
  }

  get(relay: string): Promise<RelayInfo | null> {
    const held = this.#docs.get(relay);
    if (held !== undefined) return held;
    if (this.#docs.size >= MAX_CACHED || this.#ctl.signal.aborted) return Promise.resolve(null);
    const p = fetchRelayInfo(relay, { timeoutMs: this.#timeoutMs, signal: this.#ctl.signal }, this.#fetch);
    this.#docs.set(relay, p);
    return p;
  }

  destroy(): void {
    this.#ctl.abort();
  }
}
