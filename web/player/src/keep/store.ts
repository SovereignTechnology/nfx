/**
 * Keeping what is watched, in a browser (NFX-18, NFX-10 §7): the store. A kept file is stored
 * by its sha256 under the hash list root it belongs to (NFX-18 §3), never by a name a peer, a
 * transport or a swarm chose. A file's bytes and its index entry are written in one
 * transaction, so neither is ever there without the other. Every read is checked against the
 * sha256 again, before anything plays or serves it: a file that fails is dropped, never
 * returned, so it is fetched again like any missing file.
 *
 * At the cap, videos kept only because they were watched go, the least recently played first,
 * never one a session plays (here, or in another tab of the origin: each video to go is taken
 * first by an exclusive Web Lock asked without waiting, which a tab that plays it holds shared,
 * and kept until the deletion commits). A video kept for another reason (`downloaded`) is never
 * removed to make room, and nothing is removed for a file that would not fit even then: the
 * store says it is full instead.
 *
 * This file is plain logic over a transactional backend (`KeepBackend`): ./idb.ts is
 * IndexedDB, and keep-unit.ts drives it over one in memory. Nothing in a transaction waits for
 * anything but the backend (IndexedDB commits a transaction that waits on anything else), so
 * every sha256 is computed before one starts.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { KeepReason, KeepStore, KeptRendition, KeptVideo } from '../api';

/** What a file is to the hash list (NFX-05 §2), and `hashlist` for the hash list itself. */
export type FileRole = 'hashlist' | 'playlist-master' | 'playlist' | 'init' | 'segment' | 'thumb' | 'subtitle';

export type StoreName = 'videos' | 'files' | 'bytes' | 'meta';
export const STORES: readonly StoreName[] = ['videos', 'files', 'bytes', 'meta'];

/** One transaction's view of the stores. Keys are strings. */
export interface KeepTx {
  get(store: StoreName, key: string): Promise<unknown>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  /** Every key of `store` from `lower` to `upper`, both included, in order. */
  keys(store: StoreName, lower: string, upper: string): Promise<string[]>;
  /** Every value of `store`. */
  values(store: StoreName): Promise<unknown[]>;
}

export interface KeepBackend {
  /**
   * Run `fn` in one transaction over `stores`: all of its writes happen, or none (when `fn`
   * throws, or the backend fails). Resolves with `fn`'s result once the transaction has
   * committed. `fn` may wait only on the `KeepTx` it is given.
   */
  run<T>(stores: readonly StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: KeepTx) => Promise<T>): Promise<T>;
  close(): void;
}

/** Roots taken for removal (`KeeperDeps.claim`), until `release`. */
export interface Claim {
  held: ReadonlySet<string>;
  release: () => void;
}

/** A hold on a root as playing (`KeeperDeps.hold`): `granted` once other tabs see it. */
export interface Hold {
  granted: Promise<void>;
  release: () => void;
}

export interface KeeperDeps {
  sha256: (bytes: Uint8Array) => string;
  /** ms since the epoch */
  now: () => number;
  /**
   * Take each of `roots` for removal unless a tab of this origin plays it, without waiting;
   * the ones taken stay taken until `release`. Without it, every root is taken (no other tab
   * can be seen).
   */
  claim?: (roots: readonly string[]) => Promise<Claim>;
  /** Hold `root` as playing for other tabs to see, until `release`. */
  hold?: (root: string) => Hold;
}

/** How long `protect` waits for other tabs to see a hold before it goes on anyway. */
export const HOLD_WAIT_MS = 3_000;

/** The video record (the `videos` store, by root). */
interface VideoRecord {
  v: 1;
  root: string;
  video: string;
  reasons: KeepReason[];
  renditions: KeptRendition[];
  bytes: number;
  files: number;
  createdAt: number;
  usedAt: number;
}

/** A file's index entry (the `files` store, by `<root>/<sha256>`); its bytes are in `bytes` under the same key. */
interface FileRecord {
  v: 1;
  root: string;
  sha256: string;
  role: FileRole;
  /** The rendition an `init` or `segment` belongs to; null for the files every rendition needs. */
  rendition: string | null;
  size: number;
  storedAt: number;
}

