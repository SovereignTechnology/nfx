/**
 * Settings screen (build-plan §6.1 row "Settings"): signer, relays, default mints (+ auto
 * top-up), seeding on/off + disk cap, data saver (prefetch depth, "buffer = money"), hover
 * preview and theme — one page of sections with a YouTube-style section nav on the left at
 * wide widths.
 *
 * Talks ONLY to `NetworkAdapter` (`settings` / `updateSettings`, `signer`, `seeder.*`,
 * `wallet.mints|balances`, `profile`, `image`); renders ONLY `@sovit/ui` components + semantic
 * HTML. Every control saves on its own through an optimistic, serialised queue
 * (`useSettingsStore`): the change shows at once, a failure rolls that one change back and
 * raises a `Toast` with Retry, and typed input is never cleared by a failed save.
 *
 * The theme choice is only persisted here. Applying it to the document is the shell's job:
 * it reads `settings().theme` at boot and hears every confirmed change via `onSettingsChange`.
 * This screen never touches `document` / root attributes.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { Settings as SettingsData } from '@sovit/core';
import {
  ErrorState,
  Skeleton,
  SkeletonLines,
  ToastStack,
  cx,
  type ToastItem,
} from '../../components/index.js';
import type { ScreenProps } from '../shared/route.js';
import { AppearanceSection } from './AppearanceSection.js';
import { PlaybackSection } from './PlaybackSection.js';
import { RelaysSection } from './RelaysSection.js';
import { SeedingSection, useSeederStatus } from './SeedingSection.js';
import { SignerSection, useSigner } from './SignerSection.js';
import { WalletSection, useWalletMints } from './WalletSection.js';
import { describeLoadError, type SignerKind } from './model.js';
import { useSettingsStore, type FailureNotice } from './useSettingsStore.js';

export type SettingsSectionId =
  'account' | 'appearance' | 'playback' | 'relays' | 'mints' | 'seeding';

export const SETTINGS_SECTIONS: readonly {
  readonly id: SettingsSectionId;
  readonly label: string;
}[] = [
  { id: 'account', label: 'Account' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'playback', label: 'Playback and performance' },
  { id: 'relays', label: 'Relays' },
  { id: 'mints', label: 'Mints and top-up' },
  { id: 'seeding', label: 'Seeding' },
];

export interface SettingsProps extends ScreenProps {
  /**
   * Shell-owned signer flow (connect / switch), called with the signer type the viewer
   * picked. The v3 contract has no "change signer" method, so without this prop the choice
   * is shown read-only. Return a promise to have the screen re-read `adapter.signer()`
   * once the flow finishes.
   */
  readonly onChangeSigner?: ((kind: SignerKind) => void | Promise<void>) | undefined;
  /**
   * Called with the adapter-confirmed settings after every successful save — the shell
   * applies `theme` (and hands `hoverPreview` to Home) here. Also called for saves that
   * finish after the screen unmounted.
   */
  readonly onSettingsChange?: ((settings: SettingsData) => void) | undefined;
  /**
   * Hand toasts to the shell's `ToastStack` instead of rendering one here. Recommended: a
   * save that fails after the viewer navigated away still reaches them.
   */
  readonly onToast?: ((toast: ToastItem) => void) | undefined;
  /** Render this screen's own toast stack in flow (Storybook) instead of fixed. */
  readonly inlineToasts?: boolean | undefined;
  readonly className?: string | undefined;
}

