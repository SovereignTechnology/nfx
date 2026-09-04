/**
 * fast-check arbitraries for every `pay/1` wire message, plus a structural validator used
 * to judge what `decode()` hands back for corrupted input. Test infrastructure only: no
 * crypto (challenge/signature/C/DLEQ are random hex, never real signatures), no codec.
 */
import * as fc from 'fast-check';

import type {
  AckMessage,
  CashuP2pkPubkey,
  CashuProof,
  HelloMessage,
  LockedProofSet,
  MintUrl,
  NostrPubkey,
  PayMessage,
  PayProtocolMessage,
  PayWireMessage,
  PriceMessage,
  RejectReason,
  Sats,
  SerializedDleq,
} from '../../contracts/index.js';

// ---------------------------------------------------------------------------------------
// Constants taken from the contracts (kept in one place so the validator and the
// arbitraries cannot drift apart).
// ---------------------------------------------------------------------------------------

export const REJECT_REASONS = [
  'bad-dleq',
  'wrong-p2pk-target',
  'wrong-amount',
  'overpay',
  'mint-not-accepted',
  'missing-creator-set',
  'missing-seeder-set',
  'range-not-uploaded',
  'range-already-paid',
  'missing-dleq',
  'malformed',
  'peer-banned',
] as const satisfies readonly RejectReason[];
type _ReasonsExhaustive =
  Exclude<RejectReason, (typeof REJECT_REASONS)[number]> extends never ? true : never;
const _reasonsExhaustive: _ReasonsExhaustive = true;
export { _reasonsExhaustive as REJECT_REASONS_EXHAUSTIVE };

/** 21 M BTC in sats — the largest amount that can ever be on the wire. */
export const MAX_SATS = 2_100_000_000_000_000;
/** Hypercore block indices are array positions; keep them below 2^40 (a 64 PiB core). */
export const MAX_BLOCK = 2 ** 40;

/**
 * fast-check 4 `fc.record` builds NULL-PROTOTYPE objects (verified against 4.9.0). A codec
 * returns ordinary objects, and `toStrictEqual` treats the two as different types, so every
 * generated message is rebuilt as plain `Object.prototype` data before it leaves this module.
 */
export function plain<T>(x: T): T {
  if (Array.isArray(x)) return x.map((v: unknown) => plain(v)) as T;
  if (typeof x === 'object' && x !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = plain(v);
    return out as T;
  }
  return x;
}

// ---------------------------------------------------------------------------------------
// Leaf arbitraries
// ---------------------------------------------------------------------------------------

const hexOf = (bytes: number): fc.Arbitrary<string> =>
  fc
    .uint8Array({ minLength: bytes, maxLength: bytes })
    .map((u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(''));

export const hex32Arb = hexOf(32);
export const hex64Arb = hexOf(64);
export const nostrPubkeyArb: fc.Arbitrary<NostrPubkey> = hex32Arb.map((h) => h as NostrPubkey);
export const p2pkArb: fc.Arbitrary<CashuP2pkPubkey> = fc
  .tuple(fc.constantFrom('02', '03'), hex32Arb)
  .map(([prefix, h]) => `${prefix}${h}` as CashuP2pkPubkey);
export const mintUrlArb: fc.Arbitrary<MintUrl> = fc
  .tuple(fc.constantFrom('https', 'http'), fc.domain({ size: 'small' }), fc.option(fc.nat(65535)))
  .map(
    ([scheme, host, port]) =>
      `${scheme}://${host}${port === null ? '' : `:${String(port)}`}` as MintUrl,
  );
export const satsArb: fc.Arbitrary<Sats> = fc
  .integer({ min: 0, max: MAX_SATS })
  .map((n) => n as Sats);
export const positiveSatsArb: fc.Arbitrary<Sats> = fc
  .integer({ min: 1, max: MAX_SATS })
  .map((n) => n as Sats);
export const blockIndexArb = fc.integer({ min: 0, max: MAX_BLOCK });

/** Any UTF-8-encodable string (fast-check's `binary` unit excludes lone surrogates). */
export const textArb = fc.oneof(
  { arbitrary: fc.string({ maxLength: 120 }), weight: 3 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 60 }), weight: 1 },
  { arbitrary: fc.constant(''), weight: 1 },
);

export const splitArb = fc.integer({ min: 0, max: 100 }).map((seeder) => ({
  seeder,
  creator: 100 - seeder,
}));

export const rangeArb = fc
  .tuple(blockIndexArb, fc.integer({ min: 0, max: 4096 }))
  .map(([from, len]) => ({ fromBlock: from, toBlock: Math.min(from + len, MAX_BLOCK) }));

// ---------------------------------------------------------------------------------------
// Cashu shapes
// ---------------------------------------------------------------------------------------

export const dleqArb: fc.Arbitrary<SerializedDleq> = fc
  .tuple(hex32Arb, hex32Arb, fc.option(hex32Arb))
  .map(([s, e, r]) => (r === null ? { s, e } : { s, e, r }));

/** A NUT-11 P2PK well-known secret as it appears on the wire (JSON string) — or any text. */
export const secretArb = fc.oneof(
  { arbitrary: textArb, weight: 1 },
  {
    weight: 2,
    arbitrary: fc
      .tuple(hex32Arb, p2pkArb)
      .map(([nonce, data]) =>
        JSON.stringify(['P2PK', { nonce, data, tags: [['sigflag', 'SIG_INPUTS']] }]),
      ),
  },
);

