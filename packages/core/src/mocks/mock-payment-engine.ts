/**
 * MockPaymentEngine — execution plan §0 rule 4.
 *
 * Lanes integrate against `mode: 'honest'`. The adversary suite (L10) drives the cheating
 * modes and asserts rejection. The seeder-side `verify()` here is a *reference model of the
 * rules* in SECURITY.md (amounts, targets, sets, window, replay, mint allowlist, ban on
 * double-spend), with the cryptographic checks replaced by structural stand-ins:
 *
 *   - DLEQ valid        ⇔ `proof.dleq` present and `dleq.s !== FORGED`
 *   - proof authenticity ⇔ secret starts with `mock:`
 *   - double-spend       ⇔ a secret seen in a previous accepted PAY (detected at `flush()`,
 *                          asynchronously, exactly like the real engine's swap batch)
 *
 * The real engine (Stage 2) replaces the stand-ins with cashu-ts calls and must pass the
 * same tests. Nothing here is crypto. Nothing here may be imported by production code.
 */
import type {
  BanEntry,
  BlockRange,
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PaymentEngine,
  PaymentEngineConfig,
  PeerWindow,
  PricePolicy,
  RejectReason,
  Sats,
  UnixSeconds,
  VerifyResult,
} from '../contracts/index.js';

export type MockPaymentMode =
  'honest' | 'stiff-creator' | 'stiff-seeder' | 'double-spend' | 'forge' | 'overpay' | 'underpay';

export const FORGED = 'FORGED' as const;

export interface MockPaymentEngineOptions {
  readonly mode?: MockPaymentMode;
  readonly config?: Partial<PaymentEngineConfig>;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => UnixSeconds;
  /** Viewer's own pubkey (used in `spent()` accounting only). */
  readonly viewerPubkey?: NostrPubkey;
}

const DEFAULT_CONFIG: PaymentEngineConfig = {
  windowBlocks: 4,
  acceptedMints: ['https://mint.fixture-a.example', 'https://mint.fixture-b.example'] as MintUrl[],
  ownP2pk: ('02' + 'ab'.repeat(32)) as CashuP2pkPubkey,
  ownPubkey: 'cd'.repeat(32) as NostrPubkey,
  flushEveryBlocks: 64,
  flushEveryMs: 60_000,
};

interface MutableWindow {
  peer: NostrPubkey;
  uploaded: number;
  paid: number;
  windowBlocks: number;
  banned: boolean;
  lastActivity: UnixSeconds;
  /** Ranges accepted, for replay detection. */
  paidRanges: BlockRange[];
}

function blocksIn(r: BlockRange): number {
  return r.toBlock - r.fromBlock + 1;
}

function sum(proofs: readonly CashuProof[]): number {
  return proofs.reduce((a, p) => a + p.amount, 0);
}

/** Split an integer into power-of-two denominations, largest first. */
export function denominate(amount: number): number[] {
  const out: number[] = [];
  let bit = 1;
  while (amount > 0) {
    if (amount & 1) out.unshift(bit);
    amount >>= 1;
    bit <<= 1;
  }
  return out;
}

export class MockPaymentEngine implements PaymentEngine {
  readonly config: PaymentEngineConfig;
  mode: MockPaymentMode;

  private readonly now: () => UnixSeconds;
  private readonly windowMap = new Map<NostrPubkey, MutableWindow>();
  private readonly banMap = new Map<NostrPubkey, BanEntry>();
  private readonly seenSecrets = new Set<string>();
  private readonly pending: { peer: NostrPubkey; msg: PayMessage }[] = [];
  private readonly windowListeners = new Set<(w: PeerWindow) => void>();
  private readonly doubleSpendListeners = new Set<
    (peer: NostrPubkey, d: { mint: MintUrl; amount: Sats }) => void
  >();

  // viewer side
  private seq = 0;
  private lastSent: { seeder: LockedProofSet; creator: LockedProofSet } | null = null;
  private readonly spentPerPeer = new Map<NostrPubkey, number>();

