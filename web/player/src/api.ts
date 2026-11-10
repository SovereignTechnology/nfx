/**
 * The public types of the NFX web player library (`./lib.ts`). This file imports nothing,
 * so the declaration file built from it (`api.d.ts` in the library tarball) stands alone.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** `init()`'s options. */
export interface InitOptions {
  /**
   * Where `nfx_wasm_bg.wasm` is served. Default: `./wasm/nfx_wasm_bg.wasm` next to the
   * library's own script. A page that serves it elsewhere passes its URL here, once,
   * before anything else.
   */
  wasmUrl?: string | URL;
}

/** The current revision of a signed manifest (NFX-02 §4), verified in WASM. */
export interface ResolvedManifest {
  /** The event id (the NFX-02 §4 tie-break). */
  id: string;
  /** The manifest address, `38504:<creator>:<namespace>:<video-id>`. */
  a: string;
  author: string;
  created_at: number;
  /** `<namespace>:<video-id>`. */
  video: string;
  namespace: string;
  title: string;
  /** The hash list's sha256 (NFX-05 §2): the anchor every byte is checked against. */
  root: string;
  segs: number;
  /** The signed kind-38504 event as a relay sent it: what `open({ manifestJson })` takes. */
  event: string;
}

/** `resolveManifest()`'s options. */
export interface ResolveOptions {
  /** How long each relay gets to answer, in milliseconds. Default 8000. */
  timeoutMs?: number;
}

/**
 * What seeders' live beacons (NFX-03, kind 20464) name for one video: the newest unexpired
 * beacon of each seeder counts, and nothing else. Endpoints are hints, never trust: every
 * byte is still checked against the signed anchor.
 */
export interface Endpoints {
  /** `https://host[:port][/prefix]` origin bases (NFX-05 §6), at most 8, most-named first. */
  origins: string[];
  /** `wss://` trackers from `webrtc` endpoints (NFX-10 §2), at most 4, most-named first. */
  trackers: string[];
  /**
   * `stun:<ip>:<port>` URLs from `stun` endpoints (NFX-10 §1), global unicast addresses
   * only, at most 4, most-named first: for `iceServers`, after the page's own. Such a
   * server learns each viewer's address, and beacons come from any key.
   */
  stunServers: string[];
  /** How many seeders' beacons these come from. */
  seeders: number;
}

/** One rendition as hls.js parsed it from the master playlist. */
export interface Level {
  /** What `setLevel()` takes. */
  index: number;
  width: number;
  height: number;
  bitrate: number;
}

/** A file the player refused: its bytes did not match the hash list, or it is not on it. */
export interface Rejection {
  /** The sha256 the hash list names for that URL, or null if it names none. */
  sha256: string | null;
  url: string;
  why: string;
}

/** The NFX-10 browser mesh's counters. */
export interface MeshStats {
  /** The signaling kind in use. */
  signaling: Signaling['kind'];
  /** Its trackers, for the `trackers` kind. */
  trackers: string[];
  /** Its relays, for the `nostr` kind. */
  relays: string[];
  swarms: { rendition: string | null; swarm: string }[];
  bytes: { http: number; p2p: number };
  uploaded: number;
  peers: number;
  /** `<http|p2p>:<url>` of each segment a validator refused. */
  rejected: string[];
}

/**
 * How the viewers of a swarm find each other and exchange WebRTC offers, answers and ICE
 * candidates (NFX-10 §1): peer discovery plus the exchange, kept apart from playback.
 *
 * Two kinds: WebTorrent trackers, and Nostr (NFX-10 §6), which needs no tracker at all.
 * `open()` refuses a kind it does not implement.
 */
export type Signaling = TrackerSignaling | NostrSignaling;

/** Signaling through WebTorrent trackers (NFX-10 §1), which relay SDP only, never segments. */
export interface TrackerSignaling {
  kind: 'trackers';
  /** `wss://`, or `ws://` on a loopback host; 1 to 4. */
  urls: string[];
}

