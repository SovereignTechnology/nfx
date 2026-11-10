/**
 * The NFX test player: a thin page over the library (./lib.ts), so its e2e suites test the
 * library's code. Two ways in:
 *
 * - `?a=<manifest address>&relay=<ws(s) URL>[&relay=…][&origin=<hint>]`: resolve the
 *   current signed manifest over Nostr, then play from an origin named by a verified
 *   beacon's `https` endpoint (or the hint). The trackers seeders' beacons name in
 *   `webrtc` endpoints are used too, and the STUN servers they name in `stun` endpoints
 *   (NFX-10 §1, global unicast only), after any `&stun=`. Signatures give the anchor;
 *   endpoints are only hints.
 * - `?origin=<url>&root=<hex>[&video=<d>&segs=<n>]`: play a known root from a known origin.
 *
 * A loader wrapper checks every playlist, init and segment with nfx-proto (WASM) before
 * hls.js sees a byte: a mismatch is a load error, never data.
 *
 * With `&tracker=<wss URL>` (repeatable), or trackers from beacons, the player also joins
 * the NFX-10 browser mesh: segments may then come from other viewers, checked by the same
 * verifier. With `&signal=nostr`, the mesh signals over Nostr instead (NFX-10 §6): through
 * the page's `&relay=` URLs (up to 8), with no tracker at all, and beacon-named trackers
 * are not used. `&stun=<stun: URL>` adds an ICE server; there is none by default, so no
 * third party learns who watches. Test knobs, which change where bytes come from and never
 * whether they are checked: `&httpWindow=<s>` (seconds ahead fetched over HTTP) and
 * `&level=<n>` (pin a rendition).
 *
 * `window.__nfx` exposes state for automation.
 */
import {
  type Endpoints,
  type Level,
  MAX_ICE_SERVERS,
  MAX_RELAYS,
  MAX_TRACKERS,
  type MeshStats,
  type OpenCommon,
  type PlayerEvent,
  type Session,
  type Signaling,
  init,
  open,
  relayUrl,
  resolveManifest,
  trackerUrl,
  watchEndpoints,
} from './lib';

/** How long to wait for a seeder's beacon to name an origin (beacons republish at TTL/2). */
const ORIGIN_WAIT_MS = 90_000;

interface State {
  secureContext: boolean;
  resolved: { a: string; title: string; root: string; video: string; segs: number; created_at: number } | null;
  origins: string[];
  /** Trackers named by seeders' beacons (all heard, before the cap). */
  beaconTrackers: string[];
  /** STUN servers named by seeders' beacons. */
  beaconStun: string[];
  origin: string | null;
  root: string | null;
  engine: string | null;
  verified: string[];
  rejected: { sha256: string | null; url: string; why: string }[];
  levels: { height: number; bitrate: number }[];
  playing: boolean;
  errors: string[];
  readonly mesh: MeshStats | null;
}

let session: Session | null = null;
const st: State = {
  secureContext: window.isSecureContext,
  resolved: null,
  origins: [],
  beaconTrackers: [],
  beaconStun: [],
  origin: null,
  root: null,
  engine: null,
  verified: [],
  rejected: [],
  levels: [],
  playing: false,
  errors: [],
  get mesh(): MeshStats | null {
    return session?.stats().mesh ?? null;
  },
};
(window as unknown as { __nfx: State }).__nfx = st;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>('log');
/** The last lines logged; what relays and peers make the page log is theirs to choose, so it is capped. */
const LOG_LINES = 400;
const logLines: string[] = [];
const log = (m: string): void => {
  logLines.push(`${new Date().toISOString().slice(11, 19)} ${m.slice(0, 500)}`);
  if (logLines.length > LOG_LINES) logLines.splice(0, logLines.length - LOG_LINES);
  logEl.textContent = `${logLines.join('\n')}\n`;
};

const onEvent = (e: PlayerEvent): void => {
  switch (e.type) {
    case 'log':
      log(e.message);
      break;
    case 'origin':
      if (!e.ok) log(`origin ${e.origin} did not serve a verifying copy: ${e.why ?? ''}`);
      break;
    case 'verified':
      st.verified.push(e.sha256);
      break;
    case 'rejected':
      st.rejected.push({ sha256: e.sha256, url: e.url, why: e.why });
      break;
    case 'levels':
      st.levels = e.levels.map((l: Level) => ({ height: l.height, bitrate: l.bitrate }));
      break;
    case 'playing':
      st.playing = true;
      break;
    case 'error':
      st.errors.push(e.message);
      break;
  }
};

