/**
 * Two Seeder instances (real Corestore / Hypercore / Hyperblobs on tmp dirs) replicate a
 * fixture Hyperblob over DIRECTLY PIPED `replicate()` streams — no swarm, no DHT, nothing
 * leaves the process. This is where spike S-A finding 3 is runtime-verified:
 * `peerInfo.ban(true)` + `stream.destroy()` invoked synchronously inside the `upload`
 * handler leaves the viewer holding EXACTLY `windowBlocks` blocks.
 */
import path from 'node:path';

import { mocks } from '@sovit/core';
import type { PricePolicy } from '@sovit/core';
import DHT from 'hyperdht';
import { afterEach, describe, expect, it } from 'vitest';

import { Seeder } from '../seeder.js';
import type { SeederEvent } from '../seeder.js';
import { toHex } from '../util/hex.js';
import { FakePayProtocol, hello } from './fake-pay-protocol.js';
import { adapters, capturedLogger, tmpDir } from './helpers.js';
import type { CapturedLog } from './helpers.js';

const BLOCK = 1024;

interface Node {
  seeder: Seeder;
  engine: mocks.MockPaymentEngine;
  log: CapturedLog;
  events: SeederEvent[];
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function node(windowBlocks: number, opts: { flushEveryBlocks?: number } = {}): Promise<Node> {
  const t = await tmpDir();
  const engine = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks } });
  const log = capturedLogger();
  const events: SeederEvent[] = [];
  const seeder = await Seeder.create(
    {
      dataDir: t.dir,
      diskCapBytes: 1024 * 1024,
      blockSize: BLOCK,
      swarm: null,
      flushEveryBlocks: opts.flushEveryBlocks ?? 1000,
      flushEveryMs: 60_000,
    },
    { engine, logger: log.logger, ...adapters },
  );
  seeder.on((e) => events.push(e));
  seeder.start();
  cleanups.push(async () => {
    await seeder.close();
    await t.rm();
  });
  return { seeder, engine, log, events };
}

/** Stable Noise identity for the viewer, so reconnects present the same key. */
const VIEWER_KEYS = DHT.keyPair(new Uint8Array(32).fill(42));

/**
 * Pipe seeder A (initiator) to viewer B; returns the raw streams. `closed` resolves when
 * A's Noise stream closes — the side our cut destroys. (B's end of a piped pair can stay
 * half-open; real transports close both.)
 */
function connect(a: Seeder, b: Seeder) {
  const sa = a.replicate(true);
  const sb = b.replicate(false, { keyPair: VIEWER_KEYS });
  sa.on('error', () => undefined);
  sb.on('error', () => undefined);
  sa.pipe(sb).pipe(sa);
  const closed = new Promise<void>((resolve) => {
    if (sa.noiseStream.destroyed) resolve();
    else sa.noiseStream.once('close', resolve);
  });
  return { sa, sb, closed };
}

async function fixtureBlob(seeder: Seeder, blocks: number) {
  const data = new Uint8Array(BLOCK * blocks).map((_, i) => (i * 31 + 7) % 256);
  const r = await seeder.putBytes(data, { mime: 'video/mp4' });
  if (!r.ok) throw new Error(`put failed: ${r.error.code}`);
  return { data, entry: r.entry };
}

