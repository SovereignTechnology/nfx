/**
 * Settings › Account: who is signed in and with what signer (`adapter.signer()`), what that
 * signer can do for the wallet (NUT-11 `signSecret` in the signer vs. the NIP-44 fallback —
 * signer.ts says the UI MUST say which), and the signer-type choice.
 *
 * The v3 contract has no method to change signer, so the choice is read-only unless the shell
 * passes `onChangeSigner` (it owns the connect/switch flow); see
 * docs/contract-requests/L5-Settings.md.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { NetworkAdapter, Profile, SignerStatus } from '@sovit/core';
import {
  Avatar,
  EmptyState,
  ErrorState,
  Skeleton,
  cx,
  shortPubkey,
} from '../../components/index.js';
import { Note, SectionFrame } from './controls.js';
import { SIGNER_KINDS, errorMessage, signerTitle, type SignerKind } from './model.js';

export interface SignerState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly value: SignerStatus | undefined;
  readonly error: unknown;
  readonly profile: Profile | null | undefined;
  readonly avatarSrc: string | undefined;
  /** Signed in = the signer reports a pubkey. */
  readonly signedIn: boolean;
  /** Signed out = the signer answered with no pubkey (not merely loading or unreachable). */
  readonly signedOut: boolean;
  readonly refresh: () => void;
}

/** Loads `adapter.signer()`, then the viewer's profile and (hash-checked) avatar. */
export function useSigner(adapter: NetworkAdapter): SignerState {
  const [gen, setGen] = useState(0);
  const [status, setStatus] = useState<SignerState['status']>('loading');
  const [value, setValue] = useState<SignerStatus | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [avatarSrc, setAvatarSrc] = useState<string | undefined>(undefined);

  useEffect(() => {
    const ac = new AbortController();
    const cancelled = (): boolean => ac.signal.aborted;
    setStatus('loading');
    setError(undefined);
    void (async (): Promise<void> => {
      let s: SignerStatus;
      try {
        s = await adapter.signer();
      } catch (err: unknown) {
        if (!cancelled()) {
          setError(err);
          setStatus('error');
        }
        return;
      }
      if (cancelled()) return;
      setValue(s);
      setStatus('ready');
      setProfile(undefined);
      setAvatarSrc(undefined);
      if (s.pubkey === null) return;
      try {
        const p = await adapter.profile(s.pubkey);
        if (cancelled()) return;
        setProfile(p);
        if (p?.picture) {
          const src = await adapter.image(p.picture); // T16: verified before display
          if (!cancelled()) setAvatarSrc(src);
        }
      } catch {
        if (!cancelled()) setProfile((cur) => cur ?? null); // initials fallback, no error UI
      }
    })();
    return () => {
      ac.abort();
    };
  }, [adapter, gen]);

  const refresh = useCallback((): void => {
    setGen((g) => g + 1);
  }, []);

  return {
    status,
    value,
    error,
    profile,
    avatarSrc,
    signedIn: status === 'ready' && value?.pubkey != null,
    signedOut: status === 'ready' && value?.pubkey == null,
    refresh,
  };
}

export interface SignerSectionProps {
  readonly id: string;
  readonly signer: SignerState;
  /**
   * Shell-owned signer flow (connect / switch). When omitted the signer-type choice is shown
   * read-only. When it returns a promise, the screen re-reads `adapter.signer()` after it.
   */
  readonly onChangeSigner?: ((kind: SignerKind) => void | Promise<void>) | undefined;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}

