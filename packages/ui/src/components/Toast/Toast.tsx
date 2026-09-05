import { useEffect, type ReactElement, type ReactNode } from 'react';
import { Icon, type IconName } from '../shared/Icon.js';
import { cx } from '../shared/format.js';

export type ToastTone = 'info' | 'success' | 'error' | 'sats';

export interface ToastItem {
  readonly id: string;
  readonly tone?: ToastTone;
  readonly title: string;
  readonly description?: ReactNode;
  /** Optional single action ("Undo", "View"). */
  readonly action?: { readonly label: string; readonly onClick: () => void };
  /** Auto-dismiss after this many ms; `0` = sticky. Default 5000 (errors: sticky). */
  readonly durationMs?: number;
}

export interface ToastProps {
  readonly toast: ToastItem;
  readonly onDismiss: (id: string) => void;
}

const ICONS: Record<ToastTone, IconName> = {
  info: 'info',
  success: 'check',
  error: 'error',
  sats: 'bolt',
};

/**
 * One toast. `role="status"` (polite) for info/success/sats, `role="alert"` for errors.
 * Auto-dismiss runs on a timer here so the shell only has to keep the list.
 */
export function Toast({ toast, onDismiss }: ToastProps): ReactElement {
  const tone = toast.tone ?? 'info';
  const duration = toast.durationMs ?? (tone === 'error' ? 0 : 5000);
  useEffect(() => {
    if (duration <= 0) return;
    const t = setTimeout(() => {
      onDismiss(toast.id);
    }, duration);
    return () => {
      clearTimeout(t);
    };
  }, [duration, onDismiss, toast.id]);

  return (
    <div
      className={cx('nf-toast', `nf-toast--${tone}`)}
      role={tone === 'error' ? 'alert' : 'status'}
      data-toast-id={toast.id}
    >
      <span className="nf-toast__icon">
        <Icon name={ICONS[tone]} size={20} />
      </span>
      <div className="nf-toast__text">
        <div className="nf-toast__title">{toast.title}</div>
        {toast.description ? <div className="nf-toast__desc">{toast.description}</div> : null}
      </div>
      {toast.action ? (
        <button type="button" className="nf-toast__action" onClick={toast.action.onClick}>
          {toast.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="nf-toast__close"
        aria-label="Dismiss"
        onClick={() => {
          onDismiss(toast.id);
        }}
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}

export interface ToastStackProps {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss: (id: string) => void;
  /** Corner; YouTube uses bottom-left. */
  readonly position?: 'bottom-left' | 'bottom-right' | 'top-right';
  /** Render in flow (Storybook) instead of fixed to the viewport. */
  readonly inline?: boolean;
  readonly className?: string;
}

/** The region the shell mounts once; newest toast at the bottom. */
export function ToastStack({
  toasts,
  onDismiss,
  position = 'bottom-left',
  inline = false,
  className,
}: ToastStackProps): ReactElement {
  return (
    <div
      className={cx(
        'nf-toasts',
        `nf-toasts--${position}`,
        inline && 'nf-toasts--inline',
        className,
      )}
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
