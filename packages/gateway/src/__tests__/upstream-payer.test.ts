/**
 * The gateway as a viewer toward upstream seeders (build-plan §5 "pays upstream").
 *
 * Unit part: `UpstreamPayer` + `FakePayProtocol` + `MockPaymentEngine('honest')`.
 * Integration part: a `Gateway` replicates a blob from a real upstream `Seeder` over a
 * directly piped stream pair, pays per verified block, and the upstream seeder's own
 * engine VERIFIES and ACKs every `PAY` the gateway built — with `range.core` set on all
 * of them (contracts v3, ADR 0004).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { mocks } from '@sovit/core';
import type { CoreKeyHex, PayMessage, PricePolicy, Sats } from '@sovit/core';
import { Seeder, nodeCrypto, nodeFs, toHex } from '@sovit/seeder';

import { UpstreamPayer, helloPolicyResolver } from '../upstream/payer.js';
import { FakePayProtocol, helloFrom } from './fake-pay-protocol.js';
import {
  BLOCK,
  CREATOR_P2PK,
  MINT_A,
  MINT_B,
  basePolicy,
  capturedLogger,
  cleanupRigs,
  fixtureBytes,
  pubkey,
  rig,
  settle,
  tmpDir,
  until,
} from './helpers.js';

afterEach(cleanupRigs);

const CORE_A = 'aa'.repeat(32) as CoreKeyHex;
const CORE_B = 'bb'.repeat(32) as CoreKeyHex;
const UP_PUBKEY = pubkey('upstream');
const UP_P2PK = ('02' + '11'.repeat(32)) as PricePolicy['creatorP2pk'];
const NOISE = 'ee'.repeat(32);

function unit(payEveryBlocks = 2, opts: { policy?: PricePolicy | null } = {}) {
  const engine = new mocks.MockPaymentEngine({ mode: 'honest' });
  const log = capturedLogger();
  const perCore = new Map<CoreKeyHex, PricePolicy>();
  const payer = new UpstreamPayer({
    engine,
    logger: log.logger,
    payEveryBlocks,
    ownMints: [MINT_A, MINT_B],
    policyFor:
      opts.policy === null
        ? () => null
        : opts.policy
          ? () => opts.policy!
          : helloPolicyResolver(basePolicy(), () => perCore),
  });
  const protocol = new FakePayProtocol();
  const detach = payer.attachPeer(NOISE, protocol);
  return { engine, payer, protocol, detach, log, perCore };
}

const hello = () =>
  helloFrom(UP_PUBKEY, { acceptedMints: [MINT_B, MINT_A], satsPerBlock: 3 as Sats, p2pk: UP_P2PK });

describe('UpstreamPayer (unit)', () => {
  it('pays every N contiguous verified blocks with range.core set, at the HELLO price, to the HELLO pubkey/p2pk/common mint', async () => {
    const { engine, payer, protocol } = unit(2);
    protocol.remoteHello(hello());
    for (let i = 0; i < 5; i++) payer.onDownload(CORE_A, i, NOISE);
    await payer.flush();
    // Downloads that land in one tick are batched into ONE PAY for the whole contiguous run
    // (the pay is scheduled on a microtask, so `payEveryBlocks` is a lower bound per PAY,
    // not a chunk size). Coverage is what matters: 0..4 exactly once, every PAY ≥ 1 block.
    const covered = protocol.sentPays.flatMap((p) =>
      Array.from(
        { length: p.range.toBlock - p.range.fromBlock + 1 },
        (_, k) => p.range.fromBlock + k,
      ),
    );
    expect(covered.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(protocol.sentPays.length).toBeGreaterThanOrEqual(1);
    expect(protocol.sentPays.length).toBeLessThanOrEqual(3);
    for (const p of protocol.sentPays) {
      expect(p.range.core).toBe(CORE_A);
      expect(p.seederProofs.lockedTo).toBe(UP_P2PK);
      expect(p.creatorProofs.lockedTo).toBe(CREATOR_P2PK);
      expect(p.seederProofs.mint).toBe(MINT_B); // the seeder's FIRST listed mint we can pay with
    }
    // 5 blocks × 3 sats = 15 sats spent on that seeder (invariant 2: never more).
    expect(engine.spent().perPeer.get(UP_PUBKEY)).toBe(15);
    expect(payer.stats()).toMatchObject({
      pays: protocol.sentPays.length,
      blocksPaid: 5,
      skippedNoPolicy: 0,
    });

    // Blocks arriving one tick apart ARE paid every `payEveryBlocks`.
    const paced = unit(2);
    paced.protocol.remoteHello(hello());
    for (let i = 0; i < 4; i++) {
      paced.payer.onDownload(CORE_B, i, NOISE);
      await settle(5);
    }
    expect(paced.protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('never pays a block twice, splits non-contiguous runs, and keeps cores apart', async () => {
    const { payer, protocol } = unit(1);
    protocol.remoteHello(hello());
    for (const i of [0, 1, 3, 0, 1]) payer.onDownload(CORE_A, i, NOISE);
    payer.onDownload(CORE_B, 0, NOISE);
    await payer.flush();
    const ranges = protocol.sentPays.map(
      (p) => `${p.range.core?.slice(0, 2) ?? '?'}:${p.range.fromBlock}-${p.range.toBlock}`,
    );
    expect(ranges.sort()).toEqual(['aa:0-1', 'aa:3-3', 'bb:0-0']);
    payer.onDownload(CORE_A, 1, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(3);
    // Every PAY carries a core (v3 requirement for the multi-core gateway).
    expect(protocol.sentPays.every((p) => p.range.core !== undefined)).toBe(true);
  });

  it('blocks from a peer that has not sent HELLO are counted and paid the moment it does', async () => {
    const { payer, protocol } = unit(2);
    for (let i = 0; i < 4; i++) payer.onDownload(CORE_A, i, NOISE);
    await payer.flush();
    expect(protocol.sentPays).toHaveLength(0);
    protocol.remoteHello(hello());
    await payer.flush();
    expect(protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([[0, 3]]);
  });

  it('PRICE splits a run at effectiveFromBlock: old price below, new price from it', async () => {
    const { engine, payer, protocol } = unit(10);
    protocol.remoteHello(hello());
    for (let i = 0; i < 6; i++) payer.onDownload(CORE_A, i, NOISE);
    protocol.remotePrice({ type: 'PRICE', satsPerBlock: 5 as Sats, effectiveFromBlock: 4 });
    await payer.flush();
    expect(protocol.sentPays.map((p) => [p.range.fromBlock, p.range.toBlock])).toEqual([
      [0, 3],
      [4, 5],
    ]);
    expect(engine.spent().perPeer.get(UP_PUBKEY)).toBe(4 * 3 + 2 * 5);
  });

  it('no policy / no common mint → nothing is paid and it is counted; ACKs are tallied; detach stops paying', async () => {
    const noPolicy = unit(1, { policy: null });
    noPolicy.protocol.remoteHello(hello());
    noPolicy.payer.onDownload(CORE_A, 0, NOISE);
    await noPolicy.payer.flush();
    expect(noPolicy.protocol.sentPays).toHaveLength(0);
    // The block stays pending (payable once a policy appears), so every pay attempt —
    // HELLO, the download, the flush — counts one skip.
    expect(noPolicy.payer.stats().skippedNoPolicy).toBeGreaterThanOrEqual(1);
    expect(noPolicy.payer.stats().blocksPaid).toBe(0);

    const noMint = unit(1);
    noMint.protocol.remoteHello(
      helloFrom(UP_PUBKEY, { acceptedMints: ['https://mint.other.example' as never] }),
    );
    noMint.payer.onDownload(CORE_A, 0, NOISE);
    await noMint.payer.flush();
    expect(noMint.protocol.sentPays).toHaveLength(0);
    expect(noMint.log.records.some((r) => r.msg.includes('no common mint'))).toBe(true);

    const u = unit(1);
    u.protocol.remoteHello(hello());
    u.payer.onDownload(CORE_A, 0, NOISE);
    await u.payer.flush();
    u.protocol.remoteAck({ type: 'ACK', fromBlock: 0, toBlock: 0, ok: true });
    u.protocol.remoteAck({
      type: 'ACK',
      fromBlock: 0,
      toBlock: 0,
      ok: false,
      reason: 'wrong-amount',
    });
    expect(u.payer.stats()).toMatchObject({ acksOk: 1, acksRejected: 1 });
    u.detach();
    u.payer.onDownload(CORE_A, 1, NOISE);
    await u.payer.flush();
    expect(u.protocol.sentPays).toHaveLength(1);
  });

  it('logs never carry proofs (redaction layer in front of the payer)', async () => {
    const { payer, protocol, log } = unit(1);
    protocol.remoteHello(hello());
    payer.onDownload(CORE_A, 0, NOISE);
    await payer.flush();
    const secrets = protocol.sentPays.flatMap((p) =>
      [...p.seederProofs.proofs, ...p.creatorProofs.proofs].map((x) => x.secret),
    );
    expect(secrets.length).toBeGreaterThan(0);
    const text = log.lines.join('\n');
    for (const s of secrets) expect(text).not.toContain(s);
  });
});

describe('UpstreamPayer (integration): gateway pulls from a real upstream seeder and pays it', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0).reverse()) await c();
  });

  async function upstream() {
    const t = await tmpDir('nutflix-l3-upstream-');
    const engine = new mocks.MockPaymentEngine({
      mode: 'honest',
      config: {
        windowBlocks: 100,
        acceptedMints: [MINT_A, MINT_B],
        ownP2pk: UP_P2PK,
        ownPubkey: UP_PUBKEY,
      },
    });
    const log = capturedLogger();
    const seeder = await Seeder.create(
      {
        dataDir: t.dir,
        diskCapBytes: 1024 * 1024,
        blockSize: BLOCK,
        swarm: null,
        policy: basePolicy(3),
        flushEveryBlocks: 1000,
        flushEveryMs: 60_000,
      },
      { engine, logger: log.logger, fs: nodeFs, crypto: nodeCrypto },
    );
    seeder.start();
    closers.push(async () => {
      await seeder.close();
      await t.rm();
    });
    return { seeder, engine, log };
  }

  it('every PAY names the core, covers every downloaded block once, and verifies OK at the upstream seeder', async () => {
    const BLOCKS = 9;
    const up = await upstream();
    const data = fixtureBytes(BLOCKS, 21);
    const put = await up.seeder.putBytes(data, { mime: 'video/mp4' });
    if (!put.ok) throw new Error(put.error.code);
    const coreKey = put.entry.coreKey;

    const r = await rig({ windowBlocks: 100, raw: { upstream: { payEveryBlocks: 2 } } });
    // Directly piped replication streams (no swarm): gateway = initiator toward upstream.
    const gwStream = r.gateway.seeder.replicate(true);
    const upStream = up.seeder.replicate(false);
    gwStream.on('error', () => undefined);
    upStream.on('error', () => undefined);
    gwStream.pipe(upStream).pipe(gwStream);

    // The upstream side's pay/1 is the fake too (Stage 2 owns the real wire); we bridge
    // the two fakes by hand: gateway.sendPay → upstream.remotePay, upstream.sendAck → gateway.remoteAck.
    const upProto = new FakePayProtocol();
    await until(() => r.protocols.length === 1);
    const gwProto = r.protocols[0]!;
    const upSession = await (async () => {
      await until(() => up.seeder.sessionInfos().length === 1);
      return up.seeder.session(up.seeder.sessionInfos()[0]!.noiseKeyHex)!;
    })();
    up.seeder.attachPayProtocol(upSession, upProto);
    const forwarded: PayMessage[] = [];
    const origSendPay = gwProto.sendPay.bind(gwProto);
    gwProto.sendPay = (msg) => {
      origSendPay(msg);
      forwarded.push(msg);
      upProto.remotePay(msg);
    };
    const origSendAck = upProto.sendAck.bind(upProto);
    upProto.sendAck = (ack) => {
      origSendAck(ack);
      gwProto.remoteAck({ type: 'ACK', ...ack });
    };
    // Upstream's HELLO reaches the gateway (price 3, its mints, its P2PK).
    gwProto.remoteHello(
      helloFrom(UP_PUBKEY, {
        acceptedMints: [MINT_A, MINT_B],
        satsPerBlock: 3 as Sats,
        p2pk: UP_P2PK,
      }),
    );

    const sc = await r.gateway.openUpstreamCore(coreKey);
    const got = await sc.blobs.get(put.entry.blob, { wait: true, timeout: 8000 });
    expect(got).not.toBeNull();
    expect(Buffer.from(got!).equals(Buffer.from(data))).toBe(true);
    await r.gateway.payer.flush();
    await until(
      () => upProto.acks.length === gwProto.sentPays.length && gwProto.sentPays.length > 0,
    );
    await settle(100);

    // Every PAY carries the core and, together, they cover 0..BLOCKS-1 exactly once
    // (how many PAYs depends on how the `download` events batched — see the unit test).
    expect(gwProto.sentPays.length).toBeGreaterThanOrEqual(1);
    const covered: number[] = [];
    for (const p of gwProto.sentPays) {
      expect(p.range.core).toBe(coreKey);
      for (let i = p.range.fromBlock; i <= p.range.toBlock; i++) covered.push(i);
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([...Array(BLOCKS).keys()]);
    // The upstream seeder verified each one offline and ACKed ok (invariant 4).
    expect(upProto.acks.every((a) => a.ok)).toBe(true);
    expect(upProto.acks).toHaveLength(gwProto.sentPays.length);
    expect(r.gateway.payer.stats()).toMatchObject({
      acksOk: upProto.acks.length,
      acksRejected: 0,
      blocksPaid: BLOCKS,
    });
    // Upstream window for the gateway's provisional identity is fully paid.
    const gwNoise = toHex(gwStream.noiseStream.publicKey!);
    expect(up.engine.window(gwNoise as never)).toMatchObject({
      uploaded: BLOCKS,
      paid: BLOCKS,
      outstanding: 0,
    });
    // The gateway spent exactly blocks × upstream price (invariant 2), locked to the upstream P2PK.
    expect(r.engine.spent().perPeer.get(UP_PUBKEY)).toBe(BLOCKS * 3);
    expect(forwarded.every((m) => m.seederProofs.lockedTo === UP_P2PK)).toBe(true);
    // And the blob is now served by the gateway as its own (Blossom index is the seeder's).
    expect(r.gateway.seeder.blobs.coreByKey(coreKey)).toBeDefined();
  });

  it('pays with a per-core policy override when one is set (creator P2PK from the manifest)', async () => {
    const { payer, protocol, perCore } = unit(1);
    const creator = ('03' + '77'.repeat(32)) as PricePolicy['creatorP2pk'];
    perCore.set(CORE_A, { ...basePolicy(), creatorP2pk: creator });
    protocol.remoteHello(hello());
    payer.onDownload(CORE_A, 0, NOISE);
    payer.onDownload(CORE_B, 0, NOISE);
    await payer.flush();
    const byCore = new Map(protocol.sentPays.map((p) => [p.range.core, p.creatorProofs.lockedTo]));
    expect(byCore.get(CORE_A)).toBe(creator);
    expect(byCore.get(CORE_B)).toBe(CREATOR_P2PK);
  });
});
