import type { ReactElement } from 'react';
import type { NostrPubkey, Profile, Sats } from '@sovit/core';
import { ProfileAvatar } from '../Avatar/Avatar.js';
import { Button } from '../Button/Button.js';
import { SatsBadge } from '../SatsBadge/SatsBadge.js';
import { Skeleton } from '../Skeleton/Skeleton.js';
import { Icon } from '../shared/Icon.js';
import { cx, formatInteger, shortPubkey } from '../shared/format.js';

export interface ChannelRowProps {
  readonly profile: Profile;
  /** Resolved, hash-verified avatar URL. */
  readonly avatarSrc?: string | undefined;
  readonly subscribed: boolean;
  /** Subscriber count when known (follow-set aggregate). */
  readonly subscribers?: number | undefined;
  /** "N sats to creator" — from `VideoStats.satsToCreator` on the watch page. */
  readonly satsToCreator?: Sats | undefined;
  /** "Seeding N videos" when the channel runs a seeder (kind 10019 / swarm). */
  readonly seedingVideos?: number | undefined;
  /** Subscribe/unsubscribe is in flight. */
  readonly busy?: boolean;
  readonly size?: 'md' | 'lg';
  readonly onSubscribe?: ((pubkey: NostrPubkey, next: boolean) => void) | undefined;
  readonly onOpen?: ((pubkey: NostrPubkey) => void) | undefined;
  readonly className?: string;
}

/**
 * Watch-page channel row: avatar · name (+ NIP-05 check) · subscriber line · Subscribe
 * button · "sats to creator" badge · optional "Seeding N videos". `lg` is the channel-page
 * header variant (80 px avatar).
 */
export function ChannelRow({
  profile,
  avatarSrc,
  subscribed,
  subscribers,
  satsToCreator,
  seedingVideos,
  busy = false,
  size = 'md',
  onSubscribe,
  onOpen,
  className,
}: ChannelRowProps): ReactElement {
  const name = profile.displayName ?? profile.name ?? shortPubkey(profile.pubkey);
  const verified = profile.nip05Status === 'verified';
  const subline: string[] = [];
  if (verified && profile.nip05) subline.push(profile.nip05);
  if (subscribers !== undefined)
    subline.push(`${formatInteger(subscribers)} subscriber${subscribers === 1 ? '' : 's'}`);

  return (
    <div className={cx('nf-channel', `nf-channel--${size}`, className)}>
      <button
        type="button"
        className="nf-channel__avatar"
        aria-label={name}
        onClick={() => {
          onOpen?.(profile.pubkey);
        }}
      >
        <ProfileAvatar profile={profile} src={avatarSrc} size={size === 'lg' ? 'xl' : 'lg'} />
      </button>
      <div className="nf-channel__text">
        <button
          type="button"
          className="nf-channel__name"
          onClick={() => {
            onOpen?.(profile.pubkey);
          }}
        >
          <span>{name}</span>
          {verified ? (
            <Icon name="verified" size={size === 'lg' ? 18 : 14} label="NIP-05 verified" />
          ) : null}
        </button>
        {subline.length > 0 ? <div className="nf-channel__sub">{subline.join(' · ')}</div> : null}
        {seedingVideos !== undefined && seedingVideos > 0 ? (
          <div className="nf-channel__seeding">
            <Icon name="seed" size={14} />
            <span>
              Seeding {formatInteger(seedingVideos)} video{seedingVideos === 1 ? '' : 's'}
            </span>
          </div>
        ) : null}
      </div>
      <div className="nf-channel__actions">
        {satsToCreator !== undefined ? (
          <SatsBadge sats={satsToCreator} variant="earned" suffix="to creator" />
        ) : null}
        <Button
          variant={subscribed ? 'secondary' : 'primary'}
          pressed={subscribed}
          loading={busy}
          aria-label={subscribed ? `Unsubscribe from ${name}` : `Subscribe to ${name}`}
          onClick={() => {
            onSubscribe?.(profile.pubkey, !subscribed);
          }}
        >
          {subscribed ? 'Subscribed' : 'Subscribe'}
        </Button>
      </div>
    </div>
  );
}

export function ChannelRowSkeleton({ className }: { readonly className?: string }): ReactElement {
  return (
    <div className={cx('nf-channel', 'nf-channel--md', className)} aria-busy="true">
      <span className="nf-channel__avatar">
        <Skeleton variant="circle" width={40} height={40} />
      </span>
      <div className="nf-channel__text">
        <Skeleton variant="text" width={160} height={14} />
        <Skeleton variant="text" width={100} height={12} />
      </div>
      <div className="nf-channel__actions">
        <Skeleton variant="block" width={96} height={36} />
      </div>
    </div>
  );
}
