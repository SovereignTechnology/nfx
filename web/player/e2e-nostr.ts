/**
 * NFX-10 §6, signaling over Nostr, end to end on this machine only (loopback, ephemeral
 * ports), with NO tracker anywhere: the only signaling path is a STOCK Nostr relay, strfry
 * at a pinned commit (e2e-strfry.sh builds it) with its own default strfry.conf, only its
 * database, port and open-files limit changed.
 *
 *   ffmpeg 60 s clip → nfx-package → nfxd (origin; an embedded relay only to publish the
 *   manifest it seeds, never given to a page; no tracker) behind a gate → two fresh headless
 *   Chromium contexts (never a real profile) on the test page with `&signal=nostr&relay=`
 *   strfry:
 *   - A plays with a 120 s HTTP window, so it soon holds the whole video;
 *   - B plays with a 2 s HTTP window. Once B plays with a peer, the gate refuses every
 *     segment: the rest of the video can only reach B from A, browser to browser over
 *     WebRTC, signaled only through strfry.
 *   B must play on 15 s past the cut with segment bytes from the mesh, nothing rejected,
 *   and A must have uploaded. (B may already hold what it plays after the cut: the mesh
 *   fetches up to 120 s ahead. Either way no segment came from the origin after it.)
 *   Neither page may open a socket to anything but strfry.
 *
 *   What strfry carried, read by a subscriber of every kind: only kind-25050 events with
 *   `i` = nfx-mesh/1, presence with empty content, and offers and answers whose content is
 *   NIP-44 v2 ciphertext (version byte 2) that names no SDP, candidate or address in clear.
 *
 *   Then the library's lifecycle with Nostr signaling, on the shipped bundle
 *   (out-lib/player.js, e2e-lib.ts): open, play with A as a peer, destroy; nothing may be
 *   left running (no socket, peer connection, worker, interval or timer beyond the page's
 *   baseline), nothing fetched afterwards, and strfry must have carried that session's
 *   `disconnect`.
 *
 * Usage: STRFRY=<strfry binary> STRFRY_CONF=<its strfry.conf> npm run e2e:nostr
 * (after npm run build && npm run build:lib). Every process it starts runs in its own process
 * group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { type AddressInfo, connect as tcpConnect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const crates = resolve(here, '../../crates');
const bin = (name: string): string => join(crates, 'target/debug', name);
const ffmpeg = process.env.NFX_FFMPEG ?? 'ffmpeg';
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: see the usage at the top of e2e-nostr.ts`);
  return resolve(v);
};
const work = mkdtempSync(join(tmpdir(), 'nfx-nostr-e2e-'));
chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const servers: Server[] = [];

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status}): ${r.stderr.slice(-2000)}`);
  return r.stdout;
}

function start(cmd: string, args: string[], waitFor: RegExp[]): Promise<{ matches: RegExpExecArray[]; text: () => string }> {
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
        ok({ matches: matches as RegExpExecArray[], text: () => text });
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
  const libHtml = '<!doctype html><meta charset="utf-8"><video id="v" muted></video><script type="module" src="/out/e2e-lib.js"></script>';
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/player.css': ['player.css', 'text/css'],
    '/out/player.js': ['out/player.js', 'text/javascript'],
    '/out/e2e-lib.js': ['out-e2e/e2e-lib.js', 'text/javascript'],
    '/out/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
    '/lib/player.js': ['out-lib/player.js', 'text/javascript'],
    '/lib/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
  };
  const port = await listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/lib') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(libHtml);
      const f = files[path];
      if (!f) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f[1] }).end(readFileSync(join(here, f[0])));
    }),
  );
  return `http://127.0.0.1:${port}`;
}

/** The origin behind a switch: once `block` is on, every segment is refused. */
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

interface RelayEvent {
  id: string;
  kind: number;
  pubkey: string;
  tags: string[][];
  content: string;
}

/** A subscriber of every kind on the relay: what it carried, as any reader of it sees it. */
function watchRelay(url: string): Promise<{ events: RelayEvent[]; close: () => void }> {
  return new Promise((ok, fail) => {
    const events: RelayEvent[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => fail(new Error('the relay watcher never connected')), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.send(JSON.stringify(['REQ', 'watch', {}]));
      ok({ events, close: () => ws.close() });
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as unknown[];
      if (msg[0] === 'EVENT' && msg[1] === 'watch') events.push(msg[2] as RelayEvent);
    };
    ws.onerror = () => fail(new Error('the relay watcher could not connect'));
  });
}

