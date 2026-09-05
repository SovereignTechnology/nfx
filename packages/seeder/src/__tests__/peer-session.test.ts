import type { NostrPubkey } from '@sovit/core';
import { mocks } from '@sovit/core';
import type { PeerInfo } from 'hyperswarm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PeerSession } from '../net/peer-session.js';
import { toHex } from '../util/hex.js';
import {
  FakeStream,
  capturedLogger,
  honestEngine,
  loadedBanList,
  noiseKey,
  pubkey,
  tmpDir,
} from './helpers.js';
import type { CapturedLog } from './helpers.js';

function fakePeerInfo(): PeerInfo & { banCalls: boolean[] } {
  const p = {
    publicKey: noiseKey(1),
    topics: [],
    banned: false,
    client: true,
    banCalls: [] as boolean[],
    ban(v = false): void {
      p.banCalls.push(v);
      p.banned = v;
    },
  };
  return p;
}

const CORE_A = mocks.asCoreKey('A');
const CORE_B = mocks.asCoreKey('B');

describe('PeerSession', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let log: CapturedLog;
  beforeEach(async () => {
    const t = await tmpDir();
    dir = t.dir;
    cleanup = t.rm;
    log = capturedLogger();
  });
  afterEach(() => cleanup());

  async function make(windowBlocks = 4, withPeerInfo = true) {
    const engine = honestEngine(windowBlocks);
    const banList = await loadedBanList(dir);
    const stream = new FakeStream(noiseKey(1));
    const peerInfo = withPeerInfo ? fakePeerInfo() : null;
    const session = new PeerSession({
      noiseKey: noiseKey(1),
      stream,
      engine,
      banList,
      logger: log.logger,
      peerInfo,
    });
    return { engine, banList, stream, peerInfo, session };
  }

  it('records every upload synchronously and cuts on the block that crosses the window', async () => {
    const { engine, banList, stream, peerInfo, session } = await make(4);
    for (let i = 0; i < 4; i++) {
      const w = session.onUpload('core', i, 1024);
      expect(w?.outstanding).toBe(i + 1);
      expect(stream.destroyed).toBe(false);
    }
    // 5th block: cut in the SAME call, before returning to Hypercore
    const w = session.onUpload('core', 4, 1024);
    expect(w?.outstanding).toBe(5);
    expect(w?.banned).toBe(true);
    expect(stream.destroyed).toBe(true);
    expect(stream.destroyCalls).toBe(1);
    expect(session.cutReason).toBe('window-exceeded');
    // banned on both keys, engine and swarm
    expect(banList.isNoiseBanned(noiseKey(1))).toBe(true);
    expect(engine.isBanned(session.accountId())).toBe(true);
    expect(peerInfo?.banCalls).toEqual([true]);
    // further uploads are ignored (no double accounting)
    expect(session.onUpload('core', 5, 1024)).toBeNull();
    expect(session.uploadedBlocks).toBe(5);
    expect(session.info().window?.uploaded).toBe(5);
    // the ban went to disk
    await banList.flushed();
    const reloaded = await loadedBanList(dir);
    expect(reloaded.isNoiseBanned(noiseKey(1))).toBe(true);
  });

  it('v3: accounts pre-HELLO uploads under the noise key and rebind()s them onto the bound pubkey (no provisional entry left)', async () => {
    const { engine, session } = await make(4);
    const noiseHex = toHex(noiseKey(1)) as NostrPubkey;
    expect(session.accountId()).toBe(noiseHex);
    session.onUpload(CORE_A, 0, 1);
    session.onUpload(CORE_A, 1, 1);
    expect(engine.windows().map((w) => w.peer)).toEqual([noiseHex]);

    const pk = pubkey('viewer');
    expect(session.bindPubkey(pk)).toBe(true);
    expect(session.accountId()).toBe(pk);
    // (b) the provisional (Noise-hex) window is GONE and the pubkey's carries the pre-HELLO blocks
    expect(engine.windows().map((w) => w.peer)).toEqual([pk]);
    expect(engine.window(noiseHex)).toBeUndefined();
    expect(engine.window(pk)).toMatchObject({ uploaded: 2, paid: 0, outstanding: 2 });
    expect(engine.log.some((e) => e.kind === 'rebind' && e.peer === pk)).toBe(true);

    session.onUpload(CORE_A, 2, 1);
    expect(engine.window(pk)).toMatchObject({ uploaded: 3, outstanding: 3 });
    // The per-core breakdown travelled with the rebind: a PAY naming core A for all 3 verifies.
    const viewer = honestEngine();
    const policy = {
      satsPerBlock: 2 as never,
      blockSize: 1,
      mints: engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: ('02' + '11'.repeat(32)) as never,
    };
    const ref = {
      pubkey: engine.config.ownPubkey,
      p2pk: engine.config.ownP2pk,
      mint: engine.config.acceptedMints[0]!,
    };
    const msg = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 2 }, ref, policy);
    expect(await session.verifyPay(msg, policy)).toMatchObject({ ok: true, blocks: 3 });
    expect(engine.window(pk)).toMatchObject({ uploaded: 3, paid: 3, outstanding: 0 });
    // binding the same pubkey again is a no-op (no second rebind, no double count)
    expect(session.bindPubkey(pk)).toBe(true);
    expect(engine.window(pk)).toMatchObject({ uploaded: 3, paid: 3 });
    expect(engine.log.filter((e) => e.kind === 'rebind')).toHaveLength(1);
  });

  it('v3: recordUpload carries the core — the engine keeps per-core counts and the session lists its cores', async () => {
    const { engine, session } = await make(8);
    session.onUpload(CORE_A, 0, 1);
    session.onUpload(CORE_A, 1, 1);
    session.onUpload(CORE_B, 0, 1);
    expect([...session.uploadedCores]).toEqual([CORE_A, CORE_B]);
    const pk = pubkey('v');
    session.bindPubkey(pk);
    const viewer = honestEngine();
    const policy = {
      satsPerBlock: 2 as never,
      blockSize: 1,
      mints: engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: ('02' + '11'.repeat(32)) as never,
    };
    const ref = {
      pubkey: engine.config.ownPubkey,
      p2pk: engine.config.ownP2pk,
      mint: engine.config.acceptedMints[0]!,
    };
    // 3 blocks in total, but only 1 on core B: B[0..1] is `range-not-uploaded` per core.
    const lie = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 1 }, ref, policy);
    expect(await session.verifyPay(lie, policy)).toMatchObject({
      ok: false,
      reason: 'range-not-uploaded',
    });
    const ok = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 0 }, ref, policy);
    expect(await session.verifyPay(ok, policy)).toMatchObject({ ok: true, blocks: 1 });
  });

  it('v3: a rebind whose merged outstanding crosses the window cuts synchronously (engine listener or session check)', async () => {
    const { engine, stream, session } = await make(4);
    const pk = pubkey('two-sessions');
    engine.recordUpload(pk, 3, CORE_A); // an earlier session of the same pubkey, unpaid
    session.onUpload(CORE_A, 0, 1);
    session.onUpload(CORE_A, 1, 1);
    expect(stream.destroyed).toBe(false);
    expect(session.bindPubkey(pk)).toBe(false);
    expect(session.cutReason).toBe('window-exceeded');
    expect(stream.destroyed).toBe(true);
    expect(engine.window(pk)).toMatchObject({ uploaded: 5, outstanding: 5, banned: true });
    expect(engine.window(toHex(noiseKey(1)) as NostrPubkey)).toBeUndefined();
  });

  it('v3: mux getter exposes the protomux on the noise stream (null on a bare stream)', async () => {
    const { session, stream } = await make();
    expect(session.mux).toBeNull();
    const fakeMux = { createChannel: () => ({}) };
    stream.userData = fakeMux;
    expect(session.mux).toBe(fakeMux);
    stream.userData = { notAMux: true };
    expect(session.mux).toBeNull();
  });

  it('cuts with "banned" when a banned pubkey binds, and persists the noise key with it', async () => {
    const { banList, stream, session } = await make(4);
    const pk = pubkey('bad');
    banList.ban({ pubkey: pk, reason: 'earlier' });
    expect(session.bindPubkey(pk)).toBe(false);
    expect(session.cutReason).toBe('banned');
    expect(stream.destroyed).toBe(true);
    expect(banList.isNoiseBanned(noiseKey(1))).toBe(true);
    expect(banList.isPubkeyBanned(pk)).toBe(true);
  });

  it('refuses to rebind to a different pubkey', async () => {
    const { session, stream } = await make();
    expect(session.bindPubkey(pubkey('a'))).toBe(true);
    expect(session.bindPubkey(pubkey('a'))).toBe(true);
    expect(session.bindPubkey(pubkey('b'))).toBe(false);
    expect(session.cutReason).toBe('protocol-error');
    expect(stream.destroyed).toBe(true);
  });

  it('non-payment cuts drop the stream without banning', async () => {
    const { banList, engine, stream, peerInfo, session } = await make();
    session.cut('local');
    session.cut('banned'); // idempotent: first reason wins
    expect(session.cutReason).toBe('local');
    expect(stream.destroyed).toBe(true);
    expect(banList.entries()).toHaveLength(0);
    expect(engine.bans()).toHaveLength(0);
    expect(peerInfo?.banCalls).toEqual([]);
  });

  it('verifyPay refuses after a cut and otherwise delegates to the engine', async () => {
    const { session, engine } = await make(8);
    const viewer = honestEngine();
    const pk = pubkey('v');
    session.bindPubkey(pk);
    for (let i = 0; i < 4; i++) session.onUpload('c', i, 1);
    const policy = {
      satsPerBlock: 2 as never,
      blockSize: 1,
      mints: engine.config.acceptedMints,
      split: { seeder: 50, creator: 50 },
      creatorP2pk: ('02' + '11'.repeat(32)) as never,
    };
    const msg = await viewer.pay(
      { fromBlock: 0, toBlock: 3 },
      {
        pubkey: engine.config.ownPubkey,
        p2pk: engine.config.ownP2pk,
        mint: engine.config.acceptedMints[0]!,
      },
      policy,
    );
    const r = await session.verifyPay(msg, policy);
    expect(r).toMatchObject({ ok: true, blocks: 4 });
    expect(engine.window(pk)?.outstanding).toBe(0);
    const again = await session.verifyPay(msg, policy);
    expect(again).toMatchObject({ ok: false, reason: 'range-already-paid' });
    session.cut('local');
    expect(await session.verifyPay(msg, policy)).toMatchObject({
      ok: false,
      reason: 'peer-banned',
    });
    // nothing secret in the logs
    for (const line of log.lines) {
      expect(line).not.toContain('mock:');
      expect(line).not.toMatch(/"secret"/);
    }
  });
});
