/**
 * NFX-10 browser mesh, end to end, on this machine only (loopback, ephemeral ports):
 *
 *   ffmpeg 60 s clip → nfx-package → nfxd (embedded scoped relay + origin + embedded
 *   tracker + seeding) → two fresh headless Chromium contexts (never a real profile):
 *   - E, a peer that shares whatever its origin gave it (e2e-peer.ts), fed by a lying
 *     origin that flips one byte of one segment of the lowest rendition;
 *   - B, the real player on the honest origin, with a 2 s HTTP window so most segments
 *     come from peers.
 *   B must receive segment bytes over WebRTC, reject exactly the tampered segment (from
 *   the peer), and play past it. nfxd's tracker must refuse a swarm it does not hold.
 *
 *   Then the bridge: a second nfxd with `--bridge` (a native WebRTC peer, str0m). A viewer
 *   plays through a gate that, once playback has started, refuses every segment: the rest
 *   of the video can only come from the bridge, over WebRTC, from nfxd's verified store.
 *
 *   The library's lifecycle, on the shipped bundle (out-lib/player.js, e2e-lib.ts): three
 *   rounds of open, play over the mesh, destroy, each ending with no socket, peer
 *   connection, worker, interval or timer left, nothing fetched afterwards, no event
 *   delivered and the element emptied; and an open() aborted at once rejects and leaves
 *   nothing either.
 *
 *   Then the bridge again, found the way a viewer with no settings finds it: by address,
 *   with no tracker and no origin in the URL. The bridged node's beacon names its tracker
 *   (`--tracker-url`, wss) and its origin (`--https-url`), both behind a throwaway TLS
 *   front; the player must take both from the beacon, and play on from the bridge once the
 *   origin refuses segments.
 *
 * Usage: npm run build && npm run build:lib && npm run e2e:mesh
 * Every process it starts runs in its own process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { type AddressInfo, connect as tcpConnect } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const crates = resolve(here, '../../crates');
const bin = (name: string): string => join(crates, 'target/debug', name);
const ffmpeg = process.env.NFX_FFMPEG ?? 'ffmpeg';
const work = mkdtempSync(join(tmpdir(), 'nfx-mesh-e2e-'));
chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const servers: Server[] = [];

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status}): ${r.stderr.slice(-2000)}`);
  return r.stdout;
}

function start(cmd: string, args: string[], waitFor: RegExp[]): Promise<{ child: ChildProcess; matches: RegExpExecArray[]; text: () => string }> {
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let text = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
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
      fail(new Error(`${cmd} never printed ${waitFor.join(', ')}:\n${text}`));
    }, 60_000);
    child.on('exit', (code) => fail(new Error(`${cmd} exited ${code}:\n${text}`)));
  });
}

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
}

async function pageServer(): Promise<string> {
  const peerHtml = '<!doctype html><meta charset="utf-8"><video id="v" muted></video><script type="module" src="/out/e2e-peer.js"></script>';
  const libHtml = '<!doctype html><meta charset="utf-8"><video id="v" muted></video><script type="module" src="/out/e2e-lib.js"></script>';
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/player.css': ['player.css', 'text/css'],
    '/out/player.js': ['out/player.js', 'text/javascript'],
    // Test fixtures: built outside out/, so the player's own server never serves them.
    '/out/e2e-peer.js': ['out-e2e/e2e-peer.js', 'text/javascript'],
    '/out/e2e-lib.js': ['out-e2e/e2e-lib.js', 'text/javascript'],
    '/out/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
    // The library as the tar ships it (npm run build:lib).
    '/lib/player.js': ['out-lib/player.js', 'text/javascript'],
    '/lib/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
  };
  const port = await listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/peer') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(peerHtml);
      if (path === '/lib') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(libHtml);
      const f = files[path];
      if (!f) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f[1] }).end(readFileSync(join(here, f[0])));
    }),
  );
  return `http://127.0.0.1:${port}`;
}

/** A lying origin: proxies `upstream`, flipping the first byte of one segment. */
async function liar(upstream: string, victim: string): Promise<string> {
  const port = await listen(
    createServer((req, res) => {
      const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          const body = Buffer.concat(chunks);
          const name = ((req.url ?? '').split('/').pop() ?? '').split('.')[0];
          if (name === victim && body.length > 0) body[0] = (body[0] ?? 0) ^ 0xff;
          res.writeHead(r.statusCode ?? 502, r.headers).end(body);
        });
      });
      up.on('error', () => res.writeHead(502).end());
      up.end();
    }),
  );
  return `http://127.0.0.1:${port}`;
}

