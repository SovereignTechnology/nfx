import type { CashuProof, LockedProofSet, MeltQuote, MintKeyset, MintQuote } from './cashu.js';
import type { CashuP2pkPubkey, MintUrl, NostrEventId, Sats, UnixSeconds } from './primitives.js';

/**
 * Wallet — NIP-60 ecash wallet, thin over `@cashu/cashu-ts`.
 *
 * Surface = mint quote, P2PK send, receive/swap, melt, history (build-plan §3, §4).
 * No Lightning code. No custody. No proof-management UI.
 *
 * Read-only parts (`balance`, `history`, `mints`) are unlocked. `spend.ts` (locked until
 * Stage 2) implements `send` / `receive` / `melt`.
 *
 * Persistence: desktop = NIP-60 events on relays + local encrypted cache; web = NIP-60
 * events on relays, proofs decrypted into memory only, nothing in IndexedDB/localStorage.
 */
export interface Wallet {
  /** Mints the user currently holds a balance at or has configured. */
  mints(): Promise<readonly MintUrl[]>;

  balance(mint: MintUrl): Promise<Sats>;
  balances(): Promise<ReadonlyMap<MintUrl, Sats>>;

  /** The wallet's dedicated NIP-60 P2PK pubkey (from kind 17375), used as the nutzap target. */
  p2pkPubkey(): Promise<CashuP2pkPubkey>;

  /** NUT-04: request a bolt11 to top up `amount` at `mint`. */
  mintQuote(mint: MintUrl, amount: Sats): Promise<MintQuote>;
  /** Polls the quote; on PAID mints the proofs and writes kind 7375 / 7376. */
  pollQuote(quote: MintQuote): Promise<{ state: MintQuote['state']; minted?: Sats }>;

  /**
   * NUT-11 P2PK send. Produces proofs locked to `p2pk`, with DLEQ included, and updates
   * NIP-60 state (7375 with `del`, 7376 history) BEFORE returning. The caller (payment
   * engine) then puts the set on the wire. Fails if balance at `mint` is insufficient.
   */
  send(
    amount: Sats,
    opts: { readonly p2pk: CashuP2pkPubkey; readonly mint: MintUrl },
  ): Promise<LockedProofSet>;

  /** Receive proofs (NUT-03 swap into fresh, unlocked proofs) and record 7375/7376. */
  receive(
    set: LockedProofSet | { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] },
  ): Promise<Sats>;

  /** NUT-05: melt out to a Lightning invoice. */
  meltQuote(mint: MintUrl, bolt11: string): Promise<MeltQuote>;
  melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }>;

  /** Cached keyset for offline DLEQ verification; fetches on miss. */
  keyset(mint: MintUrl, keysetId: string): Promise<MintKeyset>;

  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]>;

  /** Subscribe to balance changes for the header chip. Returns unsubscribe. */
  onChange(cb: (e: WalletChangeEvent) => void): () => void;
}

export interface WalletHistoryEntry {
  readonly id: NostrEventId; // kind 7376 event id
  readonly direction: 'in' | 'out';
  readonly amount: Sats;
  readonly mint: MintUrl;
  readonly at: UnixSeconds;
  /** Free text: "streamed 12 blocks of <video>", "top-up", "melt-out", "nutzap from …". */
  readonly memo?: string;
  /** Event ids of the 7375 token events created/destroyed (NIP-60 `e` tags). */
  readonly created: readonly NostrEventId[];
  readonly destroyed: readonly NostrEventId[];
}

export type WalletChangeEvent =
  | { readonly type: 'balance'; readonly mint: MintUrl; readonly balance: Sats }
  | { readonly type: 'quote'; readonly quote: MintQuote }
  | { readonly type: 'history'; readonly entry: WalletHistoryEntry };
