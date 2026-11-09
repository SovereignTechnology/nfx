/**
 * The NFX web player as a library. A page (the test player, ./player.ts, or another
 * client) calls, in order:
 *
 * - `init({ wasmUrl })`: load nfx-proto's WASM verifier once;
 * - `resolveManifest(a, relays)`: the current signed manifest of a video (NFX-02), over
 *   Nostr, with deletions applied (NFX-02 §6);
 * - `watchEndpoints(a, namespace, relays, onChange)`: origins and trackers named by
 *   seeders' live beacons (NFX-03), validated and capped;
 * - `open(videoElement, options)`: verify the manifest again, fetch the hash list from the
 *   first origin whose copy verifies, and play with hls.js behind a loader that checks
 *   every playlist, init and segment against it before hls.js sees a byte. With a
 *   `signaling` (today WebTorrent trackers), the NFX-10 browser mesh (p2p-media-loader)
 *   joins in, its segments checked the same way. `destroy()` stops all of it.
 *
 * Nothing here reads the page's URL or DOM beyond the element it is given, and nothing
 * here keeps state between sessions but the loaded WASM module.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Hls, {
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';

import { verifyManifest } from '../out/wasm/nfx_wasm.js';
import type {
  Endpoints,
  InitOptions,
  Level,
  MeshStats,
  OpenOptions,
  PlayerEvent,
  Rejection,
  ResolveOptions,
  ResolvedManifest,
  Session,
  Signaling,
  Stats,
} from './api';
import {
  MAX_ICE_SERVERS as ENDPOINTS_MAX_ICE_SERVERS,
  checkIceServers,
  checkOrigins,
  checkSignaling,
  originBase as beaconOrigin,
} from './endpoints';
import { MAX_TRACKERS as MESH_MAX_TRACKERS, meshConfig, trackerUrl as meshTrackerUrl } from './mesh';
import { resolveManifest as resolveOverRelays, watchEndpoints as watchBeacons } from './resolve';
import { Anchor, type ManifestBinding, loadWasm } from './verify';

// Everything public is declared here or in ./api.ts, so the declaration file built from
// this one needs nothing but api.d.ts beside it.
export type * from './api';

/** Most trackers one session takes. */
export const MAX_TRACKERS: number = MESH_MAX_TRACKERS;
/** Most STUN servers one session takes. */
export const MAX_ICE_SERVERS: number = ENDPOINTS_MAX_ICE_SERVERS;

/**
 * A tracker URL a page may configure, reduced to scheme, host, port and path: `wss:`, or
 * `ws:` on a loopback host (tests). No credentials, query or fragment. `null` otherwise.
 * (Trackers from beacons must also be `wss:`; `watchEndpoints` sees to that.)
 */
export function trackerUrl(raw: string): string | null {
  return meshTrackerUrl(raw);
}

/** A beacon-named origin as a plain `https://host[:port][/prefix]` base, or null. */
export function originBase(url: string): string | null {
  return beaconOrigin(url);
}

const P2P_ENGINE = 'p2p-media-loader 4.0.0';

/** Load the WASM verifier (once). Every other call waits for it; call this first. */
export async function init(options: InitOptions = {}): Promise<void> {
  await loadWasm(options.wasmUrl);
}

/** The current revision of the manifest at `a` across `relays` (`ws://` or `wss://` URLs). */
export function resolveManifest(a: string, relays: string[], options: ResolveOptions = {}): Promise<ResolvedManifest> {
  return resolveOverRelays(a, relays, options.timeoutMs);
}

/**
 * Report the origins and trackers seeders' live beacons for `a` name, each time they
 * change (the newest unexpired beacon per seeder counts; `wss://` trackers only, at most
 * 4; `https://` origins only, at most 8). Returns `stop`, which closes the subscriptions.
 */
export function watchEndpoints(
  a: string,
  namespace: string,
  relays: string[],
  onChange: (endpoints: Endpoints) => void,
): () => void {
  return watchBeacons(a, namespace, relays, onChange);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError');
}

/**
 * Play a video in `el`. Resolves once a hash list has verified and hls.js has started;
 * levels follow (`levels` event). Rejects if the manifest fails NFX-02, if no origin
 * serves a hash list that verifies, if MediaSource is missing (native HLS would play
 * unverified bytes), or if `signal` aborts first. A rejected `open()` leaves nothing running.
 */
