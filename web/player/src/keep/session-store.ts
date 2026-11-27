/**
 * One session's part in keeping what is watched (NFX-18 §§2.1, 3; NFX-10 §7).
 *
 * - **Nothing is written before the minimum.** Seconds actually played are counted from the
 *   media element (a seek counts nothing); until they reach the minimum, what the session
 *   fetched stays in RAM only, and a session that ends sooner writes nothing at all. From the
 *   minimum on, everything it fetched for the video, and everything it fetches later, is
 *   written, one file per transaction, behind the session's back: playback never waits on it.
 * - **A first tier** for `SessionSources` (`FileProvider`, named `keep:`): a file this session
 *   holds in RAM, or the store holds, is served from here before any network tier is asked.
 * - **The engine's segment storage** (`SegmentStorage` of p2p-media-loader-core 4.0.0, patched;
 *   `segmentStorage()`): segments in RAM as the engine's own memory storage keeps them, and
 *   `getUsage` counts RAM only, so the engine's prefetch is what it would be without keeping.
 *   A segment the store holds is served from it to the player and to peers that ask for it;
 *   only segments in RAM, and those of renditions the store holds whole, are announced.
 *
 * Every read from the store is checked against its sha256 again; one that fails is dropped,
 * counted (`refused`), and fetched again by the next tier. `destroy` of the engine's storage
 * and `close()` here end the session's part and never delete anything kept.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { CommonCoreConfig, SegmentStorage, StreamConfig, StreamType } from 'p2p-media-loader-core';

import type { KeepStats } from '../api';
import type { FileProvider, FileRole, FileWant } from '../session-sources';
import type { Keeper, PutResult } from './store';

/** How long the keep tier is waited for before the next tier starts too. */
export const KEEP_DEADLINE_MS = 1_500;
/** NFX-18 §2.1's minimum: 60 s by default, never below 30 s but on a loopback page (tests). */
export const DEFAULT_MINIMUM_S = 60;
export const MIN_MINIMUM_S = 30;
export const MAX_MINIMUM_S = 3_600;
/**
 * The most bytes held in RAM for keeping before the minimum. A segment the engine stores is
 * held here too (the same bytes, not a copy), so one the engine lets go before the minimum is
 * still written once it is reached; it never counts in the engine's usage.
 */
export const PENDING_MAX_BYTES = 256 * 1024 ** 2;

const BYTES_PER_MIB = 1_048_576;
const SHA = /^[0-9a-f]{64}$/;

export type KeepState = KeepStats['state'];

/** The media element, as far as the play clock reads it. */
export interface PlayClockElement {
  readonly currentTime: number;
  readonly seeking: boolean;
  readonly playbackRate: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface KeepSessionOptions {
  keeper: Keeper;
  root: string;
  minimumSeconds: number;
  sha256: (bytes: Uint8Array) => string;
  log?: (m: string) => void;
  onState?: (state: KeepState, why?: string) => void;
}

/** What the verified hash list says the session needs to know. */
export interface KeepList {
  video: string;
  files: readonly { sha256: string; role: string; size: number | null }[];
  /** Each rendition, its playlist's sha256 and its stream swarm ID (NFX-10 §2). */
  renditions: readonly { id: string; playlist: string; swarm: string | null }[];
}

interface Pending {
  sha256: string;
  bytes: Uint8Array;
  role: FileRole;
}

const ORDER: readonly FileRole[] = ['hashlist', 'playlist-master', 'playlist', 'thumb', 'subtitle', 'init', 'segment'];

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The sha256 a content name (`<sha256>.<ext>`, the last element of `uri`) names, or null. */
function nameSha(uri: string): string | null {
  const last = (uri.split(/[?#]/)[0] ?? '').split('/').pop() ?? '';
  const dot = last.indexOf('.');
  const sha = dot > 0 ? last.slice(0, dot) : '';
  return SHA.test(sha) ? sha : null;
}

/** A verified media playlist's init and segments, in order, by sha256. */
export function playlistLayout(text: string): { init: string | null; segments: string[] } {
  let init: string | null = null;
  const segments: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = /URI="([^"]+)"/.exec(line);
      init = m ? nameSha(m[1] ?? '') : init;
    } else if (line !== '' && !line.startsWith('#')) {
      const sha = nameSha(line);
      if (sha !== null) segments.push(sha);
    }
  }
  return { init, segments };
}

