import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BLOSSOM,
  DEFAULT_HTTP_LIMITS,
  DEFAULT_WS_LIMITS,
  ENV,
  applyEnvOverrides,
  gatewayPolicy,
  gatewayPrice,
  parseConfigText,
  validateConfig,
} from '../config.js';
import { CREATOR_P2PK, GW_P2PK, GW_PUBKEY, MINT_A } from './helpers.js';

const MINIMAL = {
  dataDir: '/var/lib/nutflix-gateway',
  identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
  policy: { satsPerBlock: 3, mints: [MINT_A], creatorP2pk: CREATOR_P2PK },
};

describe('validateConfig', () => {
  it('accepts a minimal document and fills safe defaults', () => {
    const r = validateConfig(MINIMAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.listen).toEqual({ host: '127.0.0.1', port: 8080 });
    expect(r.config.markupPercent).toBe(0);
    expect(r.config.acceptedMints).toEqual([MINT_A]);
    expect(r.config.swarm).toBeNull();
    expect(r.config.http).toEqual(DEFAULT_HTTP_LIMITS);
    expect(r.config.ws).toEqual(DEFAULT_WS_LIMITS);
    expect(r.config.blossom).toEqual(DEFAULT_BLOSSOM);
    expect(r.config.blossom.allowMirror).toBe(false);
    expect(r.config.policy.split).toEqual({ seeder: 50, creator: 50 });
    expect(r.config.policy.blockSize).toBe(65_536);
    expect(r.config.logLevel).toBe('info');
    expect(r.config.upstream.payEveryBlocks).toBe(2);
  });

  it('rejects a non-object, and JSON that is not JSON', () => {
    expect(validateConfig(null)).toEqual({ ok: false, errors: ['$: expected a JSON object'] });
    expect(validateConfig([])).toEqual({ ok: false, errors: ['$: expected a JSON object'] });
    expect(parseConfigText('{not json')).toEqual({
      ok: false,
      errors: ['$: config file is not valid JSON'],
    });
  });

  it('reports every problem by PATH and never echoes the offending value', () => {
    const secretish = 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    const r = validateConfig({
      ...MINIMAL,
      listen: { host: '', port: 70_000 },
      identity: { pubkey: secretish, p2pk: 'zz' },
      policy: {
        satsPerBlock: -1,
        mints: ['ftp://x'],
        split: { seeder: 60, creator: 60 },
        creatorP2pk: 'nope',
      },
      markupPercent: 1.5,
      http: { maxUploadBytes: 0, trustProxy: 'yes' },
      ws: { path: 'ws' },
      blossom: { publicUrl: 'http://x/', allowPubkeys: ['short'] },
      logLevel: 'verbose',
      upstream: { policies: { notahexkey: {} } },
      bogus: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.join('\n');
    expect(text).not.toContain(secretish);
    expect(text).not.toContain('70000');
    expect(text).not.toContain('verbose');
    for (const p of [
      '$.listen.host',
      '$.listen.port',
      '$.identity.pubkey',
      '$.identity.p2pk',
      '$.policy.satsPerBlock',
      '$.policy.mints',
      '$.policy.split',
      '$.policy.creatorP2pk',
      '$.markupPercent',
      '$.http.maxUploadBytes',
      '$.http.trustProxy',
      '$.ws.path',
      '$.blossom.publicUrl',
      '$.blossom.allowPubkeys',
      '$.logLevel',
      '$.upstream.policies',
      '$.bogus',
    ])
      expect(text, p).toContain(p);
  });

  it('requires dataDir unless STATE_DIRECTORY / env supplies it', () => {
    const { dataDir: _d, ...noDir } = MINIMAL;
    const bare = validateConfig(noDir);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.errors.some((e) => e.startsWith('$.dataDir'))).toBe(true);
    const viaState = validateConfig(
      applyEnvOverrides(noDir, (n) =>
        n === ENV.stateDirectory ? '/var/lib/nutflix-gateway' : undefined,
      ),
    );
    expect(viaState.ok && viaState.config.dataDir).toBe('/var/lib/nutflix-gateway');
  });

  it('env overrides beat the file; STATE_DIRECTORY only fills a missing dataDir', () => {
    const env = (n: string): string | undefined =>
      ({
        [ENV.listenHost]: '0.0.0.0',
        [ENV.listenPort]: '9999',
        [ENV.dataDir]: '/data',
        [ENV.diskCapBytes]: '1024',
        [ENV.logLevel]: 'debug',
        [ENV.publicUrl]: 'https://cdn.example',
        [ENV.stateDirectory]: '/state',
      })[n];
    const r = parseConfigText(JSON.stringify({ ...MINIMAL, listen: { port: 1 } }), env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.listen).toEqual({ host: '0.0.0.0', port: 9999 });
    expect(r.config.dataDir).toBe('/data');
    expect(r.config.diskCapBytes).toBe(1024);
    expect(r.config.logLevel).toBe('debug');
    expect(r.config.blossom.publicUrl).toBe('https://cdn.example');
    // A non-numeric port from the environment is a validation error, not a NaN listener.
    const bad = parseConfigText(JSON.stringify(MINIMAL), (n) =>
      n === ENV.listenPort ? 'eighty' : undefined,
    );
    expect(bad.ok).toBe(false);
  });

  it('parses the swarm block (gateway defaults to server+client) and per-core upstream policies', () => {
    const core = 'ab'.repeat(32);
    const r = validateConfig({
      ...MINIMAL,
      swarm: { bootstrap: [{ host: '127.0.0.1', port: 49737 }], maxPeers: 8 },
      upstream: {
        payEveryBlocks: 3,
        policies: { [core]: { satsPerBlock: 1, mints: [MINT_A], creatorP2pk: CREATOR_P2PK } },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.swarm).toEqual({
      bootstrap: [{ host: '127.0.0.1', port: 49737 }],
      maxPeers: 8,
      server: true,
      client: true,
    });
    expect(r.config.upstream.payEveryBlocks).toBe(3);
    expect(r.config.upstream.policies[core]?.creatorP2pk).toBe(CREATOR_P2PK);
  });

  it('gatewayPrice / gatewayPolicy: markupPercent default 0 leaves the base price unchanged', () => {
    const base = validateConfig(MINIMAL);
    if (!base.ok) throw new Error('config');
    expect(base.config.markupPercent).toBe(0);
    expect(gatewayPrice(base.config)).toBe(3);
    expect(gatewayPolicy(base.config)).toEqual(base.config.policy);
  });

  it('gatewayPrice = ceil(satsPerBlock × (100 + markupPercent) / 100) (ADR 0005 Q4)', () => {
    const price = (satsPerBlock: number, markupPercent: number): number => {
      const r = validateConfig({
        ...MINIMAL,
        policy: { ...MINIMAL.policy, satsPerBlock },
        markupPercent,
      });
      if (!r.ok) throw new Error(r.errors.join('\n'));
      return gatewayPrice(r.config);
    };
    expect(price(1, 50)).toBe(2); // ceil(1.5)
    expect(price(3, 10)).toBe(4); // ceil(3.3)
    expect(price(5, 100)).toBe(10); // exact
    expect(price(3, 0)).toBe(3);
    expect(price(0, 250)).toBe(0);
    expect(price(7, 33)).toBe(10); // ceil(9.31): never rounds down
    expect(Number.isInteger(price(3, 1))).toBe(true);
  });

  it('gatewayPolicy carries the marked-up price; everything else is the base policy', () => {
    const r = validateConfig({ ...MINIMAL, markupPercent: 50 });
    if (!r.ok) throw new Error('config');
    expect(gatewayPolicy(r.config)).toEqual({ ...r.config.policy, satsPerBlock: 5 });
    expect(r.config.policy.satsPerBlock).toBe(3);
  });

  it('gatewayPrice refuses a product outside the safe-integer range', () => {
    const r = validateConfig(MINIMAL);
    if (!r.ok) throw new Error('config');
    const huge = {
      policy: { ...r.config.policy, satsPerBlock: Number.MAX_SAFE_INTEGER as never },
      markupPercent: 1,
    };
    expect(() => gatewayPrice(huge)).toThrow(RangeError);
  });

  it('rejects a negative or non-integer markupPercent by path only', () => {
    for (const bad of [-1, 1.5, '10', null, Number.NaN]) {
      const r = validateConfig({ ...MINIMAL, markupPercent: bad });
      expect(r.ok, String(bad)).toBe(false);
      if (r.ok) continue;
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toMatch(/^\$\.markupPercent: expected integer/);
      expect(r.errors[0]).not.toContain('1.5');
      expect(r.errors[0]).not.toContain('-1');
    }
    // Any integer ≥ 0 is accepted (percentages above 100 are legal: price × 2+).
    expect(validateConfig({ ...MINIMAL, markupPercent: 0 }).ok).toBe(true);
    expect(validateConfig({ ...MINIMAL, markupPercent: 400 }).ok).toBe(true);
  });

  it('rejects a config still carrying the removed markupSatsPerBlock (never silently ignored)', () => {
    const r = validateConfig({ ...MINIMAL, markupSatsPerBlock: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^\$\.markupSatsPerBlock: removed key/);
    expect(r.errors[0]).toContain('markupPercent');
    // Even a value the old schema would have accepted, alongside the new key, is refused.
    const both = validateConfig({ ...MINIMAL, markupSatsPerBlock: 2, markupPercent: 10 });
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.errors).toEqual([expect.stringMatching(/^\$\.markupSatsPerBlock: /)]);
      expect(both.errors.join('\n')).not.toContain(' 2');
    }
  });
});
