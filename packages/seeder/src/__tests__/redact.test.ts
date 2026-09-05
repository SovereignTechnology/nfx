import { describe, expect, it } from 'vitest';

import { REDACTED, redact, redactString } from '../log/redact.js';

const HEX64 = 'ab'.repeat(32);
const PROOF = { id: 'k1', amount: 8, secret: 'mock:1:deadbeef', C: '02' + 'cc'.repeat(32) };

describe('redactString', () => {
  it('scrubs cashu tokens', () => {
    const s = `got cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vbWludC5leGFtcGxlIn1dfQ== and cashuBo2F0gaJhaUgA_9SLj17PgGFwgaNhYQhhc3ggNDU thanks`;
    const out = redactString(s);
    expect(out).not.toMatch(/cashu[AB][A-Za-z0-9]/);
    expect(out).toContain('[REDACTED:cashu-token]');
  });

  it('scrubs nsec keys', () => {
    const out = redactString(
      'key nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
    );
    expect(out).toBe('key [REDACTED:nsec]');
  });

  it('truncates 64-hex to 8 chars in free text (a 32-byte secret never leaves whole)', () => {
    const out = redactString(`sk=${HEX64} done`);
    expect(out).toBe('sk=abababab… done');
    expect(out).not.toContain(HEX64);
  });

  it('truncates longer hex (e.g. 128-hex signatures / secret material)', () => {
    const out = redactString('cd'.repeat(64));
    expect(out).toBe('cdcdcdcd…[REDACTED:128hex]');
  });

  it('leaves short hex and ordinary text alone', () => {
    expect(redactString('block 42 abcdef1234 ok')).toBe('block 42 abcdef1234 ok');
  });
});

describe('redact (structured)', () => {
  it('replaces secret-named fields regardless of case / separators', () => {
    const out = redact({
      secret: 'x',
      Secret: 'y',
      private_key: 'z',
      privateKey: 'w',
      nsec: 'n',
      dleq: { s: '1', e: '2' },
      witness: 'w',
      C: 'c',
      token: 't',
      preimage: 'p',
      fine: 'kept',
    }) as Record<string, unknown>;
    for (const k of [
      'secret',
      'Secret',
      'private_key',
      'privateKey',
      'nsec',
      'dleq',
      'witness',
      'C',
      'token',
      'preimage',
    ])
      expect(out[k]).toBe(REDACTED);
    expect(out['fine']).toBe('kept');
  });

  it('replaces anything shaped like a proof, at any depth', () => {
    const out = redact({ a: { b: [PROOF, { x: PROOF }] } }) as { a: { b: unknown[] } };
    expect(out.a.b[0]).toBe('[REDACTED:proof]');
    expect((out.a.b[1] as { x: unknown }).x).toBe('[REDACTED:proof]');
    expect(JSON.stringify(out)).not.toContain('mock:1');
  });

  it('keeps proof-set metadata but never the proofs', () => {
    const set = {
      mint: 'https://mint.example',
      unit: 'sat',
      lockedTo: '02' + 'ab'.repeat(32),
      proofs: [PROOF, PROOF],
    };
    const out = redact(set) as Record<string, unknown>;
    expect(out['mint']).toBe('https://mint.example');
    expect(out['unit']).toBe('sat');
    expect(out['proofs']).toBe('[REDACTED:2 proofs]');
    expect(JSON.stringify(out)).not.toContain('mock:1');
    expect(JSON.stringify(out)).not.toContain('cc'.repeat(32));
  });

  it('redacts a whole PayMessage (range survives, both sets scrubbed)', () => {
    const msg = {
      range: { fromBlock: 0, toBlock: 3 },
      seederProofs: { mint: 'm', unit: 'sat', lockedTo: 'l', proofs: [PROOF] },
      creatorProofs: { mint: 'm', unit: 'sat', lockedTo: 'l', proofs: [PROOF] },
    };
    const s = JSON.stringify(redact(msg));
    expect(s).toContain('"fromBlock":0');
    expect(s).not.toContain('secret');
    expect(s).not.toContain('mock:');
  });

  it('keeps full 64-hex in public-identifier fields but truncates elsewhere', () => {
    const out = redact({ pubkey: HEX64, peer: HEX64, noiseKey: HEX64, note: HEX64 }) as Record<
      string,
      string
    >;
    expect(out['pubkey']).toBe(HEX64);
    expect(out['peer']).toBe(HEX64);
    expect(out['noiseKey']).toBe(HEX64);
    expect(out['note']).toBe('abababab…');
  });

  it('handles errors, bytes, maps, sets, bigint, cycles-by-depth and never throws', () => {
    const err = new Error(`bad nsec1qqqqqqqqqqqqqqqq ${HEX64}`);
    const out = redact({
      err,
      bytes: new Uint8Array(5),
      m: new Map([['secret', 'v']]),
      s: new Set(['cashuAabcdefgh']),
      big: 10n,
      fn: () => 1,
    }) as Record<string, unknown>;
    expect((out['err'] as { message: string }).message).toBe('bad [REDACTED:nsec] abababab…');
    expect(out['bytes']).toBe('[bytes:5]');
    expect((out['m'] as Record<string, unknown>)['secret']).toBe(REDACTED);
    expect((out['s'] as string[])[0]).toBe('[REDACTED:cashu-token]');
    expect(out['big']).toBe('10');
    expect(out['fn']).toBe('[function]');

    interface Cyc {
      self?: Cyc;
      n: number;
    }
    const cyc: Cyc = { n: 1 };
    cyc.self = cyc;
    expect(() => redact(cyc)).not.toThrow();
    expect(JSON.stringify(redact(cyc))).toContain('[REDACTED:depth]');
  });

  it('redacts a NUT-00 token object shape', () => {
    const tok = { token: [{ mint: 'm', proofs: [PROOF] }], unit: 'sat', memo: 'hi' };
    const out = redact(tok) as Record<string, unknown>;
    expect(out['token']).toBe('[REDACTED:? proofs]');
    expect(out['memo']).toBe('hi');
  });
});
