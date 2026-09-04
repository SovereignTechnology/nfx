import { describe, expect, it } from 'vitest';

import type {
  CashuP2pkPubkey,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  UnixSeconds,
} from '../../contracts/index.js';
import { DEFAULT_BLOCK_SIZE } from '../../contracts/index.js';
import { MockPaymentEngine, denominate, type MockPaymentMode } from '../mock-payment-engine.js';

const MINT = 'https://mint.fixture-a.example' as MintUrl;
const OTHER_MINT = 'https://mint.unknown.example' as MintUrl;
const SEEDER_P2PK = ('02' + 'ab'.repeat(32)) as CashuP2pkPubkey;
const CREATOR_P2PK = ('02' + 'cc'.repeat(32)) as CashuP2pkPubkey;
const SEEDER = 'cd'.repeat(32) as NostrPubkey;
const VIEWER = 'ef'.repeat(32) as NostrPubkey;

const policy: PricePolicy = {
  satsPerBlock: 2 as PricePolicy['satsPerBlock'],
  blockSize: DEFAULT_BLOCK_SIZE,
  mints: [MINT],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
};

function pair(mode: MockPaymentMode = 'honest'): {
  viewer: MockPaymentEngine;
  seeder: MockPaymentEngine;
} {
  let t = 1_000 as UnixSeconds;
  const now = (): UnixSeconds => t++ as UnixSeconds;
  return {
    viewer: new MockPaymentEngine({ mode, now }),
    seeder: new MockPaymentEngine({
      mode: 'honest',
      now,
      config: { ownP2pk: SEEDER_P2PK, ownPubkey: SEEDER, acceptedMints: [MINT] },
    }),
  };
}

const seederInfo = { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: MINT };

describe('denominate', () => {
  it('splits into powers of two, largest first', () => {
    expect(denominate(0)).toEqual([]);
    expect(denominate(1)).toEqual([1]);
    expect(denominate(6)).toEqual([4, 2]);
    expect(denominate(255)).toEqual([128, 64, 32, 16, 8, 4, 2, 1]);
  });
});

describe('MockPaymentEngine honest path', () => {
  it('accepts an exact, correctly-locked PAY for uploaded blocks and credits the window', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(VIEWER, 4);
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
    expect(msg.seederProofs.lockedTo).toBe(SEEDER_P2PK);
    expect(msg.creatorProofs.lockedTo).toBe(CREATOR_P2PK);
    const res = await seeder.verify(VIEWER, msg, policy);
    expect(res).toEqual({ ok: true, credited: 8, blocks: 4 });
    expect(seeder.window(VIEWER)).toMatchObject({
      uploaded: 4,
      paid: 4,
      outstanding: 0,
      banned: false,
    });
    expect(viewer.spent().total).toBe(8);
  });

  it('flush swaps seeder share and nutzaps creator share', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(VIEWER, 4);
    await seeder.verify(
      VIEWER,
      await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy),
      policy,
    );
    expect(await seeder.flush()).toEqual({ swapped: 4, nutzapped: 4, failed: 0 });
    expect(seeder.pendingCount()).toBe(0);
  });

  it('T3: window exceeded → ban + onWindowExceeded, further PAYs rejected as peer-banned', async () => {
    const { viewer, seeder } = pair();
    const seen: number[] = [];
    seeder.onWindowExceeded((w) => seen.push(w.outstanding));
    seeder.recordUpload(VIEWER, 4);
    expect(seeder.isBanned(VIEWER)).toBe(false);
    seeder.recordUpload(VIEWER, 1); // outstanding 5 > window 4
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(seen).toEqual([5]);
    const res = await seeder.verify(
      VIEWER,
      await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy),
      policy,
    );
    expect(res).toMatchObject({ ok: false, reason: 'peer-banned' });
  });

  it('rejects paying for blocks never uploaded and replaying a paid range', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(VIEWER, 2);
    expect(
      await seeder.verify(
        VIEWER,
        await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy),
        policy,
      ),
    ).toMatchObject({ ok: false, reason: 'range-not-uploaded' });
    const ok = await viewer.pay({ fromBlock: 0, toBlock: 1 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, ok, policy)).toMatchObject({ ok: true });
    expect(await seeder.verify(VIEWER, ok, policy)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
  });

  it('rejects a mint outside the allowlist / video policy', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(VIEWER, 1);
    const msg = await viewer.pay(
      { fromBlock: 0, toBlock: 0 },
      { ...seederInfo, mint: OTHER_MINT },
      policy,
    );
    expect(await seeder.verify(VIEWER, msg, policy)).toMatchObject({
      ok: false,
      reason: 'mint-not-accepted',
    });
  });

  it('never throws on garbage — returns malformed', async () => {
    const { seeder } = pair();
    for (const junk of [
      null,
      1,
      'x',
      {},
      { range: {} },
      { range: { fromBlock: 0, toBlock: 0 }, seederProofs: {}, creatorProofs: {} },
    ]) {
      expect(await seeder.verify(VIEWER, junk as never, policy)).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

describe('MockPaymentEngine cheating modes are rejected (adversary seed for L10)', () => {
  const cases: { mode: MockPaymentMode; reason: string; threat: string }[] = [
    { mode: 'stiff-creator', reason: 'wrong-p2pk-target', threat: 'T4' },
    { mode: 'stiff-seeder', reason: 'missing-seeder-set', threat: 'T3' },
    { mode: 'forge', reason: 'bad-dleq', threat: 'T7' },
    { mode: 'overpay', reason: 'overpay', threat: 'invariant 2' },
    { mode: 'underpay', reason: 'wrong-amount', threat: 'invariant 2' },
  ];
  for (const c of cases) {
    it(`${c.threat}: mode=${c.mode} → ${c.reason}`, async () => {
      const { viewer, seeder } = pair(c.mode);
      seeder.recordUpload(VIEWER, 4);
      const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
      const res = await seeder.verify(VIEWER, msg, policy);
      expect(res).toMatchObject({ ok: false, reason: c.reason });
      expect(seeder.window(VIEWER)?.paid).toBe(0);
    });
  }

  it('T5: double-spend passes offline verify, is caught at flush, and bans the peer', async () => {
    const { viewer, seeder } = pair('double-spend');
    const doubles: NostrPubkey[] = [];
    seeder.onDoubleSpend((p) => doubles.push(p));
    seeder.recordUpload(VIEWER, 4);
    // First PAY in double-spend mode has nothing to replay yet, so it's honest.
    const first = await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, first, policy)).toMatchObject({ ok: true });
    seeder.recordUpload(VIEWER, 4);
    // Second PAY reuses the first proofs for a new range.
    const second = await viewer.pay({ fromBlock: 4, toBlock: 7 }, seederInfo, policy);
    expect(second.seederProofs.proofs[0]?.secret).toBe(first.seederProofs.proofs[0]?.secret);
    expect(await seeder.verify(VIEWER, second, policy)).toMatchObject({ ok: true }); // offline check cannot see it
    const r = await seeder.flush();
    expect(r.failed).toBe(1);
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(doubles).toEqual([VIEWER]);
    // Residual loss bounded to ≤ window (4 blocks × 2 sat = 8 sat), exactly as SECURITY.md T5 says.
    expect(r.swapped + r.nutzapped).toBe(8);
  });
});
