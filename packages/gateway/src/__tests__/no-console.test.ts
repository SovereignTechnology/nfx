/**
 * SECURITY.md invariant 7: `@sovit/seeder`'s redacting logger is the ONLY output path.
 * Greps `packages/gateway/src` for direct `console.` usage and raw `process.stdout/stderr`
 * writes. No file is exempt: the CLI writes through `nodeProcess.writeStdout` from the
 * seeder, whose implementation is the one audited exception in that package.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Built by concatenation so this file does not match itself.
const CONSOLE = ['con', 'sole', '.'].join('');
const STDIO = ['process.', 'std'].join('');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mts')) out.push(p);
  }
  return out;
}

describe('no direct console / stdio usage anywhere in packages/gateway/src', () => {
  it('finds none', async () => {
    const files = await walk(SRC);
    expect(files.length).toBeGreaterThan(10);
    const self = path.relative(SRC, fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f);
      if (rel === self) continue;
      const text = await readFile(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (line.includes(CONSOLE) || line.includes(STDIO))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