export interface PutFile {
  root: string;
  /** The hash list's `video`. */
  video: string;
  sha256: string;
  role: FileRole;
  rendition: string | null;
  bytes: Uint8Array;
  reason: KeepReason;
  /**
   * Renditions this file may complete: each with every file NFX-18 §1 names for it (the hash
   * list, every playlist, thumb and subtitle file, its init and segments). Each one all of
   * whose files are then stored is recorded `held`, in the same transaction.
   */
  completes?: readonly { id: string; members: readonly string[] }[];
}

export type PutResult =
  | { kind: 'stored'; renditions: KeptRendition[] }
  | { kind: 'already' }
  /** No room: the cap is reached and nothing may be evicted. */
  | { kind: 'full' }
  /** The bytes are not the file: nothing written. */
  | { kind: 'refused' };

/** A read: the bytes, verified; or null, with `refused` when stored bytes failed and were dropped. */
export interface ReadResult {
  bytes: Uint8Array | null;
  refused: boolean;
}

const SHA = /^[0-9a-f]{64}$/;
const key = (root: string, sha: string): string => `${root}/${sha}`;
/** Every key under `root`: `<root>/` then 64 hex, all below `<root>/~`. */
const lower = (root: string): string => `${root}/`;
const upper = (root: string): string => `${root}/~`;

/** Thrown inside a transaction to undo its evictions when the file still would not fit. */
class StillFull extends Error {}

/** The default cap, and the smallest a page may set. */
export const DEFAULT_CAP_BYTES = 2 * 1024 ** 3;
export const MIN_CAP_BYTES = 16 * 1024 ** 2;

function isVideo(v: unknown): v is VideoRecord {
  return typeof v === 'object' && v !== null && (v as VideoRecord).v === 1 && typeof (v as VideoRecord).root === 'string';
}

function isFile(v: unknown): v is FileRecord {
  return typeof v === 'object' && v !== null && (v as FileRecord).v === 1 && typeof (v as FileRecord).sha256 === 'string';
}

function publicVideo(r: VideoRecord): KeptVideo {
  return {
    root: r.root,
    video: r.video,
    reasons: [...r.reasons],
    renditions: r.renditions.map((x) => ({ id: x.id, state: x.state, reasons: [...x.reasons] })),
    bytes: r.bytes,
    files: r.files,
    keptAt: r.createdAt,
    playedAt: r.usedAt,
  };
}

/** The keep store a page opens once (`openKeepStore`) and hands to every session it keeps from. */
export class Keeper implements KeepStore {
  readonly capBytes: number;
  readonly #backend: KeepBackend;
  readonly #deps: KeeperDeps;
  /** Roots a session of this page plays, counted: never evicted. */
  readonly #playing = new Map<string, number>();
  /**
   * How many times the page removed each root, counted once each removal commits: a session
   * that took its mark before a removal keeps nothing more (`removedSince`), and one that
   * starts after it keeps as any other.
   */
  readonly #removals = new Map<string, number>();
  /** Every write, one after another. */
  #queue: Promise<unknown> = Promise.resolve();
  /** No new work is taken (`close`); what is queued still runs. */
  #closing = false;
  /** The backend is closed: nothing more runs. */
  #shut = false;

  constructor(backend: KeepBackend, capBytes: number, deps: KeeperDeps) {
    this.#backend = backend;
    this.capBytes = capBytes;
    this.#deps = deps;
  }

