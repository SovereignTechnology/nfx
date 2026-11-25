/**
 * The NFX web player as a library. A page (the test player, ./player.ts, or another
 * client) calls, in order:
 *
 * - `init({ wasmUrl })`: load nfx-proto's WASM verifier once;
 * - `resolveManifest(a, relays)`: the current signed manifest of a video (NFX-02), over
 *   Nostr, with deletions applied (NFX-02 §6);
 * - `watchEndpoints(a, namespace, relays, onChange)`: origins, trackers and STUN servers
 *   named by seeders' live beacons (NFX-03, NFX-10 §1), validated and capped;
 *   `selectStun(own, relays, creator)` picks a session's STUN servers by NFX-10 §1's rules:
 *   its own, then those its relays name for themselves, then those the video's creator names
 *   (`fetchRelayInfo` and `relayStunUrl` read a relay's; Nostr signaling's `relayStun` does
 *   it for a session);
 * - `open(videoElement, options)`: verify the manifest again, fetch the hash list from the
 *   first origin whose copy verifies and that answers for an allowed rendition's init (the
 *   origin is asked; beacons' claims only order the asking), and play with hls.js behind a
 *   loader that checks every playlist, init and segment against it before hls.js sees a
 *   byte. With a `signaling` (WebTorrent trackers, or Nostr relays with no tracker: NFX-10
 *   §6), the NFX-10 browser mesh (p2p-media-loader) joins in, its segments checked the same
 *   way. `destroy()` stops all of it.
 *
 * Nothing here reads the page's URL or DOM beyond the element it is given, and nothing
 * here keeps state between sessions but the loaded WASM module.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Hls, {
  type HlsConfig,
  LoadStats,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderStats,
} from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';

import { verifyManifest } from '../out/wasm/nfx_wasm.js';
import type {
  Endpoints,
  InitOptions,
  Level,
  MeshStats,
  OpenOptions,
  OriginSource,
  PeerAddress,
  PlayerEvent,
  Rejection,
  RelayInfo,
  RelayInfoOptions,
  RemoteCandidates,
  ResolveOptions,
  ResolvedManifest,
  Session,
  Signaling,
  Stats,
  SeederStun,
} from './api';
import {
  MAX_ICE_SERVERS as ENDPOINTS_MAX_ICE_SERVERS,
  checkIceServers,
  checkOriginSources,
  checkSignaling as checkSignalingOption,
  checkStunFallbackServers,
  originBase as beaconOrigin,
  relayStunUrl as relayStunServer,
  selectStun as selectStunServers,
  selectStunFallback as selectFallbackServers,
} from './endpoints';
import { MAX_RENDITIONS as LEVELS_MAX_RENDITIONS, checkRenditions, cutMaster, originOrder } from './levels';
import {
  MAX_RELAYS as MESH_MAX_RELAYS,
  MAX_TRACKERS as MESH_MAX_TRACKERS,
  PeerBook,
  meshConfig,
  relayUrl as meshRelayUrl,
  trackerUrl as meshTrackerUrl,
} from './mesh';
import { type Probe, type Selection, describe as describeProbes, initUrl, probeStatus, selectRenditions } from './probe';
import { fetchRelayInfo as fetchNip11, parseRelayInfo as parseNip11 } from './relay-info';
import { RelayStunBook } from './relay-stun';
import { MAX_REMOTE_CANDIDATES as SDP_MAX_REMOTE_CANDIDATES, filterRemoteSdp as filterSdp } from './remote-sdp';
import { NostrSignaler } from './signal-nostr';
import { StunFallbackBook } from './stun-fallback';
import { type EndpointWatch, type WatchOptions, resolveManifest as resolveOverRelays, watchEndpoints as watchBeacons } from './resolve';
import { SessionSources, bufferedAhead } from './session-sources';
import { Anchor, MAX_HASH_LIST_BYTES, type ManifestBinding, loadWasm } from './verify';

// Everything public is declared here or in ./api.ts, so the declaration file built from
// this one needs nothing but api.d.ts beside it.
export type * from './api';

/** Most trackers one session takes. */
export const MAX_TRACKERS: number = MESH_MAX_TRACKERS;
/** Most relays one session's Nostr signaling takes (NFX-10 §6). */
export const MAX_RELAYS: number = MESH_MAX_RELAYS;
/** The Nostr signaling kind, and the protocol identifier its events carry (NFX-10 §6). */
export const NOSTR_SIGNAL_KIND: number = 25050;
export const NOSTR_SIGNAL_PROTOCOL: string = 'nfx-mesh/1';
/** Most STUN servers one session takes. */
export const MAX_ICE_SERVERS: number = ENDPOINTS_MAX_ICE_SERVERS;
/** Most rendition ids `open()`'s `renditions`, and an `OriginSource`'s, take. */
export const MAX_RENDITIONS: number = LEVELS_MAX_RENDITIONS;

