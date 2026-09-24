/**
 * The A2 test player. `?origin=<url>&root=<hex>` plays `<origin>/<root>/master.m3u8`
 * with hls.js. A loader wrapper checks every playlist, init and segment against the
 * hash list (./verify.ts) before hls.js sees a byte: a mismatch is a load error, never
 * data. `window.__nfx` exposes state for automation.
 */
import Hls, {
  type HlsConfig,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from 'hls.js';

import { Anchor } from './verify';

interface State {
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
          const bytes = response.data as ArrayBuffer;
          anchor.check(ctx.url, bytes).then(
            (sha) => {
              if (stats.aborted) return;
              st.verified.push(sha);
              response.data = wantText ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
              callbacks.onSuccess(response, stats, ctx, details);
            },
            (err: Error) => {
              let sha: string | null = null;
              try {
                sha = anchor.expected(ctx.url);
              } catch {
                // unanchored URL: reported with sha256 null
              }
              st.rejected.push({ sha256: sha, url: ctx.url, why: err.message });
              log(`REJECTED ${ctx.url}: ${err.message}`);
              if (!stats.aborted) callbacks.onError({ code: 0, text: `nfx: ${err.message}` }, ctx, details, stats);
            },
          );
        },
      });
    }
  };
}

async function start(origin: string, root: string): Promise<void> {
  st.origin = origin;
  st.root = root;
  const video = $<HTMLVideoElement>('v');
  video.addEventListener('playing', () => {
    st.playing = true;
  });
  const anchor = await Anchor.load(origin, root);
  log(`hash list verified: ${anchor.files.size} files`);
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

const params = new URLSearchParams(location.search);
const origin = (params.get('origin') ?? '').replace(/\/+$/, '');
const root = params.get('root') ?? '';
$<HTMLInputElement>('origin').value = origin;
$<HTMLInputElement>('root').value = root;
if (origin && root) {
  start(origin, root).catch((e: Error) => {
    st.errors.push(e.message);
    log(`error: ${e.message}`);
  });
}
