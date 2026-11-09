/**
 * Endpoints from seeders' beacons, as plain data: no network, no WASM. The beacons reach
 * here already verified (NFX-03, by nfx-proto in WASM: ./resolve.ts); what they name is
 * still untrusted. A beacon names where to fetch, never what is right: every byte is
 * checked against the signed anchor whatever its source.
 */
import type { Endpoints, Signaling } from './api';
import { MAX_TRACKERS, trackerUrl } from './mesh';

/** Most distinct origins reported. */
export const MAX_ORIGINS = 8;
/** Most seeders held at once; a beacon from one more is ignored until one expires. */
export const MAX_SEEDERS = 64;
/** Most origins, and most trackers, taken from one beacon. */
const PER_BEACON = 4;
/** Most STUN servers one session takes. */
export const MAX_ICE_SERVERS = 4;
const STUN_URL = /^stuns?:(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * A beacon-named origin as a plain `https://host[:port][/prefix]` base, or null. Beacons
 * are untrusted and the player appends `/<root>/…` to this, so a query string, fragment or
 * credentials (which would steer requests to attacker-chosen URLs) are refused.
 */
export function originBase(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/**
 * An origin a page chose (not a beacon): as `originBase`, but `http:` is allowed too, for
 * a hint the operator gives on a loopback or test setup.
 */
export function pageOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!(u.protocol === 'https:' || u.protocol === 'http:')) return null;
  if (u.search || u.hash || u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

/**
 * A beacon-named tracker: `trackerUrl()`'s rules, and `wss:` only. The `ws:`-on-loopback
 * exception is for a page's own configuration (tests); a beacon from anywhere must not
 * point viewers at their own machine.
 */
export function beaconTracker(raw: string): string | null {
  const t = trackerUrl(raw);
  return t !== null && t.startsWith('wss://') ? t : null;
}

/** A beacon as nfx-wasm's `verifyBeacon` returns it (the fields used here). */
export interface VerifiedBeacon {
  seeder: string;
  created_at: number;
  expiration: number;
  a: string;
  content: { endpoints?: unknown };
}

interface Entry {
  created_at: number;
  expiration: number;
  origins: string[];
  trackers: string[];
}

/**
 * The newest unexpired beacon of each seeder, and what they name together. An older or
 * equal beacon from a seeder already held changes nothing (a relay replaying an old one,
 * or the same one from a second relay), and a seeder's newer beacon replaces what it said
 * before, so a seeder can withdraw an endpoint.
 */
export class EndpointBook {
  readonly #seeders = new Map<string, Entry>();

  /** Take `b` in at time `now` (unix seconds). True if it changed what the book holds. */
  add(b: VerifiedBeacon, now: number): boolean {
    if (typeof b.seeder !== 'string' || !Number.isSafeInteger(b.created_at) || !Number.isSafeInteger(b.expiration)) {
      return false;
    }
    if (b.expiration <= now) return false;
    const held = this.#seeders.get(b.seeder);
    if (held && held.created_at >= b.created_at) return false;
    if (!held && this.#seeders.size >= MAX_SEEDERS) {
      this.#prune(now);
      if (this.#seeders.size >= MAX_SEEDERS) return false;
    }
    const origins: string[] = [];
    const trackers: string[] = [];
    const endpoints = Array.isArray(b.content?.endpoints) ? (b.content.endpoints as unknown[]) : [];
    for (const e of endpoints) {
      if (e === null || typeof e !== 'object') continue;
      const { t, url, tracker_urls: urls } = e as { t?: unknown; url?: unknown; tracker_urls?: unknown };
      if (t === 'https' && typeof url === 'string') {
        const o = originBase(url);
        if (o !== null && !origins.includes(o) && origins.length < PER_BEACON) origins.push(o);
      } else if (t === 'webrtc' && Array.isArray(urls)) {
        for (const raw of urls) {
          const tr = typeof raw === 'string' ? beaconTracker(raw) : null;
          if (tr !== null && !trackers.includes(tr) && trackers.length < PER_BEACON) trackers.push(tr);
        }
      }
    }
    // Map#set on a held key keeps its place: seeders stay in first-heard order.
    this.#seeders.set(b.seeder, { created_at: b.created_at, expiration: b.expiration, origins, trackers });
    return true;
  }

  /**
   * What the unexpired beacons name at `now`, each list ranked by how many seeders name
   * an entry, ties in the order first heard.
   */
  snapshot(now: number): Endpoints {
    const origins = new Map<string, number>();
    const trackers = new Map<string, number>();
    let seeders = 0;
    for (const e of this.#seeders.values()) {
      if (e.expiration <= now) continue;
      seeders += 1;
      for (const o of e.origins) origins.set(o, (origins.get(o) ?? 0) + 1);
      for (const t of e.trackers) trackers.set(t, (trackers.get(t) ?? 0) + 1);
    }
    // Array#sort is stable, so equal counts keep first-heard order.
    const ranked = (m: Map<string, number>): string[] => [...m].sort((x, y) => y[1] - x[1]).map(([u]) => u);
    return {
      origins: ranked(origins).slice(0, MAX_ORIGINS),
      trackers: ranked(trackers).slice(0, MAX_TRACKERS),
      seeders,
    };
  }

  #prune(now: number): void {
    for (const [k, e] of this.#seeders) if (e.expiration <= now) this.#seeders.delete(k);
  }
}

/** The trackers a session may use, normalised; throws on any it may not. */
export function checkTrackers(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const t = typeof raw === 'string' ? trackerUrl(raw) : null;
    if (t === null) throw new TypeError(`nfx: not a tracker URL this player may use: ${String(raw)}`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TRACKERS) throw new TypeError(`nfx: at most ${MAX_TRACKERS} trackers`);
  return out;
}

/** The signaling a session may use, normalised; null for none; throws otherwise. */
export function checkSignaling(s: Signaling | undefined): Signaling | null {
  if (s === undefined) return null;
  const kind = (s as { kind?: unknown } | null)?.kind;
  if (kind === 'trackers') {
    const urls = checkTrackers(s.urls);
    if (urls.length === 0) throw new TypeError('nfx: trackers signaling needs at least one tracker');
    return { kind, urls };
  }
  throw new TypeError(`nfx: signaling of kind ${JSON.stringify(kind)} is not in this build`);
}

/** The ICE servers a session may use: STUN only, no credentials; throws otherwise. */
export function checkIceServers(list: readonly RTCIceServer[]): RTCIceServer[] {
  if (list.length > MAX_ICE_SERVERS) throw new TypeError(`nfx: at most ${MAX_ICE_SERVERS} ICE servers`);
  return list.map((s) => {
    const urls = typeof s?.urls === 'string' ? [s.urls] : Array.isArray(s?.urls) ? [...s.urls] : [];
    if (urls.length === 0 || !urls.every((u) => typeof u === 'string' && STUN_URL.test(u))) {
      throw new TypeError(`nfx: ICE servers must be stun: or stuns: URLs: ${JSON.stringify(s?.urls)}`);
    }
    return { urls };
  });
}

/** The origins a session may try, normalised; throws on any it may not. */
export function checkOrigins(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const o = typeof raw === 'string' ? pageOrigin(raw) : null;
    if (o === null) throw new TypeError(`nfx: not an origin base: ${String(raw)}`);
    if (!out.includes(o)) out.push(o);
  }
  if (out.length === 0) throw new TypeError('nfx: no origin to try');
  if (out.length > MAX_ORIGINS + 8) throw new TypeError(`nfx: at most ${MAX_ORIGINS + 8} origins`);
  return out;
}