/**
 * A tracker URL a page may configure, reduced to scheme, host, port and path: `wss:`, or
 * `ws:` on a loopback host (tests). No credentials, query or fragment. `null` otherwise.
 * (Trackers from beacons must also be `wss:`; `watchEndpoints` sees to that.)
 */
export function trackerUrl(raw: string): string | null {
  return meshTrackerUrl(raw);
}

/**
 * A relay URL a session may signal through (NFX-10 §6), reduced to scheme, host, port and
 * path: `wss:`, or `ws:` on a loopback host (tests). No credentials, query or fragment.
 * `null` otherwise.
 */
export function relayUrl(raw: string): string | null {
  return meshRelayUrl(raw);
}

/**
 * `signaling` as `open()` will take it, normalised (URLs reduced, duplicates dropped), or
 * `null` for none; throws a `TypeError` for anything `open()` refuses, so a page can check
 * its settings first.
 */
export function checkSignaling(signaling: Signaling | undefined): Signaling | null {
  return checkSignalingOption(signaling);
}

/** A beacon-named origin as a plain `https://host[:port][/prefix]` base, or null. */
export function originBase(url: string): string | null {
  return beaconOrigin(url);
}

/**
 * The STUN servers a session uses (NFX-10 §1), as `stun:` URLs for `iceServers`, at most 4:
 * the page's own (`own`) first; then those the relays it signals through name for themselves
 * (`relays`: `relayStunUrl` of each, in the order of the relays); then those the video's
 * creator names (`watchEndpoints`'s `stunCreator`: the `stun` endpoint of the creator's own
 * live beacon), global unicast, on a port of 1024 or above; each once. No other key's beacon
 * adds a server, however many keys name it, and no STUN service announcement does. Every NFX
 * client picks by these rules, so Nostr never makes a viewer ask more than 4 STUN servers, or
 * one that neither the creator nor one of its relays named. Each server learns the viewer's
 * address: a page that must not tell the creator's servers who watches passes `[]` as
 * `creator`. A session with Nostr signaling's `relayStun` applies the relays' part itself,
 * with each relay's document as it comes; a page passes `selectStun(own, [], creator)` to
 * `open()` then.
 */
export function selectStun(own: readonly string[], relays: readonly string[], creator: readonly string[]): string[] {
  return selectStunServers(own, relays, creator);
}

/**
 * The NIP-11 document of `relay` (a `wss:` or `ws:` URL), read as NIP-11 says (a `GET` of the
 * relay's URL with `https:` for `wss:`, `http:` for `ws:`, and `Accept:
 * application/nostr+json`), and what `parseRelayInfo` keeps of it; null on any failure (no
 * answer within `timeoutMs`, default 3 s; a status other than 200; a redirect; over 64 KiB; not
 * JSON; not an object). Never rejects. Nothing is cached: call it once per relay per session.
 * The page's Content-Security-Policy must allow `connect-src` to that URL.
 */
export function fetchRelayInfo(relay: string, options: RelayInfoOptions = {}): Promise<RelayInfo | null> {
  return fetchNip11(relay, options);
}

/**
 * What a reader keeps of a relay's parsed NIP-11 document: its `nfx` object (NFX-04 §3), every
 * field checked (`RelayNfx`). Null when `doc` is not a JSON object.
 */
export function parseRelayInfo(doc: unknown): RelayInfo | null {
  return parseNip11(doc);
}