export class KeepSession implements FileProvider {
  readonly name = 'keep:';
  readonly deadlineMs = KEEP_DEADLINE_MS;
  readonly #keeper: Keeper;
  readonly #root: string;
  readonly #minimum: number;
  readonly sha256: (bytes: Uint8Array) => string;
  readonly #log: (m: string) => void;
  readonly #onState: (state: KeepState, why?: string) => void;

  #state: KeepState = 'waiting';
  #played = 0;
  #closed = false;
  #release: (() => void) | null = null;
  /** The store's removals of the root when this session started (`Keeper.removedSince`). */
  #removalMark = 0;
  #detach: (() => void) | null = null;
  /** Whether segments come through the engine (`storeSegment`), not `delivered`. */
  meshOn = false;

  #video: string | null = null;
  readonly #roles = new Map<string, FileRole>();
  /** Every file each rendition needs that is not its own: the hash list, playlists, thumbs, subtitles. */
  #shared: string[] = [];
  readonly #bySwarm = new Map<string, string>();
  readonly #swarmOf = new Map<string, string>();
  readonly #layout = new Map<string, { init: string | null; segments: string[] }>();
  /** Each init and segment's rendition, and a segment's place in its playlist. */
  readonly #at = new Map<string, { rendition: string; index: number | null }>();

  /** Files the store holds, as far as this session knows. */
  #stored = new Set<string>();
  readonly #queued = new Set<string>();
  readonly #pending = new Map<string, Pending>();
  #pendingBytes = 0;
  #pendingFull = false;
  readonly #storages = new Set<KeepSegmentStorage>();
  #held: string[] = [];

  #written = 0;
  #writtenBytes = 0;
  #fromStore = 0;
  #refused = 0;

  constructor(o: KeepSessionOptions) {
    this.#keeper = o.keeper;
    this.#root = o.root;
    this.#minimum = o.minimumSeconds;
    this.sha256 = o.sha256;
    this.#log = o.log ?? (() => {});
    this.#onState = o.onState ?? (() => {});
  }

  /** Read what the store holds of the video, and mark it as playing (never evicted while it plays). */
  async start(): Promise<void> {
    this.#removalMark = this.#keeper.removalMark(this.#root);
    const release = await this.#keeper.protect(this.#root);
    if (this.#closed) {
      release();
      return;
    }
    this.#release = release;
    try {
      this.#stored = await this.#keeper.storedShas(this.#root);
      const v = await this.#keeper.video(this.#root);
      if (v !== null) {
        this.#held = v.renditions.filter((r) => r.state === 'held').map((r) => r.id);
        this.#log(`keep: ${v.files} file(s) of this video kept here (${v.reasons.join(', ')}); held: ${this.#held.join(', ') || 'none'}`);
      }
    } catch (e) {
      this.#setState('failed', `the keep store cannot be read: ${message(e)}`);
    }
  }

