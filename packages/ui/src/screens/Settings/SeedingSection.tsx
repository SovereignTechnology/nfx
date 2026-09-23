/**
 * Settings › Seeding: on/off (`adapter.seeder.setEnabled`), the disk cap in GB (number field
 * + slider → `updateSettings({ seeding })`), and a live usage line from `seeder.status()` /
 * `seeder.onStatus`. Earnings, peers and melt-out live in Studio › Seeder.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { NetworkAdapter, SeederStatus, Settings } from '@sovit/core';
import { Button, SatsBadge, Skeleton } from '../../components/index.js';
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
  DISK_CAP_MIN_GB,
  DISK_CAP_SLIDER_MAX_GB,
  bytesToGb,
  errorMessage,
  formatBytes,
  gbFieldValue,
  gbToBytes,
  parseDiskCapGb,
} from './model.js';

export interface SeederState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly value: SeederStatus | undefined;
  readonly error: unknown;
}

/** `seeder.status()` once, then live `seeder.onStatus` updates until unmount. */
export function useSeederStatus(adapter: NetworkAdapter): SeederState {
  const [state, setState] = useState<SeederState>({
    status: 'loading',
    value: undefined,
    error: undefined,
  });
  useEffect(() => {
    let cancelled = false;
    const off = adapter.seeder.onStatus((s) => {
      if (!cancelled) setState({ status: 'ready', value: s, error: undefined });
    });
    adapter.seeder.status().then(
      (s) => {
        if (!cancelled) setState({ status: 'ready', value: s, error: undefined });
      },
      (err: unknown) => {
        if (!cancelled)
          setState((cur) =>
            cur.status === 'ready' ? cur : { status: 'error', value: undefined, error: err },
          );
      },
    );
    return () => {
      cancelled = true;
      off();
    };
  }, [adapter]);
  return state;
}

const LABEL_ENABLED = 'seeding';
const LABEL_CAP = 'the seeding disk limit';

