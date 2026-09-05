import type { NostrEvent } from './nostr.js';
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrEventId,
  NostrPubkey,
  Sats,
  Sha256Hex,
  UnixSeconds,
} from './primitives.js';

/**
 * Video manifest = a parsed, verified NIP-71 event (build-plan §2.2).
 *
 * Two identities per rendition (assumption A2):
 *   - Blossom identity: `sha256` of the full file (the `x` in imeta)
 *   - transport identity: Hypercore key + Hyperblobs id
 */

/**
 * Hyperblobs blob id, exactly as returned by `Hyperblobs.put()`:
 * `{ byteOffset, blockOffset, blockLength, byteLength }`. Verify against
 * docs/vendor/hyperblobs.md before assuming field names.
 */
export interface HyperblobId {
  readonly byteOffset: number;
  readonly blockOffset: number;
  readonly blockLength: number;
  readonly byteLength: number;
}

export interface HyperblobRef {
  readonly core: CoreKeyHex;
  readonly blob: HyperblobId;
}

/** Hyperblobs default block size. Assumption A9 CONFIRMED against hyperblobs@2.12.1 README (`blockSize: 64KB`). */
export const DEFAULT_BLOCK_SIZE = 65_536 as const;

/** Default unpaid window in blocks (assumption A4 — refined by spike S-A; threat T3). */
export const DEFAULT_WINDOW_BLOCKS = 4 as const;

export interface Rendition {
  /** Label shown in the player, e.g. "1080p". */
  readonly label: string;
  readonly mime: 'video/mp4' | 'video/webm' | (string & {});
  readonly sha256: Sha256Hex;
  readonly size: number;
  readonly width?: number;
  readonly height?: number;
  readonly bitrateKbps?: number;
  readonly hyper: HyperblobRef;
  /**
   * As written in the imeta `url`:
   * `hyper://<core key, 64-char lower-case hex>/<blockOffset>-<blockLength>[+<byteOffset>]`.
   * `byteLength` is the imeta `size`; `+<byteOffset>` only when non-zero. z32 core keys are
   * NOT accepted (`manifest/hyper-url.ts`, `media/hyper-url.ts`, `mocks/fixtures.ts` agree).
   */
  readonly hyperUrl: string;
  /** Blossom HTTP fallbacks (`fallback` entries), all `https://host/<sha256>`. */
  readonly fallbacks: readonly string[];
  /** Thumbnail as a Blossom URL; its sha256 is verified before display (T16). */
  readonly image?: { readonly url: string; readonly sha256?: Sha256Hex };
  /** Optional tiny inline placeholder (data: URL) for blur-up. */
  readonly placeholder?: string;
  /** WebVTT captions as a Blossom blob. */
  readonly captions?: readonly {
    readonly lang: string;
    readonly url: string;
    readonly sha256?: Sha256Hex;
  }[];
  /** Storyboard sprite for scrub preview. */
  readonly storyboard?: {
    readonly url: string;
    readonly sha256?: Sha256Hex;
    readonly cols: number;
    readonly rows: number;
    readonly intervalSec: number;
  };
}

export interface PricePolicy {
  /** Sats per block (block size from `blockSize`). Integer. */
  readonly satsPerBlock: Sats;
  readonly blockSize: number;
  /** Creator-chosen mint(s). Open question 2: one or several. */
  readonly mints: readonly MintUrl[];
  /** Percentages, must sum to 100. Default 50/50 if the `split` tag is absent. */
  readonly split: { readonly seeder: number; readonly creator: number };
  /** Creator's Cashu P2PK pubkey from their kind 10019. */
  readonly creatorP2pk: CashuP2pkPubkey;
}

export interface VideoManifest {
  readonly id: NostrEventId;
  readonly kind: 21 | 22;
  readonly author: NostrPubkey;
  readonly title: string;
  readonly description: string; // raw content; UI renders via the markdown subset only
  readonly publishedAt: UnixSeconds;
  readonly durationSec?: number;
  readonly tags: readonly string[]; // `t` hashtags
  readonly renditions: readonly Rendition[];
  readonly price: PricePolicy;
  readonly blossomServers: readonly string[];
  /** The verified source event. Signature has been checked before this object exists. */
  readonly event: NostrEvent;
}

/**
 * NIP-71 tag schema as published by this network. A `build` produces exactly these tags;
 * `parse` accepts a superset and ignores unknown tags; `verify` checks the signature and
 * that every rendition carries a `x` hash and a `hyper://` url.
 */
export interface Nip71TagSchema {
  readonly title: ['title', string];
  readonly published_at: ['published_at', string];
  readonly imeta: ['imeta', ...string[]]; // space-separated key/value pairs per NIP-92
  readonly mint: ['mint', string];
  readonly price: ['price', string, 'sat'];
  readonly split: ['split', `seeder:${number}`, `creator:${number}`];
  readonly p2pk: ['p2pk', string];
  readonly t: ['t', string];
  readonly duration: ['duration', string];
  readonly blossom: ['blossom', string];
  readonly alt?: ['alt', string];
}

export type ManifestError =
  | { readonly code: 'bad-signature' }
  | { readonly code: 'wrong-kind'; readonly kind: number }
  | { readonly code: 'missing-tag'; readonly tag: keyof Nip71TagSchema }
  | { readonly code: 'bad-imeta'; readonly index: number; readonly reason: string }
  | { readonly code: 'bad-price'; readonly reason: string }
  | { readonly code: 'bad-split'; readonly reason: string };
