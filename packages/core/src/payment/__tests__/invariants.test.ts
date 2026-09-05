/**
 * SECURITY.md "Non-negotiable invariants of the money path", one named test per invariant
 * (INV1–INV8), written as properties where the invariant is quantified ("every PAY",
 * "per peer", "never"). All run against the reference model today and against the real
 * engine in Stage 2 through `provider.mts`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type {
  CashuProof,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PeerWindow,
  PricePolicy,
  Sats,
  VerifyResult,
} from '../../contracts/index.js';
import { MockPaymentEngine } from '../../mocks/mock-payment-engine.js';
import {
  ALL_MODES,
  CORE_A,
  CORE_B,
  CORE_NONE,
  CREATOR_P2PK,
  MINT_A,
  NOISE_ID,
  POLICY,
  SEEDER_INFO,
  SEEDER_P2PK,
  UNKNOWN_ID,
  VIEWER,
  WIDE_WINDOW,
  blocksIn,
  expectedShares,
  getPair,
  getSeederEngine,
  mapProofs,
  observableState,
  policyByCore,
  policyWith,
  proofMaterial,
  sats,
  sumProofs,
  usingMock,
  withCreatorSet,
  withSeederSet,
} from './provider.mjs';

const REPO_ROOT = new URL('../../../../../', import.meta.url);

/** A policy where both shares are ≥ 1 sat for `blocks` blocks (see docs/lanes/L10.md §edge). */
const pricedScenarioArb = fc
  .record({
    blocks: fc.integer({ min: 1, max: 12 }),
    satsPerBlock: fc.integer({ min: 1, max: 32 }),
    seederPct: fc.integer({ min: 1, max: 99 }),
  })
  .map(({ blocks, satsPerBlock, seederPct }) => ({
    blocks,
    policy: policyWith({
      satsPerBlock: sats(satsPerBlock),
      split: { seeder: seederPct, creator: 100 - seederPct },
    }),
  }))
  .filter(({ blocks, policy }) => {
    const s = expectedShares(blocks, policy);
    return s.seeder >= 1 && s.creator >= 1;
  });

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

async function listSource(dirUrl: URL): Promise<URL[]> {
  const out: URL[] = [];
  let entries;
  try {
    entries = await readdir(dirUrl, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
    const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dirUrl);
    if (e.isDirectory()) out.push(...(await listSource(child)));
    else if (/\.(m?ts|tsx|m?js)$/.test(e.name) && !e.name.endsWith('.test.ts')) out.push(child);
  }
  return out;
}

