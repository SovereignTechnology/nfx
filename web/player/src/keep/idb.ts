/**
 * The keep store's backend in a browser: IndexedDB (database `nfx-web-keep`, one per page
 * origin), and Web Locks to tell other tabs of the origin which videos play. No worker, and
 * nothing that needs a change to the page's Content-Security-Policy.
 *
 * Stores: `videos` (a record per kept video, by hash list root), `files` (an entry per file,
 * by `<root>/<sha256>`), `bytes` (its bytes, as an ArrayBuffer, under the same key) and
 * `meta` (`usage`: the bytes of every file stored). ./store.ts writes a file's bytes and entry
 * in one transaction.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { type KeepBackend, type KeepTx, STORES, type StoreName } from './store';

export const KEEP_DB = 'nfx-web-keep';
const VERSION = 1;
/** A Web Lock of this name, held shared, says a tab plays that root. */
export const PLAYING_LOCK_PREFIX = 'nfx-web-keep/playing/';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

class IdbBackend implements KeepBackend {
  readonly #db: IDBDatabase;

  constructor(db: IDBDatabase) {
    this.#db = db;
  }

  run<T>(stores: readonly StoreName[], mode: 'readonly' | 'readwrite', fn: (tx: KeepTx) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let t: IDBTransaction;
      try {
        t = this.#db.transaction([...stores], mode);
      } catch (e) {
        reject(e);
        return;
      }
      let settled: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
      let fnDone!: () => void;
      const ran = new Promise<void>((r) => (fnDone = r));
      t.oncomplete = () => {
        // `fn` ends before the commit when it waits on nothing but these requests.
        void ran.then(() => (settled?.ok ? resolve(settled.value) : reject(settled?.error ?? new Error('IndexedDB: transaction ended early'))));
      };
      t.onabort = () => {
        void ran.then(() => reject(settled && !settled.ok ? settled.error : (t.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'))));
      };
      const tx: KeepTx = {
        get: (s, k) => request(t.objectStore(s).get(k)),
        put: (s, k, v) => request(t.objectStore(s).put(v, k)).then(() => undefined),
        delete: (s, k) => request(t.objectStore(s).delete(k)).then(() => undefined),
        keys: (s, lo, hi) => request(t.objectStore(s).getAllKeys(IDBKeyRange.bound(lo, hi))).then((ks) => ks.filter((k): k is string => typeof k === 'string')),
        values: (s) => request(t.objectStore(s).getAll()),
      };
      fn(tx).then(
        (value) => {
          settled = { ok: true, value };
          fnDone();
        },
        (error: unknown) => {
          settled = { ok: false, error };
          fnDone();
          try {
            t.abort();
          } catch {
            // already committed or aborted
          }
        },
      );
    });
  }

  close(): void {
    this.#db.close();
  }
}

/** The IndexedDB backend, its stores made on first use. */
export function openIdbBackend(name: string = KEEP_DB): Promise<KeepBackend> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(name, VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version opened elsewhere: this one steps aside.
      db.onversionchange = () => db.close();
      resolve(new IdbBackend(db));
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB: open failed'));
  });
}

function locks(): LockManager | null {
  return typeof navigator !== 'undefined' && 'locks' in navigator && navigator.locks ? navigator.locks : null;
}

/** Roots another tab (or this one) of the origin holds as playing. */
export async function lockedRoots(): Promise<ReadonlySet<string>> {
  const l = locks();
  if (l === null) return new Set();
  const snap = await l.query();
  const out = new Set<string>();
  for (const x of [...(snap.held ?? []), ...(snap.pending ?? [])]) {
    if (typeof x.name === 'string' && x.name.startsWith(PLAYING_LOCK_PREFIX)) out.add(x.name.slice(PLAYING_LOCK_PREFIX.length));
  }
  return out;
}

/** Hold `root` as playing (a shared Web Lock) until the returned function is called. */
export function holdPlaying(root: string): () => void {
  const l = locks();
  if (l === null) return () => {};
  let release!: () => void;
  const until = new Promise<void>((r) => (release = r));
  void l.request(`${PLAYING_LOCK_PREFIX}${root}`, { mode: 'shared' }, () => until).catch(() => {});
  return release;
}