export const proofArb: fc.Arbitrary<CashuProof> = fc
  .record({
    id: hexOf(8),
    amount: fc.integer({ min: 1, max: 2 ** 40 }),
    secret: secretArb,
    C: p2pkArb,
    dleq: fc.option(dleqArb, { freq: 6 }),
    witness: fc.option(
      hex64Arb.map((sig) => JSON.stringify({ signatures: [sig] })),
      { freq: 4 },
    ),
  })
  .map(({ id, amount, secret, C, dleq, witness }) => {
    const p: CashuProof = { id, amount, secret, C };
    return {
      ...p,
      ...(dleq === null ? {} : { dleq }),
      ...(witness === null ? {} : { witness }),
    };
  });

export const lockedSetArb: fc.Arbitrary<LockedProofSet> = fc.record({
  mint: mintUrlArb,
  unit: fc.constant<'sat'>('sat'),
  lockedTo: p2pkArb,
  proofs: fc.array(proofArb, { maxLength: 12 }),
});

export const payMessageArb: fc.Arbitrary<PayMessage> = fc
  .record({
    range: rangeArb,
    seederProofs: lockedSetArb,
    creatorProofs: lockedSetArb,
  })
  .map(plain);

// ---------------------------------------------------------------------------------------
// The four wire messages
// ---------------------------------------------------------------------------------------

export const helloArb: fc.Arbitrary<HelloMessage> = fc
  .record({
    type: fc.constant<'HELLO'>('HELLO'),
    version: fc.integer({ min: 0, max: 0xffff }),
    pubkey: nostrPubkeyArb,
    challenge: hex32Arb,
    signature: hex64Arb,
    acceptedMints: fc.array(mintUrlArb, { maxLength: 6 }),
    satsPerBlock: satsArb,
    split: splitArb,
    p2pk: p2pkArb,
  })
  .map(plain);

export const payWireArb: fc.Arbitrary<PayWireMessage> = fc
  .record({
    type: fc.constant<'PAY'>('PAY'),
    payload: payMessageArb,
  })
  .map(plain);

export const ackArb: fc.Arbitrary<AckMessage> = fc
  .record({
    fromBlock: blockIndexArb,
    toBlock: blockIndexArb,
    ok: fc.boolean(),
    reason: fc.option(fc.constantFrom(...REJECT_REASONS)),
  })
  .map(({ fromBlock, toBlock, ok, reason }) => {
    const base: AckMessage = { type: 'ACK', fromBlock, toBlock, ok };
    return reason === null ? base : { ...base, reason };
  })
  .map(plain);

export const priceArb: fc.Arbitrary<PriceMessage> = fc
  .record({
    type: fc.constant<'PRICE'>('PRICE'),
    satsPerBlock: satsArb,
    effectiveFromBlock: blockIndexArb,
  })
  .map(plain);

export const messageArb: fc.Arbitrary<PayProtocolMessage> = fc.oneof(
  helloArb,
  payWireArb,
  ackArb,
  priceArb,
);

// ---------------------------------------------------------------------------------------
// Structural validator: what a *decoded* value must look like to count as a message at all
// ---------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isStr = (x: unknown): x is string => typeof x === 'string';
const isUint = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isNoExtraUndefined = (o: Record<string, unknown>): boolean =>
  Object.values(o).every((v) => v !== undefined);

function isDleq(x: unknown): x is SerializedDleq {
  return (
    isObj(x) &&
    isStr(x['s']) &&
    isStr(x['e']) &&
    (x['r'] === undefined ? !('r' in x) : isStr(x['r']))
  );
}

function isProof(x: unknown): x is CashuProof {
  if (!isObj(x)) return false;
  if (!isStr(x['id']) || !isUint(x['amount']) || x['amount'] < 1) return false;
  if (!isStr(x['secret']) || !isStr(x['C'])) return false;
  if ('dleq' in x && !isDleq(x['dleq'])) return false;
  if ('witness' in x && !isStr(x['witness'])) return false;
  return isNoExtraUndefined(x);
}

function isLockedSet(x: unknown): x is LockedProofSet {
  return (
    isObj(x) &&
    isStr(x['mint']) &&
    x['unit'] === 'sat' &&
    isStr(x['lockedTo']) &&
    Array.isArray(x['proofs']) &&
    x['proofs'].every(isProof)
  );
}

function isRange(x: unknown): x is PayMessage['range'] {
  return isObj(x) && isUint(x['fromBlock']) && isUint(x['toBlock']);
}

export function isPayMessageShape(x: unknown): x is PayMessage {
  return (
    isObj(x) &&
    isRange(x['range']) &&
    isLockedSet(x['seederProofs']) &&
    isLockedSet(x['creatorProofs'])
  );
}

export function isPayProtocolMessage(x: unknown): x is PayProtocolMessage {
  if (!isObj(x) || !isStr(x['type'])) return false;
  switch (x['type']) {
    case 'HELLO':
      return (
        isUint(x['version']) &&
        isStr(x['pubkey']) &&
        isStr(x['challenge']) &&
        isStr(x['signature']) &&
        Array.isArray(x['acceptedMints']) &&
        x['acceptedMints'].every(isStr) &&
        isUint(x['satsPerBlock']) &&
        isObj(x['split']) &&
        isUint(x['split']['seeder']) &&
        isUint(x['split']['creator']) &&
        isStr(x['p2pk'])
      );
    case 'PAY':
      return isPayMessageShape(x['payload']);
    case 'ACK':
      return (
        isUint(x['fromBlock']) &&
        isUint(x['toBlock']) &&
        typeof x['ok'] === 'boolean' &&
        (x['reason'] === undefined
          ? !('reason' in x)
          : (REJECT_REASONS as readonly string[]).includes(x['reason'] as string))
      );
    case 'PRICE':
      return isUint(x['satsPerBlock']) && isUint(x['effectiveFromBlock']);
    default:
      return false;
  }
}
