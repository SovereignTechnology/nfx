/**
 * Keeping what is watched, in a browser (NFX-18, NFX-10 §7): the store. A kept file is stored
 * by its sha256 under the hash list root it belongs to (NFX-18 §3), never by a name a peer, a
 * transport or a swarm chose. A file's bytes and its index entry are written in one
 * transaction, so neither is ever there without the other. Every read is checked against the
 * sha256 again, before anything plays or serves it: a file that fails is dropped, never
 * returned, so it is fetched again like any missing file.
 *
 * At the cap, videos kept only because they were watched go, the least recently played first,
 * never one a session plays (here, or in another tab of the origin, by its Web Lock). A video
 * kept for another reason (`downloaded`) is never removed to make room: the store says it is
 * full instead.
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

export interface KeeperDeps {
  sha256: (bytes: Uint8Array) => string;
  /** ms since the epoch */
  now: () => number;
  /** Roots another tab of this origin plays now (their Web Locks). */
  lockedRoots?: () => Promise<ReadonlySet<string>>;
  /** Hold `root` as playing for other tabs to see, until the returned function is called. */
  hold?: (root: string) => () => void;
}

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
  /** Roots removed by the page while a session played them: that session keeps nothing more. */
  readonly #removed = new Set<string>();
  /** Every write, one after another. */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(backend: KeepBackend, capBytes: number, deps: KeeperDeps) {
    this.#backend = backend;
    this.capBytes = capBytes;
    this.#deps = deps;
  }

  /** Mark `root` as playing until the returned function is called (idempotent). */
  protect(root: string): () => void {
    this.#playing.set(root, (this.#playing.get(root) ?? 0) + 1);
    this.#removed.delete(root);
    const unhold = this.#deps.hold?.(root) ?? ((): void => {});
    let done = false;
    return () => {
      if (done) return;
      done = true;
      unhold();
      const n = (this.#playing.get(root) ?? 1) - 1;
      if (n <= 0) {
        this.#playing.delete(root);
        this.#removed.delete(root);
      } else this.#playing.set(root, n);
    };
  }

  /** Whether the page removed `root` while it played. */
  removedWhilePlaying(root: string): boolean {
    return this.#removed.has(root);
  }

  /** Run `fn` after every write queued before it. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  #check(): void {
    if (this.#closed) throw new Error('nfx: the keep store is closed');
  }

  /**
   * Store `f`, its bytes and its entry in one transaction. Its sha256 is checked first; then,
   * past the cap, videos kept only as watched are evicted, least recently played first, never
   * one playing here or in another tab, nor `f`'s own.
   */
  async put(f: PutFile): Promise<PutResult> {
    this.#check();
    if (!SHA.test(f.root) || !SHA.test(f.sha256)) return { kind: 'refused' };
    if (this.#deps.sha256(f.bytes) !== f.sha256) return { kind: 'refused' };
    const size = f.bytes.byteLength;
    if (size > this.capBytes) return { kind: 'full' };
    // Other tabs' playing roots are asked before the transaction: it may wait on nothing else.
    const locked = (await this.#deps.lockedRoots?.().catch(() => new Set<string>())) ?? new Set<string>();
    const data = f.bytes.slice().buffer;
    const now = this.#deps.now();
    return this.#backend.run(STORES, 'readwrite', async (tx): Promise<PutResult> => {
      const k = key(f.root, f.sha256);
      if (isFile(await tx.get('files', k))) return { kind: 'already' };
      const meta = await tx.get('meta', 'usage');
      let usage = typeof meta === 'number' && Number.isFinite(meta) && meta >= 0 ? meta : 0;
      if (usage + size > this.capBytes) {
        const victims = (await tx.values('videos'))
          .filter(isVideo)
          .filter((v) => v.root !== f.root && !this.#playing.has(v.root) && !locked.has(v.root) && v.reasons.every((r) => r === 'watched'))
          .sort((a, b) => a.usedAt - b.usedAt || (a.root < b.root ? -1 : 1));
        for (const v of victims) {
          if (usage + size <= this.capBytes) break;
          usage -= await this.#evict(tx, v.root);
        }
        if (usage + size > this.capBytes) return { kind: 'full' };
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
    const got = await this.#backend.run(['bytes'], 'readonly', (tx) => tx.get('bytes', key(root, sha256)));
    if (!(got instanceof ArrayBuffer)) return { bytes: null, refused: false };
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
    if (this.#playing.has(root)) this.#removed.add(root);
    await this.enqueue(() =>
      this.#backend.run(STORES, 'readwrite', async (tx) => {
        const freed = await this.#evict(tx, root);
        const meta = await tx.get('meta', 'usage');
        const usage = typeof meta === 'number' && Number.isFinite(meta) ? meta : freed;
        await tx.put('meta', 'usage', Math.max(0, usage - freed));
      }),
    );
  }

  async idle(): Promise<void> {
    for (;;) {
      const q = this.#queue;
      await q;
      if (q === this.#queue) return;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.idle().then(() => this.#backend.close());
  }
}
