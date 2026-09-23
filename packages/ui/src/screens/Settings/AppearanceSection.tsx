/**
 * Settings › Appearance: light / dark / follow the device (ADR 0005 — "system" is the
 * default). The screen only persists the choice through `updateSettings({ theme })`; applying
 * it to the document is the shell's job (it hears the confirmed value via `onSettingsChange`).
 */
import type { ReactElement } from 'react';
import type { Settings } from '@sovit/core';
import { cx } from '../../components/index.js';
import { useResolvedTheme } from '../../tokens/index.js';
import { SectionFrame, type SectionProps } from './controls.js';

type Theme = Settings['theme'];

export const THEME_OPTIONS: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: 'system', label: 'Use device theme' },
  { value: 'dark', label: 'Dark theme' },
  { value: 'light', label: 'Light theme' },
];

export function AppearanceSection({
  id,
  view,
  pending,
  save,
  headingRef,
}: SectionProps & {
  readonly id: string;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  // Reads `prefers-color-scheme` only — never writes to the document.
  const deviceTheme = useResolvedTheme('system');
  const choose = (theme: Theme): void => {
    void save({ field: 'theme', label: 'your theme', patch: () => ({ theme }) });
  };
  return (
    <SectionFrame
      id={id}
      title="Appearance"
      description="Applies to Nutflix on this device."
      busy={pending.has('theme')}
      headingRef={headingRef}
    >
      <fieldset className="nf-settings__fieldset">
        <legend className="nf-settings__legend">Theme</legend>
        <div className="nf-settings__choices nf-settings__choices--compact">
          {THEME_OPTIONS.map((o) => {
            const inputId = `${id}-theme-${o.value}`;
            const selected = view.theme === o.value;
            return (
              <label
                key={o.value}
                htmlFor={inputId}
                className={cx('nf-settings__choice', selected && 'nf-settings__choice--selected')}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-theme`}
                  value={o.value}
                  checked={selected}
                  onChange={() => {
                    choose(o.value);
                  }}
                />
                <span className="nf-settings__choice-text">
                  <span className="nf-settings__choice-title">{o.label}</span>
                  {o.value === 'system' ? (
                    <span className="nf-settings__desc">
                      Follows your device — currently {deviceTheme}.
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
        {pending.has('theme') ? <span className="nf-settings__saving">Saving…</span> : null}
      </fieldset>
    </SectionFrame>
  );
}
