import type { CashuP2pkPubkey, MintUrl } from './primitives.js';

/**
 * Cashu wire shapes as they appear inside `pay/1` messages and NIP-60 events.
 *
 * Shape-compatible with `@cashu/cashu-ts` `Proof` / `SerializedDLEQ` / `MintKeys`
 * (checked against 4.10.0 `lib/types/index.d.ts`), with `amount` as a plain integer
 * because these types describe JSON on the wire, not the library's `Amount` class.
 * Conversion to/from cashu-ts types happens only inside `wallet/spend.ts` and `payment/`.
 */

export interface SerializedDleq {
  readonly s: string;
  readonly e: string;
  readonly r?: string;
}

export interface CashuProof {
  /** Keyset id. */
  readonly id: string;
  /** Integer amount in the keyset's unit (sat). */
  readonly amount: number;
  /** For P2PK proofs this is the NUT-10/11 well-known secret JSON string. */
  readonly secret: string;
  /** Unblinded signature. */
  readonly C: string;
  /** NUT-12. REQUIRED on every proof carried by `pay/1` (threat T7). */
  readonly dleq?: SerializedDleq;
  readonly witness?: string;
}

/** A set of proofs, all from one mint and one unit, locked to one recipient. */
export interface LockedProofSet {
  readonly mint: MintUrl;
  readonly unit: 'sat';
  /** The P2PK pubkey every proof in `proofs` is locked to. */
  readonly lockedTo: CashuP2pkPubkey;
  readonly proofs: readonly CashuProof[];
}

/** Cached keyset used for offline DLEQ verification (threat T7). */
export interface MintKeyset {
  readonly mint: MintUrl;
  readonly id: string;
  readonly unit: string;
  readonly active: boolean;
  /** amount → compressed pubkey hex. */
  readonly keys: Readonly<Record<string, string>>;
  readonly inputFeePpk?: number;
  readonly fetchedAt: number;
}

export interface MintQuote {
  readonly mint: MintUrl;
  readonly quoteId: string;
  readonly amount: number;
  readonly bolt11: string;
  readonly expiry: number;
  readonly state: 'UNPAID' | 'PAID' | 'ISSUED';
}

export interface MeltQuote {
  readonly mint: MintUrl;
  readonly quoteId: string;
  readonly amount: number;
  readonly feeReserve: number;
  readonly expiry: number;
  readonly state: 'UNPAID' | 'PENDING' | 'PAID';
}