/** Everything the relay carried must be NFX-10 §6 signaling, its SDPs only as ciphertext. */
function relayProblems(events: RelayEvent[]): { problems: string[]; counts: Record<string, number> } {
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  const tag = (e: RelayEvent, name: string): string | undefined => e.tags.find((t) => t[0] === name)?.[1];
  const clear = /v=0|candidate|a=ice-|a=fingerprint|127\.0\.0\.1|192\.168\.|(?:^|[^0-9])10\.\d+\.\d+\.\d+/;
  for (const e of events) {
    const t = tag(e, 't') ?? '?';
    counts[`${e.kind}/${t}`] = (counts[`${e.kind}/${t}`] ?? 0) + 1;
    if (e.kind !== 25050) {
      problems.push(`kind ${e.kind} event ${e.id}`);
      continue;
    }
    if (tag(e, 'i') !== 'nfx-mesh/1' || tag(e, 'y') !== 'nfx') problems.push(`event ${e.id} is not nfx-mesh/1`);
    if (!e.tags.some((x) => x[0] === 'roomproof')) problems.push(`event ${e.id} has no room proof`);
    if (t === 'connect' || t === 'disconnect') {
      if (e.content !== '') problems.push(`${t} ${e.id} carries content`);
    } else if (t === 'offer' || t === 'answer') {
      let version = -1;
      try {
        version = Buffer.from(e.content, 'base64')[0] ?? -1;
      } catch {
        // not base64
      }
      if (!/^[A-Za-z0-9+/]+=*$/.test(e.content) || version !== 2) problems.push(`${t} ${e.id} is not NIP-44 v2 ciphertext`);
      if (clear.test(e.content)) problems.push(`${t} ${e.id} shows SDP or an address in clear`);
    } else {
      problems.push(`event ${e.id} of type ${t}`);
    }
    if (e.tags.some((x) => x.some((v) => clear.test(v)))) problems.push(`event ${e.id} has an address in a tag`);
  }
  return { problems, counts };
}

/** Installed before any page script: the sockets, peer connections, workers, intervals and timeouts open. */
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

