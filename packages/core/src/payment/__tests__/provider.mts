/**
 * L10 provider indirection — the Stage 2 seam for the adversary suite.
 *
 * Every payment test in this directory reaches the engine ONLY through this module, so the
 * Stage 2 session that implements `packages/core/src/payment/` unskips nothing and rewires
 * one place: make `getSeederEngine()` return the real `PaymentEngine` (and, once a wallet
 * that can mint test proofs exists, make `getPair('honest').viewer` the real viewer side;
 * the cheating modes can stay on the mock or become mutators over real proofs).
 *
 * Why `.mts`: `packages/core/vitest.config.ts` includes `src/**\/__tests__/**\/*.ts`, so a
 * plain `provider.ts` would be collected as a test file and fail with "No test suite found".
 * `.mts` is not matched by that glob but is still typechecked, linted and Prettier-checked.
 *
 * Nothing here is crypto. Nothing here is implementation. Test infrastructure only.
 */
import type {
  BanEntry,
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PaymentEngine,
  PaymentEngineConfig,
  PaymentEngineViewer,
  PeerWindow,
  PricePolicy,
  Sats,
  UnixSeconds,
  VerifyResult,
} from '../../contracts/index.js';
import { DEFAULT_BLOCK_SIZE, DEFAULT_WINDOW_BLOCKS } from '../../contracts/index.js';
import { MockPaymentEngine, type MockPaymentMode } from '../../mocks/mock-payment-engine.js';

// ---------------------------------------------------------------------------------------
// Modes — enumerated from the mock's `MockPaymentMode` type, checked exhaustive at compile
// time so a mode added to the mock without a test here fails `tsc`.
// ---------------------------------------------------------------------------------------

export type AdversaryMode = MockPaymentMode;

export const ALL_MODES = [
  'honest',
  'stiff-creator',
  'stiff-seeder',
  'double-spend',
  'forge',
  'overpay',
  'underpay',
] as const satisfies readonly MockPaymentMode[];

type MissingMode = Exclude<MockPaymentMode, (typeof ALL_MODES)[number]>;
type ExtraMode = Exclude<(typeof ALL_MODES)[number], MockPaymentMode>;
// Both must be `never`; if either is not, the assignment below fails to typecheck.
const _modesExhaustive: [MissingMode, ExtraMode] extends [never, never] ? true : never = true;

export type CheatingMode = Exclude<AdversaryMode, 'honest'>;
export const CHEATING_MODES: readonly CheatingMode[] = ALL_MODES.filter(
  (m): m is CheatingMode => m !== 'honest',
);

// ---------------------------------------------------------------------------------------
// Fixtures (mirrors the seed test in core/src/mocks/__tests__/mock-payment-engine.test.ts)
// ---------------------------------------------------------------------------------------

export const MINT_A = 'https://mint.fixture-a.example' as MintUrl;
export const MINT_B = 'https://mint.fixture-b.example' as MintUrl;
export const MINT_UNKNOWN = 'https://mint.unknown.example' as MintUrl;

export const SEEDER_P2PK = ('02' + 'ab'.repeat(32)) as CashuP2pkPubkey;
export const OTHER_SEEDER_P2PK = ('02' + 'ba'.repeat(32)) as CashuP2pkPubkey;
export const CREATOR_P2PK = ('02' + 'cc'.repeat(32)) as CashuP2pkPubkey;
export const ATTACKER_P2PK = ('02' + 'ee'.repeat(32)) as CashuP2pkPubkey;

export const SEEDER = 'cd'.repeat(32) as NostrPubkey;
export const OTHER_SEEDER = 'dc'.repeat(32) as NostrPubkey;
export const VIEWER = 'ef'.repeat(32) as NostrPubkey;
export const OTHER_VIEWER = 'fe'.repeat(32) as NostrPubkey;

export const sats = (n: number): Sats => n as Sats;
export const unix = (n: number): UnixSeconds => n as UnixSeconds;

export const POLICY: PricePolicy = {
  satsPerBlock: sats(2),
  blockSize: DEFAULT_BLOCK_SIZE,
  mints: [MINT_A],
  split: { seeder: 50, creator: 50 },
  creatorP2pk: CREATOR_P2PK,
};

export function policyWith(overrides: Partial<PricePolicy>): PricePolicy {
  return { ...POLICY, ...overrides };
}

export const SEEDER_INFO = { pubkey: SEEDER, p2pk: SEEDER_P2PK, mint: MINT_A } as const;

/**
 * For scenarios that are NOT about the window (amounts, DLEQ, ranges…): a window wide
 * enough that uploading the whole scenario up-front never trips the T3/INV5 cut.
 */
export const WIDE_WINDOW: EngineOptions = { config: { windowBlocks: 1_000 } };

/** Deterministic, strictly increasing clock. */
export function clock(start = 1_000): { now: () => UnixSeconds; current: () => UnixSeconds } {
  let t = start;
  return { now: (): UnixSeconds => unix(t++), current: (): UnixSeconds => unix(t) };
}

// ---------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------

export interface EngineOptions {
  readonly config?: Partial<PaymentEngineConfig>;
  readonly now?: () => UnixSeconds;
}

