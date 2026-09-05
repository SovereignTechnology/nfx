import type { CSSProperties, ReactElement } from 'react';
import { cx } from '../shared/format.js';

export interface SkeletonProps {
  /** `text` = one line at the current line-height; `block` = free size; `circle` = avatar. */
  readonly variant?: 'text' | 'block' | 'circle';
  /** CSS length; `text` defaults to 100 %, `circle` to 36 px. */
  readonly width?: string | number | undefined;
  readonly height?: string | number | undefined;
  /** Aspect ratio for `block` (e.g. `'16 / 9'`) when height is not fixed. */
  readonly aspectRatio?: string | undefined;
  readonly className?: string;
}

/**
 * Loading placeholder with a shimmer (disabled under `prefers-reduced-motion`). Hidden from
 * assistive tech: the containing region should carry `aria-busy` instead.
 */
export function Skeleton({
  variant = 'text',
  width,
  height,
  aspectRatio,
  className,
}: SkeletonProps): ReactElement {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  if (aspectRatio !== undefined) style.aspectRatio = aspectRatio;
  return (
    <span
      className={cx('nf-skeleton', `nf-skeleton--${variant}`, className)}
      style={style}
      aria-hidden="true"
    />
  );
}

/** A stack of text-line skeletons, the last one shorter (reads as a paragraph). */
export function SkeletonLines({
  lines = 3,
  className,
}: {
  readonly lines?: number;
  readonly className?: string;
}): ReactElement {
  const n = Math.max(1, Math.floor(lines));
  return (
    <span className={cx('nf-skeleton-lines', className)} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} variant="text" width={i === n - 1 && n > 1 ? '60%' : '100%'} />
      ))}
    </span>
  );
}
