import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { mocks } from '@sovit/core';
import type { PricePolicy } from '@sovit/core';
import { afterEach, describe, expect, it } from 'vitest';

import { Seeder } from '../seeder.js';
import type { SeederEvent } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { FakePayProtocol, hello } from './fake-pay-protocol.js';
import { FakeStream, adapters, capturedLogger, noiseKey, pubkey, tmpDir } from './helpers.js';

const BLOCK = 1024;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function make(
  opts: {
    windowBlocks?: number;
    maxStreams?: number;
    maxStreamsPerKey?: number;
    diskCapBytes?: number;
    dataDir?: string;
    mode?: mocks.MockPaymentMode;
  } = {},
) {
  const t = opts.dataDir ? null : await tmpDir();
  const engine = new mocks.MockPaymentEngine({
    mode: 'honest',
    config: { windowBlocks: opts.windowBlocks ?? 4 },
  });
  const log = capturedLogger();
  const events: SeederEvent[] = [];
  const seeder = await Seeder.create(
    {
      dataDir: opts.dataDir ?? t!.dir,
      diskCapBytes: opts.diskCapBytes ?? 64 * BLOCK,
      blockSize: BLOCK,
      swarm: null,
      rateLimits: {
        maxStreams: opts.maxStreams ?? 8,
        maxStreamsPerKey: opts.maxStreamsPerKey ?? 2,
        connectsPerWindow: 100,
        windowMs: 1000,
      },
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    { engine, logger: log.logger, ...adapters },
  );
  seeder.on((e) => events.push(e));
  cleanups.push(async () => {
    await seeder.close();
    if (t) await t.rm();
  });
  return { seeder, engine, log, events };
}

describe('Seeder façade', () => {
  it('persists blobs + CAS index + disk usage across a restart and enforces the cap after reload', async () => {
    const first = await make({ diskCapBytes: 5 * BLOCK });
    const dataDir = first.seeder.config.dataDir;
    const a = await first.seeder.putBytes(new Uint8Array(3 * BLOCK).fill(1));
    expect(a.ok).toBe(true);
    expect(first.events.filter((e) => e.type === 'blob-added')).toHaveLength(1);
    expect(first.seeder.stats()).toMatchObject({
      blobs: 1,
      usedBytes: 3 * BLOCK,
      capBytes: 5 * BLOCK,
      cores: 1,
    });
    await first.seeder.index.flushed();
    await first.seeder.close();

    const second = await make({ diskCapBytes: 5 * BLOCK, dataDir });
    expect(second.seeder.stats()).toMatchObject({ blobs: 1, usedBytes: 3 * BLOCK });
    if (!a.ok) return;
    expect(second.seeder.blob(a.entry.sha256)?.blob).toEqual(a.entry.blob);
    await second.seeder.openCore();
    const back = await second.seeder.getBlob(a.entry.sha256);
    expect(back?.byteLength).toBe(3 * BLOCK);
    const tooBig = await second.seeder.putBytes(new Uint8Array(3 * BLOCK).fill(2));
    expect(tooBig).toMatchObject({ ok: false, error: { code: 'disk-cap' } });
    const fits = await second.seeder.putBytes(new Uint8Array(2 * BLOCK).fill(2));
    expect(fits.ok).toBe(true);
    expect(await second.seeder.removeBlob(a.entry.sha256)).toBe(true);
    expect(second.events.at(-1)).toMatchObject({ type: 'blob-removed', sha256: a.entry.sha256 });
    expect(second.seeder.stats().usedBytes).toBe(2 * BLOCK);
    expect(second.seeder.listBlobs()).toHaveLength(1);
  });

  it('logs (redacted) and survives corrupt state files', async () => {
    const t = await tmpDir();
    cleanups.push(t.rm);
    await writeFile(path.join(t.dir, 'bans.json'), 'garbage');
    await writeFile(path.join(t.dir, 'cas-index.json'), '[]');
    const s = await make({ dataDir: t.dir });
    expect(s.log.records.filter((r) => r.level === 'error').map((r) => r.msg)).toEqual([
      'ban list on disk was unreadable; starting with an empty list',
      'CAS index on disk was unreadable; starting with an empty index',
    ]);
    expect(s.seeder.bans()).toHaveLength(0);
  });

  it('enforces the global stream cap and per-key cap at admission and emits refusals', async () => {
    const s = await make({ maxStreams: 3, maxStreamsPerKey: 1 });
    const streams = [1, 1, 2, 3, 4].map((k) => new FakeStream(noiseKey(k)));
    const admitted = streams.map((st) => s.seeder.sessions.admit(st));
    expect(admitted.map((x) => x !== null)).toEqual([true, false, true, true, false]);
    expect(streams[1]!.destroyed).toBe(true); // per-key cap
    expect(streams[4]!.destroyed).toBe(true); // global cap
    const refused = s.events.filter(
      (e): e is Extract<SeederEvent, { type: 'session-refused' }> => e.type === 'session-refused',
    );
    expect(refused.map((r) => r.reason)).toEqual(['per-key-cap', 'global-cap']);
    expect(s.seeder.stats().sessions).toBe(3);
    // releasing one slot lets the next in
    streams[2]!.destroy();
    await streams[2]!.closed();
    expect(s.seeder.stats().sessions).toBe(2);
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(4)))).not.toBeNull();
    expect(s.events.filter((e) => e.type === 'session-close')).toHaveLength(1);
  });

  it('manual ban/unban covers the engine, the sessions and disk; banned keys are refused', async () => {
    const s = await make();
    const st = new FakeStream(noiseKey(9));
    const session = s.seeder.sessions.admit(st)!;
    const pk = pubkey('manual');
    session.bindPubkey(pk);
    s.seeder.ban({ pubkey: pk, noiseKey: noiseKey(9) }, 'operator');
    expect(st.destroyed).toBe(true);
    expect(s.engine.isBanned(pk)).toBe(true);
    expect(s.seeder.bans()).toEqual([
      expect.objectContaining({ pubkey: pk, noiseKey: toHex(noiseKey(9)), reason: 'operator' }),
    ]);
    await st.closed();
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(9)))).toBeNull();
    expect(s.seeder.unban({ pubkey: pk })).toBe(true);
    expect(s.engine.isBanned(pk)).toBe(false);
    expect(s.seeder.sessions.admit(new FakeStream(noiseKey(9)))).not.toBeNull();
  });

  it('double-spend reported at flush bans the peer on both keys and cuts its session', async () => {
    const s = await make({ windowBlocks: 8 });
    const viewer = new mocks.MockPaymentEngine({ mode: 'double-spend' });
    const policy: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    s.seeder.setPolicy(policy);
    const st = new FakeStream(noiseKey(5));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    const pk = pubkey('ds');
    protocol.remoteHello(hello(pk));
    for (let i = 0; i < 8; i++) session.onUpload('c', i, BLOCK);
    const ref = {
      pubkey: s.engine.config.ownPubkey,
      p2pk: s.engine.config.ownP2pk,
      mint: policy.mints[0]!,
    };
    protocol.remotePay(await viewer.pay({ fromBlock: 0, toBlock: 3 }, ref, policy));
    await new Promise((r) => setTimeout(r, 0));
    protocol.remotePay(await viewer.pay({ fromBlock: 4, toBlock: 7 }, ref, policy));
    await new Promise((r) => setTimeout(r, 0));
    expect(protocol.acks.map((a) => a.ok)).toEqual([true, true]);
    expect(s.seeder.stats().pendingPaidBlocks).toBe(8);

    const res = await s.seeder.flushNow();
    expect(res).toMatchObject({ failed: 1, swapped: 2, nutzapped: 2 }); // 4 blocks × 1 sat, split 50/50
    expect(st.destroyed).toBe(true);
    expect(session.cutReason).toBe('banned');
    expect(s.seeder.banList.isPubkeyBanned(pk)).toBe(true);
    expect(s.seeder.banList.isNoiseBanned(noiseKey(5))).toBe(true);
    const ds = s.events.find((e) => e.type === 'double-spend');
    expect(ds).toMatchObject({ peer: pk, amount: 4 });
    expect(s.events.some((e) => e.type === 'flush')).toBe(true);
    const all = s.log.lines.join('\n');
    expect(all).not.toContain('mock:');
    expect(all).toContain('double-spend');
  });

  it('setPolicy announces PRICE to live pay/1 peers with the old price honoured for uploaded blocks', async () => {
    const s = await make();
    const st = new FakeStream(noiseKey(6));
    const session = s.seeder.sessions.admit(st)!;
    const protocol = new FakePayProtocol();
    s.seeder.attachPayProtocol(session, protocol);
    for (let i = 0; i < 3; i++) session.onUpload('c', i, BLOCK);
    const base: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: s.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    s.seeder.setPolicy(base);
    s.seeder.setPolicy(base); // unchanged price: no announcement
    s.seeder.setPolicy({ ...base, satsPerBlock: 2 as never });
    expect(protocol.prices).toEqual([{ type: 'PRICE', satsPerBlock: 2, effectiveFromBlock: 3 }]);
    expect(s.seeder.policy().satsPerBlock).toBe(2);
  });

  it('policy() throws until configured; close() is idempotent and flushes', async () => {
    const s = await make();
    expect(() => s.seeder.policy()).toThrow(/PricePolicy/);
    await s.seeder.close();
    await s.seeder.close();
    expect(s.engine.log.filter((l) => l.kind === 'flush')).toHaveLength(1);
  });
});
