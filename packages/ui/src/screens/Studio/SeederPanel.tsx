/**
 * Studio → Seeder (build-plan §6.1 Studio "Seeder status"): `adapter.seeder.status()` plus
 * live `onStatus` (unsubscribed on unmount) — on/off, storage, earnings (total, unswapped,
 * by mint), melt-out to Lightning with a confirm `Sheet`, connected peers and banned peers
 * with Unban.
 *
 * Melt-out asks the mint for a quote (`adapter.wallet.meltQuote`) before the confirm step so
 * the sheet states the amount and fee the mint will take; `seeder.melt` itself only answers
 * `{ paid }`.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { MeltQuote, MintUrl, NetworkAdapter, NostrPubkey, SeederStatus } from '@sovit/core';
import {
  Button,
  ErrorState,
  Icon,
  MintChip,
  SatsBadge,
  Sheet,
  Skeleton,
  cx,
  formatInteger,
  formatRelativeTime,
  shortPubkey,
} from '../../components/index.js';
import type { Route } from '../shared/route.js';
import { describeBanReason, describeStudioError, formatBytes, normalizeInvoice } from './model.js';

export interface SeederPanelProps {
  readonly adapter: NetworkAdapter;
  readonly navigate: (to: Route) => void;
  readonly now: number;
  /** Renders the confirm sheet in flow instead of fixed to the viewport (Storybook). */
  readonly inlineSheet?: boolean | undefined;
}

type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly status: SeederStatus }
  | { readonly phase: 'error'; readonly error: unknown };

type MeltStep =
  | { readonly step: 'closed' }
  | { readonly step: 'quoting'; readonly mint: MintUrl; readonly invoice: string }
  | {
      readonly step: 'review' | 'paying';
      readonly mint: MintUrl;
      readonly invoice: string;
      readonly quote: MeltQuote;
    }
  | {
      readonly step: 'quote-error';
      readonly mint: MintUrl;
      readonly invoice: string;
      readonly error: unknown;
    }
  | {
      readonly step: 'result';
      readonly mint: MintUrl;
      readonly invoice: string;
      readonly quote: MeltQuote;
      readonly paid: boolean;
    }
  | {
      readonly step: 'melt-error';
      readonly mint: MintUrl;
      readonly invoice: string;
      readonly quote: MeltQuote;
      readonly error: unknown;
    };

function shortInvoice(s: string): string {
  return s.length <= 36 ? s : `${s.slice(0, 20)}…${s.slice(-10)}`;
}

/** Mint with the most earned sats; `undefined` when nothing was earned. */
export function defaultMeltMint(status: SeederStatus): MintUrl | undefined {
  let best: MintUrl | undefined;
  let bestSats = 0;
  for (const [m, s] of status.earned.byMint) {
    if (s > bestSats) {
      best = m;
      bestSats = s;
    }
  }
  return best;
}