/** The honest origin behind a switch: once `block` is on, every segment is refused. */
async function gate(upstream: string): Promise<{ url: string; block: () => void; refused: () => number }> {
  let blocked = false;
  let refused = 0;
  const port = await listen(
    createServer((req, res) => {
      if (blocked && (req.url ?? '').endsWith('.m4s')) {
        refused += 1;
        return res.writeHead(503, { 'cache-control': 'no-store' }).end();
      }
      const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      up.end();
    }),
  );
  return { url: `http://127.0.0.1:${port}`, block: () => (blocked = true), refused: () => refused };
}

/** One announce to the tracker; its reply. */
function announce(tracker: string, infoHash: string): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(tracker);
    const timer = setTimeout(() => fail(new Error('tracker never answered')), 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ action: 'announce', info_hash: infoHash, peer_id: '-PM0400-e2eprobe0000', numwant: 0, offers: [], event: 'started' }));
    ws.onmessage = (m) => {
      clearTimeout(timer);
      ws.close();
      ok(JSON.parse(String(m.data)) as Record<string, unknown>);
    };
    ws.onerror = () => fail(new Error('tracker socket error'));
  });
}

/**
 * A TLS front with a throwaway self-signed certificate for 127.0.0.1 (in the work dir,
 * deleted with it): plain TCP to `upstream` once that is set, so it carries https and wss.
 */
async function tlsFront(): Promise<{ port: number; setUpstream: (port: number) => void }> {
  const key = join(work, 'tls.key');
  const cert = join(work, 'tls.crt');
  if (!existsSync(cert)) {
    run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  }
  let upstream = 0;
  const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (sock) => {
    if (upstream === 0) return void sock.destroy();
    const up = tcpConnect(upstream, '127.0.0.1');
    sock.pipe(up);
    up.pipe(sock);
    sock.on('error', () => up.destroy());
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
    up.on('close', () => sock.destroy());
  });
  servers.push(server as unknown as Server);
  const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
  return { port, setUpstream: (p) => (upstream = p) };
}

/**
 * Installed before any page script (plain JS: it runs in the page as written): counts the
 * sockets, peer connections, workers, intervals and timeouts the page opened and has not
 * closed, for `window.__leaks()`.
 */
const LEAK_PROBE = `(() => {
  const sockets = new Set(), peers = new Set(), workers = new Set(), intervals = new Set(), timeouts = new Map();
  const WS = window.WebSocket;
  window.WebSocket = class extends WS { constructor(...a) { super(...a); sockets.add(this); } };
  const PC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends PC { constructor(...a) { super(...a); peers.add(this); } };
  const WK = window.Worker;
  window.Worker = class extends WK {
    constructor(...a) { super(...a); workers.add(this); }
    terminate() { workers.delete(this); super.terminate(); }
  };
  const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window);
  const st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window);
  window.setInterval = (f, ms, ...r) => { const id = si(f, ms, ...r); intervals.add(id); return id; };
  window.setTimeout = (f, ms, ...r) => {
    const id = st((...x) => { timeouts.delete(id); if (typeof f === 'function') f(...x); }, ms, ...r);
    timeouts.set(id, ms || 0);
    return id;
  };
  // The two clear functions share one id space.
  window.clearInterval = (id) => { intervals.delete(id); timeouts.delete(id); ci(id); };
  window.clearTimeout = (id) => { intervals.delete(id); timeouts.delete(id); ct(id); };
  window.__leaks = () => ({
    sockets: [...sockets].filter((s) => s.readyState === 0 || s.readyState === 1).map((s) => s.url),
    peers: [...peers].filter((p) => p.connectionState !== 'closed' && p.signalingState !== 'closed').length,
    workers: workers.size,
    intervals: intervals.size,
    timeouts: [...timeouts.values()].sort((x, y) => x - y),
  });
})();`;