  /**
   * Mark `root` as playing until the returned function is called (idempotent): at once for
   * this page, and for other tabs once they can see it (or after `HOLD_WAIT_MS`), so a store
   * read after this resolves sees no removal another tab started.
   */
  async protect(root: string): Promise<() => void> {
    this.#playing.set(root, (this.#playing.get(root) ?? 0) + 1);
    const hold = this.#deps.hold?.(root) ?? { granted: Promise.resolve(), release: (): void => {} };
    let done = false;
    const release = (): void => {
      if (done) return;
      done = true;
      hold.release();
      const n = (this.#playing.get(root) ?? 1) - 1;
      if (n <= 0) this.#playing.delete(root);
      else this.#playing.set(root, n);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([hold.granted.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, HOLD_WAIT_MS)))]);
    clearTimeout(timer);
    return release;
  }

  /** A mark for `removedSince`: the removals of `root` committed so far. */
  removalMark(root: string): number {
    return this.#removals.get(root) ?? 0;
  }

  /** Whether the page removed `root` after `mark` was taken. */
  removedSince(root: string, mark: number): boolean {
    return this.removalMark(root) > mark;
  }

  /** Run `fn` after every write queued before it. Refused once the store is closing. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('nfx: the keep store is closed'));
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  #check(): void {
    if (this.#closing) throw new Error('nfx: the keep store is closed');
  }

  /**
   * Store `f`, its bytes and its entry in one transaction. Its sha256 is checked first; then,
   * past the cap, videos kept only as watched are evicted, least recently played first, never
   * one playing here or in another tab, nor `f`'s own.
   */
  async put(f: PutFile): Promise<PutResult> {
    // Called from the queue: a write queued before `close` still runs.
    if (this.#shut) throw new Error('nfx: the keep store is closed');
    if (!SHA.test(f.root) || !SHA.test(f.sha256)) return { kind: 'refused' };
    if (this.#deps.sha256(f.bytes) !== f.sha256) return { kind: 'refused' };
    const size = f.bytes.byteLength;
    if (size > this.capBytes) return { kind: 'full' };
    // Videos to go are taken before the transaction (it may wait on nothing else), and kept
    // taken until it has committed.
    const claim = await this.#claimVictims(f.root, size);
    try {
      return await this.#store(f, size, claim);
    } catch (e) {
      if (e instanceof StillFull) return { kind: 'full' };
      throw e;
    } finally {
      claim?.release();
    }
  }

  /** Whether `v` may go to make room for a file of `root`: kept only as watched, and not playing here. */
  #evictable(v: VideoRecord, root: string): boolean {
    return v.root !== root && !this.#playing.has(v.root) && v.reasons.every((r) => r === 'watched');
  }

  /** Least recently played first. */
  static #byUse(a: VideoRecord, b: VideoRecord): number {
    return a.usedAt - b.usedAt || (a.root < b.root ? -1 : 1);
  }

  /**
   * When a file of `size` would pass the cap: the videos that may go for it, taken (`claim`)
   * in eviction order until they would free enough, a video another tab plays left out; none
   * when nothing needs to go. Null only when no `claim` is given (every video may then go).
   */
  async #claimVictims(root: string, size: number): Promise<Claim | null> {
    const claim = this.#deps.claim;
    if (claim === undefined) return null;
    const { usage, videos } = await this.#backend.run(['videos', 'meta'], 'readonly', async (tx) => ({
      usage: await tx.get('meta', 'usage'),
      videos: await tx.values('videos'),
    }));
    const used = typeof usage === 'number' && Number.isFinite(usage) && usage >= 0 ? usage : 0;
    if (used + size <= this.capBytes) return { held: new Set(), release: () => {} };
    const candidates = videos
      .filter(isVideo)
      .filter((v) => this.#evictable(v, root))
      .sort(Keeper.#byUse);
    const held = new Set<string>();
    const releases: (() => void)[] = [];
    let freed = 0;
    for (const v of candidates) {
      if (used - freed + size <= this.capBytes) break;
      const c = await claim([v.root]).catch((): Claim => ({ held: new Set(), release: () => {} }));
      releases.push(c.release);
      if (c.held.has(v.root)) {
        held.add(v.root);
        freed += v.bytes;
      }
    }
    return { held, release: () => releases.forEach((r) => r()) };
  }

  async #store(f: PutFile, size: number, claim: Claim | null): Promise<PutResult> {
    const data = f.bytes.slice().buffer;
    const now = this.#deps.now();
    return this.#backend.run(STORES, 'readwrite', async (tx): Promise<PutResult> => {
      const k = key(f.root, f.sha256);
      if (isFile(await tx.get('files', k))) return { kind: 'already' };
      const meta = await tx.get('meta', 'usage');
      let usage = typeof meta === 'number' && Number.isFinite(meta) && meta >= 0 ? meta : 0;
      if (usage + size > this.capBytes) {
        // Chosen before anything is deleted: when even all of them would not free enough,
        // nothing goes.
        const victims = (await tx.values('videos'))
          .filter(isVideo)
          .filter((v) => this.#evictable(v, f.root) && (claim === null || claim.held.has(v.root)))
          .sort(Keeper.#byUse);
        const going: string[] = [];
        let freeing = 0;
        for (const v of victims) {
          if (usage - freeing + size <= this.capBytes) break;
          going.push(v.root);
          freeing += v.bytes;
        }
        if (usage - freeing + size > this.capBytes) return { kind: 'full' };
        for (const root of going) usage -= await this.#evict(tx, root);
        // A record that said more than its files hold: undo every eviction (the transaction aborts).
        if (usage + size > this.capBytes) throw new StillFull();
      }
      const held = await tx.get('videos', f.root);
      const video: VideoRecord = isVideo(held)
        ? held
        : { v: 1, root: f.root, video: f.video, reasons: [], renditions: [], bytes: 0, files: 0, createdAt: now, usedAt: now };
      if (!video.reasons.includes(f.reason)) video.reasons.push(f.reason);
      if (f.rendition !== null && !video.renditions.some((r) => r.id === f.rendition)) {
        video.renditions.push({ id: f.rendition, state: 'filling', reasons: [f.reason] });
      }
      const file: FileRecord = { v: 1, root: f.root, sha256: f.sha256, role: f.role, rendition: f.rendition, size, storedAt: now };
      await tx.put('bytes', k, data);
      await tx.put('files', k, file);
      video.bytes += size;
      video.files += 1;
      video.usedAt = now;
      for (const c of f.completes ?? []) {
        let all = true;
        for (const m of c.members) {
          if (m !== f.sha256 && !isFile(await tx.get('files', key(f.root, m)))) {
            all = false;
            break;
          }
        }
        if (!all) continue;
        const r = video.renditions.find((x) => x.id === c.id);
        if (r) r.state = 'held';
        else video.renditions.push({ id: c.id, state: 'held', reasons: [f.reason] });
      }
      await tx.put('videos', f.root, video);
      await tx.put('meta', 'usage', usage + size);
      return { kind: 'stored', renditions: video.renditions.map((r) => ({ ...r, reasons: [...r.reasons] })) };
    });
  }

  /** Delete every file of `root` and its record inside `tx`; the bytes freed. */
  async #evict(tx: KeepTx, root: string): Promise<number> {
    let freed = 0;
    for (const k of await tx.keys('files', lower(root), upper(root))) {
      const f = await tx.get('files', k);
      if (isFile(f)) freed += f.size;
      await tx.delete('files', k);
      await tx.delete('bytes', k);
    }
    // Bytes left without an entry (none should be) go too.
    for (const k of await tx.keys('bytes', lower(root), upper(root))) await tx.delete('bytes', k);
    await tx.delete('videos', root);
    return freed;
  }

  /**
   * The file `sha256` of `root`, read and checked again (NFX-18 §3). Bytes that fail are
   * dropped, entry and all, and never returned.
   */
  async read(root: string, sha256: string): Promise<ReadResult> {
    this.#check();
    const k = key(root, sha256);
    const [got, entry] = await this.#backend.run(['bytes', 'files'], 'readonly', async (tx) => [await tx.get('bytes', k), await tx.get('files', k)] as const);
    if (!(got instanceof ArrayBuffer)) {
      // An entry whose bytes are gone (or are not bytes) goes too, so the file is stored again
      // when it next arrives.
      if (isFile(entry)) await this.drop(root, sha256);
      return { bytes: null, refused: false };
    }
    const bytes = new Uint8Array(got);
    if (this.#deps.sha256(bytes) === sha256) return { bytes, refused: false };
    await this.drop(root, sha256);
    return { bytes: null, refused: true };
  }

  /** Remove one file of `root`; a rendition it belonged to (every one, for a shared file) is filling again. */
  drop(root: string, sha256: string): Promise<void> {
    return this.enqueue(() =>
      this.#backend.run(STORES, 'readwrite', async (tx) => {
        const k = key(root, sha256);
        const f = await tx.get('files', k);
        await tx.delete('bytes', k);
        if (!isFile(f)) return;
        await tx.delete('files', k);
        const meta = await tx.get('meta', 'usage');
        const usage = typeof meta === 'number' && Number.isFinite(meta) ? meta : f.size;
        await tx.put('meta', 'usage', Math.max(0, usage - f.size));
        const v = await tx.get('videos', root);
        if (!isVideo(v)) return;
        v.bytes = Math.max(0, v.bytes - f.size);
        v.files = Math.max(0, v.files - 1);
        if (v.files === 0) {
          await tx.delete('videos', root);
          return;
        }
        for (const r of v.renditions) if (f.rendition === null || r.id === f.rendition) r.state = 'filling';
        await tx.put('videos', root, v);
      }),
    );
  }

  /** The sha256 of every file of `root` held. */
  async storedShas(root: string): Promise<Set<string>> {
    this.#check();
    const keys = await this.#backend.run(['files'], 'readonly', (tx) => tx.keys('files', lower(root), upper(root)));
    return new Set(keys.map((k) => k.slice(root.length + 1)));
  }

  /** `root`'s record, or null. */
  async video(root: string): Promise<KeptVideo | null> {
    this.#check();
    const v = await this.#backend.run(['videos'], 'readonly', (tx) => tx.get('videos', root));
    return isVideo(v) ? publicVideo(v) : null;
  }

  /** Note that `root` was played now (for eviction order), if it is kept. */
  touch(root: string): Promise<void> {
    const now = this.#deps.now();
    return this.enqueue(() =>
      this.#backend.run(['videos'], 'readwrite', async (tx) => {
        const v = await tx.get('videos', root);
        if (!isVideo(v)) return;
        v.usedAt = now;
        await tx.put('videos', root, v);
      }),
    );
  }

  async list(): Promise<KeptVideo[]> {
    this.#check();
    const all = await this.#backend.run(['videos'], 'readonly', (tx) => tx.values('videos'));
    return all
      .filter(isVideo)
      .map(publicVideo)
      .sort((a, b) => b.playedAt - a.playedAt);
  }

  async usage(): Promise<number> {
    this.#check();
    const meta = await this.#backend.run(['meta'], 'readonly', (tx) => tx.get('meta', 'usage'));
    return typeof meta === 'number' && Number.isFinite(meta) ? meta : 0;
  }

  async remove(root: string): Promise<void> {
    this.#check();
    if (typeof root !== 'string' || !SHA.test(root)) throw new TypeError('nfx: a root is 64 lowercase hex');
    await this.enqueue(async () => {
      await this.#backend.run(STORES, 'readwrite', async (tx) => {
        const freed = await this.#evict(tx, root);
        const meta = await tx.get('meta', 'usage');
        const usage = typeof meta === 'number' && Number.isFinite(meta) ? meta : freed;
        await tx.put('meta', 'usage', Math.max(0, usage - freed));
      });
      // Counted once committed, and before any write queued after it runs.
      this.#removals.set(root, this.removalMark(root) + 1);
    });
  }

  /** Resolves once every write queued before the call has finished (later ones are not waited for). */
  idle(): Promise<void> {
    return this.#queue.then(() => {});
  }

  /** Takes no new work; what is queued finishes, then the backend closes. */
  close(): void {
    if (this.#closing) return;
    this.#closing = true;
    void this.#queue.then(() => {
      this.#shut = true;
      this.#backend.close();
    });
  }
}
