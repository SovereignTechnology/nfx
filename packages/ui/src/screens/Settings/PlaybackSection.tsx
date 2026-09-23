/**
 * Settings › Playback and performance: prefetch depth ("data saver", build-plan §6.2
 * "buffer = money") and the hover-preview toggle (build-plan §6.1 Home).
 */
import { useState, type ReactElement } from 'react';
import { Button, Icon } from '../../components/index.js';
import { FieldError, SectionFrame, SwitchRow, useAlive, type SectionProps } from './controls.js';
import {
  PREFETCH_MAX_SEC,
  PREFETCH_MIN_SEC,
  PREFETCH_PRESETS,
  PREFETCH_STEP_SEC,
  clampPrefetch,
} from './model.js';

export function PlaybackSection({
  id,
  view,
  pending,
  save,
  headingRef,
}: SectionProps & {
  readonly id: string;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  const alive = useAlive();
  /** Slider position while dragging / after a failed save; `null` = show the setting. */
  const [draft, setDraft] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const shown = draft ?? view.prefetchSeconds;
  const sliderId = `${id}-prefetch`;

  const commit = (seconds: number): void => {
    if (seconds === view.prefetchSeconds && !failed) {
      setDraft(null);
      return;
    }
    setDraft(seconds);
    setFailed(false);
    void save({
      field: 'prefetchSeconds',
      label: 'how far ahead to buffer',
      patch: () => ({ prefetchSeconds: seconds }),
    }).then((ok) => {
      if (!alive.current) return;
      // Keep the user's value on screen after a failure (never lose input); clear on success.
      setDraft((cur) => (cur === seconds && ok ? null : cur));
      if (!ok) setFailed(true);
    });
  };
  const commitDraft = (): void => {
    if (draft !== null && (draft !== view.prefetchSeconds || failed)) commit(draft);
  };

  return (
    <SectionFrame
      id={id}
      title="Playback and performance"
      busy={pending.has('prefetchSeconds') || pending.has('hoverPreview')}
      headingRef={headingRef}
    >
      <fieldset className="nf-settings__fieldset">
        <legend className="nf-settings__legend">Buffer ahead (data saver)</legend>
        <div className="nf-settings__callout">
          <Icon name="bolt" size={20} className="nf-settings__callout-icon" />
          <div>
            <p className="nf-settings__callout-title">Buffer = money</p>
            <p className="nf-settings__desc">
              Nutflix pays seeders for every block it downloads, so buffering ahead spends sats
              before you watch them. A deeper buffer rides out slow peers; a shallower one spends
              less up front and wastes less if you stop early. Pausing always stops paying, and
              related videos are never prefetched.
            </p>
          </div>
        </div>
        <div className="nf-settings__presets" role="group" aria-label="Buffer presets">
          {PREFETCH_PRESETS.map((p) => (
            <Button
              key={p.seconds}
              size="sm"
              variant={shown === p.seconds ? 'primary' : 'secondary'}
              pressed={shown === p.seconds}
              onClick={() => {
                commit(p.seconds);
              }}
            >
              {`${p.label} · ${String(p.seconds)} s`}
            </Button>
          ))}
        </div>
        <div className="nf-settings__slider">
          <label htmlFor={sliderId} className="nf-settings__label">
            Seconds to buffer ahead
          </label>
          <div className="nf-settings__slider-line">
            <input
              id={sliderId}
              type="range"
              className="nf-settings__range"
              min={PREFETCH_MIN_SEC}
              max={PREFETCH_MAX_SEC}
              step={PREFETCH_STEP_SEC}
              value={clampPrefetch(shown)}
              aria-valuetext={`${String(shown)} seconds ahead`}
              aria-describedby={failed ? `${sliderId}-error` : `${sliderId}-hint`}
              onChange={(e) => {
                setDraft(Number(e.currentTarget.value));
              }}
              onPointerUp={commitDraft}
              onKeyUp={commitDraft}
              onBlur={commitDraft}
            />
            <output htmlFor={sliderId} className="nf-settings__output">
              {`${String(shown)} s`}
            </output>
          </div>
          {failed ? (
            <FieldError id={`${sliderId}-error`}>
              Not saved — still using {view.prefetchSeconds} s.{' '}
              <button type="button" className="nf-settings__link" onClick={commitDraft}>
                Retry
              </button>
            </FieldError>
          ) : (
            <p id={`${sliderId}-hint`} className="nf-settings__desc">
              {PREFETCH_MIN_SEC}–{PREFETCH_MAX_SEC} s. The default is about 30 s.
              {pending.has('prefetchSeconds') ? (
                <span className="nf-settings__saving"> Saving…</span>
              ) : null}
            </p>
          )}
        </div>
      </fieldset>

      <SwitchRow
        id={`${id}-hover`}
        label="Preview videos on hover"
        description="Hovering a thumbnail plays its first ~3 seconds. A preview downloads a few paid blocks, so each one costs a few sats."
        checked={view.hoverPreview}
        busy={pending.has('hoverPreview')}
        onChange={(on) => {
          void save({
            field: 'hoverPreview',
            label: 'hover preview',
            patch: () => ({ hoverPreview: on }),
          });
        }}
      />
    </SectionFrame>
  );
}
