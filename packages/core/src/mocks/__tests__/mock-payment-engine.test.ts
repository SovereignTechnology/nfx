import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  UnixSeconds,
} from '../../contracts/index.js';
import { DEFAULT_BLOCK_SIZE } from '../../contracts/index.js';
import {
  MockPaymentEngine,
  denominate,
  isPayMessage,
  type MockPaymentMode,
} from '../mock-payment-engine.js';

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

// ---------------------------------------------------------------------------------------
// L10 extensions — pins the reference model's test hooks and edges the adversary suite in
// core/src/payment/__tests__/ relies on. Interface-level properties live there, not here.
// ---------------------------------------------------------------------------------------

describe('MockPaymentEngine reference-model hooks (L10)', () => {
  it('isPayMessage never throws and rejects everything that is not a PayMessage; accepts what pay() emits', async () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(isPayMessage(x)).toBe(false);
      }),
      { numRuns: 300 },
    );
    const { viewer } = pair();
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
    expect(isPayMessage(msg)).toBe(true);
    // Proof amounts must be positive integers; unit must be the literal 'sat'.
    const p0 = msg.seederProofs.proofs[0]!;
    for (const bad of [0, -1, 1.5, '1', null]) {
      expect(
        isPayMessage({
          ...msg,
          seederProofs: { ...msg.seederProofs, proofs: [{ ...p0, amount: bad }] },
        }),
      ).toBe(false);
    }
    expect(isPayMessage({ ...msg, creatorProofs: { ...msg.creatorProofs, unit: 'usd' } })).toBe(
      false,
    );
  });

  it('ban() keeps the Noise key, unban() restores service, and both are visible in log + bans()', async () => {
    const { viewer, seeder } = pair();
    const noise = new Uint8Array([1, 2, 3, 4]);
    seeder.ban(VIEWER, 'manual', noise);
    expect(seeder.bans()).toEqual([
      { pubkey: VIEWER, noiseKey: noise, reason: 'manual', at: 1000 },
    ]);
    seeder.recordUpload(VIEWER, 2);
    expect(seeder.window(VIEWER)?.banned).toBe(true);
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 1 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, msg, policy)).toMatchObject({
      ok: false,
      reason: 'peer-banned',
    });
    seeder.unban(VIEWER);
    expect(seeder.bans()).toEqual([]);
    expect(seeder.window(VIEWER)?.banned).toBe(false);
    expect(await seeder.verify(VIEWER, msg, policy)).toMatchObject({ ok: true });
    expect(seeder.log.map((l) => l.kind)).toEqual(['ban', 'unban']);
    // A ban without a Noise key omits the field rather than writing `undefined`.
    seeder.ban(VIEWER, 'again');
    expect(Object.keys(seeder.bans()[0]!).sort()).toEqual(['at', 'pubkey', 'reason']);
  });

  it('window snapshots are immutable copies; window() is undefined for unknown peers; windows() lists every peer', () => {
    const { seeder } = pair();
    expect(seeder.window(VIEWER)).toBeUndefined();
    expect(seeder.windows()).toEqual([]);
    const snap = seeder.recordUpload(VIEWER, 1);
    seeder.recordUpload(VIEWER, 1);
    expect(snap.uploaded).toBe(1); // the earlier snapshot did not move
    expect(seeder.window(VIEWER)?.uploaded).toBe(2);
    seeder.recordUpload(SEEDER, 3);
    expect(seeder.windows().map((w) => [w.peer, w.uploaded])).toEqual([
      [VIEWER, 2],
      [SEEDER, 3],
    ]);
  });

  it('listeners can unsubscribe and are not called afterwards', async () => {
    const { viewer, seeder } = pair('double-spend');
    let windowCalls = 0;
    let doubleCalls = 0;
    const offW = seeder.onWindowExceeded(() => windowCalls++);
    const offD = seeder.onDoubleSpend(() => doubleCalls++);
    offW();
    offD();
    seeder.recordUpload(VIEWER, 4);
    const a = await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, a, policy)).toMatchObject({ ok: true });
    seeder.recordUpload(VIEWER, 4);
    const b = await viewer.pay({ fromBlock: 4, toBlock: 7 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, b, policy)).toMatchObject({ ok: true });
    seeder.recordUpload(VIEWER, 5); // crosses the window
    expect((await seeder.flush()).failed).toBe(1);
    expect(windowCalls).toBe(0);
    expect(doubleCalls).toBe(0);
    // The engine still did its job without listeners.
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(seeder.log.filter((l) => l.kind === 'window-exceeded')).toHaveLength(1);
    expect(seeder.log.filter((l) => l.kind === 'double-spend')).toHaveLength(1);
  });

  it('flush() with nothing pending is a no-op that still logs; pendingCount tracks accepted PAYs only', async () => {
    const { viewer, seeder } = pair('overpay');
    expect(await seeder.flush()).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
    expect(seeder.log.at(-1)).toMatchObject({ kind: 'flush' });
    seeder.recordUpload(VIEWER, 4);
    const rejected = await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, rejected, policy)).toMatchObject({
      ok: false,
      reason: 'overpay',
    });
    expect(seeder.pendingCount()).toBe(0);
    const honest = new MockPaymentEngine({ mode: 'honest' });
    const ok = await honest.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, ok, policy)).toMatchObject({ ok: true });
    expect(seeder.pendingCount()).toBe(1);
    await seeder.flush();
    expect(seeder.pendingCount()).toBe(0);
  });

  it('viewer spent() is accounted per seeder pubkey and includes what cheating modes actually put on the wire', async () => {
    const viewer = new MockPaymentEngine({ mode: 'overpay' });
    const other = { ...seederInfo, pubkey: VIEWER };
    await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy); // 8 owed, +1 overpaid
    await viewer.pay({ fromBlock: 0, toBlock: 0 }, other, policy); // 2 owed, +1 overpaid
    const s = viewer.spent();
    expect(s.perPeer.get(SEEDER)).toBe(9);
    expect(s.perPeer.get(VIEWER)).toBe(3);
    expect(s.total).toBe(12);
  });

  it('the mock event log never carries proof material (the mock is what lanes log against)', async () => {
    for (const mode of ['honest', 'forge', 'double-spend'] as const) {
      const { viewer, seeder } = pair(mode);
      seeder.recordUpload(VIEWER, 4);
      const a = await viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
      await seeder.verify(VIEWER, a, policy);
      seeder.recordUpload(VIEWER, 4);
      const b = await viewer.pay({ fromBlock: 4, toBlock: 7 }, seederInfo, policy);
      await seeder.verify(VIEWER, b, policy);
      seeder.recordUpload(VIEWER, 1);
      await seeder.flush();
      const text = JSON.stringify(seeder.log);
      for (const m of [a, b]) {
        for (const set of [m.seederProofs, m.creatorProofs]) {
          for (const p of set.proofs) expect(text, mode).not.toContain(p.secret);
        }
      }
    }
  });
});

