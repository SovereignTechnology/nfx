/**
 * A2 test player, end to end, on this machine only (loopback, ephemeral ports):
 *
 *   ffmpeg test clip → nfx-package → nfxd (embedded scoped relay + origin + seeding)
 *   → nfxd publish → the player in headless Chromium (fresh context, never a real
 *   profile) plays it with every file verified by nfx-proto (WASM): once from a secure
 *   context, once from an insecure one (no WebCrypto; `http://player.test` mapped to
 *   loopback). Then the same player against a lying origin that flips a byte in every
 *   segment must reject them and never play.
 *
 * Usage: npm run build && npm run e2e
 * Needs `cargo` (builds nfxd and nfx-package) and ffmpeg (`NFX_FFMPEG`, else PATH).
 * Every process it starts runs in its own process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
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
const work = mkdtempSync(join(tmpdir(), 'nfx-player-e2e-'));
chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const servers: Server[] = [];

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed (${r.status}): ${r.stderr.slice(-2000)}`);
  return r.stdout;
}

/** Start a long-running process in its own group; resolve when stderr matches every pattern. */
function start(cmd: string, args: string[], waitFor: RegExp[]): Promise<{ child: ChildProcess; matches: RegExpExecArray[] }> {
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  return new Promise((ok, fail) => {
    let text = '';
    const timer = setTimeout(() => fail(new Error(`${cmd} never printed ${waitFor.join(', ')}:\n${text}`)), 60_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      const matches = waitFor.map((re) => re.exec(text));
      if (matches.every(Boolean)) {
        clearTimeout(timer);
        ok({ child, matches: matches as RegExpExecArray[] });
      }
    });
    child.on('exit', (code) => fail(new Error(`${cmd} exited ${code}:\n${text}`)));
  });
}

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
}

/** Serves the page, its bundle and the WASM module. */
async function playerServer(): Promise<string> {
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
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

/** A lying origin: proxies `upstream`, flipping the first byte of every listed segment. */
async function liar(upstream: string, segments: Set<string>): Promise<string> {
  const port = await listen(
    createServer((req, res) => {
      const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          const body = Buffer.concat(chunks);
          const name = (req.url ?? '').split('/').pop() ?? '';
          if (segments.has(name.split('.')[0] ?? '') && body.length > 0) body[0] = (body[0] ?? 0) ^ 0xff;
          res.writeHead(r.statusCode ?? 502, r.headers).end(body);
        });
      });
      up.on('error', () => res.writeHead(502).end());
      up.end();
    }),
  );
  return `http://127.0.0.1:${port}`;
}

