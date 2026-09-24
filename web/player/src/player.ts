/**
 * The NFX test player. Two ways in:
 *
 * - `?a=<manifest address>&relay=<ws(s) URL>[&relay=…][&origin=<hint>]`: resolve the
 *   current signed manifest over Nostr, then play from an origin named by a verified
 *   beacon's `https` endpoint (or the hint). Signatures give the anchor; endpoints are
 *   only hints.
 * - `?origin=<url>&root=<hex>[&video=<d>&segs=<n>]`: play a known root from a known origin.
 *
 * A loader wrapper checks every playlist, init and segment with nfx-proto (WASM,
 * ./verify.ts) before hls.js sees a byte: a mismatch is a load error, never data.
 * `window.__nfx` exposes state for automation.
 */
import Hls, {
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from 'hls.js';

import { resolveManifest, watchOrigins } from './resolve';
import { Anchor, type ManifestBinding } from './verify';

/** How long to wait for a seeder's beacon to name an origin (beacons republish at TTL/2). */
const ORIGIN_WAIT_MS = 90_000;

interface State {
  secureContext: boolean;
  resolved: { a: string; title: string; root: string; video: string; segs: number; created_at: number } | null;
  origins: string[];
  origin: string | null;
  root: string | null;
  engine: string | null;
  verified: string[];
  rejected: { sha256: string | null; url: string; why: string }[];
  levels: { height: number; bitrate: number }[];
  playing: boolean;
  errors: string[];
}

const st: State = {
  secureContext: window.isSecureContext,
  resolved: null,
  origins: [],
  origin: null,
  root: null,
  engine: null,
  verified: [],
  rejected: [],
  levels: [],
  playing: false,
  errors: [],
};
(window as unknown as { __nfx: State }).__nfx = st;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = $<HTMLPreElement>('log');
const log = (m: string): void => {
  logEl.textContent += `${new Date().toISOString().slice(11, 19)} ${m}\n`;
};

/** Wraps hls.js' default loader: fetch as bytes, verify, then hand over. */
function verifyingLoader(anchor: Anchor): new (config: HlsConfig) => Loader<LoaderContext> {
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
            const why = e instanceof Error ? e.message : String(e);
            let expected: string | null = null;
            try {
              expected = anchor.expected(ctx.url);
            } catch {
              // an unanchored URL is reported with sha256 null
            }
            st.rejected.push({ sha256: expected, url: ctx.url, why });
            log(`REJECTED ${ctx.url}: ${why}`);
            callbacks.onError({ code: 0, text: `nfx: ${why}` }, ctx, details, stats);
            return;
          }
          st.verified.push(sha);
          response.data = wantText ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
          callbacks.onSuccess(response, stats, ctx, details);
        },
      });
    }
  };
}

$<HTMLVideoElement>('v').addEventListener('playing', () => {
  st.playing = true;
});

/** Play `root` from `origin`. Throws if the origin cannot serve a hash list that verifies. */
async function start(origin: string, root: string, manifest?: ManifestBinding): Promise<void> {
  const video = $<HTMLVideoElement>('v');
  const anchor = await Anchor.load(origin, root, manifest);
  st.origin = origin;
  st.root = root;
  log(`hash list verified: ${anchor.size} files of ${anchor.video}${manifest ? ' (bound to the manifest)' : ''}`);
  if (!Hls.isSupported()) {
    // Native HLS would fetch unverified bytes; this player refuses rather than degrade.
    throw new Error('MediaSource unavailable: this player only plays verified bytes');
  }
  st.engine = `hls.js ${Hls.version}`;
  const hls = new Hls({ loader: verifyingLoader(anchor), progressive: false });
  hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
    st.levels = d.levels.map((l) => ({ height: l.height, bitrate: l.bitrate }));
    log(`levels: ${st.levels.map((l) => `${l.height}p`).join(' ')}`);
    video.play().catch((e: unknown) => st.errors.push(`play: ${String(e)}`));
  });
  hls.on(Hls.Events.ERROR, (_, d) => {
    if (d.fatal) {
      st.errors.push(`${d.type}:${d.details}`);
      log(`fatal: ${d.details}`);
    }
  });
  hls.loadSource(`${origin}/${root}/master.m3u8`);
  hls.attachMedia(video);
}

/** Resolve `a` over `relays`, then play from the first origin that serves a verifying copy. */
async function startByAddress(a: string, relays: string[], hint: string | null): Promise<void> {
  const m = await resolveManifest(a, relays);
  st.resolved = { a: m.a, title: m.title, root: m.root, video: m.video, segs: m.segs, created_at: m.created_at };
  log(`manifest "${m.title}" (${m.video}), revision ${m.created_at}, root ${m.root.slice(0, 12)}…`);
  const binding = { video: m.video, segs: m.segs };
  const queue: string[] = hint ? [hint] : [];
  const seen = new Set(queue);
  let wake: (() => void) | null = null;
  const stop = watchOrigins(a, m.namespace, relays, (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    queue.push(url);
    st.origins.push(url);
    log(`a seeder names origin ${url}`);
    wake?.();
  });
  try {
    const deadline = Date.now() + ORIGIN_WAIT_MS;
    for (;;) {
      const next = queue.shift();
      if (next) {
        try {
          await start(next, m.root, binding);
          return;
        } catch (e) {
          log(`origin ${next} did not serve a verifying copy: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('no origin served a verifying copy in time');
      if (queue.length === 0) log('waiting for a seeder beacon that names an https origin…');
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

const params = new URLSearchParams(location.search);
const a = params.get('a') ?? '';
const relays = params.getAll('relay').filter((r) => /^wss?:\/\//.test(r));
const origin = (params.get('origin') ?? '').replace(/\/+$/, '');
const root = params.get('root') ?? '';
const video = params.get('video');
const segs = Number(params.get('segs'));
$<HTMLInputElement>('a').value = a;
$<HTMLInputElement>('relay').value = relays[0] ?? '';
$<HTMLInputElement>('origin').value = origin;
$<HTMLInputElement>('root').value = root;
if (a) {
  if (relays.length === 0) fail(new Error('an address needs at least one ws:// or wss:// relay'));
  else startByAddress(a, relays, origin || null).catch(fail);
} else if (origin && root) {
  const binding = video && Number.isSafeInteger(segs) && segs > 0 ? { video, segs } : undefined;
  start(origin, root, binding).catch(fail);
}