describe('MockPaymentEngine contracts v3 (ADR 0004): per-core ranges and rebind', () => {
  const CORE_A = 'a1'.repeat(32) as CoreKeyHex;
  const CORE_B = 'b2'.repeat(32) as CoreKeyHex;
  const NOISE = '77'.repeat(32) as NostrPubkey; // provisional id: Noise key as hex

  it('range-not-uploaded is checked per core when the PAY names a core with recorded uploads', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(VIEWER, 3, CORE_A);
    seeder.recordUpload(VIEWER, 1, CORE_B);
    // 4 blocks uploaded in total, but only 1 on core B: paying for B[0..2] is a lie.
    const lie = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 2 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, lie, policy)).toMatchObject({
      ok: false,
      reason: 'range-not-uploaded',
    });
    const ok = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 2 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, ok, policy)).toMatchObject({ ok: true, blocks: 3 });
  });

  it('replay detection is per core: the same indexes on another core are a different range', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(VIEWER, 2, CORE_A);
    seeder.recordUpload(VIEWER, 2, CORE_B);
    const a = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 1 }, seederInfo, policy);
    const b = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 1 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, a, policy)).toMatchObject({ ok: true });
    expect(await seeder.verify(VIEWER, b, policy)).toMatchObject({ ok: true });
    expect(await seeder.verify(VIEWER, a, policy)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 4, paid: 4, outstanding: 0 });
  });

  it('isPayMessage accepts a well-formed core and rejects a malformed one', async () => {
    const { viewer } = pair();
    const msg = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 0 }, seederInfo, policy);
    expect(isPayMessage(msg)).toBe(true);
    expect(isPayMessage({ ...msg, range: { ...msg.range, core: 'nothex' } })).toBe(false);
    expect(isPayMessage({ ...msg, range: { ...msg.range, core: 'A1'.repeat(32) } })).toBe(false);
  });

  it('rebind moves provisional (pre-HELLO) accounting onto the pubkey and drops the provisional entry', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(NOISE, 3, CORE_A);
    expect(seeder.window(NOISE)).toMatchObject({ uploaded: 3, outstanding: 3 });

    const w = seeder.rebind(NOISE, VIEWER);
    expect(w).toMatchObject({ peer: VIEWER, uploaded: 3, paid: 0, outstanding: 3, banned: false });
    expect(seeder.window(NOISE)).toBeUndefined();
    expect(seeder.windows().map((x) => x.peer)).toEqual([VIEWER]);

    // Per-core counts travelled with it: paying for the 3 blocks on core A works.
    const ok = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 2 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, ok, policy)).toMatchObject({ ok: true, blocks: 3 });
    expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 3, paid: 3, outstanding: 0 });
    expect(seeder.log.some((e) => e.kind === 'rebind' && e.peer === VIEWER)).toBe(true);
  });

  it('rebind sums into an existing window and enforces invariant 5 synchronously on the merge', () => {
    const { seeder } = pair();
    const fired: string[] = [];
    seeder.onWindowExceeded((w) => fired.push(w.peer));
    seeder.recordUpload(VIEWER, 3); // an earlier session of the same pubkey
    seeder.recordUpload(NOISE, 3); // pre-HELLO on a new session
    const w = seeder.rebind(NOISE, VIEWER);
    expect(w).toMatchObject({ uploaded: 6, outstanding: 6, banned: true });
    expect(fired).toEqual([VIEWER]);
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(seeder.isBanned(NOISE)).toBe(false);
  });

  it('rebind carries a provisional ban onto the pubkey and is a no-op for an unknown source', () => {
    const { seeder } = pair();
    seeder.ban(NOISE, 'window-exceeded', new Uint8Array(32));
    const w = seeder.rebind(NOISE, VIEWER);
    expect(w.banned).toBe(true);
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(seeder.isBanned(NOISE)).toBe(false);
    expect(seeder.bans().find((b) => b.pubkey === VIEWER)?.noiseKey).toBeInstanceOf(Uint8Array);

    const before = seeder.window(VIEWER);
    expect(seeder.rebind('00'.repeat(32) as NostrPubkey, VIEWER)).toEqual(before);
    expect(seeder.rebind(VIEWER, VIEWER)).toEqual(before);
  });

  it('a v2-shaped PAY without core still verifies against the aggregate count', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(VIEWER, 2, CORE_A);
    const ok = await viewer.pay({ fromBlock: 0, toBlock: 1 }, seederInfo, policy);
    expect(await seeder.verify(VIEWER, ok, policy)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------
// L10 v3 extensions — reference-model hooks for ADR 0004 (c)/(d). Interface-level v3
// properties (T4/INV2 across cores, per-core replay, rebind merge/ban/sync-callback) live in
// core/src/payment/__tests__/ behind provider.mts; this block pins only what is specific to
// the mock: its `log`, its documented v3-interim fallbacks, and `pendingCount()`.
// ---------------------------------------------------------------------------------------

describe('MockPaymentEngine v3 reference-model hooks (L10 v3)', () => {
  const CORE_A = 'a1'.repeat(32) as CoreKeyHex;
  const CORE_B = 'b2'.repeat(32) as CoreKeyHex;
  const CORE_NONE = 'c3'.repeat(32) as CoreKeyHex;
  const NOISE = '77'.repeat(32) as NostrPubkey;

  it('rebind logs one `rebind` entry keyed on `to` (naming `from` in detail) and the log stays free of proof material across a rebind', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(NOISE, 4, CORE_A);
    const early = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 1 }, seederInfo, policy);
    expect(await seeder.verify(NOISE, early, policy)).toMatchObject({ ok: true });
    seeder.rebind(NOISE, VIEWER);
    const entries = seeder.log.filter((e) => e.kind === 'rebind');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ peer: VIEWER, detail: `from=${NOISE}` });
    // A no-op rebind (unknown `from`, or `from === to`) is not logged.
    seeder.rebind('00'.repeat(32) as NostrPubkey, VIEWER);
    seeder.rebind(VIEWER, VIEWER);
    expect(seeder.log.filter((e) => e.kind === 'rebind')).toHaveLength(1);
    const text = JSON.stringify(seeder.log);
    for (const p of [...early.seederProofs.proofs, ...early.creatorProofs.proofs]) {
      expect(text).not.toContain(p.secret);
    }
  });

  it('rebind moves pending (unswapped) proofs with the accounting: pendingCount() is unchanged and the batch is attributed to `to` at flush', async () => {
    const { viewer, seeder } = pair();
    seeder.recordUpload(NOISE, 2, CORE_A);
    const msg = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 1 }, seederInfo, policy);
    expect(await seeder.verify(NOISE, msg, policy)).toMatchObject({ ok: true });
    expect(seeder.pendingCount()).toBe(1);
    seeder.rebind(NOISE, VIEWER);
    expect(seeder.pendingCount()).toBe(1);
    expect(await seeder.flush()).toEqual({ swapped: 2, nutzapped: 2, failed: 0 });
    expect(seeder.pendingCount()).toBe(0);
    // Replaying the same proofs from `to` later is caught and banned under `to`.
    seeder.recordUpload(VIEWER, 2, CORE_B);
    const replay = { ...msg, range: { core: CORE_B, fromBlock: 0, toBlock: 1 } };
    expect(await seeder.verify(VIEWER, replay, policy)).toMatchObject({ ok: true });
    expect((await seeder.flush()).failed).toBe(1);
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(seeder.isBanned(NOISE)).toBe(false);
  });

  it('rebind with both sides banned keeps `to` banned and drops `from` from bans(); the surviving entry is `to`’s own', () => {
    const { seeder } = pair();
    seeder.ban(VIEWER, 'double-spend');
    seeder.ban(NOISE, 'window-exceeded', new Uint8Array(32).fill(1));
    seeder.recordUpload(NOISE, 1);
    const w = seeder.rebind(NOISE, VIEWER);
    expect(w).toMatchObject({ peer: VIEWER, uploaded: 1, banned: true });
    expect(seeder.bans().map((b) => b.pubkey)).toEqual([VIEWER]);
    expect(seeder.bans()[0]).toMatchObject({ reason: 'double-spend' });
    expect(seeder.isBanned(NOISE)).toBe(false);
  });

  it('DOCUMENTED v3-INTERIM FALLBACKS (ADR 0004 c) — what the mock cannot express, pinned so a change is noticed: a core-less PAY on a two-core peer is accepted, and a PAY naming a core with no recorded uploads falls back to the aggregate', async () => {
    // (1) "stream replicates > 1 core ⇒ core-less PAY is malformed" has no engine-level
    //     mechanism in the mock: `MockPaymentEngineOptions` carries no core set and `verify`
    //     falls back to the v2 aggregate count when `range.core` is undefined — even after
    //     uploads on two distinct cores. The Stage 2 expectation is the `it.skipIf(usingMock())`
    //     test 'T4 core-less PAY on a multi-core stream …' in payment/__tests__/threat-table.
    const wide = (): MockPaymentEngine =>
      new MockPaymentEngine({
        config: {
          ownP2pk: SEEDER_P2PK,
          ownPubkey: SEEDER,
          acceptedMints: [MINT],
          windowBlocks: 100,
        },
      });
    const a = { viewer: pair().viewer, seeder: wide() };
    a.seeder.recordUpload(VIEWER, 4, CORE_A);
    a.seeder.recordUpload(VIEWER, 4, CORE_B);
    const coreless = await a.viewer.pay({ fromBlock: 0, toBlock: 3 }, seederInfo, policy);
    expect(await a.seeder.verify(VIEWER, coreless, policy)).toMatchObject({ ok: true });

    // (2) The per-core `range-not-uploaded` check engages only for a core that HAS recorded
    //     uploads ("whenever the PAY names a core for which uploads were recorded"); a core
    //     with none falls back to the aggregate and is accepted. Stage 2 expectation:
    //     'INV1 per core (v3): a PAY naming a core with NO recorded uploads …' (skipIf mock).
    const b = pair();
    b.seeder.recordUpload(VIEWER, 4, CORE_A);
    const never = await b.viewer.pay(
      { core: CORE_NONE, fromBlock: 0, toBlock: 0 },
      seederInfo,
      policy,
    );
    expect(await b.seeder.verify(VIEWER, never, policy)).toMatchObject({ ok: true, blocks: 1 });
  });
});
