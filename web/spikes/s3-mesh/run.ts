/**
 * Spike S3 (ADR 0008, A1): p2p-media-loader v4 + hls.js on NFX hash-named playlists with
 * our own tracker. Self-contained: starts the tracker and two origins (one clean, one that
 * lies about one segment), then drives three fresh Playwright Chromium contexts:
 *
 *   A  malicious seed: loads from the lying origin with validation OFF, so it caches a
 *      tampered 360p segment and offers it to the swarm;
 *   B  honest viewer: clean origin, sha256 validators ON, P2P-favouring windows;
 *   C  control: no NFX stream swarm IDs, so our tracker must refuse its announces.
 *
 * Usage: npx tsx run.ts   (expects ../s4-cmaf/out60 from `NFX_DURATION=60 npx tsx package.ts out60`)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const s4 = resolve(here, '../s4-cmaf');
const store = join(s4, 'out60/store');
const { root } = JSON.parse(readFileSync(join(s4, 'out60/nfx.json'), 'utf8')) as { root: string };
const list = JSON.parse(readFileSync(join(store, root), 'utf8')) as {
  video: string;
  files: { name: string; role: string; sha256: string; size: number }[];
  renditions: { id: string; playlist: string }[];
};

// The segment the lying origin corrupts: 360p, index 5 (plays at 10-12 s).
const r360 = list.renditions.find((r) => r.id === '360p');
const pl360 = list.files.find((f) => f.name === r360?.playlist);
const segs360 = readFileSync(join(store, pl360?.sha256 ?? ''), 'utf8').split('\n').filter((l) => l.endsWith('.m4s')).map((l) => l.slice(0, 64));
const TAMPER_INDEX = 5;
const tampered = segs360[TAMPER_INDEX] ?? '';

const staticDir = join(here, 'out/static');
mkdirSync(staticDir, { recursive: true });
copyFileSync(join(here, 'mesh.html'), join(staticDir, 'mesh.html'));
copyFileSync(join(here, 'node_modules/hls.js/dist/hls.min.js'), join(staticDir, 'hls.min.js'));
copyFileSync(join(here, 'node_modules/p2p-media-loader-hlsjs/dist/p2p-media-loader-hlsjs.iife.min.js'), join(staticDir, 'p2pml-hlsjs.iife.min.js'));

const children: ChildProcess[] = [];
const trackerLog: { event: string; swarm?: string; infoHash?: string }[] = [];
function start(cwd: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(join(cwd, 'node_modules/.bin/tsx'), args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  return child;
}
const tracker = start(here, ['tracker.ts', '8792', join(store, root)]);
tracker.stdout?.on('data', (d: Buffer) => {
  for (const line of d.toString().split('\n').filter(Boolean)) trackerLog.push(JSON.parse(line));
});
start(s4, ['origin.ts', store, root, '8794', '127.0.0.1'], { NFX_STATIC: staticDir });
start(s4, ['origin.ts', store, root, '8795', '127.0.0.1'], { NFX_STATIC: staticDir, NFX_TAMPER: tampered });
await new Promise((r) => setTimeout(r, 3000));

interface St {
  ready: boolean;
  bytes: { http: number; p2p: number };
  up: number;
  peers: number;
  validations: { source: string; file: string; ok: boolean }[];
  segErrors: string[];
  errors: string[];
  swarms: { streamType: string; height: number; id?: string }[];
  loaded: { src: string; id: number }[];
}
const st = (p: Page): Promise<St> => p.evaluate(() => (window as unknown as { __nfx: St }).__nfx);
const t = (p: Page): Promise<number> => p.evaluate(() => (document.getElementById('v') as HTMLVideoElement).currentTime);
async function until(p: Page, what: string, cond: (s: St) => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond(await st(p))) return true;
    await p.waitForTimeout(500);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
const url = (port: number, extra: string): string =>
  `http://127.0.0.1:${port}/s/mesh.html?root=${root}&tracker=${encodeURIComponent('ws://127.0.0.1:8792')}&${extra}`;

const results: [string, boolean, string][] = [];
const browser = await chromium.launch({ headless: true });
try {
  // A: malicious seed.
  const a = await (await browser.newContext()).newPage();
  await a.goto(url(8795, 'validate=0&httpWindow=300'));
  await until(a, 'A ready', (s) => s.ready, 20_000);
  await a.evaluate(() => (document.getElementById('v') as HTMLVideoElement).play());
  const aFull = await until(a, 'A cached all 360p segments', (s) => s.loaded.filter((l) => l.src === 'http').length >= segs360.length, 60_000);
  const sa = await st(a);
  console.log(`A: loaded ${sa.loaded.length} segments over HTTP (tampered #${TAMPER_INDEX} ${tampered.slice(0, 12)} among them): ${aFull}`);

  // B: honest viewer.
  const b = await (await browser.newContext()).newPage();
  await b.goto(url(8794, 'validate=1&httpWindow=4'));
  await until(b, 'B ready', (s) => s.ready, 20_000);
  const bPeered = await until(b, 'B connected to a peer', (s) => s.peers > 0, 30_000);
  await b.evaluate(() => (document.getElementById('v') as HTMLVideoElement).play());
  await until(b, 'B rejected the tampered P2P segment and played past it', async (s) =>
    s.validations.some((v) => v.source === 'p2p' && !v.ok) && s.bytes.p2p > 0 && (await t(b)) > 14, 60_000);
  const sb = await st(b);
  const sa2 = await st(a);
  const tb = await t(b);
  const badP2P = sb.validations.filter((v) => v.source === 'p2p' && !v.ok);
  const goodP2P = sb.validations.filter((v) => v.source === 'p2p' && v.ok).length;
  const fatal = sb.errors.filter((e) => e.endsWith(':true'));
  const reloaded = sb.loaded.filter((l) => l.id === TAMPER_INDEX);

  results.push(['p2p-media-loader v4 + hls.js on hash-named playlists, own tracker', bPeered && sb.bytes.p2p > 0 && sa2.up > 0,
    `B: ${sb.peers} peer(s), ${sb.bytes.p2p} bytes P2P + ${sb.bytes.http} HTTP; A uploaded ${sa2.up} bytes; ${goodP2P} P2P segments passed sha256`]);
  results.push(['sha256 validateP2PSegment rejects a tampered segment', badP2P.length > 0 && badP2P.every((v) => v.file === tampered.slice(0, 12)),
    `rejected ${badP2P.map((v) => v.file).join(', ')} (tampered = ${tampered.slice(0, 12)}); segment #${TAMPER_INDEX} then loaded via ${reloaded.map((l) => l.src).join('/') || '?'}; B at ${tb.toFixed(1)} s; fatal errors ${fatal.length}; segment errors ${JSON.stringify(sb.segErrors)}`]);
  const ids = [...new Set(sb.swarms.map((s) => s.id))];
  results.push(['streamSwarmIdBuilder yields NFX swarm ids (one per rendition)', ids.length === list.renditions.length && ids.every((i) => i?.startsWith(`nfx/1/web/${list.video}/`)),
    ids.join(' | ')]);

  // C: control, default p2p-media-loader swarm ids: our tracker must refuse them.
  const rejectsBefore = trackerLog.filter((l) => l.event === 'reject').length;
  const c = await (await browser.newContext()).newPage();
  await c.goto(url(8794, 'validate=1&httpWindow=4&swarm=default'));
  await until(c, 'C ready', (s) => s.ready, 20_000);
  await c.waitForTimeout(8000);
  const sc = await st(c);
  const rejects = trackerLog.filter((l) => l.event === 'reject').length - rejectsBefore;
  results.push(['own tracker admits only NFX swarms', sc.peers === 0 && rejects > 0,
    `control peer with default swarm ids: ${rejects} announce(s) refused, ${sc.peers} peers; allowed swarms: ${[...new Set(trackerLog.filter((l) => l.event === 'allow').map((l) => l.swarm))].length}`]);
} finally {
  await browser.close();
  for (const child of children) child.kill();
}

let failed = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n     ${detail}`);
  failed += ok ? 0 : 1;
}
process.exit(failed ? 1 : 0);
