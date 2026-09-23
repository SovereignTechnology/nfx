/**
 * Watch — the right-hand rail: an optional playlist panel, then "Up next" (related kind-21
 * videos as list cards, each with its own price) with the Autoplay switch, then a small
 * Shorts shelf for related kind-22 items. Presentational: the screen fetches and resolves.
 * Nothing here plays, previews or prefetches media (build-plan §6.2 "do not prefetch
 * related videos") — the only bytes are hash-verified thumbnails.
 */
import type { ReactElement } from 'react';
import type { NostrEventId, NostrPubkey, VideoManifest } from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  VideoCard,
  VideoCardSkeleton,
} from '../../components/index.js';
import { describeWatchError, type WatchPlaylist } from './model.js';
import type { Resolvers } from './useResolvers.js';

export interface RelatedList {
  readonly status: 'loading' | 'ready' | 'error';
  readonly items: readonly VideoManifest[];
  readonly error: unknown;
}

export interface WatchRelatedProps {
  readonly related: RelatedList;
  readonly onRetry: () => void;
  readonly playlist: WatchPlaylist | undefined;
  readonly playlistItems: RelatedList;
  readonly currentId: NostrEventId;
  readonly resolvers: Pick<Resolvers, 'profiles' | 'avatars' | 'thumbs' | 'stats'>;
  readonly nowSec: number;
  readonly autoplay: boolean;
  readonly onToggleAutoplay: () => void;
  readonly onOpen: (video: VideoManifest) => void;
  readonly onOpenChannel: (pubkey: NostrPubkey) => void;
  readonly idPrefix: string;
}

export function WatchRelated({
  related,
  onRetry,
  playlist,
  playlistItems,
  currentId,
  resolvers,
  nowSec,
  autoplay,
  onToggleAutoplay,
  onOpen,
  onOpenChannel,
  idPrefix,
}: WatchRelatedProps): ReactElement {
  const { profiles, avatars, thumbs, stats } = resolvers;
  const card = (v: VideoManifest, layout: 'list' | 'grid'): ReactElement => (
    <VideoCard
      video={v}
      layout={layout}
      hideChannel={layout === 'grid'}
      channel={profiles[v.author] ?? undefined}
      thumbnailSrc={thumbs[v.id]}
      avatarSrc={avatars[v.author]}
      stats={stats[v.id]}
      now={nowSec}
      onOpen={onOpen}
      onOpenChannel={onOpenChannel}
    />
  );
  const longform = related.items.filter((v) => v.kind === 21);
  const shorts = related.items.filter((v) => v.kind === 22);
  const position = playlist === undefined ? -1 : playlist.videoIds.indexOf(currentId);

  return (
    <aside
      className="nf-watch__related"
      aria-labelledby={`${idPrefix}-related`}
      aria-busy={related.status === 'loading' || undefined}
    >
      {playlist !== undefined ? (
        <section className="nf-watch__playlist" aria-labelledby={`${idPrefix}-playlist`}>
          <header className="nf-watch__playlist-head">
            <h2 id={`${idPrefix}-playlist`} className="nf-watch__playlist-title">
              {playlist.title}
            </h2>
            <span className="nf-watch__playlist-pos">
              {position >= 0 ? `${String(position + 1)} / ` : ''}
              {playlist.videoIds.length}
            </span>
          </header>
          {playlistItems.status === 'loading' ? (
            <ul className="nf-watch__list nf-watch__playlist-list" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="nf-watch__item">
                  <VideoCardSkeleton layout="list" />
                </li>
              ))}
            </ul>
          ) : playlistItems.items.length === 0 ? (
            <p className="nf-watch__muted">This playlist has no playable videos.</p>
          ) : (
            <ol className="nf-watch__list nf-watch__playlist-list">
              {playlistItems.items.map((v) => (
                <li
                  key={v.id}
                  className="nf-watch__item nf-watch__playlist-item"
                  aria-current={v.id === currentId ? 'true' : undefined}
                >
                  {card(v, 'list')}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}

      <div className="nf-watch__related-head">
        <h2 id={`${idPrefix}-related`} className="nf-watch__related-title">
          Up next
        </h2>
        <Button
          variant={autoplay ? 'primary' : 'secondary'}
          size="sm"
          pressed={autoplay}
          onClick={onToggleAutoplay}
          title="Play the next video automatically — its price is shown before it starts"
        >
          Autoplay {autoplay ? 'on' : 'off'}
        </Button>
      </div>

      {related.status === 'loading' ? (
        <ul className="nf-watch__list" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <li key={i} className="nf-watch__item">
              <VideoCardSkeleton layout="list" />
            </li>
          ))}
        </ul>
      ) : related.status === 'error' ? (
        <ErrorState
          compact
          title="Could not load related videos"
          description={describeWatchError(related.error).description}
          detail={describeWatchError(related.error).detail}
          onRetry={onRetry}
        />
      ) : related.items.length === 0 ? (
        <EmptyState
          icon="videoOff"
          compact
          title="Nothing related yet"
          description="When similar videos are published they show up here."
        />
      ) : (
        <>
          {longform.length > 0 ? (
            <ul className="nf-watch__list nf-watch__related-list">
              {longform.map((v) => (
                <li key={v.id} className="nf-watch__item">
                  {card(v, 'list')}
                </li>
              ))}
            </ul>
          ) : null}
          {shorts.length > 0 ? (
            <section className="nf-watch__shorts" aria-labelledby={`${idPrefix}-shorts`}>
              <h3 id={`${idPrefix}-shorts`} className="nf-watch__shorts-title">
                Shorts
              </h3>
              <ul className="nf-watch__shorts-list">
                {shorts.slice(0, 3).map((v) => (
                  <li key={v.id} className="nf-watch__short">
                    {card(v, 'grid')}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </aside>
  );
}
