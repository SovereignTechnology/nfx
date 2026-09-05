#!/usr/bin/env node
// Build-plan §7 / threat T13: "reproducible build, hash in signed Nostr event".
//
// Hashes a built dist tree deterministically and emits an UNSIGNED Nostr event template
// carrying that hash. Signing is done elsewhere, by the org key, offline — this script
// never sees a key and leaves `id`, `pubkey` and `sig` empty.
//
// Tree hash definition (so anyone can reproduce it with coreutils alone):
//   for every regular file under <dist>, in bytewise (LC_ALL=C) order of its
//   `/`-separated path relative to <dist>, emit the line `<sha256 hex>  <path>\n`
//   (exactly sha256sum's format); the tree hash is the sha256 of that manifest text.
//   Equivalent shell:
//     cd <dist> && find . -type f | sed 's#^\./##' | LC_ALL=C sort | xargs -d '\n' sha256sum | sha256sum
//
// Only node:crypto sha256 is used (SECURITY.md "No model writes crypto").
//
// Usage:
//   node scripts/reproducible-build.mjs <dist-dir> [options]
//     --out <file>        write the JSON report there instead of stdout
//     --kind <n>          Nostr event kind (default 30071 = NostrKind.ReleaseNotice, contracts v3;
//                         a test pins this default to the contract constant)
//     --d <tag>           `d` tag for the addressable event (default nutflix-web)
//     --version <v>       version string tag (default: package.json version of --pkg, or none)
//     --pkg <dir>         package directory whose package.json supplies --version
//     --commit <sha>      git commit tag (default: `git rev-parse HEAD` if inside a repo)
//     --created-at <n>    event created_at (default: $SOURCE_DATE_EPOCH, else now)
//     --url <u>           `r` tag; repeatable (where the build is served from)
//     --manifest          also print the sha256sum-style manifest to stderr
import { createHash } from 'node:crypto';

/** = NostrKind.ReleaseNotice (contracts v3, ADR 0004). Pinned by test. */
export const RELEASE_NOTICE_KIND = 30071;
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Bytewise comparison, matching LC_ALL=C sort. */
function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Walk <root> and return every regular file's relative posix path. Symlinks are refused:
 * a symlink makes the hash depend on what it points at, which is outside the tree.
 */
export function listFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(`symlink in dist tree is not allowed: ${relative(root, p)}`);
      }
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(relative(root, p).split(sep).join('/'));
      else throw new Error(`unsupported entry in dist tree: ${relative(root, p)}`);
    }
  }
  return out.sort(byteCompare);
}

/** @returns {{ treeHash: string, manifest: string, files: {path:string, sha256:string, bytes:number}[] }} */
export function hashTree(root) {
  const files = [];
  let manifest = '';
  for (const path of listFiles(root)) {
    const buf = readFileSync(join(root, path));
    const digest = sha256hex(buf);
    files.push({ path, sha256: digest, bytes: buf.length });
    manifest += `${digest}  ${path}\n`;
  }
  return { treeHash: sha256hex(Buffer.from(manifest, 'utf8')), manifest, files };
}

export function reproduceCommand(dist) {
  return `cd ${dist} && find . -type f | sed 's#^\\./##' | LC_ALL=C sort | xargs -d '\\n' sha256sum | sha256sum`;
}

/**
 * Unsigned NIP-01 event template. id/pubkey/sig are left empty on purpose: the signer
 * (org key, offline) fills them. Tags use `x` = sha256 hex, the convention shared by
 * NIP-92 imeta and Blossom (BUD-01) for file hashes.
 */
