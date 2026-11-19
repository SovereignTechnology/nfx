/**
 * Endpoints from seeders' beacons, as plain data: no network, no WASM. The beacons reach
 * here already verified (NFX-03, by nfx-proto in WASM: ./resolve.ts); what they name is
 * still untrusted. A beacon names where to fetch, never what is right: every byte is
 * checked against the signed anchor whatever its source.
 */
import type { Endpoints, OriginSource, RenditionAvailability, Signaling, StunNamed } from './api';
import { MAX_RENDITIONS, beaconRenditionId } from './levels';
import { MAX_RELAYS, MAX_TRACKERS, relayUrl, trackerUrl } from './mesh';

/** Most distinct origins reported. */
export const MAX_ORIGINS = 8;
/** Most seeders held at once; a beacon from one more is ignored until one expires. */
export const MAX_SEEDERS = 64;
/** Most origins, and most trackers, taken from one beacon. */
const PER_BEACON = 4;
/** Most STUN servers one session takes, its own included (NFX-10 §1's abuse bound). */
export const MAX_ICE_SERVERS = 4;
/** Most STUN service announcements held at once, and from one operator key. */
export const MAX_ANNOUNCEMENTS = 256;
const ANNOUNCEMENTS_PER_KEY = 8;
/** Most entries of `Endpoints.stunNamed`. */
const MAX_STUN_NAMED = 16;
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

/** Whether an IPv4 address (as octets) is global unicast (NFX-10 §1): none of the blocks
 * that point a viewer at its own network (this network, private, shared, loopback,
 * link-local, IETF, benchmarking), that route nowhere (documentation, RFC 5737), or that are
 * not unicast (multicast, reserved, broadcast). */
function globalV4(o: number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/**
 * A STUN address named over Nostr (NFX-10 §1: canonical `ip:port`, port not 0) as an
 * `iceServers` URL, or null: global unicast only (IPv4 above; IPv6 in 2000::/3 but not the
 * documentation blocks 2001:db8::/32 and 3fff::/20, RFC 3849 and RFC 9637), so a beacon or
 * announcement from anywhere cannot point viewers at their own network, or at an address
 * that routes nowhere.
 */
export function beaconStun(addr: string): string | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(addr);
  const v6 = /^\[([0-9a-f:]+)\]:(\d{1,5})$/.exec(addr);
  const port = Number((v4 ?? v6)?.[(v4 ? 5 : 2)]);
  if (!(Number.isInteger(port) && port >= 1 && port <= 65535)) return null;
  if (v4) {
    const parts = v4.slice(1, 5);
    const octets = parts.map(Number);
    // Canonical: no leading zeros, each at most 255, and the port as written.
    if (parts.some((p, i) => String(octets[i]) !== p) || octets.some((n) => n > 255)) return null;
    if (String(port) !== v4[5] || !globalV4(octets)) return null;
    return `stun:${parts.join('.')}:${port}`;
  }
  if (v6) {
    const host = v6[1] ?? '';
    let canonical: string;
    try {
      canonical = new URL(`http://[${host}]/`).hostname;
    } catch {
      return null;
    }
    // WHATWG's serialisation is RFC 5952's, as the canonical form requires.
    if (canonical !== `[${host}]` || String(port) !== v6[2]) return null;
    const groups = host.startsWith('::') ? [] : host.split(':');
    const first = host.startsWith('::') ? 0 : parseInt(groups[0] ?? '', 16);
    if (!(Number.isInteger(first) && (first & 0xe000) === 0x2000)) return null;
    // The documentation blocks 2001:db8::/32 (RFC 3849) and 3fff::/20 (RFC 9637). The
    // canonical form writes a second group of 0x0db8 as `db8`, and an empty one is zeros.
    const second = groups[1] === undefined || groups[1] === '' ? 0 : parseInt(groups[1], 16);
    if ((first === 0x2001 && second === 0x0db8) || (first === 0x3fff && second < 0x1000)) return null;
    return `stun:[${host}]:${port}`;
  }
  return null;
}

