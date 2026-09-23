/**
 * Settings › Mints and top-up: the default mints (add/remove with `https://`-only
 * validation, shown as `MintChip`s with the wallet's balance at each), one-tap adds from the
 * wallet's own mints, and the optional auto top-up (threshold + mint).
 */
import { useEffect, useState, type SubmitEvent, type ReactElement } from 'react';
import type { MintUrl, NetworkAdapter, Sats, Settings } from '@sovit/core';
import { Button, IconButton, MintChip, SatsBadge, mintHost } from '../../components/index.js';
import type { Route } from '../shared/route.js';
import {
  FieldError,
  Note,
  SectionFrame,
  SwitchRow,
  useAlive,
  type SectionProps,
} from './controls.js';
import {
  AUTO_TOP_UP_DEFAULT_SATS,
  autoTopUpEnabled,
  normaliseMintUrl,
  parseThresholdSats,
  validateMintUrl,
} from './model.js';

export interface WalletMints {
  readonly status: 'loading' | 'ready' | 'error';
  readonly mints: readonly MintUrl[];
  readonly balances: ReadonlyMap<MintUrl, Sats>;
}

/** The wallet's own mints and balances (read-only; used for chips and suggestions). */
export function useWalletMints(adapter: NetworkAdapter): WalletMints {
  const [state, setState] = useState<WalletMints>({
    status: 'loading',
    mints: [],
    balances: new Map(),
  });
  useEffect(() => {
    let cancelled = false;
    Promise.all([adapter.wallet.mints(), adapter.wallet.balances()]).then(
      ([mints, balances]) => {
        if (!cancelled) setState({ status: 'ready', mints, balances });
      },
      () => {
        if (!cancelled) setState({ status: 'error', mints: [], balances: new Map() });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter]);
  return state;
}

const MINTS_LABEL = 'your default mints';
const TOP_UP_LABEL = 'auto top-up';

export function WalletSection({
  id,
  view,
  saved,
  pending,
  save,
  wallet,
  signedIn,
  signedOut,
  navigate,
  headingRef,
}: SectionProps & {
  readonly id: string;
  readonly wallet: WalletMints;
  readonly signedIn: boolean;
  /** Explicitly signed out (vs. signer still loading or unreachable) — drives the note copy. */
  readonly signedOut: boolean;
  readonly navigate: (to: Route) => void;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  const alive = useAlive();
  const mints = view.defaultMints;
  const savedMints = new Set(saved.defaultMints);

  // ---- default mints --------------------------------------------------------------------
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const updateMints = (fn: (list: readonly MintUrl[]) => readonly MintUrl[]): Promise<boolean> =>
    save({
      field: 'defaultMints',
      label: MINTS_LABEL,
      patch: (base: Settings) => ({ defaultMints: fn(base.defaultMints) }),
    });
  const addMint = (url: MintUrl): Promise<boolean> =>
    updateMints((list) =>
      list.some((m) => normaliseMintUrl(m) === normaliseMintUrl(url)) ? list : [...list, url],
    );
  const removeMint = (url: MintUrl): void => {
    void updateMints((list) => list.filter((m) => m !== url));
  };

  const onSubmit = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const result = validateMintUrl(draft, mints);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const submitted = draft;
    setError(null);
    setAdding(true);
    void addMint(result.value).then((ok) => {
      if (!alive.current) return;
      setAdding(false);
      if (ok) setDraft((cur) => (cur === submitted ? '' : cur));
      else
        setError(
          'Not saved — your default mints could not be updated. Your address is kept; try again.',
        );
    });
  };

  const suggestions = wallet.mints.filter(
    (m) => !mints.some((d) => normaliseMintUrl(d) === normaliseMintUrl(m)),
  );

  // ---- auto top-up ----------------------------------------------------------------------
  const topUp = view.autoTopUp;
  const enabled = autoTopUpEnabled(topUp);
  const mintOptions = unique([...(topUp ? [topUp.fromMint] : []), ...mints, ...wallet.mints]);
  const fallbackMint = mintOptions[0];
  const [threshold, setThreshold] = useState<string | null>(null);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const canTopUp = signedIn && fallbackMint !== undefined;

  const saveTopUp = (next: (base: Settings) => Settings['autoTopUp']): Promise<boolean> =>
    save({
      field: 'autoTopUp',
      label: TOP_UP_LABEL,
      patch: (base) => {
        const v = next(base);
        return v === undefined ? {} : { autoTopUp: v };
      },
    });

  const toggleTopUp = (on: boolean): void => {
    if (fallbackMint === undefined) return;
    setThreshold(null);
    setThresholdError(null);
    void saveTopUp((base) => {
      const cur = base.autoTopUp;
      const fromMint = cur?.fromMint ?? fallbackMint;
      // "Off" is a zero threshold — `Partial<Settings>` cannot remove the optional field.
      if (!on) return cur === undefined ? undefined : { belowSats: 0 as Sats, fromMint };
      return {
        belowSats: (autoTopUpEnabled(cur) ? cur.belowSats : AUTO_TOP_UP_DEFAULT_SATS) as Sats,
        fromMint,
      };
    });
  };

  const commitThreshold = (): void => {
    if (threshold === null || !enabled) return;
    const parsed = parseThresholdSats(threshold);
    if (!parsed.ok) {
      setThresholdError(parsed.error);
      return;
    }
    if (parsed.value === topUp.belowSats && thresholdError === null) {
      setThreshold(null);
      return;
    }
    const submitted = threshold;
    setThresholdError(null);
    void saveTopUp((base) => ({
      belowSats: parsed.value as Sats,
      fromMint: base.autoTopUp?.fromMint ?? topUp.fromMint,
    })).then((ok) => {
      if (!alive.current) return;
      if (ok) setThreshold((cur) => (cur === submitted ? null : cur));
      else
        setThresholdError(
          'Not saved — the threshold was not changed. Your amount is kept; try again.',
        );
    });
  };

  const chooseMint = (fromMint: MintUrl): void => {
    void saveTopUp((base) => ({
      belowSats: (base.autoTopUp?.belowSats ?? AUTO_TOP_UP_DEFAULT_SATS) as Sats,
      fromMint,
    }));
  };

  const addId = `${id}-add`;
  const thresholdId = `${id}-threshold`;
  const mintSelectId = `${id}-topup-mint`;

  return (
    <SectionFrame
      id={id}
      title="Mints and top-up"
      description="Cashu mints hold the ecash you pay with. Your defaults are pre-selected when you publish a video and suggested when you tip."
      busy={pending.has('defaultMints') || pending.has('autoTopUp')}
      headingRef={headingRef}
    >
      <div className="nf-settings__group">
        <h3 className="nf-settings__group-title">Default mints</h3>
        {mints.length === 0 ? (
          <Note tone="warning">
            No default mint yet — add one below so you can publish and tip.
          </Note>
        ) : (
          <ul className="nf-settings__mints" aria-label="Default mints">
            {mints.map((m) => {
              const unsaved = !savedMints.has(m);
              const last = mints.length <= 1;
              return (
                <li key={m} className="nf-settings__mint">
                  <MintChip mint={m} balance={wallet.balances.get(m)} />
                  {unsaved ? <span className="nf-settings__saving">Saving…</span> : null}
                  <IconButton
                    icon="close"
                    size="sm"
                    label={`Remove ${mintHost(m)}`}
                    disabled={last}
                    title={last ? 'Keep at least one default mint' : `Remove ${mintHost(m)}`}
                    onClick={() => {
                      removeMint(m);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}

        <form className="nf-settings__add" onSubmit={onSubmit} noValidate>
          <label htmlFor={addId} className="nf-settings__label">
            Add a mint
          </label>
          <div className="nf-settings__add-line">
            <input
              id={addId}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="nf-settings__input nf-settings__mono"
              placeholder="https://mint.example"
              value={draft}
              aria-invalid={error !== null || undefined}
              aria-describedby={error !== null ? `${addId}-error` : `${addId}-hint`}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
                if (error !== null) setError(null);
              }}
            />
            <Button type="submit" variant="secondary" loading={adding}>
              Add
            </Button>
          </div>
          {error !== null ? (
            <FieldError id={`${addId}-error`}>{error}</FieldError>
          ) : (
            <p id={`${addId}-hint`} className="nf-settings__desc">
              https:// mints only. Only add mints you trust with your sats.
            </p>
          )}
        </form>

        {suggestions.length > 0 ? (
          <div className="nf-settings__suggest" role="group" aria-labelledby={`${id}-suggest`}>
            <p id={`${id}-suggest`} className="nf-settings__label">
              Add from your wallet
            </p>
            <div className="nf-settings__chips">
              {suggestions.map((m) => (
                <MintChip
                  key={m}
                  mint={m}
                  balance={wallet.balances.get(m)}
                  selected={false}
                  onSelect={(mint) => {
                    void addMint(mint);
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="nf-settings__group">
        <h3 className="nf-settings__group-title">Auto top-up</h3>
        <SwitchRow
          id={`${id}-topup`}
          label="Top up automatically"
          description="Keeps playback from stalling: when your balance at the chosen mint drops below the threshold, the wallet starts a top-up."
          checked={enabled}
          disabled={!canTopUp && !enabled}
          busy={pending.has('autoTopUp')}
          onChange={toggleTopUp}
        />
        {signedOut ? (
          <Note>Connect a signer to use your wallet.</Note>
        ) : !signedIn ? (
          <Note>Available once your signer is reachable — see Account above.</Note>
        ) : fallbackMint === undefined ? (
          <Note>Add a default mint first.</Note>
        ) : null}
        {enabled ? (
          <>
            <div className="nf-settings__fields">
              <div className="nf-settings__field">
                <label htmlFor={thresholdId} className="nf-settings__label">
                  Top up below
                </label>
                <div className="nf-settings__input-unit">
                  <input
                    id={thresholdId}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    className="nf-settings__input nf-settings__input--number"
                    value={threshold ?? String(topUp.belowSats)}
                    aria-invalid={thresholdError !== null || undefined}
                    aria-describedby={thresholdError !== null ? `${thresholdId}-error` : undefined}
                    onChange={(e) => {
                      setThreshold(e.currentTarget.value);
                    }}
                    onBlur={commitThreshold}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitThreshold();
                      }
                    }}
                  />
                  <span className="nf-settings__unit" aria-hidden="true">
                    sats
                  </span>
                </div>
                {thresholdError !== null ? (
                  <FieldError id={`${thresholdId}-error`}>{thresholdError}</FieldError>
                ) : null}
              </div>
              <div className="nf-settings__field">
                <label htmlFor={mintSelectId} className="nf-settings__label">
                  From mint
                </label>
                <select
                  id={mintSelectId}
                  className="nf-settings__input nf-settings__select"
                  value={topUp.fromMint}
                  onChange={(e) => {
                    const m = mintOptions.find((o) => o === e.currentTarget.value);
                    if (m !== undefined) chooseMint(m);
                  }}
                >
                  {mintOptions.map((m) => (
                    <option key={m} value={m}>
                      {mintHost(m)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="nf-settings__summary">
              Tops up when your balance at <strong>{mintHost(topUp.fromMint)}</strong> drops below{' '}
              <SatsBadge sats={topUp.belowSats} variant="neutral" size="sm" />.
            </p>
          </>
        ) : null}
      </div>

      <div className="nf-settings__links">
        <Button
          variant="ghost"
          icon="wallet"
          onClick={() => {
            navigate({ name: 'wallet' });
          }}
        >
          Balances, funding and history in Wallet
        </Button>
      </div>
    </SectionFrame>
  );
}

function unique(list: readonly MintUrl[]): readonly MintUrl[] {
  return [...new Set(list)];
}