export function Settings({
  adapter,
  navigate,
  miniPlayer,
  onChangeSigner,
  onSettingsChange,
  onToast,
  inlineToasts = false,
  className,
}: SettingsProps): ReactElement {
  const uid = useId();
  const sectionId = (s: SettingsSectionId): string => `${uid}-${s}`;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- toasts --------------------------------------------------------------------------
  const [toasts, setToasts] = useState<readonly ToastItem[]>([]);
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const dismiss = useCallback((toastId: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== toastId));
  }, []);
  const pushToast = useCallback((t: ToastItem): void => {
    const shell = onToastRef.current;
    if (shell) shell(t);
    else if (alive.current) setToasts((prev) => [...prev.filter((x) => x.id !== t.id), t]);
  }, []);
  const onFailure = useCallback(
    (n: FailureNotice): void => {
      pushToast({
        id: n.id,
        tone: 'error',
        title: n.title,
        description: n.description,
        action: {
          label: 'Retry',
          onClick: () => {
            dismiss(n.id);
            n.retry();
          },
        },
      });
    },
    [dismiss, pushToast],
  );

  // ---- data ------------------------------------------------------------------------------
  const store = useSettingsStore(adapter, { onSaved: onSettingsChange, onFailure });
  const signer = useSigner(adapter);
  const seeder = useSeederStatus(adapter);
  const wallet = useWalletMints(adapter);

  // ---- section nav -------------------------------------------------------------------------
  const [active, setActive] = useState<SettingsSectionId>('account');
  const headings = useRef(new Map<SettingsSectionId, HTMLHeadingElement>());
  const headingRef = useCallback(
    (s: SettingsSectionId) =>
      (el: HTMLHeadingElement | null): void => {
        if (el) headings.current.set(s, el);
        else headings.current.delete(s);
      },
    [],
  );
  const refs = useRef<Partial<Record<SettingsSectionId, (el: HTMLHeadingElement | null) => void>>>(
    {},
  );
  const refFor = (s: SettingsSectionId): ((el: HTMLHeadingElement | null) => void) =>
    (refs.current[s] ??= headingRef(s));

  const goTo = (s: SettingsSectionId): void => {
    setActive(s);
    const el = headings.current.get(s);
    if (!el) return;
    // Optional-call: jsdom (tests) and some embedded webviews lack scrollIntoView.
    (el.scrollIntoView as ((o?: ScrollIntoViewOptions) => void) | undefined)?.call(el, {
      block: 'start',
    });
    el.focus({ preventScroll: true });
  };

  // Scroll-spy: highlight the section whose heading most recently crossed the top third.
  const ready = store.status === 'ready';
  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const s = SETTINGS_SECTIONS.find((x) => headings.current.get(x.id) === hit?.target);
        if (s) setActive(s.id);
      },
      { rootMargin: '0px 0px -66% 0px' },
    );
    for (const el of headings.current.values()) io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [ready]);

  // ---- render ----------------------------------------------------------------------------
  const saving = store.pending.size > 0;
  const statusText = saving
    ? 'Saving…'
    : store.lastOutcome === 'failed'
      ? 'Last change not saved'
      : store.lastOutcome === 'saved'
        ? 'All changes saved'
        : 'Changes save automatically';

  const renderLoadError = (): ReactElement => {
    const e = describeLoadError(store.error);
    return (
      <ErrorState
        className="nf-settings__load-error"
        title={e.title}
        description={e.description}
        detail={e.detail}
        onRetry={() => {
          store.reload();
          signer.refresh();
        }}
      />
    );
  };

  const renderBody = (): ReactElement => {
    const view = store.view;
    const saved = store.saved;
    if (store.status === 'loading' || view === undefined || saved === undefined) {
      return (
        <div className="nf-settings__loading" aria-hidden="true">
          {SETTINGS_SECTIONS.map((s) => (
            <div key={s.id} className="nf-settings__section nf-settings__section--skeleton">
              <Skeleton variant="text" width="30%" />
              <SkeletonLines lines={3} />
            </div>
          ))}
        </div>
      );
    }
    const common = { view, saved, pending: store.pending, save: store.save };
    return (
      <>
        <SignerSection
          id={sectionId('account')}
          signer={signer}
          onChangeSigner={onChangeSigner}
          headingRef={refFor('account')}
        />
        <AppearanceSection
          id={sectionId('appearance')}
          {...common}
          headingRef={refFor('appearance')}
        />
        <PlaybackSection id={sectionId('playback')} {...common} headingRef={refFor('playback')} />
        <RelaysSection
          id={sectionId('relays')}
          {...common}
          signedOut={signer.signedOut}
          headingRef={refFor('relays')}
        />
        <WalletSection
          id={sectionId('mints')}
          {...common}
          wallet={wallet}
          signedIn={signer.signedIn}
          signedOut={signer.signedOut}
          navigate={navigate}
          headingRef={refFor('mints')}
        />
        <SeedingSection
          id={sectionId('seeding')}
          {...common}
          adapter={adapter}
          seeder={seeder}
          navigate={navigate}
          headingRef={refFor('seeding')}
        />
      </>
    );
  };

  return (
    <section className={cx('nf-settings', className)} aria-labelledby={`${uid}-title`}>
      <header className="nf-settings__head">
        <h1 id={`${uid}-title`} className="nf-settings__title">
          Settings
        </h1>
        {ready ? (
          <p
            className={cx(
              'nf-settings__status',
              saving && 'nf-settings__status--saving',
              !saving && store.lastOutcome === 'failed' && 'nf-settings__status--failed',
            )}
            role="status"
          >
            {statusText}
          </p>
        ) : null}
      </header>
      {store.status === 'error' ? (
        renderLoadError()
      ) : (
        <div className="nf-settings__layout">
          <nav className="nf-settings__nav" aria-label="Settings sections">
            <ul className="nf-settings__nav-list">
              {SETTINGS_SECTIONS.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cx(
                      'nf-settings__nav-item',
                      active === s.id && 'nf-settings__nav-item--active',
                    )}
                    aria-current={active === s.id ? 'true' : undefined}
                    aria-controls={sectionId(s.id)}
                    disabled={!ready}
                    onClick={() => {
                      goTo(s.id);
                    }}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="nf-settings__body" aria-busy={!ready}>
            {renderBody()}
          </div>
        </div>
      )}
      {onToast ? null : (
        <ToastStack
          toasts={toasts}
          onDismiss={dismiss}
          inline={inlineToasts}
          className="nf-settings__toasts"
        />
      )}
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-settings__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}
