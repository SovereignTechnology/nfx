/**
 * `pay/1` codec fuzz harness (execution plan §2 L10; contracts/pay-protocol.ts
 * `PayProtocolCodec`: "Must never throw on arbitrary bytes: return `null`").
 *
 * Two always-on tests pin the protocol constants and self-check the arbitraries. Everything
 * else is real and skipped only while `getCodec()` returns `undefined` — Stage 2 wires the
 * compact-encoding codec in `provider.mts` and this suite runs unchanged.
 *
 * Threat rows served: T11 (a peer feeding garbage must not crash the seeder/gateway —
 * `decode` is the first thing untrusted bytes touch) and INV4 (a PAY that decodes must be a
 * structurally complete message before `verify` sees it).
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import type { PayProtocolCodec, PayProtocolMessage } from '../../contracts/index.js';
import { PAY_PROTOCOL_NAME, PAY_PROTOCOL_VERSION } from '../../contracts/index.js';
import {
  REJECT_REASONS,
  REJECT_REASONS_EXHAUSTIVE,
  ackArb,
  helloArb,
  isPayProtocolMessage,
  messageArb,
  payWireArb,
  plain,
  priceArb,
} from './arbitraries.mjs';
import { SKIP_REASON, getCodec } from './provider.mjs';

const codec: PayProtocolCodec | undefined = getCodec();

/** Never let a throw escape `decode`; report it as a property failure with the input. */
function decodeSafely(c: PayProtocolCodec, buf: Uint8Array): { threw: unknown; out: unknown } {
  try {
    return { threw: undefined, out: c.decode(buf) };
  } catch (e: unknown) {
    return { threw: e ?? new Error('threw undefined'), out: undefined };
  }
}

describe('pay/1 protocol constants', () => {
  it('protocol name and version are the frozen wire identifiers', () => {
    expect(PAY_PROTOCOL_NAME).toBe('pay/1');
    expect(PAY_PROTOCOL_VERSION).toBe(1);
    expect(REJECT_REASONS_EXHAUSTIVE).toBe(true);
    expect(new Set(REJECT_REASONS).size).toBe(REJECT_REASONS.length);
  });

  it('harness self-check: every generated message is a structurally valid PayProtocolMessage', () => {
    fc.assert(
      fc.property(messageArb, (m) => {
        expect(isPayProtocolMessage(m)).toBe(true);
        expect(['HELLO', 'PAY', 'ACK', 'PRICE']).toContain(m.type);
      }),
      { numRuns: 300 },
    );
    // And the validator is not vacuous.
    for (const junk of [
      null,
      1,
      'PAY',
      {},
      { type: 'PAY' },
      { type: 'NOPE' },
      { type: 'ACK', ok: 1 },
    ]) {
      expect(isPayProtocolMessage(junk)).toBe(false);
    }
  });
});

