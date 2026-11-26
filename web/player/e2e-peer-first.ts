/**
 * Peers first (`segmentSource`, NFX-10 §1), end to end on this machine only (loopback,
 * ephemeral ports): a browser takes its media segments from nfxd's mesh endpoint over WebRTC
 * from the first one, signaled through a STOCK Nostr relay (strfry, as e2e-nostr-node.ts),
 * and the origin serves segments only as a rescue, or never.
 *
 *   ffmpeg 60 s clip → nfx-package → nfxd seeding it: the origin (behind a gate that counts
 *   every segment request and can refuse them all from the start) and the mesh endpoint on
 *   strfry → fresh headless Chromium contexts (never a real profile) on the test page.
 *   1. `peers-only`, the gate refusing every segment from before the page loads: it must play
 *      12 s with no segment over HTTP, none asked of the origin, nothing rejected, and no
 *      socket but to strfry. The time to the first frame is recorded.
 *   2. `peers-then-https` with that peer in the room and a long wait: the same, with the
 *      origin willing: no rescue, and the origin is asked for no segment.
 *   3. `peers-then-https` on a relay where no peer is: `waiting` (no peer), then every
 *      segment a rescue once peers have had their wait, and `resumed`; no error.
 *      Then `setSegmentSource('peers-only')` while it plays, at a moment when a rescue is
 *      still waiting on the origin's answer (held 1.5 s): no segment request begins after
 *      the switch, none is asked of the origin, playback runs out of what it holds and is
 *      `waiting`, with no error;
 *      and back to `peers-then-https`: it is `resumed` and plays on.
 *   4. A browser whose WebRTC cannot use UDP: the page says so (`blocked`); with
 *      `peers-then-https` and a wait of 20 s it plays within a few seconds all the same (the
 *      wait ends when the check does); with `peers-only` it waits, and nothing fails.
 *
 * Usage: STRFRY=<strfry binary> STRFRY_CONF=<its strfry.conf> npm run e2e:peer-first
 * (after npm run build). Every process it starts runs in its own process group, and only
 * those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { type AddressInfo, connect as tcpConnect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const crates = resolve(here, '../../crates');
const bin = (name: string): string => join(crates, 'target/debug', name);
const ffmpeg = process.env.NFX_FFMPEG ?? 'ffmpeg';
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: see the usage at the top of e2e-peer-first.ts`);
  return resolve(v);
};
const work = mkdtempSync(join(tmpdir(), 'nfx-peer-first-e2e-'));
chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const servers: Server[] = [];

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status}): ${r.stderr.slice(-2000)}`);
  return r.stdout;
}

interface Started {
  child: ChildProcess;
  matches: RegExpExecArray[];
  text: () => string;
}

function start(cmd: string, args: string[], waitFor: RegExp[]): Promise<Started> {
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let text = '';
  const take = (chunk: Buffer): void => {
    text += chunk.toString();
  };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  return new Promise((ok, fail) => {
    const timer = setInterval(() => {
      const matches = waitFor.map((re) => re.exec(text));
      if (matches.every(Boolean)) {
        clearInterval(timer);
        ok({ child, matches: matches as RegExpExecArray[], text: () => text });
      }
    }, 100);
    setTimeout(() => {
      clearInterval(timer);
      fail(new Error(`${cmd} never printed ${waitFor.join(', ')}:\n${text.slice(-4000)}`));
    }, 60_000);
    child.on('exit', (code) => fail(new Error(`${cmd} exited ${code}:\n${text.slice(-4000)}`)));
  });
}

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
}

/** A port nobody holds right now (strfry takes its port from its config). */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createTcpServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => ok(port));
    });
  });
}

