import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot, runNode, tempDir } from './helpers.js';

/**
 * `NostrKind.ReleaseNotice` read from the contracts SOURCE (tsconfig.scripts.json cannot
 * import packages/core). Contracts are `as const` literals, so a regex is exact.
 */
function releaseNoticeKind(): number {
  const src = readFileSync(join(repoRoot, 'packages/core/src/contracts/nostr.ts'), 'utf8');
  const m = /ReleaseNotice:\s*(\d+)/.exec(src);
  if (!m) throw new Error('NostrKind.ReleaseNotice not found in contracts/nostr.ts');
  return Number(m[1]);
}

interface Report {
  algorithm: string;
  treeHash: string;
  fileCount: number;
  totalBytes: number;
  files: { path: string; sha256: string; bytes: number }[];
  event: {
    id: string;
    pubkey: string;
    sig: string;
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  };
}

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function writeFixture(root: string): void {
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'empty-dir'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)\n');
  writeFileSync(join(root, 'assets', 'Zed.css'), 'body{}');
  writeFileSync(join(root, 'assets', 'a.css'), '');
}

/** The hash the script promises: sha256 over sorted `sha256sum`-format lines. */
function expectedTreeHash(root: string, paths: string[]): string {
  const manifest = [...paths]
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((p) => `${sha256(readFileSync(join(root, p)))}  ${p}\n`)
    .join('');
  return sha256(manifest);
}

describe('scripts/reproducible-build.mjs', () => {
  let dist: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ dir: dist, cleanup } = tempDir('dist'));
    writeFixture(dist);
  });
  afterEach(() => {
    cleanup();
  });

  it('hashes the tree deterministically in bytewise path order', () => {
    const r = runNode('reproducible-build.mjs', [dist, '--created-at', '0', '--commit', 'abc']);
    expect(r.status, r.stderr).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.algorithm).toBe('sha256');
    expect(report.files.map((f) => f.path)).toEqual([
      'assets/Zed.css',
      'assets/a.css',
      'assets/app.js',
      'index.html',
    ]);
    expect(report.fileCount).toBe(4);
    expect(report.totalBytes).toBe(31 + 15 + 6);
    expect(report.treeHash).toBe(
      expectedTreeHash(dist, ['index.html', 'assets/app.js', 'assets/Zed.css', 'assets/a.css']),
    );
    // run twice → identical
    const again = runNode('reproducible-build.mjs', [dist, '--created-at', '0', '--commit', 'abc']);
    expect(again.stdout).toBe(r.stdout);
  });

  it('matches the coreutils one-liner it documents', () => {
    const which = spawnSync('bash', ['-c', 'command -v sha256sum && command -v xargs'], {
      encoding: 'utf8',
    });
    if (which.status !== 0) return; // coreutils not available on this host; the JS-side check above still holds
    const sh = spawnSync(
      'bash',
      [
        '-c',
        `cd "$1" && find . -type f | sed 's#^\\./##' | LC_ALL=C sort | xargs -d '\\n' sha256sum | sha256sum`,
        '_',
        dist,
      ],
      { encoding: 'utf8' },
    );
    expect(sh.status).toBe(0);
    const r = runNode('reproducible-build.mjs', [dist, '--created-at', '0']);
    const report = JSON.parse(r.stdout) as Report;
    expect(sh.stdout.trim().split(/\s+/)[0]).toBe(report.treeHash);
  });

  it('changes when a single byte changes', () => {
    const a = JSON.parse(
      runNode('reproducible-build.mjs', [dist, '--created-at', '0']).stdout,
    ) as Report;
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(2)\n');
    const b = JSON.parse(
      runNode('reproducible-build.mjs', [dist, '--created-at', '0']).stdout,
    ) as Report;
    expect(b.treeHash).not.toBe(a.treeHash);
  });

  it('emits an UNSIGNED addressable Nostr event template', () => {
    const r = runNode('reproducible-build.mjs', [
      dist,
      '--created-at',
      '1700000000',
      '--commit',
      'deadbeefcafe0123',
      '--version',
      '1.2.3',
      '--kind',
      '30071',
      '--d',
      'nutflix-web',
      '--url',
      'https://nutflix.example/',
    ]);
    expect(r.status, r.stderr).toBe(0);
    const { event, treeHash } = JSON.parse(r.stdout) as Report;
    expect(event.id).toBe('');
    expect(event.pubkey).toBe('');
    expect(event.sig).toBe('');
    expect(event.kind).toBe(30071);
    expect(event.created_at).toBe(1700000000);
    expect(event.tags).toContainEqual(['d', 'nutflix-web']);
    expect(event.tags).toContainEqual(['x', treeHash]);
    expect(event.tags).toContainEqual(['files', '4']);
    expect(event.tags).toContainEqual(['version', '1.2.3']);
    expect(event.tags).toContainEqual(['commit', 'deadbeefcafe0123']);
    expect(event.tags).toContainEqual(['r', 'https://nutflix.example/']);
    expect(event.content).toContain(treeHash);
    expect(event.content).toContain('sha256sum');
    expect(Object.keys(event).sort()).toEqual([
      'content',
      'created_at',
      'id',
      'kind',
      'pubkey',
      'sig',
      'tags',
    ]);
  });

  it('defaults --kind to NostrKind.ReleaseNotice (contracts v3: single source of truth)', () => {
    const r = runNode('reproducible-build.mjs', [dist, '--created-at', '0']);
    expect(r.status, r.stderr).toBe(0);
    const { event } = JSON.parse(r.stdout) as Report;
    expect(event.kind).toBe(releaseNoticeKind());
    expect(event.kind).toBeGreaterThanOrEqual(30000);
    expect(event.kind).toBeLessThanOrEqual(39999);
  });

  it('takes created_at from SOURCE_DATE_EPOCH', () => {
    const r = runNode('reproducible-build.mjs', [dist], {
      env: { SOURCE_DATE_EPOCH: '1234567890' },
    });
    expect((JSON.parse(r.stdout) as Report).event.created_at).toBe(1234567890);
  });

  it('reads --version from --pkg package.json and writes --out', () => {
    const { dir: pkg, cleanup: c2 } = tempDir('pkg');
    try {
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
      const out = join(pkg, 'nested', 'report.json');
      const r = runNode('reproducible-build.mjs', [
        dist,
        '--pkg',
        pkg,
        '--out',
        out,
        '--created-at',
        '0',
      ]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('');
      const report = JSON.parse(readFileSync(out, 'utf8')) as Report;
      expect(report.event.tags).toContainEqual(['version', '9.9.9']);
    } finally {
      c2();
    }
  });

  it('refuses symlinks, empty and missing trees', () => {
    symlinkSync(join(dist, 'index.html'), join(dist, 'link.html'));
    const r = runNode('reproducible-build.mjs', [dist]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/symlink/);

    const { dir: empty, cleanup: c2 } = tempDir('empty');
    try {
      expect(runNode('reproducible-build.mjs', [empty]).status).toBe(1);
    } finally {
      c2();
    }
    const missing = runNode('reproducible-build.mjs', [join(dist, 'nope')]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/not found/);
  });

  it('rejects bad arguments', () => {
    expect(runNode('reproducible-build.mjs', []).status).toBe(1);
    expect(runNode('reproducible-build.mjs', [dist, '--kind', 'x']).status).toBe(1);
    expect(runNode('reproducible-build.mjs', [dist, '--bogus']).status).toBe(1);
  });
});
