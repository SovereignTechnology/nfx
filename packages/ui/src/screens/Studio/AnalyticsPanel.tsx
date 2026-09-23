/**
 * Studio → Analytics (build-plan §6.1 Studio "Analytics", §6.4 step 5): per-video
 * `adapter.studio.analytics(id)` — paid views, sats to you, seeders online, reactions,
 * comments, and sats by rendition as a plain bar list (L4 tokens, no chart library).
 */
import { useEffect, useId, useState, type ReactElement } from 'react';
import type { NetworkAdapter, NostrEventId, Sats, VideoManifest, VideoStats } from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  SatsBadge,
  Skeleton,
  cheapestRenditionSats,
  formatInteger,
  formatRelativeTime,
} from '../../components/index.js';
import type { Route } from '../shared/route.js';
import { describeStudioError } from './model.js';
import { StudioImage } from './parts.js';
import { openRoute, type VideosState } from './VideosPanel.js';

type Analytics = VideoStats & { readonly satsByRendition: ReadonlyMap<string, Sats> };

export interface AnalyticsPanelProps {
  readonly adapter: NetworkAdapter;
  readonly navigate: (to: Route) => void;
  readonly videos: VideosState;
  readonly selected: NostrEventId | undefined;
  readonly onSelect: (id: NostrEventId) => void;
  readonly onRetryVideos: () => void;
  readonly onUpload: () => void;
  readonly onSeeder: () => void;
  readonly now: number;
}

/** Rendition rows in the video's own order (1080p → 360p), then anything else by value. */
export function renditionRows(
  video: VideoManifest | undefined,
  byRendition: ReadonlyMap<string, Sats>,
): readonly { readonly label: string; readonly sats: number; readonly share: number }[] {
  const order = video?.renditions.map((r) => r.label) ?? [];
  const entries = [...byRendition.entries()];
  entries.sort((a, b) => {
    const ia = order.indexOf(a[0]);
    const ib = order.indexOf(b[0]);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return b[1] - a[1];
  });
  const total = entries.reduce((a, [, v]) => a + Math.max(0, v), 0);
  return entries.map(([label, v]) => ({
    label,
    sats: Math.max(0, v),
    share: total > 0 ? Math.max(0, v) / total : 0,
  }));
}

