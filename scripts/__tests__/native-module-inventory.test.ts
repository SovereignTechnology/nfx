import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBash, runNode, tempDir } from './helpers.js';

function pkg(root: string, rel: string, json: Record<string, unknown>, files: string[] = []): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.0.0', ...json }));
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
}

/** A miniature workspace: two workspace packages, one native runtime dep pulled through a
 *  chain, one dev-only napi binding, one nested (shadowed) copy, one package with an
 *  install script, and plenty of pure-JS noise that must NOT appear. */
function buildFixture(root: string): void {
  pkg(root, '', { name: 'fixture-root', workspaces: ['packages/*'] });
  pkg(root, 'packages/core', { name: '@fx/core', dependencies: { 'pure-js': '1.0.0' } });
  pkg(root, 'packages/seeder', {
    name: '@fx/seeder',
    dependencies: { '@fx/core': '0.0.0', hyper: '1.0.0' },
    devDependencies: { bundler: '1.0.0' },
  });
  pkg(root, 'node_modules/pure-js', { name: 'pure-js', version: '1.0.0' });
  pkg(root, 'node_modules/hyper', {
    name: 'hyper',
    version: '1.0.0',
    dependencies: { 'sodium-ish': '2.0.0', 'pure-js': '1.0.0' },
  });
  pkg(root, 'node_modules/sodium-ish', { name: 'sodium-ish', version: '2.0.0', addon: true }, [
    'prebuilds/linux-x64/sodium-ish.node',
    'prebuilds/linux-x64/sodium-ish.bare',
  ]);
  pkg(root, 'node_modules/bundler', {
    name: 'bundler',
    version: '1.0.0',
    optionalDependencies: { '@bundler/linux-x64': '1.0.0' },
    dependencies: { compiler: '1.0.0' },
  });
  pkg(
    root,
    'node_modules/@bundler/linux-x64',
    { name: '@bundler/linux-x64', version: '1.0.0', os: ['linux'], cpu: ['x64'] },
    ['bin/bundler'],
  );
  pkg(
    root,
    'node_modules/compiler',
    { name: 'compiler', version: '3.0.0', scripts: { postinstall: 'node install.js' } },
    ['compiler.node'],
  );
  // nested, shadowed copy of sodium-ish with a different version + a binding.gyp
  pkg(
    root,
    'node_modules/compiler/node_modules/sodium-ish',
    { name: 'sodium-ish', version: '1.0.0', gypfile: true },
    ['binding.gyp'],
  );
  // lockfile mirroring the tree (npm v3 lockfile `packages` map)
  const lock = {
    name: 'fixture-root',
    lockfileVersion: 3,
    packages: {
      '': { name: 'fixture-root', workspaces: ['packages/*'] },
      'node_modules/@fx/core': { resolved: 'packages/core', link: true },
      'node_modules/@fx/seeder': { resolved: 'packages/seeder', link: true },
      'packages/core': { name: '@fx/core', dependencies: { 'pure-js': '1.0.0' } },
      'packages/seeder': {
        name: '@fx/seeder',
        dependencies: { '@fx/core': '0.0.0', hyper: '1.0.0' },
        devDependencies: { bundler: '1.0.0' },
      },
      'node_modules/pure-js': { version: '1.0.0' },
      'node_modules/hyper': {
        version: '1.0.0',
        dependencies: { 'sodium-ish': '2.0.0', 'pure-js': '1.0.0' },
      },
      'node_modules/sodium-ish': { version: '2.0.0' },
      'node_modules/bundler': {
        version: '1.0.0',
        dev: true,
        optionalDependencies: { '@bundler/linux-x64': '1.0.0' },
        dependencies: { compiler: '1.0.0' },
      },
      'node_modules/@bundler/linux-x64': {
        version: '1.0.0',
        dev: true,
        optional: true,
        os: ['linux'],
        cpu: ['x64'],
      },
      'node_modules/compiler': {
        version: '3.0.0',
        dev: true,
        dependencies: { 'sodium-ish': '1.0.0' },
        hasInstallScript: true,
      },
      'node_modules/compiler/node_modules/sodium-ish': { version: '1.0.0', dev: true },
    },
  };
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock, null, 2));
}

describe('scripts/native-module-inventory.mjs', () => {
  let root: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ dir: root, cleanup } = tempDir('nmi'));
    buildFixture(root);
  });
  afterEach(() => {
    cleanup();
  });

  it('lists every native package once, with markers, install scripts, scope and chain', () => {
    const r = runNode('native-module-inventory.mjs', ['--root', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      '@bundler/linux-x64@1.0.0 | node_modules/@bundler/linux-x64 | platform-pkg | scripts=none | dev-only | via @fx/seeder>bundler>@bundler/linux-x64',
      'compiler@3.0.0 | node_modules/compiler | .node | scripts=postinstall:"node install.js" | dev-only | via @fx/seeder>bundler>compiler',
      'sodium-ish@1.0.0 | node_modules/compiler/node_modules/sodium-ish | binding.gyp,gypfile | scripts=none | dev-only | via @fx/seeder>bundler>compiler>sodium-ish',
      'sodium-ish@2.0.0 | node_modules/sodium-ish | .bare,.node,addon,prebuilds | scripts=none | runtime | via @fx/seeder>hyper>sodium-ish',
    ]);
  });

  it('--json carries the platform tag and structured rows', () => {
    const r = runNode('native-module-inventory.mjs', ['--root', root, '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      platform: string;
      rows: { name: string; markers: string[] }[];
    };
    expect(parsed.platform).toBe(`${process.platform}-${process.arch}`);
    expect(parsed.rows.map((x) => x.name)).toEqual([
      '@bundler/linux-x64',
      'compiler',
      'sodium-ish',
      'sodium-ish',
    ]);
    expect(parsed.rows[3]!.markers).toEqual(['.bare', '.node', 'addon', 'prebuilds']);
  });

  it('is empty when nothing native is installed', () => {
    const { dir, cleanup: c2 } = tempDir('nmi-empty');
    try {
      pkg(dir, 'node_modules/only-js', { name: 'only-js' });
      const r = runNode('native-module-inventory.mjs', ['--root', dir]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      c2();
    }
  });

  it('rejects unknown arguments and missing roots', () => {
    expect(runNode('native-module-inventory.mjs', ['--root', join(root, 'nope')]).status).toBe(2);
    expect(runNode('native-module-inventory.mjs', ['--bogus']).status).toBe(2);
  });
});

describe('scripts/native-module-inventory.sh (real repo)', () => {
  it('--check passes against the reviewed docs/native-modules.txt', () => {
    // Runs against the real worktree: the reviewed list must match what npm ci installed.
    const r = runBash('native-module-inventory.sh', ['--check'], {
      env: { NATIVE_INVENTORY_STRICT: process.platform === 'linux' ? '1' : '0' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