/**
 * Signaling over Nostr (NFX-10 §6): ephemeral kind-25050 events through ordinary relays,
 * with no tracker. Each session has a fresh random key, never a user's, and signs every
 * event when it sends it; offers and answers are NIP-44 encrypted to their receiver, so
 * relays see room and session keys and timing, not the SDP. Peers still see each other's
 * IP addresses once they connect, as with trackers.
 */
export interface NostrSignaling {
  kind: 'nostr';
  /**
   * `wss://`, or `ws://` on a loopback host; 1 to 8. Every event goes to all of them,
   * and each event is taken once whichever relays deliver it. A scoped relay (NFX-04)
   * refuses kind 25050: name general relays.
   */
  relays: string[];
}

/** What `onEvent` hears. Nothing is delivered after `destroy()`. */
export type PlayerEvent =
  | { type: 'log'; message: string }
  /** An origin served a hash list that verified (`ok`), or did not (`why`). */
  | { type: 'origin'; origin: string; ok: boolean; why?: string }
  | { type: 'verified'; sha256: string; url: string }
  | ({ type: 'rejected' } & Rejection)
  | { type: 'levels'; levels: Level[] }
  | { type: 'playing' }
  /** A fatal hls.js error (playback has stopped), or a refused `play()`. */
  | { type: 'error'; message: string };

/** What `open()` plays, from where, and how. */
export interface OpenCommon {
  /**
   * Origin bases (NFX-05 §6) to try in order: the first that serves a hash list that
   * verifies against the anchor is used. `http(s)://host[:port][/prefix]`, no query,
   * fragment or credentials.
   */
  origins: string[];
  /**
   * How mesh peers find each other (`Signaling`). None (the default) means no mesh:
   * every byte comes from the origin. With it, the viewer also uploads verified segments
   * to other viewers, and the signaling service and those peers see the viewer's IP
   * address.
   */
  signaling?: Signaling;
  /**
   * STUN servers for the mesh (`stun:` or `stuns:` URLs only), at most 4. Default none.
   * A page may take them from beacons (`stun` endpoints, NFX-10 §1) as well as its own.
   */
  iceServers?: RTCIceServer[];
  onEvent?: (event: PlayerEvent) => void;
  /** Aborting it cancels `open()`, or destroys the session once open. */
  signal?: AbortSignal;
  /** Start playing once the master playlist is parsed. Default true. */
  autoplay?: boolean;
  /** Pin this level once the master playlist is parsed (test knob). */
  level?: number;
  /** Seconds ahead of the playhead fetched over HTTP; the rest may come from peers (test knob). */
  httpWindow?: number;
}

/**
 * `open()`'s options. Either a signed manifest event, which the library verifies again
 * (NFX-02) and takes `root`, `video` and `segs` from, or a bare `root` (64 hex), with
 * optionally the manifest's `video` and `segs` to bind the hash list to.
 */
export type OpenOptions = OpenCommon &
  (
    | { manifestJson: string; root?: never; video?: never; segs?: never }
    | { manifestJson?: never; root: string; video?: string; segs?: number }
  );

/** A snapshot of one session. */
export interface Stats {
  /** `hls.js <v>`, with `+ p2p-media-loader <v>` when the mesh is on. */
  engine: string;
  origin: string;
  root: string;
  /** The video the hash list names. */
  video: string;
  /** Files checked and accepted by the player's loader (playlists, inits, HTTP segments). */
  verified: number;
  rejected: Rejection[];
  levels: Level[];
  /** The level playing, or -1 while hls.js picks. */
  level: number;
  playing: boolean;
  mesh: MeshStats | null;
}

/** One video playing in one element. */
export interface Session {
  /** The renditions, once hls.js has parsed the master playlist (empty before). */
  readonly levels: Level[];
  /** Play `index` from now on, or -1 to let hls.js pick. */
  setLevel(index: number): void;
  stats(): Stats;
  /**
   * Stop everything this session started: hls.js and its worker, the p2p loader, its
   * tracker or relay sockets and peer connections, and the element's media source.
   * Idempotent.
   */
  destroy(): void;
}
