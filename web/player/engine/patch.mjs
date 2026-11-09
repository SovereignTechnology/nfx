// web/player/engine/patch.mjs: the mesh engine the player is built from (nfx #71).
//
// The player bundles p2p-media-loader-core 4.0.0 from its own TypeScript source, with one
// patch: `signalingClientFactory`, a hook through which a stream's swarm uses a signaling
// client the player supplies (Nostr, NFX-10 §6) in place of WebTorrent tracker clients.
// Nothing else in the engine changes, and with no factory it behaves as published.
//
// Before anything is written, every input is checked against engine/pin.json:
//   - package-lock.json pins the npm tarball by the integrity (sha512) recorded there, which
//     `npm ci` verified when it installed it;
//   - node_modules/p2p-media-loader-core is that version, and its src/ tree is, file by file,
//     the tree the pin names (src_sha256, the sha256 of its manifest below), so an installed
//     copy changed after `npm ci` is refused;
//   - the patch file has the pinned sha256.
// Then the patch is applied in memory, strictly: every hunk must match its context exactly
// at the line it names (no fuzz, no offset). The patched tree must have the pinned
// out_sha256 (its manifest's sha256) before anything is written to
// out-engine/p2p-media-loader-core/src/; on any failure nothing is. Each file the patch changes gets a first line saying so
// (Apache-2.0 §4(b)). esbuild then resolves `p2p-media-loader-core` to the patched source
// (package.json, --alias).
//
//   node engine/patch.mjs            check and patch; prints NFX_ENGINE_* lines
//   node engine/patch.mjs --manifest print the src manifest of the installed package
//
// Manifest: one line per regular file under src/, "<sha256>  <path relative to the
// package>\n", sorted by path (byte order). Symlinks and anything not a regular file are
// refused.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const player = dirname(here);
const pin = JSON.parse(readFileSync(join(here, 'pin.json'), 'utf8'));
const pkgDir = join(player, 'node_modules', pin.package);
const outDir = join(player, 'out-engine', pin.package);

function die(msg) {
  console.error(`engine: ${msg}`);
  process.exit(1);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(p);
      else die(`not a regular file: ${relative(pkgDir, p)}`);
    }
  };
  walk(dir);
  return out.map((p) => relative(pkgDir, p).split('\\').join('/')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Every file is read once: what is hashed is what is patched and written.
const source = new Map(files(join(pkgDir, 'src')).map((rel) => [rel, readFileSync(join(pkgDir, rel))]));
const manifestOf = (tree) => [...tree].map(([rel, data]) => `${sha256(data)}  ${rel}\n`).join('');

if (process.argv[2] === '--manifest') {
  process.stdout.write(manifestOf(source));
  process.exit(0);
}

// ---- the inputs, against the pin ----
const lock = JSON.parse(readFileSync(join(player, 'package-lock.json'), 'utf8'));
const locked = lock.packages?.[`node_modules/${pin.package}`];
if (!locked || locked.version !== pin.version || locked.integrity !== pin.integrity || locked.resolved !== pin.tarball) {
  die(`package-lock.json does not pin ${pin.package} ${pin.version} at ${pin.integrity}`);
}
const installed = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
if (installed.name !== pin.package || installed.version !== pin.version) {
  die(`node_modules has ${installed.name} ${installed.version}, not ${pin.package} ${pin.version}: run npm ci`);
}
const srcSha = sha256(manifestOf(source));
if (srcSha !== pin.src_sha256) die(`node_modules/${pin.package}/src is not the pinned tree (${srcSha}): run npm ci`);
const patchText = readFileSync(join(here, pin.patch), 'utf8');
const patchSha = sha256(patchText);
if (patchSha !== pin.patch_sha256) die(`${pin.patch} has sha256 ${patchSha}, not the pinned ${pin.patch_sha256}`);

// ---- a strict unified-diff reader ----
function parsePatch(text) {
  const lines = text.split('\n');
  if (lines.pop() !== '') die('the patch must end with a newline');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const minus = /^--- a\/(\S+)$/.exec(lines[i] ?? '');
    const plus = /^\+\+\+ b\/(\S+)$/.exec(lines[i + 1] ?? '');
    if (!minus || !plus || minus[1] !== plus[1]) die(`patch line ${i + 1}: expected a --- a/ +++ b/ file header`);
    const path = minus[1];
    if (!path.startsWith('src/') || path.includes('\\') || path.split('/').some((p) => p === '' || p === '.' || p === '..')) {
      die(`patch names a path outside src/: ${path}`);
    }
    i += 2;
    const hunks = [];
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
      if (!h) die(`patch line ${i + 1}: bad hunk header`);
      const hunk = { oldStart: +h[1], oldLen: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLen: h[4] === undefined ? 1 : +h[4], old: [], new: [] };
      i += 1;
      while (hunk.old.length < hunk.oldLen || hunk.new.length < hunk.newLen) {
        const l = lines[i];
        if (l === undefined) die('the patch ends inside a hunk');
        const body = l.slice(1);
        if (l[0] === ' ') {
          hunk.old.push(body);
          hunk.new.push(body);
        } else if (l[0] === '-') hunk.old.push(body);
        else if (l[0] === '+') hunk.new.push(body);
        else die(`patch line ${i + 1}: not a hunk line`);
        i += 1;
      }
      if (hunk.old.length !== hunk.oldLen || hunk.new.length !== hunk.newLen) die(`patch line ${i}: hunk lengths`);
      if (hunk.oldLen === 0) die(`patch line ${i}: a hunk without context`);
      hunks.push(hunk);
    }
    if (hunks.length === 0) die(`patch: no hunks for ${path}`);
    out.push({ path, hunks });
  }
  if (new Set(out.map((f) => f.path)).size !== out.length) die('the patch names a file twice');
  return out;
}

