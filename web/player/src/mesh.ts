/**
 * The NFX-10 free browser mesh (M1): p2p-media-loader 4.0.0 on hls.js, one swarm per
 * rendition (NFX-10 §2), signalled through WebTorrent trackers.
 *
 * Every segment, whether it came from a peer or over HTTP, is checked by the same WASM
 * verifier as the rest of the player before hls.js sees it (the library validates before
 * it completes a segment). A peer that sends a bad segment is dropped by the library.
 * Playlists and inits never travel over the mesh: they go through the player's verifying
 * loader.
 */
import type { Anchor } from './verify';

/** At most this many trackers are used. */
export const MAX_TRACKERS = 4;

export interface MeshStats {
  trackers: string[];
  swarms: { rendition: string | null; swarm: string }[];
  bytes: { http: number; p2p: number };
  uploaded: number;
  peers: number;
  rejected: string[];
}

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

/** The `p2p` part of the hls.js config, and the stats it fills in. */
export function meshConfig(
  anchor: Anchor,
  trackers: string[],
  iceServers: RTCIceServer[],
  stats: MeshStats,
  log: (m: string) => void,
  tuning: MeshTuning = {},
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
  stats.trackers = trackers;
  return {
    p2p: {
      core: {
        announceTrackers: trackers,
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
        e.addEventListener('onChunkDownloaded', (n: number, source: string) => {
          if (source === 'p2p' || source === 'http') stats.bytes[source] += n;
        });
        e.addEventListener('onChunkUploaded', (n: number) => {
          stats.uploaded += n;
        });
        e.addEventListener('onPeerConnect', () => {
          stats.peers += 1;
        });
      },
    },
  };
}

interface EngineEvents {
  addEventListener(name: string, handler: (...args: never[]) => void): void;
}