/**
 * The STUN server a relay names for itself (NFX-10 §1), as a `stun:` URL, or null:
 * `stun:<host of relay>:<stun_port>` when its NIP-11 `nfx.kinds` lists 25050 and its
 * `nfx.stun_port` is 1024 to 65535. The host must not be an IP address that is not global
 * unicast, `localhost`, or a name under `.localhost`. The relay sees the viewer's address on
 * its WebSocket already: its STUN server learns only the viewer's UDP port. Not for a viewer
 * who hides its address from the relay (a proxy, a VPN, Tor).
 */
export function relayStunUrl(relay: string, info: RelayInfo | null): string | null {
  return relayStunServer(relay, info);
}

/**
 * The fallback when no STUN server a client asks returned a mapping (NFX-10 §1), as a pure
 * function: the servers it may also ask, each with its seeder. Nothing once one of those it
 * asks (`own` and `inUse`) returned a mapping (`mapped` true); a client that asks none (both
 * empty) may fall back too. Then at most one per seeder of `seeders` (`Endpoints.stunSeeders`,
 * never an announcement): global unicast, on a port of 1024 or above, not asked yet, whose IP
 * address is in `signaling` (the candidate addresses of the peers it is signaling with), at
 * most 4 STUN servers in all. `open()` applies it for you when Nostr signaling is given
 * `stunFallback`.
 */
export function selectStunFallback(
  own: readonly string[],
  inUse: readonly string[],
  mapped: boolean,
  seeders: readonly Pick<SeederStun, 'seeder' | 'urls'>[],
  signaling: readonly string[],
): { seeder: string; url: string }[] {
  return selectFallbackServers(own, inUse, mapped, seeders, signaling);
}

/** Most candidates `remoteCandidates: 'global'` keeps from one SDP. */
export const MAX_REMOTE_CANDIDATES: number = SDP_MAX_REMOTE_CANDIDATES;

/**
 * A peer's SDP cut to the candidates `mode` lets an ICE agent try (`RemoteCandidates`), as
 * `open()` applies it with Nostr signaling's `remoteCandidates`: `all` returns it as it is;
 * `global` keeps at most `MAX_REMOTE_CANDIDATES` UDP candidates at global unicast addresses,
 * in the strict form browsers write, and every other line byte for byte. Pure, and never
 * throws for an SDP left with no candidate; throws a `TypeError` for another mode.
 */
export function filterRemoteSdp(sdp: string, mode: RemoteCandidates): string {
  return filterSdp(sdp, mode);
}

/** The mesh engine: p2p-media-loader-core 4.0.0 built from its source with web/player/engine's patch. */
const P2P_ENGINE = 'p2p-media-loader 4.0.0 (nfx engine patch)';

/** Load the WASM verifier (once). Every other call waits for it; call this first. */
export async function init(options: InitOptions = {}): Promise<void> {
  await loadWasm(options.wasmUrl);
}

/** The current revision of the manifest at `a` across `relays` (`ws://` or `wss://` URLs). */
export function resolveManifest(a: string, relays: string[], options: ResolveOptions = {}): Promise<ResolvedManifest> {
  return resolveOverRelays(a, relays, options.timeoutMs);
}

/**
 * Report the origins, trackers and STUN servers seeders' live beacons for `a` name, and
 * which renditions they hold, each time that changes (the newest unexpired beacon per
 * seeder counts, at most 64 seeders, the creator's own beacon always; `https://` origins
 * only, at most 8, with the renditions beacons claim each serves, a hint for `open()`;
 * `wss://` trackers only, at most 4; `availability`). STUN servers come from beacons' `stun`
 * endpoints, global unicast addresses only: the creator's own beacon's (`stunCreator`, and
 * `stunServers`, what `selectStun` picks for a page with none of its own), and every seeder's
 * for the fallback (`stunSeeders`). STUN service announcements are not read. Origins come in
 * NFX-17 §4.2's tiers (`OriginSource.tier`): pass them to `open()` and `Session.addSources`.
 * Returns `stop`, which closes the subscriptions; `stop.delivered(url)` tells the watch an
 * origin delivered a file, so the first key that named it keeps its place. With `ask: true`,
 * `stop.ask()` asks the video's seeders to answer at once (NFX-17): call it when the viewer
 * presses Play. It publishes one event, from a throwaway key, that says which video is
 * starting; a page MUST offer a way to turn it off.
 */
