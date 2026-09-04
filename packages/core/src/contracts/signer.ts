import type { NostrEvent, UnsignedNostrEvent } from './nostr.js';
import type { NostrPubkey } from './primitives.js';

/**
 * Signer — the only thing in the system that touches a Nostr private key.
 *
 * Implementations (Stage 2, `core/src/signer/`, locked):
 *   - local encrypted key (argon2id via sodium, secure memory, zeroised on lock)
 *   - NIP-46 remote signer
 *   - NIP-07 browser extension adapter
 *
 * Nothing else in the codebase may hold an nsec. Not the wallet, not the UI, not a log.
 */
export interface Signer {
  readonly kind: 'local' | 'nip46' | 'nip07';

  getPublicKey(): Promise<NostrPubkey>;

  /** Fills `id` and `sig`. `pubkey` on the input must match `getPublicKey()`. */
  signEvent(
    event: Omit<UnsignedNostrEvent, 'pubkey'> & { pubkey?: NostrPubkey },
  ): Promise<NostrEvent>;

  nip44Encrypt(peerPubkey: NostrPubkey, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: NostrPubkey, ciphertext: string): Promise<string>;

  /**
   * Optional NIP-60 P2PK helper (build-plan §3, "NIP-60 P2PK key").
   *
   * When present, the signer holds the wallet's dedicated P2PK private key and produces
   * the NUT-11 witness signature itself, so the key never enters page memory. When absent
   * the wallet falls back to `nip44Decrypt` of the kind-17375 `privkey` entry and the UI
   * MUST tell the user which mode they are in.
   */
  readonly signSecret?: (secret: string) => Promise<string>;

  /** Lock: zeroise any key material held in memory. Idempotent. */
  lock(): Promise<void>;
  isLocked(): boolean;
}

/** Capability report for the settings/wallet screens. Never exposes key material. */
export interface SignerStatus {
  readonly kind: Signer['kind'];
  readonly pubkey: NostrPubkey | null;
  readonly locked: boolean;
  readonly supportsSignSecret: boolean;
  /** For NIP-46: relay + remote pubkey; for NIP-07: extension name if detectable. */
  readonly detail?: string;
}
