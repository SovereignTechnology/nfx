/**
 * Studio — small building blocks shared by the panels. Composition of L4 components and
 * semantic HTML only; no new visual primitives.
 */
import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import type { NetworkAdapter, Sha256Hex } from '@sovit/core';
import { Button, EmptyState, ErrorState, Icon, Skeleton, cx } from '../../components/index.js';

/**
 * An image resolved through `adapter.image(url, sha256)` (SECURITY.md T16): a `Skeleton`
 * while pending, the verified URL once it resolves, a plain block if it is rejected. The raw
 * `url` never reaches an `<img>`.
 */
export function StudioImage({
  adapter,
  url,
  sha256,
  alt = '',
  className,
}: {
  readonly adapter: NetworkAdapter;
  readonly url: string | undefined;
  readonly sha256?: Sha256Hex | undefined;
  readonly alt?: string;
  readonly className?: string | undefined;
}): ReactElement {
  const [state, setState] = useState<{ readonly for: string; readonly src: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (url === undefined) return;
    let cancelled = false;
    adapter.image(url, sha256).then(
      (src) => {
        if (!cancelled) setState({ for: url, src });
      },
      () => {
        if (!cancelled) setState({ for: url, src: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, url, sha256]);
  const current = state !== null && state.for === url ? state : null;
  return (
    <span className={cx('nf-studio__img', className)}>
      {url === undefined || (current !== null && current.src === null) ? (
        <span className="nf-studio__img-none" aria-hidden="true" />
      ) : current === null ? (
        <Skeleton variant="block" className="nf-studio__img-skeleton" />
      ) : (
        <img src={current.src ?? undefined} alt={alt} decoding="async" />
      )}
    </span>
  );
}

// ---- ffmpeg not found ------------------------------------------------------------------

export type HostOs = 'macos' | 'windows' | 'linux';

/**
 * What the shell learnt from its own system-ffmpeg probe (ADR 0005: no bundled ffmpeg; L6
 * resolves it from PATH or the Settings path). Optional: without it the screen only finds
 * out when an upload fails with `ffmpeg-not-found`.
 */
export interface FfmpegStatus {
  readonly found: boolean;
  /** Where it was found, or the configured path that did not work. */
  readonly path?: string | undefined;
  readonly version?: string | undefined;
  /** Lets the screen show this system's install steps first. */
  readonly os?: HostOs | undefined;
}

const INSTALL: readonly {
  readonly os: HostOs;
  readonly name: string;
  readonly steps: readonly { readonly label: string; readonly cmd: string }[];
  readonly note?: string;
}[] = [
  {
    os: 'macos',
    name: 'macOS',
    steps: [{ label: 'With Homebrew', cmd: 'brew install ffmpeg' }],
  },
  {
    os: 'windows',
    name: 'Windows',
    steps: [{ label: 'In Terminal or PowerShell', cmd: 'winget install Gyan.FFmpeg' }],
    note: 'Restart the app afterwards so it sees the new PATH.',
  },
  {
    os: 'linux',
    name: 'Linux',
    steps: [
      { label: 'Debian, Ubuntu, Mint', cmd: 'sudo apt install ffmpeg' },
      { label: 'Fedora (with RPM Fusion enabled)', cmd: 'sudo dnf install ffmpeg' },
      { label: 'Arch', cmd: 'sudo pacman -S ffmpeg' },
    ],
    note: 'Fedora’s own ffmpeg-free package lacks the H.264 encoder Studio needs.',
  },
];

function InstallSteps({ os }: { readonly os: HostOs | undefined }): ReactElement {
  const ordered =
    os === undefined
      ? INSTALL
      : [...INSTALL.filter((i) => i.os === os), ...INSTALL.filter((i) => i.os !== os)];
  const block = (i: (typeof INSTALL)[number]): ReactElement => (
    <section key={i.os} className="nf-studio__os" data-os={i.os}>
      <h4 className="nf-studio__os-name">{i.name}</h4>
      <ul className="nf-studio__os-steps">
        {i.steps.map((s) => (
          <li key={s.cmd}>
            <span className="nf-studio__os-label">{s.label}</span>
            <code className="nf-studio__cmd">{s.cmd}</code>
          </li>
        ))}
      </ul>
      {i.note ? <p className="nf-studio__os-note">{i.note}</p> : null}
    </section>
  );
  const [first, ...rest] = ordered;
  return (
    <div className="nf-studio__install">
      {os === undefined || first === undefined ? (
        <div className="nf-studio__os-grid">{ordered.map(block)}</div>
      ) : (
        <>
          {block(first)}
          <details className="nf-studio__os-more">
            <summary>Other systems</summary>
            <div className="nf-studio__os-grid">{rest.map(block)}</div>
          </details>
        </>
      )}
      <p className="nf-studio__os-note">
        Studio needs both <code>ffmpeg</code> and <code>ffprobe</code>; each package above installs
        both.
      </p>
    </div>
  );
}

/**
 * The "ffmpeg not found" state (ADR 0005). `status` = the shell's pre-probe (shown before
 * the form); `error` = an upload that failed with `ffmpeg-not-found` (shown as an alert).
 */
export function FfmpegMissing({
  status,
  error,
  onSettings,
  onRecheck,
  onRetry,
}: {
  readonly status?: FfmpegStatus | undefined;
  readonly error?: string | undefined;
  readonly onSettings: () => void;
  readonly onRecheck?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
}): ReactElement {
  const description =
    'Studio makes the 1080p, 720p and 360p versions viewers stream with ffmpeg, the free video tool. It is not bundled with the app: install it once, or tell Settings where it is, and uploading works.';
  const body: ReactNode = (
    <>
      {status?.path ? (
        <p className="nf-studio__ffmpeg-path">
          Looked for it at <code>{status.path}</code>
        </p>
      ) : null}
      <InstallSteps os={status?.os} />
      <div className="nf-studio__ffmpeg-actions">
        <Button variant="primary" icon="settings" onClick={onSettings}>
          Set ffmpeg path in Settings
        </Button>
        {onRetry ? (
          <Button variant="secondary" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        ) : onRecheck ? (
          <Button variant="secondary" icon="refresh" onClick={onRecheck}>
            Check again
          </Button>
        ) : null}
      </div>
    </>
  );
  return error !== undefined ? (
    <ErrorState
      className="nf-studio__ffmpeg"
      title="ffmpeg not found"
      description={description}
      detail={error || undefined}
    >
      {body}
    </ErrorState>
  ) : (
    <EmptyState
      className="nf-studio__ffmpeg"
      icon="videoOff"
      title="ffmpeg not found"
      description={description}
    >
      {body}
    </EmptyState>
  );
}

/** Capability copy for the web shell (ADR 0005 Q8: gateway transcode is Stage 3). */
export function WebUploadNotice(): ReactElement {
  const id = useId();
  return (
    <aside className="nf-studio__notice" role="note" aria-labelledby={id}>
      <Icon name="info" size={20} className="nf-studio__notice-icon" />
      <div>
        <p id={id} className="nf-studio__notice-title">
          Your gateway stores web uploads as-is
        </p>
        <p className="nf-studio__notice-text">
          In the browser your file goes to your gateway exactly as it is: one version, no
          1080p/720p/360p ladder, so the cost to watch follows your file’s own bitrate. Upload an
          MP4 (H.264) so every viewer can play it. The desktop app transcodes before publishing.
        </p>
      </div>
    </aside>
  );
}
