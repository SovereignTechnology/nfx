/**
 * Story-only fixtures: deterministic sample data from `@sovit/core` mocks plus inline SVG
 * data-URL images so thumbnails/avatars render offline. Never imported by component source.
 */
import { mocks } from '@sovit/core';
import type { NostrPubkey, PeerSpend, Profile, Sats, VideoManifest } from '@sovit/core';

export const { VIDEOS, CHANNELS, MINTS, FIXTURE_NOW, ME, MY_PROFILE } = mocks;
export const NOW = FIXTURE_NOW;

function at<T>(list: readonly T[], i: number, what: string): T {
  const v = list[i];
  if (v === undefined) throw new Error(`fixture ${what}[${i}] missing`);
  return v;
}

export const videoAt = (i: number): VideoManifest => at(VIDEOS, i, 'VIDEOS');
export const channelAt = (i: number): mocks.FixtureChannel => at(CHANNELS, i, 'CHANNELS');
/** `durationSec` is optional on the contract; fixtures always set it. */
export const durationOf = (v: VideoManifest): number => v.durationSec ?? 0;

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** 16:9 gradient "thumbnail" keyed by title so every card looks different. */
export function thumbnail(video: VideoManifest, w = 640, h = 360): string {
  const hue = mocks.fakeHex64(video.id).charCodeAt(3) * 7;
  const hue2 = (hue + 60) % 360;
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="hsl(${hue} 55% 45%)"/><stop offset="1" stop-color="hsl(${hue2} 60% 25%)"/>` +
      `</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>` +
      `<circle cx="${w * 0.7}" cy="${h * 0.35}" r="${h * 0.22}" fill="rgba(255,255,255,0.18)"/>` +
      `<rect x="${w * 0.08}" y="${h * 0.7}" width="${w * 0.5}" height="${h * 0.06}" rx="4" fill="rgba(255,255,255,0.35)"/>` +
      `</svg>`,
  );
}

/** 4×3 blurred placeholder (what a tiny inline imeta variant would look like). */
export function placeholder(video: VideoManifest): string {
  return thumbnail(video, 16, 9);
}

export function avatar(pubkey: NostrPubkey | string): string {
  const hue = mocks.fakeHex64(`av:${pubkey}`).charCodeAt(5) * 9;
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">` +
      `<rect width="160" height="160" fill="hsl(${hue % 360} 50% 40%)"/>` +
      `<circle cx="80" cy="62" r="30" fill="rgba(255,255,255,0.85)"/>` +
      `<ellipse cx="80" cy="135" rx="52" ry="36" fill="rgba(255,255,255,0.85)"/>` +
      `</svg>`,
  );
}

export function channelFor(video: VideoManifest): Profile {
  const c = CHANNELS.find((x) => x.pubkey === video.author);
  if (!c) throw new Error('fixture channel missing');
  return c.profile;
}

/** A video with a tiny inline placeholder so the blur-up story has something to blur. */
export function withPlaceholder(video: VideoManifest): VideoManifest {
  return {
    ...video,
    renditions: video.renditions.map((r) => ({ ...r, placeholder: placeholder(video) })),
  };
}

export const sats = (n: number): Sats => n as Sats;

export const PEERS: readonly PeerSpend[] = [
  {
    pubkey: channelAt(0).pubkey,
    sats: sats(412),
    ratePerMin: sats(14),
    blocks: 206,
    latencyMs: 48,
  },
  {
    pubkey: mocks.asPubkey('seeder-2'),
    sats: sats(236),
    ratePerMin: sats(9),
    blocks: 118,
    latencyMs: 210,
  },
  { pubkey: channelAt(2).pubkey, sats: sats(91), ratePerMin: sats(4), blocks: 45, latencyMs: 640 },
  { pubkey: mocks.asPubkey('seeder-4'), sats: sats(12), ratePerMin: sats(1), blocks: 6 },
];

export const PEER_PROFILES: ReadonlyMap<NostrPubkey, Profile> = new Map(
  CHANNELS.map((c) => [c.pubkey, c.profile] as const),
);

export const PEER_AVATARS: ReadonlyMap<NostrPubkey, string> = new Map(
  CHANNELS.map((c) => [c.pubkey, avatar(c.pubkey)] as const),
);

export const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
