/**
 * A session's sources (NFX-17 §§4.2-4.3): every origin it knows, what each file is (its size
 * from the hash list, its rendition and media time from the verified playlists), and how far
 * playback is buffered. Every file the session loads, the hash list included, comes through
 * `get`, from whichever source ./fetcher.ts reaches first, one source's bytes per file.
 *
 * Before HTTP come the session's file providers (NFX-10 §7, decision record 0112 point 8), in
 * tiers: the local keep store, then the file channel, then HTTP. Each is asked by the file's
 * HTTP path, told the sha256, role and byte limit the hash list gives it, and answers with
 * bytes it has checked or null; the same check runs again here before anything is used. A tier
 * that answers null hands on to the next at once; one still silent at its deadline is joined by
 * the next, and the first bytes that verify win. The last tier with a chance has no deadline.
 * A file has failed only when every tier has.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { ALL_FAILED_WAIT_MS, DEFAULT_MAX_BYTES, type FetchDeps, type FetchResult, type FileSpec, Meter, fetchFile } from './fetcher';
import { type SourceInfo, SourceSet, type Tier } from './sources';

/** What a file is to the hash list (NFX-05 §2), and `hashlist` for the hash list itself. */
export type FileRole = 'hashlist' | 'playlist-master' | 'playlist' | 'init' | 'segment' | 'thumb' | 'subtitle';

/** One file a provider is asked for. */
export interface FileWant {
  /** Its HTTP path: `<root>` for the hash list, `<root>/<content name>` (or `<root>/master.m3u8`) for the rest. */
  readonly path: string;
  readonly root: string;
  /** The sha256 its bytes must have (the root, for the hash list). */
  readonly sha256: string;
  readonly role: FileRole;
  /** The rendition an init or segment belongs to, when a verified playlist said so; else null. */
  readonly rendition: string | null;
  /** The most bytes it may have: its size from the hash list, or the caller's limit. */
  readonly maxBytes: number;
  /** Whether this provider is the last tier with a chance for it (it has no deadline then). */
  readonly lastChance: boolean;
}

/** A tier before HTTP (NFX-10 §7; decision record 0112 point 8). */
export interface FileProvider {
  /** Its name in logs and in `FetchResult.source`, ending in `:` (`keep:`, `file-channel:`); never a URL. */
  readonly name: string;
  /** How long it is waited for before the next tier starts too, in ms (none when it is the last with a chance). */
  readonly deadlineMs: number;
  /** Whether it declines `want` at once (the file channel declines `segment`). */
  declines?(want: FileWant): boolean;
  /**
   * The file's bytes, which `verify` has accepted, or null when it does not hold them or cannot
   * get them: never a throw for that. Stops, with null, when `signal` aborts.
   */
  get(want: FileWant, verify: (bytes: Uint8Array) => boolean, signal: AbortSignal): Promise<Uint8Array | null>;
  /** Told of the file's bytes, verified, when another tier (`source`) delivered them. */
  delivered?(want: FileWant, bytes: Uint8Array, source: string): void;
}

/** What `SessionSources` fetches and waits with (tests pass their own). */
export interface SourcesEnv {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** ms */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const browserEnv: SourcesEnv = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const SHA = /^[0-9a-f]{64}$/;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError');
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What is known about a file before it is fetched, by its content name. */
interface Facts {
  size: number | null;
  rendition: string | null;
  mediaTime: number | null;
}

/** The last path element of `url` (a content name such as `<sha256>.m4s`), or null. */
export function lastName(url: string): string | null {
  let path: string;
  try {
    path = new URL(url, 'https://x.invalid/').pathname;
  } catch {
    return null;
  }
  const last = path.split('/').pop() ?? '';
  return last === '' ? null : last;
}

/**
 * Each media segment and init a verified media playlist names, with its duration (`#EXTINF`)
 * or null for an init (`#EXT-X-MAP`), by content name.
 */
export function playlistFiles(text: string): Map<string, number | null> {
  const out = new Map<string, number | null>();
  let duration: number | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      const d = Number.parseFloat(line.slice(8));
      duration = Number.isFinite(d) && d > 0 ? d : null;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]+)"/.exec(line);
      const name = m ? lastName(m[1] ?? '') : null;
      if (name !== null) out.set(name, null);
    } else if (line !== '' && !line.startsWith('#')) {
      const name = lastName(line);
      if (name !== null) out.set(name, duration);
      duration = null;
    }
  }
  return out;
}

