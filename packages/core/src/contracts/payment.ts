import type { LockedProofSet } from './cashu.js';
import type { PricePolicy } from './manifest.js';
import type {
  BlockIndex,
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  Sats,
  UnixSeconds,
} from './primitives.js';

/**
 * PaymentEngine — the audit surface (build-plan §2.3, §3; SECURITY.md invariants 1–6).
 *
 * Two roles share one interface so a gateway, which is both a viewer (upstream) and a
 * seeder (downstream), instantiates it once per side.
 *
 * Real implementation lands in Stage 2 (`core/src/payment/`, locked). Until then every
 * consumer uses `MockPaymentEngine` from `core/src/mocks/`, whose `mode` lets the
 * adversary suite (L10) assert what the real engine must reject.
 */

/**
 * Inclusive block range `[fromBlock, toBlock]` within one core.
 *
 * `core` names that core. A Corestore replication stream carries MANY cores over ONE
 * `pay/1` channel, and `PricePolicy` (mint, split, `creatorP2pk`) is per video — so
 * without `core` the seeder cannot pick the policy to verify against (invariant 2 exact
 * amount, T4 creator set) nor check `range-not-uploaded` / `range-already-paid` per core.
 * v3: optional, so v2-issued code still compiles; the seeder MUST treat a `PAY` without
 * `core` as `malformed` when the stream replicates more than one core. **Becomes required
 * at the Stage 2 bump.** ADR 0004.
 */
export interface BlockRange {
  readonly core?: CoreKeyHex;
  readonly fromBlock: BlockIndex;
  readonly toBlock: BlockIndex;
}

/** What goes on the wire in a `PAY` message. Both sets are P2PK-locked and carry DLEQ. */
export interface PayMessage {
  readonly range: BlockRange;
  readonly seederProofs: LockedProofSet;
  readonly creatorProofs: LockedProofSet;
}

export type RejectReason =
  | 'bad-dleq' // T7: DLEQ failed against cached keyset
  | 'wrong-p2pk-target' // T4/T6: a set is not locked to the expected recipient
  | 'wrong-amount' // invariant 2: under- or overpayment (see `overpay`)
  | 'overpay' // invariant 2: strictly more than owed
  | 'mint-not-accepted' // mint not in the seeder's allowlist for this video
  | 'missing-creator-set' // T4
  | 'missing-seeder-set'
  | 'range-not-uploaded' // paying for blocks this seeder never sent to this peer
  | 'range-already-paid' // replay
  | 'missing-dleq' // proof without DLEQ is not verifiable offline
  | 'malformed'
  | 'peer-banned';

export type VerifyResult =
  | { readonly ok: true; readonly credited: Sats; readonly blocks: number }
  | { readonly ok: false; readonly reason: RejectReason; readonly detail?: string };

/** Per-peer accounting the seeder side maintains (invariant 5). */
export interface PeerWindow {
  readonly peer: NostrPubkey;
  readonly uploaded: number; // blocks sent to this peer
  readonly paid: number; // blocks paid for by this peer
  /** `uploaded − paid`. Past `windowBlocks` the stream is destroyed and the peer banned. */
  readonly outstanding: number;
  readonly windowBlocks: number;
  readonly banned: boolean;
  readonly lastActivity: UnixSeconds;
}

export interface PaymentEngineViewer {
  /**
   * Viewer side. Called after Hypercore has emitted `download` for every block in `range`
   * from `seeder` (invariant 1). Produces both locked sets via `Wallet.send`, updates
   * NIP-60, and returns the message to put on the wire. Never sends more than
   * `blocks × price` (invariant 2).
   */
  pay(
    range: BlockRange,
    seeder: {
      readonly pubkey: NostrPubkey;
      readonly p2pk: CashuP2pkPubkey;
      readonly mint: MintUrl;
    },
    policy: PricePolicy,
  ): Promise<PayMessage>;

  /** Running totals for the wallet chip / peer panel. */
  spent(): { readonly total: Sats; readonly perPeer: ReadonlyMap<NostrPubkey, Sats> };
}

export interface PaymentEngineSeeder {
  /**
   * Seeder side. Fully offline verification BEFORE `ACK` (invariant 4):
   * DLEQ against cached keyset, P2PK targets (own pubkey + creator pubkey), exact amount
   * for `range` under `policy`, mint allowlist, range was actually uploaded to `peer` and
   * not already paid. On success credits the peer's window and queues the proofs for the
   * async swap batch. Never throws for a bad message — returns a `RejectReason`.
   */
  verify(peer: NostrPubkey, msg: PayMessage, policy: PricePolicy): Promise<VerifyResult>;

