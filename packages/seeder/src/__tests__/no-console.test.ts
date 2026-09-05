/**
 * SECURITY.md invariant 7: the redacting logger is the only output path. This test greps
 * `packages/seeder/src` for direct `console.` usage (and raw `process.stdout/stderr`
 * writes) outside the logger module and the Node process adapter.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['log/logger.ts', 'log/redact.ts', 'adapters/node/process.ts']);
// Built by concatenation so this file does not match itself.
const CONSOLE = ['con', 'sole', '.'].join('');
const STDIO = ['process.', 'std'].join('');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('no direct console / stdio usage outside the logger', () => {
  it('finds none', async () => {
    const files = await walk(SRC);
    expect(files.length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f);
      if (ALLOWED.has(rel) || rel === path.relative(SRC, fileURLToPath(import.meta.url))) continue;
      const text = await readFile(f, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line.includes(CONSOLE) || line.includes(STDIO))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