async function waitPort(port: number, log: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const open = await new Promise<boolean>((ok) => {
      const sock = tcpConnect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        ok(true);
      });
      sock.once('error', () => ok(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`nothing listens on ${port}:\n${log().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function pageServer(): Promise<string> {
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/player.css': ['player.css', 'text/css'],
    '/out/player.js': ['out/player.js', 'text/javascript'],
    '/out/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
  };
  const port = await listen(
    createServer((req, res) => {
      const f = files[new URL(req.url ?? '/', 'http://x').pathname];
      if (!f) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f[1] }).end(readFileSync(join(here, f[0])));
    }),
  );
  return `http://127.0.0.1:${port}`;
}

/** The origin behind a switch that counts: every segment request, and (once `block` is on) refuses them. */
async function gate(upstream: string): Promise<{ url: string; block: () => void; open: () => void; delay: (ms: number) => void; asked: () => number; refused: () => number; reset: () => void }> {
  let blocked = false;
  // Held this long before a segment is answered (0: at once), so a request can be in flight across a switch.
  let delayMs = 0;
  let asked = 0;
  let refused = 0;
  const port = await listen(
    createServer((req, res) => {
      if ((req.url ?? '').endsWith('.m4s')) {
        asked += 1;
        if (blocked) {
          refused += 1;
          return res.writeHead(503, { 'cache-control': 'no-store' }).end();
        }
      }
      const go = (): void => {
        const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on('error', () => res.writeHead(502).end());
        up.end();
      };
      if (delayMs > 0 && (req.url ?? '').endsWith('.m4s')) setTimeout(go, delayMs);
      else go();
    }),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    block: () => (blocked = true),
    open: () => (blocked = false),
    delay: (ms: number) => (delayMs = ms),
    asked: () => asked,
    refused: () => refused,
    reset: () => {
      asked = 0;
      refused = 0;
    },
  };
}

interface View {
  playing: boolean;
  t: number;
  errors: string[];
  waits: string[];
  rescues: string[];
  blocked: string | null;
  mesh: any;
}

const state = (p: Page): Promise<View> =>
  p.evaluate(() => {
    const s = (window as any).__nfx;
    return {
      playing: s.playing as boolean,
      t: (document.querySelector('video') as HTMLVideoElement).currentTime,
      errors: s.errors as string[],
      waits: s.waits as string[],
      rescues: s.rescues as string[],
      blocked: s.blocked as string | null,
      mesh: s.mesh,
    };
  });

async function main(): Promise<void> {
  const strfryBin = need('STRFRY');
  const strfryConf = need('STRFRY_CONF');
  if (!existsSync(join(here, 'out/player.js'))) throw new Error('no out/player.js: run npm run build first');
  run('cargo', ['build', '--locked', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'nfxd', '-p', 'nfx-media', '--bins']);

  // ---- the stock relay ----
  const relayPort = await freePort();
  mkdirSync(join(work, 'strfry-db'));
  const conf = readFileSync(strfryConf, 'utf8')
    .replace(/^db = "\.\/strfry-db\/"$/m, `db = "${join(work, 'strfry-db')}/"`)
    .replace(/^(\s*)port = 7777$/m, `$1port = ${relayPort}`)
    .replace(/^(\s*)nofiles = [0-9]+$/m, '$1nofiles = 0');
  if (!conf.includes(`port = ${relayPort}`) || !conf.includes(join(work, 'strfry-db'))) throw new Error('strfry.conf: db or port not found');
  writeFileSync(join(work, 'strfry.conf'), conf);
  const strfry = await start(strfryBin, [`--config=${join(work, 'strfry.conf')}`, 'relay'], []);
  await waitPort(relayPort, () => strfry.text());
  const relay = `ws://127.0.0.1:${relayPort}`;

  // ---- the video, and the node: origin, no tracker, the mesh endpoint on strfry ----
  const clip = join(work, 'clip.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const pkg = join(work, 'pkg');
  run(bin('nfx-package'), [clip, '--video', 'nfx:testnet:1:peer-first-e2e', '--out', pkg, '--max-height', '720', '--preset', 'veryfast']);
  const meta = JSON.parse(readFileSync(join(pkg, 'nfx.json'), 'utf8')) as { root: string; video: string };
  const key = join(work, 'node.key');
  const pubkey = run(bin('nfxd'), ['key', 'new', key]).split('\n')[0]!;
  const a = `38504:${pubkey}:${meta.video}`;
  const node = await start(
    bin('nfxd'),
    [
      'run', '--key', key, '--store', join(pkg, 'store'), '--seed', a, '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0',
      '--mesh-relay', relay, '--mesh-bind', '127.0.0.1:0',
    ],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/, /mesh: udp \S+, session ([0-9a-f]{64})/],
  );
  const nodeRelay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  run(bin('nfxd'), ['publish', '--key', key, '--relay', nodeRelay, '--package', pkg, '--title', 'Peer first e2e']);
  const seedBy = Date.now() + 60_000;
  while (!node.text().includes(`${a}: Seeding`) || !/^mesh: 1 room/m.test(node.text())) {
    if (Date.now() > seedBy) throw new Error(`never seeding in a room:\n${node.text().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const g = await gate(origin);
  const pages = await pageServer();
  const results: Record<string, unknown> = { root: meta.root, relay };

  /** One page in a fresh context of `browser`; `until` decides when the case is over. */
  async function view(
    browser: Browser,
    name: string,
    query: string,
    until: string,
    timeout: number,
    // Kept open this long after `until` before the snapshot, so what the page does then is seen.
    settleMs = 0,
  ): Promise<{ v: View; firstFrameMs: number | null; sockets: string[]; asked: number }> {
    const sockets: string[] = [];
    const consoles: string[] = [];
    const p = await (await browser.newContext()).newPage();
    p.on('websocket', (w) => sockets.push(w.url()));
    p.on('console', (m) => {
      if (consoles.length < 200) consoles.push(`${m.type()}: ${m.text().slice(0, 300)}`);
    });
    p.on('pageerror', (e) => consoles.push(`pageerror: ${e.message}`));
    const t0 = Date.now();
    let firstFrameMs: number | null = null;
    try {
      await p.goto(`${pages}/?origin=${encodeURIComponent(g.url)}&root=${meta.root}&signal=nostr&level=0&${query}`);
      const playing = p.waitForFunction(() => (window as any).__nfx.playing === true, null, { timeout }).then(
        () => {
          firstFrameMs = Date.now() - t0;
        },
        () => undefined,
      );
      await p.waitForFunction(until, null, { timeout });
      await Promise.race([playing, new Promise((r) => setTimeout(r, 200))]);
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      // The origin's count is read with the page still open, after the settle time.
      const v = await state(p);
      return { v, firstFrameMs, sockets, asked: g.asked() };
    } catch (e) {
      const page = await p
        .evaluate(() => ({ log: (document.getElementById('log')?.textContent ?? '').slice(-6000), state: (window as any).__nfx }))
        .catch((x: unknown) => String(x));
      throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}\n--- diagnostics ---\n${JSON.stringify({ page, consoles, asked: g.asked(), refused: g.refused(), node: node.text().slice(-4000) }, null, 1)}`);
    } finally {
      await p.context().close();
    }
  }
  const played = (seconds: number): string =>
    `(() => { const s = window.__nfx; return s.errors.length > 0 || (s.playing && document.querySelector('video').currentTime > ${seconds}); })()`;
  const onlyRelay = (sockets: string[], want: string): string[] => sockets.filter((u) => u.replace(/\/$/, '') !== want).map((u) => `the page opened a socket to ${u}`);
  const fail = (name: string, problems: string[], got: unknown): void => {
    const real = problems.filter(Boolean);
    if (real.length > 0) throw new Error(`${name}: ${real.join('; ')}: ${JSON.stringify(got)}`);
  };

  const browser = await chromium.launch({ headless: true });
  try {
    // ---- 1. peers only: the origin refuses every segment from the start ----
    g.block();
    const one = await view(browser, 'peers-only', `relay=${encodeURIComponent(relay)}&segmentSource=peers-only`, played(12), 120_000);
    results.peersOnly = { firstFrameMs: one.firstFrameMs, t: one.v.t, segments: one.v.mesh?.segments, bytes: one.v.mesh?.bytes, startup: one.v.mesh?.startup, originAsked: g.asked(), waits: one.v.waits };
    fail('peers-only', [
      one.v.errors.length !== 0 ? `errors ${JSON.stringify(one.v.errors)}` : '',
      !(one.v.t > 12) ? 'did not play 12 s from peers alone' : '',
      one.v.mesh?.source !== 'peers-only' ? `source ${one.v.mesh?.source}` : '',
      one.v.mesh?.segments?.http !== 0 ? `${one.v.mesh?.segments?.http} segments over HTTP` : '',
      one.v.mesh?.bytes?.http !== 0 ? `${one.v.mesh?.bytes?.http} segment bytes over HTTP` : '',
      !(one.v.mesh?.segments?.p2p > 0) ? 'no segment from a peer' : '',
      g.asked() !== 0 ? `the origin was asked for ${g.asked()} segments` : '',
      one.v.mesh?.rescues !== 0 ? `${one.v.mesh?.rescues} rescues` : '',
      one.v.rescues.length !== 0 ? 'a rescue event' : '',
      (one.v.mesh?.rejected ?? []).length !== 0 ? `rejected ${JSON.stringify(one.v.mesh.rejected)}` : '',
      one.v.mesh?.webrtc !== 'ok' ? `WebRTC check: ${one.v.mesh?.webrtc}` : '',
      one.v.blocked !== null ? `blocked: ${one.v.blocked}` : '',
      typeof one.v.mesh?.startup?.peerSegmentMs !== 'number' ? 'the first segment from a peer was not timed' : '',
      ...onlyRelay(one.sockets, relay),
    ], results.peersOnly);

    // ---- 2. peers, then HTTPS, with the peer there: no rescue, the origin asked for nothing ----
    g.open();
    g.reset();
    const two = await view(browser, 'peers-then-https', `relay=${encodeURIComponent(relay)}&segmentSource=peers-then-https&peerWaitMs=20000`, played(12), 120_000);
    results.peersThenHttps = { firstFrameMs: two.firstFrameMs, t: two.v.t, segments: two.v.mesh?.segments, rescues: two.v.mesh?.rescues, startup: two.v.mesh?.startup, originAsked: g.asked() };
    fail('peers-then-https', [
      two.v.errors.length !== 0 ? `errors ${JSON.stringify(two.v.errors)}` : '',
      !(two.v.t > 12) ? 'did not play 12 s' : '',
      two.v.mesh?.source !== 'peers-then-https' ? `source ${two.v.mesh?.source}` : '',
      two.v.mesh?.segments?.http !== 0 ? `${two.v.mesh?.segments?.http} segments over HTTP` : '',
      two.v.mesh?.rescues !== 0 || two.v.rescues.length !== 0 ? `${two.v.mesh?.rescues} rescues` : '',
      g.asked() !== 0 ? `the origin was asked for ${g.asked()} segments` : '',
      !(two.v.mesh?.segments?.p2p > 0) ? 'no segment from a peer' : '',
      (two.v.mesh?.rejected ?? []).length !== 0 ? `rejected ${JSON.stringify(two.v.mesh.rejected)}` : '',
    ], results.peersThenHttps);

    // ---- 3. peers, then HTTPS, with no peer to meet: a wait, then rescues ----
    g.reset();
    const three = await view(browser, 'no peer', `relay=${encodeURIComponent(nodeRelay)}&segmentSource=peers-then-https`, played(12), 120_000);
    results.noPeer = { firstFrameMs: three.firstFrameMs, t: three.v.t, segments: three.v.mesh?.segments, rescues: three.v.mesh?.rescues, startup: three.v.mesh?.startup, waits: three.v.waits, originAsked: g.asked() };
    fail('no peer', [
      three.v.errors.length !== 0 ? `errors ${JSON.stringify(three.v.errors)}` : '',
      !(three.v.t > 12) ? 'did not play 12 s by rescues' : '',
      three.v.mesh?.segments?.p2p !== 0 ? 'a segment from a peer, with no peer' : '',
      !(three.v.mesh?.rescues > 0) || three.v.mesh?.rescues !== three.v.mesh?.segments?.http ? `rescues ${three.v.mesh?.rescues} of ${three.v.mesh?.segments?.http} HTTP segments` : '',
      three.v.rescues.length !== three.v.mesh?.rescues ? 'rescue events and the counter differ' : '',
      !(three.v.mesh?.startup?.segmentMs >= 3500) ? `the first segment came after ${three.v.mesh?.startup?.segmentMs} ms: peers did not get their 4 s` : '',
      three.v.waits[0] !== 'waiting:no-peer' || three.v.waits[1] !== 'resumed' ? `waits ${JSON.stringify(three.v.waits)}` : '',
      three.v.mesh?.webrtc !== 'ok' ? `WebRTC check: ${three.v.mesh?.webrtc}` : '',
    ], results.noPeer);

    // ---- 3b. HTTPS switched off while it plays, and on again ----
    g.reset();
    const ctx3b = await browser.newContext();
    // Every segment request the page starts of the origin, on the page's own clock, recorded when
    // it starts: one still in flight is seen as well as one that has finished. The engine asks
    // with `window.fetch` (p2p-media-loader-core http-loader.ts).
    await ctx3b.addInitScript((origin: string) => {
      const starts: { t: number; done: number | null }[] = [];
      (window as any).__nfxSegmentStarts = starts;
      const real = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(origin) || !(url.split('?')[0] ?? '').endsWith('.m4s')) return real(input, init);
        const rec = { t: performance.now(), done: null as number | null };
        starts.push(rec);
        const r = real(input, init);
        r.then(() => (rec.done = performance.now()), () => (rec.done = performance.now()));
        return r;
      };
    }, g.url);
    const p = await ctx3b.newPage();
    try {
      await p.goto(`${pages}/?origin=${encodeURIComponent(g.url)}&root=${meta.root}&signal=nostr&level=0&relay=${encodeURIComponent(nodeRelay)}&segmentSource=peers-then-https&peerWaitMs=500`);
      await p.waitForFunction(played(4), null, { timeout: 120_000 });
      // Origin answers held 1.5 s from here. The page switches as soon as one of its rescues is
      // waiting on such an answer, in the same task that sees it, so a request is in flight
      // across the switch: it counts as begun before, and nothing may begin after.
      g.delay(1_500);
      const heldFrom = await p.evaluate(() => performance.now());
      // The page's clock just BEFORE the switch: a request begun during the call counts as after.
      const switchedAt = await p.evaluate((from: number) => new Promise<number>((resolve, reject) => {
        const starts = (window as any).__nfxSegmentStarts as { t: number; done: number | null }[];
        const until = performance.now() + 30_000;
        // No named function in here: tsx (esbuild keepNames) would wrap it in a `__name` the page lacks.
        const timer = setInterval(() => {
          if (starts.some((s) => s.t >= from && s.done === null)) {
            clearInterval(timer);
            const t = performance.now();
            (window as any).__nfxSegmentSource('peers-only');
            resolve(t);
          } else if (performance.now() > until) {
            clearInterval(timer);
            reject(new Error('no rescue waiting on the origin within 30 s'));
          }
        }, 20);
      }), heldFrom);
      // A download already under way may still finish before the page's own counter is read.
      await new Promise((r) => setTimeout(r, 2_500));
      const off = await state(p);
      const askedAtOff = g.asked();
      await p.waitForFunction(() => { const s = (window as any).__nfx; return s.errors.length > 0 || s.waits[s.waits.length - 1] === 'waiting:no-peer'; }, null, { timeout: 90_000 });
      const starved = await state(p);
      const askedWhileOff = g.asked() - askedAtOff;
      // Segment requests of the origin the page began after the switch (ms after it), and those
      // begun before it that were still in flight at it.
      const { startedAfterSwitch, inFlightAcross } = await p.evaluate((at: number) => {
        const starts = (window as any).__nfxSegmentStarts as { t: number; done: number | null }[];
        return {
          startedAfterSwitch: starts.filter((s) => s.t >= at).map((s) => Math.round(s.t - at)),
          inFlightAcross: starts.filter((s) => s.t < at && (s.done === null || s.done > at)).length,
        };
      }, switchedAt);
      g.delay(0);
      await p.evaluate(() => (window as any).__nfxSegmentSource('peers-then-https'));
      await p.waitForFunction((t: number) => { const s = (window as any).__nfx; return s.errors.length > 0 || (s.waits[s.waits.length - 1] === 'resumed' && (document.querySelector('video') as HTMLVideoElement).currentTime > t + 3); }, starved.t, { timeout: 60_000 });
      const on = await state(p);
      results.switched = { off: { t: off.t, http: off.mesh?.segments?.http }, starved: { t: starved.t, http: starved.mesh?.segments?.http, waits: starved.waits }, askedWhileOff, startedAfterSwitch, inFlightAcross, on: { t: on.t, http: on.mesh?.segments?.http, source: on.mesh?.source } };
      fail('switch', [
        [...off.errors, ...starved.errors, ...on.errors].length !== 0 ? `errors ${JSON.stringify([...off.errors, ...starved.errors, ...on.errors])}` : '',
        starved.mesh?.source !== 'peers-only' ? `source ${starved.mesh?.source} after switching HTTPS off` : '',
        starved.mesh?.segments?.http !== off.mesh?.segments?.http ? `segments over HTTP went from ${off.mesh?.segments?.http} to ${starved.mesh?.segments?.http} with HTTPS off` : '',
        askedWhileOff !== 0 ? `the origin was asked for ${askedWhileOff} segments with HTTPS off` : '',
        startedAfterSwitch.length !== 0 ? `the page started ${startedAfterSwitch.length} segment requests after the switch (${startedAfterSwitch.join(', ')} ms after it)` : '',
        inFlightAcross < 1 ? 'no segment request of the origin was in flight at the switch' : '',
        starved.waits[starved.waits.length - 1] !== 'waiting:no-peer' ? `waits ${JSON.stringify(starved.waits)}` : '',
        on.mesh?.source !== 'peers-then-https' ? `source ${on.mesh?.source} after switching HTTPS on` : '',
        !(on.mesh?.segments?.http > starved.mesh?.segments?.http) ? 'no rescue after switching HTTPS back on' : '',
        !(on.t > starved.t + 3) ? 'did not play on after switching HTTPS back on' : '',
      ], results.switched);
    } catch (e) {
      const page = await p.evaluate(() => ({ log: (document.getElementById('log')?.textContent ?? '').slice(-6000), state: (window as any).__nfx })).catch((x: unknown) => String(x));
      throw new Error(`switch: ${e instanceof Error ? e.message : String(e)}\n--- diagnostics ---\n${JSON.stringify({ page, asked: g.asked() }, null, 1)}`);
    } finally {
      await p.context().close();
    }
  } finally {
    await browser.close();
  }

  // ---- 4. a browser whose WebRTC cannot use UDP ----
  const noUdp = await chromium.launch({ headless: true, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  try {
    g.reset();
    const four = await view(noUdp, 'blocked, peers-then-https', `relay=${encodeURIComponent(relay)}&segmentSource=peers-then-https&peerWaitMs=20000`, played(6), 120_000);
    results.blocked = { firstFrameMs: four.firstFrameMs, why: four.v.blocked, webrtc: four.v.mesh?.webrtc, rescues: four.v.mesh?.rescues, startup: four.v.mesh?.startup };
    fail('blocked, peers-then-https', [
      four.v.errors.length !== 0 ? `errors ${JSON.stringify(four.v.errors)}` : '',
      four.v.blocked === null || four.v.mesh?.webrtc !== 'blocked' ? `not reported as blocked (${four.v.mesh?.webrtc})` : '',
      !(four.v.t > 6) ? 'did not play' : '',
      !(four.v.mesh?.rescues > 0) ? 'no rescue' : '',
      four.v.mesh?.segments?.p2p !== 0 ? 'a segment from a peer through blocked WebRTC' : '',
      !(four.v.mesh?.startup?.segmentMs < 15_000) ? `the first segment came after ${four.v.mesh?.startup?.segmentMs} ms: the 20 s wait did not end with the check` : '',
    ], results.blocked);

    g.block();
    g.reset();
    const five = await view(
      noUdp,
      'blocked, peers-only',
      `relay=${encodeURIComponent(relay)}&segmentSource=peers-only`,
      `(() => { const s = window.__nfx; return s.errors.length > 0 || (s.blocked !== null && s.waits.length > 0); })()`,
      60_000,
      3_000,
    );
    results.blockedPeersOnly = { why: five.v.blocked, waits: five.v.waits, playing: five.v.playing, originAsked: five.asked };
    fail('blocked, peers-only', [
      five.v.errors.length !== 0 ? `errors ${JSON.stringify(five.v.errors)}` : '',
      five.v.blocked === null ? 'not reported as blocked' : '',
      five.v.waits[0] !== 'waiting:no-peer' ? `waits ${JSON.stringify(five.v.waits)}` : '',
      five.v.playing ? 'it played, with no peer and no HTTPS' : '',
      five.asked !== 0 ? `the origin was asked for ${five.asked} segments` : '',
    ], results.blockedPeersOnly);
  } finally {
    await noUdp.close();
  }
  console.log(JSON.stringify(results, null, 2));
}

function cleanup(): void {
  for (const s of servers) s.close();
  for (const c of children) {
    if (c.pid && c.exitCode === null && c.signalCode === null) {
      try {
        process.kill(-c.pid, 'SIGTERM'); // our own process group only
      } catch {
        // already gone
      }
    }
  }
  rmSync(work, { recursive: true, force: true }); // includes the throwaway node key
}

main().then(
  () => {
    cleanup();
    console.log('peer first e2e: PASS');
    process.exit(0);
  },
  (e: Error) => {
    cleanup();
    console.error(`peer first e2e: FAIL\n${e.stack ?? e.message}`);
    process.exit(1);
  },
);