/**
 * Seeder-side engine under test (the audit surface: `verify`, `recordUpload`, windows,
 * bans, `flush`). Stage 2: return the real engine here.
 */
export function getSeederEngine(opts: EngineOptions = {}): PaymentEngine {
  const config: Partial<PaymentEngineConfig> = {
    windowBlocks: DEFAULT_WINDOW_BLOCKS,
    ownP2pk: SEEDER_P2PK,
    ownPubkey: SEEDER,
    acceptedMints: [MINT_A],
    ...opts.config,
  };
  return opts.now
    ? new MockPaymentEngine({ mode: 'honest', config, now: opts.now })
    : new MockPaymentEngine({ mode: 'honest', config });
}

/**
 * Viewer-side message producer for a given adversary mode. `honest` must produce a PAY the
 * seeder accepts; every other mode must produce one it rejects (or, for `double-spend`, one
 * the swap batch catches).
 */
export function getViewerEngine(
  mode: AdversaryMode,
  opts: EngineOptions = {},
): PaymentEngineViewer {
  return opts.now
    ? new MockPaymentEngine({ mode, now: opts.now, viewerPubkey: VIEWER })
    : new MockPaymentEngine({ mode, viewerPubkey: VIEWER });
}

/**
 * True while the seam still returns the reference model. Tests that pin behaviour the mock
 * deliberately stands in for (real NUT-11 secret parsing, real DLEQ) are `it.skipIf(usingMock())`
 * with a full body, so they run the moment Stage 2 rewires `getSeederEngine()`.
 */
export function usingMock(): boolean {
  return getSeederEngine() instanceof MockPaymentEngine;
}

export interface AdversaryPair {
  readonly viewer: PaymentEngineViewer;
  readonly seeder: PaymentEngine;
  readonly clock: ReturnType<typeof clock>;
}

export function getPair(mode: AdversaryMode = 'honest', opts: EngineOptions = {}): AdversaryPair {
  const c = clock();
  const now = opts.now ?? c.now;
  const seederOpts: EngineOptions = opts.config ? { now, config: opts.config } : { now };
  return {
    viewer: getViewerEngine(mode, { now }),
    seeder: getSeederEngine(seederOpts),
    clock: c,
  };
}

// ---------------------------------------------------------------------------------------
// Pure helpers over the wire types (object spreads only — no crypto, no primitives)
// ---------------------------------------------------------------------------------------

export function blocksIn(range: PayMessage['range']): number {
  return range.toBlock - range.fromBlock + 1;
}

export function sumProofs(proofs: readonly CashuProof[]): number {
  return proofs.reduce((a, p) => a + p.amount, 0);
}

/** The split rule the reference model uses: floor to the seeder, remainder to the creator. */
export function expectedShares(
  blocks: number,
  policy: PricePolicy,
): { readonly total: number; readonly seeder: number; readonly creator: number } {
  const total = blocks * policy.satsPerBlock;
  const seeder = Math.floor((total * policy.split.seeder) / 100);
  return { total, seeder, creator: total - seeder };
}

export function withSeederSet(msg: PayMessage, set: Partial<LockedProofSet>): PayMessage {
  return { ...msg, seederProofs: { ...msg.seederProofs, ...set } };
}

export function withCreatorSet(msg: PayMessage, set: Partial<LockedProofSet>): PayMessage {
  return { ...msg, creatorProofs: { ...msg.creatorProofs, ...set } };
}

export function mapProofs(
  set: LockedProofSet,
  f: (p: CashuProof, i: number) => CashuProof,
): LockedProofSet {
  return { ...set, proofs: set.proofs.map(f) };
}

/** Every string that would identify proof material if it leaked (T14 / INV7). */
export function proofMaterial(msg: PayMessage): readonly string[] {
  const out: string[] = [];
  for (const set of [msg.seederProofs, msg.creatorProofs]) {
    for (const p of set.proofs) {
      out.push(p.secret, p.C);
      if (p.dleq) {
        out.push(p.dleq.s, p.dleq.e);
        if (p.dleq.r !== undefined) out.push(p.dleq.r);
      }
      if (p.witness !== undefined) out.push(p.witness);
    }
  }
  // Mock stand-ins like "mock" / "mock-s" are shared by every proof; they still must not
  // appear in observable state, but only meaningfully-unique strings are worth asserting on.
  return out.filter((s) => s.length >= 6);
}

/** Everything a consumer could observe from the seeder side after a verify. */
export function observableState(
  seeder: PaymentEngine,
  peer: NostrPubkey,
  extras: {
    readonly result?: VerifyResult;
    readonly windowEvents?: readonly PeerWindow[];
    readonly doubleSpendEvents?: readonly unknown[];
    readonly flushResult?: unknown;
  } = {},
): string {
  const state: {
    window: PeerWindow | undefined;
    windows: readonly PeerWindow[];
    bans: readonly BanEntry[];
    spent: unknown;
    extras: unknown;
  } = {
    window: seeder.window(peer),
    windows: seeder.windows(),
    bans: seeder.bans(),
    spent: seeder.spent(),
    extras,
  };
  return JSON.stringify(state, (_k, v: unknown) =>
    v instanceof Uint8Array ? `u8[${String(v.length)}]` : v,
  );
}