function apply(original, hunks, path) {
  const src = original.split('\n');
  const dst = [];
  let at = 0; // next unconsumed line of src (0-based)
  let delta = 0; // new line numbers minus old ones so far
  for (const h of hunks) {
    const start = h.oldStart - 1;
    if (start < at) die(`${path}: hunks overlap or are out of order`);
    if (h.newStart - 1 !== start + delta) die(`${path}: hunk at ${h.oldStart} names new line ${h.newStart}`);
    for (let k = 0; k < h.old.length; k++) {
      if (src[start + k] !== h.old[k]) die(`${path}: hunk at line ${h.oldStart} does not match the source`);
    }
    dst.push(...src.slice(at, start), ...h.new);
    at = start + h.old.length;
    delta += h.new.length - h.old.length;
  }
  dst.push(...src.slice(at));
  return dst.join('\n');
}

// ---- patch in memory, check the result against its pin, then write ----
const out = new Map(source);
for (const { path, hunks } of parsePatch(patchText)) {
  const original = source.get(path);
  if (original === undefined) die(`the patch names a file the package lacks: ${path}`);
  const notice = `// Changed for NFX by web/player/engine/${pin.patch} (nfx #71).\n`;
  out.set(path, Buffer.from(notice + apply(original.toString('utf8'), hunks, path), 'utf8'));
}
const outSha = sha256(manifestOf(out));
if (outSha !== pin.out_sha256) die(`the patched tree has sha256 ${outSha}, not the pinned ${pin.out_sha256}`);
rmSync(join(player, 'out-engine'), { recursive: true, force: true });
for (const [rel, data] of out) {
  mkdirSync(dirname(join(outDir, rel)), { recursive: true });
  writeFileSync(join(outDir, rel), data, { mode: 0o644 });
}
writeFileSync(join(outDir, 'LICENSE'), readFileSync(join(pkgDir, 'LICENSE')));
console.log(`NFX_ENGINE=${pin.package} ${pin.version}`);
console.log(`NFX_ENGINE_SRC_SHA256=${srcSha}`);
console.log(`NFX_ENGINE_PATCH_SHA256=${patchSha}`);
console.log(`NFX_ENGINE_OUT_SHA256=${outSha}`);
