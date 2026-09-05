#!/usr/bin/env node
// Regenerates src/tokens/tokens.css from the compiled tokens module (dist/tokens/tokens.js).
// `npm run -w packages/ui build:tokens` builds first, then runs this (Node strips the types).
// A vitest test (src/tokens/__tests__/tokens.test.ts) fails when the committed file is stale.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modUrl = pathToFileURL(join(here, '..', 'dist', 'tokens', 'tokens.js')).href;
const { generateTokensCss } = (await import(modUrl)) as { generateTokensCss: () => string };

const out = join(here, '..', 'src', 'tokens', 'tokens.css');
writeFileSync(out, generateTokensCss());
process.stderr.write(`build-tokens: wrote ${out}\n`);
