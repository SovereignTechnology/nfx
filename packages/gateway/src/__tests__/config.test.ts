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
    expect(r.config.markupSatsPerBlock).toBe(0);
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
      markupSatsPerBlock: 1.5,
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
      '$.markupSatsPerBlock',
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

  it('gatewayPrice / gatewayPolicy = base + markup (Q4 parametrised, default 0)', () => {
    const base = validateConfig(MINIMAL);
    const marked = validateConfig({ ...MINIMAL, markupSatsPerBlock: 2 });
    if (!base.ok || !marked.ok) throw new Error('config');
    expect(gatewayPrice(base.config)).toBe(3);
    expect(gatewayPrice(marked.config)).toBe(5);
    expect(gatewayPolicy(marked.config)).toEqual({ ...marked.config.policy, satsPerBlock: 5 });
  });
});