export function SignerSection({
  id,
  signer,
  onChangeSigner,
  headingRef,
}: SignerSectionProps): ReactElement {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [switching, setSwitching] = useState<SignerKind | null>(null);

  const choose = (kind: SignerKind): void => {
    if (!onChangeSigner) return;
    const result = onChangeSigner(kind);
    if (result instanceof Promise) {
      setSwitching(kind);
      result.then(
        () => {
          if (!alive.current) return;
          setSwitching(null);
          signer.refresh();
        },
        () => {
          if (alive.current) setSwitching(null);
        },
      );
    }
  };

  const s = signer.value;
  const name = signer.profile?.displayName ?? signer.profile?.name;

  const renderIdentity = (): ReactElement => {
    if (signer.status === 'loading') {
      return (
        <div className="nf-settings__identity" aria-hidden="true">
          <Skeleton variant="circle" width={56} height={56} />
          <span className="nf-settings__identity-text">
            <Skeleton variant="text" width="40%" />
            <Skeleton variant="text" width="60%" />
          </span>
        </div>
      );
    }
    if (signer.status === 'error') {
      return (
        <ErrorState
          compact
          className="nf-settings__state-card"
          title="Could not reach your signer"
          description="Your other settings still work. Retry, or check that your signer is running."
          detail={errorMessage(signer.error) || undefined}
          onRetry={signer.refresh}
        />
      );
    }
    if (s?.pubkey == null) {
      return (
        <EmptyState
          compact
          preset="signer-not-detected"
          className="nf-settings__state-card"
          description="Connect a Nostr signer to comment, subscribe and pay. Your other settings work without one."
          onAction={
            onChangeSigner
              ? () => {
                  choose(s?.kind ?? 'nip07');
                }
              : undefined
          }
        >
          {s?.detail ? <p className="nf-settings__mono nf-settings__muted">{s.detail}</p> : null}
        </EmptyState>
      );
    }
    const state = s.locked ? 'locked' : 'connected';
    return (
      <div className="nf-settings__identity">
        <Avatar name={name} seed={s.pubkey} src={signer.avatarSrc} size="xl" />
        <div className="nf-settings__identity-text">
          <p className="nf-settings__identity-name">{name ?? 'Unnamed profile'}</p>
          <p className="nf-settings__mono nf-settings__identity-key" title="Your public key">
            {shortPubkey(s.pubkey)}
          </p>
          <p className="nf-settings__identity-meta">
            <span className={cx('nf-settings__pill', `nf-settings__pill--${state}`)}>
              {state === 'locked' ? 'Locked' : 'Connected'}
            </span>
            <span>{signerTitle(s.kind)}</span>
          </p>
        </div>
      </div>
    );
  };

  const capabilities = (): ReactElement | null => {
    if (s?.pubkey == null || signer.status !== 'ready') return null;
    return (
      <dl className="nf-settings__facts">
        <div className="nf-settings__fact">
          <dt>Signing</dt>
          <dd>
            {s.locked
              ? 'Locked — unlock your signer to comment, subscribe and pay.'
              : 'Ready to sign comments, reactions, subscriptions and payments.'}
          </dd>
        </div>
        <div className="nf-settings__fact">
          <dt>Wallet key (NUT-11)</dt>
          <dd>
            {s.supportsSignSecret ? (
              <Note tone="success">
                Held by your signer — the wallet&apos;s spending key never enters this app.
              </Note>
            ) : (
              <Note tone="warning">
                Your signer cannot sign for the wallet, so the wallet key is decrypted into this
                app&apos;s memory (NIP-44) while you pay.
              </Note>
            )}
          </dd>
        </div>
        {s.detail ? (
          <div className="nf-settings__fact">
            <dt>Details</dt>
            <dd className="nf-settings__mono">{s.detail}</dd>
          </div>
        ) : null}
      </dl>
    );
  };

  const current = s?.pubkey != null ? s.kind : undefined;
  const choiceDisabled = !onChangeSigner || signer.status === 'loading' || switching !== null;

  return (
    <SectionFrame
      id={id}
      title="Account"
      description="The Nostr signer that proves who you are. Nutflix never sees your private key."
      busy={signer.status === 'loading' || switching !== null}
      headingRef={headingRef}
    >
      {renderIdentity()}
      {capabilities()}
      <fieldset className="nf-settings__fieldset" disabled={choiceDisabled}>
        <legend className="nf-settings__legend">Signer type</legend>
        {onChangeSigner ? null : (
          <Note id={`${id}-signer-note`}>
            Your signer is chosen when you sign in to the app. Switching it from Settings is not
            available in this version.
          </Note>
        )}
        <div className="nf-settings__choices">
          {SIGNER_KINDS.map((k) => {
            const inputId = `${id}-signer-${k.kind}`;
            return (
              <label
                key={k.kind}
                htmlFor={inputId}
                className={cx(
                  'nf-settings__choice',
                  current === k.kind && 'nf-settings__choice--selected',
                )}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-signer`}
                  value={k.kind}
                  checked={current === k.kind}
                  aria-describedby={`${inputId}-desc`}
                  onChange={() => {
                    choose(k.kind);
                  }}
                />
                <span className="nf-settings__choice-text">
                  <span className="nf-settings__choice-title">
                    {k.title} <span className="nf-settings__choice-tag">{k.nip}</span>
                    {switching === k.kind ? (
                      <span className="nf-settings__saving"> Connecting…</span>
                    ) : null}
                  </span>
                  <span id={`${inputId}-desc`} className="nf-settings__desc">
                    {k.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </SectionFrame>
  );
}