async function main(): Promise<void> {
  run('cargo', ['build', '--locked', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'nfxd', '-p', 'nfx-media', '--bins']);
  const clip = join(work, 'clip.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const pkg = join(work, 'pkg');
  run(bin('nfx-package'), [clip, '--video', 'nfx:mainnet:1:player-e2e', '--out', pkg, '--max-height', '720', '--preset', 'veryfast']);
  const meta = JSON.parse(readFileSync(join(pkg, 'nfx.json'), 'utf8')) as { root: string; video: string };

  const key = join(work, 'node.key');
  const pubkey = run(bin('nfxd'), ['key', 'new', key]).split('\n')[0]!;
  const a = `38504:${pubkey}:${meta.video}`;
  const node = await start(
    bin('nfxd'),
    ['run', '--key', key, '--store', join(pkg, 'store'), '--seed', a, '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0'],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/],
  );
  const relay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  const published = run(bin('nfxd'), ['publish', '--key', key, '--relay', relay, '--package', pkg, '--title', 'Player e2e']).trim();
  if (published !== a) throw new Error(`published ${published}, expected ${a}`);
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('never seeding')), 60_000);
    let text = '';
    node.child.stderr!.on('data', (c: Buffer) => {
      text += c.toString();
      if (text.includes(`${a}: Seeding`)) {
        clearTimeout(timer);
        ok();
      }
    });
  });

  const list = JSON.parse(readFileSync(join(pkg, 'store', meta.root), 'utf8')) as { files: { role: string; sha256: string }[] };
  const segments = new Set(list.files.filter((f) => f.role === 'segment').map((f) => f.sha256));
  const player = await playerServer();
  const lying = await liar(origin, segments);

  const browser = await chromium.launch({
    headless: true,
    // `player.test` is not localhost, so a page there is not a secure context.
    args: ['--host-resolver-rules=MAP player.test 127.0.0.1'],
  });
  const results: Record<string, unknown> = { root: meta.root, a };
  try {
    const context = await browser.newContext(); // fresh: never a real profile
    const page = await context.newPage();
    await page.goto(`${player}/?origin=${encodeURIComponent(origin)}&root=${meta.root}`);
    await page.waitForFunction(
      () => {
        const s = (window as any).__nfx;
        const v = document.querySelector('video') as HTMLVideoElement;
        return s.errors.length > 0 || (s.playing && v.currentTime > 2);
      },
      null,
      { timeout: 60_000 },
    );
    const honest = await page.evaluate(() => {
      const s = (window as any).__nfx;
      return { playing: s.playing, verified: s.verified.length, rejected: s.rejected.length, errors: s.errors, levels: s.levels, t: (document.querySelector('video') as HTMLVideoElement).currentTime };
    });
    results.honest = honest;
    if (!honest.playing || honest.rejected !== 0 || honest.errors.length !== 0 || honest.verified < 4) throw new Error(`honest origin: ${JSON.stringify(honest)}`);

    const insecure = await context.newPage();
    const port = new URL(player).port;
    const manifestParams = `&video=${encodeURIComponent(meta.video)}&segs=${list.files.length}`;
    await insecure.goto(`http://player.test:${port}/?origin=${encodeURIComponent(origin)}&root=${meta.root}${manifestParams}`);
    await insecure.waitForFunction(
      () => {
        const s = (window as any).__nfx;
        const v = document.querySelector('video') as HTMLVideoElement;
        return s.errors.length > 0 || (s.playing && v.currentTime > 2);
      },
      null,
      { timeout: 60_000 },
    );
    const plain = await insecure.evaluate(() => {
      const s = (window as any).__nfx;
      return { secureContext: s.secureContext, subtle: Boolean(globalThis.crypto?.subtle), playing: s.playing, verified: s.verified.length, rejected: s.rejected.length, errors: s.errors };
    });
    results.insecure = plain;
    if (plain.secureContext || plain.subtle || !plain.playing || plain.rejected !== 0 || plain.errors.length !== 0) throw new Error(`insecure context: ${JSON.stringify(plain)}`);

    const page2 = await context.newPage();
    await page2.goto(`${player}/?origin=${encodeURIComponent(lying)}&root=${meta.root}`);
    await page2.waitForFunction(() => (window as any).__nfx.rejected.length > 0, null, { timeout: 60_000 });
    await page2.waitForTimeout(5_000);
    const lied = await page2.evaluate(() => {
      const s = (window as any).__nfx;
      return { playing: s.playing, verified: s.verified.length, rejected: s.rejected.map((r: any) => r.sha256), errors: s.errors, t: (document.querySelector('video') as HTMLVideoElement).currentTime };
    });
    results.liar = { ...lied, rejected: lied.rejected.length };
    const allSegments = lied.rejected.every((sha: string | null) => sha !== null && segments.has(sha));
    if (lied.playing || lied.t !== 0 || lied.rejected.length === 0 || !allSegments) throw new Error(`lying origin: ${JSON.stringify(lied)}`);
    await context.close();
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
    console.log('player e2e: PASS');
    process.exit(0);
  },
  (e: Error) => {
    cleanup();
    console.error(`player e2e: FAIL\n${e.stack ?? e.message}`);
    process.exit(1);
  },
);
