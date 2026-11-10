/**
 * NFX-10 §6 with a native node in the mesh (#71, phase 2), end to end on this machine only
 * (loopback, ephemeral ports), with NO tracker anywhere: a browser and nfxd's mesh endpoint
 * (`--mesh-relay`, a full ICE agent) find each other in a rendition's room and negotiate
 * through a STOCK Nostr relay, strfry at the pinned commit e2e-strfry.sh builds, with its own
 * default strfry.conf (only its database, port and open-files limit changed).
 *
 *   ffmpeg 60 s clip → nfx-package → nfxd seeding it: the origin (behind a gate), an embedded
 *   relay only to publish the manifest (never given to the page), and the mesh endpoint
 *   signaling through strfry → one fresh headless Chromium context (never a real profile) on
 *   the test page with `&signal=nostr&relay=` strfry and a 2 s HTTP window.
 *   - Once the page plays with a peer (the node: nothing else is in the room), the gate
 *     refuses every segment. The page must play on 15 s past the cut with segment bytes
 *     from the mesh and nothing rejected, and open no socket but to strfry.
 *   - The node must report a connection opened and segments served (its `mesh:` status
 *     line), and strfry must have carried an offer or answer of the node's session.
 *   - What strfry carried, read by a subscriber of every kind: only kind-25050 events with
 *     `i` = nfx-mesh/1, presence with empty content, and offers and answers whose content
 *     is NIP-44 v2 ciphertext naming no SDP, candidate or address in clear.
 *   - Stopped with SIGTERM, the node leaves its room: strfry carries its `disconnect`.
 *
 * Which side offers follows the two session keys (NFX-10 §6.6), so a run takes one of the
 * two paths; crates/nfx-node/tests/mesh.rs drives both against a str0m peer.
 *
 * Usage: STRFRY=<strfry binary> STRFRY_CONF=<its strfry.conf> npm run e2e:nostr-node
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
import { chromium, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const crates = resolve(here, '../../crates');
const bin = (name: string): string => join(crates, 'target/debug', name);
const ffmpeg = process.env.NFX_FFMPEG ?? 'ffmpeg';
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: see the usage at the top of e2e-nostr-node.ts`);
  return resolve(v);
};
const work = mkdtempSync(join(tmpdir(), 'nfx-nostr-node-e2e-'));
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

const tag = (e: RelayEvent, name: string): string | undefined => e.tags.find((t) => t[0] === name)?.[1];

/** Everything the relay carried must be NFX-10 §6 signaling, its SDPs only as ciphertext. */
function relayProblems(events: RelayEvent[]): { problems: string[]; counts: Record<string, number> } {
  const problems: string[] = [];
  const counts: Record<string, number> = {};
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

const state = (p: Page) =>
  p.evaluate(() => {
    const s = (window as any).__nfx;
    return {
      playing: s.playing as boolean,
      t: (document.querySelector('video') as HTMLVideoElement).currentTime,
      errors: s.errors as string[],
      mesh: s.mesh,
    };
  });

/** The node's last `mesh:` status line, as numbers. */
function meshLine(text: string): { opened: number; served: number; failed: number; line: string } | null {
  const lines = text.split('\n').filter((l) => /^mesh: \d+ room/.test(l));
  const line = lines[lines.length - 1];
  if (line === undefined) return null;
  const n = (re: RegExp): number => Number(re.exec(line)?.[1] ?? NaN);
  return { opened: n(/opened (\d+)/), served: n(/segments served (\d+)/), failed: n(/failed (\d+)/), line };
}

async function main(): Promise<void> {
  const strfryBin = need('STRFRY');
  const strfryConf = need('STRFRY_CONF');
  if (!existsSync(join(here, 'out/player.js'))) throw new Error('no out/player.js: run npm run build first');
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

  // ---- the video, and the node: origin, no tracker, the mesh endpoint on strfry ----
  const clip = join(work, 'clip.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const pkg = join(work, 'pkg');
  run(bin('nfx-package'), [clip, '--video', 'nfx:testnet:1:nostr-node-e2e', '--out', pkg, '--max-height', '720', '--preset', 'veryfast']);
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
  if (/embedded tracker/.test(node.text())) throw new Error(`nfxd started a tracker:\n${node.text()}`);
  const nodeRelay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  const session = node.matches[2]![1]!;
  if (session === pubkey) throw new Error('the mesh session key is the node key');
  run(bin('nfxd'), ['publish', '--key', key, '--relay', nodeRelay, '--package', pkg, '--title', 'Nostr node e2e']);
  const seedBy = Date.now() + 60_000;
  while (!node.text().includes(`${a}: Seeding`) || !/^mesh: 1 room/m.test(node.text())) {
    if (Date.now() > seedBy) throw new Error(`never seeding in a room:\n${node.text().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const g = await gate(origin);

  const pages = await pageServer();
  const browser = await chromium.launch({ headless: true });
  const results: Record<string, unknown> = { root: meta.root, relay, session };
  const sockets: string[] = [];
  const consoles: string[] = [];
  let pb: Page | null = null;
  const diagnose = async (): Promise<string> => {
    const page = pb
      ? await pb
          .evaluate(() => ({ log: (document.getElementById('log')?.textContent ?? '').slice(-6000), state: (window as any).__nfx }))
          .catch((e: unknown) => String(e))
      : null;
    return JSON.stringify(
      { page, consoles, relay: relayProblems(watch.events).counts, events: watch.events.length, node: node.text().slice(-6000), strfry: strfry.text().slice(-2000) },
      null,
      1,
    );
  };
  try {
    const p = await (await browser.newContext()).newPage();
    pb = p;
    p.on('websocket', (w) => sockets.push(w.url()));
    p.on('console', (m) => {
      if (consoles.length < 200) consoles.push(`${m.type()}: ${m.text().slice(0, 300)}`);
    });
    p.on('pageerror', (e) => consoles.push(`pageerror: ${e.message}`));
    await p.goto(`${pages}/?origin=${encodeURIComponent(g.url)}&root=${meta.root}&signal=nostr&relay=${encodeURIComponent(relay)}&httpWindow=2&level=0`);
    await p.waitForFunction(
      () => {
        const s = (window as any).__nfx;
        return s.errors.length > 0 || (s.playing && (document.querySelector('video') as HTMLVideoElement).currentTime > 3 && (s.mesh?.peers ?? 0) > 0);
      },
      null,
      { timeout: 120_000 },
    );
    g.block();
    const t0 = (await state(p)).t;
    await p.waitForFunction(
      (t0: number) => {
        const s = (window as any).__nfx;
        return s.errors.length > 0 || (document.querySelector('video') as HTMLVideoElement).currentTime > t0 + 15;
      },
      t0,
      { timeout: 120_000 },
    );
    const b = await state(p);
    // The node prints its status every 2 s when it changes.
    await new Promise((r) => setTimeout(r, 2_500));
    const m = meshLine(node.text());
    results.viewer = { ...b, blockedAt: t0, originRefused: g.refused() };
    results.node = m;
    const ofNode = watch.events.filter((e) => e.pubkey === session);
    const problems = [
      b.errors.length !== 0 ? `errors ${JSON.stringify(b.errors)}` : '',
      !(b.t > t0 + 15) ? 'playback stopped when the origin went away' : '',
      !(b.mesh?.bytes?.p2p > 0) ? 'no bytes over the mesh' : '',
      (b.mesh?.rejected ?? []).length !== 0 ? `rejected ${JSON.stringify(b.mesh.rejected)}` : '',
      b.mesh?.signaling !== 'nostr' ? `signaling ${b.mesh?.signaling}` : '',
      (b.mesh?.trackers ?? []).length !== 0 ? 'the page has trackers' : '',
      m === null ? 'the node printed no mesh status' : '',
      m !== null && !(m.opened >= 1) ? `the node opened no connection: ${m.line}` : '',
      m !== null && !(m.served >= 1) ? `the node served no segment: ${m.line}` : '',
      !ofNode.some((e) => ['offer', 'answer'].includes(tag(e, 't') ?? '')) ? 'no offer or answer of the node went through the relay' : '',
      !ofNode.some((e) => tag(e, 't') === 'connect') ? 'no presence of the node went through the relay' : '',
      ...sockets.filter((u) => u.replace(/\/$/, '') !== relay).map((u) => `the page opened a socket to ${u}`),
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(`nostr node mesh: ${problems.join('; ')}: ${JSON.stringify(results)}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`${why}\n--- diagnostics ---\n${await diagnose()}`);
  } finally {
    await browser.close();
  }

  // ---- stopped with SIGTERM, the node leaves its room ----
  const exited = new Promise<number | null>((ok) => node.child.once('exit', (code) => ok(code)));
  process.kill(-node.child.pid!, 'SIGTERM');
  const code = await Promise.race([exited, new Promise<'timeout'>((ok) => setTimeout(() => ok('timeout'), 30_000))]);
  await new Promise((r) => setTimeout(r, 500));
  watch.close();
  const { problems, counts } = relayProblems(watch.events);
  results.relayCarried = counts;
  results.nodeExit = code;
  if (code === 'timeout') problems.push('nfxd did not exit within 30 s of SIGTERM');
  if (!watch.events.some((e) => e.pubkey === session && tag(e, 't') === 'disconnect')) problems.push("strfry carried no disconnect of the node's session");
  if (problems.length > 0) throw new Error(`relay: ${problems.slice(0, 20).join('; ')}: ${JSON.stringify(results)}`);
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
    console.log('nostr node e2e: PASS');
    process.exit(0);
  },
  (e: Error) => {
    cleanup();
    console.error(`nostr node e2e: FAIL\n${e.stack ?? e.message}`);
    process.exit(1);
  },
);
