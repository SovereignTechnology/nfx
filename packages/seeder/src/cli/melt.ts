/**
 * `melt` — one-click melt-out of the seeder wallet to a Lightning invoice (threat T8:
 * small balances at any mint, easy exit). Calls `Wallet.meltQuote` then `Wallet.melt`.
 *
 * Output goes through the redacting logger only. Never prints proofs, tokens, or the
 * preimage (the preimage is proof-of-payment for the *invoice*; the operator gets it from
 * their own node, not from our logs).
 *
 *   melt --mint <url> --invoice <bolt11> [--yes]
 *   melt --balances
 */
import type { MeltQuote, MintUrl, Wallet } from '@sovit/core';

import type { Logger } from '../log/logger.js';

export interface MeltCliDeps {
  readonly wallet: Wallet;
  readonly logger: Logger;
  /** Interactive confirmation; absent = `--yes` required. */
  readonly confirm?: (quote: MeltQuote) => Promise<boolean>;
}

export interface MeltArgs {
  readonly mint?: string;
  readonly invoice?: string;
  readonly yes: boolean;
  readonly balances: boolean;
  readonly help: boolean;
}

export const MELT_USAGE =
  'usage: melt --mint <url> --invoice <bolt11> [--yes] | melt --balances | melt --help';

export function parseMeltArgs(argv: readonly string[]): MeltArgs | { readonly error: string } {
  let mint: string | undefined;
  let invoice: string | undefined;
  let yes = false;
  let balances = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--mint':
        mint = argv[++i];
        if (mint === undefined) return { error: '--mint needs a value' };
        break;
      case '--invoice':
        invoice = argv[++i];
        if (invoice === undefined) return { error: '--invoice needs a value' };
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--balances':
        balances = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      case undefined:
      default:
        return { error: `unknown argument: ${a ?? ''}` };
    }
  }
  return {
    ...(mint !== undefined ? { mint } : {}),
    ...(invoice !== undefined ? { invoice } : {}),
    yes,
    balances,
    help,
  };
}

function normaliseMint(url: string): MintUrl {
  return url.replace(/\/+$/, '') as MintUrl;
}

/** Exit code semantics: 0 paid / listed, 1 usage, 2 refused or not paid, 3 wallet error. */
export async function runMelt(argv: readonly string[], deps: MeltCliDeps): Promise<number> {
  const log = deps.logger.child({ cmd: 'melt' });
  const parsed = parseMeltArgs(argv);
  if ('error' in parsed) {
    log.error(parsed.error);
    log.info(MELT_USAGE);
    return 1;
  }
  if (parsed.help) {
    log.info(MELT_USAGE);
    return 0;
  }
  if (parsed.balances) {
    try {
      const balances = await deps.wallet.balances();
      for (const [mint, balance] of balances) log.info('balance', { mint, sats: balance });
      if (balances.size === 0) log.info('no mints configured');
      return 0;
    } catch (err) {
      log.error('wallet error', { error: err });
      return 3;
    }
  }
  if (parsed.mint === undefined || parsed.invoice === undefined) {
    log.error('--mint and --invoice are required');
    log.info(MELT_USAGE);
    return 1;
  }
  if (!/^ln(bc|tb|bcrt)/i.test(parsed.invoice)) {
    log.error('--invoice does not look like a bolt11 invoice');
    return 1;
  }

  const mint = normaliseMint(parsed.mint);
  try {
    const quote = await deps.wallet.meltQuote(mint, parsed.invoice);
    log.info('melt quote', {
      mint,
      quoteId: quote.quoteId,
      amount: quote.amount,
      feeReserve: quote.feeReserve,
      expiry: quote.expiry,
    });
    let go = parsed.yes;
    if (!go && deps.confirm) go = await deps.confirm(quote);
    if (!go) {
      log.info('melt not confirmed — nothing spent (pass --yes to skip the prompt)');
      return 2;
    }
    const r = await deps.wallet.melt(quote);
    if (!r.paid) {
      log.error('melt not paid', { mint, quoteId: quote.quoteId, change: r.change });
      return 2;
    }
    log.info('melt paid', { mint, quoteId: quote.quoteId, amount: quote.amount, change: r.change });
    return 0;
  } catch (err) {
    log.error('melt failed', { mint, error: err });
    return 3;
  }
}
