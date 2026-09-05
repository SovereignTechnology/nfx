import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { Icon, type IconName } from '../shared/Icon.js';
import { cx } from '../shared/format.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: IconName;
  /** Pressed state for toggle buttons (renders `aria-pressed`). */
  readonly pressed?: boolean;
  readonly loading?: boolean;
  readonly children?: ReactNode;
}

/**
 * Pill button in the YouTube idiom: `primary` = filled inverse (Subscribe), `secondary` =
 * grey chip, `ghost` = text only, `accent` = brand colour (money actions), `danger`.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  pressed,
  loading = false,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cx(
        'nf-button',
        `nf-button--${variant}`,
        `nf-button--${size}`,
        !children && icon && 'nf-button--icon-only',
        loading && 'nf-button--loading',
        className,
      )}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 18 : 20} /> : null}
      {children !== undefined && children !== null ? (
        <span className="nf-button__label">{children}</span>
      ) : null}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  readonly icon: IconName;
  /** Required: icon-only controls must have an accessible name. */
  readonly label: string;
  readonly size?: ButtonSize | 'lg';
  readonly pressed?: boolean;
  /** `overlay` = white-on-video (player chrome). */
  readonly tone?: 'default' | 'overlay';
}

/** Round icon-only button; `label` becomes both `aria-label` and the tooltip `title`. */
export function IconButton({
  icon,
  label,
  size = 'md',
  pressed,
  tone = 'default',
  className,
  type = 'button',
  ...rest
}: IconButtonProps): ReactElement {
  const px = size === 'sm' ? 18 : size === 'lg' ? 28 : 24;
  return (
    <button
      type={type}
      className={cx(
        'nf-icon-button',
        `nf-icon-button--${size}`,
        tone === 'overlay' && 'nf-icon-button--overlay',
        className,
      )}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
      {...rest}
    >
      <Icon name={icon} size={px} />
    </button>
  );
}