/** Seconds of media buffered ahead of the play position of `el`. */
export function bufferedAhead(el: { buffered: TimeRanges; currentTime: number }): number {
  const t = el.currentTime;
  for (let i = 0; i < el.buffered.length; i++) {
    const start = el.buffered.start(i);
    const end = el.buffered.end(i);
    if (t >= start - 0.1 && t <= end) return end - t;
  }
  return 0;
}

export interface Origin {
  url: string;
  tier?: Tier;
  /** Renditions it is said to serve; null: every one. */
  renditions?: readonly string[] | null;
}

export interface SessionSourcesOptions {
  random?: () => number;
  /** The tiers before HTTP, in order (NFX-10 §7: the keep store, then the file channel). */
  providers?: readonly FileProvider[];
  env?: SourcesEnv;
}

export class SessionSources {
  readonly set: SourceSet;
  readonly meter = new Meter();
  readonly #facts = new Map<string, Facts>();
  /** What the verified hash list says of each file, by sha256. */
  readonly #files = new Map<string, { role: FileRole; size: number | null }>();
  #master: string | null = null;
  readonly #providers: readonly FileProvider[];
  readonly #env: SourcesEnv;
  #buffer: () => number = () => 0;
  #log: (m: string) => void = () => {};
  #reject: (source: string, path: string) => void = () => {};
  #delivered: (source: string) => void = () => {};
  readonly #reported = new Set<string>();

  constructor(
    readonly root: string,
    origins: readonly Origin[],
    o: SessionSourcesOptions = {},
  ) {
    this.set = new SourceSet(o.random);
    this.#providers = [...(o.providers ?? [])];
    this.#env = o.env ?? browserEnv;
    this.add(origins);
  }

  /** Whether `source` (a `FetchResult.source`) is one of the session's providers, not an HTTP source. */
  isProvider(source: string): boolean {
    return this.#providers.some((p) => p.name === source);
  }

  /** Whether a host sent bytes that do not verify: it is out for the session (NFX-05 §4). */
  rejects(url: string): boolean {
    return this.set.rejects(url);
  }

