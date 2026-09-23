/**
 * Per-item resolution shared by the Watch screen's pieces (related rail, playlist panel,
 * comments, peer panel): profiles once per pubkey, avatars and thumbnails through
 * `adapter.image(url, sha256)` (SECURITY.md T16 — a rejected hash simply leaves the
 * placeholder), and `adapter.stats(id)` for "N paid views". Each key is requested once for
 * the life of the screen; every answer is dropped after unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  NetworkAdapter,
  NostrEventId,
  NostrPubkey,
  Profile,
  VideoManifest,
  VideoStats,
} from '@sovit/core';

export interface Resolvers {
  /** `null` = looked up, no profile (or the lookup failed). Missing = not asked yet. */
  readonly profiles: Readonly<Record<string, Profile | null>>;
  readonly avatars: Readonly<Record<string, string>>;
  readonly thumbs: Readonly<Record<string, string>>;
  readonly stats: Readonly<Record<string, VideoStats>>;
  readonly resolveProfile: (pubkey: NostrPubkey) => void;
  readonly resolveThumb: (video: VideoManifest) => void;
  readonly resolveStats: (id: NostrEventId) => void;
}

export function useResolvers(adapter: NetworkAdapter): Resolvers {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [profiles, setProfiles] = useState<Readonly<Record<string, Profile | null>>>({});
  const [avatars, setAvatars] = useState<Readonly<Record<string, string>>>({});
  const [thumbs, setThumbs] = useState<Readonly<Record<string, string>>>({});
  const [stats, setStats] = useState<Readonly<Record<string, VideoStats>>>({});
  const requested = useRef({
    profiles: new Set<string>(),
    thumbs: new Set<string>(),
    stats: new Set<string>(),
  });

  const resolveProfile = useCallback(
    (pubkey: NostrPubkey): void => {
      const req = requested.current.profiles;
      if (req.has(pubkey)) return;
      req.add(pubkey);
      adapter.profile(pubkey).then(
        (p) => {
          if (!alive.current) return;
          setProfiles((prev) => ({ ...prev, [pubkey]: p }));
          const picture = p?.picture;
          if (picture === undefined || picture === '') return;
          adapter.image(picture).then(
            (src) => {
              if (alive.current) setAvatars((prev) => ({ ...prev, [pubkey]: src }));
            },
            () => undefined,
          );
        },
        () => {
          if (alive.current) setProfiles((prev) => ({ ...prev, [pubkey]: null }));
        },
      );
    },
    [adapter],
  );

  const resolveThumb = useCallback(
    (video: VideoManifest): void => {
      const req = requested.current.thumbs;
      if (req.has(video.id)) return;
      req.add(video.id);
      const image = video.renditions.find((r) => r.image !== undefined)?.image;
      if (image === undefined) return;
      adapter.image(image.url, image.sha256).then(
        (src) => {
          if (alive.current) setThumbs((prev) => ({ ...prev, [video.id]: src }));
        },
        () => undefined,
      );
    },
    [adapter],
  );

  const resolveStats = useCallback(
    (id: NostrEventId): void => {
      const req = requested.current.stats;
      if (req.has(id)) return;
      req.add(id);
      adapter.stats(id).then(
        (s) => {
          if (alive.current) setStats((prev) => ({ ...prev, [id]: s }));
        },
        () => undefined,
      );
    },
    [adapter],
  );

  return { profiles, avatars, thumbs, stats, resolveProfile, resolveThumb, resolveStats };
}