interface Leaks {
  sockets: string[];
  peers: number;
  workers: number;
  intervals: number;
  timeouts: number[];
}

/** Wait (at most 30 s) until the page holds no more than `baseline`; return what it holds. */
async function settleLeaks(page: import('playwright').Page, baseline: Leaks): Promise<{ ok: boolean; held: Leaks }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const held = (await page.evaluate(() => (window as any).__leaks())) as Leaks;
    const ok =
      held.sockets.length === 0 &&
      held.peers === 0 &&
      held.workers <= baseline.workers &&
      held.intervals <= baseline.intervals &&
      held.timeouts.length <= baseline.timeouts.length;
    if (ok || Date.now() > deadline) return { ok, held };
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Requests and websockets `page` starts during the next `ms`. */
async function quiet(page: import('playwright').Page, ms: number): Promise<string[]> {
  const seen: string[] = [];
  const onRequest = (r: { url(): string }): void => void seen.push(`request ${r.url()}`);
  const onSocket = (w: { url(): string }): void => void seen.push(`websocket ${w.url()}`);
  page.on('request', onRequest);
  page.on('websocket', onSocket);
  await page.waitForTimeout(ms);
  page.off('request', onRequest);
  page.off('websocket', onSocket);
  return seen;
}

async function main(): Promise<void> {
  if (!existsSync(join(here, 'out-lib/player.js'))) throw new Error('no out-lib/player.js: run npm run build:lib first');
  run('cargo', ['build', '--locked', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'nfxd', '-p', 'nfx-media', '--bins']);
  const clip = join(work, 'clip.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const pkg = join(work, 'pkg');
  run(bin('nfx-package'), [clip, '--video', 'nfx:testnet:1:mesh-e2e', '--out', pkg, '--max-height', '720', '--preset', 'veryfast']);
  const meta = JSON.parse(readFileSync(join(pkg, 'nfx.json'), 'utf8')) as { root: string; video: string };
  const store = join(pkg, 'store');
  const list = JSON.parse(readFileSync(join(store, meta.root), 'utf8')) as {
    files: { name: string; role: string; sha256: string }[];
    renditions: { id: string; playlist: string; bandwidth: number }[];
  };
  // The victim: segment #5 of the lowest rendition (level 0 in hls.js).
  const low = [...list.renditions].sort((x, y) => x.bandwidth - y.bandwidth)[0]!;
  const playlist = list.files.find((f) => f.name === low.playlist)!;
  const uris = readFileSync(join(store, playlist.sha256), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  const victim = uris[5]!.split('.')[0]!;

  const key = join(work, 'node.key');
  const pubkey = run(bin('nfxd'), ['key', 'new', key]).split('\n')[0]!;
  const a = `38504:${pubkey}:${meta.video}`;
  const node = await start(
    bin('nfxd'),
    ['run', '--key', key, '--store', store, '--seed', a, '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0', '--embed-tracker', '127.0.0.1:0'],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/, /embedded tracker: (ws:\/\/\S+)/],
  );
  const relay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  const tracker = node.matches[2]![1]!;
  run(bin('nfxd'), ['publish', '--key', key, '--relay', relay, '--package', pkg, '--title', 'Mesh e2e']);
  const deadline = Date.now() + 60_000;
  while (!node.text().includes(`${a}: Seeding`)) {
    if (Date.now() > deadline) throw new Error(`never seeding:\n${node.text()}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // The tracker holds this video's swarms and nothing else.
  const refused = await announce(tracker, 'AAAAAAAAAAAAAAAAAAAA');
  if (!String(refused['failure reason'] ?? '').includes('not an NFX swarm')) throw new Error(`foreign swarm: ${JSON.stringify(refused)}`);

  const pages = await pageServer();
  const lying = await liar(origin, victim);
  const browser = await chromium.launch({ headless: true });
  const results: Record<string, unknown> = { root: meta.root, victim, tracker };
  try {
    // E first, so it holds segments before B asks.
    const e = await (await browser.newContext()).newPage();
    await e.goto(`${pages}/peer?origin=${encodeURIComponent(lying)}&root=${meta.root}&tracker=${encodeURIComponent(tracker)}`);
    await e.waitForFunction(() => (window as any).__peer?.ready, null, { timeout: 30_000 });
    await e.waitForTimeout(8_000);

    const b = await (await browser.newContext()).newPage();
    await b.goto(`${pages}/?origin=${encodeURIComponent(origin)}&root=${meta.root}&tracker=${encodeURIComponent(tracker)}&httpWindow=2&level=0`);
    await b.waitForFunction(
      () => {
        const s = (window as any).__nfx;
        const v = document.querySelector('video') as HTMLVideoElement;
        return s.errors.length > 0 || (s.playing && v.currentTime > 14);
      },
      null,
      { timeout: 120_000 },
    );
    const viewer = await b.evaluate(() => {
      const s = (window as any).__nfx;
      return { playing: s.playing, t: (document.querySelector('video') as HTMLVideoElement).currentTime, errors: s.errors, engine: s.engine, mesh: s.mesh };
    });
    const peer = await e.evaluate(() => (window as any).__peer);
    results.viewer = viewer;
    results.peer = peer;
    const p2pRejected = (viewer.mesh?.rejected ?? [])
      .filter((r: string) => r.startsWith('p2p:'))
      .map((r: string) => (r.split('/').pop() ?? '').split('.')[0]);
    results.p2pRejected = p2pRejected;
    const problems = [
      !viewer.playing || viewer.t <= 14 ? 'did not play past the tampered segment' : '',
      viewer.errors.length !== 0 ? `errors ${JSON.stringify(viewer.errors)}` : '',
      !(viewer.mesh?.bytes?.p2p > 0) ? 'no bytes over the mesh' : '',
      !(peer.uploaded > 0) ? 'the peer uploaded nothing' : '',
      !p2pRejected.includes(victim) ? 'the tampered segment was not rejected from the peer' : '',
      p2pRejected.some((s: string) => s !== victim) ? 'an honest segment was rejected' : '',
      (viewer.mesh?.swarms ?? []).some((s: { swarm: string }) => !s.swarm.startsWith(`nfx/1/web/${meta.video}/`)) ? 'a stream joined a non-NFX swarm' : '',
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(`${problems.join('; ')}: ${JSON.stringify(results)}`);

    // The bridge: a second node over the same package (its own state), with a native
    // WebRTC peer in its tracker's swarms.
    // Its beacon names its tracker and its origin behind TLS fronts (browsers take only
    // wss:// trackers and https:// origins from a beacon); the last stage uses them.
    const originFront = await tlsFront();
    const trackerFront = await tlsFront();
    const bridged = await start(
      bin('nfxd'),
      [
        'run', '--key', key, '--store', store, '--state', join(work, 'state-bridge'), '--seed', a,
        '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0', '--embed-tracker', '127.0.0.1:0', '--bridge', '127.0.0.1:0',
        '--https-url', `https://127.0.0.1:${originFront.port}`, '--tracker-url', `wss://127.0.0.1:${trackerFront.port}`,
      ],
      [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/, /embedded tracker: (ws:\/\/\S+)/, /bridge: udp (\S+)/],
    );
    const relay2 = bridged.matches[0]![1]!;
    const origin2 = bridged.matches[1]![1]!.replace(/\/$/, '');
    const tracker2 = bridged.matches[2]![1]!;
    run(bin('nfxd'), ['publish', '--key', key, '--relay', relay2, '--package', pkg, '--title', 'Mesh e2e']);
    const until = Date.now() + 60_000;
    while (!bridged.text().includes(`${a}: Seeding`)) {
      if (Date.now() > until) throw new Error(`bridge never seeding:\n${bridged.text()}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const g = await gate(origin2);
    const v = await (await browser.newContext()).newPage();
    await v.goto(`${pages}/?origin=${encodeURIComponent(g.url)}&root=${meta.root}&tracker=${encodeURIComponent(tracker2)}&httpWindow=2&level=0`);
    await v.waitForFunction(() => (window as any).__nfx.playing && (document.querySelector('video') as HTMLVideoElement).currentTime > 3, null, { timeout: 60_000 });
    g.block();
    const t0 = await v.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    await v.waitForFunction(
      (t0: number) => {
        const s = (window as any).__nfx;
        return s.errors.length > 0 || (document.querySelector('video') as HTMLVideoElement).currentTime > t0 + 15;
      },
      t0,
      { timeout: 120_000 },
    );
    const viaBridge = await v.evaluate(() => {
      const s = (window as any).__nfx;
      return { t: (document.querySelector('video') as HTMLVideoElement).currentTime, errors: s.errors, mesh: s.mesh };
    });
    results.bridge = { ...viaBridge, blockedAt: t0, originRefused: g.refused() };
    const bridgeProblems = [
      viaBridge.errors.length !== 0 ? `errors ${JSON.stringify(viaBridge.errors)}` : '',
      !(viaBridge.t > t0 + 15) ? 'playback stopped when the origin went away' : '',
      !(viaBridge.mesh?.bytes?.p2p > 0) ? 'nothing came from the bridge' : '',
      (viaBridge.mesh?.rejected ?? []).length !== 0 ? `rejected ${JSON.stringify(viaBridge.mesh.rejected)}` : '',
    ].filter(Boolean);
    if (bridgeProblems.length > 0) throw new Error(`bridge: ${bridgeProblems.join('; ')}: ${JSON.stringify(results.bridge)}`);

    // The library's lifecycle, on the bundle the tar ships: open, play over the mesh, end
    // it (by destroy() in two rounds, by the open's signal in the third), and nothing may
    // be left running.
    const lc = await browser.newContext();
    await lc.addInitScript({ content: LEAK_PROBE });
    const lp = await lc.newPage();
    const pageErrors: string[] = [];
    lp.on('pageerror', (e) => pageErrors.push(e.message));
    await lp.goto(`${pages}/lib`);
    await lp.waitForFunction(() => (window as any).__lib?.st.ready, null, { timeout: 30_000 });
    const baseline = (await lp.evaluate(() => (window as any).__leaks())) as Leaks;
    const libOpts = { origins: [origin2], root: meta.root, trackers: [tracker2], httpWindow: 2, level: 0 };
    const rounds: Record<string, unknown>[] = [];
    for (const how of ['destroy', 'destroy', 'abort'] as const) {
      await lp.evaluate((o) => (window as any).__lib.open(o), libOpts);
      await lp.waitForFunction(
        () => {
          const s = (window as any).__lib.state();
          return s.errors.length > 0 || (s.playing && s.t > 3 && (s.mesh?.peers ?? 0) > 0);
        },
        null,
        { timeout: 90_000 },
      );
      const live = await lp.evaluate(() => ({ state: (window as any).__lib.state(), held: (window as any).__leaks() }));
      const events = (await lp.evaluate((h) => (window as any).__lib.end(h), how)) as number;
      const settled = await settleLeaks(lp, baseline);
      const after = await quiet(lp, 5_000);
      const element = await lp.evaluate(() => (window as any).__lib.element());
      const late = ((await lp.evaluate(() => (window as any).__lib.events())) as number) - events;
      const round = { how, playedTo: live.state.t, peers: live.state.mesh?.peers, live: live.held, settled: settled.held, after, element, late };
      rounds.push(round);
      const problems = [
        live.state.errors.length !== 0 ? `errors ${JSON.stringify(live.state.errors)}` : '',
        live.held.sockets.length === 0 ? 'the probe saw no tracker socket while playing' : '',
        live.held.peers === 0 ? 'the probe saw no peer connection while playing' : '',
        !settled.ok ? 'something was left running' : '',
        after.length !== 0 ? 'the page fetched after the end' : '',
        element.src !== null || element.readyState !== 0 ? 'the element still holds a source' : '',
        late !== 0 ? 'events were delivered after the end' : '',
      ].filter(Boolean);
      if (problems.length > 0) throw new Error(`lifecycle (${how}): ${problems.join('; ')}: ${JSON.stringify(round)}`);
    }
    const aborted = await lp.evaluate((o) => (window as any).__lib.openAborted(o), libOpts);
    const abortSettled = await settleLeaks(lp, baseline);
    results.lifecycle = { baseline, rounds, aborted, abortSettled: abortSettled.held, pageErrors };
    if (aborted !== 'AbortError' || !abortSettled.ok) throw new Error(`lifecycle (aborted open): ${JSON.stringify(results.lifecycle)}`);
    if (pageErrors.length !== 0) throw new Error(`lifecycle: page errors ${JSON.stringify(pageErrors)}`);
    await lc.close();

    // By address alone, as a viewer with no settings: no tracker and no origin in the URL.
    // The bridged node's beacon names both (behind the TLS fronts); once the origin refuses
    // segments, the rest can only come from the bridge, found through the beacon's tracker.
    const g2 = await gate(origin2);
    originFront.setUpstream(Number(new URL(g2.url).port));
    trackerFront.setUpstream(Number(new URL(tracker2).port));
    const frontOrigin = `https://127.0.0.1:${originFront.port}`;
    const frontTracker = `wss://127.0.0.1:${trackerFront.port}`;
    const bc = await browser.newContext({ ignoreHTTPSErrors: true }); // self-signed fronts, test only
    const bv = await bc.newPage();
    await bv.goto(`${pages}/?a=${encodeURIComponent(a)}&relay=${encodeURIComponent(relay2)}&httpWindow=2&level=0`);
    // Beacons are ephemeral: this waits for the node's next republish (every 60 s).
    await bv.waitForFunction(
      () => {
        const s = (window as any).__nfx;
        return s.errors.length > 0 || (s.playing && (document.querySelector('video') as HTMLVideoElement).currentTime > 3);
      },
      null,
      { timeout: 150_000 },
    );
    const found = await bv.evaluate(() => {
      const s = (window as any).__nfx;
      return { origin: s.origin, beaconTrackers: s.beaconTrackers, trackers: s.mesh?.trackers ?? [], engine: s.engine, errors: s.errors };
    });
    g2.block();
    const b0 = await bv.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
    await bv.waitForFunction(
      (t0: number) => {
        const s = (window as any).__nfx;
        return s.errors.length > 0 || (document.querySelector('video') as HTMLVideoElement).currentTime > t0 + 15;
      },
      b0,
      { timeout: 120_000 },
    );
    const viaBeacon = await bv.evaluate(() => {
      const s = (window as any).__nfx;
      return { t: (document.querySelector('video') as HTMLVideoElement).currentTime, errors: s.errors, mesh: s.mesh };
    });
    results.beaconTracker = { found, ...viaBeacon, blockedAt: b0, originRefused: g2.refused() };
    const beaconProblems = [
      found.origin !== frontOrigin ? `origin ${found.origin}, not the beacon's ${frontOrigin}` : '',
      JSON.stringify(found.trackers) !== JSON.stringify([frontTracker]) ? `trackers ${JSON.stringify(found.trackers)}, not the beacon's ${frontTracker}` : '',
      viaBeacon.errors.length !== 0 ? `errors ${JSON.stringify(viaBeacon.errors)}` : '',
      !(viaBeacon.t > b0 + 15) ? 'playback stopped when the origin went away' : '',
      !(viaBeacon.mesh?.bytes?.p2p > 0) ? 'nothing came from the bridge' : '',
      (viaBeacon.mesh?.rejected ?? []).length !== 0 ? `rejected ${JSON.stringify(viaBeacon.mesh.rejected)}` : '',
    ].filter(Boolean);
    if (beaconProblems.length > 0) throw new Error(`beacon tracker: ${beaconProblems.join('; ')}: ${JSON.stringify(results.beaconTracker)}`);
    await bc.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
}

function cleanup(): void {
  for (const s of servers) s.close();
  for (const c of children) {
    if (c.pid && c.exitCode === null) {
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
    console.log('mesh e2e: PASS');
    process.exit(0);
  },
  (e: Error) => {
    cleanup();
    console.error(`mesh e2e: FAIL\n${e.stack ?? e.message}`);
    process.exit(1);
  },
);
