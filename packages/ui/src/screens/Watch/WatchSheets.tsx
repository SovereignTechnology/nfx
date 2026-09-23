/**
 * Watch — the three `Sheet`s: nutzap (amount + `MintChip` mint chooser + optional public
 * note), report (NIP-56 reasons → `adapter.report`), and the keyboard-shortcut map.
 * Each sheet owns its form state and its own adapter call; the screen only opens/closes
 * them and turns outcomes into toasts.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { MintUrl, NetworkAdapter, Sats, VideoManifest } from '@sovit/core';
import {
  Button,
  EmptyState,
  KEYBOARD_MAP,
  MintChip,
  SatsBadge,
  Sheet,
  formatInteger,
} from '../../components/index.js';
import { WATCH_NUTZAP_AMOUNTS, WATCH_REPORT_REASONS } from './model.js';

function useAlive(): { readonly current: boolean } {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export interface NutzapSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly adapter: NetworkAdapter;
  readonly video: VideoManifest;
  /** Display name of the creator (copy only). */
  readonly creatorName: string;
  /** Wallet balances per mint; `undefined` = unknown (sending is still allowed). */
  readonly balances: ReadonlyMap<MintUrl, Sats> | undefined;
  readonly onSent: (amount: number, mint: MintUrl) => void;
  readonly onError: (message: string) => void;
  /** "Top up" from the no-balance state (→ Wallet). */
  readonly onTopUp: () => void;
  readonly idPrefix: string;
}

/** NIP-61 nutzap: a one-off public Cashu payment from the viewer's NIP-60 wallet. */
export function NutzapSheet({
  open,
  onClose,
  adapter,
  video,
  creatorName,
  balances,
  onSent,
  onError,
  onTopUp,
  idPrefix,
}: NutzapSheetProps): ReactElement {
  const alive = useAlive();
  const mints = video.price.mints;
  const [amount, setAmount] = useState<number>(WATCH_NUTZAP_AMOUNTS[0] ?? 21);
  const [custom, setCustom] = useState('');
  const [chosenMint, setChosenMint] = useState<MintUrl | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Default mint: the first one the wallet actually holds sats at, else the creator's first.
  const firstFunded = mints.find((m) => (balances?.get(m) ?? 0) > 0);
  const mint =
    chosenMint !== null && mints.includes(chosenMint)
      ? chosenMint
      : (firstFunded ?? mints[0] ?? null);
  const balance = mint !== null ? balances?.get(mint) : undefined;
  const insufficient = balance !== undefined && balance < amount;
  const valid = Number.isInteger(amount) && amount >= 1;

  const send = useCallback((): void => {
    if (mint === null || busy || !valid || insufficient) return;
    setBusy(true);
    const text = note.trim();
    const call =
      text === ''
        ? adapter.nutzap(video.id, amount as Sats, mint)
        : adapter.nutzap(video.id, amount as Sats, mint, text);
    call.then(
      () => {
        if (!alive.current) return;
        setBusy(false);
        setNote('');
        onSent(amount, mint);
      },
      (err: unknown) => {
        if (!alive.current) return;
        setBusy(false);
        onError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [adapter, alive, amount, busy, insufficient, mint, note, onError, onSent, valid, video.id]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Nutzap the creator"
      footer={
        <div className="nf-watch__zap-summary">
          <SatsBadge
            sats={valid ? amount : 0}
            variant="price"
            label={`Sending ${formatInteger(valid ? amount : 0)} sats`}
          />
          <Button
            variant="accent"
            icon="bolt"
            loading={busy}
            disabled={insufficient || mint === null || !valid}
            onClick={send}
          >
            Send nutzap
          </Button>
        </div>
      }
    >
      <div className="nf-watch__sheet">
        <p className="nf-watch__sheet-note">
          A nutzap is a one-off Cashu payment from your NIP-60 wallet to {creatorName} (NIP-61). It
          is public, and it goes to the creator in full — no seeder split.
        </p>
        <fieldset className="nf-watch__fieldset">
          <legend className="nf-watch__legend">Amount</legend>
          <div className="nf-watch__zap-amounts">
            {WATCH_NUTZAP_AMOUNTS.map((a) => (
              <Button
                key={a}
                variant={amount === a && custom === '' ? 'primary' : 'secondary'}
                size="sm"
                pressed={amount === a && custom === ''}
                onClick={() => {
                  setAmount(a);
                  setCustom('');
                }}
              >
                {formatInteger(a)} sats
              </Button>
            ))}
            <label className="nf-watch__zap-custom">
              <span className="nf-watch__sr">Custom amount in sats</span>
              <input
                className="nf-watch__input nf-watch__input--boxed"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                placeholder="Custom"
                value={custom}
                onChange={(e) => {
                  const v = e.target.value;
                  setCustom(v);
                  const n = Number(v);
                  if (v === '') setAmount(WATCH_NUTZAP_AMOUNTS[0] ?? 21);
                  else setAmount(Number.isFinite(n) ? Math.floor(n) : 0);
                }}
              />
            </label>
          </div>
        </fieldset>
        <fieldset className="nf-watch__fieldset">
          <legend className="nf-watch__legend">Pay from mint</legend>
          {mints.length === 0 ? (
            <p className="nf-watch__sheet-note">
              The creator did not name a mint for this video, so it cannot receive nutzaps.
            </p>
          ) : (
            <div className="nf-watch__zap-mints">
              {mints.map((m) => (
                <MintChip
                  key={m}
                  mint={m}
                  balance={balances?.get(m)}
                  selected={mint === m}
                  onSelect={(mm) => {
                    setChosenMint(mm);
                  }}
                />
              ))}
            </div>
          )}
        </fieldset>
        <label className="nf-watch__legend" htmlFor={`${idPrefix}-zap-note`}>
          Note (optional, public)
        </label>
        <textarea
          id={`${idPrefix}-zap-note`}
          className="nf-watch__input nf-watch__input--boxed"
          rows={2}
          maxLength={280}
          placeholder="Say thanks…"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
          }}
        />
        {insufficient ? (
          <EmptyState
            preset="no-balance-at-mint"
            compact
            onAction={() => {
              onClose();
              onTopUp();
            }}
          />
        ) : null}
      </div>
    </Sheet>
  );
}

export interface ReportSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly adapter: NetworkAdapter;
  readonly video: VideoManifest;
  readonly onSent: () => void;
  readonly onError: (message: string) => void;
}

