/**
 * Every cheating mode `MockPaymentEngine` exposes, each asserting the specific
 * `RejectReason` the interface promises. The mode list is `ALL_MODES` in provider.mts,
 * which is checked exhaustive against `MockPaymentMode` at compile time — adding a mode to
 * the mock without adding a row here fails `tsc`, not just this test.
 *
 * `honest` is the control: it must be accepted on every scenario the cheats are run on.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { RejectReason } from '../../contracts/index.js';
import {
  ALL_MODES,
  CHEATING_MODES,
  CORE_A,
  CORE_B,
  POLICY,
  SEEDER_INFO,
  VIEWER,
  WIDE_WINDOW,
  expectedShares,
  getPair,
  policyWith,
  sats,
  sumProofs,
  type CheatingMode,
} from './provider.mjs';

/**
 * Mode → the SECURITY.md row it exercises → the reason offline `verify` must return.
 * `double-spend` is the one cheat that offline verification cannot see (that is the point of
 * T5); it is caught by the swap batch instead, so its offline reason is `null`.
 */
const EXPECTED: Record<CheatingMode, { row: string; offline: RejectReason | null }> = {
  'stiff-creator': { row: 'T4', offline: 'wrong-p2pk-target' },
  'stiff-seeder': { row: 'T3', offline: 'missing-seeder-set' },
  'double-spend': { row: 'T5 / INV6', offline: null },
  forge: { row: 'T7', offline: 'bad-dleq' },
  overpay: { row: 'INV2', offline: 'overpay' },
  underpay: { row: 'INV2', offline: 'wrong-amount' },
};

