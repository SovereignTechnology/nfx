import type { ReactElement, ReactNode } from 'react';
import { Button } from '../Button/Button.js';
import { Icon, type IconName } from '../shared/Icon.js';
import { cx } from '../shared/format.js';

/**
 * Designed empty/error copy (build-plan §6.3): "no balance at this mint", "no seeders
 * online", "signer not detected" — plus the other empties the screens (L5) need. Titles are
 * sentence case, descriptions say what to do next, and an optional action names the verb.
 */
export const EMPTY_STATE_PRESETS = {
  'no-balance-at-mint': {
    icon: 'wallet',
    title: 'No balance at this mint',
    description:
      'This video is priced at a mint you hold no sats at. Top up here, or pick a video priced at one of your mints.',
    action: 'Top up',
  },
  'no-seeders-online': {
    icon: 'cloudOff',
    title: 'No seeders online',
    description:
      'Nobody is sharing this video right now. It will start as soon as a seeder appears — or try a gateway.',
    action: 'Retry',
  },
  'signer-not-detected': {
    icon: 'key',
    title: 'Signer not detected',
    description:
      'Connect a Nostr signer (NIP-07 extension, NIP-46 remote signer, or a local key) to comment, subscribe and pay.',
    action: 'Connect signer',
  },
  'no-videos': {
    icon: 'videoOff',
    title: 'No videos yet',
    description: 'When this channel publishes something, it shows up here.',
  },
  'no-results': {
    icon: 'search',
    title: 'No results',
    description: 'Try different words, fewer filters, or a broader date range.',
  },
  'no-subscriptions': {
    icon: 'people',
    title: 'No subscriptions yet',
    description: 'Subscribe to a channel and its new videos will land here.',
    action: 'Explore trending',
  },
  'no-history': {
    icon: 'replay',
    title: 'Nothing watched yet',
    description:
      'Videos you watch are kept in your private history so you can pick up where you left off.',
  },
  'no-comments': {
    icon: 'info',
    title: 'No comments yet',
    description: 'Be the first to say something.',
  },
} as const satisfies Record<
  string,
  { icon: IconName; title: string; description: string; action?: string }
>;

export type EmptyStatePreset = keyof typeof EMPTY_STATE_PRESETS;

export interface EmptyStateProps {
  /** One of the designed empties. Explicit `title`/`description`/`icon` override it. */
  readonly preset?: EmptyStatePreset | undefined;
  readonly icon?: IconName | undefined;
  readonly title?: string | undefined;
  readonly description?: ReactNode | undefined;
  /** Action label; rendered as a button when `onAction` is given. */
  readonly action?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  /** Smaller vertical rhythm for inline placement (inside a panel). */
  readonly compact?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function EmptyState({
  preset,
  icon,
  title,
  description,
  action,
  onAction,
  compact = false,
  className,
  children,
}: EmptyStateProps): ReactElement {
  const p = preset ? EMPTY_STATE_PRESETS[preset] : undefined;
  const resolvedIcon: IconName = icon ?? p?.icon ?? 'info';
  const resolvedTitle = title ?? p?.title ?? '';
  const resolvedDescription = description ?? p?.description;
  const resolvedAction = action ?? (p && 'action' in p ? p.action : undefined);
  return (
    <div
      className={cx('nf-state', 'nf-state--empty', compact && 'nf-state--compact', className)}
      role="status"
      data-preset={preset}
    >
      <span className="nf-state__icon">
        <Icon name={resolvedIcon} size={compact ? 28 : 40} />
      </span>
      <h3 className="nf-state__title">{resolvedTitle}</h3>
      {resolvedDescription ? <p className="nf-state__desc">{resolvedDescription}</p> : null}
      {children}
      {resolvedAction && onAction ? (
        <div className="nf-state__actions">
          <Button variant="primary" size={compact ? 'sm' : 'md'} onClick={onAction}>
            {resolvedAction}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps {
  readonly title?: string;
  /** Human copy. Never a stack trace; the shell logs those. */
  readonly description?: ReactNode | undefined;
  /** Short machine detail shown small (e.g. "relay timed out"). */
  readonly detail?: string | undefined;
  readonly retryLabel?: string;
  readonly onRetry?: (() => void) | undefined;
  readonly compact?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Error twin of `EmptyState`: `role="alert"`, danger tint, Retry as the default action. */
export function ErrorState({
  title = 'Something went wrong',
  description = 'We could not load this. Check your connection and try again.',
  detail,
  retryLabel = 'Retry',
  onRetry,
  compact = false,
  className,
  children,
}: ErrorStateProps): ReactElement {
  return (
    <div
      className={cx('nf-state', 'nf-state--error', compact && 'nf-state--compact', className)}
      role="alert"
    >
      <span className="nf-state__icon">
        <Icon name="error" size={compact ? 28 : 40} />
      </span>
      <h3 className="nf-state__title">{title}</h3>
      {description ? <p className="nf-state__desc">{description}</p> : null}
      {detail ? <code className="nf-state__detail">{detail}</code> : null}
      {children}
      {onRetry ? (
        <div className="nf-state__actions">
          <Button variant="secondary" icon="refresh" size={compact ? 'sm' : 'md'} onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