export function AnalyticsPanel({
  adapter,
  navigate,
  videos,
  selected,
  onSelect,
  onRetryVideos,
  onUpload,
  onSeeder,
  now,
}: AnalyticsPanelProps): ReactElement {
  const id = useId();
  const video = videos.items.find((v) => v.id === selected) ?? videos.items[0];
  const videoId = video?.id;
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<
    | { readonly for: NostrEventId; readonly ok: true; readonly value: Analytics }
    | { readonly for: NostrEventId; readonly ok: false; readonly error: unknown }
    | null
  >(null);

  useEffect(() => {
    if (videoId === undefined) return;
    let cancelled = false;
    adapter.studio.analytics(videoId).then(
      (value) => {
        if (!cancelled) setData({ for: videoId, ok: true, value });
      },
      (error: unknown) => {
        if (!cancelled) setData({ for: videoId, ok: false, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, videoId, reload]);

  if (videos.status === 'idle' || videos.status === 'loading') {
    return (
      <div className="nf-studio__analytics" aria-hidden="true">
        <Skeleton variant="text" width={320} />
        <ul className="nf-studio__tiles">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="nf-studio__tile">
              <Skeleton variant="text" width="50%" />
              <Skeleton variant="text" width="70%" />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (videos.status === 'error') {
    const e = describeStudioError(videos.error, 'load');
    return (
      <ErrorState
        title={e.title}
        description={e.description}
        detail={e.detail}
        onRetry={onRetryVideos}
      />
    );
  }
  if (video === undefined) {
    return (
      <EmptyState
        preset="no-videos"
        title="Upload your first video"
        description="Once a video is published, its paid views, earnings by rendition and seeders show up here."
        action="Upload a video"
        onAction={onUpload}
      />
    );
  }

  const current = data !== null && data.for === video.id ? data : null;
  const image = video.renditions[0]?.image;
  const price = cheapestRenditionSats(video.renditions, video.price);
  const stats = current?.ok ? current.value : undefined;
  const rows = stats ? renditionRows(video, stats.satsByRendition) : [];
  const maxSats = rows.reduce((a, r) => Math.max(a, r.sats), 0);

  return (
    <div className="nf-studio__analytics" aria-busy={current === null || undefined}>
      <div className="nf-studio__picker">
        <label htmlFor={`${id}-video`} className="nf-studio__label">
          Video
        </label>
        <select
          id={`${id}-video`}
          className="nf-studio__input nf-studio__select"
          value={video.id}
          onChange={(e) => {
            onSelect(e.currentTarget.value as NostrEventId);
          }}
        >
          {videos.items.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </select>
      </div>

      <div className="nf-studio__video-head">
        <StudioImage
          adapter={adapter}
          url={image?.url}
          sha256={image?.sha256}
          className="nf-studio__head-thumb"
        />
        <div className="nf-studio__video-text">
          <h2 className="nf-studio__card-title">{video.title}</h2>
          <span className="nf-studio__muted">
            {video.kind === 22 ? 'Short' : 'Video'} · Published{' '}
            {formatRelativeTime(video.publishedAt, now)} · Seeders {video.price.split.seeder}% · You{' '}
            {video.price.split.creator}%
          </span>
          <div className="nf-studio__inline">
            {price ? (
              <SatsBadge sats={price.sats} size="sm" {...(price.from ? { prefix: 'from' } : {})} />
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                navigate(openRoute(video));
              }}
            >
              {video.kind === 22 ? 'View in Shorts' : 'View video'}
            </Button>
          </div>
        </div>
      </div>

      {current !== null && !current.ok ? (
        <ErrorState
          compact
          title={describeStudioError(current.error, 'load').title}
          description="Analytics for this video did not load."
          detail={describeStudioError(current.error, 'load').detail}
          onRetry={() => {
            setReload((r) => r + 1);
          }}
        />
      ) : (
        <>
          <ul className="nf-studio__tiles" aria-label="Totals">
            <li className="nf-studio__tile">
              <span className="nf-studio__tile-label">Paid views</span>
              {stats ? (
                <span className="nf-studio__tile-value">{formatInteger(stats.paidViews)}</span>
              ) : (
                <Skeleton variant="text" width="60%" />
              )}
              {stats ? (
                <span className="nf-studio__tile-note">
                  {stats.paidViews === 0 ? 'No paid views yet' : 'Unique viewers who paid'}
                </span>
              ) : null}
            </li>
            <li className="nf-studio__tile">
              <span className="nf-studio__tile-label">Sats to you</span>
              {stats ? (
                <SatsBadge sats={stats.satsToCreator} variant="earned" />
              ) : (
                <Skeleton variant="text" width="60%" />
              )}
            </li>
            <li className="nf-studio__tile" data-warn={stats?.seedersOnline === 0 || undefined}>
              <span className="nf-studio__tile-label">Seeders online</span>
              {stats ? (
                <span className="nf-studio__tile-value">{formatInteger(stats.seedersOnline)}</span>
              ) : (
                <Skeleton variant="text" width="40%" />
              )}
            </li>
            <li className="nf-studio__tile">
              <span className="nf-studio__tile-label">Reactions</span>
              {stats ? (
                <span className="nf-studio__tile-value">{formatInteger(stats.reactions)}</span>
              ) : (
                <Skeleton variant="text" width="40%" />
              )}
            </li>
            <li className="nf-studio__tile">
              <span className="nf-studio__tile-label">Comments</span>
              {stats ? (
                <span className="nf-studio__tile-value">{formatInteger(stats.comments)}</span>
              ) : (
                <Skeleton variant="text" width="40%" />
              )}
            </li>
          </ul>

          {stats?.seedersOnline === 0 ? (
            <EmptyState
              compact
              preset="no-seeders-online"
              description="Nobody is seeding this video right now, so viewers cannot stream it. Keep seeding on for this device to keep it available."
              action="Open Seeder"
              onAction={onSeeder}
            />
          ) : null}

          <section className="nf-studio__card" aria-labelledby={`${id}-bars`}>
            <h3 id={`${id}-bars`} className="nf-studio__card-title">
              Sats by rendition
            </h3>
            {stats === undefined ? (
              <Skeleton variant="block" height={96} />
            ) : maxSats === 0 ? (
              <p className="nf-studio__muted">
                No sats yet. Earnings per rendition appear after the first paid view.
              </p>
            ) : (
              <ul className="nf-studio__bars">
                {rows.map((r) => (
                  <li key={r.label} className="nf-studio__bars-row">
                    <span className="nf-studio__bar-label">{r.label}</span>
                    <span className="nf-studio__bar-track" aria-hidden="true">
                      <span
                        className="nf-studio__bar-fill"
                        style={{ width: `${((r.sats / maxSats) * 100).toFixed(1)}%` }}
                      />
                    </span>
                    <SatsBadge sats={r.sats} variant="neutral" size="sm" />
                    <span className="nf-studio__bar-pct">{Math.round(r.share * 100)}%</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
