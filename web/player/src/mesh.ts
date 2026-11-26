/**
 * The NFX-10 free browser mesh (M1): p2p-media-loader 4.0.0 on hls.js, one swarm per
 * rendition (NFX-10 §2). How peers find each other is a `Signaling` (./api.ts), turned into
 * the engine's configuration in one place, `engineSignaling` below: WebTorrent trackers,
 * whose sockets the engine opens itself, or Nostr (NFX-10 §6, ./signal-nostr.ts), whose
 * client the engine takes through `signalingClientFactory`, the hook web/player/engine adds
 * to p2p-media-loader-core.
 *
 * Every segment, whether it came from a peer or over HTTP, is checked by the same WASM
 * verifier as the rest of the player before hls.js sees it (the library validates before
 * it completes a segment). A peer that sends a bad segment is dropped by the library.
 * Playlists and inits never travel over the mesh: they go through the player's verifying
 * loader.
 */
import type { MeshPeer, MeshStats, PeerAddress, SegmentSource, Signaling } from './api';
import type { NostrSignaler } from './signal-nostr';
import type { Anchor } from './verify';

export type { MeshStats };

/** At most this many trackers are used. */
export const MAX_TRACKERS = 4;
/** At most this many relays carry a session's Nostr signaling. */
export const MAX_RELAYS = 8;

/**
 * A tracker URL this page may use, reduced to scheme, host, port and path: `wss:`, or
 * `ws:` on a loopback host (tests). No credentials, query or fragment. `null` otherwise.
 */
export function trackerUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'wss:' || (u.protocol === 'ws:' && loopback))) return null;
  if (u.username || u.password) return null;
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
}

/**
 * A relay URL a session may signal through (NFX-10 §6), reduced to scheme, host, port and
 * path: `wss:`, or `ws:` on a loopback host (tests). No credentials, query or fragment.
 * `null` otherwise.
 */
export function relayUrl(raw: string): string | null {
  return trackerUrl(raw);
}

/**
 * The engine's configuration for `signaling`: the one place a kind is wired in. The Nostr
 * kind needs the session's signaler, which makes one client per stream swarm.
 */
function engineSignaling(
  signaling: Signaling,
  nostr: NostrSignaler | undefined,
): { announceTrackers: string[]; signalingClientFactory?: NostrSignaler['factory'] } {
  switch (signaling.kind) {
    case 'trackers':
      return { announceTrackers: [...signaling.urls] };
    case 'nostr':
      if (nostr === undefined) throw new TypeError('nfx: nostr signaling needs its signaler');
      return { announceTrackers: [], signalingClientFactory: nostr.factory };
    default: {
      // A kind added to `Signaling` and not wired here fails the typecheck.
      const unknown: never = signaling;
      throw new TypeError(`nfx: signaling of kind ${String((unknown as { kind: unknown }).kind)} is not in this build`);
    }
  }
}