export function SeederPanel({
  adapter,
  navigate,
  now,
  inlineSheet,
}: SeederPanelProps): ReactElement {
  const id = useId();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    adapter.seeder.status().then(
      (status) => {
        if (!cancelled) setLoad({ phase: 'ready', status });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ phase: 'error', error });
      },
    );
    const off = adapter.seeder.onStatus((status) => {
      if (!cancelled) setLoad({ phase: 'ready', status });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [adapter, reload]);

  const refresh = useCallback((): void => {
    adapter.seeder.status().then(
      (status) => {
        if (alive.current) setLoad({ phase: 'ready', status });
      },
      () => undefined,
    );
  }, [adapter]);

  // ---- on/off -------------------------------------------------------------------------
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<unknown>(undefined);
  const toggle = (on: boolean): void => {
    setToggling(true);
    setToggleError(undefined);
    adapter.seeder.setEnabled(on).then(
      () => {
        if (!alive.current) return;
        setToggling(false);
        refresh();
      },
      (err: unknown) => {
        if (!alive.current) return;
        setToggling(false);
        setToggleError(err);
      },
    );
  };

  // ---- unban --------------------------------------------------------------------------
  const [unbanning, setUnbanning] = useState<Readonly<Record<string, 'busy' | 'error'>>>({});
  const [unbanned, setUnbanned] = useState<readonly NostrPubkey[]>([]);
  const unban = (pk: NostrPubkey): void => {
    setUnbanning((p) => ({ ...p, [pk]: 'busy' }));
    adapter.seeder.unban(pk).then(
      () => {
        if (!alive.current) return;
        setUnbanned((u) => [...u, pk]);
        setUnbanning((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== pk)));
      },
      () => {
        if (alive.current) setUnbanning((p) => ({ ...p, [pk]: 'error' }));
      },
    );
  };

  // ---- melt ---------------------------------------------------------------------------
  const [meltMint, setMeltMint] = useState<MintUrl | undefined>(undefined);
  const [invoiceText, setInvoiceText] = useState('');
  const [invoiceError, setInvoiceError] = useState<string | undefined>(undefined);
  const [melt, setMelt] = useState<MeltStep>({ step: 'closed' });

  const status = load.phase === 'ready' ? load.status : undefined;
  const mint = meltMint ?? (status ? defaultMeltMint(status) : undefined);

  /** Bumped when the sheet closes, so a late quote/melt answer cannot reopen it. */
  const meltSeq = useRef(0);
  const review = (): void => {
    const invoice = normalizeInvoice(invoiceText);
    if (invoice === null) {
      setInvoiceError('Paste a Lightning invoice (it starts with lnbc).');
      return;
    }
    if (mint === undefined) return;
    setInvoiceError(undefined);
    const seq = ++meltSeq.current;
    setMelt({ step: 'quoting', mint, invoice });
    adapter.wallet.meltQuote(mint, invoice).then(
      (quote) => {
        if (alive.current && meltSeq.current === seq) {
          setMelt({ step: 'review', mint, invoice, quote });
        }
      },
      (error: unknown) => {
        if (alive.current && meltSeq.current === seq) {
          setMelt({ step: 'quote-error', mint, invoice, error });
        }
      },
    );
  };
  const confirm = (): void => {
    if (melt.step !== 'review') return;
    const { mint: m, invoice, quote } = melt;
    const seq = meltSeq.current;
    setMelt({ step: 'paying', mint: m, invoice, quote });
    adapter.seeder.melt(m, invoice).then(
      (r) => {
        if (!alive.current) return;
        if (r.paid) {
          setInvoiceText('');
          refresh();
        }
        if (meltSeq.current === seq) {
          setMelt({ step: 'result', mint: m, invoice, quote, paid: r.paid });
        }
      },
      (error: unknown) => {
        if (alive.current && meltSeq.current === seq) {
          setMelt({ step: 'melt-error', mint: m, invoice, quote, error });
        }
      },
    );
  };
  /** Closing is refused while the melt is in flight: its answer must be seen. */
  const closeMelt = (): void => {
    if (melt.step === 'paying') return;
    meltSeq.current++;
    setMelt({ step: 'closed' });
  };

  // ---- render -------------------------------------------------------------------------
  if (load.phase === 'loading') {
    return (
      <div className="nf-studio__seeder" aria-hidden="true">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="nf-studio__card">
            <Skeleton variant="text" width="40%" />
            <Skeleton variant="text" width="70%" />
            <Skeleton variant="text" width="55%" />
          </div>
        ))}
      </div>
    );
  }
  if (load.phase === 'error') {
    const e = describeStudioError(load.error, 'seeder');
    return (
      <ErrorState
        title={e.title}
        description={e.description}
        detail={e.detail}
        onRetry={() => {
          setLoad({ phase: 'loading' });
          setReload((r) => r + 1);
        }}
      />
    );
  }

  const s = load.status;
  const banned = s.banned.filter((b) => !unbanned.includes(b.pubkey));
  const byMint = [...s.earned.byMint.entries()];
  const usedPct = s.diskCapBytes > 0 ? Math.min(100, (s.bytesStored / s.diskCapBytes) * 100) : 0;
  const earnedAtMint = mint !== undefined ? (s.earned.byMint.get(mint) ?? 0) : 0;

  return (
    <div className="nf-studio__seeder">
      <section className="nf-studio__card" aria-labelledby={`${id}-device`}>
        <h2 id={`${id}-device`} className="nf-studio__card-title">
          Seeding on this device
        </h2>
        <p className={cx('nf-studio__seed-state', s.enabled && 'is-on')}>
          <span className="nf-studio__seed-dot" aria-hidden="true" />
          {s.enabled
            ? `On — streaming ${formatInteger(s.videos)} ${s.videos === 1 ? 'video' : 'videos'} to paying viewers`
            : 'Off — this device is not streaming your videos to anyone'}
        </p>
        <div className="nf-studio__inline">
          <Button
            variant={s.enabled ? 'secondary' : 'accent'}
            loading={toggling}
            onClick={() => {
              toggle(!s.enabled);
            }}
          >
            {s.enabled ? 'Turn off seeding' : 'Turn on seeding'}
          </Button>
        </div>
        {toggleError !== undefined ? (
          <p className="nf-studio__error" role="alert">
            Could not change seeding. {describeStudioError(toggleError, 'seeder').description}
          </p>
        ) : null}
        <div className="nf-studio__storage">
          <label htmlFor={`${id}-disk`} className="nf-studio__label">
            Storage
          </label>
          <meter
            id={`${id}-disk`}
            className="nf-studio__meter"
            min={0}
            max={Math.max(1, s.diskCapBytes)}
            value={Math.min(s.bytesStored, Math.max(1, s.diskCapBytes))}
            high={Math.max(1, s.diskCapBytes) * 0.9}
          />
          <p className="nf-studio__hint">
            {formatBytes(s.bytesStored)} of {formatBytes(s.diskCapBytes)} ({Math.round(usedPct)}%) ·{' '}
            <button
              type="button"
              className="nf-studio__link"
              onClick={() => {
                navigate({ name: 'settings' });
              }}
            >
              Change the disk cap in Settings
            </button>
          </p>
        </div>
      </section>

      <section className="nf-studio__card" aria-labelledby={`${id}-earn`}>
        <h2 id={`${id}-earn`} className="nf-studio__card-title">
          Earnings
        </h2>
        <div className="nf-studio__earn-total">
          <SatsBadge sats={s.earned.total} variant="earned" />
          <span className="nf-studio__muted">earned by this seeder</span>
        </div>
        <p className="nf-studio__hint">
          <SatsBadge sats={s.earned.unswapped} variant="neutral" size="sm" /> received from viewers
          and not yet swapped at the mint (swaps run in batches).
        </p>
        {byMint.length > 0 ? (
          <ul className="nf-studio__by-mint" aria-label="Earnings by mint">
            {byMint.map(([m, v]) => (
              <li key={m}>
                <MintChip mint={m} size="sm" />
                <SatsBadge sats={v} variant="neutral" size="sm" />
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="nf-studio__card" aria-labelledby={`${id}-melt`}>
        <h2 id={`${id}-melt`} className="nf-studio__card-title">
          Melt out to Lightning
        </h2>
        {byMint.length === 0 || mint === undefined ? (
          <p className="nf-studio__muted">
            Nothing to melt yet. Earnings land here as viewers pay for blocks you stream.
          </p>
        ) : (
          <>
            <div className="nf-studio__field" role="group" aria-labelledby={`${id}-melt-mint`}>
              <span id={`${id}-melt-mint`} className="nf-studio__label">
                From mint
              </span>
              <div className="nf-studio__mints">
                {byMint.map(([m, v]) => (
                  <MintChip
                    key={m}
                    mint={m}
                    balance={v}
                    selected={m === mint}
                    onSelect={setMeltMint}
                  />
                ))}
              </div>
            </div>
            <div className="nf-studio__field">
              <label htmlFor={`${id}-invoice`} className="nf-studio__label">
                Lightning invoice
              </label>
              <textarea
                id={`${id}-invoice`}
                className="nf-studio__input nf-studio__textarea nf-studio__mono"
                rows={3}
                value={invoiceText}
                placeholder="lnbc…"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setInvoiceText(e.currentTarget.value);
                }}
                {...(invoiceError
                  ? { 'aria-invalid': true, 'aria-describedby': `${id}-invoice-error` }
                  : { 'aria-describedby': `${id}-invoice-hint` })}
              />
              {invoiceError ? (
                <p id={`${id}-invoice-error`} className="nf-studio__error">
                  {invoiceError}
                </p>
              ) : (
                <p id={`${id}-invoice-hint`} className="nf-studio__hint">
                  Make an invoice in your Lightning wallet for up to{' '}
                  <SatsBadge sats={earnedAtMint} variant="neutral" size="sm" />, minus the mint’s
                  fee. You confirm the amount on the next step.
                </p>
              )}
            </div>
            <div className="nf-studio__inline">
              <Button variant="accent" onClick={review} disabled={invoiceText.trim() === ''}>
                Review melt-out
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="nf-studio__card nf-studio__wide" aria-labelledby={`${id}-peers`}>
        <h2 id={`${id}-peers`} className="nf-studio__card-title">
          Connected peers
        </h2>
        {s.peers.length === 0 ? (
          <p className="nf-studio__muted">No viewers are streaming from this seeder right now.</p>
        ) : (
          <div className="nf-studio__table-wrap">
            <table className="nf-studio__table nf-studio__table--compact">
              <caption className="nf-studio__sr">Peers streaming from this seeder</caption>
              <thead>
                <tr>
                  <th scope="col">Peer</th>
                  <th scope="col" className="nf-studio__num">
                    Blocks sent
                  </th>
                  <th scope="col" className="nf-studio__num">
                    Blocks paid
                  </th>
                  <th scope="col" className="nf-studio__num">
                    Unpaid
                  </th>
                  <th scope="col">Last active</th>
                </tr>
              </thead>
              <tbody>
                {s.peers.map((p) => (
                  <tr key={p.peer}>
                    <td className="nf-studio__mono">{shortPubkey(p.peer)}</td>
                    <td className="nf-studio__num">{formatInteger(p.uploaded)}</td>
                    <td className="nf-studio__num">{formatInteger(p.paid)}</td>
                    <td className="nf-studio__num">
                      {formatInteger(p.outstanding)} of {formatInteger(p.windowBlocks)}
                    </td>
                    <td className="nf-studio__muted">{formatRelativeTime(p.lastActivity, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="nf-studio__hint">
          A peer may be at most {formatInteger(s.peers[0]?.windowBlocks ?? 4)} blocks behind on
          payment; past that the stream is cut and the peer banned.
        </p>
      </section>

      <section className="nf-studio__card nf-studio__wide" aria-labelledby={`${id}-banned`}>
        <h2 id={`${id}-banned`} className="nf-studio__card-title">
          Banned peers
        </h2>
        {banned.length === 0 ? (
          <p className="nf-studio__muted">No banned peers.</p>
        ) : (
          <ul className="nf-studio__banned">
            {banned.map((b) => (
              <li key={b.pubkey} className="nf-studio__banned-row">
                <Icon name="error" size={20} className="nf-studio__banned-icon" />
                <div className="nf-studio__video-text">
                  <span className="nf-studio__mono">{shortPubkey(b.pubkey)}</span>
                  <span className="nf-studio__muted">
                    {describeBanReason(b.reason)} · {formatRelativeTime(b.at, now)}
                  </span>
                  {unbanning[b.pubkey] === 'error' ? (
                    <span className="nf-studio__error">Could not unban. Try again.</span>
                  ) : null}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={unbanning[b.pubkey] === 'busy'}
                  onClick={() => {
                    unban(b.pubkey);
                  }}
                  aria-label={`Unban ${shortPubkey(b.pubkey)}`}
                >
                  Unban
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Sheet
        open={melt.step !== 'closed'}
        onClose={closeMelt}
        title="Melt out to Lightning"
        inline={inlineSheet ?? false}
        footer={
          <MeltFooter melt={melt} onCancel={closeMelt} onConfirm={confirm} onRetry={review} />
        }
      >
        <MeltBody melt={melt} earned={earnedAtMint} />
      </Sheet>
    </div>
  );
}

function MeltBody({
  melt,
  earned,
}: {
  readonly melt: MeltStep;
  readonly earned: number;
}): ReactElement | null {
  if (melt.step === 'closed') return null;
  const head = (
    <dl className="nf-studio__facts">
      <dt>From</dt>
      <dd>
        <MintChip mint={melt.mint} size="sm" />
      </dd>
      <dt>Invoice</dt>
      <dd className="nf-studio__mono" title={melt.invoice}>
        {shortInvoice(melt.invoice)}
      </dd>
    </dl>
  );
  switch (melt.step) {
    case 'quoting':
      return (
        <div className="nf-studio__melt" aria-busy="true">
          {head}
          <p className="nf-studio__muted">Asking the mint for a quote…</p>
        </div>
      );
    case 'quote-error': {
      const e = describeStudioError(melt.error, 'melt');
      return (
        <div className="nf-studio__melt">
          {head}
          <ErrorState
            compact
            title="The mint could not quote this invoice"
            description="Nothing was paid. Check the invoice (it may have expired) and try again."
            detail={e.detail}
          />
        </div>
      );
    }
    case 'review':
    case 'paying': {
      const total = melt.quote.amount + melt.quote.feeReserve;
      return (
        <div className="nf-studio__melt">
          {head}
          <dl className="nf-studio__facts nf-studio__facts--money">
            <dt>Invoice amount</dt>
            <dd>
              <SatsBadge sats={melt.quote.amount} variant="neutral" />
            </dd>
            <dt>Mint fee, at most</dt>
            <dd>
              <SatsBadge sats={melt.quote.feeReserve} variant="neutral" />
            </dd>
            <dt>Leaves the mint, at most</dt>
            <dd>
              <SatsBadge sats={total} variant="price" />
            </dd>
          </dl>
          {total > earned ? (
            <p className="nf-studio__warn">
              That is more than this seeder has earned at this mint; the rest comes from your wallet
              balance there, if it has enough.
            </p>
          ) : null}
          <p className="nf-studio__hint">
            Quoted by the mint. Any unused fee comes back as change.
          </p>
        </div>
      );
    }
    case 'result':
      return (
        <div className="nf-studio__melt">
          {head}
          {melt.paid ? (
            <div className="nf-studio__melt-result is-paid" role="status">
              <Icon name="check" size={24} />
              <div>
                <p className="nf-studio__card-title">Paid</p>
                <p className="nf-studio__hint">
                  <SatsBadge sats={melt.quote.amount} variant="earned" size="sm" /> sent to your
                  Lightning invoice.
                </p>
              </div>
            </div>
          ) : (
            <div className="nf-studio__melt-result" role="alert">
              <Icon name="error" size={24} />
              <div>
                <p className="nf-studio__card-title">Not paid</p>
                <p className="nf-studio__hint">
                  The mint did not pay the invoice — usually not enough balance at this mint for the
                  amount and fee. Your ecash stays at the mint; try a smaller invoice or another
                  mint.
                </p>
              </div>
            </div>
          )}
        </div>
      );
    case 'melt-error': {
      const e = describeStudioError(melt.error, 'melt');
      return (
        <div className="nf-studio__melt">
          {head}
          <ErrorState compact title={e.title} description={e.description} detail={e.detail} />
        </div>
      );
    }
  }
}

function MeltFooter({
  melt,
  onCancel,
  onConfirm,
  onRetry,
}: {
  readonly melt: MeltStep;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onRetry: () => void;
}): ReactElement | null {
  switch (melt.step) {
    case 'closed':
      return null;
    case 'quoting':
    case 'review':
    case 'paying':
      return (
        <div className="nf-studio__sheet-actions">
          <Button variant="ghost" onClick={onCancel} disabled={melt.step === 'paying'}>
            Cancel
          </Button>
          <Button
            variant="accent"
            onClick={onConfirm}
            disabled={melt.step !== 'review'}
            loading={melt.step === 'paying'}
          >
            {melt.step === 'quoting'
              ? 'Melt out'
              : `Melt out ${formatInteger(melt.quote.amount)} ${melt.quote.amount === 1 ? 'sat' : 'sats'}`}
          </Button>
        </div>
      );
    case 'quote-error':
      return (
        <div className="nf-studio__sheet-actions">
          <Button variant="ghost" onClick={onCancel}>
            Close
          </Button>
          <Button variant="secondary" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        </div>
      );
    case 'result':
    case 'melt-error':
      return (
        <div className="nf-studio__sheet-actions">
          <Button variant="primary" onClick={onCancel}>
            Done
          </Button>
        </div>
      );
  }
}