export function SeedingSection({
  id,
  view,
  pending,
  save,
  adapter,
  seeder,
  navigate,
  headingRef,
}: SectionProps & {
  readonly id: string;
  readonly adapter: NetworkAdapter;
  readonly seeder: SeederState;
  readonly navigate: (to: Route) => void;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  const alive = useAlive();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cap = view.seeding.diskCapBytes;
  const fieldValue = draft ?? gbFieldValue(cap);
  const draftGb = Number(fieldValue);
  const sliderGb = Number.isFinite(draftGb)
    ? Math.min(DISK_CAP_SLIDER_MAX_GB, Math.max(DISK_CAP_MIN_GB, Math.round(draftGb)))
    : DISK_CAP_MIN_GB;
  const stored = seeder.value?.bytesStored;

  const toggle = (on: boolean): void => {
    void save({
      field: 'seeding',
      label: LABEL_ENABLED,
      patch: (base) => ({ seeding: { ...base.seeding, enabled: on } }),
      // The live seeder is switched through its own method; it persists the preference
      // (see docs/contract-requests/L5-Settings.md for the v4 clarification asked for).
      write: async (_patch, base): Promise<Settings> => {
        await adapter.seeder.setEnabled(on);
        return { ...base, seeding: { ...base.seeding, enabled: on } };
      },
    });
  };

  const commit = (text: string): void => {
    const parsed = parseDiskCapGb(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const bytes = gbToBytes(parsed.value);
    if (bytes === cap && error === null) {
      setDraft(null);
      return;
    }
    setError(null);
    void save({
      field: 'seeding',
      label: LABEL_CAP,
      patch: (base) => ({ seeding: { ...base.seeding, diskCapBytes: bytes } }),
    }).then((ok) => {
      if (!alive.current) return;
      if (ok) setDraft((cur) => (cur === text ? null : cur));
      else
        setError(
          `Not saved — still limited to ${formatBytes(cap)}. Your value is kept; try again.`,
        );
    });
  };

  const inputId = `${id}-cap`;
  const sliderId = `${id}-cap-slider`;
  const belowStored =
    stored !== undefined &&
    Number.isFinite(draftGb) &&
    draft !== null &&
    gbToBytes(draftGb) < stored;

  const usage = (): ReactElement => {
    if (seeder.status === 'loading') {
      return (
        <div className="nf-settings__usage" aria-hidden="true">
          <Skeleton variant="text" width="50%" />
        </div>
      );
    }
    if (seeder.status === 'error' || seeder.value === undefined) {
      return (
        <Note tone="warning">
          Seeder status is unavailable right now
          {errorMessage(seeder.error) ? ` (${errorMessage(seeder.error)})` : ''}. Your settings
          still apply.
        </Note>
      );
    }
    const s = seeder.value;
    const peers = s.peers.filter((p) => !p.banned).length;
    return (
      <div className="nf-settings__usage">
        <meter
          className="nf-settings__meter"
          min={0}
          max={Math.max(1, s.diskCapBytes)}
          value={Math.min(s.bytesStored, Math.max(1, s.diskCapBytes))}
          aria-label="Disk used by seeding"
        />
        <p className="nf-settings__usage-text">
          {formatBytes(s.bytesStored)} of {formatBytes(s.diskCapBytes)} used · {s.videos}{' '}
          {s.videos === 1 ? 'video' : 'videos'} ·{' '}
          {s.enabled ? `${String(peers)} ${peers === 1 ? 'peer' : 'peers'} connected` : 'paused'}
        </p>
        <SatsBadge sats={s.earned.total} variant="earned" size="sm" suffix="earned" />
      </div>
    );
  };

  return (
    <SectionFrame
      id={id}
      title="Seeding"
      description="Share videos from this device with other viewers and earn sats for every block they stream from you."
      busy={pending.has('seeding')}
      headingRef={headingRef}
    >
      <SwitchRow
        id={`${id}-enabled`}
        label="Seed videos"
        description="Uses your upload bandwidth and the disk space below. Turn it off at any time; nothing is deleted."
        checked={view.seeding.enabled}
        busy={pending.has('seeding')}
        onChange={toggle}
      />
      {usage()}
      <fieldset className="nf-settings__fieldset">
        <legend className="nf-settings__legend">Disk space for seeding</legend>
        <div className="nf-settings__cap">
          <div className="nf-settings__field">
            <label htmlFor={inputId} className="nf-settings__label">
              Limit
            </label>
            <div className="nf-settings__input-unit">
              <input
                id={inputId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                className="nf-settings__input nf-settings__input--number"
                value={fieldValue}
                aria-invalid={error !== null || undefined}
                aria-describedby={error !== null ? `${inputId}-error` : `${inputId}-hint`}
                onChange={(e) => {
                  setDraft(e.currentTarget.value);
                }}
                onBlur={(e) => {
                  if (draft !== null) commit(e.currentTarget.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commit(e.currentTarget.value);
                  }
                }}
              />
              <span className="nf-settings__unit" aria-hidden="true">
                GB
              </span>
            </div>
          </div>
          <div className="nf-settings__field nf-settings__field--grow">
            <label htmlFor={sliderId} className="nf-settings__label nf-settings__sr">
              Limit slider
            </label>
            <input
              id={sliderId}
              type="range"
              className="nf-settings__range"
              min={DISK_CAP_MIN_GB}
              max={DISK_CAP_SLIDER_MAX_GB}
              step={1}
              value={sliderGb}
              aria-valuetext={`${String(sliderGb)} GB`}
              onChange={(e) => {
                setDraft(e.currentTarget.value);
              }}
              onPointerUp={(e) => {
                commit(e.currentTarget.value);
              }}
              onKeyUp={(e) => {
                if (draft !== null) commit(e.currentTarget.value);
              }}
            />
            <span className="nf-settings__range-scale" aria-hidden="true">
              <span>{DISK_CAP_MIN_GB} GB</span>
              <span>{DISK_CAP_SLIDER_MAX_GB} GB</span>
            </span>
          </div>
        </div>
        {error !== null ? (
          <FieldError id={`${inputId}-error`}>{error}</FieldError>
        ) : (
          <p id={`${inputId}-hint`} className="nf-settings__desc">
            Currently {formatBytes(cap)}
            {bytesToGb(cap) > DISK_CAP_SLIDER_MAX_GB ? ' (type any size up to 10,000 GB)' : ''}.
            {pending.has('seeding') ? <span className="nf-settings__saving"> Saving…</span> : null}
          </p>
        )}
        {belowStored ? (
          <Note tone="warning">
            That is less than the {formatBytes(stored)} already stored for seeding.
          </Note>
        ) : null}
      </fieldset>
      <div className="nf-settings__links">
        <Button
          variant="ghost"
          icon="seed"
          onClick={() => {
            navigate({ name: 'studio', tab: 'seeder' });
          }}
        >
          Earnings, peers and melt-out in Studio
        </Button>
      </div>
    </SectionFrame>
  );
}