export function watchEndpoints(
  a: string,
  namespace: string,
  relays: string[],
  onChange: (endpoints: Endpoints) => void,
  options: WatchOptions = {},
): EndpointWatch {
  return watchBeacons(a, namespace, relays, onChange, options);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError');
}

/**
 * Play a video in `el`. Resolves once a hash list has verified, the origin has answered
 * which allowed renditions it holds, and hls.js has started; levels follow (`levels`
 * event). Rejects if the manifest fails NFX-02, if no origin serves a hash list that
 * verifies and answers for an allowed rendition's init (`OpenCommon` has the rule), if
 * `renditions` names one the hash list lacks, if MediaSource is missing (native HLS would
 * play unverified bytes), or if `signal` aborts first. A rejected `open()` leaves nothing
 * running.
 */
export async function open(el: HTMLVideoElement, options: OpenOptions): Promise<Session> {
  const { signal } = options;
  const origins = checkOriginSources(options.origins);
  const wanted = checkRenditions(options.renditions);
  const signaling = checkSignalingOption(options.signaling);
  const iceServers = checkIceServers(options.iceServers ?? []);
  checkStunFallbackServers(signaling, iceServers);
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
  let renditions: string[] = [];
  const failures: string[] = [];
  const skip = (origin: string, why: string): void => {
    failures.push(`${origin}: ${why}`);
    emit({ type: 'origin', origin, ok: false, why });
  };
  // Every source the session knows, in NFX-17 §4.2's tiers. The hash list comes from whichever
  // delivers a copy that verifies against `root` first (§4.3), whoever sent it.
  const sources = new SessionSources(
    root,
    origins.map((o) => ({ url: o.url, tier: o.tier, renditions: o.renditions })),
  );
  sources.bind({ log, reject: (source, path) => skip(source, `${path} did not verify`) });
  const built: { list: Anchor | null } = { list: null };
  let delivered: string;
  try {
    const got = await sources.get(
      root,
      (bytes) => {
        try {
          built.list = Anchor.fromBytes('', root, bytes, binding);
          return true;
        } catch {
          return false;
        }
      },
      signal,
      true,
    );
    delivered = got.source;
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    throw new Error(`no source served a hash list that verifies (${message(e)}${failures.length > 0 ? `; ${failures.join('; ')}` : ''})`);
  }
  const list = built.list;
  if (list === null) throw new Error('no source served a hash list that verifies');
  sources.learnSizes(list.fileSizes());

  // Which renditions the session offers is what a source answers for (nfx #85), asked of the
  // source that delivered the hash list first, then the rest. What beacons say an origin
  // serves (`hint`) only orders them.
  const order = originOrder(origins, wanted);
  order.sort((x, y) => (x.url === delivered ? -1 : y.url === delivered ? 1 : 0));
  for (const { url: origin, renditions: hint } of order) {
    const loaded = list.at(origin);
    let picked: Selection;
    try {
      // A RangeError (an id the hash list lacks) ends open(), before any probe: every
      // origin serves the same list.
      picked = await selectRenditions(
        loaded.renditions.map((r) => r.id),
        wanted,
        hint,
        initProbe(loaded),
        { signal },
      );
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      throw e;
    }
    renditions = picked.renditions;
    const summary = describeProbes(picked.outcomes) + (picked.unasked > 0 ? `; ${picked.unasked} more not asked for (at most ${MAX_RENDITIONS})` : '');
    if (renditions.length === 0) {
      skip(origin, `it holds none of the allowed renditions (${summary})`);
      continue;
    }
    log(`${origin} holds ${renditions.join(', ')} of the allowed renditions (${summary})`);
    anchor = loaded;
    emit({ type: 'origin', origin, ok: true });
    break;
  }
  if (anchor === null) throw new Error(`no origin held an allowed rendition (${failures.join('; ')})`);
  if (signal?.aborted) throw abortError(signal);
  log(`hash list verified: ${anchor.size} files of ${anchor.video}${binding ? ' (bound to the manifest)' : ''}`);
  const levelRule = { renditions, preferStart: wanted !== null };
  return start(el, anchor, { signaling, iceServers, autoplay, level, httpWindow, signal, ...levelRule, sources }, emit, log, () => {
    dead = true;
  });
}

