/**
 * "Add funds" sheet (build-plan §3 "Funding"): pick mint + amount → `wallet.mintQuote` (NUT-04)
 * → the bolt11 as a QR, copyable text and a `lightning:` link, with an expiry countdown →
 * `wallet.pollQuote` with back-off until the mint reports the invoice paid and the ecash
 * minted → success. Expired / unreachable / failed each have a designed state.
 *
 * Mounted only while open: closing the sheet unmounts it, which stops polling (the effect
 * cleanup clears the timer and drops any in-flight answer).
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { MintQuote, MintUrl, Sats, Wallet } from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  MintChip,
  SatsBadge,
  Sheet,
  Skeleton,
  SkeletonLines,
  cx,
  formatInteger,
  formatSats,
  mintHost,
  type MintStatus,
} from '../../components/index.js';
import { useAlive, useNow } from './hooks.js';
import { InvoiceQr } from './InvoiceQr.js';
import {
  POLL_MAX_ERRORS,
  describeWalletError,
  formatCountdown,
  invoiceHref,
  looksLikeMintInvoice,
  nextPollDelay,
  parseSats,
} from './invoice.js';

/** Quick picks under the amount field (YouTube-style chips). */
export const FUND_PRESETS: readonly number[] = [1000, 5000, 10_000, 21_000];

export interface FundSheetProps {
  readonly wallet: Wallet;
  /** Every mint the viewer can fund (wallet mints ∪ default mints from Settings). */
  readonly mints: readonly MintUrl[];
  readonly balances: ReadonlyMap<MintUrl, Sats>;
  readonly mintStatus: Readonly<Record<string, MintStatus>>;
  readonly initialMint?: MintUrl | undefined;
  readonly initialAmount?: number | undefined;
  /** Request the invoice at once (a deep link that already chose mint and amount). */
  readonly autoRequest?: boolean | undefined;
  /** Unix seconds; must be referentially stable. */
  readonly clock: () => number;
  readonly pollInitialMs: number;
  readonly pollMaxMs: number;
  readonly onClose: () => void;
  readonly onFunded: (mint: MintUrl, minted: number) => void;
  readonly onMintStatus: (mint: MintUrl, status: MintStatus) => void;
  readonly onCopied: (ok: boolean) => void;
  readonly onOpenSettings: () => void;
}

type Step =
  | { readonly step: 'form' }
  | { readonly step: 'requesting'; readonly mint: MintUrl; readonly amount: number }
  | {
      readonly step: 'invoice';
      readonly quote: MintQuote;
      /** The mint says PAID but has not issued the ecash yet. */
      readonly paidPending: boolean;
    }
  | { readonly step: 'paid'; readonly quote: MintQuote; readonly minted: number }
  | { readonly step: 'expired'; readonly quote: MintQuote }
  | { readonly step: 'unreachable'; readonly quote: MintQuote; readonly error: unknown }
  | {
      readonly step: 'error';
      readonly mint: MintUrl;
      readonly amount: number;
      readonly error: unknown;
    };

function defaultMint(
  mints: readonly MintUrl[],
  balances: ReadonlyMap<MintUrl, Sats>,
  preferred: MintUrl | undefined,
): MintUrl | undefined {
  if (preferred !== undefined) return preferred;
  let best: MintUrl | undefined;
  let bestBalance = -1;
  for (const m of mints) {
    const b = balances.get(m) ?? 0;
    if (b > bestBalance) {
      best = m;
      bestBalance = b;
    }
  }
  return best;
}

