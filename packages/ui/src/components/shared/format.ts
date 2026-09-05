/**
 * Pure formatting helpers shared by the components. No DOM, no data fetching.
 * Locale is pinned to `en-US` so screenshots are diffable (docs/lanes/L4.md "defaults").
 */
import type { MintUrl, NostrPubkey, PricePolicy, Rendition, Sats, UnixSeconds } from '@sovit/core';

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `1240` → `1,240`. Sats are integers by contract; anything else is rounded. */
export function formatInteger(n: number): string {
  return intFormat.format(Math.round(n));
}

/** `1240` → `1,240 sats`; `1` → `1 sat`. */
export function formatSats(sats: Sats | number): string {
  const n = Math.round(sats);
  return `${formatInteger(n)} ${n === 1 ? 'sat' : 'sats'}`;
}

/** Compact form for tight chips: `1,240` → `1.2k`, `12,400` → `12k`, `1,240,000` → `1.2M`. */
export function formatSatsCompact(sats: Sats | number): string {
  const n = Math.round(sats);
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** `754` → `12:34`; `3725` → `1:02:05`. Negative or NaN → `0:00`. */
export function formatDuration(totalSec: number): string {
  const s = Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** YouTube-style relative time: "3 hours ago", "2 days ago", "1 month ago". */
export function formatRelativeTime(at: UnixSeconds | number, now: UnixSeconds | number): string {
  const diff = Math.max(0, Math.floor(now - at));
  const units: readonly [label: string, seconds: number][] = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [label, seconds] of units) {
    if (diff >= seconds) {
      const n = Math.floor(diff / seconds);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** `12` → `12 paid views`, `1` → `1 paid view`. */
export function formatPaidViews(n: number): string {
  return `${formatInteger(n)} paid ${n === 1 ? 'view' : 'views'}`;
}

/** First 8 + last 4 hex chars of a pubkey: `3f9a…c21e`. Never the whole key in UI copy. */
export function shortPubkey(pubkey: NostrPubkey | string): string {
  if (pubkey.length <= 14) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/** Host part of a mint URL for chips: `https://mint.example/path` → `mint.example`. */
export function mintHost(mint: MintUrl | string): string {
  try {
    return new URL(mint).host;
  } catch {
    return mint;
  }
}

/** Total price of one rendition in sats: blocks × satsPerBlock (integer, rounded up). */
export function renditionPriceSats(rendition: Rendition, policy: PricePolicy): Sats {
  const blockSize = policy.blockSize > 0 ? policy.blockSize : 1;
  const blocks = Math.ceil(rendition.size / blockSize);
  return (blocks * policy.satsPerBlock) as Sats;
}

/** Sats per minute of playback at this rendition (for "streaming X sats/min" copy). */
export function renditionRatePerMin(
  rendition: Rendition,
  policy: PricePolicy,
  durationSec: number | undefined,
): Sats {
  if (!durationSec || durationSec <= 0) return 0 as Sats;
  return Math.ceil((renditionPriceSats(rendition, policy) * 60) / durationSec) as Sats;
}

/** Cheapest rendition price — what a card shows before playback ("from N sats"). */
export function cheapestRenditionSats(
  renditions: readonly Rendition[],
  policy: PricePolicy,
): { readonly sats: Sats; readonly from: boolean } | undefined {
  if (renditions.length === 0) return undefined;
  const prices = renditions.map((r) => renditionPriceSats(r, policy));
  const sats = Math.min(...prices) as Sats;
  return { sats, from: prices.some((p) => p !== sats) };
}

/** Initials for an avatar fallback: "Orbital Mechanics" → "OM", "matrixops" → "M". */
export function initials(name: string | undefined, fallback = '?'): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return fallback;
  const first = words[0]?.[0] ?? '';
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + second).toUpperCase() || fallback;
}

/** Deterministic hue (0–359) from a pubkey/string for avatar fallback colours. */
export function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Joins class names, dropping falsy entries. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