export function eventTemplate({
  kind,
  d,
  treeHash,
  fileCount,
  totalBytes,
  version,
  commit,
  urls,
  createdAt,
}) {
  const tags = [
    ['d', d],
    ['x', treeHash],
    ['files', String(fileCount)],
    ['size', String(totalBytes)],
  ];
  if (version) tags.push(['version', version]);
  if (commit) tags.push(['commit', commit]);
  for (const u of urls) tags.push(['r', u]);
  const content =
    `${d}${version ? ` ${version}` : ''}${commit ? ` (${commit.slice(0, 12)})` : ''}: ` +
    `sha256 tree hash ${treeHash} over ${fileCount} files, ${totalBytes} bytes. ` +
    `Reproduce: build from the tagged commit, then run ` +
    `\`find . -type f | sed 's#^\\./##' | LC_ALL=C sort | xargs -d '\\n' sha256sum | sha256sum\` in the dist directory.`;
  return { id: '', pubkey: '', created_at: createdAt, kind, tags, content, sig: '' };
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function parseArgs(argv) {
  // Must equal `NostrKind.ReleaseNotice` (packages/core/src/contracts/nostr.ts); this .mjs
  // cannot import the TS contracts, so scripts/__tests__/reproducible-build.test.ts asserts it.
  const opts = { kind: RELEASE_NOTICE_KIND, d: 'nutflix-web', urls: [], manifest: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--out':
        opts.out = next();
        break;
      case '--kind':
        opts.kind = Number.parseInt(next(), 10);
        if (!Number.isInteger(opts.kind) || opts.kind < 0)
          throw new Error('--kind must be a non-negative integer');
        break;
      case '--d':
        opts.d = next();
        break;
      case '--version':
        opts.version = next();
        break;
      case '--pkg':
        opts.pkg = next();
        break;
      case '--commit':
        opts.commit = next();
        break;
      case '--created-at':
        opts.createdAt = Number.parseInt(next(), 10);
        if (!Number.isInteger(opts.createdAt)) throw new Error('--created-at must be an integer');
        break;
      case '--url':
        opts.urls.push(next());
        break;
      case '--manifest':
        opts.manifest = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        positional.push(a);
    }
  }
  if (positional.length !== 1)
    throw new Error('usage: reproducible-build.mjs <dist-dir> [options]');
  opts.dist = positional[0];
  return opts;
}

export function run(argv, env = process.env) {
  const opts = parseArgs(argv);
  const dist = resolve(opts.dist);
  let st;
  try {
    st = lstatSync(dist);
  } catch {
    throw new Error(
      `dist directory not found: ${dist} (build first; packages/app-web has no build output yet?)`,
    );
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${dist}`);

  const { treeHash, manifest, files } = hashTree(dist);
  if (files.length === 0) throw new Error(`dist directory is empty: ${dist}`);
  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);

  let version = opts.version;
  if (!version && opts.pkg) {
    version = JSON.parse(readFileSync(join(resolve(opts.pkg), 'package.json'), 'utf8')).version;
  }
  const commit = opts.commit ?? gitHead(dist);
  const sourceDateEpoch = env.SOURCE_DATE_EPOCH ? Number.parseInt(env.SOURCE_DATE_EPOCH, 10) : NaN;
  const createdAt =
    opts.createdAt ??
    (Number.isInteger(sourceDateEpoch) ? sourceDateEpoch : Math.floor(Date.now() / 1000));

  const report = {
    algorithm: 'sha256',
    dist: opts.dist,
    treeHash,
    fileCount: files.length,
    totalBytes,
    reproduce: reproduceCommand(opts.dist),
    files,
    event: eventTemplate({
      kind: opts.kind,
      d: opts.d,
      treeHash,
      fileCount: files.length,
      totalBytes,
      version,
      commit,
      urls: opts.urls,
      createdAt,
    }),
  };
  const text = JSON.stringify(report, null, 2) + '\n';
  if (opts.out) {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, text);
    process.stderr.write(`tree sha256 ${treeHash} (${files.length} files) -> ${opts.out}\n`);
  } else {
    process.stdout.write(text);
  }
  if (opts.manifest) process.stderr.write(manifest);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `reproducible-build: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
