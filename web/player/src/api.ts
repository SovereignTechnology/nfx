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
 * An origin `open()` may play from, and the renditions it serves (NFX-03 §4).
 * `watchEndpoints` reports them (`Endpoints.originSources`); a page may also write its own.
 */
export interface OriginSource {
  /** `http(s)://host[:port][/prefix]`, as `OpenCommon.origins` takes a bare string. */
  url: string;
  /**
   * The ids of the renditions whose `init` and `segment` files it serves (the hash list's
   * `renditions[].id`): its `https` endpoint's `renditions`. Absent: every rendition. Empty:
   * none, so `open()` skips it. Ids the hash list does not name are ignored. At most 32.
   */
  renditions?: string[];
}

/**
 * Who holds which renditions of one video, by seeders' live beacons (NFX-03 §5): each
 * seeder, counted by its key, by its newest unexpired beacon only, at most 64 of them (as
 * `Endpoints`). A seeder holds the renditions its `iroh` endpoints have a ticket for, and
 * those its `webrtc` and `https` endpoints name in `renditions`; such an endpoint without
 * `renditions` holds every rendition. Only these three endpoint types count, whether or not
 * this page can reach them: it is a hint about where the swarm is, for ranking. Which
 * levels a session offers is `open()`'s rule (`OpenCommon.renditions`).
 *
 * Keys are cheap, so a count is a hint, never proof of how many hosts hold the bytes.
 */
export interface RenditionAvailability {
  /** How many seeders hold at least one rendition (or every one). */
  seeders: number;
  /** Of those, how many hold every rendition: a rendition no seeder names has this many. */
  all: number;
  /**
   * Each rendition id some seeder names, with how many seeders hold it (the `all` ones
   * included), most-held first, ties in the order first heard. At most 32 ids of at most 64
   * characters each (a seeder's first 32 count), never `meta` (NFX-03 §4). An id here may
   * be one the video's hash list does not have: beacons come from any key.
   */
  renditions: { id: string; seeders: number }[];
}

/**
 * What seeders' live beacons (NFX-03, kind 20464) name for one video: the newest unexpired
 * beacon of each seeder counts, and nothing else. Endpoints are hints, never trust: every
 * byte is still checked against the signed anchor.
 */
export interface Endpoints {
  /**
   * `https://host[:port][/prefix]` origin bases (NFX-05 §6), at most 8, most-named first.
   * Give `open()` `originSources` instead: a bare URL is taken to serve every rendition, so
   * a session could offer a level that origin answers with `404`.
   */
  origins: string[];
  /**
   * `origins` again, in the same order, each with the renditions it serves, as `open()`'s
   * `origins` takes them. When several seeders name one origin, it serves only what every
   * one of them says it does: a beacon can narrow what an origin is taken to serve, never
   * widen it, so the worst a lying beacon does is have `open()` skip that origin, rather
   * than offer a level whose segments it answers with `404`.
   */
  originSources: OriginSource[];
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
  /** Which renditions those seeders hold, and how many hold each. */
  availability: RenditionAvailability;
}

/** One rendition as hls.js parsed it from the master playlist. */
export interface Level {
  /** What `setLevel()` takes. */
  index: number;
  /**
   * The rendition id (the hash list's `renditions[].id`), by the content name of the
   * level's playlist (NFX-10 §2), never by its bitrate or size.
   */
  id: string;
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
  /**
   * An origin served a hash list that verified and is used (`ok`), or was not (`why`: no
   * hash list that verifies, or none of the allowed renditions held).
   */
  | { type: 'origin'; origin: string; ok: boolean; why?: string }
  | { type: 'verified'; sha256: string; url: string }
  | ({ type: 'rejected' } & Rejection)
  | { type: 'levels'; levels: Level[] }
  | { type: 'playing' }
  /** A fatal hls.js error (playback has stopped), or a refused `play()`. */
  | { type: 'error'; message: string };

/**
 * What `open()` plays, from where, and how.
 *
 * **Which levels a session offers** (NFX-10 §1, NFX-03 §5). The session takes every file
 * from one origin: the first of `origins`, in order, that serves a hash list that verifies
 * and holds at least one allowed rendition (an origin that cannot is skipped, with an
 * `origin` event saying why). The session's levels are then the allowed renditions
 * (`renditions`, or every rendition of the hash list) that this origin serves (its
 * `OriginSource.renditions`, or every one). The mesh never adds a level: a segment peers do
 * not deliver in time comes over HTTP from that origin, so a rendition it does not serve
 * would only fail. hls.js is told of no other level: the master playlist it reads is cut to
 * those renditions' variants, matched by playlist content name (NFX-10 §2), and a level
 * outside them stops the session with an `error` event before any segment is fetched.
 */
export interface OpenCommon {
  /**
   * Origin bases (NFX-05 §6) to try in order (above): `http(s)://host[:port][/prefix]`, no
   * query, fragment or credentials. A bare string serves every rendition; an
   * `OriginSource` names those it serves (`Endpoints.originSources` are such).
   */
  origins: (string | OriginSource)[];
  /**
   * The renditions the session may play, by id (the hash list's `renditions[].id`), in the
   * caller's order of preference: 1 to 32 distinct ids, each one the hash list has.
   * Default: every rendition. `open()` refuses an empty or malformed list with a
   * `TypeError` before it fetches anything, and an id the hash list lacks with a
   * `RangeError` once the hash list has verified, leaving nothing running either way.
   * Levels are cut to these (and to what the origin serves, above); hls.js's ABR then picks
   * freely among them, starting on the first of them the origin serves unless `level` says
   * otherwise.
   */
  renditions?: string[];
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
  /**
   * Pin this level once the master playlist is parsed (test knob): an index into the
   * session's levels (`Session.levels`, after `renditions` and the origin have cut them, in
   * hls.js's order), not into the master playlist. It turns ABR off and overrides the start
   * `renditions` would give; past the last level it is ignored.
   */
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
  /**
   * The session's levels (`OpenCommon`: only renditions allowed and served by its origin),
   * once hls.js has parsed the master playlist (empty before).
   */
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
