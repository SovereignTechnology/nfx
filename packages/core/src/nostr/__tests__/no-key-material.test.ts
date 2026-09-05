/**
 * Static guard for the lane rules: the data layer never handles a secret key, never
 * signs or encrypts itself, and never implements a hash/curve. Only the `Signer`
 * contract and `nostr-tools`' verification/parsing helpers are allowed in production
 * source; key-generating/signing helpers may appear in test files only.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const roots = [join(here, '..'), join(here, '..', '..', 'manifest')];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__') out.push(...sources(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const FORBIDDEN: readonly RegExp[] = [
  /generateSecretKey/,
  /finalizeEvent/,
  /(?<![.\w])getPublicKey\s*\(/, // nostr-tools' sk → pk; the Signer's method is always `signer.getPublicKey()`
  /nostr-tools\/nip44/,
  /nostr-tools\/nip04/,
  /nostr-tools\/nip49/,
  /nostr-tools\/nip06/,
  /@noble\//,
  /@scure\//,
  /\bnsec\b/,
  /secretKey|privateKey|privkey/i,
  /\bsha256\s*\(/,
  /\bschnorr\b/,
  /createHash|crypto\.subtle|webcrypto/,
];

describe('no key material, signing, or hand-rolled crypto in nostr/ and manifest/', () => {
  const files = roots.flatMap(sources);
  it('scans a non-trivial set of files', () => {
    expect(files.length).toBeGreaterThan(15);
  });
  it.each(files.map((f) => [f.slice(f.indexOf('packages/'))] as const))('%s', (rel) => {
    const src = readFileSync(join(here, '..', '..', '..', '..', '..', rel), 'utf8');
    for (const re of FORBIDDEN) {
      const m = re.exec(src);
      expect(m, `${rel} matches forbidden pattern ${re.source}`).toBeNull();
    }
  });
  it('the only signature helper used in production source is verifyEvent (plus validateEvent)', () => {
    const uses = files.filter((f) => readFileSync(f, 'utf8').includes("from 'nostr-tools/pure'"));
    expect(uses.map((f) => f.slice(f.lastIndexOf('/') + 1))).toEqual(['event.ts']);
  });
});