/** NIP-56 report: one tap per reason; relays and gateways use it for moderation (BUD-09). */
export function ReportSheet({
  open,
  onClose,
  adapter,
  video,
  onSent,
  onError,
}: ReportSheetProps): ReactElement {
  const alive = useAlive();
  const [busy, setBusy] = useState<string | null>(null);
  const send = (reason: string): void => {
    if (busy !== null) return;
    setBusy(reason);
    adapter.report(video.id, reason).then(
      () => {
        if (!alive.current) return;
        setBusy(null);
        onSent();
      },
      (err: unknown) => {
        if (!alive.current) return;
        setBusy(null);
        onError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title="Report video">
      <div className="nf-watch__sheet">
        <p className="nf-watch__sheet-note">
          What is wrong with “{video.title}”? Reports are public NIP-56 events; relays and gateways
          use them for moderation (BUD-09).
        </p>
        <ul className="nf-watch__report-list">
          {WATCH_REPORT_REASONS.map((r) => (
            <li key={r.id}>
              <Button
                variant="secondary"
                className="nf-watch__report-reason"
                loading={busy === r.id}
                disabled={busy !== null && busy !== r.id}
                onClick={() => {
                  send(r.id);
                }}
              >
                {r.label}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

/** The player's keyboard map (build-plan §6.2), from L4's `KEYBOARD_MAP`. */
export function ShortcutsSheet({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Sheet open={open} onClose={onClose} title="Keyboard shortcuts">
      <div className="nf-watch__sheet">
        <p className="nf-watch__sheet-note">
          They work anywhere on the page while a video plays — except while you type.
        </p>
        <dl className="nf-watch__keys">
          {KEYBOARD_MAP.map((k) => (
            <div key={k.keys} className="nf-watch__keys-row">
              <dt className="nf-watch__keys-key">{k.keys}</dt>
              <dd className="nf-watch__keys-action">{k.action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Sheet>
  );
}
