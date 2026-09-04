#!/usr/bin/env node
// Build-plan §7 / threat T12: "explicit list of native modules reviewed on every bump."
//
// Walks node_modules (including nested node_modules) and reports every package that
// carries native code, with enough context for a reviewer to decide whether it belongs:
//
//   <name>@<version> | <install path> | <markers> | scripts=<lifecycle install scripts> | <scope> | via <dependency chain>
//
// Markers:
//   binding.gyp   compiled from source at install time (would need node-gyp; blocked by ignore-scripts)
//   prebuilds     ships a prebuilds/ directory (node-gyp-build / require-addon convention)
//   .node         Node-API / NAN addon binary present
//   .bare         Bare runtime addon binary present
//   addon         package.json `addon: true` (Bare convention)
//   gypfile       package.json `gypfile: true`
//   platform-pkg  package.json restricts os/cpu/libc — a per-platform binary package
//                 (napi-rs bindings, esbuild's ELF, …) even when no *.node is present
//
// `scripts=` lists preinstall/install/postinstall if declared. `.npmrc` sets
// `ignore-scripts=true`, so none of these ever run — but a module that NEEDS one to work is
// a module that will not work here, and a module that declares one is a review flag.
//
// `via` is the shortest dependency chain from a workspace package, computed from
// package-lock.json (npm's nearest-ancestor resolution), so the reviewer can see which
// workspace dependency pulls the module in. `scope` is `runtime` or `dev-only` from the
// lockfile's `dev` flag.
//
// Invoked by scripts/native-module-inventory.sh; run directly with --root <dir> for tests.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** @param {string} p */
const posix = (p) => p.split(sep).join('/');

/** @param {string} pkgDir absolute package directory
 *  @returns {Set<string>} markers */
function detectMarkers(pkgDir, pkgJson) {
  const markers = new Set();
  if (existsSync(join(pkgDir, 'binding.gyp'))) markers.add('binding.gyp');
  if (existsSync(join(pkgDir, 'prebuilds'))) markers.add('prebuilds');
  if (pkgJson.addon === true) markers.add('addon');
  if (pkgJson.gypfile === true) markers.add('gypfile');
  if (pkgJson.os || pkgJson.cpu || pkgJson.libc) markers.add('platform-pkg');
  // Binary files anywhere in the package (not in nested node_modules).
  const stack = [pkgDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') stack.push(join(dir, e.name));
      } else if (e.name.endsWith('.node')) {
        markers.add('.node');
      } else if (e.name.endsWith('.bare')) {
        markers.add('.bare');
      }
    }
  }
  return markers;
}

/** Enumerate every installed package directory under a node_modules tree (recursive). */
function* packageDirs(nodeModules) {
  if (!existsSync(nodeModules)) return;
  for (const e of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === '.bin' || e.name === '.cache') continue;
    if (e.name.startsWith('@')) {
      const scopeDir = join(nodeModules, e.name);
      for (const s of readdirSync(scopeDir, { withFileTypes: true })) {
        if (s.isDirectory()) yield* visit(join(scopeDir, s.name));
      }
    } else {
      yield* visit(join(nodeModules, e.name));
    }
  }
}
function* visit(dir) {
  if (existsSync(join(dir, 'package.json'))) yield dir;
  yield* packageDirs(join(dir, 'node_modules'));
}

/** @returns {Record<string, any>} lockfile `packages` map, or {} */
function readLock(root) {
  const p = join(root, 'package-lock.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')).packages ?? {};
  } catch {
    return {};
  }
}

/**
 * npm resolution: from package at lock path `from`, dependency `name` resolves to the
 * nearest `<ancestor>/node_modules/<name>` that exists in the lock.
 */
function resolveDep(lock, from, name) {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (candidate in lock) {
      const entry = lock[candidate];
      // Workspace links point at the real package path.
      if (entry.link && entry.resolved && entry.resolved in lock) return entry.resolved;
      return candidate;
    }
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i === -1 ? '' : base.slice(0, i);
  }
}

/** Shortest chain (by edge count) from any workspace package to `target`. */
function chainTo(lock, workspaces, target) {
  /** @type {Map<string, string | null>} */
  const prev = new Map();
  const queue = [];
  for (const w of workspaces) {
    prev.set(w, null);
    queue.push(w);
  }
  while (queue.length) {
    const cur = queue.shift();
    if (cur === target) break;
    const entry = lock[cur] ?? {};
    const deps = Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
      ...entry.devDependencies,
    }).sort();
    for (const d of deps) {
      const next = resolveDep(lock, cur, d);
      if (next && !prev.has(next)) {
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  if (!prev.has(target)) return null;
  const chain = [];
  for (let n = target; n !== null; n = prev.get(n) ?? null) chain.unshift(n);
  return chain.map((p) => lock[p]?.name ?? p.slice(p.lastIndexOf('node_modules/') + 13));
}

export function inventory(root) {
  const lock = readLock(root);
  const workspaces = Object.keys(lock).filter((k) => k !== '' && !k.includes('node_modules/'));
  const rows = [];
  for (const dir of packageDirs(join(root, 'node_modules'))) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const markers = detectMarkers(dir, pkg);
    if (markers.size === 0) continue;
    const lockPath = posix(relative(root, dir));
    const scripts = ['preinstall', 'install', 'postinstall']
      .filter((k) => pkg.scripts && typeof pkg.scripts[k] === 'string')
      .map((k) => `${k}:${JSON.stringify(pkg.scripts[k])}`);
    const entry = lock[lockPath];
    const scope = entry ? (entry.dev ? 'dev-only' : 'runtime') : 'not-in-lockfile';
    const chain = entry ? chainTo(lock, workspaces, lockPath) : null;
    rows.push({
      name: pkg.name ?? lockPath,
      version: pkg.version ?? '?',
      path: lockPath,
      markers: [...markers].sort(),
      scripts,
      scope,
      via: chain ? chain.join('>') : '?',
    });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

export function formatRow(r) {
  return [
    `${r.name}@${r.version}`,
    r.path,
    r.markers.join(','),
    `scripts=${r.scripts.length ? r.scripts.join(';') : 'none'}`,
    r.scope,
    `via ${r.via}`,
  ].join(' | ');
}

export function platformTag() {
  return `${process.platform}-${process.arch}`;
}

function main(argv) {
  let root = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--json') json = true;
    else {
      process.stderr.write(`unknown argument ${argv[i]}\n`);
      process.exit(2);
    }
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`no such directory: ${root}\n`);
    process.exit(2);
  }
  const rows = inventory(root);
  if (json) process.stdout.write(JSON.stringify({ platform: platformTag(), rows }, null, 2) + '\n');
  else for (const r of rows) process.stdout.write(formatRow(r) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