describe('SECURITY.md money-path invariants', () => {
  it('INV1 pay after verify → a PAY covers exactly the range handed to `pay()`, and the seeder refuses any block it never uploaded to that peer', async () => {
    // Viewer side: `pay()` is only ever called for blocks that fired `download` (caller
    // discipline owned by L2/L7); the engine must not widen or shift the range.
    // Seeder side: `verify` is the mirror — a block not in this peer's `uploaded` count is
    // not payable, whatever the proofs look like.
    await fc.assert(
      fc.asyncProperty(
        fc.nat(20), // blocks uploaded to VIEWER
        fc.nat(20), // fromBlock
        fc.nat(6), // range length − 1
        async (uploaded, from, len) => {
          const { viewer, seeder } = getPair('honest', WIDE_WINDOW);
          if (uploaded > 0) seeder.recordUpload(VIEWER, uploaded);
          const range = { fromBlock: from, toBlock: from + len };
          const msg = await viewer.pay(range, SEEDER_INFO, POLICY);
          expect(msg.range).toEqual(range);
          const res = await seeder.verify(VIEWER, msg, POLICY);
          if (range.toBlock < uploaded) {
            expect(res).toMatchObject({ ok: true, blocks: len + 1 });
            expect(seeder.window(VIEWER)).toMatchObject({ uploaded, paid: len + 1 });
          } else {
            expect(res).toMatchObject({ ok: false, reason: 'range-not-uploaded' });
            expect(seeder.window(VIEWER)?.paid ?? 0).toBe(0);
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it('INV1 per core (v3, ADR 0004 c): `range-not-uploaded` and `range-already-paid` are per core — [0,3] on core A then [0,3] on core B is not a replay, [0,3] on core A twice is, and a core’s own upload count governs even when the aggregate would cover the range', async () => {
    const { viewer, seeder } = getPair('honest', WIDE_WINDOW);
    seeder.recordUpload(VIEWER, 4, CORE_A);
    seeder.recordUpload(VIEWER, 4, CORE_B);

    // Same indexes, two cores: two distinct ranges, both payable.
    const a = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    const b = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, a, POLICY)).toMatchObject({ ok: true, blocks: 4 });
    expect(await seeder.verify(VIEWER, b, POLICY)).toMatchObject({ ok: true, blocks: 4 });
    expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 8, paid: 8, outstanding: 0 });

    // The same range on the same core again — the message itself, and a fresh message for
    // the same or an overlapping range — is a replay.
    expect(await seeder.verify(VIEWER, a, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    const aAgain = await viewer.pay(
      { core: CORE_A, fromBlock: 0, toBlock: 3 },
      SEEDER_INFO,
      POLICY,
    );
    expect(await seeder.verify(VIEWER, aAgain, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    const aOverlap = await viewer.pay(
      { core: CORE_A, fromBlock: 3, toBlock: 3 },
      SEEDER_INFO,
      POLICY,
    );
    expect(await seeder.verify(VIEWER, aOverlap, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    expect(seeder.window(VIEWER)).toMatchObject({ paid: 8 });

    // Per-core `range-not-uploaded`: 3 blocks on A + 1 on B = 4 in total, but B[0..2] was
    // never sent — the aggregate count would say yes, the per-core count says no.
    const fresh = getSeederEngine(WIDE_WINDOW);
    fresh.recordUpload(VIEWER, 3, CORE_A);
    fresh.recordUpload(VIEWER, 1, CORE_B);
    const lieB = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 2 }, SEEDER_INFO, POLICY);
    expect(await fresh.verify(VIEWER, lieB, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-not-uploaded',
    });
    const okB = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 0 }, SEEDER_INFO, POLICY);
    expect(await fresh.verify(VIEWER, okB, POLICY)).toMatchObject({ ok: true, blocks: 1 });
    const okA = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 2 }, SEEDER_INFO, POLICY);
    expect(await fresh.verify(VIEWER, okA, POLICY)).toMatchObject({ ok: true, blocks: 3 });
    expect(fresh.window(VIEWER)).toMatchObject({ uploaded: 4, paid: 4, outstanding: 0 });

    // Property: for any two per-core upload counts, a PAY on core X is payable iff it fits
    // X's own count, never the other core's or the sum.
    await fc.assert(
      fc.asyncProperty(
        fc.nat(8),
        fc.nat(8),
        fc.nat(10),
        fc.constantFrom(CORE_A, CORE_B),
        async (nA, nB, toBlock, core) => {
          const s = getSeederEngine(WIDE_WINDOW);
          if (nA > 0) s.recordUpload(VIEWER, nA, CORE_A);
          if (nB > 0) s.recordUpload(VIEWER, nB, CORE_B);
          const own = core === CORE_A ? nA : nB;
          const msg = await viewer.pay({ core, fromBlock: 0, toBlock }, SEEDER_INFO, POLICY);
          const res = await s.verify(VIEWER, msg, POLICY);
          // The reference model only knows a core once uploads were recorded for it; with
          // zero uploads on `core` it falls back to the aggregate (see the Stage 2 test
          // below), so the property is stated for cores that have a count.
          if (own === 0) return;
          if (toBlock < own) expect(res).toMatchObject({ ok: true, blocks: toBlock + 1 });
          else expect(res).toMatchObject({ ok: false, reason: 'range-not-uploaded' });
        },
      ),
      { numRuns: 80 },
    );
  });

  it.skipIf(usingMock())(
    'INV1 per core (v3): a PAY naming a core with NO recorded uploads is `range-not-uploaded` even when other cores have uploads (Stage 2 packages/core/src/payment/ unskips this)',
    async () => {
      // Interim behaviour the reference model pins (ADR 0004 (c)): the per-core check applies
      // "whenever the PAY names a core for which uploads were recorded"; for a core with no
      // record it falls back to the aggregate and ACCEPTS. Once `core` is required at the
      // Stage 2 bump every upload is per core, so "no record" means "never sent".
      const { viewer, seeder } = getPair('honest', WIDE_WINDOW);
      seeder.recordUpload(VIEWER, 4, CORE_A);
      const never = await viewer.pay(
        { core: CORE_NONE, fromBlock: 0, toBlock: 0 },
        SEEDER_INFO,
        POLICY,
      );
      expect(await seeder.verify(VIEWER, never, POLICY)).toMatchObject({
        ok: false,
        reason: 'range-not-uploaded',
      });
      expect(seeder.window(VIEWER)?.paid).toBe(0);
    },
  );

  it('INV1 rebind (v3, ADR 0004 d): per-core upload counts and paid ranges survive the move — a PAY from `to` for a core uploaded under `from` verifies, replaying it is range-already-paid, and a range already paid under `from` cannot be paid again by `to`', async () => {
    const { viewer, seeder } = getPair('honest', WIDE_WINDOW);
    // Pre-HELLO: 4 blocks of A and 2 of B served under the provisional id; A[0,1] paid there.
    seeder.recordUpload(NOISE_ID, 4, CORE_A);
    seeder.recordUpload(NOISE_ID, 2, CORE_B);
    const paidEarly = await viewer.pay(
      { core: CORE_A, fromBlock: 0, toBlock: 1 },
      SEEDER_INFO,
      POLICY,
    );
    expect(await seeder.verify(NOISE_ID, paidEarly, POLICY)).toMatchObject({ ok: true });
    expect(seeder.window(NOISE_ID)).toMatchObject({ uploaded: 6, paid: 2, outstanding: 4 });

    const w = seeder.rebind(NOISE_ID, VIEWER);
    expect(w).toMatchObject({ peer: VIEWER, uploaded: 6, paid: 2, outstanding: 4, banned: false });
    expect(seeder.window(NOISE_ID)).toBeUndefined();

    // (v) per-core counts travelled: the rest of A and all of B are payable by `to`…
    const restA = await viewer.pay({ core: CORE_A, fromBlock: 2, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, restA, POLICY)).toMatchObject({ ok: true, blocks: 2 });
    const allB = await viewer.pay({ core: CORE_B, fromBlock: 0, toBlock: 1 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, allB, POLICY)).toMatchObject({ ok: true, blocks: 2 });
    // …but not more than was sent on each core.
    const tooMuchB = await viewer.pay(
      { core: CORE_B, fromBlock: 2, toBlock: 2 },
      SEEDER_INFO,
      POLICY,
    );
    expect(await seeder.verify(VIEWER, tooMuchB, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-not-uploaded',
    });
    // Paid ranges travelled too: replaying what `to` paid, and what `from` paid, are replays.
    expect(await seeder.verify(VIEWER, restA, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    expect(await seeder.verify(VIEWER, paidEarly, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    const earlyAgain = await viewer.pay(
      { core: CORE_A, fromBlock: 0, toBlock: 1 },
      SEEDER_INFO,
      POLICY,
    );
    expect(await seeder.verify(VIEWER, earlyAgain, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-already-paid',
    });
    expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 6, paid: 6, outstanding: 0 });
    // The provisional id is gone for good: a PAY addressed to it finds nothing uploaded.
    expect(await seeder.verify(NOISE_ID, earlyAgain, POLICY)).toMatchObject({
      ok: false,
      reason: 'range-not-uploaded',
    });
  });

  it('INV2 exact amounts → blocks × price split per the video’s `split` tag; underpayment and overpayment are both rejected', async () => {
    await fc.assert(
      fc.asyncProperty(
        pricedScenarioArb,
        fc.constantFrom<'seederProofs' | 'creatorProofs'>('seederProofs', 'creatorProofs'),
        fc.constantFrom<'+1' | '-1' | 'drop-one'>('+1', '-1', 'drop-one'),
        async ({ blocks, policy }, which, delta) => {
          const { viewer, seeder } = getPair('honest', WIDE_WINDOW);
          seeder.recordUpload(VIEWER, blocks);
          const range = { fromBlock: 0, toBlock: blocks - 1 };
          const honest = await viewer.pay(range, SEEDER_INFO, policy);
          const shares = expectedShares(blocks, policy);

          // The honest PAY carries exactly the split…
          expect(sumProofs(honest.seederProofs.proofs)).toBe(shares.seeder);
          expect(sumProofs(honest.creatorProofs.proofs)).toBe(shares.creator);
          expect(shares.seeder + shares.creator).toBe(blocks * policy.satsPerBlock);

          // …and is credited for exactly `blocks × price`.
          const ok = await seeder.verify(VIEWER, honest, policy);
          expect(ok).toEqual({ ok: true, credited: shares.total, blocks });

          // Any deviation in either set is rejected, whichever direction.
          const fresh = getSeederEngine(WIDE_WINDOW);
          fresh.recordUpload(VIEWER, blocks);
          const set = honest[which];
          const extra: CashuProof = { ...set.proofs[0]!, amount: 1, secret: `mock:extra:${which}` };
          let mutated: PayMessage;
          if (delta === '+1') {
            mutated = { ...honest, [which]: { ...set, proofs: [...set.proofs, extra] } };
          } else if (delta === 'drop-one') {
            if (set.proofs.length < 2) return; // dropping the only proof is INV3's case
            mutated = { ...honest, [which]: { ...set, proofs: set.proofs.slice(1) } };
          } else {
            const smallest = set.proofs.reduce((a, p) => (p.amount < a.amount ? p : a));
            if (smallest.amount === 1 && set.proofs.length === 1) return; // would be an empty set
            const proofs = set.proofs
              .filter((p) => p !== smallest)
              .concat(smallest.amount > 1 ? [{ ...smallest, amount: smallest.amount - 1 }] : []);
            mutated = { ...honest, [which]: { ...set, proofs } };
          }
          const res = await fresh.verify(VIEWER, mutated, policy);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(['overpay', 'wrong-amount']).toContain(res.reason);
            if (delta === '+1') expect(res.reason).toBe('overpay');
            else expect(res.reason).toBe('wrong-amount');
          }
          expect(fresh.window(VIEWER)?.paid).toBe(0);
        },
      ),
      { numRuns: 100 },
    );

    // Total-preserving but split-violating: right sum, wrong distribution → still rejected.
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const honest = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    const oneSat: CashuProof = {
      ...honest.creatorProofs.proofs[0]!,
      amount: 1,
      secret: 'mock:moved:1',
    };
    const shifted = withSeederSet(
      withCreatorSet(honest, {
        proofs: [{ ...honest.creatorProofs.proofs[0]!, amount: 3, secret: 'mock:moved:3' }],
      }),
      { proofs: [...honest.seederProofs.proofs, oneSat] },
    );
    expect(sumProofs(shifted.seederProofs.proofs) + sumProofs(shifted.creatorProofs.proofs)).toBe(
      8,
    );
    expect(await seeder.verify(VIEWER, shifted, POLICY)).toMatchObject({ ok: false });
  });

  it('INV2 across cores (v3, ADR 0004 c): cores priced differently on one channel — the cheap core’s price for the expensive core’s blocks → wrong-amount; the expensive price for the cheap core’s blocks → overpay; the exact amount at the named core’s price is accepted', async () => {
    // Same creator, same split, same mint: the ONLY difference is `satsPerBlock`.
    const cheap = POLICY; // 2 sat/block
    const expensive = policyWith({ satsPerBlock: sats(8) });
    const resolve = policyByCore(
      new Map([
        [CORE_A, cheap],
        [CORE_B, expensive],
      ]),
    );
    const { viewer, seeder } = getPair('honest', WIDE_WINDOW);
    seeder.recordUpload(VIEWER, 4, CORE_A);
    seeder.recordUpload(VIEWER, 4, CORE_B);

    // The attack: B's blocks (8 sat each) paid at A's price (2 sat each) → 8 sat for 32 owed.
    const rangeB = { core: CORE_B, fromBlock: 0, toBlock: 3 };
    const underB = await viewer.pay(rangeB, SEEDER_INFO, cheap);
    expect(sumProofs(underB.seederProofs.proofs) + sumProofs(underB.creatorProofs.proofs)).toBe(
      expectedShares(4, cheap).total,
    );
    expect(await seeder.verify(VIEWER, underB, resolve(underB.range))).toMatchObject({
      ok: false,
      reason: 'wrong-amount',
    });
    expect(seeder.window(VIEWER)?.paid).toBe(0);

    // The mirror (an honest-but-confused viewer): A's blocks at B's price → strictly more
    // than owed, which INV2 rejects as `overpay` rather than pocketing the difference.
    const rangeA = { core: CORE_A, fromBlock: 0, toBlock: 3 };
    const overA = await viewer.pay(rangeA, SEEDER_INFO, expensive);
    expect(await seeder.verify(VIEWER, overA, resolve(overA.range))).toMatchObject({
      ok: false,
      reason: 'overpay',
    });
    expect(seeder.window(VIEWER)?.paid).toBe(0);

    // Exact at each core's own price: accepted and credited at that price.
    const okB = await viewer.pay(rangeB, SEEDER_INFO, expensive);
    expect(await seeder.verify(VIEWER, okB, resolve(okB.range))).toEqual({
      ok: true,
      credited: expectedShares(4, expensive).total,
      blocks: 4,
    });
    const okA = await viewer.pay(rangeA, SEEDER_INFO, cheap);
    expect(await seeder.verify(VIEWER, okA, resolve(okA.range))).toEqual({
      ok: true,
      credited: expectedShares(4, cheap).total,
      blocks: 4,
    });
    expect(seeder.window(VIEWER)).toMatchObject({ uploaded: 8, paid: 8, outstanding: 0 });

    // Control — the v2 degradation: a seeder verifying every core at the cheapest price
    // accepts the underpayment ("cheapest price wins", ADR 0004 (c)).
    const v2 = getSeederEngine(WIDE_WINDOW);
    v2.recordUpload(VIEWER, 4, CORE_A);
    v2.recordUpload(VIEWER, 4, CORE_B);
    expect(await v2.verify(VIEWER, underB, cheap)).toMatchObject({ ok: true });

    // Property: for any two distinct prices, paying core X's blocks at core Y's price is
    // rejected on amount — `wrong-amount` when Y is cheaper, `overpay` when Y is dearer —
    // and the exact amount at X's price is accepted.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 32 }),
        fc.integer({ min: 1, max: 32 }),
        fc.integer({ min: 1, max: 6 }),
        async (priceA, priceB, blocks) => {
          fc.pre(priceA !== priceB);
          const pA = policyWith({ satsPerBlock: sats(priceA) });
          const pB = policyWith({ satsPerBlock: sats(priceB) });
          // Both honest shares must be ≥ 1 sat or the PAY is an INV3 case, not an amount one
          // (docs/lanes/L10.md §observations 3).
          fc.pre(expectedShares(blocks, pA).seeder >= 1 && expectedShares(blocks, pB).seeder >= 1);
          const s = getSeederEngine(WIDE_WINDOW);
          s.recordUpload(VIEWER, blocks, CORE_A);
          s.recordUpload(VIEWER, blocks, CORE_B);
          const range = { core: CORE_B, fromBlock: 0, toBlock: blocks - 1 };
          const wrong = await viewer.pay(range, SEEDER_INFO, pA);
          const res = await s.verify(VIEWER, wrong, pB);
          expect(res).toMatchObject({
            ok: false,
            reason: priceA < priceB ? 'wrong-amount' : 'overpay',
          });
          expect(s.window(VIEWER)?.paid).toBe(0);
          const right = await viewer.pay(range, SEEDER_INFO, pB);
          expect(await s.verify(VIEWER, right, pB)).toEqual({
            ok: true,
            credited: expectedShares(blocks, pB).total,
            blocks,
          });
        },
      ),
      { numRuns: 80 },
    );
  });

  it('INV3 two locked sets → every PAY carries a seeder set and a creator set, each P2PK-locked to its recipient, each proof with DLEQ', async () => {
    await fc.assert(
      fc.asyncProperty(pricedScenarioArb, async ({ blocks, policy }) => {
        const { viewer } = getPair('honest');
        const msg = await viewer.pay({ fromBlock: 0, toBlock: blocks - 1 }, SEEDER_INFO, policy);
        for (const [set, target] of [
          [msg.seederProofs, SEEDER_INFO.p2pk],
          [msg.creatorProofs, policy.creatorP2pk],
        ] as const) {
          expect(set.proofs.length).toBeGreaterThan(0);
          expect(set.lockedTo).toBe(target);
          expect(set.unit).toBe('sat');
          expect(set.mint).toBe(SEEDER_INFO.mint);
          for (const p of set.proofs) {
            expect(p.dleq).toBeDefined();
            expect(typeof p.dleq!.s).toBe('string');
            expect(typeof p.dleq!.e).toBe('string');
            expect(Number.isInteger(p.amount) && p.amount > 0).toBe(true);
          }
        }
      }),
      { numRuns: 40 },
    );

    // The seeder enforces the same shape: missing set / missing DLEQ / wrong lock → refused.
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const honest = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    const cases: { msg: PayMessage; reason: string }[] = [
      { msg: withSeederSet(honest, { proofs: [] }), reason: 'missing-seeder-set' },
      { msg: withCreatorSet(honest, { proofs: [] }), reason: 'missing-creator-set' },
      { msg: withSeederSet(honest, { lockedTo: CREATOR_P2PK }), reason: 'wrong-p2pk-target' },
      { msg: withCreatorSet(honest, { lockedTo: SEEDER_P2PK }), reason: 'wrong-p2pk-target' },
      {
        msg: {
          ...honest,
          seederProofs: mapProofs(honest.seederProofs, ({ dleq: _d, ...p }) => p),
        },
        reason: 'missing-dleq',
      },
      {
        msg: {
          ...honest,
          creatorProofs: mapProofs(honest.creatorProofs, ({ dleq: _d, ...p }) => p),
        },
        reason: 'missing-dleq',
      },
    ];
    for (const c of cases) {
      expect(await seeder.verify(VIEWER, c.msg, POLICY)).toMatchObject({
        ok: false,
        reason: c.reason,
      });
    }
    expect(seeder.window(VIEWER)?.paid).toBe(0);
    expect(await seeder.verify(VIEWER, honest, POLICY)).toMatchObject({ ok: true });
  });

  it('INV4 offline verification before ACK → `verify` decides without the mint, never throws, and credits only on acceptance', async () => {
    // (a) Acceptance is decided by `verify` alone: the window is credited before any
    //     `flush()` (the swap batch) has run, and `flush()` then only swaps what was accepted.
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    const res = await seeder.verify(VIEWER, msg, POLICY);
    expect(res).toMatchObject({ ok: true });
    expect(seeder.window(VIEWER)).toMatchObject({ paid: 4, outstanding: 0 });
    const shares = expectedShares(4, POLICY);
    expect(await seeder.flush()).toEqual({
      swapped: shares.seeder,
      nutzapped: shares.creator,
      failed: 0,
    });

    // (b) `verify` never throws — for arbitrary junk, and for arbitrary corruptions of a
    //     valid message — and a rejection never credits the window.
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (junk) => {
        const s = getSeederEngine();
        s.recordUpload(VIEWER, 4);
        let out: VerifyResult | undefined;
        let threw = false;
        try {
          out = await s.verify(VIEWER, junk as PayMessage, POLICY);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(out).toMatchObject({ ok: false, reason: 'malformed' });
        expect(s.window(VIEWER)?.paid).toBe(0);
      }),
      { numRuns: 150 },
    );

    const corruption = fc.oneof(
      fc.constant((m: PayMessage): unknown => ({ ...m, range: null })),
      fc.constant((m: PayMessage): unknown => ({ ...m, seederProofs: 'x' })),
      fc.constant((m: PayMessage): unknown => ({ ...m, creatorProofs: [] })),
      fc.constant((m: PayMessage): unknown => withSeederSet(m, { unit: 'usd' as 'sat' })),
      fc.constant((m: PayMessage): unknown => withSeederSet(m, { mint: 42 as unknown as MintUrl })),
      fc.constant((m: PayMessage): unknown => ({
        ...m,
        seederProofs: mapProofs(m.seederProofs, (p) => ({ ...p, amount: 0 })),
      })),
      fc.constant((m: PayMessage): unknown => ({
        ...m,
        creatorProofs: mapProofs(m.creatorProofs, (p) => ({ ...p, amount: -p.amount })),
      })),
      fc.constant((m: PayMessage): unknown => ({
        ...m,
        seederProofs: mapProofs(m.seederProofs, (p) => ({ ...p, amount: 1.5 })),
      })),
      fc.constant((m: PayMessage): unknown => ({
        ...m,
        creatorProofs: mapProofs(m.creatorProofs, (p) => ({
          ...p,
          secret: 7 as unknown as string,
        })),
      })),
      fc.constant((m: PayMessage): unknown => ({
        ...m,
        seederProofs: { ...m.seederProofs, proofs: [null] },
      })),
      fc.constant((m: PayMessage): unknown => ({ range: m.range })),
      fc.constant((): unknown => Object.create(null)),
    );
    await fc.assert(
      fc.asyncProperty(corruption, async (corrupt) => {
        const s = getSeederEngine();
        s.recordUpload(VIEWER, 4);
        const good = await getPair('honest').viewer.pay(
          { fromBlock: 0, toBlock: 3 },
          SEEDER_INFO,
          POLICY,
        );
        let out: VerifyResult | undefined;
        let threw = false;
        try {
          out = await s.verify(VIEWER, corrupt(good) as PayMessage, POLICY);
        } catch {
          threw = true;
        }
        expect(threw).toBe(false);
        expect(out?.ok).toBe(false);
        expect(s.window(VIEWER)?.paid).toBe(0);
      }),
      { numRuns: 60 },
    );
  });

  it('INV5 window then cut → `uploaded − paid` never exceeds the window without the peer being cut and banned, for any interleaving of uploads and PAYs', async () => {
    type Op = { kind: 'upload'; blocks: number } | { kind: 'pay'; blocks: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant<'upload'>('upload'), blocks: fc.integer({ min: 1, max: 3 }) }),
      fc.record({ kind: fc.constant<'pay'>('pay'), blocks: fc.integer({ min: 1, max: 4 }) }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 1, max: 6 }),
        async (ops, windowBlocks) => {
          const seeder = getSeederEngine({ config: { windowBlocks } });
          const { viewer } = getPair('honest');
          const exceeded: PeerWindow[] = [];
          seeder.onWindowExceeded((w) => exceeded.push(w));
          let uploaded = 0;
          let nextUnpaid = 0; // first block not yet paid for
          let banned = false;
          for (const op of ops) {
            if (op.kind === 'upload') {
              const w = seeder.recordUpload(VIEWER, op.blocks);
              uploaded += op.blocks;
              expect(w.uploaded).toBe(uploaded);
              expect(w.outstanding).toBe(w.uploaded - w.paid);
              if (w.outstanding > windowBlocks) {
                // The crossing is caught on this very call, synchronously.
                expect(w.banned).toBe(true);
                expect(seeder.isBanned(VIEWER)).toBe(true);
                banned = true;
              }
            } else {
              // Pay for the next `blocks` blocks, but only ones actually uploaded.
              const to = Math.min(nextUnpaid + op.blocks, uploaded) - 1;
              if (to < nextUnpaid) continue; // nothing payable yet
              const range = { fromBlock: nextUnpaid, toBlock: to };
              const msg = await viewer.pay(range, SEEDER_INFO, POLICY);
              const res = await seeder.verify(VIEWER, msg, POLICY);
              if (banned) {
                expect(res).toMatchObject({ ok: false, reason: 'peer-banned' });
              } else {
                expect(res).toMatchObject({ ok: true, blocks: blocksIn(range) });
                nextUnpaid = to + 1;
              }
            }
            const w = seeder.window(VIEWER);
            if (w) {
              expect(w.windowBlocks).toBe(windowBlocks);
              expect(w.outstanding).toBe(w.uploaded - w.paid);
              // The invariant itself:
              if (w.outstanding > windowBlocks) expect(w.banned).toBe(true);
              if (!w.banned) expect(w.outstanding).toBeLessThanOrEqual(windowBlocks);
            }
          }
          // Exactly one cut per peer, fired at the crossing, carrying the post-update window.
          expect(exceeded.length).toBe(banned ? 1 : 0);
          if (banned) {
            expect(exceeded[0]!.outstanding).toBeGreaterThan(windowBlocks);
            expect(exceeded[0]!.banned).toBe(true);
            expect(seeder.bans().some((b) => b.pubkey === VIEWER)).toBe(true);
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  it('INV5 rebind (v3, ADR 0004 d): sum-merge — after `rebind(from, to)` the window for `to` shows n + m uploaded and `from` is gone from windows(); when n + m > window the ban and `onWindowExceeded` fire synchronously inside `rebind` and the returned window reflects it; an unknown `from` is a no-op', async () => {
    // (i) Sum-merge below the window: nothing fires, `to` has both sessions' blocks.
    const a = getPair('honest'); // default window (4)
    const firedA: PeerWindow[] = [];
    a.seeder.onWindowExceeded((w) => firedA.push(w));
    a.seeder.recordUpload(VIEWER, 2); // m = 2 from an earlier session of the same pubkey
    a.seeder.recordUpload(NOISE_ID, 1); // n = 1 pre-HELLO on the new session
    const merged = a.seeder.rebind(NOISE_ID, VIEWER);
    expect(merged).toMatchObject({
      peer: VIEWER,
      uploaded: 3,
      paid: 0,
      outstanding: 3,
      banned: false,
    });
    expect(a.seeder.window(VIEWER)).toEqual(merged);
    expect(a.seeder.window(NOISE_ID)).toBeUndefined();
    expect(a.seeder.windows().map((w) => w.peer)).toEqual([VIEWER]);
    expect(firedA).toEqual([]);
    expect(a.seeder.isBanned(VIEWER)).toBe(false);
    // The merged window is live: one more block is tolerated, the next crosses.
    expect(a.seeder.recordUpload(VIEWER, 1).banned).toBe(false);
    expect(a.seeder.recordUpload(VIEWER, 1).banned).toBe(true);
    expect(firedA).toHaveLength(1);

    // (iii) Sum-merge across the window: the crossing is detected inside `rebind`, the
    //       callback fires synchronously (before `rebind` returns) with the peer already
    //       banned, and the returned `PeerWindow` is the post-ban snapshot.
    const b = getPair('honest');
    const firedB: { peer: NostrPubkey; outstanding: number; bannedAtCallback: boolean }[] = [];
    let rebindReturned = false;
    b.seeder.onWindowExceeded((w) =>
      firedB.push({
        peer: w.peer,
        outstanding: w.outstanding,
        bannedAtCallback: b.seeder.isBanned(w.peer) && !rebindReturned,
      }),
    );
    b.seeder.recordUpload(VIEWER, 3); // m = 3 ≤ window
    b.seeder.recordUpload(NOISE_ID, 2); // n = 2 ≤ window
    expect(firedB).toEqual([]);
    const crossed = b.seeder.rebind(NOISE_ID, VIEWER);
    rebindReturned = true;
    expect(firedB).toEqual([{ peer: VIEWER, outstanding: 5, bannedAtCallback: true }]);
    expect(crossed).toMatchObject({ peer: VIEWER, uploaded: 5, outstanding: 5, banned: true });
    expect(b.seeder.isBanned(VIEWER)).toBe(true);
    expect(b.seeder.isBanned(NOISE_ID)).toBe(false);
    expect(b.seeder.window(NOISE_ID)).toBeUndefined();
    expect(b.seeder.bans().some((e) => e.pubkey === VIEWER)).toBe(true);
    const late = await b.viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await b.seeder.verify(VIEWER, late, POLICY)).toMatchObject({
      ok: false,
      reason: 'peer-banned',
    });

    // (iv) Unknown `from`: no throw, `to` unchanged, nothing fires, nothing new appears.
    const c = getPair('honest');
    const firedC: PeerWindow[] = [];
    c.seeder.onWindowExceeded((w) => firedC.push(w));
    c.seeder.recordUpload(VIEWER, 2);
    const before = c.seeder.window(VIEWER);
    const beforeAll = c.seeder.windows();
    expect(c.seeder.rebind(UNKNOWN_ID, VIEWER)).toEqual(before);
    expect(c.seeder.rebind(VIEWER, VIEWER)).toEqual(before);
    expect(c.seeder.window(VIEWER)).toEqual(before);
    expect(c.seeder.windows()).toEqual(beforeAll);
    expect(c.seeder.window(UNKNOWN_ID)).toBeUndefined();
    expect(firedC).toEqual([]);
    expect(c.seeder.isBanned(VIEWER)).toBe(false);

    // Property: for any n, m and window, after `rebind` `to` has exactly n + m uploaded,
    // `from` is gone, `to` is banned iff outstanding > window, and the crossing — whether
    // it happened at an upload or at the merge — fired exactly once.
    fc.assert(
      fc.property(
        fc.nat(6),
        fc.nat(6),
        fc.integer({ min: 1, max: 6 }),
        fc.boolean(),
        (n, m, windowBlocks, toExists) => {
          const s = getSeederEngine({ config: { windowBlocks } });
          const fired: PeerWindow[] = [];
          s.onWindowExceeded((w) => fired.push(w));
          if (toExists || m > 0) s.recordUpload(VIEWER, m);
          if (n > 0) s.recordUpload(NOISE_ID, n);
          const firedBefore = fired.length;
          const w = s.rebind(NOISE_ID, VIEWER);
          expect(w.peer).toBe(VIEWER);
          expect(w.uploaded).toBe(n + m);
          expect(w.paid).toBe(0);
          expect(w.outstanding).toBe(n + m);
          expect(w.windowBlocks).toBe(windowBlocks);
          const shouldBan = n + m > windowBlocks;
          expect(w.banned).toBe(shouldBan);
          expect(s.isBanned(VIEWER)).toBe(shouldBan);
          expect(s.isBanned(NOISE_ID)).toBe(false);
          expect(s.window(NOISE_ID)).toBeUndefined();
          expect(s.window(VIEWER)).toEqual(w);
          expect(s.windows().map((x) => x.peer)).toEqual([VIEWER]);
          // Each side that crossed on its own already fired at its `recordUpload`; the merge
          // fires exactly once more iff neither had and the sum crosses. Never twice for one
          // identity, never zero for a banned one.
          const preCrossings = (m > windowBlocks ? 1 : 0) + (n > windowBlocks ? 1 : 0);
          expect(firedBefore).toBe(preCrossings);
          const crossedAtMerge = preCrossings === 0 && shouldBan;
          expect(fired.length - firedBefore).toBe(crossedAtMerge ? 1 : 0);
          if (crossedAtMerge) {
            expect(fired.at(-1)).toMatchObject({ peer: VIEWER, outstanding: n + m, banned: true });
          }
          for (const f of fired) expect(f.banned).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('INV6 ban on double-spend → an already-spent proof reported by the swap bans the paying pubkey and the ban is listed durably', async () => {
    // Persistence to disk (across process restarts) is owned by L2; the engine must expose
    // the ban list the seeder persists, with pubkey, reason and timestamp.
    const { viewer, seeder, clock } = getPair('double-spend');
    seeder.recordUpload(VIEWER, 2);
    const a = await viewer.pay({ fromBlock: 0, toBlock: 1 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, a, POLICY)).toMatchObject({ ok: true });
    seeder.recordUpload(VIEWER, 2);
    const b = await viewer.pay({ fromBlock: 2, toBlock: 3 }, SEEDER_INFO, POLICY); // replays a's proofs
    expect(await seeder.verify(VIEWER, b, POLICY)).toMatchObject({ ok: true });
    expect(seeder.isBanned(VIEWER)).toBe(false);
    expect(seeder.bans()).toHaveLength(0);

    const before = clock.current();
    expect((await seeder.flush()).failed).toBe(1);

    expect(seeder.isBanned(VIEWER)).toBe(true);
    const entry = seeder.bans().find((e) => e.pubkey === VIEWER);
    expect(entry).toBeDefined();
    expect(entry!.at).toBeGreaterThanOrEqual(before);
    expect(entry!.reason.length).toBeGreaterThan(0);
    expect(seeder.window(VIEWER)?.banned).toBe(true);

    // The ban outlives the batch and gates every later interaction from that pubkey.
    await seeder.flush();
    expect(seeder.bans().find((e) => e.pubkey === VIEWER)).toEqual(entry);
    seeder.recordUpload(VIEWER, 1);
    const c = await getPair('honest').viewer.pay({ fromBlock: 4, toBlock: 4 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, c, POLICY)).toMatchObject({
      ok: false,
      reason: 'peer-banned',
    });
    // Only the explicit administrative path lifts it.
    seeder.unban(VIEWER);
    expect(seeder.isBanned(VIEWER)).toBe(false);
    expect(seeder.bans()).toHaveLength(0);
  });

  it('INV6 rebind (v3, ADR 0004 d): pending proofs move with the accounting — a double-spend accepted under the provisional id and caught at flush after `rebind` bans the bound pubkey, not the dead provisional id', async () => {
    const { viewer, seeder } = getPair('double-spend', WIDE_WINDOW);
    const doubles: NostrPubkey[] = [];
    seeder.onDoubleSpend((p) => doubles.push(p));

    // Earlier session, already bound: an honest PAY, swapped.
    seeder.recordUpload(VIEWER, 4, CORE_A);
    const first = await viewer.pay({ core: CORE_A, fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, first, POLICY)).toMatchObject({ ok: true });
    expect(await seeder.flush()).toMatchObject({ failed: 0 });

    // New session, pre-HELLO: the same proofs again, for blocks served under the Noise id.
    // Offline verification cannot see the double-spend, so it is queued under `from`.
    seeder.recordUpload(NOISE_ID, 4, CORE_B);
    const replay = await viewer.pay(
      { core: CORE_B, fromBlock: 0, toBlock: 3 },
      SEEDER_INFO,
      POLICY,
    );
    expect(replay.seederProofs.proofs.map((p) => p.secret)).toEqual(
      first.seederProofs.proofs.map((p) => p.secret),
    );
    expect(await seeder.verify(NOISE_ID, replay, POLICY)).toMatchObject({ ok: true });

    // HELLO verifies → rebind. The swap batch then reports the spent proof: the ban must
    // land on the identity that now owns the accounting.
    const w = seeder.rebind(NOISE_ID, VIEWER);
    expect(w).toMatchObject({ peer: VIEWER, uploaded: 8, paid: 8, outstanding: 0, banned: false });
    const r = await seeder.flush();
    expect(r.failed).toBe(1);
    expect(doubles).toEqual([VIEWER]);
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(seeder.isBanned(NOISE_ID)).toBe(false);
    expect(seeder.bans().map((e) => e.pubkey)).toEqual([VIEWER]);
    expect(seeder.window(VIEWER)?.banned).toBe(true);
    // Nothing new was swapped or nutzapped for the replay.
    expect(r.swapped + r.nutzapped).toBe(0);
  });

  it('INV7 no key or proof in a log, ever → for every mode, every observable output of the seeder (results incl. `detail`, callbacks, state) is free of proof material', async () => {
    // The redaction layer itself is L2 (seeder) / Stage 2 (signer, wallet). The property
    // the engine must hold so redaction has nothing to catch: `RejectReason.detail`, window
    // snapshots, ban entries, callback payloads and the mock's own event log never contain
    // a secret, a `C`, a DLEQ scalar or a witness.
    for (const mode of ALL_MODES) {
      const { viewer, seeder } = getPair(mode);
      const windowEvents: PeerWindow[] = [];
      const doubleSpendEvents: unknown[] = [];
      seeder.onWindowExceeded((w) => windowEvents.push(w));
      seeder.onDoubleSpend((p, d) => doubleSpendEvents.push([p, d]));
      const results: VerifyResult[] = [];
      const messages: PayMessage[] = [];
      seeder.recordUpload(VIEWER, 4);
      for (const range of [
        { fromBlock: 0, toBlock: 3 },
        { fromBlock: 4, toBlock: 7 },
      ]) {
        const msg = await viewer.pay(range, SEEDER_INFO, POLICY);
        messages.push(msg);
        results.push(await seeder.verify(VIEWER, msg, POLICY));
        seeder.recordUpload(VIEWER, 4);
      }
      seeder.recordUpload(VIEWER, 2); // cross the window at least once
      const flushResult = await seeder.flush();
      const observed =
        observableState(seeder, VIEWER, { windowEvents, doubleSpendEvents, flushResult }) +
        JSON.stringify(results) +
        (seeder instanceof MockPaymentEngine ? JSON.stringify(seeder.log) : '');
      const material = messages.flatMap(proofMaterial);
      expect(material.length).toBeGreaterThan(0);
      for (const s of material) expect(observed, `mode=${mode}`).not.toContain(s);
      for (const r of results) {
        if (!r.ok && r.detail !== undefined) {
          for (const s of material) expect(r.detail).not.toContain(s);
        }
      }
    }
    // The viewer-side accounting is amounts only.
    const { viewer } = getPair('honest');
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    const spent = JSON.stringify({ ...viewer.spent(), perPeer: [...viewer.spent().perPeer] });
    for (const s of proofMaterial(msg)) expect(spent).not.toContain(s);
    expect(viewer.spent().perPeer.get(SEEDER_INFO.pubkey)).toBe(
      expectedShares(4, POLICY).total as Sats,
    );
  });

  it('INV8 no browser persistence of proofs or keys → the runtime-agnostic core and the web shell source never touch Web Storage / IndexedDB', async () => {
    // The bundle-level grep and the in-memory NIP-60 state are owned by L7 (web shell). At
    // the source level today: nothing under core/src (which the web shell embeds) or
    // app-web/src references a browser persistence API outside comments; and the Wallet
    // contract states the rule.
    const forbidden =
      /\b(localStorage|sessionStorage|indexedDB|IDBDatabase|openDatabase|document\.cookie)\b/;
    const roots = ['packages/core/src/', 'packages/app-web/src/'];
    let scanned = 0;
    for (const root of roots) {
      for (const f of await listSource(new URL(root, REPO_ROOT))) {
        scanned++;
        const src = stripComments(await readFile(f, 'utf8'));
        expect(src, f.pathname).not.toMatch(forbidden);
      }
    }
    expect(scanned).toBeGreaterThan(5);
    const wallet = await readFile(
      new URL('packages/core/src/contracts/wallet.ts', REPO_ROOT),
      'utf8',
    );
    expect(wallet).toMatch(/nothing in IndexedDB\/localStorage/);
    const security = await readFile(new URL('SECURITY.md', REPO_ROOT), 'utf8');
    expect(security).toMatch(/holds NIP-60 state in memory\s+only/);
  });
});

describe('SECURITY.md invariant coverage', () => {
  it('every numbered invariant in SECURITY.md is named INVn by a test in this file', async () => {
    const security = await readFile(new URL('SECURITY.md', REPO_ROOT), 'utf8');
    const section = security
      .split('## Non-negotiable invariants')[1]
      ?.split('## Locked directories')[0];
    expect(section).toBeDefined();
    const ids = [...section!.matchAll(/^(\d+)\. \*\*/gm)].map((m) => `INV${m[1]!}`);
    expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `INV${String(i + 1)}`));
    const self = await readFile(new URL(import.meta.url), 'utf8');
    for (const id of ids) expect(self).toMatch(new RegExp(`it\\('${id} `));
  });

  it('the contracts v3 rows (ADR 0004 c/d) are named by tests in this file, under their invariant', async () => {
    const self = await readFile(new URL(import.meta.url), 'utf8');
    for (const title of [
      'INV1 per core (v3, ADR 0004 c)',
      'INV1 rebind (v3, ADR 0004 d)',
      'INV2 across cores (v3, ADR 0004 c)',
      'INV5 rebind (v3, ADR 0004 d)',
      'INV6 rebind (v3, ADR 0004 d)',
    ]) {
      expect(self, title).toContain(`it('${title}`);
    }
  });
});

// Type-level pins the invariants rely on.
const _reason: NostrPubkey extends string ? true : never = true;
const _policy: PricePolicy['split'] = { seeder: 50, creator: 50 };
const _mint: MintUrl = MINT_A;
