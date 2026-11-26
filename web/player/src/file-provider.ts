/**
 * The file channel as a source of start-up files (NFX-10 §6.10; decision record 0112 point 8):
 * a session's tier between the keep store and HTTP. It holds one `FilePeer` per peer session
 * key (from stream-room connections and the video room alike) and asks them for files the way
 * §6.10 "Choosing peers" says:
 *
 * - one peer at a time per file, the file built from that peer's bytes only; a second peer
 *   joins a request that has had no byte for 2 s, at most 3 at once; a peer that has sent no
 *   byte for 4 s is given up on for that file;
 * - after `missing` it moves on; after `busy` too, asking that peer again no sooner than 5 s;
 * - first the peers that delivered a file that verified, then (for a rendition's playlist or
 *   init) the peers whose `have` names the rendition, then the rest at random;
 * - with no peer at all it waits for a first one until `firstPeerWaitMs` after the session
 *   began (`peerWaitMs`, §6.10 "Starting from a manifest"), and after that hands on at once
 *   (null), so a page whose origins rescue it pays that wait once, not per file;
 * - when every peer has failed a file, it asks for more peers (`morePeers`: the video room
 *   offers, §6.9) and waits for a new one or 10 s, then tries again; a tier that is not the
 *   last with a chance hands on (null) after one such wait;
 * - bytes that do not verify drop the peer for the session (NFX-05 §4): its file channel
 *   closes, `onMismatch` is told, and it is never asked again;
 * - every start-up file it delivered, or another tier did (`delivered`), is kept for the
 *   session (at most `CACHE_BYTES`), so hls.js loading a file the session already probed costs
 *   nothing (§6.10 "Starting from a manifest", step 5);
 * - a video-room connection closes 30 s after our last request on it, with none open (§6.9
 *   "Ending a connection"); a stream-room one lives as long as its connection. One file
 *   channel per peer: a stream-room one replaces a video-room one, which closes once idle.
 *
 * Segments are declined: they never travel on the file channel. So is every file while no
 * peer is ready and the session is in no video room (`findsPeers` false): its peers then
 * come only from stream rooms, joined once the hash list has verified, and a page with
 * origins must not wait for them. The types are those of
 * ./session-sources.ts's `FileProvider` (structurally: this module needs no more of them).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FileChannelStats } from './api';
import type { Have } from './file-channel';
import { type Answer, FilePeer } from './file-peer';

/** What this tier reads of `FileWant` (./session-sources.ts). */
export interface WantLike {
  readonly path: string;
  readonly sha256: string;
  readonly role: string;
  readonly rendition: string | null;
  readonly maxBytes: number;
  readonly lastChance: boolean;
}

export const FILE_CHANNEL_DEADLINE_MS = 4_000;
export const JOIN_AFTER_MS = 2_000;
export const STALL_MS = 4_000;
export const MAX_AT_ONCE = 3;
export const BUSY_WAIT_MS = 5_000;
export const NEW_PEER_WAIT_MS = 10_000;
export const VIDEO_IDLE_MS = 30_000;
/** Start-up files kept for the session, in bytes at most (the hash list may be 16 MiB). */
export const CACHE_BYTES = 48 * 1024 * 1024;

/** Which room a file channel's connection is in. */
export type RoomKind = 'stream' | 'video';


export interface FileChannelProviderOptions {
  /** The hash list's root: asked of each peer in `list` as soon as it is ready. */
  root: string;
  /** How long after the session began a file waits for a first peer, in ms. Default 4000. */
  firstPeerWaitMs?: number;
  /** Whether the session finds peers itself (it is in a video room). Default true. */
  findsPeers?: boolean;
  /** Ask for more peers (the video room offers to more of its members). */
  morePeers?: () => void;
  /** Bytes from this peer did not verify: close every connection to it. */
  onMismatch?: (peer: string) => void;
  log?: (m: string) => void;
  now?: () => number;
  random?: () => number;
  /** For tests: the waits, in ms (`sleep(ms, signal)` resolves early when it aborts). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export class FileChannelProvider {
  readonly name = 'file-channel:';
  readonly deadlineMs = FILE_CHANNEL_DEADLINE_MS;
  readonly #o: Required<FileChannelProviderOptions>;
  readonly #firstPeerBy: number;
  /** Peers whose `list` has been answered (`have` or not). */
  readonly #listed = new Set<string>();
  readonly #peers = new Map<string, FilePeer>();
  readonly #rooms = new Map<string, RoomKind>();
  readonly #cache = new Map<string, Uint8Array>();
  #cached = 0;
  #inFlight = 0;
  #sweep: ReturnType<typeof setInterval> | undefined;
  #destroyed = false;
  readonly stats: FileChannelStats = { peers: 0, files: 0, bytes: 0, videoRoom: false };
  readonly #delivered = new Set<string>();
  readonly #dropped = new Set<string>();
  readonly #haves = new Map<string, Have>();
  /** Peers whose `have` is ignored for the session: it named a rendition, then `missing`. */
  readonly #haveIgnored = new Set<string>();
  readonly #busyUntil = new Map<string, number>();
  /** The rendition of each media playlist, by sha256 (from the verified hash list). */
  #playlistRendition = new Map<string, string>();
  readonly #newPeer = new Set<() => void>();

