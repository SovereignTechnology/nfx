/**
 * A minimal NFX-05 §6 origin over a content-addressed store (spike tool for S2–S4).
 *
 *   GET|HEAD /<sha256>[.<ext>]            file bytes (extension ignored for lookup)
 *   GET|HEAD /<root>                      the hash list
 *   GET|HEAD /<root>/master.m3u8          the master playlist
 *   GET|HEAD /<root>/<sha256>.<ext>       a file listed in that root's hash list
 *   GET      /player/                     hls.js test page (?root=<root>)
 *
 * Hits carry `Cache-Control: public, max-age=31536000, immutable`; misses and errors carry
 * `no-store` (NFX-05 §6.1). CORS `*` on everything hash-addressed.
 *
 * Usage: npx tsx origin.ts <store-dir> <root>[,<root>…] [port=8791] [host=0.0.0.0]
 * Spike-only env: NFX_STATIC=<dir> serves that directory under /s/ (S3's mesh page);
 * NFX_TAMPER=<sha256> flips the last byte of that file whenever it is served (a lying
 * origin, used to seed a malicious peer in S3).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [storeArg, rootsArg, portArg, hostArg] = process.argv.slice(2);
if (!storeArg || !rootsArg) {
  console.error('usage: origin.ts <store-dir> <root>[,<root>…] [port] [host]');
  process.exit(2);
}
const store = resolve(storeArg);
const port = Number(portArg ?? 8791);
const host = hostArg ?? '0.0.0.0';
const HEX64 = /^[0-9a-f]{64}$/;

const TYPES: Record<string, string> = {
  'playlist-master': 'application/vnd.apple.mpegurl',
  playlist: 'application/vnd.apple.mpegurl',
  init: 'video/mp4',
  segment: 'video/iso.segment',
  thumb: 'image/jpeg',
  subtitle: 'text/vtt',
};

interface Listed {
  role: string;
  name: string;
}
const lists = new Map<string, Map<string, Listed>>(); // root -> sha -> entry
const roleOf = new Map<string, string>(); // sha -> role, across all lists
for (const root of rootsArg.split(',')) {
  if (!HEX64.test(root)) throw new Error(`bad root ${root}`);
  const list = JSON.parse(readFileSync(join(store, root), 'utf8')) as { files: (Listed & { sha256: string })[] };
  const bySha = new Map<string, Listed>();
  for (const f of list.files) {
    bySha.set(f.sha256, { role: f.role, name: f.name });
    roleOf.set(f.sha256, f.role);
  }
  lists.set(root, bySha);
}

const player = readFileSync(join(here, 'player.html'));
const staticDir = process.env.NFX_STATIC ? resolve(process.env.NFX_STATIC) : undefined;
const tamper = process.env.NFX_TAMPER;
const STATIC_TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json' };
const hlsJs = readFileSync(join(here, 'node_modules/hls.js/dist/hls.min.js'));

const server = createServer((req, res) => {
  const send = (status: number, body: Buffer | string, headers: Record<string, string>): void => {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    res.writeHead(status, { 'Content-Length': String(buf.length), ...headers });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  const miss = (status: number, why: string): void =>
    send(status, why, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  const hit = (sha: string, contentType: string): void => {
    const path = join(store, sha);
    if (!existsSync(path)) return miss(404, 'not in store');
    const bytes = readFileSync(path);
    if (sha === tamper) bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    send(200, bytes, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    });
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') return miss(405, 'GET or HEAD');
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/player/' || path === '/player/index.html') return send(200, player, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (path === '/player/hls.min.js') return send(200, hlsJs, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });

  if (staticDir && path.startsWith('/s/')) {
    const name = path.slice(3);
    // Flat names only, never dot-leading (`.`/`..` would name directories), regular files only.
    const file = join(staticDir, name);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || !existsSync(file) || !statSync(file).isFile()) return miss(404, 'no such static file');
    return send(200, readFileSync(join(staticDir, name)), {
      'Content-Type': STATIC_TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
  }
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 1) {
    const [sha] = (parts[0] ?? '').split('.');
    if (!sha || !HEX64.test(sha)) return miss(404, 'not a content address');
    if (lists.has(sha)) return hit(sha, 'application/json');
    return hit(sha, TYPES[roleOf.get(sha) ?? ''] ?? 'application/octet-stream');
  }
  if (parts.length === 2) {
    const [root, name] = parts as [string, string];
    const list = lists.get(root);
    if (!list) return miss(404, 'unknown root');
    if (name === 'master.m3u8') {
      const master = [...list].find(([, f]) => f.role === 'playlist-master');
      return master ? hit(master[0], TYPES['playlist-master'] ?? '') : miss(404, 'no master');
    }
    const [sha, ext] = name.split('.');
    if (!sha || !ext || !HEX64.test(sha)) return miss(404, 'not a content name');
    const entry = list.get(sha);
    if (!entry) return miss(404, 'not listed in this root');
    return hit(sha, TYPES[entry.role] ?? 'application/octet-stream');
  }
  return miss(404, 'no route');
});
server.listen(port, host, () => console.log(`origin on http://${host}:${port}/  roots ${[...lists.keys()].map((r) => r.slice(0, 12)).join(', ')}`));
