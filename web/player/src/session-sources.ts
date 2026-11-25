/**
 * A session's sources (NFX-17 §§4.2-4.3): every origin it knows, what each file is (its size
 * from the hash list, its rendition and media time from the verified playlists), and how far
 * playback is buffered. Every file the session loads, the hash list included, comes through
 * `get`, from whichever source ./fetcher.ts reaches first, one source's bytes per file.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { type FetchDeps, Meter, fetchFile } from './fetcher';
import { type SourceInfo, SourceSet, type Tier } from './sources';

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

export class SessionSources {
  readonly set: SourceSet;
  readonly meter = new Meter();
  readonly #facts = new Map<string, Facts>();
  #buffer: () => number = () => 0;
  #log: (m: string) => void = () => {};
  #reject: (source: string, path: string) => void = () => {};
  #delivered: (source: string) => void = () => {};
  readonly #reported = new Set<string>();

  constructor(
    readonly root: string,
    origins: readonly Origin[],
    random?: () => number,
  ) {
    this.set = new SourceSet(random);
    this.add(origins);
  }

  /** Sources heard of while the session runs (NFX-17 §4.3: it keeps adding them). */
  add(origins: readonly Origin[]): void {
    const infos: SourceInfo[] = origins.map((o) => ({
      url: o.url,
      tier: o.tier ?? 4,
      renditions: o.renditions ?? null,
      firm: o.renditions ?? null,
    }));
    this.set.update(infos, Date.now());
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

  /** What a verified media playlist of `rendition` says of its files. */
  learnPlaylist(text: string, rendition: string | null): void {
    for (const [name, mediaTime] of playlistFiles(text)) {
      const held = this.#facts.get(name);
      this.#facts.set(name, { size: held?.size ?? null, rendition, mediaTime });
    }
  }

  /**
   * The file at `<source>/<path>`, checked by `verify`, and the source it came from. With
   * `once`, rejects when every source has failed it, instead of waiting and trying again.
   */
  async get(
    path: string,
    verify: (bytes: Uint8Array) => boolean,
    signal?: AbortSignal,
    once = false,
    maxBytes?: number,
  ): Promise<{ bytes: Uint8Array; source: string }> {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const facts = this.#facts.get(name);
    const deps: FetchDeps = {
      sources: this.set,
      meter: this.meter,
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      bufferAhead: () => this.#buffer(),
      verify,
      log: this.#log,
      onReject: (source) => this.#reject(source, path),
      once,
    };
    const got = await fetchFile(
      {
        path,
        size: facts?.size ?? null,
        mediaTime: facts?.mediaTime ?? null,
        rendition: facts?.rendition ?? null,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      },
      deps,
      signal,
    );
    if (!this.#reported.has(got.source)) {
      this.#reported.add(got.source);
      this.#delivered(got.source);
    }
    return got;
  }
}