  /** Test hooks — visible on purpose so the adversary suite can assert internal effects. */
  readonly log: {
    at: UnixSeconds;
    kind: 'ban' | 'unban' | 'window-exceeded' | 'double-spend' | 'flush';
    peer?: NostrPubkey;
    detail?: string;
  }[] = [];

  constructor(opts: MockPaymentEngineOptions = {}) {
    this.mode = opts.mode ?? 'honest';
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.now = opts.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  // ------------------------------------------------------------------ viewer side

  async pay(
    range: BlockRange,
    seeder: {
      readonly pubkey: NostrPubkey;
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
    },
    policy: PricePolicy,
  ): Promise<PayMessage> {
    const blocks = blocksIn(range);
    const total = blocks * policy.satsPerBlock;
    let seederAmt = Math.floor((total * policy.split.seeder) / 100);
    let creatorAmt = total - seederAmt;

    if (this.mode === 'overpay') seederAmt += 1;
    if (this.mode === 'underpay') creatorAmt = Math.max(0, creatorAmt - 1);

    let seederSet = this.mint(seeder.mint, seeder.p2pk, seederAmt);
    let creatorSet = this.mint(seeder.mint, policy.creatorP2pk, creatorAmt);

    switch (this.mode) {
      case 'stiff-creator':
        // Lock the creator's share to ourselves instead of the creator.
        creatorSet = this.mint(seeder.mint, seeder.p2pk, creatorAmt);
        break;
      case 'stiff-seeder':
        seederSet = { ...seederSet, proofs: [] };
        break;
      case 'double-spend':
        // Replay the previous PAY's proofs for a new range; the first PAY is honest.
        if (this.lastSent) {
          seederSet = this.lastSent.seeder;
          creatorSet = this.lastSent.creator;
        }
        break;
      case 'forge':
        seederSet = {
          ...seederSet,
          proofs: seederSet.proofs.map((p) => ({ ...p, dleq: { s: FORGED, e: FORGED } })),
        };
        break;
      case 'honest':
      case 'overpay':
      case 'underpay':
        break;
    }

    this.lastSent = { seeder: seederSet, creator: creatorSet };
    this.spentPerPeer.set(
      seeder.pubkey,
      (this.spentPerPeer.get(seeder.pubkey) ?? 0) + sum(seederSet.proofs) + sum(creatorSet.proofs),
    );
    return Promise.resolve({ range, seederProofs: seederSet, creatorProofs: creatorSet });
  }

  spent(): { readonly total: Sats; readonly perPeer: ReadonlyMap<NostrPubkey, Sats> } {
    let total = 0;
    const perPeer = new Map<NostrPubkey, Sats>();
    for (const [k, v] of this.spentPerPeer) {
      total += v;
      perPeer.set(k, v as Sats);
    }
    return { total: total as Sats, perPeer };
  }

  private mint(mint: MintUrl, lockedTo: CashuP2pkPubkey, amount: number): LockedProofSet {
    const proofs: CashuProof[] = denominate(amount).map((amt) => ({
      id: 'mockkeyset00',
      amount: amt,
      secret: `mock:${String(++this.seq)}:${lockedTo.slice(2, 10)}`,
      C: 'mock',
      dleq: { s: 'mock-s', e: 'mock-e' },
    }));
    return { mint, unit: 'sat', lockedTo, proofs };
  }

  // ------------------------------------------------------------------ seeder side

  verify(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): Promise<VerifyResult> {
    return Promise.resolve(this.verifySync(peer, msg, policy));
  }

  private verifySync(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): VerifyResult {
    const reject = (reason: RejectReason, detail?: string): VerifyResult =>
      detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

    if (this.banMap.has(peer)) return reject('peer-banned');
    if (!isPayMessage(msg)) return reject('malformed');
    const { range, seederProofs, creatorProofs } = msg;
    if (range.toBlock < range.fromBlock || range.fromBlock < 0)
      return reject('malformed', 'bad range');

    if (seederProofs.proofs.length === 0) return reject('missing-seeder-set');
    if (creatorProofs.proofs.length === 0) return reject('missing-creator-set');

    for (const set of [seederProofs, creatorProofs]) {
      if (!this.config.acceptedMints.includes(set.mint) || !policy.mints.includes(set.mint))
        return reject('mint-not-accepted', set.mint);
      for (const p of set.proofs) {
        if (!p.dleq) return reject('missing-dleq');
        if (p.dleq.s === FORGED || p.dleq.e === FORGED || !p.secret.startsWith('mock:'))
          return reject('bad-dleq');
      }
    }
    if (seederProofs.lockedTo !== this.config.ownP2pk)
      return reject('wrong-p2pk-target', 'seeder set');
    if (creatorProofs.lockedTo !== policy.creatorP2pk)
      return reject('wrong-p2pk-target', 'creator set');

    const blocks = blocksIn(range);
    const total = blocks * policy.satsPerBlock;
    const expectSeeder = Math.floor((total * policy.split.seeder) / 100);
    const expectCreator = total - expectSeeder;
    const gotSeeder = sum(seederProofs.proofs);
    const gotCreator = sum(creatorProofs.proofs);
    if (gotSeeder > expectSeeder || gotCreator > expectCreator)
      return reject('overpay', `${gotSeeder}+${gotCreator} > ${expectSeeder}+${expectCreator}`);
    if (gotSeeder !== expectSeeder || gotCreator !== expectCreator)
      return reject(
        'wrong-amount',
        `${gotSeeder}+${gotCreator} != ${expectSeeder}+${expectCreator}`,
      );

    const w = this.windowFor(peer);
    if (range.toBlock >= w.uploaded)
      return reject('range-not-uploaded', `toBlock ${range.toBlock} >= uploaded ${w.uploaded}`);
    for (const r of w.paidRanges) {
      if (range.fromBlock <= r.toBlock && r.fromBlock <= range.toBlock)
        return reject('range-already-paid');
    }

    // Accept: credit the window, queue proofs for the async swap batch.
    w.paid += blocks;
    w.paidRanges.push(range);
    w.lastActivity = this.now();
    this.pending.push({ peer, msg });
    return { ok: true, credited: total as Sats, blocks };
  }

  recordUpload(peer: NostrPubkey, blocks: number): PeerWindow {
    const w = this.windowFor(peer);
    w.uploaded += blocks;
    w.lastActivity = this.now();
    const snap = this.snapshot(w);
    if (snap.outstanding > w.windowBlocks && !w.banned) {
      this.log.push({
        at: this.now(),
        kind: 'window-exceeded',
        peer,
        detail: `outstanding=${snap.outstanding}`,
      });
      this.ban(peer, 'window-exceeded');
      const after = this.snapshot(w);
      for (const cb of this.windowListeners) cb(after);
      return after;
    }
    return snap;
  }

  window(peer: NostrPubkey): PeerWindow | undefined {
    const w = this.windowMap.get(peer);
    return w ? this.snapshot(w) : undefined;
  }

  windows(): readonly PeerWindow[] {
    return [...this.windowMap.values()].map((w) => this.snapshot(w));
  }

  onWindowExceeded(cb: (w: PeerWindow) => void): () => void {
    this.windowListeners.add(cb);
    return () => this.windowListeners.delete(cb);
  }

  onDoubleSpend(
    cb: (peer: NostrPubkey, detail: { readonly mint: MintUrl; readonly amount: Sats }) => void,
  ): () => void {
    this.doubleSpendListeners.add(cb);
    return () => this.doubleSpendListeners.delete(cb);
  }

  flush(): Promise<{ readonly swapped: Sats; readonly nutzapped: Sats; readonly failed: number }> {
    let swapped = 0;
    let nutzapped = 0;
    let failed = 0;
    const batch = this.pending.splice(0);
    for (const { peer, msg } of batch) {
      const all = [...msg.seederProofs.proofs, ...msg.creatorProofs.proofs];
      const dup = all.find((p) => this.seenSecrets.has(p.secret));
      if (dup) {
        failed++;
        const amount = sum(all) as Sats;
        this.log.push({ at: this.now(), kind: 'double-spend', peer, detail: `amount=${amount}` });
        this.ban(peer, 'double-spend');
        for (const cb of this.doubleSpendListeners)
          cb(peer, { mint: msg.seederProofs.mint, amount });
        continue;
      }
      for (const p of all) this.seenSecrets.add(p.secret);
      swapped += sum(msg.seederProofs.proofs);
      nutzapped += sum(msg.creatorProofs.proofs);
    }
    this.log.push({
      at: this.now(),
      kind: 'flush',
      detail: `swapped=${swapped} nutzapped=${nutzapped} failed=${failed}`,
    });
    return Promise.resolve({ swapped: swapped as Sats, nutzapped: nutzapped as Sats, failed });
  }

  ban(peer: NostrPubkey, reason: string, noiseKey?: Uint8Array): void {
    this.banMap.set(
      peer,
      noiseKey
        ? { pubkey: peer, noiseKey, reason, at: this.now() }
        : { pubkey: peer, reason, at: this.now() },
    );
    const w = this.windowMap.get(peer);
    if (w) w.banned = true;
    this.log.push({ at: this.now(), kind: 'ban', peer, detail: reason });
  }

  unban(peer: NostrPubkey): void {
    this.banMap.delete(peer);
    const w = this.windowMap.get(peer);
    if (w) w.banned = false;
    this.log.push({ at: this.now(), kind: 'unban', peer });
  }

  isBanned(peer: NostrPubkey): boolean {
    return this.banMap.has(peer);
  }

  bans(): readonly BanEntry[] {
    return [...this.banMap.values()];
  }

  /** Test hook: pending (unswapped) proof count. */
  pendingCount(): number {
    return this.pending.length;
  }

  private windowFor(peer: NostrPubkey): MutableWindow {
    let w = this.windowMap.get(peer);
    if (!w) {
      w = {
        peer,
        uploaded: 0,
        paid: 0,
        windowBlocks: this.config.windowBlocks,
        banned: this.banMap.has(peer),
        lastActivity: this.now(),
        paidRanges: [],
      };
      this.windowMap.set(peer, w);
    }
    return w;
  }

  private snapshot(w: MutableWindow): PeerWindow {
    return {
      peer: w.peer,
      uploaded: w.uploaded,
      paid: w.paid,
      outstanding: w.uploaded - w.paid,
      windowBlocks: w.windowBlocks,
      banned: w.banned,
      lastActivity: w.lastActivity,
    };
  }
}

/** Structural guard used before touching any field — `verify` must never throw (invariant 4). */
export function isPayMessage(x: unknown): x is PayMessage {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  const r = m['range'];
  if (typeof r !== 'object' || r === null) return false;
  const rr = r as Record<string, unknown>;
  if (!Number.isInteger(rr['fromBlock']) || !Number.isInteger(rr['toBlock'])) return false;
  return isLockedSet(m['seederProofs']) && isLockedSet(m['creatorProofs']);
}

function isLockedSet(x: unknown): x is LockedProofSet {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  if (typeof s['mint'] !== 'string' || typeof s['lockedTo'] !== 'string' || s['unit'] !== 'sat')
    return false;
  const proofs = s['proofs'];
  if (!Array.isArray(proofs)) return false;
  return proofs.every((p: unknown) => {
    if (typeof p !== 'object' || p === null) return false;
    const q = p as Record<string, unknown>;
    return (
      typeof q['id'] === 'string' &&
      Number.isInteger(q['amount']) &&
      (q['amount'] as number) > 0 &&
      typeof q['secret'] === 'string' &&
      typeof q['C'] === 'string'
    );
  });
}
