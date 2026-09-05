import type { CoreKeyHex, PricePolicy } from '@sovit/core';
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
const CORE_A = mocks.asCoreKey('A');
const CORE_B = mocks.asCoreKey('B');

describe('pay bridge (PayProtocol ⇄ PeerSession ⇄ PaymentEngine.verify)', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    const t = await tmpDir();
    dir = t.dir;
    cleanup = t.rm;
  });
  afterEach(() => cleanup());

  async function rig(
    windowBlocks = 4,
    mode: mocks.MockPaymentMode = 'honest',
    v3: {
      readonly corePolicies?: ReadonlyMap<CoreKeyHex, PricePolicy>;
      readonly replicatedCores?: () => number;
    } = {},
  ) {
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
      policy: (core) => (core === undefined ? undefined : v3.corePolicies?.get(core)) ?? policy,
      ...(v3.replicatedCores ? { replicatedCores: v3.replicatedCores } : {}),
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

  // ---------------------------------------------------------------- contracts v3 (ADR 0004)

  it('v3 (a): a core-less PAY on a stream replicating 2 cores is refused as malformed before the engine sees it', async () => {
    const r = await rig(8);
    const pk = pubkey('v2-client');
    r.protocol.remoteHello(hello(pk));
    for (let i = 0; i < 2; i++) r.session.onUpload(CORE_A, i, 1024);
    for (let i = 0; i < 2; i++) r.session.onUpload(CORE_B, i, 1024);
    expect(r.session.uploadedCores.size).toBe(2);

    const v2pay = await r.viewer.pay({ fromBlock: 0, toBlock: 1 }, r.seederRef, r.policy);
    r.protocol.remotePay(v2pay);
    await tick();
    expect(r.protocol.acks).toEqual([
      { type: 'ACK', fromBlock: 0, toBlock: 1, ok: false, reason: 'malformed' },
    ]);
    // nothing was credited, nothing queued, the session is NOT cut (a refusal, not a ban)
    expect(r.engine.window(pk)).toMatchObject({ uploaded: 4, paid: 0, outstanding: 4 });
    expect(r.engine.pendingCount()).toBe(0);
    expect(r.scheduler.pendingBlocks).toBe(0);
    expect(r.stream.destroyed).toBe(false);
    expect(
      r.log.records.some((x) => x.msg === 'PAY rejected' && x.fields['reason'] === 'malformed'),
    ).toBe(true);

    // The same PAY WITH a core is fine.
    const v3pay = await r.viewer.pay(
      { core: CORE_A, fromBlock: 0, toBlock: 1 },
      r.seederRef,
      r.policy,
    );
    r.protocol.remotePay(v3pay);
    await tick();
    expect(r.protocol.acks[1]).toMatchObject({ ok: true });
    expect(r.engine.window(pk)).toMatchObject({ paid: 2, outstanding: 2 });
    await r.scheduler.stop({ flush: false });
    r.detach();
  });

  it('v3 (a): the seeder-supplied replicatedCores view counts too, even before a block was uploaded from the 2nd core', async () => {
    let cores = 1;
    const r = await rig(8, 'honest', { replicatedCores: () => cores });
    const pk = pubkey('v2-client-2');
    r.protocol.remoteHello(hello(pk));
    for (let i = 0; i < 2; i++) r.session.onUpload(CORE_A, i, 1024);
    // one core on the stream: v2 aggregate semantics still apply
    r.protocol.remotePay(await r.viewer.pay({ fromBlock: 0, toBlock: 0 }, r.seederRef, r.policy));
    await tick();
    expect(r.protocol.acks[0]).toMatchObject({ ok: true });
    // the peer attached a second core (no upload from it yet): core-less PAY now malformed
    cores = 2;
    r.protocol.remotePay(await r.viewer.pay({ fromBlock: 1, toBlock: 1 }, r.seederRef, r.policy));
    await tick();
    expect(r.protocol.acks[1]).toMatchObject({ ok: false, reason: 'malformed' });
    await r.scheduler.stop({ flush: false });
  });

  it("v3 (c): the policy is resolved per range.core — a PAY for core B is verified against B's policy, not the default", async () => {
    const policyB: PricePolicy = {
      satsPerBlock: 5 as never,
      blockSize: 1024,
      mints: honestEngine().config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: mocks.asP2pk('creator-B'),
    };
    const r = await rig(16, 'honest', { corePolicies: new Map([[CORE_B, policyB]]) });
    const pk = pubkey('per-core');
    r.protocol.remoteHello(hello(pk));
    for (let i = 0; i < 4; i++) r.session.onUpload(CORE_A, i, 1024);
    for (let i = 0; i < 4; i++) r.session.onUpload(CORE_B, i, 1024);

    // Paying core B's blocks at the DEFAULT price (2 sat, creator A) fails on B's policy:
    // the creator set is locked to the wrong creator (T4) — the first check that differs.
    const cheap = await r.viewer.pay(
      { core: CORE_B, fromBlock: 0, toBlock: 1 },
      r.seederRef,
      r.policy,
    );
    r.protocol.remotePay(cheap);
    await tick();
    expect(r.protocol.acks[0]).toMatchObject({ ok: false, reason: 'wrong-p2pk-target' });

    // Right creator, still the cheap price → exact-amount check under B's policy.
    const underpaid = await r.viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 1 }, r.seederRef, {
      ...policyB,
      satsPerBlock: r.policy.satsPerBlock,
    });
    r.protocol.remotePay(underpaid);
    await tick();
    expect(r.protocol.acks[1]).toMatchObject({ ok: false, reason: 'wrong-amount' });

    // Paid under B's policy → accepted, credited at 2 × 5 sat.
    const right = await r.viewer.pay(
      { core: CORE_B, fromBlock: 0, toBlock: 1 },
      r.seederRef,
      policyB,
    );
    r.protocol.remotePay(right);
    await tick();
    expect(r.protocol.acks[2]).toMatchObject({ ok: true });
    // Core A has no override → default policy.
    const a = await r.viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 3 }, r.seederRef, r.policy);
    r.protocol.remotePay(a);
    await tick();
    expect(r.protocol.acks[3]).toMatchObject({ ok: true });
    expect(r.engine.window(pk)).toMatchObject({ uploaded: 8, paid: 6, outstanding: 2 });
    await r.scheduler.stop({ flush: false });
    for (const line of r.log.lines) expect(line).not.toContain('mock:');
  });
});