/**
 * How to ask the origin `anchor` came from whether it holds a rendition (./probe.ts): its
 * media playlist, fetched and verified against the hash list, names its init (NFX-05 §3),
 * and a GET of that init must answer 200 or 206. Every URL is one the hash list names,
 * under `<origin>/<root>/`: the playlist's content name, and the init's, read from bytes
 * that verified.
 */
/** `<sha256>.<ext>`: a content name (NFX-05 §3), with no path, query or fragment. */
const CONTENT_NAME = /^[0-9a-f]{64}\.[0-9A-Za-z]{1,8}$/;

function initProbe(anchor: Anchor): Probe {
  const base = `${anchor.origin}/${anchor.root}/`;
  return async (id, signal) => {
    const r = anchor.renditions.find((x) => x.id === id);
    if (r === undefined) throw new Error('not a rendition of the hash list');
    const playlistUrl = `${base}${r.playlist}.m3u8`;
    let text: string;
    try {
      const bytes = await anchor.fetchChecked(playlistUrl, Math.min(r.playlistSize ?? MAX_HASH_LIST_BYTES, MAX_HASH_LIST_BYTES), signal);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      throw new Error(`playlist: ${message(e)}`);
    }
    // A content name right under `<origin>/<root>/` (NFX-05 §3), and one the hash list names:
    // nothing else is ever requested, whatever the playlist holds.
    const init = initUrl(text, playlistUrl);
    if (init === null || !init.startsWith(base) || !CONTENT_NAME.test(init.slice(base.length))) throw new Error('its playlist names no init');
    anchor.expected(init); // throws for a file the hash list does not name
    return probeStatus((url, req) => fetch(url, req), init, signal);
  };
}

