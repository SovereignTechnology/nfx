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
 *   Held renditions (NFX-03 §§4–5, NFX-10 §1): a second video in two renditions, 720p and
 *   360p, which the node holds in 360p only (`--seed <a>#360p`): its origin answers 404 for
 *   720p's init and segments, and its beacon's `https` endpoint names `renditions: ["360p"]`.
 *   The library asks the origin which renditions it holds (nfx #85): for 720p it reads the
 *   playlist (verified, to learn the init's content name) and asks for the init once, which
 *   answers 404. So by address, with no renditions asked for and with 720p asked for first
 *   (`&renditions=720p,360p`), and by origin and root without `&renditions=`, the player must
 *   offer 360p alone, play it, and send exactly one request for 720p's playlist and one for
 *   its init per session, and none for a 720p segment. By origin and root, `&renditions=360p`
 *   asks for nothing of 720p; `&renditions=` is refused when it names a rendition the video
 *   lacks (before any probe), or is malformed.
 *
 *   A hostile beacon (nfx #85): a third video in 720p and 360p, served whole by an honest
 *   origin (a plain NFX-05 §6 server over the store, behind TLS) that no honest beacon names.
 *   A second nfxd, under a stranger's key, seeds it in 360p only and names that origin in its
 *   `https` endpoint with `renditions: ["360p"]`, a narrowing claim. By address, the page
 *   must still offer 720p and 360p (each with its rendition id) and play; asked for 720p alone
 *   (`&renditions=720p`), it must play 720p from that origin rather than skip it.
 *
 * Usage: npm run build && npm run e2e
 * Needs `cargo` (builds nfxd and nfx-package) and ffmpeg (`NFX_FFMPEG`, else PATH).
 * Every process it starts runs in its own process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

/** A front for `upstream` that records the path of every request it passes on. */
async function recorder(upstream: string): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const port = await listen(
    createServer((req, res) => {
      requests.push(new URL(req.url ?? '/', 'http://x').pathname);
      const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      up.end();
    }),
  );
  return { url: `http://127.0.0.1:${port}`, requests };
}

/**
 * A withholding origin (NFX-17 §4.3): proxies `upstream`, but for every listed segment sends
 * headers and then nothing, holding the connection open.
 */
async function withholder(upstream: string, segments: Set<string>): Promise<string> {
  const port = await listen(
    createServer((req, res) => {
      const name = (req.url ?? '').split('/').pop() ?? '';
      if (segments.has(name.split('.')[0] ?? '')) {
        res.writeHead(200, { 'content-type': 'video/mp4', 'access-control-allow-origin': '*' });
        res.flushHeaders();
        return; // never a byte of the body
      }
      const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      up.end();
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

/** A throwaway self-signed certificate for 127.0.0.1, made once (deleted with the work dir). */
let selfSignedPair: { key: Buffer; cert: Buffer } | null = null;
function selfSigned(): { key: Buffer; cert: Buffer } {
  if (selfSignedPair === null) {
    const key = join(work, 'tls.key');
    const cert = join(work, 'tls.crt');
    run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
    selfSignedPair = { key: readFileSync(key), cert: readFileSync(cert) };
  }
  return selfSignedPair;
}

/** An https front for the origin, with the throwaway certificate; the upstream is set once
 * nfxd has printed its origin. */
async function tlsProxy(): Promise<{ url: string; setUpstream: (u: string) => void; requests: string[] }> {
  let upstream = '';
  const requests: string[] = [];
  const server = createHttpsServer(selfSigned(), (req, res) => {
    requests.push(new URL(req.url ?? '/', 'http://x').pathname);
    const up = httpRequest(`${upstream}${req.url}`, { method: req.method }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    up.end();
  });
  servers.push(server as unknown as Server);
  const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
  return { url: `https://127.0.0.1:${port}`, setUpstream: (u) => (upstream = u), requests };
}

/**
 * An honest origin (NFX-05 §6) by hand, behind TLS: for each of `roots`, its hash list at
 * `/<root>`, its master playlist at `/<root>/master.m3u8`, and every file it lists at
 * `/<root>/<sha256>.<ext>`, from `store`; anything else `404` (`no-store`). It serves every
 * rendition, and records each request's path.
 */
async function staticOrigin(store: string, roots: string[]): Promise<{ url: string; requests: string[] }> {
  const videos = new Map<string, { files: Set<string>; master: string }>();
  for (const root of roots) {
    const list = JSON.parse(readFileSync(join(store, root), 'utf8')) as HashListFile;
    const master = list.files.find((f) => f.role === 'playlist-master')?.sha256;
    if (master === undefined) throw new Error(`hash list ${root} has no master playlist`);
    videos.set(root, { files: new Set(list.files.map((f) => f.sha256)), master });
  }
  const types: Record<string, string> = { m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', m4s: 'video/iso.segment' };
  const requests: string[] = [];
  const server = createHttpsServer(selfSigned(), (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    requests.push(path);
    const [, root = '', name, ...more] = path.split('/');
    const video = videos.get(root);
    let file: string | undefined;
    let type = 'application/json';
    if (video !== undefined && more.length === 0 && (req.method === 'GET' || req.method === 'HEAD')) {
      if (name === undefined) file = root;
      else if (name === 'master.m3u8') [file, type] = [video.master, types.m3u8!];
      else {
        const [sha = '', ext = ''] = name.split('.');
        if (video.files.has(sha)) [file, type] = [sha, types[ext] ?? 'application/octet-stream'];
      }
    }
    const cors = { 'access-control-allow-origin': '*' };
    if (file === undefined) return res.writeHead(404, { ...cors, 'cache-control': 'no-store' }).end();
    res.writeHead(200, { ...cors, 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable' }).end(readFileSync(join(store, file)));
  });
  servers.push(server as unknown as Server);
  const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port)));
  return { url: `https://127.0.0.1:${port}`, requests };
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
    return {
      resolved: s.resolved,
      origin: s.origin,
      origins: s.origins,
      playing: s.playing,
      verified: s.verified.length,
      rejected: s.rejected.length,
      errors: s.errors,
      levels: s.levels,
      renditions: s.renditions,
      availability: s.availability,
      originSources: s.originSources,
    };
  });
}

/** Wait until the page reports an error; return them. */
async function failure(page: import('playwright').Page, timeout: number): Promise<string[]> {
  await page.waitForFunction(() => (window as any).__nfx.errors.length > 0, null, { timeout });
  return page.evaluate(() => (window as any).__nfx.errors as string[]);
}

/**
 * A rendition's files by content name: its media playlist, and the init and segments that
 * playlist lists; and the sha256 of each.
 */
function renditionFiles(store: string, list: HashListFile, id: string): { names: string[]; shas: Set<string> } {
  const r = list.renditions.find((x) => x.id === id);
  const playlist = list.files.find((f) => f.name === r?.playlist);
  if (!playlist) throw new Error(`no rendition ${id}`);
  const text = readFileSync(join(store, playlist.sha256), 'utf8');
  const uris = [...text.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]!).concat(text.split('\n').filter((l) => l && !l.startsWith('#')));
  const names = [`${playlist.sha256}.m3u8`, ...uris];
  if (uris.length < 3) throw new Error(`rendition ${id} lists ${uris.length} files`);
  return { names, shas: new Set(names.map((n) => n.split('.')[0]!)) };
}

/** The requests in `log` for one of `shas` under `/<root>/`. */
function asked(log: string[], root: string, shas: Set<string>): string[] {
  return log.filter((p) => p.includes(`/${root}/`) && shas.has((p.split('/').pop() ?? '').split('.')[0] ?? ''));
}

interface HashListFile {
  files: { name: string; role: string; sha256: string }[];
  renditions: { id: string; playlist: string }[];
}

async function main(): Promise<void> {
  run('cargo', ['build', '--locked', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'nfxd', '-p', 'nfx-media', '--bins']);
  const clip = join(work, 'clip.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const pkg = join(work, 'pkg');
  run(bin('nfx-package'), [clip, '--video', 'nfx:mainnet:1:player-e2e', '--out', pkg, '--max-height', '720', '--preset', 'veryfast']);
  const meta = JSON.parse(readFileSync(join(pkg, 'nfx.json'), 'utf8')) as { root: string; video: string };
  // A second video in two renditions, from another clip (so no file is shared with the
  // first), its files in the same store: the node holds it in 360p only.
  const clip2 = join(work, 'clip2.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip2]);
  const pkg2 = join(work, 'pkg2');
  run(bin('nfx-package'), [clip2, '--video', 'nfx:mainnet:1:player-e2e-held', '--out', pkg2, '--renditions', '720p,360p', '--preset', 'veryfast']);
  const meta2 = JSON.parse(readFileSync(join(pkg2, 'nfx.json'), 'utf8')) as { root: string; video: string };
  for (const f of readdirSync(join(pkg2, 'store'))) {
    if (!existsSync(join(pkg, 'store', f))) cpSync(join(pkg2, 'store', f), join(pkg, 'store', f));
  }
  const list2 = JSON.parse(readFileSync(join(pkg, 'store', meta2.root), 'utf8')) as HashListFile;
  if (list2.renditions.map((r) => r.id).sort().join() !== '360p,720p') throw new Error(`video 2 renditions: ${JSON.stringify(list2.renditions)}`);
  const files720 = renditionFiles(join(pkg, 'store'), list2, '720p');
  const files360 = renditionFiles(join(pkg, 'store'), list2, '360p');
  // A third video in the same two renditions, from a third clip, in a store of its own: an
  // honest origin serves it whole, and only a stranger's beacon names that origin.
  const clip3 = join(work, 'clip3.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip3]);
  const pkg3 = join(work, 'pkg3');
  run(bin('nfx-package'), [clip3, '--video', 'nfx:mainnet:1:player-e2e-hostile', '--out', pkg3, '--renditions', '720p,360p', '--preset', 'veryfast']);
  const meta3 = JSON.parse(readFileSync(join(pkg3, 'nfx.json'), 'utf8')) as { root: string; video: string };
  const list3 = JSON.parse(readFileSync(join(pkg3, 'store', meta3.root), 'utf8')) as HashListFile;
  if (list3.renditions.map((r) => r.id).sort().join() !== '360p,720p') throw new Error(`video 3 renditions: ${JSON.stringify(list3.renditions)}`);
  const files720of3 = renditionFiles(join(pkg3, 'store'), list3, '720p');

  const key = join(work, 'node.key');
  const pubkey = run(bin('nfxd'), ['key', 'new', key]).split('\n')[0]!;
  const a = `38504:${pubkey}:${meta.video}`;
  const a2 = `38504:${pubkey}:${meta2.video}`;
  const a3 = `38504:${pubkey}:${meta3.video}`;
  const tls = await tlsProxy();
  const whole = await staticOrigin(join(pkg3, 'store'), [meta3.root]);
  const node = await start(
    bin('nfxd'),
    ['run', '--key', key, '--store', join(pkg, 'store'), '--seed', a, '--seed', `${a2}#360p`, '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0', '--https-url', tls.url],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/],
  );
  const relay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  tls.setUpstream(origin);
  const published = run(bin('nfxd'), ['publish', '--key', key, '--relay', relay, '--package', pkg, '--title', 'Player e2e']).trim();
  if (published !== a) throw new Error(`published ${published}, expected ${a}`);
  const published2 = run(bin('nfxd'), ['publish', '--key', key, '--relay', relay, '--package', pkg2, '--title', 'Player e2e, held renditions']).trim();
  if (published2 !== a2) throw new Error(`published ${published2}, expected ${a2}`);
  const published3 = run(bin('nfxd'), ['publish', '--key', key, '--relay', relay, '--package', pkg3, '--title', 'Player e2e, a hostile beacon']).trim();
  if (published3 !== a3) throw new Error(`published ${published3}, expected ${a3}`);
  // The stranger: another key, its own copy of the store and state, the creator's relay. It
  // seeds video 3 in 360p only and names the honest origin, which it does not run, as
  // serving 360p alone.
  const strangerKey = join(work, 'stranger.key');
  run(bin('nfxd'), ['key', 'new', strangerKey]);
  const strangerStore = join(work, 'stranger-store');
  cpSync(join(pkg3, 'store'), strangerStore, { recursive: true });
  const seeding3 = new RegExp(`${a3.replace(/[^0-9A-Za-z]/g, (c) => `\\${c}`)}: Seeding`);
  const stranger = start(bin('nfxd'), ['run', '--key', strangerKey, '--store', strangerStore, '--relay', relay, '--seed', `${a3}#360p`, '--https-url', whole.url], [seeding3]);
  stranger.catch(() => {}); // awaited below; a failure before then must not go unhandled
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('never seeding')), 60_000);
    let text = '';
    node.child.stderr!.on('data', (c: Buffer) => {
      text += c.toString();
      if (text.includes(`${a}: Seeding`) && text.includes(`${a2}: Seeding`)) {
        clearTimeout(timer);
        ok();
      }
    });
  });
  // The node serves 360p's files of video 2 and every playlist, and answers 404 for 720p's
  // init and segments.
  const status = async (name: string): Promise<number> => (await fetch(`${origin}/${meta2.root}/${name}`)).status;
  const served = {
    playlist720: await status(files720.names[0]!),
    init720: await status(files720.names[1]!),
    segment720: await status(files720.names.at(-1)!),
    segment360: await status(files360.names.at(-1)!),
  };
  if (served.playlist720 !== 200 || served.init720 !== 404 || served.segment720 !== 404 || served.segment360 !== 200) {
    throw new Error(`node origin for video 2: ${JSON.stringify(served)}`);
  }
  await stranger;

  const list = JSON.parse(readFileSync(join(pkg, 'store', meta.root), 'utf8')) as { files: { role: string; sha256: string }[] };
  const segments = new Set(list.files.filter((f) => f.role === 'segment').map((f) => f.sha256));
  const player = await playerServer();
  const lying = await liar(origin, segments);
  const holding = await withholder(origin, segments);

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

    // Held renditions: video 2, which the node holds in 360p only, and the hostile beacon:
    // video 3, which only the stranger's beacon names, on the honest origin. By address,
    // each page in a context of its own (no shared HTTP cache, so each request count is one
    // session's); all four wait for the next beacons together.
    const fresh = async (): Promise<import('playwright').Page> => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage(); // self-signed, test only
    const q2 = (extra: string): string => `${player}/?a=${encodeURIComponent(a2)}&relay=${encodeURIComponent(relay)}${extra}`;
    const q3 = (extra: string): string => `${player}/?a=${encodeURIComponent(a3)}&relay=${encodeURIComponent(relay)}${extra}`;
    const [fromBeacons, askedFirst, hostileAll, hostile720] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    await Promise.all([fromBeacons.goto(q2('')), askedFirst.goto(q2('&renditions=720p,360p')), hostileAll.goto(q3('')), hostile720.goto(q3('&renditions=720p'))]);
    const [beaconHeld, originCut, narrowed, wanted720] = await Promise.all([
      settle(fromBeacons, 150_000),
      settle(askedFirst, 150_000),
      settle(hostileAll, 150_000),
      settle(hostile720, 150_000),
    ]);
    results.heldFromBeacons = beaconHeld;
    results.heldAskedFirst = originCut;
    results.hostileBeacon = narrowed;
    results.hostileBeacon720 = wanted720;
    const only360 = (s: { levels: { id: string; height: number }[] }): boolean =>
      s.levels.length === 1 && s.levels[0]?.id === '360p' && s.levels[0]?.height === 360;
    const levelIds = (s: { levels: { id: string; height: number }[] }): string => s.levels.map((l) => `${l.id}@${l.height}`).join();
    type Settled = { resolved: { root: string } | null; origin: string; playing: boolean; rejected: number; errors: string[] };
    const healthy = (s: Settled, root: string, from: string): boolean =>
      s.resolved?.root === root && s.origin === from && s.playing && s.rejected === 0 && s.errors.length === 0;
    const wantAvailability = { seeders: 1, all: 0, renditions: [{ id: '360p', seeders: 1 }] };
    if (
      !healthy(beaconHeld, meta2.root, tls.url) ||
      !only360(beaconHeld) ||
      beaconHeld.renditions !== null ||
      JSON.stringify(beaconHeld.availability) !== JSON.stringify(wantAvailability) ||
      // The node is the video's creator: its origin is tier 1 (NFX-17 §4.2).
      JSON.stringify(beaconHeld.originSources) !== JSON.stringify([{ url: tls.url, renditions: ['360p'], tier: 1 }])
    ) {
      throw new Error(`held renditions, from beacons: ${JSON.stringify(beaconHeld)}`);
    }
    if (!healthy(originCut, meta2.root, tls.url) || !only360(originCut) || JSON.stringify(originCut.renditions) !== '["720p","360p"]') {
      throw new Error(`held renditions, 720p asked for first: ${JSON.stringify(originCut)}`);
    }
    // 720p of video 2 through the TLS front: per session, its playlist once and its init
    // once (the probe, answered 404), and never a segment.
    const count = (log: string[], root: string, names: string[]): number[] => names.map((n) => log.filter((p) => p === `/${root}/${n}`).length);
    const [playlist720 = '', init720 = '', ...segments720] = files720.names;
    const tls720 = asked(tls.requests, meta2.root, files720.shas);
    const tls360 = asked(tls.requests, meta2.root, files360.shas);
    results.heldRequests = { r720: tls720, r360: tls360.length };
    const [tlsPlaylist, tlsInit] = count(tls.requests, meta2.root, [playlist720, init720]);
    if (tlsPlaylist !== 2 || tlsInit !== 2 || tls720.length !== 4 || count(tls.requests, meta2.root, segments720).some((n) => n !== 0) || tls360.length < 3) {
      throw new Error(`held renditions, requests: 720p ${JSON.stringify(tls720)}, 360p ${tls360.length}`);
    }
    // The hostile beacon: its narrowing claim reached the library as the origin's hint, and
    // was only a hint: both levels offered, and 720p played when asked for.
    // A stranger's key: an open source, tier 3 (NFX-17 §4.2).
    const wantHostileSources = JSON.stringify([{ url: whole.url, renditions: ['360p'], tier: 3 }]);
    if (
      !healthy(narrowed, meta3.root, whole.url) ||
      levelIds(narrowed) !== '360p@360,720p@720' ||
      narrowed.renditions !== null ||
      JSON.stringify(narrowed.originSources) !== wantHostileSources ||
      JSON.stringify(narrowed.availability) !== JSON.stringify(wantAvailability)
    ) {
      throw new Error(`a hostile beacon, every rendition: ${JSON.stringify(narrowed)}`);
    }
    const honest720 = asked(whole.requests, meta3.root, files720of3.shas).filter((p) => p.endsWith('.m4s'));
    results.hostileRequests = { r720segments: honest720.length };
    if (!healthy(wanted720, meta3.root, whole.url) || levelIds(wanted720) !== '720p@720' || JSON.stringify(wanted720.originSources) !== wantHostileSources || honest720.length === 0) {
      throw new Error(`a hostile beacon, 720p asked for: ${JSON.stringify(wanted720)}, 720p segments ${honest720.length}`);
    }
    for (const p of [fromBeacons, askedFirst, hostileAll, hostile720]) await p.context().close();

    // By origin and root (no beacon): `&renditions=360p` asks for nothing of 720p.
    const rec = await recorder(origin);
    const byRoot = (o: string, extra: string, r = meta2.root): string => `${player}/?origin=${encodeURIComponent(o)}&root=${r}${extra}`;
    const cutPage = await context.newPage();
    await cutPage.goto(byRoot(rec.url, '&renditions=360p'));
    const cut = await settle(cutPage, 60_000);
    results.heldByRoot = cut;
    const rec720 = asked(rec.requests, meta2.root, files720.shas);
    if (!cut.playing || !only360(cut) || cut.errors.length !== 0 || cut.rejected !== 0 || rec720.length !== 0) {
      throw new Error(`renditions by root: ${JSON.stringify(cut)}, 720p requests ${JSON.stringify(rec720)}`);
    }
    // Without it, the library asks: 360p alone is offered, after one request for 720p's
    // playlist and one for its init, and no 720p segment is requested.
    const rec2 = await recorder(origin);
    const askedPage = await (await browser.newContext()).newPage();
    await askedPage.goto(byRoot(rec2.url, ''));
    const probed = await settle(askedPage, 60_000);
    const rec2of720 = asked(rec2.requests, meta2.root, files720.shas);
    results.heldByRootAsked = { levels: probed.levels, r720: rec2of720 };
    const [recPlaylist, recInit] = count(rec2.requests, meta2.root, [playlist720, init720]);
    if (!probed.playing || !only360(probed) || probed.errors.length !== 0 || recPlaylist !== 1 || recInit !== 1 || rec2of720.length !== 2) {
      throw new Error(`held renditions by root, asked: ${JSON.stringify(probed)}, 720p requests ${JSON.stringify(rec2of720)}`);
    }
    await askedPage.context().close();
    // An origin that holds both: both levels are listed, each with its rendition id (by
    // playlist content name, in hls.js's order); level 0, the 360p one, plays.
    const bothContext = await browser.newContext({ ignoreHTTPSErrors: true }); // self-signed, test only
    const both = await bothContext.newPage();
    await both.goto(byRoot(whole.url, '&level=0', meta3.root));
    const listed = await settle(both, 60_000);
    results.bothListed = listed.levels;
    if (!listed.playing || listed.errors.length !== 0 || levelIds(listed) !== '360p@360,720p@720') throw new Error(`both levels: ${JSON.stringify(listed)}`);
    await bothContext.close();
    // Refused: a rendition the video lacks (once the hash list has verified, and before
    // anything plays), and malformed lists (before anything is fetched).
    const refusals: Record<string, unknown> = {};
    for (const [extra, want, fetched] of [
      ['&renditions=4320p', /"4320p" is not a rendition of this video \(it has "720p", "360p"\)|"4320p" is not a rendition of this video \(it has "360p", "720p"\)/, [`/${meta2.root}`]],
      ['&renditions=', /"" is not a rendition id/, []],
      ['&renditions=360p,360p', /"360p" is named twice/, []],
    ] as const) {
      const r = await recorder(origin);
      const p = await context.newPage();
      await p.goto(byRoot(r.url, extra));
      const errors = await failure(p, 30_000);
      await p.waitForTimeout(1_000);
      const playing = await p.evaluate(() => (window as any).__nfx.playing as boolean);
      refusals[extra] = { errors, requests: r.requests };
      if (!want.test(errors[0] ?? '') || playing || JSON.stringify(r.requests) !== JSON.stringify(fetched)) {
        throw new Error(`refusal ${extra}: ${JSON.stringify({ errors, playing, requests: r.requests })}`);
      }
    }
    results.heldRefusals = refusals;

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

    // NFX-17 §4.3: with an honest origin beside it, the liar is left after its first bad
    // segment and the video plays; a withholding origin, which serves the hash list and then
    // sends nothing, is left after 4 s and the video plays too.
    for (const [name, bad] of [['liarThenHonest', lying], ['withholderThenHonest', holding]] as const) {
      const p = await context.newPage();
      await p.goto(`${player}/?origin=${encodeURIComponent(bad)}&origin=${encodeURIComponent(origin)}&root=${meta.root}`);
      await p.waitForFunction(() => (window as any).__nfx.playing && (document.querySelector('video') as HTMLVideoElement).currentTime > 2, null, { timeout: 90_000 });
      const got = await p.evaluate(() => {
        const s = (window as any).__nfx;
        return { playing: s.playing, verified: s.verified.length, rejected: s.rejected.length, errors: s.errors, t: (document.querySelector('video') as HTMLVideoElement).currentTime };
      });
      results[name] = got;
      // Both are configured sources, tried in the page's order: the bad one first.
      const left = name === 'liarThenHonest' ? got.rejected > 0 : true;
      if (!got.playing || got.t <= 2 || got.errors.length > 0 || !left) throw new Error(`${name}: ${JSON.stringify(got)}`);
      await p.close();
    }
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
