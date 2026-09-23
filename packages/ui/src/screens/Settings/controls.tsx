/**
 * Screen-local form scaffolding for Settings: plain semantic HTML (label + native input,
 * fieldset/legend), styled by Settings.css with L4 tokens. Not new visual primitives — the
 * on/off switch is a native checkbox with `role="switch"`, the rest are ordinary inputs.
 */
import { useEffect, useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { Settings } from '@sovit/core';
import { Icon, cx } from '../../components/index.js';
import type { SaveSpec, SettingsField } from './useSettingsStore.js';

/** `ref.current` is false once the component unmounted — guards late promise callbacks. */
export function useAlive(): RefObject<boolean> {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/** What every settings section receives from the screen. */
export interface SectionProps {
  readonly view: Settings;
  readonly saved: Settings;
  readonly pending: ReadonlySet<SettingsField>;
  readonly save: (spec: SaveSpec) => Promise<boolean>;
}

export interface SectionFrameProps {
  readonly id: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly busy?: boolean | undefined;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
  readonly children: ReactNode;
}

/** One settings page section: `<section>` named by its `<h2>`. */
export function SectionFrame({
  id,
  title,
  description,
  busy,
  headingRef,
  children,
}: SectionFrameProps): ReactElement {
  return (
    <section
      id={id}
      className="nf-settings__section"
      aria-labelledby={`${id}-title`}
      aria-busy={busy === true ? true : undefined}
      data-section={id}
    >
      <header className="nf-settings__section-head">
        <h2
          id={`${id}-title`}
          className="nf-settings__section-title"
          tabIndex={-1}
          ref={headingRef}
        >
          {title}
        </h2>
        {description ? <p className="nf-settings__section-desc">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

export interface SwitchRowProps {
  readonly id: string;
  readonly label: string;
  readonly description?: ReactNode;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean | undefined;
  /** A write for this control is queued or in flight. */
  readonly busy?: boolean | undefined;
}

/** Label + description on the left, an on/off switch on the right (YouTube settings rows). */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  busy,
}: SwitchRowProps): ReactElement {
  return (
    <div className={cx('nf-settings__row', disabled && 'nf-settings__row--disabled')}>
      <div className="nf-settings__row-text">
        <label htmlFor={id} className="nf-settings__label">
          {label}
        </label>
        {description ? (
          <p id={`${id}-desc`} className="nf-settings__desc">
            {description}
          </p>
        ) : null}
      </div>
      <div className="nf-settings__row-control">
        {busy ? <span className="nf-settings__saving">Saving…</span> : null}
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="nf-settings__switch"
          checked={checked}
          disabled={disabled}
          aria-describedby={description ? `${id}-desc` : undefined}
          onChange={(e) => {
            onChange(e.currentTarget.checked);
          }}
        />
      </div>
    </div>
  );
}

/** Inline field error, tied to its input with `aria-describedby`. */
export function FieldError({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p id={id} className="nf-settings__error" role="alert">
      <Icon name="error" size={16} />
      <span>{children}</span>
    </p>
  );
}

/** Muted one-line note (hints, "signed out" notes). */
export function Note({
  children,
  tone = 'muted',
  id,
}: {
  readonly children: ReactNode;
  readonly tone?: 'muted' | 'warning' | 'success';
  readonly id?: string;
}): ReactElement {
  return (
    <p id={id} className={cx('nf-settings__note', `nf-settings__note--${tone}`)}>
      {tone === 'warning' ? <Icon name="info" size={16} /> : null}
      <span>{children}</span>
    </p>
  );
}
