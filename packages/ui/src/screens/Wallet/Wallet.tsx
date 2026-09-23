/**
 * Wallet screen (build-plan §6.1 row "Wallet", §3 "Funding"): balance per mint with a
 * `MintChip` each, fund via a Lightning invoice QR (NUT-04 mint quote + polling), melt-out to
 * a Lightning invoice (NUT-05, fee shown before an explicit confirm), the auto-top-up
 * threshold (`Settings.autoTopUp`, optimistic with rollback), and history (NIP-60 kind 7376).
 *
 * Talks ONLY to `NetworkAdapter` (`me`, `signer`, `wallet.*`, `settings`, `updateSettings`);
 * renders ONLY `@sovit/ui` components + semantic HTML. It never shows proofs, secrets, keys
 * or payment preimages. The wallet needs a signer (NIP-60 events are encrypted to the
 * viewer's key), so a signed-out visitor gets the designed "signer not detected" state.
 *
 * `WalletChip` (the shell's persistent header chip) lives next door in `WalletChip.tsx`.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import type { MintUrl, NostrPubkey, Sats, SignerStatus, WalletHistoryEntry } from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Markdown,
  MintChip,
  SatsBadge,
  Skeleton,
  SkeletonLines,
  ToastStack,
  cx,
  formatRelativeTime,
  formatSats,
  mintHost,
  type IconName,
  type MintStatus,
  type ToastItem,
} from '../../components/index.js';
import type { ScreenProps } from '../shared/route.js';
import { FundSheet } from './FundSheet.js';
import { useAlive } from './hooks.js';
import {
  POLL_INITIAL_MS,
  POLL_MAX_MS,
  describeWalletError,
  isAutoTopUpOn,
  parseSats,
  type AutoTopUp,
} from './invoice.js';
import { WithdrawSheet } from './WithdrawSheet.js';

/**
 * A deep link into one of the flows, e.g. Watch's "No balance at this mint → Top up" (the
 * `Route` for `wallet` carries no params in v3, so the shell passes this prop).
 * - `fund` with `mint` + `amount`: the sheet opens and requests the invoice at once (the
 *   choice was made upstream; a mint quote moves no money).
 * - `withdraw` with `invoice`: the sheet opens and fetches the melt quote — it NEVER pays
 *   without the explicit confirm.
 */
export type WalletIntent =
  | {
      readonly action: 'fund';
      readonly mint?: MintUrl | undefined;
      readonly amount?: Sats | number | undefined;
    }
  | {
      readonly action: 'withdraw';
      readonly mint?: MintUrl | undefined;
      readonly invoice?: string | undefined;
    };

export interface WalletProps extends ScreenProps {
  readonly intent?: WalletIntent | undefined;
  /** Unix seconds; pinned in stories/tests. Drives relative times and expiry countdowns. */
  readonly clock?: (() => number) | undefined;
  /** `wallet.history({ limit })`. */
  readonly historyLimit?: number | undefined;
  /** First `pollQuote` delay after an invoice is shown (ms). */
  readonly pollIntervalMs?: number | undefined;
  /** Back-off cap between polls (ms). */
  readonly maxPollIntervalMs?: number | undefined;
  readonly className?: string | undefined;
}

export const WALLET_HISTORY_LIMIT = 50;

type Me = 'pending' | NostrPubkey | null;
type Status = 'loading' | 'ready' | 'error';

interface BalancesState {
  readonly status: Status;
  readonly map: ReadonlyMap<MintUrl, Sats>;
  readonly mints: readonly MintUrl[];
  readonly error: unknown;
}

interface HistoryState {
  readonly status: Status;
  /** The filter these items were loaded for. */
  readonly filter: MintUrl | 'all';
  readonly items: readonly WalletHistoryEntry[];
  readonly error: unknown;
}

type SheetState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'fund';
      readonly seq: number;
      readonly mint?: MintUrl | undefined;
      readonly amount?: number | undefined;
      readonly auto: boolean;
    }
  | {
      readonly kind: 'withdraw';
      readonly seq: number;
      readonly mint?: MintUrl | undefined;
      readonly invoice?: string | undefined;
      readonly auto: boolean;
    };

const EMPTY_MAP: ReadonlyMap<MintUrl, Sats> = new Map();

function defaultClock(): number {
  return Date.now() / 1000;
}

function uniqueMints(...lists: readonly (readonly MintUrl[])[]): MintUrl[] {
  const out: MintUrl[] = [];
  for (const list of lists) for (const m of list) if (!out.includes(m)) out.push(m);
  return out;
}

