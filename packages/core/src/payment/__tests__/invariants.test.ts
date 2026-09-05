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
  CREATOR_P2PK,
  MINT_A,
  POLICY,
  SEEDER_INFO,
  SEEDER_P2PK,
  VIEWER,
  WIDE_WINDOW,
  blocksIn,
  expectedShares,
  getPair,
  getSeederEngine,
  mapProofs,
  observableState,
  policyWith,
  proofMaterial,
  sats,
  sumProofs,
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
});

// Type-level pins the invariants rely on.
const _reason: NostrPubkey extends string ? true : never = true;
const _policy: PricePolicy['split'] = { seeder: 50, creator: 50 };
const _mint: MintUrl = MINT_A;
