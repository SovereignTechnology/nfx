import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BAN_FILE, BanList } from '../store/ban-list.js';
import { toHex } from '../util/hex.js';
import { adapters, loadedBanList, noiseKey, pubkey, tmpDir } from './helpers.js';

describe('BanList', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const t = await tmpDir();
    dir = t.dir;
    cleanup = t.rm;
  });
  afterEach(() => cleanup());

  it('bans on both keys and answers on either', async () => {
    const b = await loadedBanList(dir);
    const pk = pubkey('viewer');
    const nk = noiseKey(1);
    b.ban({ pubkey: pk, noiseKey: nk, reason: 'window-exceeded' });
    expect(b.isPubkeyBanned(pk)).toBe(true);
    expect(b.isNoiseBanned(nk)).toBe(true);
    expect(b.isNoiseBanned(toHex(nk))).toBe(true);
    expect(b.firewall(nk)).toBe(true);
    expect(b.firewall(noiseKey(2))).toBe(false);
    expect(b.entries()).toHaveLength(1);
    expect(b.asBanEntries()[0]).toMatchObject({ pubkey: pk, reason: 'window-exceeded' });
    expect(b.asBanEntries()[0]?.noiseKey).toEqual(nk);
  });

  it('persists to disk and reloads on start, on BOTH keys', async () => {
    const b = await loadedBanList(dir);
    const pk = pubkey('viewer');
    const nk = noiseKey(7);
    b.ban({ pubkey: pk, noiseKey: nk, reason: 'double-spend' });
    b.ban({ noiseKey: noiseKey(8), reason: 'noise-only' });
    b.ban({ pubkey: pubkey('other'), reason: 'pubkey-only' });
    await b.flushed();

    const raw = JSON.parse(await readFile(path.join(dir, BAN_FILE), 'utf8')) as { bans: unknown[] };
    expect(raw.bans).toHaveLength(3);

    const b2 = await loadedBanList(dir);
    expect(b2.isPubkeyBanned(pk)).toBe(true);
    expect(b2.isNoiseBanned(nk)).toBe(true);
    expect(b2.isNoiseBanned(noiseKey(8))).toBe(true);
    expect(b2.isPubkeyBanned(pubkey('other'))).toBe(true);
    expect(b2.isNoiseBanned(noiseKey(9))).toBe(false);
    expect(b2.corruptOnLoad).toBe(false);
  });

  it('unban removes the whole entry via either key and persists', async () => {
    const b = await loadedBanList(dir);
    const pk = pubkey('v');
    const nk = noiseKey(3);
    b.ban({ pubkey: pk, noiseKey: nk, reason: 'x' });
    expect(b.unban({ noiseKey: nk })).toBe(true);
    expect(b.isPubkeyBanned(pk)).toBe(false);
    expect(b.isNoiseBanned(nk)).toBe(false);
    expect(b.unban({ pubkey: pk })).toBe(false);
    await b.flushed();
    const b2 = await loadedBanList(dir);
    expect(b2.entries()).toHaveLength(0);
  });

  it('ignores a corrupt file (flagging it) and refuses to mutate before load', async () => {
    await writeFile(path.join(dir, BAN_FILE), '{not json');
    const b = await loadedBanList(dir);
    expect(b.corruptOnLoad).toBe(true);
    expect(b.entries()).toHaveLength(0);

    const fresh = new BanList({ ...adapters, dataDir: dir });
    expect(() => fresh.ban({ pubkey: pubkey('x'), reason: 'r' })).toThrow(/load\(\)/);
  });

  it('rejects entries with malformed keys on load', async () => {
    await writeFile(
      path.join(dir, BAN_FILE),
      JSON.stringify({ version: 1, bans: [{ pubkey: 'zz', noiseKey: null, reason: 'r', at: 1 }] }),
    );
    const b = await loadedBanList(dir);
    expect(b.corruptOnLoad).toBe(true);
  });

  it('requires at least one key', async () => {
    const b = await loadedBanList(dir);
    expect(() => b.ban({ reason: 'r' })).toThrow();
  });
});