  constructor(o: FileChannelProviderOptions) {
    this.#o = {
      firstPeerWaitMs: FILE_CHANNEL_DEADLINE_MS,
      findsPeers: true,
      morePeers: () => {},
      onMismatch: () => {},
      log: () => {},
      now: () => Date.now(),
      random: Math.random,
      sleep: realSleep,
      ...o,
    };
    this.#firstPeerBy = this.#o.now() + this.#o.firstPeerWaitMs;
  }

  /** A file channel of a connection with `peer` in a `room` (./signal-nostr.ts `onFileChannel`). */
  add(peer: string, channel: ConstructorParameters<typeof FilePeer>[1], room: RoomKind = 'stream'): void {
    if (this.#destroyed || this.#dropped.has(peer)) {
      channel.close();
      return;
    }
    const held = this.#peers.get(peer);
    if (held !== undefined && !held.closed) {
      // One per peer. A stream-room channel lives as long as its connection, so it replaces a
      // video-room one, which finishes what it carries; any other second channel is closed.
      if (!(room === 'stream' && this.#rooms.get(peer) === 'video')) {
        channel.close();
        return;
      }
      held.closeWhenIdle();
    }
    const p = new FilePeer(peer, channel, (why) => this.#o.log(`file channel ${peer.slice(0, 12)}…: ${why}`));
    this.#peers.set(peer, p);
    this.#rooms.set(peer, room);
    if (room === 'video' && this.#sweep === undefined) this.#sweep = setInterval(() => this.sweep(), 5_000);
    void p.ready.then(
      () => {
        if (this.#peers.get(peer) !== p) return;
        for (const f of [...this.#newPeer]) f();
        void p.list(this.#o.root).then((a) => {
          if (this.#peers.get(peer) !== p) return;
          if (a.t === 'have') this.#haves.set(peer, a.have);
          this.#listed.add(peer);
          for (const f of [...this.#newPeer]) f();
        });
      },
      () => {},
    );
  }

  /** Whether a file channel with `peer` is open (the video room offers to no such peer). */
  has(peer: string): boolean {
    const p = this.#peers.get(peer);
    return p !== undefined && !p.closed;
  }

  /** Whether a file is wanted now (the video room offers only then, §6.9). */
  get wanting(): boolean {
    return this.#inFlight > 0;
  }

  /** Close the video-room channels idle for 30 s with no request open (a timer runs it every 5 s). */
  sweep(): void {
    const now = Date.now();
    for (const [k, p] of this.#peers) {
      if (this.#rooms.get(k) === 'video' && !p.busy && now - p.lastActivity >= VIDEO_IDLE_MS) p.close();
    }
    for (const [k, p] of this.#peers) if (p.closed) this.#forget(k);
    if (![...this.#rooms.values()].includes('video') && this.#sweep !== undefined) {
      clearInterval(this.#sweep);
      this.#sweep = undefined;
    }
  }

  #forget(k: string): void {
    this.#peers.delete(k);
    this.#rooms.delete(k);
    this.#haves.delete(k);
    this.#listed.delete(k);
  }

  /** Resolves once every ready peer has answered `list`, or after `ms`, or when `signal` aborts. */
  async haveFromAll(ms: number, signal: AbortSignal): Promise<void> {
    const until = this.#o.now() + ms;
    for (;;) {
      const waiting = [...this.#peers.keys()].some((k) => this.#live(k) && !this.#listed.has(k));
      const left = until - this.#o.now();
      if (!waiting || left <= 0 || signal.aborted) return;
      await this.#waitForPeer(Math.min(left, 250), signal);
    }
  }

  /**
   * The renditions to offer (§6.10 "Which levels"), of `ids`: those a connected peer's `have`
   * names in `whole`, or, when none names any there, in `part`. The page offers each only once
   * its playlist and init have verified.
   */
  levels(ids: readonly string[]): string[] {
    const haves = [...this.haves().values()];
    const whole = ids.filter((id) => haves.some((h) => h.whole.includes(id)));
    return whole.length > 0 ? whole : ids.filter((id) => haves.some((h) => h.part.includes(id)));
  }

  /**
   * Whether a peer is ready, waiting for a first one until the first-peer wait ends (none when
   * the session finds no peers itself).
   */
  async firstPeer(signal: AbortSignal): Promise<boolean> {
    while (this.ready === 0 && this.#o.findsPeers && !signal.aborted && !this.#destroyed) {
      const left = this.#firstPeerBy - this.#o.now();
      if (left <= 0) break;
      await this.#waitForPeer(left, signal);
    }
    return this.ready > 0;
  }

  /** Resolves when a new peer is ready, after `ms`, or when `signal` aborts. */
  waitForPeer(ms: number, signal: AbortSignal): Promise<void> {
    return this.#waitForPeer(ms, signal);
  }

  /** Told of a file another tier delivered (./session-sources.ts): kept, if a start-up file. */
  delivered(want: WantLike, bytes: Uint8Array): void {
    this.#keep(want, bytes);
  }

  #keep(want: WantLike, bytes: Uint8Array): void {
    if (want.role === 'segment' || this.#cache.has(want.sha256) || this.#cached + bytes.byteLength > CACHE_BYTES) return;
    this.#cache.set(want.sha256, bytes);
    this.#cached += bytes.byteLength;
  }

  /** What the verified hash list says: the rendition each media playlist (by sha256) is of. */
  learnPlaylists(bySha: ReadonlyMap<string, string>): void {
    this.#playlistRendition = new Map(bySha);
  }

  /** Every ready peer's `have`, not ignored ones: what "Which levels" reads. */
  haves(): Map<string, Have> {
    const out = new Map<string, Have>();
    for (const [k, h] of this.#haves) if (!this.#haveIgnored.has(k) && this.#live(k)) out.set(k, h);
    return out;
  }

  /** Peers ready now. */
  get ready(): number {
    let n = 0;
    for (const k of this.#peers.keys()) if (this.#live(k)) n += 1;
    return n;
  }

  /** The stats now (`MeshStats.files`). */
  snapshot(videoRoom: boolean): FileChannelStats {
    return { ...this.stats, peers: this.ready, videoRoom };
  }

  declines(want: WantLike): boolean {
    return want.role === 'segment' || (!this.#o.findsPeers && this.ready === 0);
  }

  /** Close every file channel (the session ended). */
  destroy(): void {
    this.#destroyed = true;
    if (this.#sweep !== undefined) clearInterval(this.#sweep);
    this.#sweep = undefined;
    for (const p of this.#peers.values()) p.close();
    this.#peers.clear();
    this.#rooms.clear();
    this.#cache.clear();
    this.#cached = 0;
    for (const f of [...this.#newPeer]) f();
  }

  #live(k: string): boolean {
    const p = this.#peers.get(k);
    return p !== undefined && !p.closed && p.flags !== null && (p.flags & 1) === 1 && !this.#dropped.has(k);
  }

  /** The peers to ask for `want`, best first, of those not in `tried`. */
  #order(want: WantLike, tried: ReadonlySet<string>): string[] {
    const now = this.#o.now();
    const rendition = want.rendition ?? (want.role === 'playlist' ? (this.#playlistRendition.get(want.sha256) ?? null) : null);
    const names = (k: string): boolean => {
      if (rendition === null || this.#haveIgnored.has(k)) return false;
      const h = this.#haves.get(k);
      return h !== undefined && (h.whole.includes(rendition) || h.part.includes(rendition));
    };
    const keys = [...this.#peers.keys()].filter((k) => this.#live(k) && !tried.has(k) && (this.#busyUntil.get(k) ?? 0) <= now);
    const rank = (k: string): number => (this.#delivered.has(k) ? 0 : names(k) ? 1 : 2);
    const shuffled = keys.map((k) => ({ k, r: rank(k), x: this.#o.random() }));
    shuffled.sort((a, b) => a.r - b.r || a.x - b.x);
    return shuffled.map((s) => s.k);
  }

  /** Resolves when a new peer is ready, after `ms`, or when `signal` aborts. */
  #waitForPeer(ms: number, signal: AbortSignal): Promise<void> {
    const ctl = new AbortController();
    const stop = (): void => ctl.abort();
    this.#newPeer.add(stop);
    signal.addEventListener('abort', stop, { once: true });
    return this.#o.sleep(ms, ctl.signal).finally(() => {
      this.#newPeer.delete(stop);
      signal.removeEventListener('abort', stop);
    });
  }

  async get(want: WantLike, verify: (bytes: Uint8Array) => boolean, signal: AbortSignal): Promise<Uint8Array | null> {
    if (this.declines(want) || this.#destroyed) return null;
    const held = this.#cache.get(want.sha256);
    if (held !== undefined) {
      if (verify(held)) return held;
      this.#cache.delete(want.sha256);
      this.#cached -= held.byteLength;
    }
    this.#inFlight += 1;
    try {
      const tried = new Set<string>();
      let waited = false;
      while (!signal.aborted && !this.#destroyed) {
        if (this.ready === 0) {
          // No peer yet: wait for one, until the session's first-peer wait ends (or for good
          // when this is the last tier with a chance), asking the video room for more.
          const left = want.lastChance ? NEW_PEER_WAIT_MS : this.#firstPeerBy - this.#o.now();
          if (left <= 0) return null;
          this.#o.morePeers();
          await this.#waitForPeer(left, signal);
          if (this.ready === 0 && !want.lastChance) return null;
          continue;
        }
        const got = await this.#round(want, verify, signal, tried);
        if (got !== null) {
          this.stats.files += 1;
          this.stats.bytes += got.byteLength;
          this.#keep(want, got);
          return got;
        }
        if (signal.aborted || this.#destroyed) return null;
        // Every peer has failed it: more peers, a new one or 10 s, then again.
        if (waited && !want.lastChance) return null;
        waited = true;
        this.#o.morePeers();
        await this.#waitForPeer(NEW_PEER_WAIT_MS, signal);
        // A peer tried before may be asked again once a round has passed.
        tried.clear();
      }
      return null;
    } finally {
      this.#inFlight -= 1;
    }
  }

  /** One pass over the peers there are now: null when each has failed or none is left. */
  #round(want: WantLike, verify: (bytes: Uint8Array) => boolean, signal: AbortSignal, tried: Set<string>): Promise<Uint8Array | null> {
    return new Promise<Uint8Array | null>((resolve) => {
      const ctl = new AbortController();
      let running = 0;
      let done = false;
      let lastByte = this.#o.now();
      const finish = (v: Uint8Array | null): void => {
        if (done) return;
        done = true;
        ctl.abort();
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onAbort = (): void => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      const start = (): boolean => {
        if (done || running >= MAX_AT_ONCE) return false;
        const k = this.#order(want, tried)[0];
        if (k === undefined) return false;
        tried.add(k);
        running += 1;
        void this.#ask(k, want, verify, ctl.signal, () => {
          lastByte = this.#o.now();
        }).then((bytes) => {
          running -= 1;
          if (done) return;
          if (bytes !== null) return finish(bytes);
          if (!start() && running === 0) finish(null);
        });
        return true;
      };
      if (!start()) return finish(null);
      // Every 2 s without a byte from any peer asked: one more joins (at most 3 at once).
      const tick = async (): Promise<void> => {
        while (!done) {
          await this.#o.sleep(JOIN_AFTER_MS, ctl.signal);
          if (done) return;
          if (this.#o.now() - lastByte >= JOIN_AFTER_MS) start();
        }
      };
      void tick();
    });
  }

  /** Ask `k` for `want`: its bytes, verified, or null (and why, in the peer's books). */
  async #ask(k: string, want: WantLike, verify: (bytes: Uint8Array) => boolean, signal: AbortSignal, onByte: () => void): Promise<Uint8Array | null> {
    const p = this.#peers.get(k);
    if (p === undefined) return null;
    const ctl = new AbortController();
    const stop = (): void => ctl.abort();
    signal.addEventListener('abort', stop, { once: true });
    let last = this.#o.now();
    // Given up on after 4 s without a byte.
    const watch = (async (): Promise<void> => {
      while (!ctl.signal.aborted) {
        await this.#o.sleep(1_000, ctl.signal);
        if (!ctl.signal.aborted && this.#o.now() - last >= STALL_MS) {
          this.#o.log(`${this.name} ${want.path}: nothing from ${k.slice(0, 12)}… for 4 s`);
          ctl.abort();
        }
      }
    })();
    let a: Answer;
    try {
      a = await p.get(want.sha256, want.maxBytes, ctl.signal, () => {
        last = this.#o.now();
        onByte();
      });
    } finally {
      ctl.abort();
      signal.removeEventListener('abort', stop);
      await watch;
    }
    switch (a.t) {
      case 'file':
        if (!verify(a.bytes)) {
          this.#drop(k, `${want.path}: bytes that do not verify`);
          return null;
        }
        this.#delivered.add(k);
        return a.bytes;
      case 'missing': {
        const rendition = want.role === 'playlist' ? (this.#playlistRendition.get(want.sha256) ?? null) : want.role === 'init' ? want.rendition : null;
        const h = this.#haves.get(k);
        if (rendition !== null && h !== undefined && (h.whole.includes(rendition) || h.part.includes(rendition))) this.#haveIgnored.add(k);
        return null;
      }
      case 'busy':
        this.#busyUntil.set(k, this.#o.now() + BUSY_WAIT_MS);
        return null;
      default:
        return null;
    }
  }

  #drop(k: string, why: string): void {
    this.#dropped.add(k);
    this.#o.log(`${this.name} dropped ${k.slice(0, 12)}… for the session: ${why}`);
    this.#peers.get(k)?.close();
    this.#forget(k);
    try {
      this.#o.onMismatch(k);
    } catch (e) {
      globalThis.reportError?.(e);
    }
  }
}
