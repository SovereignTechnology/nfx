import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CoreKeyHex, Sha256Hex } from '@sovit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CAS_INDEX_FILE, CasIndex } from '../store/cas-index.js';
import { DiskCap } from '../store/disk-cap.js';
import { adapters, tmpDir } from './helpers.js';

const sha = (s: string): Sha256Hex => s.repeat(64).slice(0, 64) as Sha256Hex;
const core = 'ab'.repeat(32) as CoreKeyHex;
const blob = { byteOffset: 0, blockOffset: 0, blockLength: 2, byteLength: 100 };

describe('CasIndex', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const t = await tmpDir();
    dir = t.dir;
    cleanup = t.rm;
  });
  afterEach(() => cleanup());

  it('maps sha256 → {coreKey, blob}, persists and reloads', async () => {
    const i = new CasIndex({ ...adapters, dataDir: dir });
    await i.load();
    i.add({ sha256: sha('a'), coreKey: core, blob, size: 100, mime: 'video/mp4' });
    i.add({ sha256: sha('b'), coreKey: core, blob: { ...blob, blockOffset: 2 }, size: 50 });
    expect(i.resolve(sha('a'))).toEqual({ core, blob });
    expect(i.resolve(sha('A').toLowerCase())).toEqual({ core, blob });
    expect(i.resolve(sha('c'))).toBeUndefined();
    expect(i.totalBytes()).toBe(150);
    await i.flushed();

    const j = new CasIndex({ ...adapters, dataDir: dir });
    await j.load();
    expect(j.entries()).toHaveLength(2);
    expect(j.get(sha('a'))?.mime).toBe('video/mp4');
    expect(j.totalBytes()).toBe(150);
    expect(j.remove(sha('a'))).toBe(true);
    expect(j.remove(sha('a'))).toBe(false);
    await j.flushed();
    const k = new CasIndex({ ...adapters, dataDir: dir });
    await k.load();
    expect(k.entries().map((e) => e.sha256)).toEqual([sha('b')]);
  });

  it('flags a corrupt or malformed file', async () => {
    await writeFile(
      path.join(dir, CAS_INDEX_FILE),
      JSON.stringify({
        version: 1,
        entries: [{ sha256: 'nope', coreKey: core, blob, size: 1, addedAt: 1 }],
      }),
    );
    const i = new CasIndex({ ...adapters, dataDir: dir });
    await i.load();
    expect(i.corruptOnLoad).toBe(true);
    expect(i.entries()).toHaveLength(0);
  });
});

describe('DiskCap', () => {
  it('reserves, commits, releases and refuses past the cap', () => {
    const cap = new DiskCap(100, 30);
    expect(cap.freeBytes).toBe(70);
    expect(cap.fits(70)).toBe(true);
    expect(cap.fits(71)).toBe(false);
    const r1 = cap.reserve(50);
    expect(r1).not.toBeNull();
    expect(cap.pendingBytes).toBe(50);
    expect(cap.reserve(21)).toBeNull(); // 30 + 50 + 21 > 100
    const r2 = cap.reserve(20);
    expect(r2).not.toBeNull();
    r1!.release();
    r2!.commit();
    r2!.commit(); // idempotent
    expect(cap.usedBytes).toBe(50);
    expect(cap.pendingBytes).toBe(0);
    cap.free(20);
    expect(cap.usedBytes).toBe(30);
    expect(cap.fits(-1)).toBe(false);
  });

  it('validates its inputs', () => {
    expect(() => new DiskCap(-1, 0)).toThrow();
    expect(() => new DiskCap(1, -1)).toThrow();
  });
});
