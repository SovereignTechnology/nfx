import type { VideoManifest, PricePolicy } from './manifest.js';
import type { NostrEvent, Profile, RelayConfig } from './nostr.js';
import type { PeerWindow } from './payment.js';
import type {
  MintUrl,
  NostrEventId,
  NostrPubkey,
  Sats,
  Sha256Hex,
  UnixSeconds,
} from './primitives.js';
import type { SignerStatus } from './signer.js';
import type { Wallet } from './wallet.js';

/**
 * NetworkAdapter — everything the UI is allowed to call (assumption A11, build-plan §2.1).
 *
 * `@sovit/ui` imports nothing else from core at runtime. Two implementations:
 *   - app-desktop: over worker IPC (preload exposes exactly these methods)
 *   - app-web: over WebSocket to a gateway + in-page Hypercore (or MSE fallback per S-B)
 * plus `MockNetworkAdapter` (fixture videos, fake sats) for screens and Storybook.
 *
 * Every method that returns Nostr-derived data returns it already signature-verified.
 */

export type Unsubscribe = () => void;

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor; `undefined` = no more. */
  readonly next?: string;
}

export interface FeedQuery {
  readonly source: 'subscriptions' | 'trending' | 'tags' | 'author' | 'shorts';
  readonly tags?: readonly string[];
  readonly author?: NostrPubkey;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Comment {
  readonly id: NostrEventId;
  readonly author: NostrPubkey;
  readonly content: string; // raw; rendered by the markdown subset only
  readonly createdAt: UnixSeconds;
  readonly parent?: NostrEventId;
  readonly reactions: number;
  readonly event: NostrEvent;
}

export interface VideoStats {
  /** Unique paying pubkeys from kind 9321 — labelled "paid views" in the UI. */
  readonly paidViews: number;
  readonly satsToCreator: Sats;
  readonly reactions: number;
  readonly comments: number;
  /** Seeders currently announcing this core (from swarm / 10019). */
  readonly seedersOnline: number;
}

/**
 * Core has no DOM lib (it runs on Bare too), so browser objects are typed structurally.
 * Shells narrow these to the real `File` / `Blob` / `MediaSource`.
 */
export interface BlobLike {
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface FileLike extends BlobLike {
  readonly name: string;
  readonly lastModified: number;
}
/** Marker for a DOM `MediaSource`; the web shell owns the real type. */
export interface MediaSourceLike {
  readonly readyState: 'closed' | 'open' | 'ended';
}

/**
 * Spike S-B PASSED: Hypercore 11 + Hyperblobs run in-page over a WebSocket Duplex with an
 * in-memory `hypercore-storage` backend, so the web shell's primary source is
 * `service-worker` (SW answers `<video>` range requests from the in-page core). `mediasource`
 * is the A8 fallback (gateway-served sha256 segments + MSE) and stays available.
 */
export type PlaySource =
  | { readonly kind: 'url'; readonly url: string } // desktop: hypercore-blob-server localhost range URL
  | { readonly kind: 'service-worker'; readonly url: string } // web: SW-served range URL from in-page core
  | { readonly kind: 'mediasource'; readonly mediaSource: MediaSourceLike }; // web fallback: MSE

export interface PlaySession {
  readonly videoId: NostrEventId;
  readonly rendition: string;
  readonly source: PlaySource;
  readonly policy: PricePolicy;
  /** Live per-seeder spend for the peer panel. */
  onPeers(cb: (peers: readonly PeerSpend[]) => void): Unsubscribe;
  /** Live totals for the header chip: sats/min while playing. */
  onSpend(cb: (s: { readonly total: Sats; readonly ratePerMin: Sats }) => void): Unsubscribe;
  /** Prefetch depth in seconds (build-plan §6.2 "buffer = money"). */
  setPrefetchSeconds(sec: number): void;
  /** Pause = stop paying. Must be honoured by the transport, not just the element. */
  pause(): void;
  resume(): void;
  /** Switch rendition at a keyframe; the UI shows the price difference first. */
  switchRendition(label: string): Promise<PlaySession>;
  close(): Promise<void>;
}

export interface PeerSpend {
  readonly pubkey: NostrPubkey;
  readonly sats: Sats;
  readonly ratePerMin: Sats;
  readonly blocks: number;
  readonly latencyMs?: number;
}

export interface UploadInput {
  /** Desktop: absolute path. Web: a File (gateway transcodes after BUD-02 upload). */
  readonly file: string | FileLike;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly kind: 21 | 22;
  readonly mints: readonly MintUrl[];
  readonly satsPerBlock: Sats;
  readonly split: { readonly seeder: number; readonly creator: number };
  readonly thumbnailChoice?: number | BlobLike;
  readonly mirrorTo?: readonly string[]; // Blossom servers for BUD-02 mirror
}

export type UploadProgress =
  | { readonly stage: 'probing' }
  | { readonly stage: 'transcoding'; readonly rendition: string; readonly percent: number }
  | { readonly stage: 'thumbnails'; readonly candidates: readonly string[] }
  | { readonly stage: 'writing'; readonly rendition: string; readonly percent: number }
  | { readonly stage: 'publishing' }
  | { readonly stage: 'mirroring'; readonly server: string; readonly ok: boolean }
  | { readonly stage: 'done'; readonly video: VideoManifest }
  | { readonly stage: 'error'; readonly message: string };

export interface SeederStatus {
  readonly enabled: boolean;
  readonly pubkey: NostrPubkey;
  readonly videos: number;
  readonly bytesStored: number;
  readonly diskCapBytes: number;
  readonly peers: readonly PeerWindow[];
  readonly earned: {
    readonly total: Sats;
    readonly unswapped: Sats;
    readonly byMint: ReadonlyMap<MintUrl, Sats>;
  };
  readonly banned: readonly {
    readonly pubkey: NostrPubkey;
    readonly reason: string;
    readonly at: UnixSeconds;
  }[];
}

export interface Settings {
  readonly relays: readonly RelayConfig[];
  readonly defaultMints: readonly MintUrl[];
  readonly seeding: { readonly enabled: boolean; readonly diskCapBytes: number };
  readonly prefetchSeconds: number;
  readonly hoverPreview: boolean;
  readonly theme: 'dark' | 'light' | 'system';
  readonly autoTopUp?: { readonly belowSats: Sats; readonly fromMint: MintUrl };
}

export interface NetworkAdapter {
  /** Which shell we are in. The UI uses this only for capability copy, never for logic. */
  readonly platform: 'desktop' | 'web' | 'mock';

