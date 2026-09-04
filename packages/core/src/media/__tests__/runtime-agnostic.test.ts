import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Lane rule: `@sovit/core/media` planning code is runtime-agnostic. Only `media/node/` may
 * import `node:*`; tests are exempt (they are Node by definition).
 */
const MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const NODE_IMPORT = /^\s*(import|export)\b[^;]*?\bfrom\s+['"]node:[^'"]+['"]/m;
const NODE_REQUIRE = /require\(\s*['"]node:/;
const NODE_DYNAMIC = /import\(\s*['"]node:/;

describe('runtime-agnostic planning code', () => {
  const files = walk(MEDIA_DIR).map((p) => relative(MEDIA_DIR, p));
  const planning = files.filter((f) => !f.startsWith('node/') && !f.startsWith('__tests__/'));
  const nodeAdapters = files.filter((f) => f.startsWith('node/'));

  it('has planning files and node adapter files to check', () => {
    expect(planning.length).toBeGreaterThan(8);
    expect(nodeAdapters.length).toBeGreaterThan(3);
    expect(planning).toContain('pipeline.ts');
    expect(planning).toContain('index.ts');
    expect(planning).toContain('testing/fakes.ts');
  });

  it.each(
    walk(MEDIA_DIR)
      .map((p) => relative(MEDIA_DIR, p))
      .filter((f) => !f.startsWith('node/') && !f.startsWith('__tests__/')),
  )('%s has no node: import', (file) => {
    const src = readFileSync(join(MEDIA_DIR, file), 'utf8');
    expect(src).not.toMatch(NODE_IMPORT);
    expect(src).not.toMatch(NODE_REQUIRE);
    expect(src).not.toMatch(NODE_DYNAMIC);
    // and nothing reaches the adapters from planning code either
    expect(src).not.toMatch(/from\s+['"]\.\/node\//);
  });

  it('index.ts (the barrel) does not re-export the node adapters', () => {
    const src = readFileSync(join(MEDIA_DIR, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/['"]\.\/node/);
  });

  it('the node adapters DO use node: modules (sanity check that the grep works)', () => {
    const all = nodeAdapters.map((f) => readFileSync(join(MEDIA_DIR, f), 'utf8')).join('\n');
    expect(all).toMatch(NODE_IMPORT);
  });

  it('no planning file references Buffer, process or __dirname', () => {
    for (const f of planning) {
      const src = readFileSync(join(MEDIA_DIR, f), 'utf8');
      expect(src, f).not.toMatch(/\bBuffer\b\s*\./);
      expect(src, f).not.toMatch(/\bprocess\.(env|cwd|platform)\b/);
      expect(src, f).not.toMatch(/__dirname|__filename/);
    }
  });
});