/** Icon + a friendlier title for the memos the wallet itself writes; others show as-is. */
export function historyLabel(entry: WalletHistoryEntry): {
  readonly icon: IconName;
  readonly title: string | undefined;
} {
  const memo = (entry.memo ?? '').trim();
  const fallbackIcon: IconName = entry.direction === 'in' ? 'coin' : 'bolt';
  if (/^top-?up$/i.test(memo)) return { icon: 'wallet', title: 'Top-up via Lightning' };
  if (/^melt(-?out)?$/i.test(memo)) return { icon: 'bolt', title: 'Withdrawal to Lightning' };
  if (/^receive$/i.test(memo)) return { icon: 'coin', title: 'Received ecash' };
  if (/^stream/i.test(memo)) return { icon: 'play', title: undefined };
  if (/nutzap/i.test(memo)) return { icon: 'bolt', title: undefined };
  if (memo === '')
    return { icon: fallbackIcon, title: entry.direction === 'in' ? 'Received' : 'Sent' };
  return { icon: fallbackIcon, title: undefined };
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function Wallet({
  adapter,
  navigate,
  miniPlayer,
  intent,
  clock,
  historyLimit = WALLET_HISTORY_LIMIT,
  pollIntervalMs = POLL_INITIAL_MS,
  maxPollIntervalMs = POLL_MAX_MS,
  className,
}: WalletProps): ReactElement {
  const id = useId();
  const alive = useAlive();
  const wallet = adapter.wallet;
  const clockRef = useRef(clock ?? defaultClock);
  clockRef.current = clock ?? defaultClock;
  const now = useCallback((): number => clockRef.current(), []);

  // ---- toasts --------------------------------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((t: Omit<ToastItem, 'id'>): void => {
    toastSeq.current += 1;
    const item: ToastItem = { ...t, id: `wallet-toast-${String(toastSeq.current)}` };
    setToasts((prev) => [...prev, item]);
  }, []);
  const dismissToast = useCallback((toastId: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);

  // ---- identity ------------------------------------------------------------------------
  const [me, setMe] = useState<Me>('pending');
  const [identityError, setIdentityError] = useState<unknown>(undefined);
  const [identityGen, setIdentityGen] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setMe('pending');
    setIdentityError(undefined);
    adapter.me().then(
      (pk) => {
        if (!cancelled) setMe(pk);
      },
      (err: unknown) => {
        if (!cancelled) setIdentityError(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, identityGen]);
  const signedIn = me !== 'pending' && me !== null;

  // ---- balances (+ configured mints) ---------------------------------------------------
  const [balances, setBalances] = useState<BalancesState>({
    status: 'loading',
    map: EMPTY_MAP,
    mints: [],
    error: undefined,
  });
  const [balancesGen, setBalancesGen] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    setBalances((prev) => ({ ...prev, status: prev.status === 'ready' ? 'ready' : 'loading' }));
    Promise.all([wallet.balances(), wallet.mints()]).then(
      ([map, mints]) => {
        if (!cancelled) setBalances({ status: 'ready', map, mints, error: undefined });
      },
      (error: unknown) => {
        if (!cancelled) setBalances({ status: 'error', map: EMPTY_MAP, mints: [], error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [balancesGen, signedIn, wallet]);
  const refreshBalances = useCallback((): void => {
    setBalancesGen((g) => g + 1);
  }, []);

  // ---- settings (default mints, auto top-up) -------------------------------------------
  const [settingsStatus, setSettingsStatus] = useState<Status>('loading');
  const [settingsError, setSettingsError] = useState<unknown>(undefined);
  const [defaultMints, setDefaultMints] = useState<readonly MintUrl[]>([]);
  const [autoTopUp, setAutoTopUp] = useState<AutoTopUp | undefined>(undefined);
  const [settingsGen, setSettingsGen] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    setSettingsStatus('loading');
    adapter.settings().then(
      (s) => {
        if (cancelled) return;
        setDefaultMints(s.defaultMints);
        setAutoTopUp(s.autoTopUp);
        setSettingsStatus('ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        setSettingsError(err);
        setSettingsStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, settingsGen, signedIn]);

  // ---- signer mode (build-plan §3: tell the user which P2PK key mode they are in) --------
  const [signer, setSigner] = useState<SignerStatus | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    adapter.signer().then(
      (s) => {
        if (!cancelled) setSigner(s);
      },
      () => undefined, // informational only; the card simply omits the line
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, signedIn]);

  // ---- history (kind 7376) ------------------------------------------------------------
  const [filter, setFilter] = useState<MintUrl | 'all'>('all');
  const [history, setHistory] = useState<HistoryState>({
    status: 'loading',
    filter: 'all',
    items: [],
    error: undefined,
  });
  const [historyGen, setHistoryGen] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    // A refresh keeps the list on screen; a new filter shows skeletons.
    setHistory((prev) =>
      prev.status === 'ready' && prev.filter === filter
        ? prev
        : { status: 'loading', filter, items: [], error: undefined },
    );
    wallet
      .history(filter === 'all' ? { limit: historyLimit } : { limit: historyLimit, mint: filter })
      .then(
        (items) => {
          if (!cancelled) setHistory({ status: 'ready', filter, items, error: undefined });
        },
        (error: unknown) => {
          if (!cancelled) setHistory({ status: 'error', filter, items: [], error });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [filter, historyGen, historyLimit, signedIn, wallet]);
  const refreshHistory = useCallback((): void => {
    setHistoryGen((g) => g + 1);
  }, []);

  // ---- live updates (the same events feed the shell's header chip) ----------------------
  const filterRef = useRef(filter);
  filterRef.current = filter;
  useEffect(() => {
    if (!signedIn) return;
    const off = wallet.onChange((e) => {
      if (!alive.current) return;
      if (e.type === 'balance') {
        setBalances((prev) => {
          if (prev.status !== 'ready') return prev;
          const map = new Map(prev.map);
          map.set(e.mint, e.balance);
          return { ...prev, map };
        });
      } else if (e.type === 'history') {
        const f = filterRef.current;
        if (f !== 'all' && f !== e.entry.mint) return;
        setHistory((prev) =>
          prev.status !== 'ready' || prev.items.some((i) => i.id === e.entry.id)
            ? prev
            : { ...prev, items: [e.entry, ...prev.items].slice(0, historyLimit) },
        );
      }
    });
    return () => {
      off();
    };
  }, [alive, historyLimit, signedIn, wallet]);

  // ---- mint reachability learnt from quotes this session --------------------------------
  const [mintStatus, setMintStatus] = useState<Readonly<Record<string, MintStatus>>>({});
  const noteMintStatus = useCallback((mint: MintUrl, status: MintStatus): void => {
    setMintStatus((prev) => (prev[mint] === status ? prev : { ...prev, [mint]: status }));
  }, []);

  // ---- derived -------------------------------------------------------------------------
  const knownMints = useMemo(
    () => uniqueMints([...balances.map.keys()], balances.mints, defaultMints),
    [balances.map, balances.mints, defaultMints],
  );
  const total = useMemo(() => {
    let sum = 0;
    for (const v of balances.map.values()) sum += v;
    return sum;
  }, [balances.map]);
  const fundedCount = useMemo(
    () => [...balances.map.values()].filter((v) => v > 0).length,
    [balances.map],
  );

  // ---- sheets ----------------------------------------------------------------------------
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });
  const sheetSeq = useRef(0);
  const openFund = useCallback((mint?: MintUrl, amount?: number, auto = false): void => {
    sheetSeq.current += 1;
    setSheet({ kind: 'fund', seq: sheetSeq.current, mint, amount, auto });
  }, []);
  const openWithdraw = useCallback((mint?: MintUrl, invoice?: string, auto = false): void => {
    sheetSeq.current += 1;
    setSheet({ kind: 'withdraw', seq: sheetSeq.current, mint, invoice, auto });
  }, []);
  const closeSheet = useCallback((): void => {
    setSheet({ kind: 'none' });
  }, []);

  const onFunded = useCallback(
    (mint: MintUrl, minted: number): void => {
      pushToast({
        tone: 'sats',
        title: `Added ${formatSats(minted)}`,
        description: `Ready to spend at ${mintHost(mint)}.`,
      });
      refreshBalances();
      refreshHistory();
    },
    [pushToast, refreshBalances, refreshHistory],
  );
  const onWithdrawSettled = useCallback(
    (mint: MintUrl, paid: boolean, amount: number): void => {
      if (paid)
        pushToast({
          tone: 'success',
          title: `Sent ${formatSats(amount)}`,
          description: `Paid from ${mintHost(mint)}.`,
        });
      refreshBalances();
      refreshHistory();
    },
    [pushToast, refreshBalances, refreshHistory],
  );
  const onCopied = useCallback(
    (ok: boolean): void => {
      pushToast(
        ok
          ? { tone: 'success', title: 'Invoice copied' }
          : {
              tone: 'info',
              title: 'Copy is not available here',
              description: 'Select the invoice text and copy it yourself.',
            },
      );
    },
    [pushToast],
  );
  const goSettings = useCallback((): void => {
    navigate({ name: 'settings' });
  }, [navigate]);

  // ---- deep link (applied once per distinct intent, after identity + balances) -----------
  const appliedIntent = useRef('');
  useEffect(() => {
    if (!intent || !signedIn || balances.status === 'loading') return;
    const key = JSON.stringify(intent);
    if (appliedIntent.current === key) return;
    appliedIntent.current = key;
    if (intent.action === 'fund') {
      const amount = intent.amount !== undefined ? parseSats(String(intent.amount)) : undefined;
      openFund(intent.mint, amount, intent.mint !== undefined && amount !== undefined);
    } else {
      openWithdraw(intent.mint, intent.invoice, intent.invoice !== undefined);
    }
  }, [balances.status, intent, openFund, openWithdraw, signedIn]);

  // ---- auto top-up (optimistic, rolled back on failure) ---------------------------------
  const saveAutoTopUp = useCallback(
    (next: AutoTopUp): void => {
      const prev = autoTopUp;
      setAutoTopUp(next); // optimistic
      adapter.updateSettings({ autoTopUp: next }).then(
        (s) => {
          if (!alive.current) return;
          setAutoTopUp(s.autoTopUp);
          pushToast(
            isAutoTopUpOn(next)
              ? {
                  tone: 'success',
                  title: 'Auto top-up on',
                  description: `Below ${formatSats(next.belowSats)}, from ${mintHost(next.fromMint)}.`,
                }
              : { tone: 'success', title: 'Auto top-up off' },
          );
        },
        (err: unknown) => {
          if (!alive.current) return;
          setAutoTopUp(prev); // rollback
          const e = describeWalletError(err);
          pushToast({
            tone: 'error',
            title: 'Could not save auto top-up',
            description: `${
              e.title === 'Relay down'
                ? 'None of your relays answered, so the change was not published.'
                : e.description
            } Your previous setting is back.`,
          });
        },
      );
    },
    [adapter, alive, autoTopUp, pushToast],
  );

  // ---- render ----------------------------------------------------------------------------
  const nowSec = now();
  const renderBalance = (): ReactElement => {
    const headingId = `${id}-balance`;
    let content: ReactElement;
    if (balances.status === 'loading') {
      content = (
        <div className="nf-wallet__balance-body" aria-hidden="true">
          <Skeleton variant="text" width={220} height={40} />
          <Skeleton variant="text" width={120} />
          <ul className="nf-wallet__mints">
            {[0, 1].map((i) => (
              <li key={i} className="nf-wallet__mint">
                <Skeleton variant="block" width={240} height={32} />
              </li>
            ))}
          </ul>
        </div>
      );
    } else if (balances.status === 'error') {
      const e = describeWalletError(balances.error);
      content = (
        <ErrorState
          compact
          title="Could not load your balance"
          description={e.description}
          detail={e.detail}
          onRetry={refreshBalances}
        />
      );
    } else {
      content = (
        <div className="nf-wallet__balance-body">
          <div className="nf-wallet__total">
            <SatsBadge
              sats={total}
              variant="neutral"
              className="nf-wallet__total-badge"
              label={`Total balance: ${formatSats(total)}`}
            />
            {knownMints.length > 0 ? (
              <span className="nf-wallet__total-sub">
                {fundedCount === 0
                  ? `Nothing at your ${knownMints.length === 1 ? 'mint' : `${String(knownMints.length)} mints`} yet`
                  : `across ${String(fundedCount)} of ${String(knownMints.length)} ${knownMints.length === 1 ? 'mint' : 'mints'}`}
              </span>
            ) : null}
          </div>
          {knownMints.length === 0 ? (
            <EmptyState
              compact
              icon="coin"
              title="No mints yet"
              description="Add a Cashu mint in Settings, then top up from any Lightning wallet."
              action="Open Settings"
              onAction={goSettings}
            />
          ) : total <= 0 ? (
            <EmptyState
              compact
              icon="wallet"
              title="Your wallet is empty"
              description="Add sats from any Lightning wallet: pick a mint, pay the invoice, and the ecash lands here — ready to pay for what you watch."
              action="Add funds"
              onAction={() => {
                openFund();
              }}
            />
          ) : null}
          {knownMints.length > 0 ? (
            <ul className="nf-wallet__mints" aria-label="Balance per mint">
              {knownMints.map((m) => {
                const b = balances.map.get(m) ?? (0 as Sats);
                const share = total > 0 ? Math.round((b / total) * 100) : 0;
                return (
                  <li key={m} className="nf-wallet__mint" data-mint={m}>
                    <MintChip mint={m} balance={b} status={mintStatus[m] ?? 'unknown'} />
                    {b > 0 ? (
                      <>
                        <span className="nf-wallet__mint-note">
                          {share >= 100
                            ? 'All of your balance'
                            : `${String(share)}% of your balance`}
                        </span>
                        <span className="nf-wallet__mint-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="bolt"
                            aria-label={`Add funds at ${mintHost(m)}`}
                            onClick={() => {
                              openFund(m);
                            }}
                          >
                            Add funds
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Withdraw from ${mintHost(m)}`}
                            onClick={() => {
                              openWithdraw(m);
                            }}
                          >
                            Withdraw
                          </Button>
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="nf-wallet__mint-note nf-wallet__mint-note--empty">
                          No balance at this mint
                        </span>
                        <span className="nf-wallet__mint-actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-label={`Top up at ${mintHost(m)}`}
                            onClick={() => {
                              openFund(m);
                            }}
                          >
                            Top up
                          </Button>
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="nf-wallet__tip">
            <Icon name="info" size={16} />
            <span>
              A mint holds the sats behind your ecash. Keep balances small and spread across mints
              you trust — you can withdraw any time.
            </span>
          </p>
        </div>
      );
    }
    return (
      <section
        className="nf-wallet__card nf-wallet__balance"
        aria-labelledby={headingId}
        aria-busy={balances.status === 'loading' || undefined}
      >
        <h2 id={headingId} className="nf-wallet__card-title">
          Balance
        </h2>
        {content}
      </section>
    );
  };

  const renderHistory = (): ReactElement => {
    const headingId = `${id}-history`;
    let content: ReactElement;
    if (history.status === 'loading') {
      content = (
        <ul className="nf-wallet__history" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="nf-wallet__tx">
              <Skeleton variant="circle" width={40} height={40} />
              <span className="nf-wallet__tx-text">
                <SkeletonLines lines={2} />
              </span>
            </li>
          ))}
        </ul>
      );
    } else if (history.status === 'error') {
      const e = describeWalletError(history.error);
      content = (
        <ErrorState
          compact
          title="Could not load your history"
          description={e.description}
          detail={e.detail}
          onRetry={refreshHistory}
        />
      );
    } else if (history.items.length === 0) {
      content = (
        <EmptyState
          compact
          icon="replay"
          title={filter === 'all' ? 'No transactions yet' : 'Nothing at this mint yet'}
          description="Top-ups, streaming payments, nutzaps and withdrawals show up here. The list is kept on your relays, encrypted to you (NIP-60)."
        />
      );
    } else {
      content = (
        <>
          <ul className="nf-wallet__history">
            {history.items.map((entry) => {
              const { icon, title } = historyLabel(entry);
              const sign = entry.direction === 'in' ? '+' : '−';
              return (
                <li key={entry.id} className="nf-wallet__tx" data-direction={entry.direction}>
                  <span
                    className={cx('nf-wallet__tx-icon', `nf-wallet__tx-icon--${entry.direction}`)}
                  >
                    <Icon name={icon} size={20} />
                  </span>
                  <span className="nf-wallet__tx-text">
                    {title !== undefined ? (
                      <span className="nf-wallet__tx-title">{title}</span>
                    ) : (
                      <Markdown
                        source={capitalize((entry.memo ?? '').trim())}
                        className="nf-wallet__tx-title nf-wallet__tx-memo"
                      />
                    )}
                    <span className="nf-wallet__tx-meta">
                      {mintHost(entry.mint)} ·{' '}
                      <time dateTime={new Date(entry.at * 1000).toISOString()}>
                        {formatRelativeTime(entry.at, nowSec)}
                      </time>
                    </span>
                  </span>
                  <SatsBadge
                    sats={entry.amount}
                    variant="neutral"
                    prefix={sign}
                    className={cx(
                      'nf-wallet__tx-amount',
                      `nf-wallet__tx-amount--${entry.direction}`,
                    )}
                    label={`${entry.direction === 'in' ? 'Received' : 'Spent'} ${formatSats(entry.amount)}`}
                  />
                </li>
              );
            })}
          </ul>
          {history.items.length >= historyLimit ? (
            <p className="nf-wallet__hint">
              Showing your latest {String(historyLimit)} transactions.
            </p>
          ) : null}
        </>
      );
    }
    return (
      <section
        className="nf-wallet__card nf-wallet__history-card"
        aria-labelledby={headingId}
        aria-busy={history.status === 'loading' || undefined}
      >
        <div className="nf-wallet__card-head">
          <h2 id={headingId} className="nf-wallet__card-title">
            History
          </h2>
          {knownMints.length > 1 ? (
            <div className="nf-wallet__filters" role="group" aria-label="Show history for">
              <Button
                size="sm"
                variant={filter === 'all' ? 'primary' : 'secondary'}
                pressed={filter === 'all'}
                onClick={() => {
                  setFilter('all');
                }}
              >
                All mints
              </Button>
              {knownMints.map((m) => (
                <MintChip key={m} mint={m} size="sm" selected={filter === m} onSelect={setFilter} />
              ))}
            </div>
          ) : null}
        </div>
        {content}
      </section>
    );
  };

  const renderKeyCard = (): ReactElement => {
    const headingId = `${id}-kept`;
    return (
      <section className="nf-wallet__card" aria-labelledby={headingId}>
        <h2 id={headingId} className="nf-wallet__card-title">
          How your wallet is kept
        </h2>
        <ul className="nf-wallet__facts">
          {signer ? (
            <li className="nf-wallet__fact" data-fact="key-mode">
              <span className="nf-wallet__fact-icon">
                <Icon name="key" size={20} />
              </span>
              <span className="nf-wallet__fact-text">
                <span className="nf-wallet__fact-title">
                  {signer.supportsSignSecret
                    ? 'Wallet key held by your signer'
                    : 'Wallet key unlocked in this app'}
                </span>
                <span className="nf-wallet__fact-desc">
                  {signer.supportsSignSecret
                    ? 'Your signer signs each ecash spend itself, so the wallet’s private key never enters this app’s memory.'
                    : 'Your signer cannot sign ecash spends directly, so the wallet key is decrypted (NIP-44) into this app’s memory while it runs. A signer with signSecret support keeps it out.'}
                </span>
              </span>
            </li>
          ) : null}
          <li className="nf-wallet__fact">
            <span className="nf-wallet__fact-icon">
              <Icon name="refresh" size={20} />
            </span>
            <span className="nf-wallet__fact-text">
              <span className="nf-wallet__fact-title">Synced through your relays</span>
              <span className="nf-wallet__fact-desc">
                Balance and history are NIP-60 events encrypted to your Nostr key, so the same
                wallet opens in the app and on the web.
              </span>
            </span>
          </li>
          {adapter.platform === 'web' ? (
            <li className="nf-wallet__fact" data-fact="platform">
              <span className="nf-wallet__fact-icon">
                <Icon name="info" size={20} />
              </span>
              <span className="nf-wallet__fact-text">
                <span className="nf-wallet__fact-title">Nothing stored in this browser</span>
                <span className="nf-wallet__fact-desc">
                  Ecash is decrypted into this tab’s memory only. A web page runs whatever code its
                  server sends, so keep what you hold here small.
                </span>
              </span>
            </li>
          ) : adapter.platform === 'desktop' ? (
            <li className="nf-wallet__fact" data-fact="platform">
              <span className="nf-wallet__fact-icon">
                <Icon name="info" size={20} />
              </span>
              <span className="nf-wallet__fact-text">
                <span className="nf-wallet__fact-title">Cached encrypted on this device</span>
                <span className="nf-wallet__fact-desc">
                  A local encrypted copy lets the app start without waiting for your relays.
                </span>
              </span>
            </li>
          ) : null}
        </ul>
      </section>
    );
  };

  const renderSignedIn = (): ReactElement => (
    <div className="nf-wallet__layout">
      <div className="nf-wallet__main">
        {renderBalance()}
        {renderHistory()}
      </div>
      <aside className="nf-wallet__side" aria-label="Wallet settings">
        <AutoTopUpCard
          status={settingsStatus}
          error={settingsError}
          value={autoTopUp}
          mints={knownMints}
          balances={balances.map}
          onSave={saveAutoTopUp}
          onRetry={() => {
            setSettingsGen((g) => g + 1);
          }}
        />
        {renderKeyCard()}
      </aside>
    </div>
  );

  const renderLoading = (): ReactElement => (
    <div className="nf-wallet__layout" aria-hidden="true">
      <div className="nf-wallet__main">
        <div className="nf-wallet__card">
          <Skeleton variant="text" width={96} />
          <Skeleton variant="text" width={220} height={40} />
          <SkeletonLines lines={3} />
        </div>
        <div className="nf-wallet__card">
          <Skeleton variant="text" width={96} />
          <SkeletonLines lines={4} />
        </div>
      </div>
      <div className="nf-wallet__side">
        <div className="nf-wallet__card">
          <Skeleton variant="text" width={120} />
          <SkeletonLines lines={4} />
        </div>
      </div>
    </div>
  );

  const renderBody = (): ReactElement => {
    if (identityError !== undefined) {
      const e = describeWalletError(identityError);
      return (
        <ErrorState
          title={e.title}
          description={e.description}
          detail={e.detail}
          onRetry={() => {
            setIdentityGen((g) => g + 1);
          }}
        />
      );
    }
    if (me === 'pending') return renderLoading();
    if (me === null) {
      return (
        <EmptyState
          preset="signer-not-detected"
          title="Sign in to use your wallet"
          description="Your wallet lives on your relays, encrypted to your Nostr key (NIP-60). Connect a signer — NIP-07 extension, NIP-46 remote signer, or a local key — to see your balance, add funds or withdraw."
          onAction={goSettings}
        />
      );
    }
    return renderSignedIn();
  };

  const busy =
    (me === 'pending' && identityError === undefined) ||
    (signedIn && balances.status === 'loading');

  return (
    <section
      className={cx('nf-wallet', className)}
      aria-labelledby={`${id}-title`}
      aria-busy={busy || undefined}
    >
      <header className="nf-wallet__head">
        <div className="nf-wallet__heading">
          <h1 id={`${id}-title`} className="nf-wallet__title">
            Wallet
          </h1>
          <p className="nf-wallet__subtitle">
            Ecash at Cashu mints you choose, paid out block by block as you watch.
          </p>
        </div>
        {signedIn ? (
          <div className="nf-wallet__actions">
            <Button
              variant="accent"
              icon="bolt"
              onClick={() => {
                openFund();
              }}
            >
              Add funds
            </Button>
            <Button
              variant="secondary"
              disabled={balances.status !== 'ready' || total <= 0}
              onClick={() => {
                openWithdraw();
              }}
            >
              Withdraw
            </Button>
          </div>
        ) : null}
      </header>
      {renderBody()}
      {signedIn && sheet.kind === 'fund' ? (
        <FundSheet
          key={sheet.seq}
          wallet={wallet}
          mints={knownMints}
          balances={balances.map}
          mintStatus={mintStatus}
          initialMint={sheet.mint}
          initialAmount={sheet.amount}
          autoRequest={sheet.auto}
          clock={now}
          pollInitialMs={pollIntervalMs}
          pollMaxMs={maxPollIntervalMs}
          onClose={closeSheet}
          onFunded={onFunded}
          onMintStatus={noteMintStatus}
          onCopied={onCopied}
          onOpenSettings={goSettings}
        />
      ) : null}
      {signedIn && sheet.kind === 'withdraw' ? (
        <WithdrawSheet
          key={sheet.seq}
          wallet={wallet}
          mints={knownMints}
          balances={balances.map}
          mintStatus={mintStatus}
          initialMint={sheet.mint}
          initialInvoice={sheet.invoice}
          autoReview={sheet.auto}
          clock={now}
          onClose={closeSheet}
          onSettled={onWithdrawSettled}
          onMintStatus={noteMintStatus}
          onAddFunds={() => {
            openFund();
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-wallet__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}

// ---- auto top-up card ------------------------------------------------------------------

interface AutoTopUpCardProps {
  readonly status: Status;
  readonly error: unknown;
  readonly value: AutoTopUp | undefined;
  readonly mints: readonly MintUrl[];
  readonly balances: ReadonlyMap<MintUrl, Sats>;
  readonly onSave: (next: AutoTopUp) => void;
  readonly onRetry: () => void;
}

/** Suggested threshold when the viewer switches auto top-up on for the first time. */
export const AUTO_TOP_UP_DEFAULT_BELOW = 500;

interface Draft {
  readonly enabled: boolean;
  readonly below: string;
  readonly from: MintUrl | undefined;
}

function richestMint(
  mints: readonly MintUrl[],
  balances: ReadonlyMap<MintUrl, Sats>,
): MintUrl | undefined {
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

function draftFrom(
  value: AutoTopUp | undefined,
  mints: readonly MintUrl[],
  balances: ReadonlyMap<MintUrl, Sats>,
): Draft {
  const on = isAutoTopUpOn(value);
  return {
    enabled: on,
    below: String(on ? value.belowSats : AUTO_TOP_UP_DEFAULT_BELOW),
    from: value?.fromMint ?? richestMint(mints, balances),
  };
}

function AutoTopUpCard({
  status,
  error,
  value,
  mints,
  balances,
  onSave,
  onRetry,
}: AutoTopUpCardProps): ReactElement {
  const id = useId();
  const headingId = `${id}-title`;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(value, mints, balances));
  const [touched, setTouched] = useState(false);
  // A saved (or rolled-back) value resets the form to it.
  const valueKey = value ? `${String(value.belowSats)}|${value.fromMint}` : '';
  const mintsKey = mints.join('|');
  useEffect(() => {
    setDraft(draftFrom(value, mints, balances));
    setTouched(false);
    // Keyed on the saved value and the mint list only: `balances` merely seeds the suggested
    // mint, and a live balance tick must not wipe an edit in progress.
  }, [valueKey, mintsKey]);

  const on = isAutoTopUpOn(value);
  const below = parseSats(draft.below);
  const invalidBelow = draft.enabled && below === undefined;
  const noFrom = draft.enabled && draft.from === undefined;
  const dirty =
    draft.enabled !== on ||
    (draft.enabled && (below !== value?.belowSats || draft.from !== value?.fromMint));
  const fromBalance = draft.from !== undefined ? (balances.get(draft.from) ?? 0) : 0;

  const save = (): void => {
    setTouched(true);
    if (draft.enabled) {
      if (below === undefined || draft.from === undefined) return;
      onSave({ belowSats: below as Sats, fromMint: draft.from });
      return;
    }
    const from = draft.from ?? value?.fromMint ?? mints[0];
    if (from === undefined) return;
    onSave({ belowSats: 0 as Sats, fromMint: from });
  };

  let content: ReactElement;
  if (status === 'loading') {
    content = (
      <div aria-hidden="true">
        <SkeletonLines lines={4} />
      </div>
    );
  } else if (status === 'error') {
    const e = describeWalletError(error);
    content = (
      <ErrorState
        compact
        title="Could not load settings"
        description={e.description}
        detail={e.detail}
        onRetry={onRetry}
      />
    );
  } else if (mints.length === 0) {
    content = (
      <p className="nf-wallet__hint">Add a mint first — auto top-up moves sats between mints.</p>
    );
  } else {
    content = (
      <form
        className="nf-wallet__form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="nf-wallet__check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => {
              const enabled = e.currentTarget.checked;
              setDraft((d) => ({ ...d, enabled }));
            }}
          />
          <span>Top up automatically</span>
        </label>
        {draft.enabled ? (
          <>
            <div className="nf-wallet__field">
              <label className="nf-wallet__label" htmlFor={`${id}-below`}>
                When a mint I pay at drops below
              </label>
              <div
                className={cx(
                  'nf-wallet__amount',
                  touched && invalidBelow && 'nf-wallet__amount--invalid',
                )}
              >
                <input
                  id={`${id}-below`}
                  className="nf-wallet__input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft.below}
                  aria-invalid={(touched && invalidBelow) || undefined}
                  onChange={(e) => {
                    const below = e.currentTarget.value;
                    setDraft((d) => ({ ...d, below }));
                  }}
                />
                <span className="nf-wallet__unit">sats</span>
              </div>
            </div>
            <fieldset className="nf-wallet__field">
              <legend className="nf-wallet__label">Move sats from</legend>
              <div className="nf-wallet__chips">
                {mints.map((m) => (
                  <MintChip
                    key={m}
                    mint={m}
                    size="sm"
                    balance={balances.get(m) ?? (0 as Sats)}
                    selected={draft.from === m}
                    onSelect={(mint) => {
                      setDraft((d) => ({ ...d, from: mint }));
                    }}
                  />
                ))}
              </div>
            </fieldset>
          </>
        ) : null}
        <p className="nf-wallet__hint">
          Each top-up is a Lightning payment from that mint to the one running low, so the sending
          mint’s Lightning fee applies. Off unless you turn it on.
        </p>
        {draft.enabled && draft.from !== undefined && fromBalance <= 0 ? (
          <p className="nf-wallet__notice nf-wallet__notice--warning">
            {mintHost(draft.from)} holds no sats, so auto top-up cannot run until you add some
            there.
          </p>
        ) : null}
        {touched && (invalidBelow || noFrom) ? (
          <p className="nf-wallet__hint nf-wallet__hint--error" role="alert">
            {invalidBelow
              ? 'Enter a whole number of sats, at least 1.'
              : 'Pick the mint to move sats from.'}
          </p>
        ) : null}
        <div className="nf-wallet__row">
          <Button type="submit" variant="primary" disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
    );
  }

  return (
    <section className="nf-wallet__card" aria-labelledby={headingId}>
      <div className="nf-wallet__card-head">
        <h2 id={headingId} className="nf-wallet__card-title">
          Auto top-up
        </h2>
        {status === 'ready' ? (
          <span
            className={cx('nf-wallet__pill', on && 'nf-wallet__pill--on')}
            data-state={on ? 'on' : 'off'}
          >
            {on ? 'On' : 'Off'}
          </span>
        ) : null}
      </div>
      {status === 'ready' && on ? (
        <p className="nf-wallet__summary-line">
          Below <SatsBadge sats={value.belowSats} variant="neutral" size="sm" />, from{' '}
          {mintHost(value.fromMint)}
        </p>
      ) : null}
      {content}
    </section>
  );
}
