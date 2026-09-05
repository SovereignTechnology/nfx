import { describe, expect, it } from 'vitest';

import { createLogger } from '../log/logger.js';
import { capturedLogger } from './helpers.js';

const PROOF = { id: 'k', amount: 1, secret: 'mock:9', C: 'cc' };

describe('Logger', () => {
  it('emits JSON lines with redacted message and fields', () => {
    const { logger, lines, records } = capturedLogger();
    logger.info('peer nsec1qqqqqqqqqq paid', { proofs: [PROOF], peer: 'ab'.repeat(32), n: 3 });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as {
      level: string;
      msg: string;
      fields: Record<string, unknown>;
    };
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('peer [REDACTED:nsec] paid');
    expect(rec.fields['proofs']).toBe('[REDACTED:1 proofs]');
    expect(rec.fields['peer']).toBe('ab'.repeat(32));
    expect(rec.fields['n']).toBe(3);
    expect(lines[0]).not.toContain('mock:9');
    expect(records[0]?.fields['proofs']).toBe('[REDACTED:1 proofs]');
  });

  it('filters below the configured level', () => {
    const { logger, lines } = capturedLogger('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['c', 'd']);
  });

  it('child loggers carry redacted bindings', () => {
    const { logger, lines } = capturedLogger();
    const child = logger
      .child({ component: 'x', secret: 'shh' })
      .child({ noiseKey: 'cd'.repeat(32) });
    child.info('hi');
    const rec = JSON.parse(lines[0]!) as { fields: Record<string, unknown> };
    expect(rec.fields).toMatchObject({
      component: 'x',
      secret: '[REDACTED]',
      noiseKey: 'cd'.repeat(32),
    });
  });

  it('survives a throwing sink and unserialisable fields', () => {
    const logger = createLogger({
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => {
      logger.error('x', { big: 1n });
    }).not.toThrow();
  });

  it('uses the injected clock', () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (l) => {
        lines.push(l);
      },
      now: () => new Date(0),
    });
    logger.info('t');
    expect((JSON.parse(lines[0]!) as { ts: string }).ts).toBe('1970-01-01T00:00:00.000Z');
  });
});