export async function open(el: HTMLVideoElement, options: OpenOptions): Promise<Session> {
  const { signal } = options;
  const origins = checkOrigins(options.origins);
  const signaling = checkSignaling(options.signaling);
  const iceServers = checkIceServers(options.iceServers ?? []);
  const autoplay = options.autoplay ?? true;
  const level = options.level;
  const httpWindow = options.httpWindow;
  if (level !== undefined && !(Number.isSafeInteger(level) && level >= 0)) throw new TypeError('nfx: level must be a whole number');
  if (httpWindow !== undefined && !(Number.isSafeInteger(httpWindow) && httpWindow >= 0 && httpWindow <= 600)) {
    throw new TypeError('nfx: httpWindow must be 0 to 600 seconds');
  }
  if (signal?.aborted) throw abortError(signal);
  await loadWasm();

  let root: string;
  let binding: ManifestBinding | undefined;
  if (typeof options.manifestJson === 'string') {
    // NFX-02 again, whoever fetched it: the anchor comes from a signature, never a caller.
    const m = JSON.parse(verifyManifest(options.manifestJson)) as { root: string; video: string; segs: number };
    root = m.root;
    binding = { video: m.video, segs: m.segs };
  } else {
    root = String(options.root);
    const { video, segs } = options;
    binding = typeof video === 'string' && Number.isSafeInteger(segs) && (segs ?? 0) > 0 ? { video, segs: segs! } : undefined;
  }
  if (!Hls.isSupported()) throw new Error('MediaSource unavailable: this player only plays verified bytes');

  let dead = false;
  const emit = (e: PlayerEvent): void => {
    if (dead) return;
    try {
      options.onEvent?.(e);
    } catch (err) {
      globalThis.reportError?.(err);
    }
  };
  const log = (m: string): void => emit({ type: 'log', message: m });

  let anchor: Anchor | null = null;
  const failures: string[] = [];
  for (const origin of origins) {
    try {
      anchor = await Anchor.load(origin, root, binding, signal);
      emit({ type: 'origin', origin, ok: true });
      break;
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      failures.push(`${origin}: ${message(e)}`);
      emit({ type: 'origin', origin, ok: false, why: message(e) });
    }
  }
  if (anchor === null) throw new Error(`no origin served a hash list that verifies (${failures.join('; ')})`);
  if (signal?.aborted) throw abortError(signal);
  log(`hash list verified: ${anchor.size} files of ${anchor.video}${binding ? ' (bound to the manifest)' : ''}`);
  return start(el, anchor, { signaling, iceServers, autoplay, level, httpWindow, signal }, emit, log, () => {
    dead = true;
  });
}

interface StartOptions {
  signaling: Signaling | null;
  iceServers: RTCIceServer[];
  autoplay: boolean;
  level: number | undefined;
  httpWindow: number | undefined;
  signal: AbortSignal | undefined;
}

