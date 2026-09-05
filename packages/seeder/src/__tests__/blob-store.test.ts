import { createHash } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../blobs/blob-store.js';
import { CasIndex } from '../store/cas-index.js';
import { DiskCap } from '../store/disk-cap.js';
import { adapters, capturedLogger, tmpDir } from './helpers.js';

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const BLOCK = 1024;

describe('BlobStore (Corestore + Hyperblobs + CAS index + disk cap)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let store: BlobStore;
  let index: CasIndex;
  let cap: DiskCap;
  let opened: string[];

  beforeEach(async () => {
    const t = await tmpDir();
    dir = t.dir;
    cleanup = t.rm;
    index = new CasIndex({ ...adapters, dataDir: dir });
    await index.load();
    cap = new DiskCap(10 * BLOCK, 0);
    opened = [];
    store = new BlobStore({
      storageDir: path.join(dir, 'store'),
      blockSize: BLOCK,
      ...adapters,
      index,
      diskCap: cap,
      logger: capturedLogger().logger,
      onCoreOpened: (c) => {
        opened.push(c.name);
      },
    });
    await store.ready();
  });
  afterEach(async () => {
    await store.close();
    await index.flushed();
    await cleanup();
  });

  it('stores bytes as blockSize blocks, indexes by sha256 and reads them back', async () => {
    const data = new Uint8Array(BLOCK * 3 + 17).map((_, i) => i % 251);
    const r = await store.putBytes(data, { mime: 'video/mp4' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deduplicated).toBe(false);
    expect(r.entry.sha256).toBe(sha256(data));
    expect(r.entry.blob).toEqual({
      byteOffset: 0,
      blockOffset: 0,
      blockLength: 4,
      byteLength: data.byteLength,
    });
    expect(r.entry.mime).toBe('video/mp4');
    expect(opened).toEqual(['blobs']);
    expect(index.resolve(r.entry.sha256)).toEqual({ core: r.entry.coreKey, blob: r.entry.blob });
    expect(cap.usedBytes).toBe(data.byteLength);

    const back = await store.get(r.entry.sha256);
    expect(back).not.toBeNull();
    expect(Buffer.from(back!).equals(Buffer.from(data))).toBe(true);
    const sc = store.coreByKey(r.entry.coreKey)!;
    expect(sc.core.length).toBe(4);
    expect(await sc.core.has(3)).toBe(true);
  });

  it('deduplicates by sha256 without touching disk accounting', async () => {
    const data = new Uint8Array(BLOCK).fill(9);
    const a = await store.putBytes(data);
    const b = await store.putBytes(data);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.deduplicated).toBe(true);
    expect(b.entry).toEqual(a.entry);
    expect(cap.usedBytes).toBe(BLOCK);
    expect(store.coreByKey(a.entry.coreKey)!.core.length).toBe(1);
  });

  it('refuses a blob past the disk cap and leaves nothing behind', async () => {
    const ok = await store.putBytes(new Uint8Array(BLOCK * 6).fill(1));
    expect(ok.ok).toBe(true);
    const nope = await store.putBytes(new Uint8Array(BLOCK * 5).fill(2));
    expect(nope).toEqual({
      ok: false,
      error: { code: 'disk-cap', needed: BLOCK * 5, free: BLOCK * 4 },
    });
    expect(cap.usedBytes).toBe(BLOCK * 6);
    expect(cap.pendingBytes).toBe(0);
    expect(index.entries()).toHaveLength(1);
    const fits = await store.putBytes(new Uint8Array(BLOCK * 4).fill(3));
    expect(fits.ok).toBe(true);
    expect(cap.freeBytes).toBe(0);
    const zero = await store.putBytes(new Uint8Array(0));
    expect(zero.ok).toBe(true); // an empty blob costs nothing
  });

  it('puts a file by streaming it (hash pass + write pass) with odd chunk boundaries', async () => {
    const data = new Uint8Array(BLOCK * 2 + 500).map((_, i) => (i * 7) % 256);
    const file = path.join(dir, 'clip.bin');
    await writeFile(file, data);
    const r = await store.putFile(file);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.sha256).toBe(sha256(data));
    expect(r.entry.blob.blockLength).toBe(3);
    expect(r.entry.size).toBe(data.byteLength);
    const back = await store.get(r.entry.sha256);
    expect(Buffer.from(back!).equals(Buffer.from(data))).toBe(true);

    expect(await store.putFile(path.join(dir, 'missing'))).toMatchObject({
      ok: false,
      error: { code: 'not-a-file' },
    });
  });

  it('rejects a stream whose size does not match the declaration', async () => {
    const r = await store.putStream(
      () =>
        (async function* () {
          await Promise.resolve();
          yield new Uint8Array(10);
        })(),
      11,
    );
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'size-mismatch', declared: 11, actual: 10 },
    });
    expect(cap.usedBytes).toBe(0);
  });

  it('v3 (d): the second source() is opened lazily — dedupe / cap early returns never open it (no orphaned ENOENT)', async () => {
    const data = new Uint8Array(BLOCK * 2).map((_, i) => (i * 13) % 256);
    const first = await store.putBytes(data);
    expect(first.ok).toBe(true);

    // A source that would ENOENT on a second open (the caller unlinked the spool file).
    const enoentOnSecondOpen = () => {
      let opens = 0;
      return {
        opens: () => opens,
        source: (): AsyncIterable<Uint8Array> => {
          opens++;
          if (opens > 1) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
          return (async function* () {
            await Promise.resolve();
            yield data;
          })();
        },
      };
    };

    // dedupe path
    const dup = enoentOnSecondOpen();
    const r1 = await store.putStream(dup.source, data.byteLength, {});
    expect(r1).toMatchObject({ ok: true, deduplicated: true });
    expect(dup.opens()).toBe(1);

    // disk-cap path (cap = 10 blocks, 2 used → 9 does not fit)
    const big = new Uint8Array(BLOCK * 9).fill(9);
    let bigOpens = 0;
    const r2 = await store.putStream(() => {
      bigOpens++;
      if (bigOpens > 1) throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
      return (async function* () {
        await Promise.resolve();
        yield big;
      })();
    }, big.byteLength);
    expect(r2).toMatchObject({ ok: false, error: { code: 'disk-cap' } });
    expect(bigOpens).toBe(1);
    expect(cap.pendingBytes).toBe(0);

    // The real shape L3 hit: putFile on an already-stored file, then unlink immediately.
    // With an eager second createReadStream this raised an uncaught ENOENT a tick later.
    const file = path.join(dir, 'spool.bin');
    await writeFile(file, data);
    const r3 = await store.putFile(file);
    expect(r3).toMatchObject({ ok: true, deduplicated: true });
    await unlink(file);
    await new Promise((r) => setTimeout(r, 30));
    expect(index.entries()).toHaveLength(1);
  });

  it('serves ranges and removes blobs (index + cap)', async () => {
    const data = new Uint8Array(BLOCK * 2).map((_, i) => i % 256);
    const r = await store.putBytes(data);
    if (!r.ok) throw new Error('put failed');
    const chunks: Uint8Array[] = [];
    for await (const c of store.createReadStream(r.entry.sha256, {
      start: BLOCK - 2,
      end: BLOCK + 1,
    })!)
      chunks.push(c);
    // Hyperblobs `end` is INCLUSIVE (README: "End offset within the blob (inclusive)").
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(data.subarray(BLOCK - 2, BLOCK + 2)));
    expect(await store.remove(r.entry.sha256)).toBe(true);
    expect(await store.remove(r.entry.sha256)).toBe(false);
    expect(store.has(r.entry.sha256)).toBe(false);
    expect(cap.usedBytes).toBe(0);
    expect(store.createReadStream(r.entry.sha256)).toBeNull();
  });

  it('survives a restart: index reload re-resolves blobs stored in the persisted core', async () => {
    const data = new Uint8Array(BLOCK + 1).fill(5);
    const r = await store.putBytes(data);
    if (!r.ok) throw new Error('put failed');
    await store.close();
    await index.flushed();

    const index2 = new CasIndex({ ...adapters, dataDir: dir });
    await index2.load();
    const store2 = new BlobStore({
      storageDir: path.join(dir, 'store'),
      blockSize: BLOCK,
      ...adapters,
      index: index2,
      diskCap: new DiskCap(10 * BLOCK, index2.totalBytes()),
      logger: capturedLogger().logger,
    });
    await store2.ready();
    const sc = await store2.openCore();
    expect(sc.keyHex).toBe(r.entry.coreKey);
    const back = await store2.get(r.entry.sha256);
    expect(Buffer.from(back!).equals(Buffer.from(data))).toBe(true);
    await store2.close();
    store = store2; // afterEach closes it again (idempotent)
  });
});
