/**
 * "Withdraw" sheet (NUT-05 melt-out, SECURITY.md T8 "one-click melt-out"): pick a mint that
 * holds sats, paste a Lightning invoice (shape-checked loosely — never decoded here) →
 * `wallet.meltQuote` → the amount, the fee reserve and the most it can cost are shown FIRST →
 * an explicit confirm → `wallet.melt(quote)` with exactly the quote that was shown → result.
 *
 * Price shown = price charged: the confirm button is disabled unless the displayed quote is
 * current (not expired) and the mint holds amount + fee reserve; `melt` receives the same
 * quote object that rendered the figures.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { MeltQuote, MintUrl, Sats, Wallet } from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  MintChip,
  SatsBadge,
  Sheet,
  SkeletonLines,
  cx,
  formatSats,
  mintHost,
  type MintStatus,
} from '../../components/index.js';
import { useAlive, useNow } from './hooks.js';
import {
  describeWalletError,
  formatCountdown,
  isLikelyBolt11,
  normalizeInvoice,
  shortInvoice,
} from './invoice.js';

export interface WithdrawSheetProps {
  readonly wallet: Wallet;
  readonly mints: readonly MintUrl[];
  readonly balances: ReadonlyMap<MintUrl, Sats>;
  readonly mintStatus: Readonly<Record<string, MintStatus>>;
  readonly initialMint?: MintUrl | undefined;
  readonly initialInvoice?: string | undefined;
  /** Fetch the quote at once (a deep link carrying an invoice). Never pays by itself. */
  readonly autoReview?: boolean | undefined;
  /** Unix seconds; must be referentially stable. */
  readonly clock: () => number;
  readonly onClose: () => void;
  /** After a melt that paid (or may have): the screen refreshes balances + history. */
  readonly onSettled: (mint: MintUrl, paid: boolean, amount: number) => void;
  readonly onMintStatus: (mint: MintUrl, status: MintStatus) => void;
  readonly onAddFunds: () => void;
}

type Step =
  | { readonly step: 'form' }
  | { readonly step: 'quoting'; readonly mint: MintUrl; readonly invoice: string }
  | { readonly step: 'confirm'; readonly quote: MeltQuote; readonly invoice: string }
  | { readonly step: 'paying'; readonly quote: MeltQuote; readonly invoice: string }
  | { readonly step: 'sent'; readonly quote: MeltQuote; readonly change: number }
  | { readonly step: 'not-paid'; readonly quote: MeltQuote; readonly invoice: string }
  | {
      readonly step: 'melt-error';
      readonly quote: MeltQuote;
      readonly invoice: string;
      readonly error: unknown;
    }
  | {
      readonly step: 'quote-error';
      readonly mint: MintUrl;
      readonly invoice: string;
      readonly error: unknown;
    };

/** Why a pasted string was refused, in words (or `undefined` when it looks like bolt11). */
export function invoiceProblem(input: string): string | undefined {
  const s = input.trim();
  if (s === '') return 'Paste a Lightning invoice to withdraw to.';
  if (s.includes('@') || /^(lightning:)?lnurl/i.test(s))
    return 'Lightning addresses and LNURL are not supported here — paste an invoice (it starts with lnbc).';
  if (!isLikelyBolt11(s))
    return 'That does not look like a Lightning invoice. It should start with lnbc (lntb or lnbcrt on test networks).';
  return undefined;
}

function pickMint(
  funded: readonly MintUrl[],
  balances: ReadonlyMap<MintUrl, Sats>,
  preferred: MintUrl | undefined,
): MintUrl | undefined {
  if (preferred !== undefined && funded.includes(preferred)) return preferred;
  let best: MintUrl | undefined;
  let bestBalance = 0;
  for (const m of funded) {
    const b = balances.get(m) ?? 0;
    if (b > bestBalance) {
      best = m;
      bestBalance = b;
    }
  }
  return best;
}