describe('MockPaymentEngine cheating modes (each mode, each reason)', () => {
  it('enumerates every mode the mock exposes', () => {
    expect([...ALL_MODES].sort()).toEqual(
      [
        'honest',
        'stiff-creator',
        'stiff-seeder',
        'double-spend',
        'forge',
        'overpay',
        'underpay',
      ].sort(),
    );
    expect(CHEATING_MODES).toHaveLength(ALL_MODES.length - 1);
    expect(Object.keys(EXPECTED).sort()).toEqual([...CHEATING_MODES].sort());
  });

  it('honest (control): accepted and credited exactly', async () => {
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    const shares = expectedShares(4, POLICY);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toEqual({
      ok: true,
      credited: shares.total,
      blocks: 4,
    });
    expect(seeder.window(VIEWER)).toMatchObject({
      uploaded: 4,
      paid: 4,
      outstanding: 0,
      banned: false,
    });
    expect(await seeder.flush()).toEqual({
      swapped: shares.seeder,
      nutzapped: shares.creator,
      failed: 0,
    });
  });

  for (const mode of CHEATING_MODES) {
    const { row, offline } = EXPECTED[mode];
    if (offline !== null) {
      it(`${row}: mode=${mode} → offline verify rejects with '${offline}' and credits nothing`, async () => {
        const { viewer, seeder } = getPair(mode);
        seeder.recordUpload(VIEWER, 4);
        const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
        const res = await seeder.verify(VIEWER, msg, POLICY);
        expect(res).toMatchObject({ ok: false, reason: offline });
        expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 4, paid: 0, outstanding: 4 });
        // Nothing reached the swap batch.
        expect(await seeder.flush()).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
        // Whether a rejected cheat also bans the peer is left to the implementation (SECURITY.md
        // mandates a ban only for window-exceeded and double-spend); what is pinned is that
        // nothing is ever credited.
      });
    } else {
      it(`${row}: mode=${mode} → offline verify accepts, swap batch reports the spent proof, peer banned`, async () => {
        const { viewer, seeder } = getPair(mode, WIDE_WINDOW);
        seeder.recordUpload(VIEWER, 8);
        const first = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
        const second = await viewer.pay({ fromBlock: 4, toBlock: 7 }, SEEDER_INFO, POLICY);
        expect(await seeder.verify(VIEWER, first, POLICY)).toMatchObject({ ok: true });
        expect(await seeder.verify(VIEWER, second, POLICY)).toMatchObject({ ok: true });
        const r = await seeder.flush();
        expect(r.failed).toBe(1);
        expect(seeder.isBanned(VIEWER)).toBe(true);
        expect(seeder.bans().map((b) => b.pubkey)).toEqual([VIEWER]);
      });
    }
  }

  it('every cheating mode is rejected (offline or at flush) across arbitrary prices, splits and ranges; honest is always accepted', async () => {
    const scenario = fc
      .record({
        blocks: fc.integer({ min: 1, max: 10 }),
        satsPerBlock: fc.integer({ min: 1, max: 16 }),
        seederPct: fc.integer({ min: 1, max: 99 }),
        from: fc.nat(30),
      })
      .map((s) => ({
        ...s,
        policy: policyWith({
          satsPerBlock: sats(s.satsPerBlock),
          split: { seeder: s.seederPct, creator: 100 - s.seederPct },
        }),
      }))
      .filter(({ blocks, policy }) => {
        const sh = expectedShares(blocks, policy);
        // Both honest shares must be ≥ 2 sat so `underpay` (−1 on the creator side) and
        // `stiff-*` remain distinguishable from an empty set. See docs/lanes/L10.md §edge.
        return sh.seeder >= 2 && sh.creator >= 2;
      });

    await fc.assert(
      fc.asyncProperty(
        scenario,
        fc.constantFrom(...ALL_MODES),
        async ({ blocks, from, policy }, mode) => {
          const { viewer, seeder } = getPair(mode, WIDE_WINDOW);
          seeder.recordUpload(VIEWER, from + 2 * blocks);
          const r1 = { fromBlock: from, toBlock: from + blocks - 1 };
          const r2 = { fromBlock: from + blocks, toBlock: from + 2 * blocks - 1 };
          const m1 = await viewer.pay(r1, SEEDER_INFO, policy);
          const m2 = await viewer.pay(r2, SEEDER_INFO, policy);
          const v1 = await seeder.verify(VIEWER, m1, policy);
          const v2 = await seeder.verify(VIEWER, m2, policy);
          const flush = await seeder.flush();
          const shares = expectedShares(blocks, policy);

          if (mode === 'honest') {
            expect(v1).toEqual({ ok: true, credited: shares.total, blocks });
            expect(v2).toEqual({ ok: true, credited: shares.total, blocks });
            expect(flush).toEqual({
              swapped: 2 * shares.seeder,
              nutzapped: 2 * shares.creator,
              failed: 0,
            });
            expect(seeder.isBanned(VIEWER)).toBe(false);
            return;
          }
          const expected = EXPECTED[mode];
          if (expected.offline === null) {
            // double-spend: first PAY honest, second replays → caught at flush.
            expect(v1).toMatchObject({ ok: true });
            expect(v2).toMatchObject({ ok: true });
            expect(flush.failed).toBe(1);
            expect(flush.swapped + flush.nutzapped).toBe(shares.total);
            expect(seeder.isBanned(VIEWER)).toBe(true);
          } else {
            expect(v1).toMatchObject({ ok: false, reason: expected.offline });
            expect(v2).toMatchObject({ ok: false, reason: expected.offline });
            expect(flush).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
            expect(seeder.window(VIEWER)?.paid).toBe(0);
          }
          // Whatever the cheat, the seeder never credits more than the honest amount.
          expect(flush.swapped).toBeLessThanOrEqual(2 * shares.seeder);
          expect(flush.nutzapped).toBeLessThanOrEqual(2 * shares.creator);
        },
      ),
      { numRuns: 120 },
    );
  });

  it('the cheating PAYs really are cheats on the wire (the mock produces the attack it claims)', async () => {
    // Guards against a mode silently becoming honest, which would make the rejections above
    // vacuous. Each mode's message must differ from the honest one in the documented way.
    const honestMsg = await getPair('honest').viewer.pay(
      { fromBlock: 0, toBlock: 3 },
      SEEDER_INFO,
      POLICY,
    );
    const shares = expectedShares(4, POLICY);
    for (const mode of CHEATING_MODES) {
      const { viewer } = getPair(mode);
      const a = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
      switch (mode) {
        case 'stiff-creator':
          expect(a.creatorProofs.lockedTo).toBe(SEEDER_INFO.p2pk);
          expect(a.creatorProofs.lockedTo).not.toBe(honestMsg.creatorProofs.lockedTo);
          break;
        case 'stiff-seeder':
          expect(a.seederProofs.proofs).toHaveLength(0);
          expect(sumProofs(a.creatorProofs.proofs)).toBe(shares.creator);
          break;
        case 'forge':
          expect(a.seederProofs.proofs.every((p) => p.dleq?.s === 'FORGED')).toBe(true);
          break;
        case 'overpay':
          expect(sumProofs(a.seederProofs.proofs)).toBe(shares.seeder + 1);
          break;
        case 'underpay':
          expect(sumProofs(a.creatorProofs.proofs)).toBe(shares.creator - 1);
          break;
        case 'double-spend': {
          const b = await viewer.pay({ fromBlock: 4, toBlock: 7 }, SEEDER_INFO, POLICY);
          expect(b.seederProofs.proofs.map((p) => p.secret)).toEqual(
            a.seederProofs.proofs.map((p) => p.secret),
          );
          expect(b.range).not.toEqual(a.range);
          break;
        }
      }
    }
  });

  it('v3 (ADR 0004 c): naming a core is not a bypass — every cheating mode is rejected with the same reason when the PAY carries `range.core`; honest with a core is accepted; `pay()` passes `core` through unchanged in every mode', async () => {
    for (const mode of ALL_MODES) {
      const { viewer, seeder } = getPair(mode, WIDE_WINDOW);
      seeder.recordUpload(VIEWER, 4, CORE_A);
      seeder.recordUpload(VIEWER, 4, CORE_B);
      const rangeA = { core: CORE_A, fromBlock: 0, toBlock: 3 };
      const rangeB = { core: CORE_B, fromBlock: 0, toBlock: 3 };
      const a = await viewer.pay(rangeA, SEEDER_INFO, POLICY);
      const b = await viewer.pay(rangeB, SEEDER_INFO, POLICY);
      // The wire carries exactly the core the viewer was handed — for cheats too.
      expect(a.range, mode).toEqual(rangeA);
      expect(b.range, mode).toEqual(rangeB);

      const va = await seeder.verify(VIEWER, a, POLICY);
      const vb = await seeder.verify(VIEWER, b, POLICY);
      const flush = await seeder.flush();
      const shares = expectedShares(4, POLICY);

      if (mode === 'honest') {
        expect(va, mode).toEqual({ ok: true, credited: shares.total, blocks: 4 });
        expect(vb, mode).toEqual({ ok: true, credited: shares.total, blocks: 4 });
        expect(flush, mode).toEqual({
          swapped: 2 * shares.seeder,
          nutzapped: 2 * shares.creator,
          failed: 0,
        });
        expect(seeder.window(VIEWER), mode).toMatchObject({ uploaded: 8, paid: 8 });
        continue;
      }
      const { offline } = EXPECTED[mode];
      if (offline === null) {
        // double-spend: the second PAY (core B) replays the first's proofs — a different
        // core is not a different proof.
        expect(va, mode).toMatchObject({ ok: true });
        expect(vb, mode).toMatchObject({ ok: true });
        expect(flush.failed, mode).toBe(1);
        expect(flush.swapped + flush.nutzapped, mode).toBe(shares.total);
        expect(seeder.isBanned(VIEWER), mode).toBe(true);
      } else {
        expect(va, mode).toMatchObject({ ok: false, reason: offline });
        expect(vb, mode).toMatchObject({ ok: false, reason: offline });
        expect(flush, mode).toEqual({ swapped: 0, nutzapped: 0, failed: 0 });
        expect(seeder.window(VIEWER)?.paid, mode).toBe(0);
      }
    }
  });
});