/**
 * The STUN servers named over Nostr, ranked: `pairs` are [key, URL] in the order heard (a
 * beacon's seeder and each URL of its `stun` endpoint; an announcement's operator and its
 * server), URLs already through `beaconStun`. Each URL counts the distinct keys that name it;
 * most first, ties in the order first named.
 */
export function rankNamed(pairs: Iterable<readonly [string, string]>): StunNamed[] {
  const keys = new Map<string, Set<string>>();
  for (const [key, url] of pairs) {
    const k = keys.get(url);
    if (k) k.add(key);
    else keys.set(url, new Set([key]));
  }
  // Array#sort is stable: equal counts keep the order first named.
  return [...keys].map(([url, k]) => ({ url, keys: k.size })).sort((x, y) => y.keys - x.keys);
}

/**
 * The STUN servers a session uses (NFX-10 §1), as `stun:` URLs, at most `max`: the page's
 * own (`own`, each once) first; then the servers named over Nostr (`named`, as `rankNamed`
 * gives them) that are not its own, most-named first; a server named by one key alone only
 * when the page has none of its own and none named has two keys or more. So Nostr never makes
 * a viewer ask more than 4 STUN servers, or one at an address that is not global unicast
 * (`beaconStun` refused those).
 */
export function selectStun(own: readonly string[], named: readonly StunNamed[], max: number = MAX_ICE_SERVERS): string[] {
  const out: string[] = [];
  for (const o of own) if (out.length < max && !out.includes(o)) out.push(o);
  const ranked = named.filter((n) => !own.includes(n.url)).sort((x, y) => y.keys - x.keys);
  const loneOk = own.length === 0 && !ranked.some((n) => n.keys >= 2);
  for (const n of ranked) {
    if (out.length >= max) break;
    if ((n.keys >= 2 || loneOk) && !out.includes(n.url)) out.push(n.url);
  }
  return out;
}

/** A STUN service announcement as nfx-wasm's `verifyStunAnnouncement` returns it. */
export interface VerifiedStunAnnouncement {
  operator: string;
  addr: string;
  networks: string[];
  created_at: number;
  expiration: number;
}

/** A beacon as nfx-wasm's `verifyBeacon` returns it (the fields used here). */
export interface VerifiedBeacon {
  seeder: string;
  created_at: number;
  expiration: number;
  a: string;
  content: { endpoints?: unknown };
}

/** An origin as one beacon names it: what it serves, null for every rendition. */
interface NamedOrigin {
  url: string;
  renditions: string[] | null;
}

interface Entry {
  created_at: number;
  expiration: number;
  /** When it was first heard, in the book's order (beacons and announcements together). */
  heard: number;
  origins: NamedOrigin[];
  trackers: string[];
  stun: string[];
  /** The renditions the seeder holds (NFX-03 §5): every one, or these (perhaps none). */
  holds: 'all' | string[];
}

/**
 * An endpoint's `renditions` (NFX-03 §4): `all` when absent, else the ids this player
 * counts (`beaconRenditionId`), at most `MAX_RENDITIONS`; null when it is not a list of
 * strings, which nfx-proto never passes (the endpoint then serves nothing here).
 */
function endpointRenditions(raw: unknown): 'all' | string[] | null {
  if (raw === undefined) return 'all';
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const id of raw as unknown[]) {
    if (typeof id !== 'string') return null;
    if (beaconRenditionId(id) && !out.includes(id) && out.length < MAX_RENDITIONS) out.push(id);
  }
  return out;
}

/** What two claims about one origin leave: only what both say it serves (null: every rendition). */
function narrow(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b === null ? null : [...b];
  return b === null ? a : a.filter((id) => b.includes(id));
}

