/**
 * A2 test player, end to end, on this machine only (loopback, ephemeral ports):
 *
 *   ffmpeg test clip → nfx-package → nfxd (embedded scoped relay + origin + seeding)
 *   → nfxd publish → the player in headless Chromium (fresh context, never a real
 *   profile) plays it with every file verified by nfx-proto (WASM):
 *   - by origin and root, from a secure context and from an insecure one (no WebCrypto;
 *     `http://player.test` mapped to loopback);
 *   - by manifest address over Nostr, with an origin hint, and with no hint at all, the
 *     origin then coming from a verified beacon's `https` endpoint (a throwaway
 *     self-signed TLS proxy in front of nfxd's origin);
 *   - by an address nobody published: it must fail, not guess.
 *   Then the same player against a lying origin that flips a byte in every segment must
 *   reject them and never play.
 *
 * Usage: npm run build && npm run e2e
 * Needs `cargo` (builds nfxd and nfx-package) and ffmpeg (`NFX_FFMPEG`, else PATH).
 * Every process it starts runs in its own process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
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

/** An https front for the origin, with a throwaway self-signed certificate (deleted with the
 * work dir); the upstream is set once nfxd has printed its origin. */
async function tlsProxy(): Promise<{ url: string; setUpstream: (u: string) => void }> {
  const key = join(work, 'tls.key');
  const cert = join(work, 'tls.crt');
  run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
  let upstream = '';
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    up.end();
  });
  servers.push(server as unknown as Server);
  const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
  return { url: `https://127.0.0.1:${port}`, setUpstream: (u) => (upstream = u) };
}

/** Wait until the player plays past 2 s or reports an error; return its state. */
async function settle(page: import('playwright').Page, timeout: number): Promise<any> {
  await page.waitForFunction(
    () => {
      const s = (window as any).__nfx;
      const v = document.querySelector('video') as HTMLVideoElement;
      return s.errors.length > 0 || (s.playing && v.currentTime > 2);
    },
    null,
    { timeout },
  );
  return page.evaluate(() => {
    const s = (window as any).__nfx;
    return { resolved: s.resolved, origin: s.origin, origins: s.origins, playing: s.playing, verified: s.verified.length, rejected: s.rejected.length, errors: s.errors };
  });
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
  const tls = await tlsProxy();
  const node = await start(
    bin('nfxd'),
    ['run', '--key', key, '--store', join(pkg, 'store'), '--seed', a, '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0', '--https-url', tls.url],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/],
  );
  const relay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  tls.setUpstream(origin);
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

    // By manifest address over Nostr, with the origin as a hint.
    const q = (extra: string): string => `${player}/?a=${encodeURIComponent(a)}&relay=${encodeURIComponent(relay)}${extra}`;
    const byHint = await context.newPage();
    await byHint.goto(q(`&origin=${encodeURIComponent(origin)}`));
    const hinted = await settle(byHint, 60_000);
    results.byAddressWithHint = hinted;
    if (hinted.resolved?.root !== meta.root || hinted.origin !== origin || !hinted.playing || hinted.rejected !== 0 || hinted.errors.length !== 0) {
      throw new Error(`by address with hint: ${JSON.stringify(hinted)}`);
    }

    // By manifest address alone: the origin must come from a verified beacon's https
    // endpoint. Beacons are ephemeral, so this waits for the seeder's next republish.
    const tlsContext = await browser.newContext({ ignoreHTTPSErrors: true }); // self-signed, test only
    const byBeacon = await tlsContext.newPage();
    await byBeacon.goto(q(''));
    const beaconed = await settle(byBeacon, 120_000);
    results.byAddressViaBeacon = beaconed;
    if (beaconed.resolved?.root !== meta.root || beaconed.origin !== tls.url || !beaconed.playing || beaconed.rejected !== 0 || beaconed.errors.length !== 0) {
      throw new Error(`by address via beacon: ${JSON.stringify(beaconed)}`);
    }
    await tlsContext.close();

    // An address nobody published: an error, never a guess.
    const nobody = await context.newPage();
    await nobody.goto(`${player}/?a=${encodeURIComponent(a.replace(pubkey, '0'.repeat(64)))}&relay=${encodeURIComponent(relay)}`);
    await nobody.waitForFunction(() => (window as any).__nfx.errors.length > 0, null, { timeout: 30_000 });
    const unknown = await nobody.evaluate(() => (window as any).__nfx.errors as string[]);
    results.unknownAddress = unknown;
    if (!unknown[0]?.includes('no valid manifest')) throw new Error(`unknown address: ${JSON.stringify(unknown)}`);

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
    // The creator withdraws the video (NFX-02 §6): resolving it now fails, never plays.
    run(bin('nfxd'), ['delete', '--key', key, '--relay', relay, '--a', a]);
    const gone = await context.newPage();
    await gone.goto(q(`&origin=${encodeURIComponent(origin)}`));
    await gone.waitForFunction(() => (window as any).__nfx.errors.length > 0, null, { timeout: 30_000 });
    const deleted = await gone.evaluate(() => ({ errors: (window as any).__nfx.errors as string[], playing: (window as any).__nfx.playing }));
    results.deleted = deleted;
    if (!deleted.errors[0]?.includes('deleted by its creator') || deleted.playing) throw new Error(`deleted video: ${JSON.stringify(deleted)}`);
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
