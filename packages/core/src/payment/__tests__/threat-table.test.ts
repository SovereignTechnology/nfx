/**
 * SECURITY.md threat table, one named test per row (T1–T16), targeting the interfaces.
 *
 * Rows that are payment-engine properties (T3–T8, T9/T10 at the engine boundary) are fully
 * proven here against the reference model and, in Stage 2, against the real engine through
 * `provider.mts`. Rows whose control lives elsewhere (T1/T2/T11 → L2, T12 → L9, T13 → L7,
 * T14 → Stage 2 signer + L2 redaction, T15/T16 → L4) get the strongest pin that is
 * checkable at the interface/contract/repo-policy level today; the comment on each test
 * names the owner of the runtime proof. See docs/lanes/L10.md for the full/pinned split.
 */
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type {
  CashuProof,
  LockedProofSet,
  NostrPubkey,
  PayMessage,
  PeerWindow,
  VerifyResult,
} from '../../contracts/index.js';
import { PAY_PROTOCOL_NAME } from '../../contracts/index.js';
import { VIDEOS, fixtureComments } from '../../mocks/fixtures.js';
import { FORGED } from '../../mocks/mock-payment-engine.js';
import {
  ATTACKER_P2PK,
  CREATOR_P2PK,
  MINT_A,
  MINT_B,
  MINT_UNKNOWN,
  OTHER_SEEDER_P2PK,
  OTHER_VIEWER,
  POLICY,
  SEEDER_INFO,
  SEEDER_P2PK,
  VIEWER,
  expectedShares,
  getPair,
  getSeederEngine,
  mapProofs,
  observableState,
  policyWith,
  proofMaterial,
  usingMock,
  withCreatorSet,
  withSeederSet,
} from './provider.mjs';

const REPO_ROOT = new URL('../../../../../', import.meta.url);

async function readRepoFile(rel: string): Promise<string> {
  return readFile(new URL(rel, REPO_ROOT), 'utf8');
}

