import type { PricePolicy } from '@sovit/core';
import { mocks } from '@sovit/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PeerSession } from '../net/peer-session.js';
import { FlushScheduler } from '../payment/flush-scheduler.js';
import { attachPayBridge } from '../payment/pay-bridge.js';
import { FakePayProtocol, hello } from './fake-pay-protocol.js';
import {
  FakeStream,
  capturedLogger,
  honestEngine,
  loadedBanList,
  noiseKey,
  pubkey,
  tmpDir,
} from './helpers.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('pay bridge (PayProtocol ⇄ PeerSession ⇄ PaymentEngine.verify)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const t = await tmpDir();
    dir = t.dir;
    cleanup = t.rm;
  });
  afterEach(() => cleanup());

  async function rig(windowBlocks = 4, mode: mocks.MockPaymentMode = 'honest') {
    const engine = honestEngine(windowBlocks);
    const viewer = new mocks.MockPaymentEngine({ mode });
    const banList = await loadedBanList(dir);
    const log = capturedLogger();
    const stream = new FakeStream(noiseKey(2));
    const session = new PeerSession({
      noiseKey: noiseKey(2),
      stream,
      engine,
      banList,
      logger: log.logger,
    });
    const protocol = new FakePayProtocol();
    const scheduler = new FlushScheduler(engine, {
      everyBlocks: 1000,
      everyMs: 60_000,
      logger: log.logger,
    });
    const policy: PricePolicy = {
      satsPerBlock: 2 as never,
      blockSize: 1024,
      mints: engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator'),
    };
    const detach = attachPayBridge({
      session,
      protocol,
      policy: () => policy,
      scheduler,
      logger: log.logger,
    });
    const seederRef = {
      pubkey: engine.config.ownPubkey,
      p2pk: engine.config.ownP2pk,
      mint: policy.mints[0]!,
    };
    return {
      engine,
      viewer,
      banList,
      log,
      stream,
      session,
      protocol,
      scheduler,
      policy,
      detach,
      seederRef,
    };
  }

  it('HELLO binds the pubkey; honest PAY is verified, ACKed and credited; scheduler counts blocks', async () => {
    const r = await rig(4);
    const pk = pubkey('viewer');
    r.protocol.remoteHello(hello(pk));
    expect(r.session.pubkey).toBe(pk);

    for (let i = 0; i < 4; i++) r.session.onUpload('c', i, 1024);
    expect(r.engine.window(pk)?.outstanding).toBe(4);

    const msg = await r.viewer.pay({ fromBlock: 0, toBlock: 3 }, r.seederRef, r.policy);
    r.protocol.remotePay(msg);
    await tick();
    expect(r.protocol.acks).toEqual([{ type: 'ACK', fromBlock: 0, toBlock: 3, ok: true }]);
    expect(r.engine.window(pk)?.outstanding).toBe(0);
    expect(r.scheduler.pendingBlocks).toBe(4);
    expect(r.engine.pendingCount()).toBe(1);

    // Window is free again: 4 more blocks flow without a cut.
    for (let i = 4; i < 8; i++) r.session.onUpload('c', i, 1024);
    expect(r.stream.destroyed).toBe(false);
    r.session.onUpload('c', 8, 1024);
    expect(r.stream.destroyed).toBe(true);
    expect(r.session.cutReason).toBe('window-exceeded');
    await r.scheduler.stop({ flush: false });
    r.detach();
    for (const line of r.log.lines) expect(line).not.toContain('mock:');
  });

  it('a cheating PAY is rejected with the engine reason and the window stays open', async () => {
    const r = await rig(4, 'stiff-creator');
    const pk = pubkey('cheat');
    r.protocol.remoteHello(hello(pk));
    for (let i = 0; i < 3; i++) r.session.onUpload('c', i, 1024);
    const msg = await r.viewer.pay({ fromBlock: 0, toBlock: 2 }, r.seederRef, r.policy);
    r.protocol.remotePay(msg);
    await tick();
    expect(r.protocol.acks[0]).toMatchObject({ ok: false, reason: 'wrong-p2pk-target' });
    expect(r.engine.window(pk)?.outstanding).toBe(3);
    expect(r.stream.destroyed).toBe(false);
    await r.scheduler.stop({ flush: false });
  });

  it('a banned pubkey in HELLO is cut immediately; PAY from a cut session gets peer-banned', async () => {
    const r = await rig(4);
    const pk = pubkey('banned');
    r.banList.ban({ pubkey: pk, reason: 'test' });
    r.protocol.remoteHello(hello(pk));
    expect(r.session.cutReason).toBe('banned');
    expect(r.stream.destroyed).toBe(true);
    await r.scheduler.stop({ flush: false });
  });

  it('a remote/protocol close with a payment reason mirrors onto the session', async () => {
    const r = await rig(4);
    r.protocol.remoteHello(hello(pubkey('x')));
    r.protocol.remoteClose('remote');
    expect(r.session.cutReason).toBeNull();
    r.protocol.remoteClose('protocol-error');
    expect(r.session.cutReason).toBe('protocol-error');
    expect(r.banList.entries()).toHaveLength(0);
    await r.scheduler.stop({ flush: false });
  });

  it('double-spend detected at flush bans via the engine (seeder-level wiring is tested in seeder.test)', async () => {
    const r = await rig(8, 'double-spend');
    const pk = pubkey('ds');
    r.protocol.remoteHello(hello(pk));
    for (let i = 0; i < 8; i++) r.session.onUpload('c', i, 1024);
    const m1 = await r.viewer.pay({ fromBlock: 0, toBlock: 3 }, r.seederRef, r.policy);
    const m2 = await r.viewer.pay({ fromBlock: 4, toBlock: 7 }, r.seederRef, r.policy); // replays m1's proofs
    r.protocol.remotePay(m1);
    await tick();
    r.protocol.remotePay(m2);
    await tick();
    expect(r.protocol.acks.map((a) => a.ok)).toEqual([true, true]); // offline checks pass
    const res = await r.scheduler.flush();
    expect(res.failed).toBe(1);
    expect(r.engine.isBanned(pk)).toBe(true);
    await r.scheduler.stop({ flush: false });
  });
});