  /** What the verified hash list says (before anything is written). */
  learnList(list: KeepList): void {
    this.#video = list.video;
    const shared = [this.#root];
    for (const f of list.files) {
      if (!SHA.test(f.sha256) || !ORDER.includes(f.role as FileRole) || f.role === 'hashlist') continue;
      this.#roles.set(f.sha256, f.role as FileRole);
      if (f.role !== 'init' && f.role !== 'segment' && !shared.includes(f.sha256)) shared.push(f.sha256);
    }
    this.#shared = shared;
    for (const r of list.renditions) {
      if (r.swarm === null) continue;
      this.#bySwarm.set(r.swarm, r.id);
      this.#swarmOf.set(r.id, r.swarm);
    }
    this.#flush();
  }

  /** What a verified media playlist of `rendition` holds. */
  learnPlaylist(text: string, rendition: string | null): void {
    if (rendition === null || this.#layout.has(rendition)) return;
    const layout = playlistLayout(text);
    this.#layout.set(rendition, layout);
    if (layout.init !== null) this.#at.set(layout.init, { rendition, index: null });
    layout.segments.forEach((sha, index) => {
      if (!this.#at.has(sha)) this.#at.set(sha, { rendition, index });
    });
  }

  /** Count what `el` plays: forward progress at most a few seconds at a time, nothing for a seek. */
  attach(el: PlayClockElement): void {
    let last = el.currentTime;
    const onTime = (): void => {
      const t = el.currentTime;
      const d = t - last;
      last = t;
      if (!el.seeking && d > 0 && d < 2 * Math.max(1, el.playbackRate)) this.#addPlayed(d);
    };
    const onSeek = (): void => {
      last = el.currentTime;
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('seeking', onSeek);
    el.addEventListener('seeked', onSeek);
    this.#detach = () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('seeking', onSeek);
      el.removeEventListener('seeked', onSeek);
    };
  }

  #addPlayed(seconds: number): void {
    if (this.#closed) return;
    this.#played += seconds;
    if (this.#state === 'waiting' && this.#played >= this.#minimum) {
      this.#setState('keeping', `${this.#minimum} s played`);
      void this.#keeper.touch(this.#root).catch(() => {});
      this.#flush();
    }
  }

  #setState(state: KeepState, why?: string): void {
    if (this.#state === state) return;
    this.#state = state;
    this.#log(`keep: ${state}${why ? ` (${why})` : ''}`);
    this.#onState(state, why);
  }

  /** Write everything held in RAM for the video, once keeping (and the hash list is known). */
  #flush(): void {
    if (this.#state !== 'keeping' || this.#video === null || this.#closed) return;
    const pending = [...this.#pending.values()].sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
    this.#pending.clear();
    this.#pendingBytes = 0;
    for (const p of pending) this.#write(p);
    for (const s of this.#storages) for (const it of s.items()) this.#write({ sha256: it.sha256, bytes: it.bytes, role: 'segment' });
  }

  /** A file the session fetched: written when keeping, held in RAM before the minimum. */
  #arrived(p: Pending): void {
    if (this.#closed || this.#stored.has(p.sha256) || this.#queued.has(p.sha256)) return;
    if (this.#state === 'keeping' && this.#video !== null) {
      this.#write(p);
      return;
    }
    if (this.#state !== 'waiting' && this.#state !== 'keeping') return;
    if (this.#pending.has(p.sha256)) return;
    if (this.#pendingBytes + p.bytes.byteLength > PENDING_MAX_BYTES) {
      if (!this.#pendingFull) this.#log(`keep: over ${PENDING_MAX_BYTES / BYTES_PER_MIB} MiB held before the minimum; later files are not held`);
      this.#pendingFull = true;
      return;
    }
    this.#pending.set(p.sha256, p);
    this.#pendingBytes += p.bytes.byteLength;
  }

  /** Renditions the store would hold whole with `sha` stored too (NFX-18 §1). */
  #completes(sha: string, rendition: string | null): { id: string; members: string[] }[] {
    const ids = rendition !== null ? [rendition] : [...this.#layout.keys()];
    const out: { id: string; members: string[] }[] = [];
    for (const id of ids) {
      if (this.#held.includes(id)) continue;
      const lay = this.#layout.get(id);
      if (!lay) continue;
      const members = [...this.#shared, ...(lay.init === null ? [] : [lay.init]), ...lay.segments];
      if (members.every((m) => m === sha || this.#stored.has(m))) out.push({ id, members });
    }
    return out;
  }

  #write(p: Pending): void {
    const video = this.#video;
    if (video === null || this.#stored.has(p.sha256) || this.#queued.has(p.sha256)) return;
    this.#queued.add(p.sha256);
    const rendition = p.role === 'init' || p.role === 'segment' ? (this.#at.get(p.sha256)?.rendition ?? null) : null;
    void this.#keeper
      .enqueue(async (): Promise<PutResult | null> => {
        if (this.#state !== 'keeping') return null;
        if (this.#keeper.removedSince(this.#root, this.#removalMark)) {
          this.#setState('removed', 'the page removed this video from the store');
          return null;
        }
        return this.#keeper.put({
          root: this.#root,
          video,
          sha256: p.sha256,
          role: p.role,
          rendition,
          bytes: p.bytes,
          reason: 'watched',
          completes: this.#completes(p.sha256, rendition),
        });
      })
      .then(
        (r) => {
          this.#queued.delete(p.sha256);
          if (r === null) return;
          switch (r.kind) {
            case 'stored':
              this.#stored.add(p.sha256);
              this.#written += 1;
              this.#writtenBytes += p.bytes.byteLength;
              this.#held = r.renditions.filter((x) => x.state === 'held').map((x) => x.id);
              return;
            case 'already':
              this.#stored.add(p.sha256);
              return;
            case 'full':
              this.#setState('full', 'the keep store is at its cap, and nothing in it may be removed');
              return;
            case 'refused':
              this.#log(`keep: ${p.sha256.slice(0, 12)}… is not the file it was said to be; not kept`);
              return;
          }
        },
        (e: unknown) => {
          this.#queued.delete(p.sha256);
          this.#setState('failed', `a write failed: ${message(e)}`);
        },
      );
  }

  /**
   * `sha` from the store, checked again, or null; bytes that fail their sha256 are dropped and
   * counted. Bytes `verify` refuses (a request's own check, such as a hash list's binding to a
   * manifest) are a miss for that request only: they are the file, and stay.
   */
  async readFile(sha: string, verify?: (bytes: Uint8Array) => boolean): Promise<Uint8Array | null> {
    if (!this.#stored.has(sha)) return null;
    let got: { bytes: Uint8Array | null; refused: boolean };
    try {
      got = await this.#keeper.read(this.#root, sha);
    } catch (e) {
      this.#log(`keep: reading ${sha.slice(0, 12)}…: ${message(e)}`);
      return null;
    }
    if (got.bytes === null) {
      if (got.refused) this.#refusedFile(sha);
      else this.#stored.delete(sha);
      return null;
    }
    if (verify && !verify(got.bytes)) {
      this.#log(`keep: the stored ${sha.slice(0, 12)}… is not what this request asks for; not used here`);
      return null;
    }
    this.#fromStore += 1;
    return got.bytes;
  }

  #refusedFile(sha: string): void {
    this.#stored.delete(sha);
    this.#refused += 1;
    this.#log(`keep: the stored copy of ${sha.slice(0, 12)}… did not verify; dropped, to be fetched again`);
    void this.#keeper.video(this.#root).then(
      (v) => {
        this.#held = v === null ? [] : v.renditions.filter((r) => r.state === 'held').map((r) => r.id);
      },
      () => {},
    );
  }

  // ---- FileProvider ----

  async get(want: FileWant, verify: (bytes: Uint8Array) => boolean, _signal: AbortSignal): Promise<Uint8Array | null> {
    if (this.#closed) return null;
    const ram = this.#pending.get(want.sha256)?.bytes ?? this.#inStorages(want.sha256);
    if (ram && verify(ram)) return ram;
    return this.readFile(want.sha256, verify);
  }

  delivered(want: FileWant, bytes: Uint8Array, _source: string): void {
    // With the mesh, segments come through the engine's storage instead.
    if (want.role === 'segment' && this.meshOn) return;
    this.#arrived({ sha256: want.sha256, bytes, role: want.role });
  }

  #inStorages(sha: string): Uint8Array | null {
    for (const s of this.#storages) {
      const b = s.bySha(sha);
      if (b !== null) return b;
    }
    return null;
  }

  // ---- for the engine's storage ----

  /** A new storage for the engine (`customSegmentStorageFactory`). */
  segmentStorage(): SegmentStorage {
    const s = new KeepSegmentStorage(this);
    this.#storages.add(s);
    return s;
  }

  storageGone(s: KeepSegmentStorage): void {
    this.#storages.delete(s);
  }

  /** Where the segment `sha` is in the session's playlists, or null. */
  segmentAt(sha: string): { rendition: string; index: number } | null {
    const at = this.#at.get(sha);
    return at && at.index !== null ? { rendition: at.rendition, index: at.index } : null;
  }

  swarmOf(rendition: string): string | null {
    return this.#swarmOf.get(rendition) ?? null;
  }

  /** The sha256 of segment `index` of the stream `swarm`, or null. */
  shaAt(swarm: string, index: number): string | null {
    const r = this.#bySwarm.get(swarm);
    return r === undefined ? null : (this.#layout.get(r)?.segments[index] ?? null);
  }

  /** The segments of `swarm` the store holds, when its rendition is held whole (announced, NFX-18 §4). */
  heldSegments(swarm: string): number[] {
    const r = this.#bySwarm.get(swarm);
    if (r === undefined || !this.#held.includes(r)) return [];
    const lay = this.#layout.get(r);
    if (!lay) return [];
    const out: number[] = [];
    lay.segments.forEach((sha, i) => {
      if (this.#stored.has(sha)) out.push(i);
    });
    return out;
  }

  onDisk(sha: string): boolean {
    return this.#stored.has(sha);
  }

  /** A segment the engine stored, verified as one of the session's playlists': held before the minimum, written after. */
  segmentStored(sha: string, bytes: Uint8Array): void {
    this.#arrived({ sha256: sha, bytes, role: 'segment' });
  }

  note(m: string): void {
    this.#log(m);
  }

  stats(): KeepStats {
    return {
      state: this.#state,
      playedSeconds: Math.round(this.#played * 10) / 10,
      minimumSeconds: this.#minimum,
      written: this.#written,
      writtenBytes: this.#writtenBytes,
      fromStore: this.#fromStore,
      refused: this.#refused,
      held: [...this.#held],
    };
  }

  /** The session is over: nothing more is kept, nothing kept is deleted. Writes already queued finish. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detach?.();
    this.#detach = null;
    this.#pending.clear();
    this.#pendingBytes = 0;
    const release = this.#release;
    this.#release = null;
    void this.#keeper.idle().then(
      () => release?.(),
      () => release?.(),
    );
  }
}

interface Item {
  segmentId: number;
  streamSwarmId: string;
  data: ArrayBuffer;
  sha256: string;
  startTime: number;
  endTime: number;
  streamType: StreamType;
}

/** The engine's default RAM limit when the page sets none, as its own memory storage picks it. */
function defaultLimitMiB(): number {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua) || (/Android/.test(ua) && /; wv\)/.test(ua))) return 1024;
  if (/Android/.test(ua)) return 2048;
  return 4096;
}

/**
 * The engine's segment storage while keeping: its RAM part behaves as the engine's own
 * `SegmentMemoryStorage` (the same limit, the same eviction behind the playhead, the same
 * usage), and the store stands behind it.
 */
export class KeepSegmentStorage implements SegmentStorage {
  readonly #keep: KeepSession;
  readonly #items = new Map<string, Item>();
  #usage = 0;
  #limitMiB = 4096;
  #playback: { position: number; rate: number } | null = null;
  #requested = false;
  #main: StreamConfig | null = null;
  #secondary: StreamConfig | null = null;
  #cb: ((streamSwarmId: string) => void) | undefined;
  #strays = 0;

  constructor(keep: KeepSession) {
    this.#keep = keep;
  }

  async initialize(core: CommonCoreConfig, main: StreamConfig, secondary: StreamConfig): Promise<void> {
    this.#limitMiB = core.segmentMemoryStorageLimit || defaultLimitMiB();
    this.#main = main;
    this.#secondary = secondary;
  }

  onPlaybackUpdated(position: number, rate: number): void {
    this.#playback = { position, rate };
  }

  onSegmentRequested(): void {
    this.#requested = true;
  }

  async storeSegment(
    _swarmId: string,
    streamSwarmId: string,
    segmentId: number,
    data: ArrayBuffer,
    startTime: number,
    endTime: number,
    streamType: StreamType,
    isLiveStream: boolean,
  ): Promise<void> {
    const bytes = new Uint8Array(data);
    const sha = this.#keep.sha256(bytes);
    // Placed by its own bytes: the engine passes the stream last requested, which need not be
    // the segment's own.
    const at = this.#keep.segmentAt(sha);
    if (at === null) {
      if (this.#strays++ === 0) this.#keep.note('keep: the engine stored bytes that are no segment of the session\'s playlists; not kept');
      return;
    }
    const swarm = this.#keep.swarmOf(at.rendition) ?? streamSwarmId;
    const id = swarm === streamSwarmId && at.index !== segmentId ? segmentId : at.index;
    this.#clear(isLiveStream, data.byteLength);
    const k = `${swarm}|${id}`;
    const old = this.#items.get(k);
    if (old) this.#usage -= old.data.byteLength;
    this.#items.set(k, { segmentId: id, streamSwarmId: swarm, data, sha256: sha, startTime, endTime, streamType });
    this.#usage += data.byteLength;
    this.#keep.segmentStored(sha, bytes);
    this.#cb?.(swarm);
  }

  async getSegmentData(_swarmId: string, streamSwarmId: string, segmentId: number): Promise<ArrayBuffer | undefined> {
    const it = this.#items.get(`${streamSwarmId}|${segmentId}`);
    if (it) return it.data;
    const sha = this.#keep.shaAt(streamSwarmId, segmentId);
    if (sha === null || !this.#keep.onDisk(sha)) return undefined;
    const bytes = await this.#keep.readFile(sha);
    if (bytes === null) {
      // Gone, or did not verify: no longer held, and fetched as any missing segment.
      this.#cb?.(streamSwarmId);
      return undefined;
    }
    const buf = bytes.buffer;
    return buf instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength ? buf : bytes.slice().buffer;
  }

  getUsage(): { totalCapacity: number; usedCapacity: number } {
    if (!this.#requested || this.#playback === null) return { totalCapacity: this.#limitMiB, usedCapacity: this.#usage / BYTES_PER_MIB };
    const position = this.#playback.position;
    let used = 0;
    for (const { endTime, data } of this.#items.values()) if (position <= endTime) used += data.byteLength;
    return { totalCapacity: this.#limitMiB, usedCapacity: used / BYTES_PER_MIB };
  }

  hasSegment(_swarmId: string, streamSwarmId: string, segmentId: number): boolean {
    if (this.#items.has(`${streamSwarmId}|${segmentId}`)) return true;
    const sha = this.#keep.shaAt(streamSwarmId, segmentId);
    return sha !== null && this.#keep.onDisk(sha);
  }

  getStoredSegmentIds(_swarmId: string, streamSwarmId: string): number[] {
    const ids = new Set<number>();
    for (const it of this.#items.values()) if (it.streamSwarmId === streamSwarmId) ids.add(it.segmentId);
    for (const i of this.#keep.heldSegments(streamSwarmId)) ids.add(i);
    return [...ids];
  }

  setSegmentChangeCallback(cb: ((streamSwarmId: string) => void) | undefined): void {
    this.#cb = cb;
  }

  destroy(): void {
    this.#items.clear();
    this.#usage = 0;
    this.#cb = undefined;
    this.#keep.storageGone(this);
  }

  /** The segments held in RAM. */
  *items(): Iterable<{ sha256: string; bytes: Uint8Array }> {
    for (const it of this.#items.values()) yield { sha256: it.sha256, bytes: new Uint8Array(it.data) };
  }

  bySha(sha: string): Uint8Array | null {
    for (const it of this.#items.values()) if (it.sha256 === sha) return new Uint8Array(it.data);
    return null;
  }

  /** As the engine's memory storage: past the limit, segments behind the playhead go, oldest first. */
  #clear(isLive: boolean, size: number): void {
    if (this.#playback === null || this.#main === null || this.#secondary === null) return;
    const over = (): boolean => (this.#usage + size) / BYTES_PER_MIB > this.#limitMiB;
    if (!over() && !isLive) return;
    const position = this.#playback.position;
    const affected = new Set<string>();
    for (const it of [...this.#items.values()].sort((a, b) => a.startTime - b.startTime)) {
      if (position <= it.endTime) continue;
      if (isLive) {
        const cfg = it.streamType === 'main' ? this.#main : this.#secondary;
        if (!(position > cfg.highDemandTimeWindow + it.endTime)) continue;
      }
      this.#items.delete(`${it.streamSwarmId}|${it.segmentId}`);
      this.#usage -= it.data.byteLength;
      affected.add(it.streamSwarmId);
      if (!over() && !isLive) break;
    }
    for (const s of affected) this.#cb?.(s);
  }
}