/**
 * The newest unexpired beacon of each seeder, and what they name together. An older or
 * equal beacon from a seeder already held changes nothing (a relay replaying an old one,
 * or the same one from a second relay), and a seeder's newer beacon replaces what it said
 * before, so a seeder can withdraw an endpoint, or stop holding a rendition. Beside them,
 * the newest unexpired STUN service announcement of each operator and server (NFX-10 §1),
 * whose servers count with the beacons' `stun` endpoints, by distinct key.
 */
export class EndpointBook {
  readonly #seeders = new Map<string, Entry>();
  /** By `<operator> <server>`: the newest announcement of each. */
  readonly #announcements = new Map<
    string,
    { operator: string; url: string; created_at: number; expiration: number; heard: number }
  >();
  /** The order things are first heard in, across beacons and announcements (for ties). */
  #heard = 0;

  /**
   * Take in a STUN service announcement (NFX-10 §1), already verified and checked to serve
   * the page's network, at `now`. True if it changed what the book holds. An older or equal
   * one of the same operator and server changes nothing; at most `MAX_ANNOUNCEMENTS` are
   * held, 8 per operator.
   */
  addAnnouncement(a: VerifiedStunAnnouncement, now: number): boolean {
    if (typeof a.operator !== 'string' || typeof a.addr !== 'string') return false;
    if (!Number.isSafeInteger(a.created_at) || !Number.isSafeInteger(a.expiration) || a.expiration <= now) return false;
    const url = beaconStun(a.addr);
    if (url === null) return false;
    const key = `${a.operator} ${a.addr}`;
    const held = this.#announcements.get(key);
    if (held && held.created_at >= a.created_at) return false;
    if (!held) {
      for (const [k, e] of this.#announcements) if (e.expiration <= now) this.#announcements.delete(k);
      const mine = [...this.#announcements.values()].filter((e) => e.operator === a.operator).length;
      if (this.#announcements.size >= MAX_ANNOUNCEMENTS || mine >= ANNOUNCEMENTS_PER_KEY) return false;
    }
    const heard = held?.heard ?? ++this.#heard;
    this.#announcements.set(key, { operator: a.operator, url, created_at: a.created_at, expiration: a.expiration, heard });
    return true;
  }

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
    const origins: NamedOrigin[] = [];
    const trackers: string[] = [];
    const stun: string[] = [];
    let all = false;
    const ids: string[] = [];
    const hold = (r: 'all' | string[]): void => {
      if (r === 'all') all = true;
      else for (const id of r) if (!ids.includes(id) && ids.length < MAX_RENDITIONS) ids.push(id);
    };
    const endpoints = Array.isArray(b.content?.endpoints) ? (b.content.endpoints as unknown[]) : [];
    for (const e of endpoints) {
      if (e === null || typeof e !== 'object') continue;
      const { t, url, tracker_urls: urls, addrs, renditions, tickets } = e as {
        t?: unknown;
        url?: unknown;
        tracker_urls?: unknown;
        addrs?: unknown;
        renditions?: unknown;
        tickets?: unknown;
      };
      if (t === 'https' && typeof url === 'string') {
        const r = endpointRenditions(renditions);
        if (r === null) continue;
        hold(r);
        const o = originBase(url);
        const served = r === 'all' ? null : r;
        const named = origins.find((x) => x.url === o);
        if (named) named.renditions = narrow(named.renditions, served);
        else if (o !== null && origins.length < PER_BEACON) origins.push({ url: o, renditions: served });
      } else if (t === 'webrtc' && Array.isArray(urls)) {
        const r = endpointRenditions(renditions);
        if (r !== null) hold(r);
        for (const raw of urls) {
          const tr = typeof raw === 'string' ? beaconTracker(raw) : null;
          if (tr !== null && !trackers.includes(tr) && trackers.length < PER_BEACON) trackers.push(tr);
        }
      } else if (t === 'iroh' && tickets !== null && typeof tickets === 'object' && !Array.isArray(tickets)) {
        // One ticket per held rendition, and `meta` (NFX-03 §4), which beaconRenditionId refuses.
        hold(Object.keys(tickets).filter(beaconRenditionId));
      } else if (t === 'stun' && Array.isArray(addrs)) {
        for (const raw of addrs) {
          const s = typeof raw === 'string' ? beaconStun(raw) : null;
          if (s !== null && !stun.includes(s) && stun.length < PER_BEACON) stun.push(s);
        }
      }
    }
    const holds = all ? 'all' : ids;
    // Map#set on a held key keeps its place: seeders stay in first-heard order.
    const heard = held?.heard ?? ++this.#heard;
    this.#seeders.set(b.seeder, { created_at: b.created_at, expiration: b.expiration, heard, origins, trackers, stun, holds });
    return true;
  }

  /**
   * What the unexpired beacons name at `now`, each list ranked by how many seeders name
   * an entry, ties in the order first heard; and who holds which renditions.
   */
  snapshot(now: number): Endpoints {
    const origins = new Map<string, { n: number; renditions: string[] | null }>();
    const trackers = new Map<string, number>();
    /** [first heard, key, URL]: ties among STUN servers go to the one first heard. */
    const stunPairs: [number, string, string][] = [];
    const named = new Map<string, number>();
    let seeders = 0;
    let holders = 0;
    let all = 0;
    for (const [seeder, e] of this.#seeders) {
      if (e.expiration <= now) continue;
      seeders += 1;
      for (const o of e.origins) {
        const c = origins.get(o.url);
        if (c) {
          c.n += 1;
          c.renditions = narrow(c.renditions, o.renditions);
        } else origins.set(o.url, { n: 1, renditions: o.renditions === null ? null : [...o.renditions] });
      }
      for (const t of e.trackers) trackers.set(t, (trackers.get(t) ?? 0) + 1);
      for (const s of e.stun) stunPairs.push([e.heard, seeder, s]);
      if (e.holds === 'all') {
        holders += 1;
        all += 1;
      } else if (e.holds.length > 0) {
        holders += 1;
        for (const id of e.holds) named.set(id, (named.get(id) ?? 0) + 1);
      }
    }
    for (const a of this.#announcements.values()) if (a.expiration > now) stunPairs.push([a.heard, a.operator, a.url]);
    // Array#sort is stable: within one source, the order it names them in.
    stunPairs.sort((x, y) => x[0] - y[0]);
    const stunNamed = rankNamed(stunPairs.map(([, key, url]): [string, string] => [key, url])).slice(0, MAX_STUN_NAMED);
    // Array#sort is stable, so equal counts keep first-heard order.
    const ranked = (m: Map<string, number>): string[] => [...m].sort((x, y) => y[1] - x[1]).map(([u]) => u);
    const originsRanked = [...origins].sort((x, y) => y[1].n - x[1].n).slice(0, MAX_ORIGINS);
    const availability: RenditionAvailability = {
      seeders: holders,
      all,
      renditions: [...named]
        .sort((x, y) => y[1] - x[1])
        .slice(0, MAX_RENDITIONS)
        .map(([id, n]) => ({ id, seeders: n + all })),
    };
    return {
      origins: originsRanked.map(([u]) => u),
      originSources: originsRanked.map(([url, c]): OriginSource => (c.renditions === null ? { url } : { url, renditions: c.renditions })),
      trackers: ranked(trackers).slice(0, MAX_TRACKERS),
      stunServers: selectStun([], stunNamed),
      stunNamed,
      seeders,
      availability,
    };
  }

  /**
   * When the next beacon or announcement held expires (unix seconds), or null when none is
   * live: what the book names may change then with nothing new heard.
   */
  nextExpiration(now: number): number | null {
    let next: number | null = null;
    for (const e of [...this.#seeders.values(), ...this.#announcements.values()]) {
      if (e.expiration > now && (next === null || e.expiration < next)) next = e.expiration;
    }
    return next;
  }

  #prune(now: number): void {
    for (const [k, e] of this.#seeders) if (e.expiration <= now) this.#seeders.delete(k);
  }

}

/** The trackers a session may use, normalised; throws on any it may not. */
export function checkTrackers(list: readonly string[]): string[] {
  if (!Array.isArray(list)) throw new TypeError('nfx: trackers must be a list');
  const out: string[] = [];
  for (const raw of list) {
    const t = typeof raw === 'string' ? trackerUrl(raw) : null;
    if (t === null) throw new TypeError(`nfx: not a tracker URL this player may use: ${String(raw)}`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TRACKERS) throw new TypeError(`nfx: at most ${MAX_TRACKERS} trackers`);
  return out;
}

/** The Nostr relays a session may signal through, normalised; throws on any it may not. */
export function checkRelays(list: readonly string[]): string[] {
  if (!Array.isArray(list)) throw new TypeError('nfx: relays must be a list');
  const out: string[] = [];
  for (const raw of list) {
    const r = typeof raw === 'string' ? relayUrl(raw) : null;
    if (r === null) throw new TypeError(`nfx: not a relay URL this player may signal through: ${String(raw)}`);
    if (!out.includes(r)) out.push(r);
  }
  if (out.length > MAX_RELAYS) throw new TypeError(`nfx: at most ${MAX_RELAYS} relays`);
  return out;
}

/** The signaling a session may use, normalised; null for none; throws otherwise. */
export function checkSignaling(s: Signaling | undefined): Signaling | null {
  if (s === undefined) return null;
  const kind = (s as { kind?: unknown } | null)?.kind;
  if (kind === 'trackers') {
    const urls = checkTrackers((s as { urls: string[] }).urls ?? []);
    if (urls.length === 0) throw new TypeError('nfx: trackers signaling needs at least one tracker');
    return { kind, urls };
  }
  if (kind === 'nostr') {
    const relays = checkRelays((s as { relays: string[] }).relays ?? []);
    if (relays.length === 0) throw new TypeError('nfx: nostr signaling needs at least one relay');
    return { kind, relays };
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

/** An origin a session may try, and the renditions it serves (null: every one). */
export interface CheckedOrigin {
  url: string;
  renditions: string[] | null;
}

/**
 * The origins a session may try (bare bases, or `OriginSource`s), normalised: URLs reduced,
 * repeated ids dropped, an origin given twice taken as first given. Throws a `TypeError` on
 * any it may not: a URL `pageOrigin` refuses, or `renditions` that is not a list of at most
 * `MAX_RENDITIONS` non-empty strings.
 */
export function checkOriginSources(list: readonly (string | OriginSource)[]): CheckedOrigin[] {
  if (!Array.isArray(list)) throw new TypeError('nfx: origins must be a list');
  const out: CheckedOrigin[] = [];
  for (const raw of list as unknown[]) {
    const src = (typeof raw === 'string' ? { url: raw } : raw) as Partial<OriginSource> | null;
    const url = typeof src?.url === 'string' ? pageOrigin(src.url) : null;
    if (url === null) throw new TypeError(`nfx: not an origin base: ${String(typeof raw === 'string' ? raw : src?.url)}`);
    const r: unknown = src?.renditions;
    let renditions: string[] | null = null;
    if (r !== undefined) {
      if (!Array.isArray(r) || r.length > MAX_RENDITIONS || !r.every((id) => typeof id === 'string' && id !== '')) {
        throw new TypeError(`nfx: the renditions of ${url} must be a list of at most ${MAX_RENDITIONS} rendition ids`);
      }
      renditions = [...new Set(r as string[])];
    }
    if (!out.some((o) => o.url === url)) out.push({ url, renditions });
    if (out.length > MAX_ORIGINS + 8) throw new TypeError(`nfx: at most ${MAX_ORIGINS + 8} origins`);
  }
  if (out.length === 0) throw new TypeError('nfx: no origin to try');
  return out;
}

/** The origins a session may try, as bare bases, normalised; throws on any it may not. */
export function checkOrigins(list: readonly string[]): string[] {
  return checkOriginSources(list).map((o) => o.url);
}
