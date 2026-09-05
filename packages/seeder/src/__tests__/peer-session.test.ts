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

  it('accounts pre-HELLO uploads under the noise key and replays them onto the bound pubkey', async () => {
    const { engine, session } = await make(4);
    expect(session.accountId()).toBe(toHex(noiseKey(1)));
    session.onUpload('core', 0, 1);
    session.onUpload('core', 1, 1);
    const pk = pubkey('viewer');
    expect(session.bindPubkey(pk)).toBe(true);
    expect(session.accountId()).toBe(pk);
    expect(engine.window(pk)?.uploaded).toBe(2);
    session.onUpload('core', 2, 1);
    expect(engine.window(pk)?.uploaded).toBe(3);
    expect(engine.window(pk)?.outstanding).toBe(3);
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
      satsPerBlock: 1 as never,
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