/** Strip comments so doc-comments that *mention* a forbidden token do not trip a grep. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

async function listTs(dirUrl: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const e of await readdir(dirUrl, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dirUrl);
    if (e.isDirectory()) out.push(...(await listTs(child)));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mts')) out.push(child);
  }
  return out;
}

const rangeArb = fc
  .tuple(fc.nat(64), fc.nat(15))
  .map(([from, len]) => ({ fromBlock: from, toBlock: from + len }));

describe('SECURITY.md threat table', () => {
  it('T1 malicious seeder serves wrong bytes → the money path only ever pays for the exact range the viewer verified; malformed ranges are refused', async () => {
    // Runtime proof (Hypercore Merkle proof before `download` fires) is owned by L2 / the
    // viewer transport. At the interface: `pay()` cannot widen the range it was handed, so a
    // block that never fired `download` can never be included in a PAY; and the seeder side
    // refuses ranges that are not well-formed.
    await fc.assert(
      fc.asyncProperty(rangeArb, async (range) => {
        const { viewer } = getPair('honest');
        const msg = await viewer.pay(range, SEEDER_INFO, POLICY);
        expect(msg.range).toEqual(range);
        const { total } = expectedShares(range.toBlock - range.fromBlock + 1, POLICY);
        expect(viewer.spent().total).toBe(total);
      }),
      { numRuns: 50 },
    );

    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const good = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    for (const bad of [
      { fromBlock: 3, toBlock: 0 }, // inverted
      { fromBlock: -1, toBlock: 0 }, // negative
      { fromBlock: 0.5, toBlock: 3 }, // non-integer
      { fromBlock: 0, toBlock: Number.NaN },
    ]) {
      const res = await seeder.verify(VIEWER, { ...good, range: bad }, POLICY);
      expect(res).toMatchObject({ ok: false, reason: 'malformed' });
    }
    expect(seeder.window(VIEWER)?.paid).toBe(0);
  });

  it('T2 malicious seeder stalls → per-peer `lastActivity` advances on upload and on accepted PAY so a timeout can be computed', async () => {
    // Runtime proof (per-peer timeout + drop; Hypercore multi-sourcing) is owned by L2.
    // At the interface the engine must expose the signal a timeout needs.
    const { viewer, seeder, clock } = getPair('honest');
    const t0 = clock.current();
    const w1 = seeder.recordUpload(VIEWER, 4);
    expect(w1.lastActivity).toBeGreaterThanOrEqual(t0);
    const afterUpload = w1.lastActivity;
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({ ok: true });
    const w2 = seeder.window(VIEWER);
    expect(w2).toBeDefined();
    expect(w2!.lastActivity).toBeGreaterThan(afterUpload);
    // A stalled peer's window does not move by itself.
    expect(seeder.window(VIEWER)!.lastActivity).toBe(w2!.lastActivity);
  });

  it('T3 malicious viewer downloads and never pays → window (4 blocks) then synchronous cut + ban; loss bounded to the window', async () => {
    const { viewer, seeder } = getPair('honest');
    const events: { outstanding: number; bannedAtCallback: boolean }[] = [];
    seeder.onWindowExceeded((w: PeerWindow) =>
      events.push({ outstanding: w.outstanding, bannedAtCallback: seeder.isBanned(VIEWER) }),
    );

    // Exactly `windowBlocks` unpaid blocks are tolerated…
    for (let i = 0; i < seeder.config.windowBlocks; i++) {
      const w = seeder.recordUpload(VIEWER, 1);
      expect(w.banned).toBe(false);
      expect(events).toHaveLength(0);
    }
    // …the block that crosses the window triggers the cut synchronously, before
    // `recordUpload` returns (spike S-A: `upload` fires before the block hits the wire).
    const crossed = seeder.recordUpload(VIEWER, 1);
    expect(events).toEqual([
      { outstanding: seeder.config.windowBlocks + 1, bannedAtCallback: true },
    ]);
    expect(crossed.banned).toBe(true);
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(seeder.bans().map((b) => b.pubkey)).toContain(VIEWER);

    // Residual loss: at most the window's worth of blocks (SECURITY.md: "~4 blocks of sats").
    expect(crossed.outstanding).toBeLessThanOrEqual(seeder.config.windowBlocks + 1);

    // A late PAY from the banned peer is refused, not credited.
    const late = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, late, POLICY)).toMatchObject({
      ok: false,
      reason: 'peer-banned',
    });
    expect(seeder.window(VIEWER)?.paid).toBe(0);

    // The seeder-side of the same row via the mock: a PAY with no seeder set is refused.
    const stiff = getPair('stiff-seeder');
    stiff.seeder.recordUpload(VIEWER, 4);
    const m = await stiff.viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await stiff.seeder.verify(VIEWER, m, POLICY)).toMatchObject({
      ok: false,
      reason: 'missing-seeder-set',
    });
  });

  it('T4 malicious viewer pays the seeder and stiffs the creator → both proof sets required, creator set must be locked to the creator', async () => {
    // Mode: creator share re-locked to the seeder's own key.
    const stiff = getPair('stiff-creator');
    stiff.seeder.recordUpload(VIEWER, 4);
    const msg = await stiff.viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(msg.creatorProofs.lockedTo).toBe(SEEDER_P2PK); // the attack, as sent
    expect(await stiff.seeder.verify(VIEWER, msg, POLICY)).toMatchObject({
      ok: false,
      reason: 'wrong-p2pk-target',
    });
    expect(stiff.seeder.window(VIEWER)?.paid).toBe(0);

    // Hand-built variants of the same attack against an honest PAY.
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const honest = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);

    const noCreator = withCreatorSet(honest, { proofs: [] });
    expect(await seeder.verify(VIEWER, noCreator, POLICY)).toMatchObject({
      ok: false,
      reason: 'missing-creator-set',
    });

    const creatorToAttacker = withCreatorSet(honest, { lockedTo: ATTACKER_P2PK });
    expect(await seeder.verify(VIEWER, creatorToAttacker, POLICY)).toMatchObject({
      ok: false,
      reason: 'wrong-p2pk-target',
    });

    // Seeder share moved into the creator set (right total, wrong split) is not accepted.
    const creatorOverSeederUnder = withSeederSet(
      withCreatorSet(honest, {
        proofs: [...honest.creatorProofs.proofs, ...honest.seederProofs.proofs],
      }),
      { proofs: [] },
    );
    expect(await seeder.verify(VIEWER, creatorOverSeederUnder, POLICY)).toMatchObject({
      ok: false,
    });
    expect(seeder.window(VIEWER)?.paid).toBe(0);
  });

  it('T5 malicious viewer double-spends → passes offline check, caught by the async swap, peer banned, loss ≤ window', async () => {
    const { viewer, seeder } = getPair('double-spend');
    const doubles: { peer: NostrPubkey; mint: string; amount: number }[] = [];
    seeder.onDoubleSpend((peer, d) => doubles.push({ peer, mint: d.mint, amount: d.amount }));

    seeder.recordUpload(VIEWER, 4);
    const first = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, first, POLICY)).toMatchObject({ ok: true });

    seeder.recordUpload(VIEWER, 4);
    const second = await viewer.pay({ fromBlock: 4, toBlock: 7 }, SEEDER_INFO, POLICY);
    // Same proofs, new range: offline verification cannot know they were spent.
    expect(second.seederProofs.proofs.map((p) => p.secret)).toEqual(
      first.seederProofs.proofs.map((p) => p.secret),
    );
    expect(await seeder.verify(VIEWER, second, POLICY)).toMatchObject({ ok: true });

    const r = await seeder.flush();
    expect(r.failed).toBe(1);
    expect(seeder.isBanned(VIEWER)).toBe(true);
    expect(doubles).toHaveLength(1);
    expect(doubles[0]).toMatchObject({ peer: VIEWER, mint: MINT_A });

    // Bounded: only the genuinely-new value was ever swapped/nutzapped — one window's worth.
    const { total } = expectedShares(4, POLICY);
    expect(r.swapped + r.nutzapped).toBe(total);
    expect(total).toBe(seeder.config.windowBlocks * POLICY.satsPerBlock);

    // Ban is durable across further batches and blocks further PAYs.
    expect(await seeder.flush()).toMatchObject({ failed: 0 });
    expect(seeder.isBanned(VIEWER)).toBe(true);
    seeder.recordUpload(VIEWER, 1);
    const third = await viewer.pay({ fromBlock: 8, toBlock: 8 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(VIEWER, third, POLICY)).toMatchObject({
      ok: false,
      reason: 'peer-banned',
    });
  });

  it('T6 MITM steals proofs in flight → every set is P2PK-locked to its recipient, so a stolen PAY is worthless to anyone else', async () => {
    // Noise secret-stream is owned by the transport (hyperswarm / L2 / Stage 2 pay-protocol).
    // At the interface: (a) the viewer locks each set to the intended recipient, (b) a
    // different seeder re-presenting the captured PAY as its own is refused.
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(msg.seederProofs.lockedTo).toBe(SEEDER_INFO.p2pk);
    expect(msg.creatorProofs.lockedTo).toBe(POLICY.creatorP2pk);

    const mitm = getSeederEngine({ config: { ownP2pk: OTHER_SEEDER_P2PK } });
    mitm.recordUpload(VIEWER, 4);
    expect(await mitm.verify(VIEWER, msg, POLICY)).toMatchObject({
      ok: false,
      reason: 'wrong-p2pk-target',
    });
    // The honest seeder is still paid by the same message.
    expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({ ok: true });
  });

  it.skipIf(usingMock())(
    'T6 a captured PAY re-labelled to the thief’s key is still refused: the NUT-11 lock is in the proof secret, not the envelope (Stage 2 packages/core/src/payment/ unskips this)',
    async () => {
      // The reference model checks only the `lockedTo` envelope field, so under the mock a
      // re-labelled set is accepted (documented in docs/lanes/L10.md as a mock/spec gap).
      // The real engine must parse the NUT-11 secret (`["P2PK", { data: <pubkey> … }]`) and
      // compare THAT to its own key; the envelope is untrusted input.
      const { viewer } = getPair('honest');
      const thief = getSeederEngine({ config: { ownP2pk: OTHER_SEEDER_P2PK } });
      thief.recordUpload(VIEWER, 4);
      const captured = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
      for (const relabelled of [
        withSeederSet(captured, { lockedTo: OTHER_SEEDER_P2PK }),
        withCreatorSet(withSeederSet(captured, { lockedTo: OTHER_SEEDER_P2PK }), {
          lockedTo: POLICY.creatorP2pk,
        }),
      ]) {
        const res = await thief.verify(VIEWER, relabelled, POLICY);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(['wrong-p2pk-target', 'bad-dleq']).toContain(res.reason);
      }
      expect(thief.window(VIEWER)?.paid).toBe(0);
    },
  );

  it('T7 forged proofs → NUT-12 DLEQ against the cached keyset; forged, missing or tampered DLEQ is refused', async () => {
    const forge = getPair('forge');
    forge.seeder.recordUpload(VIEWER, 4);
    const forged = await forge.viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(await forge.seeder.verify(VIEWER, forged, POLICY)).toMatchObject({
      ok: false,
      reason: 'bad-dleq',
    });
    expect(forge.seeder.window(VIEWER)?.paid).toBe(0);

    // Property: forging or stripping the DLEQ of ANY single proof, in either set, is refused.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('seederProofs', 'creatorProofs'),
        fc.nat(7),
        fc.constantFrom<'forge' | 'strip' | 'tamper-secret'>('forge', 'strip', 'tamper-secret'),
        async (which, idx, how) => {
          const { viewer, seeder } = getPair('honest');
          seeder.recordUpload(VIEWER, 4);
          const honest = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
          const set = honest[which];
          const i = idx % set.proofs.length;
          const mutated = mapProofs(set, (p: CashuProof, j: number): CashuProof => {
            if (j !== i) return p;
            if (how === 'forge') return { ...p, dleq: { s: FORGED, e: FORGED } };
            if (how === 'tamper-secret') return { ...p, secret: `x${p.secret}` };
            const { dleq: _dleq, ...rest } = p;
            return rest;
          });
          const msg: PayMessage =
            which === 'seederProofs'
              ? { ...honest, seederProofs: mutated }
              : { ...honest, creatorProofs: mutated };
          const res = await seeder.verify(VIEWER, msg, POLICY);
          expect(res.ok).toBe(false);
          if (!res.ok) expect(['bad-dleq', 'missing-dleq']).toContain(res.reason);
          if (!res.ok && how === 'strip') expect(res.reason).toBe('missing-dleq');
          expect(seeder.window(VIEWER)?.paid).toBe(0);
        },
      ),
      { numRuns: 60 },
    );
  });

  it.skipIf(usingMock())(
    'T7 a proof whose unblinded signature `C` is altered fails DLEQ even with a well-formed `dleq` (Stage 2 packages/core/src/payment/ unskips this)',
    async () => {
      // The reference model never looks at `C` (its DLEQ stand-in is `dleq.s !== FORGED`), so
      // this is skipped under the mock and documented in docs/lanes/L10.md. NUT-12: the DLEQ
      // proves C = k·B' for the keyset's k; any change to C, secret or amount breaks it.
      const { viewer, seeder } = getPair('honest');
      seeder.recordUpload(VIEWER, 4);
      const honest = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
      const tamperedC: PayMessage = {
        ...honest,
        seederProofs: mapProofs(honest.seederProofs, (p, i) =>
          i === 0
            ? { ...p, C: p.C.startsWith('02') ? `03${p.C.slice(2)}` : `02${p.C.slice(2)}` }
            : p,
        ),
      };
      expect(await seeder.verify(VIEWER, tamperedC, POLICY)).toMatchObject({
        ok: false,
        reason: 'bad-dleq',
      });
      expect(seeder.window(VIEWER)?.paid).toBe(0);
      expect(await seeder.verify(VIEWER, honest, POLICY)).toMatchObject({ ok: true });
    },
  );

  it('T8 mint rug / compromise → the seeder only accepts creator-chosen mints that are also on its own allowlist', async () => {
    // Small balances, one-click melt-out and "mint shown in UI" are owned by the Wallet
    // screens (L5) and wallet/spend.ts (Stage 2). At the engine boundary the exposure is
    // bounded by the allowlist intersection: video policy ∩ seeder config.
    const cases: { seederMints: readonly string[]; policyMints: readonly string[]; pay: string }[] =
      [
        { seederMints: [MINT_A], policyMints: [MINT_A], pay: MINT_UNKNOWN },
        { seederMints: [MINT_A], policyMints: [MINT_A, MINT_B], pay: MINT_B }, // creator ok, seeder not
        { seederMints: [MINT_A, MINT_B], policyMints: [MINT_A], pay: MINT_B }, // seeder ok, creator not
      ];
    for (const c of cases) {
      const seeder = getSeederEngine({
        config: { acceptedMints: c.seederMints as PayMessage['seederProofs']['mint'][] },
      });
      const { viewer } = getPair('honest');
      const policy = policyWith({ mints: c.policyMints as PayMessage['seederProofs']['mint'][] });
      seeder.recordUpload(VIEWER, 4);
      const msg = await viewer.pay(
        { fromBlock: 0, toBlock: 3 },
        { ...SEEDER_INFO, mint: c.pay as PayMessage['seederProofs']['mint'] },
        policy,
      );
      expect(await seeder.verify(VIEWER, msg, policy)).toMatchObject({
        ok: false,
        reason: 'mint-not-accepted',
      });
      expect(seeder.window(VIEWER)?.paid).toBe(0);
    }
    // A mixed PAY (seeder set at an accepted mint, creator set at a rogue one) is refused too.
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const honest = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(
      await seeder.verify(VIEWER, withCreatorSet(honest, { mint: MINT_UNKNOWN }), POLICY),
    ).toMatchObject({ ok: false, reason: 'mint-not-accepted' });
    // And the intersection is honoured: accepted on both sides → ok.
    expect(await seeder.verify(VIEWER, honest, POLICY)).toMatchObject({ ok: true });
  });

  it('T9 impostor creator → the creator P2PK comes from the seeder’s verified manifest, never from the wire', async () => {
    // Signature verification of the NIP-71 event and the verified-pubkey UI are owned by
    // L1 / L5. At the engine boundary: a viewer fed an impostor policy (wrong creatorP2pk)
    // produces a PAY the honest seeder refuses, because the seeder checks against ITS
    // policy, which was parsed from the signed event.
    const impostorPolicy = policyWith({ creatorP2pk: ATTACKER_P2PK });
    const { viewer, seeder } = getPair('honest');
    seeder.recordUpload(VIEWER, 4);
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, impostorPolicy);
    expect(msg.creatorProofs.lockedTo).toBe(ATTACKER_P2PK);
    expect(await seeder.verify(VIEWER, msg, POLICY)).toMatchObject({
      ok: false,
      reason: 'wrong-p2pk-target',
    });
    // The viewer API gives the seeder no field through which to name a creator key:
    // `pay(range, seeder, policy)` takes the creator target only from `policy`.
    const honest = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
    expect(honest.creatorProofs.lockedTo).toBe(CREATOR_P2PK);
    // Fixture manifests carry the creator key inside the signed event's `p2pk` tag.
    for (const v of VIDEOS) {
      const tag = v.event.tags.find((t) => t[0] === 'p2pk');
      expect(tag?.[1]).toBe(v.price.creatorP2pk);
    }
  });

  it('T10 sybil seeders serve nothing → pay-after-verify: no upload, no PAY; a PAY for un-uploaded blocks is refused', async () => {
    // Peer reputation is out of scope for Stage 1. Pay-after-verify at the engine boundary:
    // the viewer engine has no path that pays on connect/HELLO — money moves only through
    // `pay(range)` for blocks that fired `download` (caller discipline owned by L2/L7).
    const { viewer, seeder } = getPair('honest');
    expect(viewer.spent().total).toBe(0);
    expect(viewer.spent().perPeer.size).toBe(0);
    expect(seeder.window(VIEWER)).toBeUndefined();

    // The seeder side of the same invariant: nothing uploaded ⇒ nothing payable.
    await fc.assert(
      fc.asyncProperty(rangeArb, async (range) => {
        const fresh = getSeederEngine();
        const msg = await getPair('honest').viewer.pay(range, SEEDER_INFO, POLICY);
        const res = await fresh.verify(OTHER_VIEWER, msg, POLICY);
        expect(res).toMatchObject({ ok: false, reason: 'range-not-uploaded' });
        expect(fresh.window(OTHER_VIEWER)?.paid ?? 0).toBe(0);
      }),
      { numRuns: 30 },
    );
  });

  it('T11 DoS → accounting and bans are strictly per pubkey; a ban carries the Noise key so the transport can refuse reconnects', async () => {
    // Per-pubkey rate limits, max streams and OS hardening are owned by L2 (seeder) and L9.
    // At the engine boundary: windows are independent, one peer's ban never touches another,
    // and `ban()` persists both identities the transport needs.
    const seeder = getSeederEngine();
    const peers = Array.from(
      { length: 8 },
      (_, i) => String(i).padStart(2, '0').repeat(32) as NostrPubkey,
    );
    for (const p of peers) seeder.recordUpload(p, 2);
    expect(seeder.windows()).toHaveLength(peers.length);

    const noise = new Uint8Array(32).fill(7);
    seeder.ban(peers[0]!, 'rate-limit', noise);
    expect(seeder.isBanned(peers[0]!)).toBe(true);
    for (const p of peers.slice(1)) expect(seeder.isBanned(p)).toBe(false);
    const entry = seeder.bans().find((b) => b.pubkey === peers[0]);
    expect(entry).toBeDefined();
    expect(entry!.noiseKey).toEqual(noise);
    expect(entry!.reason).toBe('rate-limit');
    expect(typeof entry!.at).toBe('number');

    // A banned peer's uploads do not disturb the others' windows.
    seeder.recordUpload(peers[0]!, 100);
    for (const p of peers.slice(1))
      expect(seeder.window(p)).toMatchObject({ uploaded: 2, banned: false });

    const { viewer } = getPair('honest');
    const msg = await viewer.pay({ fromBlock: 0, toBlock: 1 }, SEEDER_INFO, POLICY);
    expect(await seeder.verify(peers[1]!, msg, POLICY)).toMatchObject({ ok: true });
    expect(await seeder.verify(peers[0]!, msg, POLICY)).toMatchObject({
      ok: false,
      reason: 'peer-banned',
    });
  });

  it('T12 compromised npm dependency → lockfile present, every dependency pinned exactly, lifecycle scripts disabled', async () => {
    // Native-module inventory and provenance checks are owned by L9 (`ci/`, `scripts/`).
    const lock = JSON.parse(await readRepoFile('package-lock.json')) as {
      lockfileVersion?: number;
    };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);

    const npmrc = await readRepoFile('.npmrc');
    for (const line of ['save-exact=true', 'ignore-scripts=true', 'package-lock=true']) {
      expect(npmrc.split('\n').map((l) => l.trim())).toContain(line);
    }

    const ci = await readRepoFile('ci/gitlab-ci.yml');
    expect(ci).toMatch(/npm ci[^\n]*--ignore-scripts/);

    const manifests = ['package.json'];
    for (const e of await readdir(new URL('packages/', REPO_ROOT), { withFileTypes: true })) {
      if (e.isDirectory()) manifests.push(`packages/${e.name}/package.json`);
    }
    const exact = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
    for (const m of manifests) {
      const pkg = JSON.parse(await readRepoFile(m)) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, version] of Object.entries(pkg[field] ?? {})) {
          if (name.startsWith('@sovit/')) continue; // workspace links
          expect(version, `${m} ${field}.${name}`).toMatch(exact);
        }
      }
    }
  });

  it('T13 malicious portal JS → the policy says so in the UI; the shared protocol carries no browser-only trust', async () => {
    // Reproducible build, SRI and CSP are owned by L9 (build) and L7 (web shell); the
    // "say so in the UI" disclosure is L5/L7. Pin the normative text so the requirement
    // cannot silently disappear from the threat model this suite is generated from.
    const security = await readRepoFile('SECURITY.md');
    const row = security.split('\n').find((l) => l.startsWith('| T13 '));
    expect(row).toBeDefined();
    expect(row).toContain('Not fully fixable in a browser');
    expect(row).toContain('say so in the UI');
    expect(row).toMatch(/reproducible build/i);
    expect(row).toMatch(/\bSRI\b/);
    expect(row).toMatch(/\bCSP\b/);
    // The payment protocol identifier is shared by every shell — no browser-special variant.
    expect(PAY_PROTOCOL_NAME).toBe('pay/1');
  });

  it('T14 host reads keys from disk/logs → nothing the engine exposes (windows, bans, results, callbacks) carries proof material', async () => {
    // Encrypted-at-rest keys and secure memory are Stage 2 (signer / wallet); the redaction
    // layer in front of every logger is L2. At the engine boundary: everything observable
    // after a PAY is free of secrets, C values and DLEQ scalars, so a logger that prints
    // engine state cannot leak them.
    for (const mode of ['honest', 'forge', 'stiff-creator', 'overpay'] as const) {
      const { viewer, seeder } = getPair(mode);
      const windowEvents: PeerWindow[] = [];
      const doubleSpendEvents: unknown[] = [];
      seeder.onWindowExceeded((w) => windowEvents.push(w));
      seeder.onDoubleSpend((p, d) => doubleSpendEvents.push([p, d]));
      seeder.recordUpload(VIEWER, 4);
      const msg = await viewer.pay({ fromBlock: 0, toBlock: 3 }, SEEDER_INFO, POLICY);
      const result: VerifyResult = await seeder.verify(VIEWER, msg, POLICY);
      seeder.recordUpload(VIEWER, 5); // force a window-exceeded event too
      const flushResult = await seeder.flush();
      const observed = observableState(seeder, VIEWER, {
        result,
        windowEvents,
        doubleSpendEvents,
        flushResult,
      });
      const material = proofMaterial(msg);
      expect(material.length).toBeGreaterThan(0);
      for (const s of material) expect(observed).not.toContain(s);
    }
  });

  it('T15 XSS via titles/descriptions/comments → contracts carry text, never HTML; fixtures contain no markup', async () => {
    // Rendering as text / sanitized markdown, CSP and Electron isolation are owned by L4
    // (renderer test: raw HTML never renders), L6 and L9. At the contract level: no field is
    // typed or named as HTML, the manifest documents the markdown-subset rule, and the
    // fixture corpus every screen is built against is markup-free.
    const contractsDir = new URL('packages/core/src/contracts/', REPO_ROOT);
    for (const f of await listTs(contractsDir)) {
      const src = stripComments(await readFile(f, 'utf8'));
      expect(src, f.pathname).not.toMatch(/\b(innerHTML|dangerouslySetInnerHTML|html)\s*[?:]/);
    }
    const manifestSrc = await readFile(new URL('manifest.ts', contractsDir), 'utf8');
    expect(manifestSrc).toMatch(/markdown subset/);

    const html = /<\/?[a-z][\s\S]*?>|javascript:|on\w+\s*=/i;
    for (const v of VIDEOS) {
      expect(v.title).not.toMatch(html);
      expect(v.description).not.toMatch(html);
      for (const c of fixtureComments(v.id)) expect(c.content).not.toMatch(html);
    }
  });

  it('T16 malicious thumbnail/blob → every fixture thumbnail is a Blossom blob with a sha256 the renderer must verify before display', () => {
    // "Verify before display; images decoded in renderer only" is owned by L4/L5. At the
    // contract level the hash MUST be there to verify against: every rendition's `image`
    // carries a 64-hex sha256, every rendition's own `x` hash is in the signed imeta, and
    // no thumbnail is inlined as executable content.
    const hex64 = /^[0-9a-f]{64}$/;
    expect(VIDEOS.length).toBeGreaterThan(0);
    for (const v of VIDEOS) {
      expect(v.renditions.length).toBeGreaterThan(0);
      for (const r of v.renditions) {
        expect(r.sha256).toMatch(hex64);
        expect(r.image).toBeDefined();
        expect(r.image!.sha256).toMatch(hex64);
        expect(r.image!.url).toMatch(/^https:\/\//);
        if (r.placeholder !== undefined) expect(r.placeholder).toMatch(/^data:image\//);
        const imeta = v.event.tags.find(
          (t) => t[0] === 'imeta' && t.some((kv) => kv === `x ${r.sha256}`),
        );
        expect(imeta, `imeta with x for ${v.title}/${r.label}`).toBeDefined();
      }
    }
  });
});

// Keep the table and this file in lock-step: every row id in SECURITY.md has a test above.
describe('SECURITY.md threat table coverage', () => {
  it('every T-row in SECURITY.md is named by a test in this file', async () => {
    const security = await readRepoFile('SECURITY.md');
    const rows = [...security.matchAll(/^\| (T\d+) \|/gm)].map((m) => m[1]!);
    expect(rows).toEqual(Array.from({ length: 16 }, (_, i) => `T${String(i + 1)}`));
    const self = await readFile(new URL(import.meta.url), 'utf8');
    for (const id of rows) expect(self).toMatch(new RegExp(`it\\('${id} `));
  });
});

// Type-level pin: `LockedProofSet.unit` is the closed literal the wire expects.
const _unit: LockedProofSet['unit'] = 'sat';
