/**
 * Test fixture for e2e-mesh.ts, never part of the player: a page that drives the shipped
 * library bundle itself (`out-lib/player.js`, minified, served at /lib/player.js, its WASM
 * at /lib/wasm/), so the lifecycle stage tests the bytes the tar carries. e2e-mesh.ts calls
 * `window.__lib` through Playwright.
 */
import type * as Lib from './src/lib';

type LibModule = typeof Lib;
// A variable, so esbuild leaves the import to the browser instead of bundling the source.
const url = '/lib/player.js';
const lib = (await import(url)) as LibModule;
await lib.init();

const video = document.getElementById('v') as HTMLVideoElement;
let session: Lib.Session | null = null;
let control: AbortController | null = null;
const st = { ready: true, playing: false, errors: [] as string[], events: 0 };

interface Opts {
  origins: string[];
  root: string;
  /** WebTorrent trackers, unless `relays` is given. */
  trackers: string[];
  /** Nostr relays (NFX-10 §6): signaling over Nostr instead of trackers. */
  relays?: string[];
  httpWindow?: number;
  level?: number;
}

function signaling(o: { trackers: string[]; relays?: string[] }): Lib.Signaling {
  return o.relays ? { kind: 'nostr', relays: o.relays } : { kind: 'trackers', urls: o.trackers };
}

(window as unknown as { __lib: unknown }).__lib = {
  st,
  async open(opts: Opts): Promise<void> {
    st.playing = false;
    control = new AbortController();
    const { trackers, relays, ...rest } = opts;
    session = await lib.open(video, {
      ...rest,
      signaling: signaling({ trackers, relays }),
      signal: control.signal,
      onEvent: (e) => {
        st.events += 1;
        if (e.type === 'playing') st.playing = true;
        if (e.type === 'error') st.errors.push(e.message);
      },
    });
  },
  /** End the session by `destroy()` (twice: it is idempotent) or by aborting its signal; the event count then. */
  end(how: 'destroy' | 'abort'): number {
    const events = st.events;
    if (how === 'abort') control?.abort();
    else {
      session?.destroy();
      session?.destroy();
    }
    session = null;
    control = null;
    return events;
  },
  /** open(), aborted straight away: it must reject, and leave nothing behind. */
  async openAborted(opts: Opts): Promise<string> {
    const c = new AbortController();
    const { trackers, relays, ...rest } = opts;
    const p = lib.open(video, { ...rest, signaling: signaling({ trackers, relays }), signal: c.signal });
    c.abort();
    try {
      (await p).destroy();
      return 'resolved';
    } catch (e) {
      return e instanceof DOMException ? e.name : String(e);
    }
  },
  state() {
    const s = session?.stats();
    return { t: video.currentTime, playing: st.playing, errors: st.errors, mesh: s?.mesh ?? null, verified: s?.verified ?? 0 };
  },
  element() {
    return { src: video.getAttribute('src'), readyState: video.readyState, networkState: video.networkState };
  },
  events: (): number => st.events,
};