function start(
  el: HTMLVideoElement,
  anchor: Anchor,
  o: StartOptions,
  emit: (e: PlayerEvent) => void,
  log: (m: string) => void,
  silence: () => void,
): Session {
  let dead = false;
  let verified = 0;
  let playing = false;
  let levels: Level[] = [];
  const rejected: Rejection[] = [];
  const reject = (r: Rejection): void => {
    if (rejected.length < 1000) rejected.push(r);
    emit({ type: 'rejected', ...r });
    log(`REJECTED ${r.url}: ${r.why}`);
  };
  const base = {
    loader: verifyingLoader(
      anchor,
      (sha256, url) => {
        verified += 1;
        emit({ type: 'verified', sha256, url });
      },
      reject,
    ),
    progressive: false,
  };
  let hls: Hls;
  let mesh: MeshStats | null = null;
  let engine: string;
  if (o.signaling !== null) {
    const signaling = o.signaling;
    mesh = { signaling: signaling.kind, trackers: [], swarms: [], bytes: { http: 0, p2p: 0 }, uploaded: 0, peers: 0, rejected: [] };
    const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);
    const tuning = o.httpWindow === undefined ? {} : { httpWindow: o.httpWindow };
    hls = new HlsWithP2P({ ...base, ...meshConfig(anchor, signaling, o.iceServers, mesh, log, tuning) } as never);
    engine = `hls.js ${Hls.version} + ${P2P_ENGINE}`;
    log(`mesh: ${signaling.kind} ${signaling.urls.join(' ')}`);
  } else {
    hls = new Hls(base);
    engine = `hls.js ${Hls.version}`;
  }

  const onPlaying = (): void => {
    if (dead) return;
    playing = true;
    emit({ type: 'playing' });
  };
  el.addEventListener('playing', onPlaying);
  hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
    if (dead) return;
    if (o.level !== undefined && o.level < d.levels.length) hls.currentLevel = o.level;
    levels = d.levels.map((l, index) => ({ index, width: l.width, height: l.height, bitrate: l.bitrate }));
    emit({ type: 'levels', levels: levels.map((l) => ({ ...l })) });
    log(`levels: ${levels.map((l) => `${l.height}p`).join(' ')}`);
    if (o.autoplay) {
      el.play().catch((e: unknown) => emit({ type: 'error', message: `play: ${String(e)}` }));
    }
  });
  hls.on(Hls.Events.ERROR, (_, d) => {
    if (dead || !d.fatal) return;
    emit({ type: 'error', message: `${d.type}:${d.details}` });
    log(`fatal: ${d.details}`);
  });

  const destroy = (): void => {
    if (dead) return;
    dead = true;
    silence();
    o.signal?.removeEventListener('abort', destroy);
    el.removeEventListener('playing', onPlaying);
    // hls.js stops its loaders and its worker, detaches the media (revoking the
    // MediaSource URL), and fires DESTROYING, on which the p2p engine destroys its core:
    // stream loaders, peers and the tracker sockets.
    hls.destroy();
    if (el.src.startsWith('blob:')) {
      el.removeAttribute('src');
      el.load();
    }
  };
  o.signal?.addEventListener('abort', destroy, { once: true });

  hls.loadSource(`${anchor.origin}/${anchor.root}/master.m3u8`);
  hls.attachMedia(el);

  return {
    get levels(): Level[] {
      return levels.map((l) => ({ ...l }));
    },
    setLevel(index: number): void {
      if (dead) return;
      if (!Number.isSafeInteger(index) || index < -1 || index >= levels.length) {
        throw new RangeError(`nfx: no level ${index}`);
      }
      hls.currentLevel = index;
    },
    stats(): Stats {
      return {
        engine,
        origin: anchor.origin,
        root: anchor.root,
        video: anchor.video,
        verified,
        rejected: rejected.map((r) => ({ ...r })),
        levels: levels.map((l) => ({ ...l })),
        level: dead ? -1 : hls.currentLevel,
        playing,
        mesh: mesh === null ? null : structuredClone(mesh),
      };
    },
    destroy,
  };
}

/** Wraps hls.js' default loader: fetch as bytes, verify, then hand over. */
function verifyingLoader(
  anchor: Anchor,
  onVerified: (sha256: string, url: string) => void,
  onRejected: (r: Rejection) => void,
): new (config: HlsConfig) => Loader<LoaderContext> {
  const Base = Hls.DefaultConfig.loader as unknown as new (config: HlsConfig) => Loader<LoaderContext>;
  return class VerifyingLoader extends Base {
    override load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      const wantText = context.responseType !== 'arraybuffer';
      context.responseType = 'arraybuffer';
      super.load(context, config, {
        onError: callbacks.onError,
        onTimeout: callbacks.onTimeout,
        onAbort: callbacks.onAbort,
        // No onProgress: unverified bytes must never reach hls.js.
        onSuccess: (response, stats, ctx, details) => {
          if (stats.aborted) return;
          const bytes = response.data as ArrayBuffer;
          let sha: string;
          try {
            sha = anchor.check(ctx.url, bytes);
          } catch (e) {
            const why = message(e);
            let expected: string | null = null;
            try {
              expected = anchor.expected(ctx.url);
            } catch {
              // an unanchored URL is reported with sha256 null
            }
            onRejected({ sha256: expected, url: ctx.url, why });
            callbacks.onError({ code: 0, text: `nfx: ${why}` }, ctx, details, stats);
            return;
          }
          onVerified(sha, ctx.url);
          response.data = wantText ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
          callbacks.onSuccess(response, stats, ctx, details);
        },
      });
    }
  };
}
