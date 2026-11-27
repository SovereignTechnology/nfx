/**
 * Test fixture for e2e-keep.ts, never part of the player: the keep store (./src/keep/store.ts)
 * over real IndexedDB (./src/keep/idb.ts), in its own database, so a browser shows what
 * keep-unit.ts shows over memory: a file's bytes and entry are one transaction (an error
 * between the two leaves neither), and a stored byte changed behind the store's back is
 * refused and dropped on the next read. e2e-keep.ts calls `window.__keepFixture.run()`.
 */
import init, { sha256Hex } from './out/wasm/nfx_wasm.js';
import { openIdbBackend } from './src/keep/idb';
import { type KeepBackend, Keeper } from './src/keep/store';

const DB = 'nfx-keep-fixture';

function bytes(label: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  out.set(new TextEncoder().encode(label).slice(0, size));
  return out;
}

/** Counts of the fixture database's stores, read with raw IndexedDB. */
function counts(): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const t = db.transaction(['videos', 'files', 'bytes', 'meta'], 'readonly');
      const out: Record<string, number> = {};
      for (const s of ['videos', 'files', 'bytes', 'meta']) {
        const q = t.objectStore(s).count();
        q.onsuccess = () => (out[s] = q.result);
      }
      t.oncomplete = () => {
        db.close();
        resolve(out);
      };
      t.onerror = () => reject(t.error);
    };
  });
}

/** Flip one byte of a stored file with raw IndexedDB. */
function flip(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result;
      const t = db.transaction('bytes', 'readwrite');
      const s = t.objectStore('bytes');
      const g = s.get(key);
      g.onsuccess = () => {
        const b = new Uint8Array(g.result as ArrayBuffer);
        b[0] = b[0]! ^ 0xff;
        s.put(b.buffer, key);
      };
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => reject(t.error);
    };
  });
}

/** The backend, with the put of every file entry failing (as a quota error would). */
function failingEntries(real: KeepBackend): KeepBackend {
  return {
    run: (stores, mode, fn) =>
      real.run(stores, mode, (tx) =>
        fn({
          ...tx,
          put: (s, k, v) => (s === 'files' ? Promise.reject(new Error('injected failure')) : tx.put(s, k, v)),
        }),
      ),
    close: () => real.close(),
  };
}

(window as unknown as { __keepFixture: unknown }).__keepFixture = {
  async run(): Promise<Record<string, unknown>> {
    await init({ module_or_path: '/out/wasm/nfx_wasm_bg.wasm' });
    const real = await openIdbBackend(DB);
    const deps = { sha256: sha256Hex, now: () => Date.now() };
    const out: Record<string, unknown> = {};
    const root = sha256Hex(bytes('hash list', 300));
    const b = bytes('segment', 50_000);
    const sha = sha256Hex(b);
    const file = { root, video: 'nfx:fixture', sha256: sha, role: 'segment' as const, rendition: '360p', bytes: b, reason: 'watched' as const };
    try {
      await new Keeper(failingEntries(real), 1 << 24, deps).put(file);
      out.failed = 'no error';
    } catch (e) {
      out.failed = e instanceof Error ? e.message : String(e);
    }
    out.afterFailure = await counts();
    const keeper = new Keeper(real, 1 << 24, deps);
    out.put = (await keeper.put(file)).kind;
    out.afterPut = await counts();
    const read = await keeper.read(root, sha);
    out.read = read.bytes !== null && sha256Hex(read.bytes) === sha;
    await flip(`${root}/${sha}`);
    const tampered = await keeper.read(root, sha);
    out.tampered = { bytes: tampered.bytes === null ? null : 'returned', refused: tampered.refused };
    await keeper.idle();
    out.afterTamper = await counts();
    out.list = await keeper.list();
    real.close();
    return out;
  },
};
