/**
 * `packages/seeder/systemd/nutflix-seeder.service` is the reference unit for operators. It
 * must be byte-identical to what `renderSystemdUnit()` produces for the reference layout,
 * so the two cannot drift.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { renderSystemdUnit } from '../host/systemd.js';

export const REFERENCE_UNIT = renderSystemdUnit({
  user: 'nutflix-seeder',
  // The entry is supplied by the shell that owns the PaymentEngine (Stage 2 / L6); it calls
  // `runDaemon()` from `@sovit/seeder`. See docs/lanes/L2.md.
  execStart: '/usr/bin/node /opt/nutflix/seeder-entry.js',
  dataDir: '/var/lib/nutflix-seeder',
  workingDirectory: '/opt/nutflix',
  environment: { NODE_ENV: 'production', NUTFLIX_SEEDER_DISK_CAP_BYTES: '53687091200' },
});

describe('systemd/nutflix-seeder.service', () => {
  it('matches renderSystemdUnit() for the reference layout', async () => {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../systemd/nutflix-seeder.service',
    );
    expect(await readFile(file, 'utf8')).toBe(REFERENCE_UNIT);
  });
});
