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
 * Usage: npm run build && npm run e2e:mesh
 * Every process it starts runs in its own process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/out/player.js': ['out/player.js', 'text/javascript'],
    '/out/e2e-peer.js': ['out/e2e-peer.js', 'text/javascript'],
    '/out/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
  };
  const port = await listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/peer') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(peerHtml);
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

async function main(): Promise<void> {
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
