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
 * An origin `open()` may play from, and the renditions it is said to serve (NFX-03 §4).
 * `watchEndpoints` reports them (`Endpoints.originSources`); a page may also write its own.
 */
export interface OriginSource {
  /** `http(s)://host[:port][/prefix]`, as `OpenCommon.origins` takes a bare string. */
  url: string;
  /**
   * **A hint, never a constraint** (it was a constraint until nfx #85): the ids of the
   * renditions whose `init` and `segment` files it is said to serve (the hash list's
   * `renditions[].id`), as its `https` endpoint's `renditions` claim them. Beacons come from
   * any key, so `open()` uses this only to order: an origin whose hint names an allowed
   * rendition is tried before one whose hint does not, and the renditions it names are asked
   * for first. It never skips an origin, and never adds or removes a level: which levels a
   * session offers is what the origin itself answers for (`OpenCommon`). Absent: no claim
   * (every rendition). Empty: a claim of none, so the origin is tried after the others.
   * Ids the hash list does not name are ignored. At most 32.
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
   * `originSources` is the same list with what beacons claim each origin serves; give
   * `open()` either (it asks each origin what it holds).
   */
  origins: string[];
  /**
   * `origins` again, in the same order, each with the renditions beacons claim it serves,
   * as `open()`'s `origins` takes them. When several seeders name one origin, the claim is
   * only what every one of them says it serves. That is a hint (`OriginSource.renditions`):
   * since nfx #85 `open()` asks the origin itself which renditions it holds, so a beacon
   * from any key, narrowing or lying, can change the order in which origins are tried but
   * can neither make `open()` skip an origin that serves the allowed renditions nor make
   * it offer a level the origin does not serve.
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
  /** Segment bytes as they arrived, by where from: the origin over HTTP, or peers. */
  bytes: { http: number; p2p: number };
  /** Segment bytes sent to peers. */
  uploaded: number;
  /** Every peer connection made since the session started (never goes down: `connected` does). */
  peers: number;
  /** `<http|p2p>:<url>` of each segment a validator refused. */
  rejected: string[];
  /** Peer connections open now, across the session's swarms. */
  connected: number;
  /** Segments loaded whole, by where from. */
  segments: { http: number; p2p: number };
  /**
   * Each peer this session has exchanged a connection or bytes with (`MeshPeer`): open
   * connections first, then most bytes. At most 64; a peer that closed is the first to go.
   */
  peerList: MeshPeer[];
  /** The Nostr kind's signaling counters, and how many of its relay sockets are open; null for trackers. */
  signal: { open: number; sent: number; received: number; offers: number; answers: number } | null;
}

/**
 * One mesh peer, as the engine knows it. Its id and `via` come from the network (a peer or
 * a tracker chose them): show them as text only.
 */
export interface MeshPeer {
  /**
   * The engine's id for it: for the Nostr kind, the peer's session key (64 hex, fresh each
   * session, never a user's key); for trackers, its WebTorrent peer id (nfxd's bridge uses
   * the prefix `-NX0100-`, which anyone can copy). Non-printable characters become `?`; at
   * most 64 characters.
   */
  id: string;
  /** Where it was found: the tracker's URL, or `nostr:` and the relays. At most 256 characters. */
  via: string;
  /** Segment bytes received from it, as they arrived. */
  down: number;
  /** Segment bytes sent to it. */
  up: number;
  /** Segments it delivered whole. */
  segments: number;
  /** Whether a connection to it is open now. */
  connected: boolean;
  /** When it last connected, and when bytes last moved either way (ms since the epoch; 0: never). */
  since: number;
  last: number;
}

/**
 * Where an open mesh peer's connection goes, by the browser's own statistics of its selected
 * ICE candidate pair (`Session.addresses()`). One per peer: a peer connected in several swarms
 * (renditions) is reported by its first open connection.
 *
 * **These are other viewers' IP addresses.** A page shows them only when its user asks,
 * and never logs, stores or sends them.
 */
export interface PeerAddress {
  /** `MeshPeer.id`. */
  id: string;
  /**
   * The remote candidate's address as the browser reports it: an IP address, an mDNS
   * `.local` name (a browser on the same network hiding its LAN address), or `''` when the
   * browser does not reveal it (some report none for a peer-reflexive candidate).
   */
  address: string;
  port: number | null;
  /** The remote and local candidate types: `host`, `srflx`, `prflx` or `relay`; `''` unknown. */
  remoteType: string;
  localType: string;
  /** `udp` or `tcp`; `''` unknown. */
  protocol: string;
  /**
   * `relayed` when either candidate is a TURN relay, `direct` when a pair is selected and
   * neither is, `unknown` when none is selected yet.
   */
  path: 'direct' | 'relayed' | 'unknown';
  /** The pair's current round-trip time in milliseconds, when the browser has measured it. */
  rttMs: number | null;
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
   * refuses kind 25050 unless its NIP-11 `nfx.kinds` lists it: name general relays, and
   * such scoped relays beside them.
   */
  relays: string[];
  /**
   * Which of a peer's ICE candidates this session's ICE agent may try (`RemoteCandidates`).
   * Default `all`.
   */
  remoteCandidates?: RemoteCandidates;
}

