/**
 * The WS bridge end to end: a client-side Hypercore (a second `Seeder` acting as the
 * viewer, `replicate(true)` = Noise initiator exactly as the browser in spike S-B) over a
 * REAL `ws` loopback socket replicates a fixture blob from the gateway's seeder.
 *
 *   - accounting: the gateway's `upload` events, the `PeerSession` and the PaymentEngine
 *     window all agree with the viewer's `download` count;
 *   - the cut: a non-paying WS client is cut by the seeder's window logic exactly as over
 *     hyperswarm (S-A finding 3) — window+1 uploads recorded, `session-cut{window-exceeded}`,
 *     Noise key banned, viewer holds ≤ window blocks, socket closed;
 *   - `HELLO` on the socket discloses the gateway's OWN price = base + markup;
 *   - the `pay/1` instance is attached to the connection's protomux.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { mocks } from '@sovit/core';
import type { Sats } from '@sovit/core';
import { Seeder, toHex } from '@sovit/seeder';
import type { SeederEvent } from '@sovit/seeder';

import { WsDuplex } from '../ws/ws-duplex.js';
import {
  BLOCK,
  capturedLogger,
  cleanupRigs,
  fixtureBytes,
  rig,
  settle,
  tmpDir,
  until,
} from './helpers.js';
import type { Rig } from './helpers.js';

afterEach(cleanupRigs);

interface Viewer {
  readonly seeder: Seeder;
  readonly events: SeederEvent[];
  readonly close: () => Promise<void>;
}

const viewers: Viewer[] = [];
afterEach(async () => {
  for (const v of viewers.splice(0)) await v.close();
});

async function viewer(): Promise<Viewer> {
  const t = await tmpDir('nutflix-l3-viewer-');
  const engine = new mocks.MockPaymentEngine({ mode: 'honest', config: { windowBlocks: 1000 } });
  const log = capturedLogger();
  const seeder = await Seeder.create(
    {
      dataDir: t.dir,
      diskCapBytes: 1024 * 1024,
      blockSize: BLOCK,
      swarm: null,
      flushEveryBlocks: 1000,
      flushEveryMs: 60_000,
    },
    {
      engine,
      logger: log.logger,
      fs: (await import('@sovit/seeder')).nodeFs,
      crypto: (await import('@sovit/seeder')).nodeCrypto,
    },
  );
  const events: SeederEvent[] = [];
  seeder.on((e) => events.push(e));
  seeder.start();
  const v: Viewer = {
    seeder,
    events,
    close: async () => {
      await seeder.close();
      await t.rm();
    },
  };
  viewers.push(v);
  return v;
}

/** Browser-side wiring from S-B: WebSocket → Duplex → `replicate(true)`. */
function connectViewer(
  v: Viewer,
  r: Rig,
  keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array },
) {
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}${r.config.ws.path}`);
  const duplex = new WsDuplex(ws);
  const raw = v.seeder.replicate(true, keyPair ? { keyPair } : {});
  raw.on('error', () => undefined);
  duplex.on('error', () => undefined);
  ws.once('open', () => {
    raw.pipe(duplex).pipe(raw);
  });
  const closed = new Promise<void>((resolve) => {
    ws.once('close', () => {
      resolve();
    });
  });
  return { ws, raw, closed };
}

async function countBlocks(v: Viewer, coreKeyHex: string): Promise<number> {
  const sc = v.seeder.blobs.coreByKey(coreKeyHex);
  if (!sc) throw new Error('viewer has no such core');
  let have = 0;
  for (let i = 0; i < sc.core.length; i++) if (await sc.core.has(i)) have++;
  return have;
}

async function putFixture(r: Rig, blocks: number) {
  const data = fixtureBytes(blocks);
  const res = await r.gateway.seeder.putBytes(data, { mime: 'video/mp4' });
  if (!res.ok) throw new Error(res.error.code);
  return { data, entry: res.entry };
}

describe('WS bridge: one WebSocket = one replication stream + pay/1', () => {
  it('a client Hypercore over a real ws socket replicates a fixture blob and the accounting matches', async () => {
    const BLOCKS = 12;
    const r = await rig({ windowBlocks: 100 });
    const { data, entry } = await putFixture(r, BLOCKS);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));

    let uploads = 0;
    r.gateway.seeder.blobs.coreByKey(entry.coreKey)!.core.on('upload', () => uploads++);
    let downloads = 0;
    vcore.core.on('download', () => downloads++);

    const { raw } = connectViewer(v, r);
    const got = await vcore.blobs.get(entry.blob, { wait: true, timeout: 8000 });
    expect(got).not.toBeNull();
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);
    await settle(150);

    expect(uploads).toBe(BLOCKS);
    expect(downloads).toBe(BLOCKS);
    expect(await countBlocks(v, entry.coreKey)).toBe(BLOCKS);

    // Gateway side: the session for the viewer's Noise key saw every upload …
    const viewerNoise = toHex(raw.noiseStream.publicKey!);
    const session = r.gateway.seeder.session(viewerNoise);
    expect(session).toBeDefined();
    expect(session!.uploadedBlocks).toBe(BLOCKS);
    expect(session!.info().uploadedBytes).toBe(BLOCKS * BLOCK);
    // … and so did the PaymentEngine under the provisional (Noise-key) identity.
    const w = r.engine.window(session!.accountId())!;
    expect(w).toMatchObject({ uploaded: BLOCKS, paid: 0, outstanding: BLOCKS, banned: false });
    expect(session!.cutReason).toBeNull();
    expect(r.gateway.stats().wsConnections).toBe(1);
    expect(r.sessions.map((s) => s.noiseKeyHex)).toContain(viewerNoise);
  });

  it('a non-paying WS client is cut by the seeder window exactly as over hyperswarm (S-A finding 3)', async () => {
    const WINDOW = 4;
    const BLOCKS = 20;
    const r = await rig({ windowBlocks: WINDOW });
    const { entry } = await putFixture(r, BLOCKS);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    const uploadEvents: number[] = [];
    r.gateway.seeder.blobs.coreByKey(entry.coreKey)!.core.on('upload', (i) => uploadEvents.push(i));

    const { raw, closed } = connectViewer(v, r);
    const res = await vcore.blobs
      .get(entry.blob, { wait: true, timeout: 2500 })
      .catch((e: unknown) => e);
    expect(res).toBeInstanceOf(Error); // REQUEST_TIMEOUT: the stream was cut mid-fetch
    await closed; // the gateway closed the WebSocket
    await settle(150);

    const viewerNoise = toHex(raw.noiseStream.publicKey!);
    // Hypercore fired `upload` at least window+1 times (the crossing block was counted, S-A
    // finding + L2's wire-rig note that one more queued request can pop after destroy) …
    expect(uploadEvents.length).toBeGreaterThanOrEqual(WINDOW + 1);
    // … the engine recorded exactly window+1 and banned the provisional identity …
    const w = r.engine.window(viewerNoise as never)!;
    expect(w).toMatchObject({
      uploaded: WINDOW + 1,
      paid: 0,
      outstanding: WINDOW + 1,
      banned: true,
    });
    // … the session was cut for that reason and left the registry …
    expect(r.gateway.seeder.session(viewerNoise)).toBeUndefined();
    const cut = r.log.records.find((rec) => rec.msg === 'session cut');
    expect(cut?.fields['reason']).toBe('window-exceeded');
    // … the Noise key is on the persisted ban list …
    expect(
      r.gateway.seeder
        .bans()
        .some((b) => b.noiseKey === viewerNoise && b.reason === 'window-exceeded'),
    ).toBe(true);
    // … and the viewer holds at most `window` blocks (never the crossing one).
    const have = await countBlocks(v, entry.coreKey);
    expect(have).toBeGreaterThan(0);
    expect(have).toBeLessThanOrEqual(WINDOW);
    await until(() => r.gateway.stats().wsConnections === 0, 3000);
  });

  it('HELLO discloses the gateway price = base policy + markup, and pay/1 is attached to the protomux', async () => {
    const r = await rig({ windowBlocks: 100, raw: { markupSatsPerBlock: 3 } });
    const { entry } = await putFixture(r, 2);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    connectViewer(v, r);
    await vcore.blobs.get(entry.blob, { wait: true, timeout: 8000 });
    await until(() => r.protocols.length === 1 && r.protocols[0]!.hellos.length === 1);

    const p = r.protocols[0]!;
    const hello = p.hellos[0]!;
    expect(hello.satsPerBlock).toBe((2 + 3) as Sats);
    expect(r.gateway.price()).toBe(5);
    expect(hello.pubkey).toBe(r.config.identity.pubkey);
    expect(hello.p2pk).toBe(r.config.identity.p2pk);
    expect(hello.acceptedMints).toEqual(r.config.acceptedMints);
    expect(hello.split).toEqual({ seeder: 50, creator: 50 });
    expect(hello.version).toBe(1);
    expect(hello.signature).toBe(`sig:${hello.challenge.slice(0, 8)}`);
    expect(hello.challenge).toMatch(/^[0-9a-f]{64}$/);
    // Attached to the connection's protomux (what Hypercore parks on the Noise stream).
    expect(p.attachedTo).not.toBeNull();
    expect(typeof p.attachedTo!.createChannel).toBe('function');
    // The seeder verifies downstream PAYs against the MARKED-UP policy.
    expect(r.gateway.seeder.policy().satsPerBlock).toBe(5);
  });

  it('a downstream PAY at the gateway price is verified and ACKed through the seeder pay bridge', async () => {
    const r = await rig({ windowBlocks: 100, raw: { markupSatsPerBlock: 1 } });
    const { entry } = await putFixture(r, 6);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    const { raw } = connectViewer(v, r);
    await vcore.blobs.get(entry.blob, { wait: true, timeout: 8000 });
    await until(() => r.protocols.length === 1 && r.protocols[0]!.hellos.length === 1);
    await settle(100);
    const p = r.protocols[0]!;
    const viewerNoise = toHex(raw.noiseStream.publicKey!);
    const before = r.engine.window(viewerNoise as never)!;
    expect(before.outstanding).toBe(6);

    // The viewer pays through ITS engine at the disclosed price, naming the core (v3).
    const viewerEngine = new mocks.MockPaymentEngine({ mode: 'honest' });
    const policy = r.gateway.seeder.policy();
    const msg = await viewerEngine.pay(
      { core: entry.coreKey, fromBlock: 0, toBlock: 5 },
      { pubkey: r.config.identity.pubkey, p2pk: r.config.identity.p2pk, mint: policy.mints[0]! },
      policy,
    );
    p.remotePay(msg);
    await until(() => p.acks.length === 1);
    expect(p.acks[0]).toMatchObject({ ok: true, fromBlock: 0, toBlock: 5 });
    expect(r.engine.window(viewerNoise as never)!.outstanding).toBe(0);
  });

  it('refuses upgrades on the wrong path (404) and above the connection cap (503)', async () => {
    const r = await rig({ raw: { ws: { maxConnections: 1, handshakeTimeoutMs: 5000 } } });
    const wrong = new WebSocket(`http://127.0.0.1:${r.port}/nope`);
    const wrongErr = await new Promise<Error>((resolve) => wrong.once('error', resolve));
    expect(wrongErr.message).toContain('404');

    const first = new WebSocket(`ws://127.0.0.1:${r.port}/ws`);
    await new Promise<void>((resolve) => first.once('open', resolve));
    const second = new WebSocket(`ws://127.0.0.1:${r.port}/ws`);
    const secondErr = await new Promise<Error>((resolve) => second.once('error', resolve));
    expect(secondErr.message).toContain('503');
    expect(r.gateway.bridge.stats().refused).toBe(1);
    first.terminate();
    await until(() => r.gateway.stats().wsConnections === 0);
  });

  it('drops a socket that never completes the Noise handshake', async () => {
    const r = await rig({ raw: { ws: { handshakeTimeoutMs: 200 } } });
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/ws`);
    await new Promise<void>((resolve) => ws.once('open', resolve));
    ws.send(Buffer.from('garbage that is not a noise handshake'));
    await new Promise<void>((resolve) =>
      ws.once('close', () => {
        resolve();
      }),
    );
    await until(
      () =>
        r.gateway.bridge.stats().handshakeTimeouts + r.gateway.seeder.stats().sessions >= 1 &&
        r.gateway.stats().wsConnections === 0,
    );
    expect(r.gateway.seeder.stats().sessions).toBe(0);
  });

  it('sessions without a pay/1 factory still replicate and are still cut (no factory = no HELLO)', async () => {
    const r = await rig({ windowBlocks: 2, payProtocol: false });
    const { entry } = await putFixture(r, 10);
    const v = await viewer();
    const vcore = await v.seeder.blobs.openCoreByKey(Buffer.from(entry.coreKey, 'hex'));
    const { closed } = connectViewer(v, r);
    await vcore.blobs.get(entry.blob, { wait: true, timeout: 1500 }).catch(() => null);
    await closed;
    expect(r.log.records.some((rec) => rec.msg.includes('session without pay/1'))).toBe(true);
    expect(
      r.log.records.some(
        (rec) => rec.msg === 'session cut' && rec.fields['reason'] === 'window-exceeded',
      ),
    ).toBe(true);
  });
});