async function settleLeaks(page: Page, baseline: Leaks): Promise<{ ok: boolean; held: Leaks }> {
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

const state = (p: Page) =>
  p.evaluate(() => {
    const s = (window as any).__nfx;
    return {
      playing: s.playing as boolean,
      t: (document.querySelector('video') as HTMLVideoElement).currentTime,
      errors: s.errors as string[],
      engine: s.engine as string | null,
      mesh: s.mesh,
    };
  });

async function main(): Promise<void> {
  const strfryBin = need('STRFRY');
  const strfryConf = need('STRFRY_CONF');
  if (!existsSync(join(here, 'out-lib/player.js'))) throw new Error('no out-lib/player.js: run npm run build:lib first');
  run('cargo', ['build', '--locked', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'nfxd', '-p', 'nfx-media', '--bins']);

  // ---- the stock relay: strfry's own config, only db, port and open-files limit changed ----
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
  const watch = await watchRelay(relay);

  // ---- the video, and its origin (no tracker) ----
  const clip = join(work, 'clip.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const pkg = join(work, 'pkg');
  run(bin('nfx-package'), [clip, '--video', 'nfx:testnet:1:nostr-e2e', '--out', pkg, '--max-height', '720', '--preset', 'veryfast']);
  const meta = JSON.parse(readFileSync(join(pkg, 'nfx.json'), 'utf8')) as { root: string; video: string };
  const key = join(work, 'node.key');
  const pubkey = run(bin('nfxd'), ['key', 'new', key]).split('\n')[0]!;
  const a = `38504:${pubkey}:${meta.video}`;
  const node = await start(
    bin('nfxd'),
    ['run', '--key', key, '--store', join(pkg, 'store'), '--seed', a, '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0'],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/],
  );
  if (/embedded tracker/.test(node.text())) throw new Error(`nfxd started a tracker:\n${node.text()}`);
  const nodeRelay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  run(bin('nfxd'), ['publish', '--key', key, '--relay', nodeRelay, '--package', pkg, '--title', 'Nostr e2e']);
  // The origin serves the video once the node seeds it.
  const seedBy = Date.now() + 60_000;
  while (!node.text().includes(`${a}: Seeding`)) {
    if (Date.now() > seedBy) throw new Error(`never seeding:\n${node.text().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const g = await gate(origin);

  const pages = await pageServer();
  const browser = await chromium.launch({ headless: true });
  const results: Record<string, unknown> = { root: meta.root, relay };
  const sockets: Record<string, string[]> = { A: [], B: [] };
  const consoles: Record<string, string[]> = { A: [], B: [] };
  const opened: Record<string, Page> = {};
  /** What each page logged and holds, and what the relay carried: for a failure's message. */
  const diagnose = async (): Promise<string> => {
    const pages: Record<string, unknown> = {};
    for (const [n, p] of Object.entries(opened)) {
      pages[n] = await p
        .evaluate(() => ({ log: (document.getElementById('log')?.textContent ?? '').slice(-6000), state: (window as any).__nfx }))
        .catch((e: unknown) => String(e));
    }
    return JSON.stringify({ pages, consoles, relay: relayProblems(watch.events).counts, events: watch.events.length, strfry: strfry.text().slice(-2000) }, null, 1);
  };
  try {
    const page = async (name: 'A' | 'B', httpWindow: number): Promise<Page> => {
      const p = await (await browser.newContext()).newPage();
      opened[name] = p;
      p.on('websocket', (w) => sockets[name]!.push(w.url()));
      p.on('console', (m) => {
        if (consoles[name]!.length < 200) consoles[name]!.push(`${m.type()}: ${m.text().slice(0, 300)}`);
      });
      p.on('pageerror', (e) => consoles[name]!.push(`pageerror: ${e.message}`));
      await p.goto(
        `${pages}/?origin=${encodeURIComponent(g.url)}&root=${meta.root}&signal=nostr&relay=${encodeURIComponent(relay)}&httpWindow=${httpWindow}&level=0`,
      );
      return p;
    };
    const pa = await page('A', 120);
    await pa.waitForFunction(() => (window as any).__nfx.playing || (window as any).__nfx.errors.length > 0, null, { timeout: 60_000 });
    const a0 = await state(pa);
    if (!a0.playing || a0.errors.length > 0) throw new Error(`A did not play: ${JSON.stringify(a0.errors)}`);
    await pa.waitForTimeout(10_000); // A fetches far ahead over HTTP

    const pb = await page('B', 2);
    await pb.waitForFunction(
      () => {
        const s = (window as any).__nfx;
        return s.errors.length > 0 || (s.playing && (document.querySelector('video') as HTMLVideoElement).currentTime > 3 && (s.mesh?.peers ?? 0) > 0);
      },
      null,
      { timeout: 120_000 },
    );
    g.block();
    const t0 = (await state(pb)).t;
    await pb.waitForFunction(
      (t0: number) => {
        const s = (window as any).__nfx;
        return s.errors.length > 0 || (document.querySelector('video') as HTMLVideoElement).currentTime > t0 + 15;
      },
      t0,
      { timeout: 120_000 },
    );
    const b = await state(pb);
    const aState = await state(pa);
    results.viewer = { ...b, blockedAt: t0, originRefused: g.refused() };
    results.seeder = aState;
    const problems = [
      b.errors.length !== 0 ? `errors ${JSON.stringify(b.errors)}` : '',
      !(b.t > t0 + 15) ? 'playback stopped when the origin went away' : '',
      !(b.mesh?.bytes?.p2p > 0) ? 'no bytes over the mesh' : '',
      !(aState.mesh?.uploaded > 0) ? 'A uploaded nothing' : '',
      (b.mesh?.rejected ?? []).length !== 0 ? `rejected ${JSON.stringify(b.mesh.rejected)}` : '',
      b.mesh?.signaling !== 'nostr' || JSON.stringify(b.mesh?.relays) !== JSON.stringify([relay]) ? `signaling ${b.mesh?.signaling} ${JSON.stringify(b.mesh?.relays)}` : '',
      (b.mesh?.trackers ?? []).length !== 0 ? 'B has trackers' : '',
      ...Object.entries(sockets).flatMap(([n, urls]) =>
        urls.filter((u) => u.replace(/\/$/, '') !== relay).map((u) => `${n} opened a socket to ${u}`),
      ),
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(`nostr mesh: ${problems.join('; ')}: ${JSON.stringify(results)}`);

    // ---- the library's lifecycle with Nostr signaling, on the shipped bundle ----
    const lc = await browser.newContext();
    await lc.addInitScript({ content: LEAK_PROBE });
    const lp = await lc.newPage();
    const pageErrors: string[] = [];
    lp.on('pageerror', (e) => pageErrors.push(e.message));
    await lp.goto(`${pages}/lib`);
    await lp.waitForFunction(() => (window as any).__lib?.st.ready, null, { timeout: 30_000 });
    const baseline = (await lp.evaluate(() => (window as any).__leaks())) as Leaks;
    const g2 = await gate(origin);
    const libOpts = { origins: [g2.url], root: meta.root, trackers: [], relays: [relay], httpWindow: 2, level: 0 };
    await lp.evaluate((o) => (window as any).__lib.open(o), libOpts);
    await lp.waitForFunction(
      () => {
        const s = (window as any).__lib.state();
        return s.errors.length > 0 || (s.playing && s.t > 3 && (s.mesh?.peers ?? 0) > 0);
      },
      null,
      { timeout: 120_000 },
    );
    const live = await lp.evaluate(() => ({ state: (window as any).__lib.state(), held: (window as any).__leaks() }));
    const disconnectsBefore = watch.events.filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'disconnect')).length;
    const events = (await lp.evaluate(() => (window as any).__lib.end('destroy'))) as number;
    const settled = await settleLeaks(lp, baseline);
    const after: string[] = [];
    lp.on('request', (r) => after.push(`request ${r.url()}`));
    lp.on('websocket', (w) => after.push(`websocket ${w.url()}`));
    await lp.waitForTimeout(5_000);
    const late = ((await lp.evaluate(() => (window as any).__lib.events())) as number) - events;
    const disconnects = watch.events.filter((e) => e.tags.some((t) => t[0] === 't' && t[1] === 'disconnect')).length - disconnectsBefore;
    results.lifecycle = { playedTo: live.state.t, peers: live.state.mesh?.peers, live: live.held, settled: settled.held, after, late, disconnects, pageErrors };
    const lcProblems = [
      live.state.errors.length !== 0 ? `errors ${JSON.stringify(live.state.errors)}` : '',
      !live.held.sockets.some((u: string) => u.replace(/\/$/, '') === relay) ? 'the probe saw no relay socket while playing' : '',
      live.held.sockets.some((u: string) => u.replace(/\/$/, '') !== relay) ? `a socket to something but the relay: ${JSON.stringify(live.held.sockets)}` : '',
      live.held.peers === 0 ? 'the probe saw no peer connection while playing' : '',
      !settled.ok ? 'something was left running' : '',
      after.length !== 0 ? 'the page fetched after the end' : '',
      late !== 0 ? 'events were delivered after the end' : '',
      disconnects < 1 ? 'strfry carried no disconnect from the ended session' : '',
      pageErrors.length !== 0 ? `page errors ${JSON.stringify(pageErrors)}` : '',
    ].filter(Boolean);
    if (lcProblems.length > 0) throw new Error(`lifecycle (nostr): ${lcProblems.join('; ')}: ${JSON.stringify(results.lifecycle)}`);
    await lc.close();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`${why}\n--- diagnostics ---\n${await diagnose()}`);
  } finally {
    await browser.close();
  }

  // ---- what the relay carried ----
  await new Promise((r) => setTimeout(r, 500));
  watch.close();
  const { problems, counts } = relayProblems(watch.events);
  results.relayCarried = counts;
  if (!(counts['25050/offer']! > 0 && counts['25050/answer']! > 0 && counts['25050/connect']! > 0)) problems.push('no offer, answer or presence went through the relay');
  if (problems.length > 0) throw new Error(`relay: ${problems.slice(0, 20).join('; ')}: ${JSON.stringify(counts)}`);
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
    console.log('nostr e2e: PASS');
    process.exit(0);
  },
  (e: Error) => {
    cleanup();
    console.error(`nostr e2e: FAIL\n${e.stack ?? e.message}`);
    process.exit(1);
  },
);