/** A unique swarm ID for a stream that maps to no rendition: it meets no one. */
function nowhere(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `nfx/1/web/unmapped/${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Where bytes come from; never whether they are checked. */
export interface MeshTuning {
  /** Seconds ahead of the playhead fetched over HTTP; the rest may come from peers. */
  httpWindow?: number;
  /** Where segments come from (`SegmentSource`); `https-first` when absent. */
  segmentSource?: SegmentSource;
  /** How long peers get before HTTPS steps in (`OpenCommon.peerWaitMs`). */
  peerWaitMs?: number;
  /** A segment came over HTTPS although peers come first. */
  onRescue?: (url: string) => void;
}

/** `OpenCommon.peerWaitMs`'s default and bound. */
export const PEER_WAIT_MS = 4000;
export const MAX_PEER_WAIT_MS = 30_000;
/**
 * With peers first, how far ahead of the playhead segments are fetched from them, in
 * seconds. nfxd serves a connection 60 requests at once and 20 a second after that
 * (`rtc_serve.rs`): at NFX-05's 2 s segments this is 15 requests, then one every 2 s.
 */
export const PEER_AHEAD_SECONDS = 30;
/**
 * With peers first, the most the engine keeps of fetched segments, in MiB (its default is 4096).
 * Set only when a session opens in a peer mode: the engine reads it once, when its storage starts,
 * so `setSegmentSource` cannot change it later.
 */
export const PEER_STORAGE_MIB = 512;

const SEGMENT_SOURCES: readonly SegmentSource[] = ['peers-then-https', 'peers-only', 'https-first'];

/**
 * `open()`'s `segmentSource` and `peerWaitMs`, checked (`OpenCommon` has the rules): a
 * `TypeError` for a value outside them, for `peers-only` with no mesh to take segments
 * from, and for `httpWindow` beside a source it does not apply to.
 */
export function checkSegmentSource(
  options: { segmentSource?: unknown; peerWaitMs?: unknown; httpWindow?: unknown },
  mesh: boolean,
): { segmentSource: SegmentSource; peerWaitMs: number } {
  const raw = options.segmentSource;
  if (raw !== undefined && !SEGMENT_SOURCES.includes(raw as SegmentSource)) {
    throw new TypeError(`nfx: segmentSource must be one of ${SEGMENT_SOURCES.join(', ')}`);
  }
  const segmentSource = (raw as SegmentSource | undefined) ?? 'https-first';
  const wait = options.peerWaitMs;
  if (wait !== undefined && !(typeof wait === 'number' && Number.isSafeInteger(wait) && wait >= 0 && wait <= MAX_PEER_WAIT_MS)) {
    throw new TypeError(`nfx: peerWaitMs must be 0 to ${MAX_PEER_WAIT_MS} milliseconds`);
  }
  if (segmentSource === 'peers-only' && !mesh) throw new TypeError('nfx: segmentSource peers-only needs signaling');
  if (segmentSource !== 'https-first' && options.httpWindow !== undefined) {
    throw new TypeError('nfx: httpWindow is only for segmentSource https-first');
  }
  return { segmentSource, peerWaitMs: (wait as number | undefined) ?? PEER_WAIT_MS };
}

/**
 * The engine's settings for a segment source, all of them ones it takes while it runs (so
 * `Session.setSegmentSource` applies the same object).
 *
 * Peers first is the engine patch's `segmentPolicy`: nothing over HTTP in the background,
 * and only a bounded stretch ahead of the playhead from peers; the engine reads its HTTP
 * window only to know how far its queue reaches, so it equals the peer window. HTTPS first
 * is the engine's published defaults, or the `httpWindow` test knob's.
 */
export function segmentWindows(source: SegmentSource, tuning: Pick<MeshTuning, 'httpWindow' | 'peerWaitMs'> = {}): Record<string, string | number> {
  if (source !== 'https-first') {
    return {
      segmentPolicy: source === 'peers-only' ? 'peer-only' : 'peer-first',
      peerWaitMs: tuning.peerWaitMs ?? PEER_WAIT_MS,
      highDemandTimeWindow: 15,
      httpDownloadTimeWindow: PEER_AHEAD_SECONDS,
      p2pDownloadTimeWindow: PEER_AHEAD_SECONDS,
      simultaneousHttpDownloads: 1,
    };
  }
  return tuning.httpWindow === undefined
    ? { segmentPolicy: 'http-first', highDemandTimeWindow: 15, httpDownloadTimeWindow: 3000, p2pDownloadTimeWindow: 6000, simultaneousHttpDownloads: 2 }
    : {
        segmentPolicy: 'http-first',
        highDemandTimeWindow: tuning.httpWindow,
        httpDownloadTimeWindow: tuning.httpWindow,
        p2pDownloadTimeWindow: 120,
        simultaneousHttpDownloads: 1,
      };
}

/**
 * Whether playing is what was last asked of a media element: `autoplay` until someone says
 * otherwise, then its last `play` (asked) or `pause` (not asked), and not asked once a
 * `play()` was refused (the browser wants a gesture first). A session reports that it is
 * waiting for a peer only while this holds: an element left paused waits for no one.
 */
export class PlayIntent {
  #wanted: boolean;

  constructor(autoplay: boolean) {
    this.#wanted = autoplay;
  }

  /** The element's `play` event: someone, or `autoplay`, asked it to play. */
  played(): void {
    this.#wanted = true;
  }

  /** Its `pause` event (a stall for want of data fires `waiting`, never `pause`). */
  paused(): void {
    this.#wanted = false;
  }

  /** A `play()` the browser refused. */
  refused(): void {
    this.#wanted = false;
  }

  get wanted(): boolean {
    return this.#wanted;
  }
}

/** What `probeWebRtc` found. */
export interface WebRtcProbe {
  /** At least one UDP candidate was gathered: a peer can be reached. */
  ok: boolean;
  /** UDP candidates gathered. */
  udp: number;
  /** In words, for a log line or a notice. */
  why: string;
}

/** What `probeWebRtc` needs of the browser: `RTCPeerConnection`, or a stand-in in tests. */
export type ProbeConnection = new (config: { iceServers: RTCIceServer[] }) => {
  createDataChannel(label: string): unknown;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(d: { type?: string; sdp?: string }): Promise<void>;
  addEventListener(name: 'icecandidate', cb: (e: { candidate: { candidate?: string; protocol?: string | null } | null }) => void): void;
  close(): void;
};

/**
 * Whether this browser's WebRTC can reach a peer: one throwaway connection gathers its ICE
 * candidates (asking `iceServers`, the STUN servers the mesh would ask anyway), and the
 * UDP ones are counted. None means no mesh peer can connect: the browser has WebRTC off, or
 * allows it only through a proxy (its "WebRTC IP handling policy", a hardened build's
 * default, or an extension). It never throws, opens no connection to a peer, and ends by
 * `timeoutMs` at the latest, or as soon as `signal` aborts (with what it had found by then).
 */
export async function probeWebRtc(
  iceServers: RTCIceServer[],
  timeoutMs = 3000,
  Connection: ProbeConnection | undefined = (globalThis as { RTCPeerConnection?: ProbeConnection }).RTCPeerConnection,
  signal?: AbortSignal,
): Promise<WebRtcProbe> {
  if (typeof Connection !== 'function') return { ok: false, udp: 0, why: 'this browser has no RTCPeerConnection' };
  let pc: InstanceType<ProbeConnection>;
  try {
    pc = new Connection({ iceServers });
  } catch (e) {
    return { ok: false, udp: 0, why: `RTCPeerConnection refused: ${e instanceof Error ? e.message : String(e)}` };
  }
  let udp = 0;
  let other = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  let ended = false;
  try {
    const gathered = new Promise<void>((resolve) => {
      const end = (): void => {
        ended = true;
        resolve();
      };
      stop = end;
      if (signal?.aborted) end();
      else signal?.addEventListener('abort', end, { once: true });
      pc.addEventListener('icecandidate', (e) => {
        const c = e.candidate;
        // The end of gathering: null, or (older engines) an empty candidate.
        if (c === null || c.candidate === '' || c.candidate === undefined) {
          end();
          return;
        }
        const protocol = typeof c.protocol === 'string' ? c.protocol : (c.candidate.split(' ')[2] ?? '');
        if (protocol.toLowerCase() === 'udp') udp += 1;
        else other += 1;
      });
      timer = setTimeout(end, timeoutMs);
    });
    // Starting is bounded like gathering: an offer or a local description that never settles
    // ends at the time limit, or the abort, with the connection closed below.
    const failure: { why: string | null } = { why: null };
    const started = (async (): Promise<void> => {
      pc.createDataChannel('nfx-probe');
      const offer = await pc.createOffer();
      // An offer that arrives after the time limit or the abort is dropped: the connection
      // is closed by then, and nothing more is asked of it.
      if (ended) return;
      await pc.setLocalDescription(offer);
    })().catch((e: unknown) => {
      if (!ended) failure.why = `WebRTC failed to start: ${e instanceof Error ? e.message : String(e)}`;
    });
    await Promise.race([started, gathered]);
    if (failure.why !== null) return { ok: false, udp, why: failure.why };
    await gathered;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (stop !== undefined) signal?.removeEventListener('abort', stop);
    try {
      pc.close();
    } catch {
      // nothing to close
    }
  }
  if (udp > 0) return { ok: true, udp, why: `${udp} UDP candidate${udp === 1 ? '' : 's'}` };
  return {
    ok: false,
    udp: 0,
    why:
      other > 0
        ? `WebRTC gathered no UDP candidate (${other} other): it is kept to a proxy or to TCP in this browser`
        : 'WebRTC gathered no network candidate: it is switched off or kept to a proxy in this browser',
  };
}

/** At most this many peers are listed (`MeshStats.peerList`) or asked for addresses. */
export const MAX_PEERS_LISTED = 64;
/** At most this many peers are remembered; past it, the one longest idle (closed first) goes. */
const MAX_PEERS_KEPT = 256;
const MAX_ID = 64;
/** A peer is keyed by its id as the engine has it (cut to this, to bound memory), never by its shown form. */
const MAX_KEY = 256;
const MAX_VIA = 256;
const MAX_ADDRESS = 64;

/** A peer- or tracker-chosen string, made safe to show: printable ASCII only, cut to `max`. */
export function printable(raw: unknown, max: number): string {
  const s = typeof raw === 'string' ? raw : '';
  let out = '';
  for (const ch of s) {
    if (out.length >= max) break;
    const c = ch.codePointAt(0) ?? 0;
    out += c >= 0x20 && c < 0x7f ? ch : '?';
  }
  return out;
}

/** What `PeerBook` needs of a peer connection: its statistics, and whether it is closed. */
export interface StatsConnection {
  readonly connectionState?: string;
  getStats(): Promise<{ forEach(cb: (s: Record<string, unknown>) => void): void }>;
}

interface PeerEntry {
  /** The engine's id, cut to `MAX_KEY`: what the map is keyed by. */
  key: string;
  /** What is shown: `key` made printable and cut to `MAX_ID`. */
  id: string;
  via: string;
  down: number;
  up: number;
  segments: number;
  since: number;
  last: number;
  /** The open connections to it, one per stream swarm (by infohash). */
  connections: Map<string, StatsConnection>;
}

/**
 * Per-peer counters, from the engine's events, and the peers' connections for
 * `addresses()`. Bounded: ids, `via` and the number of peers kept.
 */
export class PeerBook {
  readonly #peers = new Map<string, PeerEntry>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The engine's id as a map key: distinct ids stay distinct even when they print the same. */
  static #key(rawId: unknown): string {
    return (typeof rawId === 'string' ? rawId : '').slice(0, MAX_KEY);
  }

  #entry(rawId: unknown): PeerEntry {
    const key = PeerBook.#key(rawId);
    let e = this.#peers.get(key);
    if (e === undefined) {
      e = { key, id: printable(key, MAX_ID), via: '', down: 0, up: 0, segments: 0, since: 0, last: 0, connections: new Map() };
      this.#peers.set(key, e);
      if (this.#peers.size > MAX_PEERS_KEPT) this.#evict(e);
    }
    return e;
  }

  /** Drop the peer longest idle, closed ones before open ones, never `keep`. */
  #evict(keep: PeerEntry): void {
    let worst: PeerEntry | undefined;
    for (const e of this.#peers.values()) {
      if (e === keep) continue;
      if (worst === undefined) worst = e;
      else {
        const open = this.#open(e) > 0;
        const worstOpen = this.#open(worst) > 0;
        if ((!open && worstOpen) || (open === worstOpen && e.last < worst.last)) worst = e;
      }
    }
    if (worst !== undefined) this.#peers.delete(worst.key);
  }

  #open(e: PeerEntry): number {
    for (const [k, c] of e.connections) if (c.connectionState === 'closed' || c.connectionState === 'failed') e.connections.delete(k);
    return e.connections.size;
  }

  connect(d: { peerId?: unknown; infoHash?: unknown; trackerUrl?: unknown; connection?: unknown }): void {
    const e = this.#entry(d.peerId);
    e.via = printable(d.trackerUrl, MAX_VIA);
    e.since = this.#now();
    e.last = e.since;
    const c = d.connection as StatsConnection | undefined;
    if (c !== undefined && c !== null && typeof c.getStats === 'function') e.connections.set(String(d.infoHash), c);
  }

  close(d: { peerId?: unknown; infoHash?: unknown }): void {
    const e = this.#peers.get(PeerBook.#key(d.peerId));
    e?.connections.delete(String(d.infoHash));
  }

  received(peerId: unknown, n: number): void {
    const e = this.#entry(peerId);
    e.down += n;
    e.last = this.#now();
  }

  sent(peerId: unknown, n: number): void {
    const e = this.#entry(peerId);
    e.up += n;
    e.last = this.#now();
  }

  segment(peerId: unknown): void {
    this.#entry(peerId).segments += 1;
  }

  /** Open connections, across peers and swarms. */
  connected(): number {
    let n = 0;
    for (const e of this.#peers.values()) n += this.#open(e);
    return n;
  }

  /** The entries `list()` shows, in its order. */
  #ranked(): { e: PeerEntry; open: boolean }[] {
    return [...this.#peers.values()]
      .map((e) => ({ e, open: this.#open(e) > 0 }))
      .sort((a, b) => Number(b.open) - Number(a.open) || b.e.down + b.e.up - (a.e.down + a.e.up))
      .slice(0, MAX_PEERS_LISTED);
  }

  /** `MeshStats.peerList`: open first, then most bytes; at most `MAX_PEERS_LISTED`. */
  list(): MeshPeer[] {
    return this.#ranked().map(({ e, open }) => ({
      id: e.id,
      via: e.via,
      down: e.down,
      up: e.up,
      segments: e.segments,
      connected: open,
      since: e.since,
      last: e.last,
    }));
  }

  /** Forget every connection (the session ended): counters stay, connections are dropped. */
  release(): void {
    for (const e of this.#peers.values()) e.connections.clear();
  }

  /** `Session.addresses()`: each open peer's first connection, asked now. */
  async addresses(): Promise<PeerAddress[]> {
    const open = this.#ranked().filter((r) => r.open);
    const out = await Promise.all(
      open.map(async ({ e }) => {
        const c = e.connections.values().next().value;
        if (c === undefined) return null;
        try {
          return { id: e.id, ...selectedPair(await c.getStats()) };
        } catch {
          return { id: e.id, ...UNKNOWN_PAIR };
        }
      }),
    );
    return out.filter((a): a is PeerAddress => a !== null);
  }
}

const UNKNOWN_PAIR: Omit<PeerAddress, 'id'> = {
  address: '',
  port: null,
  remoteType: '',
  localType: '',
  protocol: '',
  path: 'unknown',
  rttMs: null,
};
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const PROTOCOLS = new Set(['udp', 'tcp']);

/**
 * The selected candidate pair in an `RTCStatsReport`: the transport's
 * `selectedCandidatePairId` (Chromium), else a pair marked `selected` (Firefox), else a
 * nominated pair that succeeded. Everything read is checked and bounded: the address is the
 * browser's, but it names a peer.
 */
export function selectedPair(report: { forEach(cb: (s: Record<string, unknown>) => void): void }): Omit<PeerAddress, 'id'> {
  const byId = new Map<string, Record<string, unknown>>();
  report.forEach((s) => {
    if (typeof s.id === 'string') byId.set(s.id, s);
  });
  let pair: Record<string, unknown> | undefined;
  for (const s of byId.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = byId.get(s.selectedCandidatePairId);
  }
  if (pair === undefined) {
    for (const s of byId.values()) {
      if (s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded'))) {
        pair = s;
        break;
      }
    }
  }
  if (pair === undefined) return { ...UNKNOWN_PAIR };
  const remote = typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : undefined;
  const local = typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined;
  const kind = (c: Record<string, unknown> | undefined): string =>
    typeof c?.candidateType === 'string' && CANDIDATE_TYPES.has(c.candidateType) ? c.candidateType : '';
  const remoteType = kind(remote);
  const localType = kind(local);
  const port = remote?.port;
  const protocol = remote?.protocol;
  const rtt = pair.currentRoundTripTime;
  return {
    // `ip` is the older name of `address`.
    address: printable(remote?.address ?? remote?.ip, MAX_ADDRESS),
    port: typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null,
    remoteType,
    localType,
    protocol: typeof protocol === 'string' && PROTOCOLS.has(protocol) ? protocol : '',
    path: remoteType === 'relay' || localType === 'relay' ? 'relayed' : 'direct',
    rttMs: typeof rtt === 'number' && Number.isFinite(rtt) && rtt >= 0 ? Math.round(rtt * 1000) : null,
  };
}

/** The `p2p` part of the hls.js config, and the stats it fills in. */
export function meshConfig(
  anchor: Anchor,
  signaling: Signaling,
  iceServers: RTCIceServer[],
  stats: MeshStats,
  log: (m: string) => void,
  tuning: MeshTuning = {},
  nostr?: NostrSignaler,
  book: PeerBook = new PeerBook(),
) {
  const source: SegmentSource = tuning.segmentSource ?? 'https-first';
  // HTTPS first with no test knob leaves the engine exactly as published. With peers first
  // the engine also keeps less (its limit is fixed when it is made).
  const windows =
    source === 'https-first'
      ? tuning.httpWindow === undefined
        ? {}
        : segmentWindows(source, tuning)
      : { ...segmentWindows(source, tuning), segmentMemoryStorageLimit: PEER_STORAGE_MIB };
  const startedAt = performance.now();
  const since = (): number => Math.round(performance.now() - startedAt);
  // Whether each HTTP download under way began as a rescue: the source can change while it
  // runs (`Session.setSegmentSource`), and what it was when the download began is what counts.
  const httpBeganAsRescue = new Map<string, boolean>();
  const segmentKey = (d: { segment?: { runtimeId?: unknown; url?: unknown } }): string =>
    typeof d.segment?.runtimeId === 'string' ? d.segment.runtimeId : typeof d.segment?.url === 'string' ? d.segment.url : '';
  const check = (source: 'http' | 'p2p') =>
    async (url: string, byteRange: unknown, data: ArrayBuffer): Promise<boolean> => {
      // NFX files are whole content-addressed files; a byte range is never a valid request.
      if (byteRange !== undefined) {
        stats.rejected.push(`${source}:byte-range:${url}`);
        return false;
      }
      try {
        anchor.check(url, data);
        return true;
      } catch (e) {
        stats.rejected.push(`${source}:${url}`);
        log(`mesh: rejected ${source} bytes for ${url}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    };
  stats.signaling = signaling.kind;
  stats.source = source;
  stats.trackers = signaling.kind === 'trackers' ? [...signaling.urls] : [];
  stats.relays = signaling.kind === 'nostr' ? [...signaling.relays] : [];
  return {
    p2p: {
      core: {
        ...engineSignaling(signaling, nostr),
        rtcConfig: { iceServers },
        ...windows,
        streamSwarmIdBuilder: ({ runtimeId }: { runtimeId: string }) => {
          const swarm = anchor.streamSwarmId(runtimeId);
          stats.swarms.push({ rendition: swarm ? swarm.slice(swarm.lastIndexOf('/') + 1) : null, swarm: swarm ?? 'none' });
          return swarm ?? nowhere();
        },
        validateP2PSegment: check('p2p'),
        validateHTTPSegment: check('http'),
      },
      onHlsJsCreated(hls: { p2pEngine: EngineEvents }) {
        const e = hls.p2pEngine;
        e.addEventListener('onChunkDownloaded', (n: number, source: string, peerId?: string) => {
          if (source === 'p2p' || source === 'http') stats.bytes[source] += n;
          if (source === 'p2p' && peerId !== undefined) book.received(peerId, n);
        });
        e.addEventListener('onChunkUploaded', (n: number, peerId?: string) => {
          stats.uploaded += n;
          if (peerId !== undefined) book.sent(peerId, n);
        });
        e.addEventListener('onSegmentStart', (d: { downloadSource?: string; segment?: { runtimeId?: unknown; url?: unknown } }) => {
          if (d.downloadSource !== 'http') return;
          // Bounded: a download that neither loads, fails nor aborts would otherwise stay.
          if (httpBeganAsRescue.size >= 256) httpBeganAsRescue.clear();
          httpBeganAsRescue.set(segmentKey(d), stats.source === 'peers-then-https');
        });
        const forget = (d: { downloadSource?: string; segment?: { runtimeId?: unknown; url?: unknown } }): void => {
          if (d.downloadSource === 'http') httpBeganAsRescue.delete(segmentKey(d));
        };
        e.addEventListener('onSegmentError', forget);
        e.addEventListener('onSegmentAbort', forget);
        e.addEventListener('onSegmentLoaded', (d: { downloadSource?: string; peerId?: string; segment?: { runtimeId?: unknown; url?: unknown } }) => {
          if (d.downloadSource === 'p2p' || d.downloadSource === 'http') {
            stats.segments[d.downloadSource] += 1;
            stats.startup.segmentMs ??= since();
          }
          if (d.downloadSource === 'p2p') stats.startup.peerSegmentMs ??= since();
          if (d.downloadSource === 'p2p' && d.peerId !== undefined) book.segment(d.peerId);
          // This one came over HTTP, and peers came first when its download began: a rescue.
          if (d.downloadSource === 'http') {
            const key = segmentKey(d);
            const rescue = httpBeganAsRescue.get(key) ?? stats.source === 'peers-then-https';
            httpBeganAsRescue.delete(key);
            if (rescue) {
              stats.rescues += 1;
              tuning.onRescue?.(typeof d.segment?.url === 'string' ? d.segment.url : '');
            }
          }
        });
        // The patched engine hands over the peer's RTCPeerConnection (PeerConnectDetails).
        e.addEventListener('onPeerConnect', (d: { peerId?: string; infoHash?: string; trackerUrl?: string; connection?: unknown }) => {
          stats.peers += 1;
          stats.startup.peerMs ??= since();
          book.connect(d);
        });
        e.addEventListener('onPeerClose', (d: { peerId?: string; infoHash?: string }) => {
          book.close(d);
        });
      },
    },
  };
}

interface EngineEvents {
  addEventListener(name: string, handler: (...args: never[]) => void): void;
}
