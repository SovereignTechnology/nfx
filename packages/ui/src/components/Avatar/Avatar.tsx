import type { CSSProperties, ReactElement } from 'react';
import type { Profile } from '@sovit/core';
import { cx, hueFor, initials } from '../shared/format.js';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  /** Display name used for initials and the alt text. */
  readonly name?: string | undefined;
  /** Seed for the fallback colour — usually the pubkey. */
  readonly seed: string;
  /** Resolved image URL (already hash-verified by the screen via `NetworkAdapter.image`). */
  readonly src?: string | undefined;
  readonly size?: AvatarSize;
  readonly className?: string;
}

/**
 * Circular avatar. Falls back to initials on a deterministic hue derived from `seed`, so a
 * profile with no picture still looks intentional. Never fetches: the screen resolves and
 * hash-verifies `Profile.picture` first and passes the resulting URL as `src`.
 */
export function Avatar({ name, seed, src, size = 'md', className }: AvatarProps): ReactElement {
  const label = name ?? '';
  return (
    <span
      className={cx('nf-avatar', `nf-avatar--${size}`, !src && 'nf-avatar--fallback', className)}
      style={src ? undefined : ({ '--nf-avatar-hue': hueFor(seed) } as CSSProperties)}
      role="img"
      aria-label={label || 'avatar'}
    >
      {src ? (
        <img className="nf-avatar__img" src={src} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="nf-avatar__initials" aria-hidden="true">
          {initials(label)}
        </span>
      )}
    </span>
  );
}

/** Convenience: an avatar straight from a `Profile` plus its resolved picture URL. */
export function ProfileAvatar({
  profile,
  src,
  size,
  className,
}: {
  readonly profile: Pick<Profile, 'pubkey' | 'displayName' | 'name'>;
  readonly src?: string | undefined;
  readonly size?: AvatarSize;
  readonly className?: string;
}): ReactElement {
  return (
    <Avatar
      name={profile.displayName ?? profile.name}
      seed={profile.pubkey}
      src={src}
      {...(size ? { size } : {})}
      {...(className ? { className } : {})}
    />
  );
}
