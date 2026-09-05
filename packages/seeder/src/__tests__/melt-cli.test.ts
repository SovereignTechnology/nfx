import { mocks } from '@sovit/core';
import type { MeltQuote, Wallet } from '@sovit/core';
import { describe, expect, it } from 'vitest';

import { MELT_USAGE, parseMeltArgs, runMelt } from '../cli/melt.js';
import { capturedLogger } from './helpers.js';

const MINT = mocks.MINTS.a;
const INVOICE = 'lnbc500n1mockinvoice';

describe('melt CLI', () => {
  it('parses arguments', () => {
    expect(parseMeltArgs(['--mint', 'm', '--invoice', 'i', '--yes'])).toEqual({
      mint: 'm',
      invoice: 'i',
      yes: true,
      balances: false,
      help: false,
    });
    expect(parseMeltArgs(['--balances'])).toMatchObject({ balances: true });
    expect(parseMeltArgs(['--mint'])).toEqual({ error: '--mint needs a value' });
    expect(parseMeltArgs(['--wat'])).toEqual({ error: 'unknown argument: --wat' });
  });

  it('melts through Wallet.meltQuote + Wallet.melt and prints amounts, never proofs or the preimage', async () => {
    const wallet = new mocks.MockWallet({ balances: { [MINT]: 2000 } });
    const { logger, lines, records } = capturedLogger();
    const code = await runMelt(['--mint', `${MINT}/`, '--invoice', INVOICE, '--yes'], {
      wallet,
      logger,
    });
    expect(code).toBe(0);
    expect(await wallet.balance(MINT)).toBe(1500);
    const paid = records.find((r) => r.msg === 'melt paid');
    expect(paid?.fields).toMatchObject({ mint: MINT, amount: 500 });
    const all = lines.join('\n');
    expect(all).not.toContain('00'.repeat(32)); // the preimage
    expect(all).not.toContain('mock:');
    expect(all).not.toMatch(/"secret"|proofs|cashuA/);
  });

  it('returns 2 when not confirmed and spends nothing', async () => {
    const wallet = new mocks.MockWallet({ balances: { [MINT]: 2000 } });
    const { logger } = capturedLogger();
    let seen: MeltQuote | null = null;
    const code = await runMelt(['--mint', MINT, '--invoice', INVOICE], {
      wallet,
      logger,
      confirm: (q) => {
        seen = q;
        return Promise.resolve(false);
      },
    });
    expect(code).toBe(2);
    expect(seen).not.toBeNull();
    expect(await wallet.balance(MINT)).toBe(2000);
    // no confirm hook and no --yes: also refused
    expect(await runMelt(['--mint', MINT, '--invoice', INVOICE], { wallet, logger })).toBe(2);
  });

  it('returns 2 on an unpaid melt and 3 on a wallet error', async () => {
    const poor = new mocks.MockWallet({ balances: { [MINT]: 10 } });
    const { logger, records } = capturedLogger();
    expect(
      await runMelt(['--mint', MINT, '--invoice', INVOICE, '-y'], { wallet: poor, logger }),
    ).toBe(2);
    expect(records.some((r) => r.msg === 'melt not paid')).toBe(true);

    const broken: Wallet = Object.assign(Object.create(poor) as Wallet, {
      meltQuote: () => Promise.reject(new Error('mint offline nsec1qqqqqqqqqq')),
    });
    expect(
      await runMelt(['--mint', MINT, '--invoice', INVOICE, '-y'], { wallet: broken, logger }),
    ).toBe(3);
    const err = records.find((r) => r.msg === 'melt failed');
    expect(JSON.stringify(err)).toContain('[REDACTED:nsec]');
  });

  it('usage errors and --balances / --help', async () => {
    const wallet = new mocks.MockWallet({ balances: { [MINT]: 42 } });
    const { logger, records } = capturedLogger();
    expect(await runMelt(['--mint', MINT], { wallet, logger })).toBe(1);
    expect(await runMelt(['--mint', MINT, '--invoice', 'nope', '-y'], { wallet, logger })).toBe(1);
    expect(await runMelt(['--help'], { wallet, logger })).toBe(0);
    expect(records.some((r) => r.msg === MELT_USAGE)).toBe(true);
    expect(await runMelt(['--balances'], { wallet, logger })).toBe(0);
    expect(records.find((r) => r.msg === 'balance')?.fields).toMatchObject({
      mint: MINT,
      sats: 42,
    });
  });
});
