/**
 * LOCKED until Stage 2 (SECURITY.md §locked). Interface and tests only.
 * Kind 24242 verification for BUD-02/04/09, replay protection, expiry, allow/deny lists.
 */
import type { NostrEvent, NostrPubkey, Sha256Hex } from '@sovit/core';

export type BlossomVerb = 'upload' | 'delete' | 'list' | 'get' | 'mirror' | 'report';

export interface BlossomAuthRequest {
  readonly verb: BlossomVerb;
  /** Raw `Authorization: Nostr <base64 event>` header value. */
  readonly header: string;
  /** sha256 the request is about, when the verb targets a blob. */
  readonly sha256?: Sha256Hex;
  readonly now: number;
}

export type BlossomAuthResult =
  | { readonly ok: true; readonly pubkey: NostrPubkey; readonly event: NostrEvent }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly reason:
        | 'malformed'
        | 'bad-signature'
        | 'wrong-kind'
        | 'expired'
        | 'wrong-verb'
        | 'wrong-hash'
        | 'replayed'
        | 'denied';
    };

export interface BlossomAuth {
  verify(req: BlossomAuthRequest): Promise<BlossomAuthResult>;
  allow(pubkey: NostrPubkey): void;
  deny(pubkey: NostrPubkey): void;
}