interface StartOptions {
  /** The session's renditions, in order of preference (`OpenCommon` has the rule). */
  renditions: string[];
  /** Start on the first of `renditions` (the caller named them), unless `level` pins one. */
  preferStart: boolean;
  signaling: Signaling | null;
  iceServers: RTCIceServer[];
  autoplay: boolean;
  level: number | undefined;
  httpWindow: number | undefined;
  signal: AbortSignal | undefined;
  /** Where every file comes from (NFX-17 §§4.2-4.3). */
  sources: SessionSources;
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
  let originBytes = 0;
  let playing = false;
  let levels: Level[] = [];
  const rejected: Rejection[] = [];
  const reject = (r: Rejection): void => {
    if (rejected.length < 1000) rejected.push(r);
    emit({ type: 'rejected', ...r });
    log(`REJECTED ${r.url}: ${r.why}`);
  };
  // The playlists of the session's renditions: the master playlist is cut to their variants,
  // so hls.js (and the mesh, which reads hls.js's levels) never learns of another.
  const allowed = new Set(o.renditions);
  const keep = new Set(anchor.renditions.filter((r) => allowed.has(r.id)).map((r) => r.playlist));
  const cut = (url: string, text: string): string => {
    try {
      const c = cutMaster(text, url, keep);
      if (c.kept === 0) throw new Error('the master playlist lists none of the allowed renditions');
      log(`master playlist cut to ${c.kept} variant(s), for ${o.renditions.join(', ')}`);
      return c.text;
    } catch (e) {
      log(`master playlist refused: ${message(e)}`);
      throw e;
    }
  };
  o.sources.bind({
    buffer: () => bufferedAhead(el),
    // Each source that delivers a file (a page passes it on to `EndpointWatch.delivered`).
    delivered: (origin) => emit({ type: 'origin', origin, ok: true }),
    reject: (source, path) => {
      let sha256: string | null = null;
      try {
        sha256 = anchor.expected(`${anchor.origin}/${path}`);
      } catch {
        // a path the hash list does not name is reported with sha256 null
      }
      reject({ sha256, url: `${source}/${path}`, why: 'bytes that do not verify; source stopped for the session' });
    },
  });
  // Every file comes through the session's sources, which retry, hedge and change source
  // themselves (NFX-17 §4.3): hls.js retries nothing, and never times a load out first.
  const noRetry = { default: { maxTimeToFirstByteMs: Infinity, maxLoadTimeMs: 3_600_000, timeoutRetry: null, errorRetry: null } };
  const base = {
    loader: sourcedLoader(
      anchor,
      o.sources,
      (sha256, url, bytes) => {
        verified += 1;
        originBytes += bytes;
        emit({ type: 'verified', sha256, url });
      },
      cut,
    ),
    progressive: false,
    fragLoadPolicy: noRetry,
    playlistLoadPolicy: noRetry,
    manifestLoadPolicy: noRetry,
  };
  let hls: Hls;
  let mesh: MeshStats | null = null;
  const book = new PeerBook();
  let nostr: NostrSignaler | undefined;
  let engine: string;
  if (o.signaling !== null) {
    const signaling = o.signaling;
    mesh = {
      signaling: signaling.kind,
      trackers: [],
      relays: [],
      swarms: [],
      bytes: { http: 0, p2p: 0 },
      uploaded: 0,
      peers: 0,
      rejected: [],
      connected: 0,
      segments: { http: 0, p2p: 0 },
      peerList: [],
      signal: null,
    };
    const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);
    const tuning = o.httpWindow === undefined ? {} : { httpWindow: o.httpWindow };
    if (signaling.kind === 'nostr') {
      const fallback = signaling.stunFallback ? new StunFallbackBook(signaling.stunFallback, o.iceServers.flatMap((i) => i.urls)) : null;
      // The relays' documents are read beside their sockets; nothing waits for them.
      const relayStun = signaling.relayStun ? new RelayStunBook(signaling.relayStun, signaling.relays, log) : null;
      nostr = new NostrSignaler(signaling.relays, log, signaling.remoteCandidates ?? 'all', fallback, relayStun);
    }
    const p2p = meshConfig(anchor, signaling, o.iceServers, mesh, log, tuning, nostr, book);
    // The engine's HTTP downloads go through the session's sources too, and a segment is
    // assembled from one source's (or one peer's) bytes only (NFX-17 §4.3; engine patch).
    Object.assign(p2p.p2p.core, {
      httpSegmentFetch: async (url: string, signal: AbortSignal | undefined): Promise<Uint8Array> =>
        (await o.sources.get(pathUnder(anchor, url), verifies(anchor, url), signal)).bytes,
      segmentFromOneSource: true,
    });
    hls = new HlsWithP2P({ ...base, ...p2p } as never);
    engine = `hls.js ${Hls.version} + ${P2P_ENGINE}`;
    const filtered = nostr?.remoteCandidates === 'global' ? ' (remote candidates: global unicast UDP only)' : '';
    const atRelays = nostr?.relayStun ? ' (STUN at its relays too)' : '';
    log(`mesh: ${signaling.kind} ${(signaling.kind === 'nostr' ? signaling.relays : signaling.urls).join(' ')}${filtered}${atRelays}`);
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
    const ids = d.levels.map((l) => anchor.renditionOf(l.url[0] ?? ''));
    if (ids.some((id) => id === null || !allowed.has(id))) {
      // Cannot happen after the cut; checked, not assumed. hls.js starts loading only after
      // this event, so the session ends before it fetches a segment.
      emit({ type: 'error', message: 'nfx: hls.js lists a level outside the allowed renditions' });
      log('fatal: a level outside the allowed renditions');
      queueMicrotask(destroy);
      return;
    }
    levels = d.levels.map((l, index) => ({ index, id: ids[index] ?? '', width: l.width, height: l.height, bitrate: l.bitrate }));
    if (o.level !== undefined && o.level < d.levels.length) hls.currentLevel = o.level;
    else if (o.preferStart) {
      // The first of the caller's renditions that hls.js kept; ABR stays on (startLevel, not currentLevel).
      const first = o.renditions.map((id) => ids.indexOf(id)).find((i) => i >= 0);
      if (first !== undefined) hls.startLevel = first;
    }
    emit({ type: 'levels', levels: levels.map((l) => ({ ...l })) });
    log(`levels: ${levels.map((l) => `${l.id} (${l.height}p)`).join(' ')}`);
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
    // stream loaders, peers and the tracker sockets (or the Nostr rooms, which send their
    // disconnects). Then the Nostr signaler closes its relay sockets.
    hls.destroy();
    nostr?.destroy();
    book.release();
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
        mesh:
          mesh === null
            ? null
            : {
                ...structuredClone(mesh),
                connected: dead ? 0 : book.connected(),
                peerList: book.list(),
                signal:
                  nostr === undefined
                    ? null
                    : { open: dead ? 0 : nostr.pool.openCount, ...nostr.stats },
              },
        originBytes,
        bandwidthEstimate: dead ? 0 : hls.bandwidthEstimate,
      };
    },
    addSources(list: readonly (string | OriginSource)[]): void {
      if (dead) return;
      o.sources.add(checkOriginSources(list).map((x) => ({ url: x.url, tier: x.tier, renditions: x.renditions })));
    },
    async addresses(): Promise<PeerAddress[]> {
      if (dead || mesh === null) return [];
      const found = await book.addresses();
      return dead ? [] : found;
    },
    destroy,
  };
}

