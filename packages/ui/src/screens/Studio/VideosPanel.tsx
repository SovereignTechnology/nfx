/**
 * Studio → Videos: `adapter.studio.myVideos(cursor)` as a YouTube-Studio-style content table
 * (thumbnail, title, published, price, paid views, sats to you) with paging, plus the
 * "Upload your first video" empty state. Per-row numbers come from `adapter.stats(id)`.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { NetworkAdapter, NostrEventId, VideoManifest, VideoStats } from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  SatsBadge,
  Skeleton,
  cheapestRenditionSats,
  formatDuration,
  formatInteger,
  formatRelativeTime,
} from '../../components/index.js';
import type { Route } from '../shared/route.js';
import { describeStudioError } from './model.js';
import { StudioImage } from './parts.js';

export interface VideosState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly items: readonly VideoManifest[];
  readonly next: string | undefined;
  readonly error: unknown;
  readonly more: 'idle' | 'loading' | 'error';
  readonly moreError: unknown;
}

export const EMPTY_VIDEOS: VideosState = {
  status: 'idle',
  items: [],
  next: undefined,
  error: undefined,
  more: 'idle',
  moreError: undefined,
};

export interface VideosPanelProps {
  readonly adapter: NetworkAdapter;
  readonly navigate: (to: Route) => void;
  readonly videos: VideosState;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onUpload: () => void;
  readonly onAnalytics: (id: NostrEventId) => void;
  readonly now: number;
}

export function openRoute(video: VideoManifest): Route {
  return video.kind === 22
    ? { name: 'shorts', videoId: video.id }
    : { name: 'watch', videoId: video.id };
}

export function VideosPanel({
  adapter,
  navigate,
  videos,
  onLoadMore,
  onRetry,
  onUpload,
  onAnalytics,
  now,
}: VideosPanelProps): ReactElement {
  const [stats, setStats] = useState<Readonly<Record<string, VideoStats | null>>>({});
  const requested = useRef(new Set<NostrEventId>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    for (const v of videos.items) {
      if (requested.current.has(v.id)) continue;
      requested.current.add(v.id);
      adapter.stats(v.id).then(
        (s) => {
          if (alive.current) setStats((prev) => ({ ...prev, [v.id]: s }));
        },
        () => {
          if (alive.current) setStats((prev) => ({ ...prev, [v.id]: null }));
        },
      );
    }
  }, [adapter, videos.items]);

  if (videos.status === 'idle' || videos.status === 'loading') {
    return (
      <div className="nf-studio__table-wrap" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="nf-studio__row-skeleton">
            <Skeleton variant="block" width={120} aspectRatio="16 / 9" />
            <span className="nf-studio__row-skeleton-text">
              <Skeleton variant="text" width="60%" />
              <Skeleton variant="text" width="30%" />
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (videos.status === 'error') {
    const e = describeStudioError(videos.error, 'load');
    return (
      <ErrorState title={e.title} description={e.description} detail={e.detail} onRetry={onRetry} />
    );
  }
  if (videos.items.length === 0) {
    return (
      <EmptyState
        preset="no-videos"
        title="Upload your first video"
        description="Videos you publish show up here with their price, paid views and what they have earned you."
        action="Upload a video"
        onAction={onUpload}
      />
    );
  }

  return (
    <div className="nf-studio__table-wrap">
      <table className="nf-studio__table">
        <caption className="nf-studio__sr">Your videos</caption>
        <thead>
          <tr>
            <th scope="col">Video</th>
            <th scope="col">Published</th>
            <th scope="col">Price</th>
            <th scope="col" className="nf-studio__num">
              Paid views
            </th>
            <th scope="col" className="nf-studio__num">
              Sats to you
            </th>
            <th scope="col">
              <span className="nf-studio__sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {videos.items.map((v) => {
            const image = v.renditions[0]?.image;
            const price = cheapestRenditionSats(v.renditions, v.price);
            const s = stats[v.id];
            return (
              <tr key={v.id}>
                <td>
                  <div className="nf-studio__video-cell">
                    <StudioImage
                      adapter={adapter}
                      url={image?.url}
                      sha256={image?.sha256}
                      className="nf-studio__row-thumb"
                    />
                    <div className="nf-studio__video-text">
                      <button
                        type="button"
                        className="nf-studio__link"
                        onClick={() => {
                          onAnalytics(v.id);
                        }}
                      >
                        {v.title}
                      </button>
                      <span className="nf-studio__muted">
                        {v.kind === 22 ? 'Short' : 'Video'}
                        {v.durationSec !== undefined ? ` · ${formatDuration(v.durationSec)}` : ''}
                        {v.tags.length > 0 ? ` · ${v.tags.map((t) => `#${t}`).join(' ')}` : ''}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="nf-studio__muted">{formatRelativeTime(v.publishedAt, now)}</td>
                <td>
                  {price ? (
                    <SatsBadge
                      sats={price.sats}
                      size="sm"
                      {...(price.from ? { prefix: 'from' } : {})}
                    />
                  ) : null}
                </td>
                <td className="nf-studio__num">
                  {s === undefined ? (
                    <Skeleton variant="text" width={40} />
                  ) : s === null ? (
                    '—'
                  ) : (
                    formatInteger(s.paidViews)
                  )}
                </td>
                <td className="nf-studio__num">
                  {s === undefined ? (
                    <Skeleton variant="text" width={64} />
                  ) : s === null ? (
                    '—'
                  ) : (
                    <SatsBadge sats={s.satsToCreator} variant="earned" size="sm" />
                  )}
                </td>
                <td>
                  <div className="nf-studio__row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onAnalytics(v.id);
                      }}
                      aria-label={`Analytics for ${v.title}`}
                    >
                      Analytics
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        navigate(openRoute(v));
                      }}
                      aria-label={`View ${v.title}`}
                    >
                      View
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {videos.more === 'loading' ? (
        <div className="nf-studio__row-skeleton" aria-hidden="true">
          <Skeleton variant="block" width={120} aspectRatio="16 / 9" />
          <span className="nf-studio__row-skeleton-text">
            <Skeleton variant="text" width="60%" />
          </span>
        </div>
      ) : null}
      {videos.more === 'error' ? (
        <ErrorState
          compact
          title="Could not load more"
          description={describeStudioError(videos.moreError, 'load').description}
          detail={describeStudioError(videos.moreError, 'load').detail}
          onRetry={onLoadMore}
        />
      ) : null}
      {videos.next !== undefined && videos.more === 'idle' ? (
        <div className="nf-studio__more">
          <Button variant="secondary" onClick={onLoadMore}>
            Show more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
