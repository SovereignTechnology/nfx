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
import type { MeshPeer, MeshStats, PeerAddress, Signaling } from './api';
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
  const windows =
    tuning.httpWindow === undefined
      ? {}
      : {
          highDemandTimeWindow: tuning.httpWindow,
          httpDownloadTimeWindow: tuning.httpWindow,
          p2pDownloadTimeWindow: 120,
          simultaneousHttpDownloads: 1,
        };
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
        e.addEventListener('onSegmentLoaded', (d: { downloadSource?: string; peerId?: string }) => {
          if (d.downloadSource === 'p2p' || d.downloadSource === 'http') stats.segments[d.downloadSource] += 1;
          if (d.downloadSource === 'p2p' && d.peerId !== undefined) book.segment(d.peerId);
        });
        // The patched engine hands over the peer's RTCPeerConnection (PeerConnectDetails).
        e.addEventListener('onPeerConnect', (d: { peerId?: string; infoHash?: string; trackerUrl?: string; connection?: unknown }) => {
          stats.peers += 1;
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
