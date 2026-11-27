/**
 * Keeping what is watched (NFX-18, NFX-10 §7), end to end on this machine only (loopback,
 * ephemeral ports): a browser keeps a video it played past the minimum in IndexedDB, and plays
 * it again from there with the origin refusing every file.
 *
 *   ffmpeg 16 s clip → nfx-package → nfxd seeding it (the origin, behind a gate that logs every
 *   request and can refuse them all; its embedded relay for the mesh's signaling, with no peer)
 *   → headless Chromium with a persistent profile in a temporary directory (never a real
 *   profile) on the test page with `&keep=1`.
 *   0. The store over real IndexedDB (e2e-keep-fixture.ts): an error between a file's bytes
 *      and its entry leaves neither; a byte changed behind the store's back is refused.
 *   a. A play shorter than the minimum (8 s): the database holds nothing.
 *   b. A play to the end past a short minimum (3 s); then the browser is closed and started
 *      again on the same profile, and the origin refuses everything: the video plays to the
 *      end from the store, with the mesh (the engine's segment storage) and without it (the
 *      keep tier); the origin is asked for none of the kept files.
 *   c. One stored segment and the init changed by a byte in IndexedDB, the origin willing: both
 *      refused, fetched again from the origin (no other segment is), and stored right again.
 *
 * Usage: npm run e2e:keep (after npm run build). Every process it starts runs in its own
 * process group, and only those are killed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const crates = resolve(here, '../../crates');
const bin = (name: string): string => join(crates, 'target/debug', name);
const ffmpeg = process.env.NFX_FFMPEG ?? 'ffmpeg';
const work = mkdtempSync(join(tmpdir(), 'nfx-keep-e2e-'));
chmodSync(work, 0o700);
const children: ChildProcess[] = [];
const servers: Server[] = [];
const CLIP_S = 16;

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

async function pageServer(): Promise<string> {
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/player.css': ['player.css', 'text/css'],
    '/out/player.js': ['out/player.js', 'text/javascript'],
    '/out/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
    '/out-e2e/e2e-keep-fixture.js': ['out-e2e/e2e-keep-fixture.js', 'text/javascript'],
  };
  const port = await listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/fixture') {
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><script type="module" src="/out-e2e/e2e-keep-fixture.js"></script>');
      }
      const f = files[path];
      if (!f) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f[1] }).end(readFileSync(join(here, f[0])));
    }),
  );
  return `http://127.0.0.1:${port}`;
}

/** The origin behind a gate that logs every request's path, and refuses every one while `refuse` is on. */
async function gate(upstream: string): Promise<{ url: string; refuse: (on: boolean) => void; log: () => { path: string; refused: boolean }[]; reset: () => void }> {
  let refusing = false;
  let log: { path: string; refused: boolean }[] = [];
  const port = await listen(
    createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      log.push({ path, refused: refusing });
      if (refusing) return res.writeHead(503, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end();
      const up = httpRequest(`${upstream}${req.url}`, { method: req.method, headers: { range: req.headers.range ?? '' } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on('error', () => res.writeHead(502).end());
      up.end();
    }),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    refuse: (on) => (refusing = on),
    log: () => [...log],
    reset: () => (log = []),
  };
}

/**
 * Raw IndexedDB reads of the player's keep store, injected as source text (so no bundler wraps
 * it): counts, file entries, a byte flipped, a file's sha256. The database is never created
 * here: absent, it counts as empty.
 */
const IDB_HELPERS = `
window.__idbKeep = {
  open() {
    return indexedDB.databases().then((dbs) => {
      if (!dbs.some((d) => d.name === 'nfx-web-keep')) return null;
      return new Promise((res, rej) => {
        const r = indexedDB.open('nfx-web-keep');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    });
  },
  async counts() {
    const db = await this.open();
    if (db === null) return { exists: false, videos: 0, files: 0, bytes: 0, meta: 0 };
    const out = { exists: true };
    await new Promise((res, rej) => {
      const t = db.transaction(['videos', 'files', 'bytes', 'meta'], 'readonly');
      for (const s of ['videos', 'files', 'bytes', 'meta']) {
        const q = t.objectStore(s).count();
        q.onsuccess = () => { out[s] = q.result; };
      }
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
    db.close();
    return out;
  },
  async files() {
    const db = await this.open();
    if (db === null) return [];
    const all = await new Promise((res, rej) => {
      const q = db.transaction('files', 'readonly').objectStore('files').getAll();
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    return all;
  },
  async flip(key) {
    const db = await this.open();
    await new Promise((res, rej) => {
      const t = db.transaction('bytes', 'readwrite');
      const s = t.objectStore('bytes');
      const g = s.get(key);
      g.onsuccess = () => {
        const b = new Uint8Array(g.result);
        b[b.length >> 1] ^= 0x01;
        s.put(b.buffer, key);
      };
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
    });
    db.close();
  },
  async sha(key) {
    const db = await this.open();
    const buf = await new Promise((res, rej) => {
      const q = db.transaction('bytes', 'readonly').objectStore('bytes').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    db.close();
    if (!(buf instanceof ArrayBuffer)) return null;
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
  },
};
`;

interface KeptFile {
  root: string;
  sha256: string;
  role: string;
  rendition: string | null;
}

async function main(): Promise<void> {
  if (!existsSync(join(here, 'out/player.js'))) throw new Error('no out/player.js: run npm run build first');
  if (!existsSync(join(here, 'out-e2e/e2e-keep-fixture.js'))) throw new Error('no out-e2e/e2e-keep-fixture.js: run npm run e2e:keep');
  run('cargo', ['build', '--locked', '--manifest-path', join(crates, 'Cargo.toml'), '-p', 'nfxd', '-p', 'nfx-media', '--bins']);

  // ---- the video, and the node: origin, embedded relay, no mesh endpoint (no peer) ----
  const clip = join(work, 'clip.mp4');
  run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(CLIP_S), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  const pkg = join(work, 'pkg');
  run(bin('nfx-package'), [clip, '--video', 'nfx:testnet:1:keep-e2e', '--out', pkg, '--max-height', '720', '--preset', 'veryfast']);
  const meta = JSON.parse(readFileSync(join(pkg, 'nfx.json'), 'utf8')) as { root: string; video: string };
  const key = join(work, 'node.key'); // a throwaway key, made here, removed with `work`
  const pubkey = run(bin('nfxd'), ['key', 'new', key]).split('\n')[0]!;
  const a = `38504:${pubkey}:${meta.video}`;
  const node = await start(
    bin('nfxd'),
    ['run', '--key', key, '--store', join(pkg, 'store'), '--seed', a, '--embed-relay', '127.0.0.1:0', '--origin', '127.0.0.1:0'],
    [/embedded relay: (ws:\/\/\S+)/, /origin: (http:\/\/\S+?)\/?\s/],
  );
  const relay = node.matches[0]![1]!;
  const origin = node.matches[1]![1]!.replace(/\/$/, '');
  run(bin('nfxd'), ['publish', '--key', key, '--relay', relay, '--package', pkg, '--title', 'Keep e2e']);
  const seedBy = Date.now() + 60_000;
  while (!node.text().includes(`${a}: Seeding`)) {
    if (Date.now() > seedBy) throw new Error(`never seeding:\n${node.text().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const g = await gate(origin);
  const pages = await pageServer();
  const root = meta.root;
  const results: Record<string, unknown> = { root };

  const profile = mkdtempSync(join(work, 'profile-'));
  const launch = async (): Promise<BrowserContext> => {
    const ctx = await chromium.launchPersistentContext(profile, { headless: true });
    await ctx.addInitScript(IDB_HELPERS);
    return ctx;
  };
  const fail = (name: string, problems: string[], got: unknown): void => {
    const real = problems.filter(Boolean);
    if (real.length > 0) throw new Error(`${name}: ${real.join('; ')}: ${JSON.stringify(got)}`);
  };
  const url = (q: string): string => `${pages}/?origin=${encodeURIComponent(g.url)}&root=${root}&level=0&keep=1&${q}`;
  const mesh = `signal=nostr&relay=${encodeURIComponent(relay)}`;
  const diag = async (p: Page, name: string, e: unknown): Promise<never> => {
    const page = await p
      .evaluate(() => ({ log: (document.getElementById('log')?.textContent ?? '').slice(-6000), state: (window as any).__nfx }))
      .catch((x: unknown) => String(x));
    throw new Error(`${name}: ${e instanceof Error ? e.message : String(e)}\n--- diagnostics ---\n${JSON.stringify({ page, gate: g.log().slice(-60) }, null, 1)}`);
  };
  /** Open the page, wait for `until`, read `__nfx.keep` and state, then end the session and wait for its writes. */
  const session = async (ctx: BrowserContext, name: string, q: string, until: string, timeout = 120_000) => {
    const p = await ctx.newPage();
    const consoles: string[] = [];
    p.on('pageerror', (e) => consoles.push(`pageerror: ${e.message}`));
    try {
      await p.goto(url(q));
      await p.waitForFunction(until, null, { timeout });
      const v = await p.evaluate(() => {
        const s = (window as any).__nfx;
        const el = document.querySelector('video') as HTMLVideoElement;
        return { playing: s.playing as boolean, t: el.currentTime, ended: el.ended, errors: s.errors as string[], rejected: s.rejected as unknown[], keep: s.keep, keepEvents: s.keepEvents as string[], mesh: s.mesh === null ? null : { segments: s.mesh.segments, rejected: s.mesh.rejected } };
      });
      await p.evaluate(async () => {
        (window as any).__nfxDestroy();
        await (window as any).__nfxKeep.idle();
      });
      const list = (await p.evaluate(() => (window as any).__nfxKeep.list())) as { root: string; files: number; bytes: number; reasons: string[]; renditions: { id: string; state: string }[] }[];
      const counts = (await p.evaluate(() => (window as any).__idbKeep.counts())) as Record<string, number | boolean>;
      return { v, list, counts, consoles, p };
    } catch (e) {
      return diag(p, name, e);
    }
  };
  const ended = `(() => { const s = window.__nfx; const el = document.querySelector('video'); return s.errors.length > 0 || el.ended || (el.duration > 0 && el.currentTime >= el.duration - 0.3); })()`;

  let ctx = await launch();
  let kept: KeptFile[] = [];
  /** The played rendition's segments, all kept in b: a replay reads each from the store. */
  let keptSegmentCount = 0;
  try {
    // ---- 0. the store over real IndexedDB ----
    const fp = await ctx.newPage();
    await fp.goto(`${pages}/fixture`);
    await fp.waitForFunction(() => (window as any).__keepFixture !== undefined, null, { timeout: 30_000 });
    const fx = (await fp.evaluate(() => (window as any).__keepFixture.run())) as Record<string, any>;
    results.fixture = fx;
    fail('fixture', [
      !String(fx.failed).includes('injected failure') ? `a failed commit: ${fx.failed}` : '',
      JSON.stringify(fx.afterFailure) !== JSON.stringify({ videos: 0, files: 0, bytes: 0, meta: 0 }) ? 'a failed commit left something' : '',
      fx.put !== 'stored' ? `put: ${fx.put}` : '',
      JSON.stringify(fx.afterPut) !== JSON.stringify({ videos: 1, files: 1, bytes: 1, meta: 1 }) ? 'a commit is not bytes, entry, video and usage together' : '',
      fx.read !== true ? 'a stored file did not read back' : '',
      fx.tampered?.bytes !== null || fx.tampered?.refused !== true ? 'a tampered file was not refused' : '',
      fx.afterTamper?.files !== 0 || fx.afterTamper?.bytes !== 0 ? 'a tampered file was not dropped' : '',
    ], fx);
    await fp.close();

    // ---- a. under the minimum: nothing written ----
    const short = await session(ctx, 'under the minimum', `${mesh}&keepMinimum=8`, `(() => { const s = window.__nfx; return s.errors.length > 0 || (s.playing && document.querySelector('video').currentTime > 3); })()`);
    results.underMinimum = { t: short.v.t, keep: short.v.keep, counts: short.counts, list: short.list, events: short.v.keepEvents };
    fail('under the minimum', [
      short.v.errors.length !== 0 ? `errors ${JSON.stringify(short.v.errors)}` : '',
      short.v.keep?.state !== 'waiting' ? `state ${short.v.keep?.state}` : '',
      !(short.v.keep?.playedSeconds > 2 && short.v.keep?.playedSeconds < 8) ? `played ${short.v.keep?.playedSeconds} s` : '',
      short.v.keep?.written !== 0 ? `${short.v.keep?.written} written` : '',
      short.list.length !== 0 ? `${short.list.length} videos kept` : '',
      short.counts.videos !== 0 || short.counts.files !== 0 || short.counts.bytes !== 0 || short.counts.meta !== 0 ? 'the database holds something' : '',
      short.v.keepEvents.length !== 0 ? `keep events ${JSON.stringify(short.v.keepEvents)}` : '',
      ...short.consoles,
    ], results.underMinimum);
    await short.p.close();

    // ---- b. past the minimum, to the end: kept ----
    g.reset();
    const full = await session(ctx, 'kept', `${mesh}&keepMinimum=3`, ended);
    kept = (await full.p.evaluate(() => (window as any).__idbKeep.files())) as KeptFile[];
    results.kept = { t: full.v.t, keep: full.v.keep, events: full.v.keepEvents, list: full.list, counts: full.counts, roles: kept.map((f) => f.role) };
    // What the hash list says the played rendition holds, asked of the origin directly.
    const list = (await (await fetch(`${origin}/${root}`)).json()) as { files: { role: string; sha256: string; name: string }[]; renditions: { id: string; playlist: string }[] };
    const playedRendition = kept.find((f) => f.role === 'segment')?.rendition ?? null;
    const playlistName = list.renditions.find((r) => r.id === playedRendition)?.playlist;
    const playlistSha = list.files.find((f) => f.name === playlistName)?.sha256;
    const playlistText = playlistSha ? await (await fetch(`${origin}/${root}/${playlistSha}.m3u8`)).text() : '';
    const segmentsOfPlayed = playlistText.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#')).length;
    const keptSegments = kept.filter((f) => f.role === 'segment' && f.rendition === playedRendition).length;
    keptSegmentCount = keptSegments;
    fail('kept', [
      full.v.errors.length !== 0 ? `errors ${JSON.stringify(full.v.errors)}` : '',
      full.v.keep?.state !== 'keeping' ? `state ${full.v.keep?.state}` : '',
      full.v.keepEvents[0] !== 'keeping:3 s played' ? `keep events ${JSON.stringify(full.v.keepEvents)}` : '',
      full.list.length !== 1 || full.list[0]?.root !== root ? `kept ${JSON.stringify(full.list.map((x) => x.root))}` : '',
      JSON.stringify(full.list[0]?.reasons) !== '["watched"]' ? `reasons ${JSON.stringify(full.list[0]?.reasons)}` : '',
      playedRendition === null ? 'no segment kept' : '',
      !(segmentsOfPlayed > 1) || keptSegments !== segmentsOfPlayed ? `${keptSegments} of ${segmentsOfPlayed} segments of ${playedRendition} kept` : '',
      !kept.some((f) => f.role === 'hashlist' && f.sha256 === root) ? 'the hash list is not kept' : '',
      !kept.some((f) => f.role === 'playlist-master') ? 'the master playlist is not kept' : '',
      !kept.some((f) => f.role === 'playlist' && f.sha256 === playlistSha) ? 'the played playlist is not kept' : '',
      !kept.some((f) => f.role === 'init' && f.rendition === playedRendition) ? 'the init is not kept' : '',
      kept.some((f) => f.root !== root) ? 'a file under another root' : '',
      full.counts.files !== kept.length || full.counts.bytes !== kept.length ? `entries ${full.counts.files}, bytes ${full.counts.bytes}` : '',
      full.v.keep?.written !== kept.length ? `the session says ${full.v.keep?.written} written, the database holds ${kept.length}` : '',
      ...full.consoles,
    ], results.kept);
    await full.p.close();
  } finally {
    await ctx.close();
  }

  // ---- b. the browser again, the same profile; the origin refuses every file ----
  ctx = await launch();
  const keptShas = new Set(kept.map((f) => f.sha256));
  const askedKept = (): string[] =>
    g
      .log()
      .map((x) => x.path)
      .filter((p) => {
        const last = p.split('/').pop() ?? '';
        return p === `/${root}` || last === 'master.m3u8' || keptShas.has(last.slice(0, last.indexOf('.')));
      });
  try {
    for (const [name, q] of [
      ['replay, mesh', mesh],
      ['replay, no mesh', ''],
    ] as const) {
      g.refuse(true);
      g.reset();
      const r = await session(ctx, name, `${q}&keepMinimum=3`, ended);
      const res = { t: r.v.t, ended: r.v.ended, keep: r.v.keep, gate: g.log().length, askedKept: askedKept(), rejected: r.v.rejected, mesh: r.v.mesh };
      results[name] = res;
      fail(name, [
        r.v.errors.length !== 0 ? `errors ${JSON.stringify(r.v.errors)}` : '',
        !r.v.playing ? 'never played' : '',
        !(r.v.t >= CLIP_S - 1) ? `stopped at ${r.v.t} s` : '',
        // Every segment from the store (the player's fetches are `no-store`, so none can come
        // from the HTTP cache past the gate), plus at least the hash list, playlist and init.
        !(r.v.keep?.fromStore >= keptSegmentCount + 3) ? `${r.v.keep?.fromStore} files from the store, ${keptSegmentCount} segments kept` : '',
        r.v.keep?.refused !== 0 ? `${r.v.keep?.refused} refused` : '',
        res.askedKept.length !== 0 ? `the origin was asked for kept files: ${res.askedKept.join(' ')}` : '',
        g.log().some((x) => !x.refused) ? 'the gate let a request through' : '',
        r.v.rejected.length !== 0 ? `rejected ${JSON.stringify(r.v.rejected)}` : '',
        (r.v.mesh?.rejected ?? []).length !== 0 ? `mesh rejected ${JSON.stringify(r.v.mesh?.rejected)}` : '',
        name === 'replay, mesh' && r.v.mesh?.segments?.http !== 0 ? `${r.v.mesh?.segments?.http} segments over HTTP` : '',
        ...r.consoles,
      ], res);
      await r.p.close();
    }

    // ---- c. a byte changed in a stored segment and in the init: refused, fetched again, stored right ----
    const segment = kept.filter((f) => f.role === 'segment').sort((x, y) => (x.sha256 < y.sha256 ? -1 : 1))[1]!;
    const initFile = kept.find((f) => f.role === 'init' && f.rendition === segment.rendition)!;
    const tp = await ctx.newPage();
    await tp.goto(`${pages}/?nothing=1`);
    for (const f of [segment, initFile]) await tp.evaluate((k: string) => (window as any).__idbKeep.flip(k), `${root}/${f.sha256}`);
    const flippedBefore = await Promise.all([segment, initFile].map((f) => tp.evaluate((k: string) => (window as any).__idbKeep.sha(k), `${root}/${f.sha256}`)));
    await tp.close();
    g.refuse(false);
    g.reset();
    const c = await session(ctx, 'tampered', `${mesh}&keepMinimum=3`, ended);
    const fetched = g.log().map((x) => x.path.split('/').pop() ?? '');
    const segmentsFetched = fetched.filter((n) => n.endsWith('.m4s'));
    const after = await Promise.all([segment, initFile].map((f) => c.p.evaluate((k: string) => (window as any).__idbKeep.sha(k), `${root}/${f.sha256}`)));
    const res = { t: c.v.t, keep: c.v.keep, flippedBefore, after, segmentsFetched, initFetched: fetched.filter((n) => n.startsWith(initFile.sha256)).length, gate: g.log().map((x) => x.path) };
    results.tampered = res;
    fail('tampered', [
      c.v.errors.length !== 0 ? `errors ${JSON.stringify(c.v.errors)}` : '',
      !(c.v.t >= CLIP_S - 1) ? `stopped at ${c.v.t} s` : '',
      flippedBefore[0] === segment.sha256 || flippedBefore[1] === initFile.sha256 ? 'the flip did not change the stored bytes' : '',
      c.v.keep?.refused !== 2 ? `${c.v.keep?.refused} refused, not 2` : '',
      JSON.stringify(segmentsFetched) !== JSON.stringify([`${segment.sha256}.m4s`]) ? `segments fetched from the origin: ${JSON.stringify(segmentsFetched)}` : '',
      res.initFetched < 1 ? 'the init was not fetched again' : '',
      after[0] !== segment.sha256 || after[1] !== initFile.sha256 ? `stored again: ${JSON.stringify(after)}` : '',
      c.v.rejected.length !== 0 ? `rejected ${JSON.stringify(c.v.rejected)}` : '',
      ...c.consoles,
    ], res);
    await c.p.close();
  } finally {
    await ctx.close();
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
  rmSync(work, { recursive: true, force: true }); // the profile and the throwaway node key with it
}

main().then(
  () => {
    cleanup();
    console.log('keep e2e: PASS');
    process.exit(0);
  },
  (e: Error) => {
    cleanup();
    console.error(`keep e2e: FAIL\n${e.stack ?? e.message}`);
    process.exit(1);
  },
);