describe.skipIf(codec === undefined)(`PayProtocolCodec fuzz (${SKIP_REASON})`, () => {
  const c = (): PayProtocolCodec => codec!;

  it('decode(arbitrary bytes) never throws and returns null or a structurally valid message', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const { threw, out } = decodeSafely(c(), bytes);
        expect(threw).toBeUndefined();
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('decode of the empty buffer and of small fixed patterns is null, not a throw', () => {
    const patterns = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0xff]),
      new Uint8Array(16).fill(0),
      new Uint8Array(16).fill(0xff),
      new Uint8Array([0xfd, 0xff, 0xff]), // compact-encoding uint16 prefix with nothing after
      new Uint8Array([0xfe, 0xff, 0xff, 0xff, 0xff]),
      new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      new TextEncoder().encode('{"type":"PAY"}'),
      new TextEncoder().encode(PAY_PROTOCOL_NAME),
    ];
    for (const p of patterns) {
      const { threw, out } = decodeSafely(c(), p);
      expect(threw, `pattern ${Array.from(p).join(',')}`).toBeUndefined();
      expect(out === null || isPayProtocolMessage(out)).toBe(true);
    }
    expect(decodeSafely(c(), new Uint8Array(0)).out).toBeNull();
  });

  it('decode(encode(msg)) round-trips every valid PayProtocolMessage exactly', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const bytes = c().encode(msg);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes.length).toBeGreaterThan(0);
        const back = c().decode(bytes);
        // `toStrictEqual`: optional fields that were absent must come back absent, not
        // `undefined` (contracts are compiled with `exactOptionalPropertyTypes`).
        expect(back).toStrictEqual(msg);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trip per message type (so a regression names the message, not just "oneof")', () => {
    for (const [name, arb] of [
      ['HELLO', helloArb],
      ['PAY', payWireArb],
      ['ACK', ackArb],
      ['PRICE', priceArb],
    ] as const) {
      fc.assert(
        fc.property(arb as fc.Arbitrary<PayProtocolMessage>, (msg) => {
          const back = c().decode(c().encode(msg));
          expect(back, name).toStrictEqual(msg);
          expect(back?.type).toBe(name);
        }),
        { numRuns: 150 },
      );
    }
  });

  it('encode is deterministic: the same message always yields the same bytes', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        expect(c().encode(msg)).toEqual(c().encode(structuredClone(msg)));
      }),
      { numRuns: 200 },
    );
  });

  it('encode never throws on any valid message, and its output is a fresh Uint8Array', () => {
    fc.assert(
      fc.property(messageArb, (msg) => {
        const a = c().encode(msg);
        const b = c().encode(msg);
        expect(a).not.toBe(b); // not a shared scratch buffer the caller could mutate
        a.fill(0);
        expect(c().decode(b)).toStrictEqual(msg); // b unaffected by mutating a
      }),
      { numRuns: 100 },
    );
  });

  it('every truncation of a valid encoding is rejected without throwing', () => {
    fc.assert(
      fc.property(messageArb, fc.double({ min: 0, max: 1, noNaN: true }), (msg, frac) => {
        const full = c().encode(msg);
        const cut = Math.floor(full.length * frac);
        fc.pre(cut < full.length);
        const { threw, out } = decodeSafely(c(), full.subarray(0, cut));
        expect(threw).toBeUndefined();
        // A strict prefix of an encoding cannot be the same message; the codec may either
        // reject it or (if the prefix happens to decode) return something structurally valid.
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
        if (out !== null) expect(out).not.toStrictEqual(msg);
      }),
      { numRuns: 300 },
    );
  });

  it('trailing garbage after a valid encoding never throws', () => {
    fc.assert(
      fc.property(messageArb, fc.uint8Array({ minLength: 1, maxLength: 64 }), (msg, tail) => {
        const full = c().encode(msg);
        const buf = new Uint8Array(full.length + tail.length);
        buf.set(full, 0);
        buf.set(tail, full.length);
        const { threw, out } = decodeSafely(c(), buf);
        expect(threw).toBeUndefined();
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('random byte flips / insertions / deletions in a valid encoding never throw and never yield a malformed message', () => {
    const mutation = fc.oneof(
      fc.record({
        kind: fc.constant<'flip'>('flip'),
        at: fc.nat(),
        bits: fc.integer({ min: 1, max: 255 }),
      }),
      fc.record({ kind: fc.constant<'insert'>('insert'), at: fc.nat(), byte: fc.nat(255) }),
      fc.record({ kind: fc.constant<'delete'>('delete'), at: fc.nat() }),
      fc.record({ kind: fc.constant<'set'>('set'), at: fc.nat(), byte: fc.nat(255) }),
    );
    fc.assert(
      fc.property(messageArb, fc.array(mutation, { minLength: 1, maxLength: 8 }), (msg, muts) => {
        let buf = c().encode(msg);
        for (const m of muts) {
          if (buf.length === 0) break;
          const at = m.at % (m.kind === 'insert' ? buf.length + 1 : buf.length);
          switch (m.kind) {
            case 'flip':
              buf[at] = buf[at]! ^ m.bits;
              break;
            case 'set':
              buf[at] = m.byte;
              break;
            case 'insert': {
              const next = new Uint8Array(buf.length + 1);
              next.set(buf.subarray(0, at), 0);
              next[at] = m.byte;
              next.set(buf.subarray(at), at + 1);
              buf = next;
              break;
            }
            case 'delete': {
              const next = new Uint8Array(buf.length - 1);
              next.set(buf.subarray(0, at), 0);
              next.set(buf.subarray(at + 1), at);
              buf = next;
              break;
            }
          }
        }
        const { threw, out } = decodeSafely(c(), buf);
        expect(threw).toBeUndefined();
        expect(out === null || isPayProtocolMessage(out)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('large but valid payloads (many proofs, long secrets) round-trip', () => {
    const bigPay = fc.record({
      type: fc.constant<'PAY'>('PAY'),
      payload: fc.record({
        range: fc.constant({ fromBlock: 0, toBlock: 63 }),
        seederProofs: fc.record({
          mint: fc.constant('https://mint.example'),
          unit: fc.constant<'sat'>('sat'),
          lockedTo: fc.constant('02' + '11'.repeat(32)),
          proofs: fc.array(
            fc.record({
              id: fc.constant('0011223344556677'),
              amount: fc.integer({ min: 1, max: 2 ** 31 }),
              secret: fc.string({ minLength: 200, maxLength: 2000 }),
              C: fc.constant('02' + '22'.repeat(32)),
              dleq: fc.constant({ s: '33'.repeat(32), e: '44'.repeat(32) }),
            }),
            { minLength: 32, maxLength: 128 },
          ),
        }),
        creatorProofs: fc.record({
          mint: fc.constant('https://mint.example'),
          unit: fc.constant<'sat'>('sat'),
          lockedTo: fc.constant('02' + '55'.repeat(32)),
          proofs: fc.constant([]),
        }),
      }),
    });
    fc.assert(
      fc.property(bigPay, (msg) => {
        const m = plain(msg as unknown as PayProtocolMessage);
        expect(c().decode(c().encode(m))).toStrictEqual(m);
      }),
      { numRuns: 20 },
    );
  });
});