  /** Sources heard of while the session runs (NFX-17 §4.3: it keeps adding them). */
  add(origins: readonly Origin[]): void {
    if (origins.length === 0) return;
    const infos: SourceInfo[] = origins.map((o) => ({
      url: o.url,
      tier: o.tier ?? 4,
      renditions: o.renditions ?? null,
      firm: o.renditions ?? null,
    }));
    this.set.update(infos, this.#env.now());
  }

  bind(o: {
    buffer?: () => number;
    log?: (m: string) => void;
    reject?: (source: string, path: string) => void;
    /** Told once of each source that delivers a file (for `EndpointWatch.delivered`). */
    delivered?: (source: string) => void;
  }): void {
    if (o.buffer) this.#buffer = o.buffer;
    if (o.log) this.#log = o.log;
    if (o.reject) this.#reject = o.reject;
    if (o.delivered) this.#delivered = o.delivered;
  }

  /** Sizes of the files a verified hash list names, by name. */
  learnSizes(files: Iterable<[string, number | null]>): void {
    for (const [name, size] of files) {
      const held = this.#facts.get(name);
      this.#facts.set(name, { size, rendition: held?.rendition ?? null, mediaTime: held?.mediaTime ?? null });
    }
  }

  /**
   * What a verified hash list says of each file (its `files[]`: sha256, role, size), and its
   * master playlist's sha256: what the providers are told of a file.
   */
  learnFiles(files: Iterable<{ sha256: string; role: string; size: number | null }>, master: string | null): void {
    const roles: readonly string[] = ['playlist-master', 'playlist', 'init', 'segment', 'thumb', 'subtitle'];
    for (const f of files) {
      if (!SHA.test(f.sha256) || !roles.includes(f.role) || this.#files.has(f.sha256)) continue;
      this.#files.set(f.sha256, { role: f.role as FileRole, size: f.size });
    }
    if (master !== null && SHA.test(master)) this.#master = master;
  }

  /** What a provider is told of the file at `path`, or null for a path the hash list does not name (yet). */
  want(path: string, maxBytes: number | undefined, lastChance = false): FileWant | null {
    const root = this.root;
    if (path === root) {
      return { path, root, sha256: root, role: 'hashlist', rendition: null, maxBytes: maxBytes ?? DEFAULT_MAX_BYTES, lastChance };
    }
    if (!path.startsWith(`${root}/`)) return null;
    const name = path.slice(root.length + 1);
    if (name.includes('/')) return null;
    const dot = name.indexOf('.');
    const sha = name === 'master.m3u8' ? this.#master : dot > 0 ? name.slice(0, dot) : null;
    if (sha === null || !SHA.test(sha)) return null;
    const file = this.#files.get(sha);
    if (file === undefined) return null;
    const rendition = file.role === 'init' || file.role === 'segment' ? (this.#facts.get(name)?.rendition ?? null) : null;
    return { path, root, sha256: sha, role: file.role, rendition, maxBytes: file.size ?? maxBytes ?? DEFAULT_MAX_BYTES, lastChance };
  }

  /** What a verified media playlist of `rendition` says of its files. */
  learnPlaylist(text: string, rendition: string | null): void {
    for (const [name, mediaTime] of playlistFiles(text)) {
      const held = this.#facts.get(name);
      this.#facts.set(name, { size: held?.size ?? null, rendition, mediaTime });
    }
  }

  /**
   * The file at `<source>/<path>`, checked by `verify`, and the source it came from: a
   * provider's name or an origin. With `once`, rejects when every tier has failed it, instead
   * of waiting and trying again.
   */
  async get(
    path: string,
    verify: (bytes: Uint8Array) => boolean,
    signal?: AbortSignal,
    once = false,
    maxBytes?: number,
  ): Promise<FetchResult> {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const facts = this.#facts.get(name);
    const spec: FileSpec = {
      path,
      size: facts?.size ?? null,
      mediaTime: facts?.mediaTime ?? null,
      rendition: facts?.rendition ?? null,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    };
    const deps = (o: boolean): FetchDeps => ({
      sources: this.set,
      meter: this.meter,
      fetch: this.#env.fetch,
      now: this.#env.now,
      sleep: this.#env.sleep,
      bufferAhead: () => this.#buffer(),
      verify,
      log: this.#log,
      onReject: (source) => this.#reject(source, path),
      once: o,
    });
    const want = this.#providers.length === 0 ? null : this.want(path, maxBytes);
    let got: FetchResult;
    if (want === null) {
      // No provider can be asked for it: HTTP alone, as before there were providers.
      got = await fetchFile(spec, deps(once), signal);
    } else {
      got = await this.#tiered(want, spec, verify, deps(true), once, signal);
      for (const p of this.#providers) {
        if (p.name === got.source) continue;
        try {
          p.delivered?.(want, got.bytes, got.source);
        } catch (e) {
          this.#log(`${p.name} ${path}: ${message(e)}`);
        }
      }
    }
    if (!this.isProvider(got.source) && !this.#reported.has(got.source)) {
      this.#reported.add(got.source);
      this.#delivered(got.source);
    }
    return got;
  }

  /** Whether HTTP has a source left to ask: one not out for the session. */
  #httpChance(): boolean {
    return this.set.list(this.#env.now()).some((s) => !s.bad);
  }

  /** Every tier, again and again (after `ALL_FAILED_WAIT_MS`), until one delivers; with `once`, a single round. */
  async #tiered(
    want: FileWant,
    spec: FileSpec,
    verify: (bytes: Uint8Array) => boolean,
    http: FetchDeps,
    once: boolean,
    signal: AbortSignal | undefined,
  ): Promise<FetchResult> {
    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      const got = await this.#round(want, spec, verify, http, signal);
      if (got !== null) return got;
      if (signal?.aborted) throw abortReason(signal);
      if (once) throw new Error(`every source failed ${want.path}`);
      this.#log(`every source failed ${want.path}; trying again in ${ALL_FAILED_WAIT_MS / 1000} s`);
      await new Promise<void>((resolve) => {
        const fin = (): void => {
          signal?.removeEventListener('abort', fin);
          resolve();
        };
        signal?.addEventListener('abort', fin, { once: true });
        void this.#env.sleep(ALL_FAILED_WAIT_MS).then(fin);
      });
      this.set.wake();
    }
  }

  /**
   * One round over the tiers: each provider that does not decline, then HTTP if a source is
   * left. A tier starts when the one before it answers null or reaches its deadline; the first
   * bytes that verify win and stop the rest. Null when every tier has failed.
   */
  #round(
    want: FileWant,
    spec: FileSpec,
    verify: (bytes: Uint8Array) => boolean,
    http: FetchDeps,
    signal: AbortSignal | undefined,
  ): Promise<FetchResult | null> {
    const env = this.#env;
    const began = env.now();
    const providers = this.#providers.filter((p) => {
      try {
        return !p.declines?.(want);
      } catch {
        return false;
      }
    });
    const tiers: (FileProvider | null)[] = [...providers, ...(this.#httpChance() ? [null] : [])];
    if (tiers.length === 0) return Promise.resolve(null);
    const ctl = new AbortController();
    return new Promise<FetchResult | null>((resolve, reject) => {
      let next = 0;
      let running = 0;
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        ctl.abort();
        reject(abortReason(signal!));
      };
      const finish = (r: FetchResult | null): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        ctl.abort();
        resolve(r);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const run = async (tier: FileProvider | null, last: boolean): Promise<FetchResult | null> => {
        if (tier === null) {
          // Timed from the round's start, as the providers' answers are: a keep tier waited for
          // first is time the file took, not time its transfer took less.
          const waited = Math.max(0, env.now() - began);
          try {
            const r = await fetchFile(spec, http, ctl.signal);
            return waited === 0 ? r : { ...r, firstByteMs: r.firstByteMs + waited, totalMs: r.totalMs + waited };
          } catch {
            return null;
          }
        }
        try {
          const bytes = await tier.get(last ? { ...want, lastChance: true } : want, verify, ctl.signal);
          if (bytes === null || ctl.signal.aborted) return null;
          // The provider's check, and the session's again: nothing it says is taken on trust.
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > want.maxBytes || !verify(bytes)) {
            this.#log(`${tier.name} ${want.path}: bytes that do not verify, refused`);
            return null;
          }
          const t = env.now();
          return { bytes, source: tier.name, firstByteMs: Math.max(0, t - began), totalMs: Math.max(1, t - began) };
        } catch (e) {
          if (!ctl.signal.aborted) this.#log(`${tier.name} ${want.path}: ${message(e)}`);
          return null;
        }
      };
      const startNext = (): void => {
        if (done || next >= tiers.length) return;
        const i = next++;
        const tier = tiers[i]!;
        const last = i === tiers.length - 1;
        running += 1;
        if (!last && tier !== null) {
          const ms = tier.deadlineMs;
          void env.sleep(ms).then(() => {
            if (done || next !== i + 1) return;
            this.#log(`${tier.name} ${want.path}: nothing within ${ms} ms; the next tier too`);
            startNext();
          });
        }
        void run(tier, last).then((r) => {
          running -= 1;
          if (done) return;
          if (r !== null) {
            finish(r);
            return;
          }
          // The newest tier said no: the next one now.
          if (next === i + 1) startNext();
          if (running === 0 && next >= tiers.length) finish(null);
        });
      };
      startNext();
    });
  }
}