/** `url`'s path under the session's anchor origin: `<root>` or `<root>/<name>`. */
function pathUnder(anchor: Anchor, url: string): string {
  const base = `${anchor.origin}/`;
  if (!url.startsWith(base)) throw new Error(`nfx: ${url} is not under the session's origin`);
  return url.slice(base.length);
}

/** Whether bytes are the file the hash list names at `url`. */
function verifies(anchor: Anchor, url: string): (bytes: Uint8Array) => boolean {
  return (bytes) => {
    try {
      anchor.check(url, bytes);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * hls.js' loader: every file through the session's sources (NFX-17 §4.3), verified before
 * hls.js sees a byte; the master playlist through `masterText` (its text, once verified, cut
 * to the session's renditions). A media playlist also tells the sources each file's
 * rendition and media time.
 */
function sourcedLoader(
  anchor: Anchor,
  sources: SessionSources,
  onVerified: (sha256: string, url: string, bytes: number) => void,
  masterText: (url: string, text: string) => string,
): new (config: HlsConfig) => Loader<LoaderContext> {
  return class SourcedLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null;
    stats: LoaderStats = new LoadStats();
    #ctl: AbortController | null = null;

    destroy(): void {
      this.abort();
      this.context = null;
    }

    abort(): void {
      if (this.#ctl !== null && !this.stats.aborted) {
        this.stats.aborted = true;
        this.#ctl.abort();
      }
    }

    load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      this.context = context;
      const stats = this.stats;
      stats.loading.start = performance.now();
      const ctl = new AbortController();
      this.#ctl = ctl;
      const url = context.url;
      const wantText = context.responseType !== 'arraybuffer';
      const fail = (why: string): void => {
        if (!stats.aborted) callbacks.onError({ code: 0, text: `nfx: ${why}` }, context, null, stats);
      };
      let path: string;
      try {
        path = pathUnder(anchor, url);
      } catch (e) {
        queueMicrotask(() => fail(message(e)));
        return;
      }
      sources.get(path, verifies(anchor, url), ctl.signal).then(
        ({ bytes }) => {
          if (stats.aborted) return;
          const now = performance.now();
          stats.loading.first = Math.max(stats.loading.start, now - 1);
          stats.loading.end = now;
          stats.loaded = bytes.byteLength;
          stats.total = bytes.byteLength;
          stats.chunkCount = 1;
          let sha: string;
          try {
            sha = anchor.check(url, bytes);
          } catch (e) {
            fail(message(e));
            return;
          }
          onVerified(sha, url, bytes.byteLength);
          let data: string | ArrayBuffer = bytes.slice().buffer;
          if (wantText) {
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
              if (sha === anchor.master) data = masterText(url, text);
              else {
                sources.learnPlaylist(text, anchor.renditionOf(url));
                data = text;
              }
            } catch (e) {
              // Verified bytes hls.js must still not see: an error, never data.
              fail(message(e));
              return;
            }
          }
          callbacks.onSuccess({ url, data }, stats, context, null);
        },
        (e: unknown) => fail(message(e)),
      );
    }
  };
}
