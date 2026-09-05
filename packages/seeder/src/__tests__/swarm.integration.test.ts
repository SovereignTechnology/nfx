/**
 * Two Seeder instances on separate UDP ports replicate a fixture Hyperblob through REAL
 * hyperswarm over a LOCAL `hyperdht` testnet (`hyperdht/testnet.js`, bootstrap on
 * 127.0.0.1). Nothing leaves loopback; no public DHT is contacted.
 *
 * Also runtime-checks S-A findings 3 + 6 on a real UDX transport: the cut fires inside
 * `upload`, `peerInfo.ban(true)` blocks reconnection, and the viewer ends up with AT MOST
 * `windowBlocks` blocks (see docs/lanes/L2.md — on a real socket, blocks already handed
 * to the transport can be lost when the stream is destroyed, so "exactly" holds at the
 * Hypercore layer and "≤" on the wire).
 */
import { mocks } from '@sovit/core';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Seeder } from '../seeder.js';
import type { SeederEvent } from '../seeder.js';
import type { SwarmConfig } from '../net/swarm.js';
import { toHex } from '../util/hex.js';
import { adapters, capturedLogger, tmpDir } from './helpers.js';
import type { CapturedLog } from './helpers.js';

const BLOCK = 1024;
const VIEWER_KEYS = DHT.keyPair(new Uint8Array(32).fill(7));
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('replication over hyperswarm (local hyperdht testnet)', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function node(windowBlocks: number, swarm: Omit<SwarmConfig, 'bootstrap'>) {
    const t = await tmpDir();
    const engine = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks } });
    const log: CapturedLog = capturedLogger();
    const events: SeederEvent[] = [];
    const seeder = await Seeder.create(
      {
        dataDir: t.dir,
        diskCapBytes: 1024 * 1024,
        blockSize: BLOCK,
        swarm: { ...swarm, bootstrap: testnet.bootstrap },
        flushEveryMs: 60_000,
      },
      { engine, logger: log.logger, ...adapters },
    );
    seeder.on((e) => events.push(e));
    cleanups.push(async () => {
      await seeder.close();
      await t.rm();
    });
    return { seeder, engine, log, events };
  }

  async function countBlocks(viewer: Seeder, coreKeyHex: string): Promise<number> {
    const sc = viewer.blobs.coreByKey(coreKeyHex)!;
    let have = 0;
    for (let i = 0; i < sc.core.length; i++) if (await sc.core.has(i)) have++;
    return have;
  }

  it('two seeders on separate ports replicate a blob; accounting matches', async () => {
    const BLOCKS = 16;
    const a = await node(100, { server: true, client: false });
    const b = await node(100, { server: false, client: true, keyPair: VIEWER_KEYS });
    const data = new Uint8Array(BLOCK * BLOCKS).map((_, i) => (i * 13) % 256);
    const put = await a.seeder.putBytes(data);
    if (!put.ok) throw new Error('put failed');

    a.seeder.start();
    await a.seeder.swarm!.flushedAll();
    const vcore = await b.seeder.blobs.openCoreByKey(Buffer.from(put.entry.coreKey, 'hex'));
    b.seeder.start();
    await b.seeder.swarm!.flush();

    const pa = a.seeder.swarm!.address()!.port;
    const pb = b.seeder.swarm!.address()!.port;
    expect(pa).not.toBe(pb);

    const got = await vcore.blobs.get(put.entry.blob, { wait: true, timeout: 5000 });
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);
    await settle(100);

    const viewerNoise = toHex(VIEWER_KEYS.publicKey);
    const session = a.seeder.session(viewerNoise)!;
    expect(session).toBeDefined();
    expect(session.uploadedBlocks).toBe(BLOCKS);
    expect(a.engine.window(viewerNoise as never)).toMatchObject({
      uploaded: BLOCKS,
      outstanding: BLOCKS,
      banned: false,
    });
    expect(a.seeder.stats().swarmConnections).toBe(1);
    expect(a.seeder.stats().sessions).toBe(1);
  }, 20_000);

  it('window exceeded on the wire: cut inside `upload`, PeerInfo banned, no reconnection, ≤ window delivered', async () => {
    const WINDOW = 4;
    const BLOCKS = 20;
    const a = await node(WINDOW, { server: true, client: false });
    const b = await node(100, { server: false, client: true, keyPair: VIEWER_KEYS });
    const put = await a.seeder.putBytes(new Uint8Array(BLOCK * BLOCKS).fill(3));
    if (!put.ok) throw new Error('put failed');
    const uploads: number[] = [];
    a.seeder.blobs.coreByKey(put.entry.coreKey)!.core.on('upload', (i) => uploads.push(i));

    a.seeder.start();
    await a.seeder.swarm!.flushedAll();
    const vcore = await b.seeder.blobs.openCoreByKey(Buffer.from(put.entry.coreKey, 'hex'));
    b.seeder.start();
    await b.seeder.swarm!.flush();

    const res = await vcore.blobs
      .get(put.entry.blob, { wait: true, timeout: 1500 })
      .catch((e: unknown) => e);
    expect(res).toBeInstanceOf(Error);
    await settle(200);

    // Wire: at most `window` blocks reached the viewer (UDX may drop what was in flight).
    const have = await countBlocks(b.seeder, put.entry.coreKey);
    expect(have).toBeGreaterThan(0);
    expect(have).toBeLessThanOrEqual(WINDOW);
    // Accounting: the session and the engine counted exactly window+1 (the crossing block)
    // and nothing after the cut. Hypercore itself may emit one more `upload` for a request
    // already queued when the stream was destroyed (the send is a no-op on a destroyed
    // stream — see docs/lanes/L2.md), so the raw event count is >= window+1.
    const cut = a.events.find(
      (e): e is Extract<SeederEvent, { type: 'session-cut' }> => e.type === 'session-cut',
    );
    expect(cut?.reason).toBe('window-exceeded');
    expect(cut?.session.uploadedBlocks).toBe(WINDOW + 1);
    expect(a.engine.window(toHex(VIEWER_KEYS.publicKey) as never)?.uploaded).toBe(WINDOW + 1);
    expect(uploads.length).toBeGreaterThanOrEqual(WINDOW + 1);
    const rawUploads = uploads.length;

    // Banned on the Noise key, both in our ban list and in hyperswarm's PeerInfo.
    const viewerNoise = toHex(VIEWER_KEYS.publicKey);
    expect(a.seeder.banList.isNoiseBanned(viewerNoise)).toBe(true);
    expect(a.seeder.swarm!.peerInfo(viewerNoise)?.banned).toBe(true);

    // The viewer keeps trying (client mode reconnects); the seeder never accepts it again.
    await b.seeder.swarm!.flush().catch(() => undefined);
    await settle(1500);
    expect(a.seeder.stats().swarmConnections).toBe(0);
    expect(a.seeder.stats().sessions).toBe(0);
    expect(uploads).toHaveLength(rawUploads);
    expect(await countBlocks(b.seeder, put.entry.coreKey)).toBe(have);

    // Persisted: a fresh seeder on the same data dir firewalls the key at the DHT level.
    await a.seeder.banList.flushed();
    await a.seeder.close();
    const engine2 = new mocks.MockPaymentEngine({
      mode: 'honest',
      config: { windowBlocks: WINDOW },
    });
    const a2 = await Seeder.create(
      {
        dataDir: a.seeder.config.dataDir,
        diskCapBytes: 1024 * 1024,
        blockSize: BLOCK,
        swarm: { server: true, client: false, bootstrap: testnet.bootstrap },
      },
      { engine: engine2, ...adapters },
    );
    cleanups.push(() => a2.close());
    await a2.openCore();
    a2.start();
    await a2.swarm!.flushedAll();
    await b.seeder.swarm!.flush().catch(() => undefined);
    await settle(1500);
    expect(a2.stats().swarmConnections).toBe(0);
    expect(await countBlocks(b.seeder, put.entry.coreKey)).toBe(have);
  }, 30_000);
});