const params = new URLSearchParams(location.search);
const a = params.get('a') ?? '';
const relays = params.getAll('relay').filter((r) => /^wss?:\/\//.test(r));
const origin = (params.get('origin') ?? '').replace(/\/+$/, '');
const root = params.get('root') ?? '';
const video = params.get('video');
const segs = Number(params.get('segs'));
const urlTrackers = [
  ...new Set(params.getAll('tracker').map(trackerUrl).filter((t): t is string => t !== null)),
].slice(0, MAX_TRACKERS);
const iceServers: RTCIceServer[] = params
  .getAll('stun')
  .filter((u) => /^stuns?:(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/.test(u))
  .slice(0, 2)
  .map((urls) => ({ urls }));
/** `&signal=nostr`: the mesh signals through the page's relays, and no tracker. */
const nostrRelays =
  params.get('signal') === 'nostr'
    ? [...new Set(relays.map(relayUrl).filter((r): r is string => r !== null))].slice(0, MAX_RELAYS)
    : [];
/** The mesh over Nostr, or through these trackers, or no mesh. */
const trackerSignaling = (urls: string[]): Signaling | undefined =>
  nostrRelays.length > 0
    ? { kind: 'nostr', relays: nostrRelays }
    : urls.length > 0
      ? { kind: 'trackers', urls }
      : undefined;
const whole = (v: string | null, max: number): number | undefined => {
  const n = Number(v);
  return v !== null && Number.isSafeInteger(n) && n >= 0 && n <= max ? n : undefined;
};
const common = {
  iceServers,
  onEvent,
  httpWindow: whole(params.get('httpWindow'), 600),
  level: whole(params.get('level'), 16),
} satisfies Partial<OpenCommon>;

/** Open a session, and show it in `__nfx`. */
async function play(opts: Parameters<typeof open>[1]): Promise<void> {
  const s = await open($<HTMLVideoElement>('v'), opts);
  session = s;
  const stats = s.stats();
  st.origin = stats.origin;
  st.root = stats.root;
  st.engine = stats.engine;
}

/** Resolve `a` over `relays`, then play from the first origin that serves a verifying copy. */
async function startByAddress(a: string, relays: string[], hint: string | null): Promise<void> {
  const m = await resolveManifest(a, relays);
  st.resolved = { a: m.a, title: m.title, root: m.root, video: m.video, segs: m.segs, created_at: m.created_at };
  log(`manifest "${m.title}" (${m.video}), revision ${m.created_at}, root ${m.root.slice(0, 12)}…`);
  let heard: Endpoints = { origins: [], trackers: [], stunServers: [], seeders: 0 };
  let wake: (() => void) | null = null;
  const stop = watchEndpoints(a, m.namespace, relays, (e) => {
    heard = e;
    for (const o of e.origins) {
      if (!st.origins.includes(o)) {
        st.origins.push(o);
        log(`a seeder names origin ${o}`);
      }
    }
    for (const t of e.trackers) {
      if (!st.beaconTrackers.includes(t)) {
        st.beaconTrackers.push(t);
        log(`a seeder names tracker ${t}`);
      }
    }
    for (const s of e.stunServers) {
      if (!st.beaconStun.includes(s)) {
        st.beaconStun.push(s);
        log(`a seeder names STUN server ${s}`);
      }
    }
    wake?.();
  });
  const tried = new Set<string>();
  let pending = hint ? [hint] : [];
  try {
    const deadline = Date.now() + ORIGIN_WAIT_MS;
    for (;;) {
      const fresh = [...new Set([...pending, ...heard.origins])].filter((o) => !tried.has(o));
      pending = [];
      if (fresh.length > 0) {
        fresh.forEach((o) => tried.add(o));
        // The page's own trackers first, then what seeders named by now.
        const trackers = [...new Set([...urlTrackers, ...heard.trackers])].slice(0, MAX_TRACKERS);
        // Likewise its own STUN servers, then those seeders named (NFX-10 §1).
        const stun = [...iceServers, ...heard.stunServers.map((urls) => ({ urls }))].slice(0, MAX_ICE_SERVERS);
        try {
          await play({ ...common, iceServers: stun, manifestJson: m.event, origins: fresh, signaling: trackerSignaling(trackers) });
          return;
        } catch (e) {
          log(e instanceof Error ? e.message : String(e));
          continue;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('no origin served a verifying copy in time');
      if (heard.origins.length === 0) log('waiting for a seeder beacon that names an https origin…');
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, Math.min(left, 5_000));
      });
      wake = null;
    }
  } finally {
    stop();
  }
}

const fail = (e: Error): void => {
  st.errors.push(e.message);
  log(`error: ${e.message}`);
};

$<HTMLInputElement>('a').value = a;
$<HTMLInputElement>('relay').value = relays[0] ?? '';
$<HTMLInputElement>('origin').value = origin;
$<HTMLInputElement>('root').value = root;
if (a) {
  if (relays.length === 0) fail(new Error('an address needs at least one ws:// or wss:// relay'));
  else init().then(() => startByAddress(a, relays, origin || null)).catch(fail);
} else if (origin && root) {
  const bound = video && Number.isSafeInteger(segs) && segs > 0 ? { video, segs } : {};
  init()
    .then(() => play({ ...common, root, ...bound, origins: [origin], signaling: trackerSignaling(urlTrackers) }))
    .catch(fail);
}