  // ---- identity ------------------------------------------------------------------
  signer(): Promise<SignerStatus>;
  me(): Promise<NostrPubkey | null>;
  profile(pubkey: NostrPubkey): Promise<Profile | null>;

  // ---- catalog -------------------------------------------------------------------
  feed(q: FeedQuery): Promise<Page<VideoManifest>>;
  video(id: NostrEventId): Promise<VideoManifest | null>;
  stats(id: NostrEventId): Promise<VideoStats>;
  related(id: NostrEventId, limit?: number): Promise<readonly VideoManifest[]>;
  search(q: {
    readonly text: string;
    readonly cursor?: string;
    readonly filters?: SearchFilters;
  }): Promise<Page<VideoManifest>>;

  // ---- social --------------------------------------------------------------------
  comments(videoId: NostrEventId, sort: 'new' | 'top', cursor?: string): Promise<Page<Comment>>;
  comment(videoId: NostrEventId, content: string, parent?: NostrEventId): Promise<Comment>;
  /** NIP-25 reaction content: `+` (like), `-` (dislike) or an emoji. */
  react(videoId: NostrEventId, reaction: string): Promise<void>;
  nutzap(videoId: NostrEventId, amount: Sats, mint: MintUrl, comment?: string): Promise<void>;
  subscribe(channel: NostrPubkey): Promise<void>;
  unsubscribe(channel: NostrPubkey): Promise<void>;
  subscriptions(): Promise<readonly NostrPubkey[]>;
  report(videoId: NostrEventId, reason: string): Promise<void>;

  // ---- library (NIP-51; private sets are encrypted) ------------------------------
  library: {
    history(cursor?: string): Promise<
      Page<{
        readonly video: VideoManifest;
        readonly positionSec: number;
        readonly at: UnixSeconds;
      }>
    >;
    recordProgress(videoId: NostrEventId, positionSec: number): Promise<void>;
    watchLater(): Promise<readonly VideoManifest[]>;
    setWatchLater(videoId: NostrEventId, on: boolean): Promise<void>;
    playlists(author?: NostrPubkey): Promise<readonly Playlist[]>;
    savePlaylist(p: Omit<Playlist, 'id' | 'author'> & { readonly id?: string }): Promise<Playlist>;
    liked(): Promise<readonly VideoManifest[]>;
  };

  // ---- playback ------------------------------------------------------------------
  play(videoId: NostrEventId, rendition?: string): Promise<PlaySession>;
  /** Verifies the Blossom `x` hash before handing back a displayable URL (T16). */
  image(url: string, sha256?: Sha256Hex): Promise<string>;

  // ---- money ---------------------------------------------------------------------
  readonly wallet: Wallet;

  // ---- studio --------------------------------------------------------------------
  studio: {
    upload(input: UploadInput, onProgress: (p: UploadProgress) => void): Promise<VideoManifest>;
    myVideos(cursor?: string): Promise<Page<VideoManifest>>;
    analytics(
      videoId: NostrEventId,
    ): Promise<VideoStats & { readonly satsByRendition: ReadonlyMap<string, Sats> }>;
  };

  // ---- seeder --------------------------------------------------------------------
  seeder: {
    status(): Promise<SeederStatus>;
    setEnabled(on: boolean): Promise<void>;
    melt(mint: MintUrl, bolt11: string): Promise<{ paid: boolean }>;
    unban(pubkey: NostrPubkey): Promise<void>;
    onStatus(cb: (s: SeederStatus) => void): Unsubscribe;
  };

  // ---- settings ------------------------------------------------------------------
  settings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  // ---- live ----------------------------------------------------------------------
  /** New videos from followed channels + replies to my comments, while open. */
  notifications(cb: (n: Notification) => void): Unsubscribe;
}

export interface SearchFilters {
  readonly since?: UnixSeconds;
  readonly until?: UnixSeconds;
  readonly minDurationSec?: number;
  readonly maxDurationSec?: number;
  readonly tags?: readonly string[];
  readonly author?: NostrPubkey;
}

export interface Playlist {
  readonly id: string; // NIP-51 `d` tag
  readonly author: NostrPubkey;
  readonly title: string;
  readonly description?: string;
  readonly videoIds: readonly NostrEventId[];
  readonly isPrivate: boolean;
}

export type Notification =
  | { readonly type: 'new-video'; readonly video: VideoManifest }
  | { readonly type: 'reply'; readonly comment: Comment; readonly videoId: NostrEventId }
  | { readonly type: 'nutzap-received'; readonly amount: Sats; readonly videoId?: NostrEventId };