async function countBlocks(viewer: Seeder, coreKeyHex: string): Promise<number> {
  const sc = viewer.blobs.coreByKey(coreKeyHex);
  if (!sc) throw new Error('viewer has no such core');
  let have = 0;
  for (let i = 0; i < sc.core.length; i++) if (await sc.core.has(i)) have++;
  return have;
}

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('replication over a direct stream pair (offline)', () => {
  it('replicates a fixture blob and the upload accounting matches on both sides', async () => {
    const BLOCKS = 12;
    const seeder = await node(100);
    const viewer = await node(100);
    const { data, entry } = await fixtureBlob(seeder.seeder, BLOCKS);

    const vcore = await viewer.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    let downloads = 0;
    vcore.core.on('download', () => downloads++);
    let uploads = 0;
    seeder.seeder.blobs.coreByKey(entry.coreKey)!.core.on('upload', () => uploads++);

    const { sb } = connect(seeder.seeder, viewer.seeder);
    const got = await vcore.blobs.get(entry.blob, { wait: true, timeout: 5000 });
    expect(got).not.toBeNull();
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);

    await settle();
    expect(uploads).toBe(BLOCKS);
    expect(downloads).toBe(BLOCKS);
    // The seeder's session for the viewer's noise key saw every upload...
    const viewerNoise = toHex(sb.noiseStream.publicKey!);
    const session = seeder.seeder.session(viewerNoise)!;
    expect(session.uploadedBlocks).toBe(BLOCKS);
    expect(session.info().uploadedBytes).toBe(BLOCKS * BLOCK);
    // ...and so did the PaymentEngine, under the provisional (noise-key) identity.
    const w = seeder.engine.window(session.accountId())!;
    expect(w.uploaded).toBe(BLOCKS);
    expect(w.paid).toBe(0);
    expect(w.outstanding).toBe(BLOCKS);
    expect(w.banned).toBe(false);
    expect(session.cutReason).toBeNull();
    expect(seeder.events.some((e) => e.type === 'session-open')).toBe(true);
    expect(await countBlocks(viewer.seeder, entry.coreKey)).toBe(BLOCKS);
  });

  it.each([4, 2, 7])(
    'S-A finding 3: cut inside `upload` leaves the viewer with EXACTLY windowBlocks=%i blocks',
    async (windowBlocks) => {
      const BLOCKS = 20;
      const seeder = await node(windowBlocks);
      const viewer = await node(100);
      const { entry } = await fixtureBlob(seeder.seeder, BLOCKS);
      const vcore = await viewer.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
      const uploadEvents: number[] = [];
      seeder.seeder.blobs.coreByKey(entry.coreKey)!.core.on('upload', (i) => uploadEvents.push(i));

      const { sb, closed } = connect(seeder.seeder, viewer.seeder);
      const res = await vcore.blobs
        .get(entry.blob, { wait: true, timeout: 1500 })
        .catch((e: unknown) => e);
      expect(res).toBeInstanceOf(Error); // REQUEST_TIMEOUT: the stream was cut mid-fetch
      await closed;
      await settle();

      // Hypercore fired `upload` window+1 times: the crossing block was counted...
      expect(uploadEvents).toHaveLength(windowBlocks + 1);
      // ...but never left, so the viewer holds exactly `windowBlocks` blocks.
      expect(await countBlocks(viewer.seeder, entry.coreKey)).toBe(windowBlocks);

      const viewerNoise = toHex(VIEWER_KEYS.publicKey);
      expect(toHex(sb.noiseStream.publicKey!)).toBe(viewerNoise);
      expect(seeder.seeder.session(viewerNoise)).toBeUndefined(); // closed sessions leave the registry
      const cut = seeder.events.find(
        (e): e is Extract<SeederEvent, { type: 'session-cut' }> => e.type === 'session-cut',
      );
      expect(cut?.reason).toBe('window-exceeded');
      expect(cut?.session.uploadedBlocks).toBe(windowBlocks + 1);
      const w = seeder.engine.window(viewerNoise as never)!;
      expect(w).toMatchObject({
        uploaded: windowBlocks + 1,
        paid: 0,
        outstanding: windowBlocks + 1,
        banned: true,
      });

      // Banned on the Noise key, persisted, and honoured after a restart.
      expect(seeder.seeder.bans()).toHaveLength(1);
      expect(seeder.seeder.bans()[0]).toMatchObject({
        noiseKey: viewerNoise,
        reason: 'window-exceeded',
      });
      await seeder.seeder.banList.flushed();
      const dataDir = seeder.seeder.config.dataDir;
      const raw = await adapters.fs.readFile(path.join(dataDir, 'bans.json'));
      expect(new TextDecoder().decode(raw)).toContain(viewerNoise);
    },
  );

  it('a banned Noise key is refused on reconnect (no blocks leave) — before and after a restart', async () => {
    const seeder = await node(4);
    const viewer = await node(100);
    const { entry } = await fixtureBlob(seeder.seeder, 10);
    const vcore = await viewer.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));

    const c1 = connect(seeder.seeder, viewer.seeder);
    await vcore.blobs.get(entry.blob, { wait: true, timeout: 1000 }).catch(() => null);
    await c1.closed;
    const viewerNoise = toHex(VIEWER_KEYS.publicKey);
    expect(seeder.seeder.banList.isNoiseBanned(viewerNoise)).toBe(true);
    const before = await countBlocks(viewer.seeder, entry.coreKey);
    expect(before).toBe(4);

    // Reconnect with the same viewer identity: the seeder refuses at admission.
    const refused: string[] = [];
    seeder.seeder.on((e) => {
      if (e.type === 'session-refused') refused.push(e.reason);
    });
    const c2 = connect(seeder.seeder, viewer.seeder);
    await c2.closed;
    await settle();
    expect(refused).toEqual(['banned']);
    expect(await countBlocks(viewer.seeder, entry.coreKey)).toBe(4);

    // Restart the seeder on the same data dir: the ban list reloads from disk.
    await seeder.seeder.banList.flushed();
    await seeder.seeder.close();
    const engine2 = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks: 4 } });
    const seeder2 = await Seeder.create(
      {
        dataDir: seeder.seeder.config.dataDir,
        diskCapBytes: 1024 * 1024,
        blockSize: BLOCK,
        swarm: null,
      },
      { engine: engine2, ...adapters },
    );
    cleanups.push(() => seeder2.close());
    await seeder2.openCore();
    expect(seeder2.hasBlob(entry.sha256)).toBe(true);
    expect(seeder2.banList.isNoiseBanned(viewerNoise)).toBe(true);
    seeder2.start();
    const refused2: string[] = [];
    seeder2.on((e) => {
      if (e.type === 'session-refused') refused2.push(e.reason);
    });
    const c3 = connect(seeder2, viewer.seeder);
    await c3.closed;
    await settle();
    expect(refused2).toEqual(['banned']);
    expect(await countBlocks(viewer.seeder, entry.coreKey)).toBe(4);
  });

  it('honest viewer: HELLO + PAY through the bridge re-opens the window and the whole blob arrives', async () => {
    const BLOCKS = 8;
    const seeder = await node(4, { flushEveryBlocks: 8 });
    const viewer = await node(100);
    const viewerEngine = viewer.engine;
    const { data, entry } = await fixtureBlob(seeder.seeder, BLOCKS);
    const vcore = await viewer.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));

    const policy: PricePolicy = {
      satsPerBlock: 1 as never,
      blockSize: BLOCK,
      mints: seeder.engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    seeder.seeder.setPolicy(policy);

    const { sb } = connect(seeder.seeder, viewer.seeder);
    await sb.noiseStream.opened;
    await settle(50);
    const viewerNoise = toHex(sb.noiseStream.publicKey!);
    const session = seeder.seeder.session(viewerNoise)!;
    const protocol = new FakePayProtocol();
    seeder.seeder.attachPayProtocol(session, protocol);
    const viewerPubkey = mocks.asPubkey('honest-viewer');
    protocol.remoteHello(hello(viewerPubkey));
    expect(session.pubkey).toBe(viewerPubkey);

    // Blocks 0..3: exactly the window.
    for (let i = 0; i < 4; i++)
      expect(await vcore.core.get(i, { wait: true, timeout: 2000 })).not.toBeNull();
    await settle(50);
    expect(seeder.engine.window(viewerPubkey)).toMatchObject({
      uploaded: 4,
      paid: 0,
      outstanding: 4,
    });

    // Viewer pays for what Hypercore emitted `download` for (invariant 1) → ACK ok.
    const pay = await viewerEngine.pay(
      { fromBlock: 0, toBlock: 3 },
      {
        pubkey: seeder.engine.config.ownPubkey,
        p2pk: seeder.engine.config.ownP2pk,
        mint: policy.mints[0]!,
      },
      policy,
    );
    protocol.remotePay(pay);
    await settle(20);
    expect(protocol.acks).toEqual([{ type: 'ACK', fromBlock: 0, toBlock: 3, ok: true }]);
    expect(seeder.engine.window(viewerPubkey)).toMatchObject({
      uploaded: 4,
      paid: 4,
      outstanding: 0,
    });

    // Blocks 4..7 now flow; the stream is still up; the blob is complete and byte-exact.
    for (let i = 4; i < 8; i++)
      expect(await vcore.core.get(i, { wait: true, timeout: 2000 })).not.toBeNull();
    await settle(50);
    expect(session.cutReason).toBeNull();
    expect(sb.noiseStream.destroyed).toBe(false);
    const full = await vcore.blobs.get(entry.blob, { wait: false });
    expect(Buffer.from(full!).equals(Buffer.from(data))).toBe(true);
    expect(seeder.engine.window(viewerPubkey)).toMatchObject({
      uploaded: 8,
      paid: 4,
      outstanding: 4,
    });

    // Second PAY → 8 paid blocks = flushEveryBlocks → the scheduler flushed the batch.
    const pay2 = await viewerEngine.pay(
      { fromBlock: 4, toBlock: 7 },
      {
        pubkey: seeder.engine.config.ownPubkey,
        p2pk: seeder.engine.config.ownP2pk,
        mint: policy.mints[0]!,
      },
      policy,
    );
    protocol.remotePay(pay2);
    await settle(20);
    expect(protocol.acks[1]?.ok).toBe(true);
    const flush = seeder.events.find(
      (e): e is Extract<SeederEvent, { type: 'flush' }> => e.type === 'flush',
    );
    expect(flush?.trigger).toBe('blocks');
    expect(flush?.result).toMatchObject({ swapped: 4, nutzapped: 4, failed: 0 });

    // Invariant 7: nothing in the seeder's log leaks a proof.
    const all = seeder.log.lines.join('\n');
    expect(all).not.toContain('mock:');
    expect(all).not.toMatch(/"secret"|"C":/);
    expect(all).toContain('PAY accepted');
  });
});