export function WithdrawSheet({
  wallet,
  mints,
  balances,
  mintStatus,
  initialMint,
  initialInvoice,
  autoReview = false,
  clock,
  onClose,
  onSettled,
  onMintStatus,
  onAddFunds,
}: WithdrawSheetProps): ReactElement {
  const id = useId();
  const alive = useAlive();
  const funded = mints.filter((m) => (balances.get(m) ?? 0) > 0);
  const [mint, setMint] = useState<MintUrl | undefined>(() =>
    pickMint(funded, balances, initialMint),
  );
  const [invoiceText, setInvoiceText] = useState(initialInvoice ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState<Step>({ step: 'form' });
  const cb = useRef({ onSettled, onMintStatus });
  cb.current = { onSettled, onMintStatus };

  const problem = invoiceProblem(invoiceText);
  const showProblem = submitted && problem !== undefined;

  const review = useCallback(
    (m: MintUrl, raw: string): void => {
      const invoice = normalizeInvoice(raw);
      setStep({ step: 'quoting', mint: m, invoice });
      wallet.meltQuote(m, invoice).then(
        (quote) => {
          if (!alive.current) return;
          cb.current.onMintStatus(m, 'ok');
          setStep({ step: 'confirm', quote, invoice });
        },
        (error: unknown) => {
          if (!alive.current) return;
          if (describeWalletError(error).title === 'Mint unreachable')
            cb.current.onMintStatus(m, 'unreachable');
          setStep({ step: 'quote-error', mint: m, invoice, error });
        },
      );
    },
    [alive, wallet],
  );

  // A deep link carrying an invoice goes straight to the quote — and stops there.
  const autoDone = useRef(false);
  useEffect(() => {
    if (autoDone.current || !autoReview) return;
    autoDone.current = true;
    setSubmitted(true);
    if (mint !== undefined && initialInvoice !== undefined && !invoiceProblem(initialInvoice))
      review(mint, initialInvoice);
  }, [autoReview, initialInvoice, mint, review]);

  const pay = (quote: MeltQuote, invoice: string): void => {
    setStep({ step: 'paying', quote, invoice });
    wallet.melt(quote).then(
      (r) => {
        if (!alive.current) return;
        cb.current.onSettled(quote.mint, r.paid, quote.amount);
        setStep(
          r.paid ? { step: 'sent', quote, change: r.change } : { step: 'not-paid', quote, invoice },
        );
      },
      (error: unknown) => {
        if (!alive.current) return;
        cb.current.onSettled(quote.mint, false, quote.amount);
        setStep({ step: 'melt-error', quote, invoice, error });
      },
    );
  };

  const shownQuote = step.step === 'confirm' || step.step === 'paying' ? step.quote : undefined;
  const now = useNow(clock, shownQuote !== undefined && shownQuote.expiry > 0);

  // While the melt is in flight the sheet stays open: closing would hide the outcome.
  const close = (): void => {
    if (step.step !== 'paying') onClose();
  };

  const formId = `${id}-form`;
  const invoiceId = `${id}-invoice`;
  const invoiceHint = `${id}-invoice-hint`;

  let body: ReactElement;
  let footer: ReactElement | undefined;

  switch (step.step) {
    case 'form': {
      if (funded.length === 0) {
        body = (
          <EmptyState
            icon="wallet"
            title="Nothing to withdraw"
            description="You hold no sats at any mint yet. Add funds first, then you can send them to any Lightning wallet."
            action="Add funds"
            onAction={onAddFunds}
          />
        );
        footer = (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        );
        break;
      }
      body = (
        <form
          id={formId}
          className="nf-wallet__form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(true);
            if (mint !== undefined && problem === undefined) review(mint, invoiceText);
          }}
        >
          <fieldset className="nf-wallet__field">
            <legend className="nf-wallet__label">From mint</legend>
            <div className="nf-wallet__chips">
              {funded.map((m) => (
                <MintChip
                  key={m}
                  mint={m}
                  balance={balances.get(m) ?? (0 as Sats)}
                  status={mintStatus[m] ?? 'unknown'}
                  selected={m === mint}
                  onSelect={setMint}
                />
              ))}
            </div>
          </fieldset>
          <div className="nf-wallet__field">
            <label className="nf-wallet__label" htmlFor={invoiceId}>
              Lightning invoice
            </label>
            <textarea
              id={invoiceId}
              className={cx(
                'nf-wallet__input',
                'nf-wallet__invoice-text',
                showProblem && 'nf-wallet__input--invalid',
              )}
              rows={4}
              spellCheck={false}
              autoComplete="off"
              placeholder="lnbc…"
              value={invoiceText}
              aria-invalid={showProblem || undefined}
              aria-describedby={invoiceHint}
              onChange={(e) => {
                setInvoiceText(e.currentTarget.value);
              }}
            />
            <p
              id={invoiceHint}
              className={cx('nf-wallet__hint', showProblem && 'nf-wallet__hint--error')}
              role={showProblem ? 'alert' : undefined}
            >
              {showProblem
                ? problem
                : 'Create an invoice in the wallet you want the sats in, then paste it here. You see the fee before anything is sent.'}
            </p>
          </div>
        </form>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="primary" disabled={!mint}>
            Review
          </Button>
        </>
      );
      break;
    }
    case 'quoting':
      body = (
        <div className="nf-wallet__confirm" aria-busy="true">
          <p className="nf-wallet__lead">
            Asking <MintChip mint={step.mint} size="sm" /> what this invoice costs…
          </p>
          <SkeletonLines lines={4} />
        </div>
      );
      footer = (
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      );
      break;
    case 'confirm':
    case 'paying': {
      const { quote, invoice } = step;
      const paying = step.step === 'paying';
      const total = quote.amount + quote.feeReserve;
      const have = balances.get(quote.mint) ?? 0;
      const short = have < total;
      const left = quote.expiry > 0 ? quote.expiry - now : undefined;
      const expired = left !== undefined && left <= 0;
      body = (
        <div className="nf-wallet__confirm" aria-busy={paying || undefined}>
          <p className="nf-wallet__lead">
            Pay this Lightning invoice with ecash from{' '}
            <MintChip mint={quote.mint} balance={have as Sats} size="sm" />
          </p>
          <dl className="nf-wallet__summary">
            <div className="nf-wallet__summary-row">
              <dt>Invoice amount</dt>
              <dd>
                <SatsBadge sats={quote.amount} variant="neutral" />
              </dd>
            </div>
            <div className="nf-wallet__summary-row">
              <dt>Lightning fee reserve, at most</dt>
              <dd>
                <SatsBadge sats={quote.feeReserve} variant="neutral" />
              </dd>
            </div>
            <div className="nf-wallet__summary-row nf-wallet__summary-row--total">
              <dt>Total, at most</dt>
              <dd>
                <SatsBadge
                  sats={total}
                  variant="price"
                  className="nf-wallet__summary-total"
                  label={`Total, at most ${formatSats(total)}`}
                />
              </dd>
            </div>
          </dl>
          <p className="nf-wallet__hint">
            Fee reserve the payment does not use comes back to this mint as change. Invoice{' '}
            <code className="nf-wallet__mono">{shortInvoice(invoice)}</code>
            {left !== undefined && !expired ? (
              <>
                {' '}
                · quote valid for <time>{formatCountdown(left)}</time>
              </>
            ) : null}
          </p>
          {short ? (
            <p className="nf-wallet__notice nf-wallet__notice--danger" role="alert">
              Not enough at this mint: you hold {formatSats(have)} there and this needs up to{' '}
              {formatSats(total)}.
            </p>
          ) : null}
          {expired ? (
            <p className="nf-wallet__notice nf-wallet__notice--warning" role="alert">
              This quote expired. Get a new one to see the current fee.
            </p>
          ) : null}
          {paying ? (
            <p className="nf-wallet__status" aria-live="polite">
              <span className="nf-wallet__pulse" aria-hidden="true" />
              Sending — keep this open until the mint answers.
            </p>
          ) : null}
        </div>
      );
      footer = (
        <>
          <Button
            variant="ghost"
            disabled={paying}
            onClick={() => {
              setStep({ step: 'form' });
            }}
          >
            Back
          </Button>
          {expired && !paying ? (
            <Button
              variant="primary"
              onClick={() => {
                review(quote.mint, invoice);
              }}
            >
              Get a new quote
            </Button>
          ) : (
            <Button
              variant="accent"
              icon="bolt"
              loading={paying}
              disabled={short || expired || paying}
              onClick={() => {
                pay(quote, invoice);
              }}
            >
              {`Withdraw up to ${formatSats(total)}`}
            </Button>
          )}
        </>
      );
      break;
    }
    case 'sent': {
      const { quote, change } = step;
      const fee = Math.max(0, quote.feeReserve - change);
      body = (
        <EmptyState
          icon="check"
          title="Payment sent"
          description={`Paid from ${mintHost(quote.mint)}. Unused fee reserve is back in your balance.`}
          className="nf-wallet__done"
        >
          <dl className="nf-wallet__summary nf-wallet__summary--outcome">
            <div className="nf-wallet__summary-row">
              <dt>Sent</dt>
              <dd>
                <SatsBadge sats={quote.amount} variant="neutral" />
              </dd>
            </div>
            <div className="nf-wallet__summary-row">
              <dt>Lightning fee</dt>
              <dd>
                <SatsBadge sats={fee} variant="neutral" />
              </dd>
            </div>
            {change > 0 ? (
              <div className="nf-wallet__summary-row">
                <dt>Change returned</dt>
                <dd>
                  <SatsBadge sats={change} variant="neutral" />
                </dd>
              </div>
            ) : null}
          </dl>
        </EmptyState>
      );
      footer = (
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      );
      break;
    }
    case 'not-paid':
      body = (
        <ErrorState
          title="Payment did not go through"
          description="The mint could not pay this invoice. If it is still pending your balance updates on its own — check History before you try again."
          retryLabel="Try again"
          onRetry={() => {
            setStep({ step: 'confirm', quote: step.quote, invoice: step.invoice });
          }}
        />
      );
      footer = (
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      );
      break;
    case 'melt-error': {
      const e = describeWalletError(step.error);
      body = (
        <ErrorState
          title="Withdrawal failed"
          description={`${e.description} If the mint was already paying, it finishes on its own — check History before you try again.`}
          detail={e.detail}
          retryLabel="Try again"
          onRetry={() => {
            setStep({ step: 'confirm', quote: step.quote, invoice: step.invoice });
          }}
        />
      );
      footer = (
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      );
      break;
    }
    case 'quote-error': {
      const e = describeWalletError(step.error);
      body = (
        <ErrorState
          title="Could not get a quote"
          description={`${e.description} Nothing was sent.`}
          detail={e.detail}
          onRetry={() => {
            review(step.mint, step.invoice);
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStep({ step: 'form' });
            }}
          >
            Edit invoice
          </Button>
        </ErrorState>
      );
      footer = (
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      );
      break;
    }
  }

  return (
    <Sheet open onClose={close} title="Withdraw" footer={footer} className="nf-wallet__sheet">
      {body}
    </Sheet>
  );
}