  /**
   * Record that `blocks` were uploaded to `peer`. MUST be called synchronously from inside
   * Hypercore's `upload` event handler: spike S-A established that `upload` fires BEFORE the
   * block is written to the wire, so a stream destroy in the same tick prevents the block
   * that crosses the window from ever leaving. `onWindowExceeded` callbacks therefore fire
   * synchronously from this call, and the returned window is post-update.
   *
   * `core` (v3, optional; required at the Stage 2 bump) is the core the blocks belong to,
   * so the engine can answer `range-not-uploaded` per core once `BlockRange.core` is on
   * the wire. The window itself (invariant 5) stays per peer, summed over cores.
   */
  recordUpload(peer: NostrPubkey, blocks: number, core?: CoreKeyHex): PeerWindow;

  /**
   * Move the accounting kept under `from` onto `to` and drop `from` (v3, ADR 0004).
   *
   * Hypercore starts serving the moment the replication channel opens; `pay/1`'s `HELLO`
   * — which binds the Nostr pubkey — races it. The transport therefore accounts pre-`HELLO`
   * uploads under a provisional id (the peer's Noise key as hex, same 32-byte shape; it is
   * authenticated by the Noise handshake) and calls `rebind(noiseHex, pubkey)` once `HELLO`
   * verifies. Semantics: `uploaded`/`paid`/paid ranges are SUMMED into `to` (a pubkey that
   * already has a window from another session keeps it); a ban on either side sticks to
   * `to`; `from` is removed. If the merged `outstanding` exceeds the window the engine bans
   * `to` and fires `onWindowExceeded` synchronously, exactly as `recordUpload` would. Returns
   * the post-merge window. Idempotent for an unknown `from` (returns `to`'s window).
   */
  rebind(from: NostrPubkey, to: NostrPubkey): PeerWindow;

  window(peer: NostrPubkey): PeerWindow | undefined;
  windows(): readonly PeerWindow[];

  /**
   * Fires when a peer crosses the window. The transport layer (pay-protocol/seeder)
   * destroys the stream on this signal; the engine bans the pubkey itself.
   */
  onWindowExceeded(cb: (w: PeerWindow) => void): () => void;

  /**
   * Fires when the async swap at the mint reported a spent proof (double-spend, T5).
   * The engine has already banned the peer; this is for logging (redacted) and UI.
   */
  onDoubleSpend(
    cb: (peer: NostrPubkey, detail: { readonly mint: MintUrl; readonly amount: Sats }) => void,
  ): () => void;

  /**
   * Process the swap batch now (normally every N blocks or 60 s). Swaps own proofs into
   * the wallet, publishes creator proofs as kind 9321 nutzaps. Returns what happened.
   */
  flush(): Promise<{ readonly swapped: Sats; readonly nutzapped: Sats; readonly failed: number }>;

  /**
   * Bans are keyed on the Nostr pubkey bound in `HELLO`; the transport layer additionally
   * bans the Noise key (`hyperswarm` `peerInfo.ban(true)`) so the peer cannot reconnect.
   * Both keys are persisted by the seeder (SECURITY.md invariant 6).
   */
  ban(peer: NostrPubkey, reason: string, noiseKey?: Uint8Array): void;
  unban(peer: NostrPubkey): void;
  isBanned(peer: NostrPubkey): boolean;
  bans(): readonly BanEntry[];
}

export interface BanEntry {
  readonly pubkey: NostrPubkey;
  readonly noiseKey?: Uint8Array;
  readonly reason: string;
  readonly at: UnixSeconds;
}

/** Full engine = both sides plus configuration. */
export interface PaymentEngine extends PaymentEngineViewer, PaymentEngineSeeder {
  readonly config: PaymentEngineConfig;
}

export interface PaymentEngineConfig {
  readonly windowBlocks: number;
  /** Mints this node will accept payment at. */
  readonly acceptedMints: readonly MintUrl[];
  /** This node's own P2PK pubkey (seeder side). */
  readonly ownP2pk: CashuP2pkPubkey;
  readonly ownPubkey: NostrPubkey;
  /** Swap batch triggers. */
  readonly flushEveryBlocks: number;
  readonly flushEveryMs: number;
}
