import type { NostrEventId, NostrPubkey, RelayUrl, UnixSeconds } from './primitives.js';

/**
 * Nostr wire types. Shape-compatible with `nostr-tools` `Event`/`UnsignedEvent`/`Filter`
 * so implementations can pass them straight through; duplicated here so the contracts
 * package has no runtime dependency.
 */

/** A tag is a non-empty string array; index 0 is the tag name. Enforced at parse time. */
export type NostrTag = readonly string[];

export interface UnsignedNostrEvent {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: readonly NostrTag[];
  readonly content: string;
  readonly pubkey: NostrPubkey;
}

export interface NostrEvent extends UnsignedNostrEvent {
  readonly id: NostrEventId;
  readonly sig: string;
}

/** Subset of NIP-01 filter fields the data layer needs. */
export interface NostrFilter {
  readonly ids?: readonly string[];
  readonly authors?: readonly NostrPubkey[];
  readonly kinds?: readonly number[];
  readonly since?: UnixSeconds;
  readonly until?: UnixSeconds;
  readonly limit?: number;
  readonly search?: string; // NIP-50
  readonly [tag: `#${string}`]: readonly string[] | undefined;
}

/**
 * Event kinds used by the network. Single source of truth; do not scatter literals.
 * See build-plan §2.2.
 */
export const NostrKind = {
  Profile: 0,
  Follows: 3,
  Reaction: 7,
  Video: 21, // NIP-71 normal
  ShortVideo: 22, // NIP-71 short
  Comment: 1111, // NIP-22
  Report: 1984, // NIP-56
  NutzapPayout: 9321, // NIP-61
  WalletToken: 7375, // NIP-60
  WalletHistory: 7376, // NIP-60
  RelayList: 10002, // NIP-65
  NutzapInfo: 10019, // NIP-61
  BlossomServerList: 10063, // BUD-03
  WalletInfo: 17375, // NIP-60
  BlossomAuth: 24242, // BUD-01
  ChannelSet: 30000, // NIP-51 follow set used as "subscriptions"
  VideoSet: 30005, // NIP-51 playlist
} as const;
export type NostrKind = (typeof NostrKind)[keyof typeof NostrKind];

/** Resolved kind-0 profile with NIP-05 verification state. */
export interface Profile {
  readonly pubkey: NostrPubkey;
  readonly name?: string;
  readonly displayName?: string;
  readonly about?: string;
  readonly picture?: string;
  readonly banner?: string;
  readonly nip05?: string;
  /** `verified` only after a live NIP-05 lookup succeeded for this pubkey. */
  readonly nip05Status: 'none' | 'unverified' | 'verified' | 'failed';
  readonly lud16?: string;
  readonly fetchedAt: UnixSeconds;
}

/** Relay pool the data layer talks to. Read/write split so the UI can show it. */
export interface RelayConfig {
  readonly url: RelayUrl;
  readonly read: boolean;
  readonly write: boolean;
}