export function FundSheet({
  wallet,
  mints,
  balances,
  mintStatus,
  initialMint,
  initialAmount,
  autoRequest = false,
  clock,
  pollInitialMs,
  pollMaxMs,
  onClose,
  onFunded,
  onMintStatus,
  onCopied,
  onOpenSettings,
}: FundSheetProps): ReactElement {
  const id = useId();
  const alive = useAlive();
  const choices =
    initialMint !== undefined && !mints.includes(initialMint) ? [initialMint, ...mints] : mints;
  const [mint, setMint] = useState<MintUrl | undefined>(() =>
    defaultMint(choices, balances, initialMint),
  );
  const [amountText, setAmountText] = useState(
    initialAmount !== undefined ? String(initialAmount) : '',
  );
  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState<Step>({ step: 'form' });
  const [pollGen, setPollGen] = useState(0);
  // Parent callbacks via a ref: a re-render upstream must never restart the poll loop.
  const cb = useRef({ onFunded, onMintStatus });
  cb.current = { onFunded, onMintStatus };

  const amount = parseSats(amountText);
  const amountInvalid = submitted && amount === undefined;

  const request = useCallback(
    (m: MintUrl, sats: number): void => {
      setStep({ step: 'requesting', mint: m, amount: sats });
      wallet.mintQuote(m, sats as Sats).then(
        (quote) => {
          if (!alive.current) return;
          cb.current.onMintStatus(m, 'ok');
          if (!looksLikeMintInvoice(quote.bolt11)) {
            setStep({
              step: 'error',
              mint: m,
              amount: sats,
              error: new Error('unexpected answer: not a Lightning invoice'),
            });
            return;
          }
          setStep({ step: 'invoice', quote, paidPending: false });
        },
        (error: unknown) => {
          if (!alive.current) return;
          if (describeWalletError(error).title === 'Mint unreachable')
            cb.current.onMintStatus(m, 'unreachable');
          setStep({ step: 'error', mint: m, amount: sats, error });
        },
      );
    },
    [alive, wallet],
  );

  // A deep link that already chose mint + amount skips the form (the click was upstream).
  const autoDone = useRef(false);
  useEffect(() => {
    if (autoDone.current || !autoRequest) return;
    autoDone.current = true;
    const sats = initialAmount !== undefined ? parseSats(String(initialAmount)) : undefined;
    if (mint !== undefined && sats !== undefined) request(mint, sats);
  }, [autoRequest, initialAmount, mint, request]);

  // ---- polling (back-off; one final check at expiry; stops on close/unmount) -----------
  const invoiceQuote = step.step === 'invoice' ? step.quote : undefined;
  useEffect(() => {
    if (!invoiceQuote) return;
    const quote = invoiceQuote;
    let cancelled = false;
    // Read through a call: TS would otherwise keep `cancelled` narrowed across the awaits.
    const isCancelled = (): boolean => cancelled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay: number | undefined;
    let errors = 0;
    const hasExpiry = quote.expiry > 0;

    const succeed = (minted: number): void => {
      if (cancelled) return;
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      setStep({ step: 'paid', quote, minted });
      cb.current.onFunded(quote.mint, minted);
    };

    const schedule = (): void => {
      const next = nextPollDelay(delay, pollInitialMs, pollMaxMs);
      delay = next;
      // Never sleep past the expiry: the last UNPAID check happens right at it. (Once past
      // it — a PAID-but-not-issued quote — the plain back-off applies.)
      const msLeft = hasExpiry ? (quote.expiry - clock()) * 1000 : Number.POSITIVE_INFINITY;
      timer = setTimeout(
        () => {
          void tick();
        },
        msLeft > 0 ? Math.min(next, Math.ceil(msLeft)) : next,
      );
    };

    const tick = async (): Promise<void> => {
      if (isCancelled()) return;
      const expiredBefore = hasExpiry && clock() >= quote.expiry;
      try {
        const r = await wallet.pollQuote(quote);
        if (isCancelled()) return;
        errors = 0;
        if (r.minted !== undefined || r.state === 'ISSUED') {
          succeed(r.minted ?? quote.amount);
          return;
        }
        if (r.state === 'PAID') {
          setStep((prev) =>
            prev.step === 'invoice' && prev.quote.quoteId === quote.quoteId && !prev.paidPending
              ? { ...prev, paidPending: true }
              : prev,
          );
        } else if (expiredBefore) {
          setStep({ step: 'expired', quote });
          return;
        }
      } catch (error: unknown) {
        if (isCancelled()) return;
        errors += 1;
        if (errors >= POLL_MAX_ERRORS) {
          cb.current.onMintStatus(quote.mint, 'unreachable');
          setStep({ step: 'unreachable', quote, error });
          return;
        }
      }
      schedule();
    };

    // The wallet may learn about the payment first (its own subscription / another tab).
    const off = wallet.onChange((e) => {
      if (e.type === 'quote' && e.quote.quoteId === quote.quoteId && e.quote.state === 'ISSUED')
        succeed(quote.amount);
    });
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
    };
    // `pollGen` restarts the loop for "Check again" (same quote object).
  }, [clock, invoiceQuote, pollGen, pollInitialMs, pollMaxMs, wallet]);

  const quoteForClock =
    step.step === 'invoice' ? step.quote : step.step === 'unreachable' ? step.quote : undefined;
  const now = useNow(clock, quoteForClock !== undefined && quoteForClock.expiry > 0);

  const submit = (): void => {
    setSubmitted(true);
    if (mint === undefined || amount === undefined) return;
    request(mint, amount);
  };

  const copy = (text: string): void => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clip) {
      onCopied(false);
      return;
    }
    clip.writeText(text).then(
      () => {
        if (alive.current) onCopied(true);
      },
      () => {
        if (alive.current) onCopied(false);
      },
    );
  };

  // ---- render ------------------------------------------------------------------------
  const formId = `${id}-form`;
  const amountId = `${id}-amount`;
  const amountHint = `${id}-amount-hint`;
  const invoiceId = `${id}-invoice`;

  let body: ReactElement;
  let footer: ReactElement | undefined;

  switch (step.step) {
    case 'form': {
      if (choices.length === 0) {
        body = (
          <EmptyState
            icon="coin"
            title="No mint to fund"
            description="Add a Cashu mint in Settings first — top-ups land at a mint you choose."
            action="Open Settings"
            onAction={onOpenSettings}
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
            submit();
          }}
        >
          <fieldset className="nf-wallet__field">
            <legend className="nf-wallet__label">Mint</legend>
            <div className="nf-wallet__chips">
              {choices.map((m) => (
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
            <p className="nf-wallet__hint">
              The sats land at this mint.{' '}
              <button type="button" className="nf-wallet__link" onClick={onOpenSettings}>
                Manage mints in Settings
              </button>
            </p>
          </fieldset>
          <div className="nf-wallet__field">
            <label className="nf-wallet__label" htmlFor={amountId}>
              Amount
            </label>
            <div className={cx('nf-wallet__amount', amountInvalid && 'nf-wallet__amount--invalid')}>
              <input
                id={amountId}
                className="nf-wallet__input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                placeholder="5,000"
                value={amountText}
                aria-invalid={amountInvalid || undefined}
                aria-describedby={amountHint}
                onChange={(e) => {
                  setAmountText(e.currentTarget.value);
                }}
              />
              <span className="nf-wallet__unit">sats</span>
            </div>
            <div className="nf-wallet__presets" role="group" aria-label="Quick amounts">
              {FUND_PRESETS.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant="secondary"
                  pressed={amount === p}
                  onClick={() => {
                    setAmountText(String(p));
                  }}
                >
                  {formatInteger(p)}
                </Button>
              ))}
            </div>
            <p
              id={amountHint}
              className={cx('nf-wallet__hint', amountInvalid && 'nf-wallet__hint--error')}
              role={amountInvalid ? 'alert' : undefined}
            >
              {amountInvalid
                ? 'Enter a whole number of sats, at least 1.'
                : 'You pay this from any Lightning wallet; the mint may set its own limits.'}
            </p>
          </div>
        </form>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="accent" icon="bolt" disabled={!mint}>
            Create invoice
          </Button>
        </>
      );
      break;
    }
    case 'requesting':
      body = (
        <div className="nf-wallet__invoice" aria-busy="true">
          <p className="nf-wallet__lead">
            Asking <MintChip mint={step.mint} size="sm" /> for an invoice for{' '}
            <SatsBadge sats={step.amount} variant="price" />
          </p>
          <div className="nf-wallet__qr nf-wallet__qr--pending">
            <Skeleton variant="block" width={232} height={232} />
          </div>
          <SkeletonLines lines={2} />
        </div>
      );
      footer = (
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      );
      break;
    case 'invoice': {
      const { quote, paidPending } = step;
      const left = quote.expiry > 0 ? quote.expiry - now : undefined;
      body = (
        <div className="nf-wallet__invoice">
          <p className="nf-wallet__lead">
            Pay from any Lightning wallet to add <SatsBadge sats={quote.amount} variant="price" />{' '}
            at <MintChip mint={quote.mint} size="sm" status={mintStatus[quote.mint] ?? 'ok'} />
          </p>
          <div className="nf-wallet__qr">
            <InvoiceQr
              bolt11={quote.bolt11}
              label={`QR code: Lightning invoice for ${formatSats(quote.amount)}`}
              className="nf-wallet__qr-svg"
            />
          </div>
          <p className="nf-wallet__status">
            <span
              className={cx('nf-wallet__pulse', paidPending && 'nf-wallet__pulse--paid')}
              aria-hidden="true"
            />
            <span aria-live="polite">
              {paidPending ? 'Payment received — minting your ecash…' : 'Waiting for payment…'}
            </span>
            {left !== undefined ? (
              <span className="nf-wallet__countdown">
                {' '}
                · Expires in <time>{formatCountdown(left)}</time>
              </span>
            ) : null}
          </p>
          <label className="nf-wallet__label" htmlFor={invoiceId}>
            Invoice
          </label>
          <textarea
            id={invoiceId}
            className="nf-wallet__input nf-wallet__invoice-text"
            readOnly
            rows={3}
            spellCheck={false}
            value={quote.bolt11}
            onFocus={(e) => {
              e.currentTarget.select();
            }}
          />
          <div className="nf-wallet__row">
            <Button
              variant="primary"
              onClick={() => {
                copy(quote.bolt11);
              }}
            >
              Copy invoice
            </Button>
            <a
              className="nf-button nf-button--secondary nf-button--md"
              href={invoiceHref(quote.bolt11)}
            >
              <span className="nf-button__label">Open in wallet</span>
            </a>
          </div>
          <p className="nf-wallet__hint">
            Your Lightning wallet shows the amount before you pay — it should say{' '}
            {formatSats(quote.amount)}. Keep this open until the payment arrives.
          </p>
        </div>
      );
      footer = (
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      );
      break;
    }
    case 'paid':
      body = (
        <EmptyState
          icon="check"
          title="Payment received"
          description={`Your ecash is at ${mintHost(step.quote.mint)}, ready to spend.`}
          className="nf-wallet__done"
        >
          <dl className="nf-wallet__summary nf-wallet__summary--outcome">
            <div className="nf-wallet__summary-row">
              <dt>Added</dt>
              <dd>
                <SatsBadge sats={step.minted} variant="earned" prefix="+" />
              </dd>
            </div>
          </dl>
        </EmptyState>
      );
      footer = (
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      );
      break;
    case 'expired':
      body = (
        <EmptyState
          icon="replay"
          title="Invoice expired"
          description="It was not paid in time, so nothing was charged. Create a new invoice to try again."
          action="New invoice"
          onAction={() => {
            request(step.quote.mint, step.quote.amount);
          }}
        />
      );
      footer = (
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      );
      break;
    case 'unreachable': {
      const e = describeWalletError(step.error);
      body = (
        <ErrorState
          title="The mint is not answering"
          description="We stopped checking this invoice. If you already paid it, do not pay again — check again once the mint answers."
          detail={e.detail}
          retryLabel="Check again"
          onRetry={() => {
            setStep({ step: 'invoice', quote: step.quote, paidPending: false });
            setPollGen((g) => g + 1);
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
    case 'error': {
      const e = describeWalletError(step.error);
      body = (
        <ErrorState
          title="Could not create an invoice"
          description={e.description}
          detail={e.detail}
          onRetry={() => {
            request(step.mint, step.amount);
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStep({ step: 'form' });
            }}
          >
            Change mint or amount
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
    <Sheet open onClose={onClose} title="Add funds" footer={footer} className="nf-wallet__sheet">
      {body}
    </Sheet>
  );
}