/**
 * Which candidates of a peer's SDP (its offer or answer) reach `setRemoteDescription`.
 *
 * - `all` (the default): every candidate, as the peer wrote it.
 * - `global`: only UDP candidates at global unicast IP addresses, at most 16 per SDP (the
 *   first, in SDP order), for a page that must not let a stranger's SDP point its ICE
 *   agent's connectivity checks at the user's LAN, loopback, router or a cloud metadata
 *   address (a desktop renderer: nutflix-pear ADR 0023 rule 5). Dropped: private, shared
 *   (CGNAT), loopback, link-local, documentation, benchmarking, multicast and reserved
 *   IPv4; IPv6 outside 2000::/3 and in 2001:db8::/32; mDNS (`.local`) and other names; TCP;
 *   and any candidate line not in the strict form `filterRemoteSdp` reads. Every other line
 *   (`a=end-of-candidates` included) is kept as it is. An SDP left with no candidate is still
 *   applied, and that connection fails; the session goes on fetching from its origin.
 *   A browser peer behind a NAT is still reached through its server-reflexive candidate,
 *   and one on the same LAN, which offers only mDNS host candidates, is not.
 */
export type RemoteCandidates = 'all' | 'global';

/** What `onEvent` hears. Nothing is delivered after `destroy()`. */
export type PlayerEvent =
  | { type: 'log'; message: string }
  /**
   * An origin served a hash list that verified and answered for at least one allowed
   * rendition, and is used (`ok`); or it was not (`why`: no hash list that verifies, or no
   * allowed rendition's init answered, with each rendition's answer).
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
 * **Which levels a session offers** (NFX-10 §1, NFX-03 §5; nfx #85). The session takes
 * every file from one origin. `open()` tries `origins` in order, except that an origin
 * whose `OriginSource.renditions` hint names none of the allowed renditions is tried after
 * the others. On each, once its hash list has verified, it **asks the origin** which of
 * the allowed renditions (`renditions`, or every rendition of the hash list; at most 32,
 * those the hint names first) it holds: for each, it fetches the rendition's media
 * playlist, verifies it, and sends a `GET` for the init it names (NFX-05 §3), reading at
 * most 64 KiB of the answer. These run in parallel, 6 at a time, and all of one origin's
 * together get 8 s. A rendition is held when its init answers `200` (or `206`); anything
 * else, or no answer in time, and it is not. The first origin that holds at least one
 * allowed rendition is used (one that holds none, or whose hash list does not verify, is
 * skipped, with an `origin` event saying why), and the session's levels are the allowed
 * renditions it holds. So the cost is a playlist and an init per allowed rendition per
 * session, both of which hls.js would fetch anyway for the level it plays (they are
 * immutable, so the HTTP cache usually answers the second time).
 *
 * Beacon claims never remove an origin or a level: a beacon from any key can only change
 * the order above. And a level is never offered whose segments no source can deliver: the
 * mesh never adds a level, since a segment peers do not deliver in time comes over HTTP
 * from that origin, so a rendition it does not hold would only fail. hls.js is told of no
 * other level: the master playlist it reads is cut to those renditions' variants, matched
 * by playlist content name (NFX-10 §2), and a level outside them stops the session with an
 * `error` event before any segment is fetched.
 */
export interface OpenCommon {
  /**
   * Origin bases (NFX-05 §6) to try in order (above): `http(s)://host[:port][/prefix]`, no
   * query, fragment or credentials. A bare string makes no claim; an `OriginSource` names
   * the renditions it is said to serve, as a hint (`Endpoints.originSources` are such).
   * Either way `open()` asks the origin what it holds.
   */
  origins: (string | OriginSource)[];
  /**
   * The renditions the session may play, by id (the hash list's `renditions[].id`), in the
   * caller's order of preference: 1 to 32 distinct ids, each one the hash list has.
   * Default: every rendition. `open()` refuses an empty or malformed list with a
   * `TypeError` before it fetches anything, and an id the hash list lacks with a
   * `RangeError` once the hash list has verified, leaving nothing running either way.
   * Levels are cut to these (and to what the origin answers that it holds, above); hls.js's
   * ABR then picks freely among them, starting on the first of them the origin holds unless
   * `level` says otherwise. Only these are asked for, so naming one rendition costs one
   * probe.
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
   * session's levels (`Session.levels`, after `renditions` and the origin's answers have
   * cut them, in hls.js's order), not into the master playlist. It turns ABR off and
   * overrides the start `renditions` would give; past the last level it is ignored.
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
  /**
   * Bytes of the files the player's own loader took from `origin` and verified: playlists
   * and inits, and segments too when there is no mesh. With a mesh, segments come through
   * it: those fetched over HTTP are `mesh.bytes.http`.
   */
  originBytes: number;
  /** hls.js's bandwidth estimate, in bits per second (its default until it has measured). */
  bandwidthEstimate: number;
}

/** One video playing in one element. */
export interface Session {
  /**
   * The session's levels (`OpenCommon`: only renditions allowed and held by its origin, by
   * its own answers), once hls.js has parsed the master playlist (empty before).
   */
  readonly levels: Level[];
  /** Play `index` from now on, or -1 to let hls.js pick. */
  setLevel(index: number): void;
  stats(): Stats;
  /**
   * Where each open mesh peer's connection goes (`PeerAddress`, one per peer), read from the
   * browser's `getStats()` when called, and only then. Empty without a mesh, or once destroyed.
   * At most 64. These are other viewers' IP addresses: call it only when the user asks to see
   * them.
   */
  addresses(): Promise<PeerAddress[]>;
  /**
   * Stop everything this session started: hls.js and its worker, the p2p loader, its
   * tracker or relay sockets and peer connections, and the element's media source.
   * Idempotent.
   */
  destroy(): void;
}
