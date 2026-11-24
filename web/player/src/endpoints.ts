/**
 * Endpoints from seeders' beacons, as plain data: no network, no WASM. The beacons reach
 * here already verified (NFX-03, by nfx-proto in WASM: ./resolve.ts); what they name is
 * still untrusted. A beacon names where to fetch, never what is right: every byte is
 * checked against the signed anchor whatever its source.
 */
import type { Endpoints, OriginSource, RenditionAvailability, SeederStun, Signaling, StunFallback } from './api';
import { MAX_RENDITIONS, beaconRenditionId } from './levels';
import { MAX_RELAYS, MAX_TRACKERS, relayUrl, trackerUrl } from './mesh';

/** Most distinct origins reported. */
export const MAX_ORIGINS = 32;
/** Most seeders held at once; a beacon from one more is ignored until one expires. */
export const MAX_SEEDERS = 64;
/** Keys first heard on any one relay (NFX-17 §4.2): one relay cannot fill the table. */
export const MAX_SEEDERS_PER_RELAY = 16;
/** Keys heard only through tells, held apart from the rest (NFX-17 §4.1). */
export const MAX_POOL = 16;
/** Most origins, and most trackers, taken from one beacon. */
const PER_BEACON = 4;
/** Most STUN servers one session takes, its own included (NFX-10 §1's abuse bound). */
export const MAX_ICE_SERVERS = 4;
/**
 * The lowest port of a STUN server named over Nostr a session asks (NFX-10 §1): a beacon must
 * not aim a viewer at a well-known service. A page's own servers may use any port.
 */
export const MIN_STUN_PORT = 1024;
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

/**
 * Which addresses count as global unicast. Both rules refuse the documentation blocks
 * 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (RFC 5737) and 2001:db8::/32 (RFC 3849).
 * `stun` (a STUN server named over Nostr, NFX-10 §1) refuses 3fff::/20 (RFC 9637) as well;
 * `ice` (the remote ICE candidates `remoteCandidates: 'global'` keeps, nutflix-pear ADR 0023
 * rule 5) names those four blocks only.
 */
export type GlobalRule = 'stun' | 'ice';

/** Whether an IPv4 address (as octets) is global unicast (NFX-10 §1): none of the blocks
 * that point a viewer at its own network (this network, private, shared, loopback,
 * link-local, IETF, benchmarking), that route nowhere (documentation, RFC 5737), or that are
 * not unicast (multicast, reserved, broadcast). */
function globalV4(o: number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  const documentation = (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    documentation
  );
}

/**
 * The family of `host` if it is an IP address in canonical text, else null. Canonical: IPv4
 * as four decimal octets with no leading zeros; IPv6 as RFC 5952 writes it (lower case,
 * zeros compressed, no zone, no embedded IPv4). Null for anything else: a name, an mDNS
 * name, or another spelling of an address, which a reader elsewhere might take for a
 * different address than this one does.
 */
export function ipFamily(host: string): 4 | 6 | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const parts = v4.slice(1, 5);
    const octets = parts.map(Number);
    return parts.some((p, i) => String(octets[i]) !== p) || octets.some((n) => n > 255) ? null : 4;
  }
  if (!/^[0-9a-f:]+$/.test(host)) return null;
  try {
    // WHATWG's serialisation is RFC 5952's, as the canonical form requires.
    return new URL(`http://[${host}]/`).hostname === `[${host}]` ? 6 : null;
  } catch {
    return null;
  }
}

/**
 * Whether `host` is an IP address in canonical text (`ipFamily`) that is global unicast
 * under `rule`: IPv4 by `globalV4`; IPv6 in 2000::/3 and not in 2001:db8::/32, and under
 * `stun` not in 3fff::/20 either.
 */
export function globalUnicast(host: string, rule: GlobalRule): boolean {
  const family = ipFamily(host);
  if (family === 4) return globalV4(host.split('.').map(Number));
  if (family !== 6) return false;
  const groups = host.startsWith('::') ? [] : host.split(':');
  const first = host.startsWith('::') ? 0 : parseInt(groups[0] ?? '', 16);
  if (!(Number.isInteger(first) && (first & 0xe000) === 0x2000)) return false;
  // The canonical form writes a second group of 0x0db8 as `db8`, and an empty one is zeros.
  const second = groups[1] === undefined || groups[1] === '' ? 0 : parseInt(groups[1], 16);
  if (first === 0x2001 && second === 0x0db8) return false;
  return !(rule === 'stun' && first === 0x3fff && second < 0x1000);
}

/**
 * A STUN address named over Nostr (NFX-10 §1: canonical `ip:port`, port not 0) as an
 * `iceServers` URL, or null: global unicast only (`globalUnicast`, rule `stun`), so a beacon
 * from anywhere cannot point viewers at their own network, or at an address that routes
 * nowhere. The port floor (`MIN_STUN_PORT`) is the selection's to apply.
 */
export function beaconStun(addr: string): string | null {
  const m = /^(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|\[([0-9a-f:]+)\]):(\d{1,5})$/.exec(addr);
  if (!m) return null;
  const port = Number(m[3]);
  // The port as written: no leading zeros, and not 0.
  if (!(port >= 1 && port <= 65535) || String(port) !== m[3]) return null;
  const host = m[1] ?? m[2] ?? '';
  if (!globalUnicast(host, 'stun')) return null;
  return m[1] !== undefined ? `stun:${host}:${port}` : `stun:[${host}]:${port}`;
}

/** The host of a `stun:<ip>:<port>` URL as `beaconStun` writes it, else null. */
export function stunHost(url: string): string | null {
  const addr = url.startsWith('stun:') ? url.slice(5) : '';
  if (beaconStun(addr) !== url) return null;
  return addr.startsWith('[') ? addr.slice(1, addr.indexOf(']')) : addr.slice(0, addr.lastIndexOf(':'));
}

/**
 * Whether a session may ask `url`, a STUN server named over Nostr: a `stun:<ip>:<port>` URL
 * as `beaconStun` writes it (global unicast), on a port of `MIN_STUN_PORT` or above.
 */
function askable(url: string): boolean {
  return stunHost(url) !== null && Number(url.slice(url.lastIndexOf(':') + 1)) >= MIN_STUN_PORT;
}

/**
 * The STUN servers a session uses routinely (NFX-10 §1), as `stun:` URLs, at most `max`: the
 * page's own (`own`, each once) first; then those the video's creator names (`creator`, as
 * `Endpoints.stunCreator` gives them: the `stun` endpoint of the creator's own live beacon),
 * in that order, each once, if global unicast, on a port of 1024 or above, and not its own.
 * No other key's beacon adds a server here, however many keys name it, and no announcement
 * ever does. So Nostr never makes a viewer ask more than 4 STUN servers, or one the creator
 * did not name.
 */
export function selectStun(own: readonly string[], creator: readonly string[], max: number = MAX_ICE_SERVERS): string[] {
  const out: string[] = [];
  for (const o of own) if (out.length < max && !out.includes(o)) out.push(o);
  for (const url of creator) {
    if (out.length >= max) break;
    if (!out.includes(url) && !own.includes(url) && askable(url)) out.push(url);
  }
  return out;
}

/**
 * The fallback when no STUN server a client asks returned a mapping (NFX-10 §1): which servers
 * it may also ask, each with the seeder that named it. Nothing once one of those it asks
 * (`own` and `inUse`) returned a mapping (`mapped` true). A client that asks no server at all
 * (both empty) has no mapping once gathering ends, so it may fall back too. Then, in the order
 * of `seeders` (live verified beacons of this video, the creator's included, never an
 * announcement), at most one server per seeder: global unicast, on a port of 1024 or above,
 * not asked yet, whose IP address is in `signaling` (the candidate addresses of the peers it
 * is signaling with), at most `max` STUN servers in all.
 */
export function selectStunFallback(
  own: readonly string[],
  inUse: readonly string[],
  mapped: boolean,
  seeders: readonly Pick<SeederStun, 'seeder' | 'urls'>[],
  signaling: readonly string[],
  max: number = MAX_ICE_SERVERS,
): { seeder: string; url: string }[] {
  const out: { seeder: string; url: string }[] = [];
  if (mapped) return out;
  const asked = new Set([...own, ...inUse]);
  const taken = new Set<string>();
  for (const { seeder, urls } of seeders) {
    if (taken.has(seeder)) continue;
    for (const url of urls) {
      if (asked.size >= max) return out;
      if (asked.has(url) || !askable(url)) continue;
      if (!signaling.includes(stunHost(url) ?? '')) continue;
      asked.add(url);
      taken.add(seeder);
      out.push({ seeder, url });
      break;
    }
  }
  return out;
}

/** A beacon as nfx-wasm's `verifyBeacon` returns it (the fields used here). */
export interface VerifiedBeacon {
  seeder: string;
  /** The video's creator, the key in the beacon's `a` tag: the manifest's author. */
  creator: string;
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
  /** Whether the seeder is the video's creator: only then are its `stun` servers used routinely. */
  creator: boolean;
  /** The relay it was first heard on, or '' when the caller did not say. */
  relay: string;
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
 * before, so a seeder can withdraw an endpoint, or stop holding a rendition. The creator's
 * own beacon (its seeder is the video's creator) names the STUN servers a session uses
 * routinely (NFX-10 §1); every seeder's, the creator's included, those of the fallback.
 */
export class EndpointBook {
  readonly #seeders = new Map<string, Entry>();
  readonly #random: () => number;
  /** Keys with a positive trusted score (NFX-16 §4): tier 2, and never refused for room. */
  readonly #rated: ReadonlySet<string>;
  /** Hosts that have delivered a file this session, and the first key that named each. */
  readonly #delivered = new Map<string, string | null>();
  /** Drawn once: the order of open origins, unknown to whoever names them. */
  readonly #salt: number;
  /** Seeders heard only through tells (NFX-17 §4.1): their `https` origins, nothing else. */
  readonly #pool = new Map<string, { expiration: number; origins: NamedOrigin[] }>();

  constructor(o: { random?: () => number; rated?: ReadonlySet<string> } = {}) {
    this.#random = o.random ?? Math.random;
    this.#rated = o.rated ?? new Set();
    this.#salt = Math.floor(this.#random() * 0x7fffffff);
  }

  /** A key that is never replaced: the creator's, a rated one, or the first to name a host that delivered. */
  #protected(seeder: string, e: Pick<Entry, 'creator'>): boolean {
    if (e.creator || this.#rated.has(seeder)) return true;
    for (const first of this.#delivered.values()) if (first === seeder) return true;
    return false;
  }

  /** Drop a random unprotected key first heard on `relay`; false if there is none. */
  #replace(relay: string): boolean {
    const victims = [...this.#seeders].filter(([k, e]) => e.relay === relay && !this.#protected(k, e)).map(([k]) => k);
    if (victims.length === 0) return false;
    const k = victims[Math.min(victims.length - 1, Math.floor(this.#random() * victims.length))];
    if (k !== undefined) this.#seeders.delete(k);
    return true;
  }

  #countFrom(relay: string): number {
    let n = 0;
    for (const e of this.#seeders.values()) if (e.relay === relay) n += 1;
    return n;
  }

  /**
   * Note that `url`'s host delivered a file (NFX-17 §4.2): the first key that named it is
   * protected from replacement from now on.
   */
  delivered(url: string): void {
    const host = originHost(url);
    if (host === null || this.#delivered.has(host)) return;
    let first: string | null = null;
    for (const [k, e] of this.#seeders) {
      if (e.origins.some((o) => originHost(o.url) === host)) {
        first = k;
        break;
      }
    }
    this.#delivered.set(host, first);
  }

  /**
   * Take `b`, heard on `relay`, in at time `now` (unix seconds). True if it changed what the
   * book holds. At most `MAX_SEEDERS` are held, and at most `MAX_SEEDERS_PER_RELAY` first heard
   * on one relay (NFX-17 §4.2). The creator's own beacon and rated keys are always taken. A new
   * key from a relay at its quota replaces a random unprotected key of that relay; when the
   * table is full, one from a relay under its quota replaces a random unprotected key of the
   * relay holding the most. A key heard with no relay named is refused when the table is full.
   */
  add(b: VerifiedBeacon, now: number, relay = ''): boolean {
    if (typeof b.seeder !== 'string' || !Number.isSafeInteger(b.created_at) || !Number.isSafeInteger(b.expiration)) {
      return false;
    }
    if (b.expiration <= now) return false;
    // A key heard broadcast leaves the tell pool (NFX-17 §4.1).
    this.#pool.delete(b.seeder);
    const creator = b.seeder === b.creator;
    const held = this.#seeders.get(b.seeder);
    if (held && held.created_at >= b.created_at) return false;
    if (!held && !this.#protected(b.seeder, { creator })) {
      if (relay !== '' && this.#countFrom(relay) >= MAX_SEEDERS_PER_RELAY) {
        this.#prune(now);
        if (this.#countFrom(relay) >= MAX_SEEDERS_PER_RELAY && !this.#replace(relay)) return false;
      } else if (this.#seeders.size >= MAX_SEEDERS) {
        this.#prune(now);
        if (this.#seeders.size >= MAX_SEEDERS) {
          if (relay === '') return false;
          const counts = new Map<string, number>();
          for (const e of this.#seeders.values()) if (e.relay !== '') counts.set(e.relay, (counts.get(e.relay) ?? 0) + 1);
          const top = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0];
          if (top === undefined || !this.#replace(top)) return false;
        }
      }
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
    this.#seeders.set(b.seeder, { created_at: b.created_at, expiration: b.expiration, creator, relay: held?.relay ?? relay, origins, trackers, stun, holds });
    return true;
  }

  /**
   * What the unexpired beacons name at `now` (NFX-17 §4.2): origins in tiers (those the
   * creator's beacon names, then a rated key's, then the rest, the open ones, in an order
   * drawn for this book; how many keys name an origin never ranks it), each with its tier and
   * the renditions its tier's keys claim for it; trackers ranked by how many seeders name
   * them; the STUN servers the creator names; and who holds which renditions (NFX-03 §5).
   */
  snapshot(now: number): Endpoints {
    type Named = { tier: 1 | 2 | 3; renditions: string[] | null };
    const origins = new Map<string, Named>();
    const trackers = new Map<string, number>();
    const stunCreator: string[] = [];
    const named = new Map<string, number>();
    const stunSeeders: SeederStun[] = [];
    let seeders = 0;
    let holders = 0;
    let all = 0;
    for (const [seeder, e] of this.#seeders) {
      if (e.expiration <= now) continue;
      seeders += 1;
      const tier: 1 | 2 | 3 = e.creator ? 1 : this.#rated.has(seeder) ? 2 : 3;
      for (const o of e.origins) {
        const c = origins.get(o.url);
        if (!c || tier < c.tier) origins.set(o.url, { tier, renditions: o.renditions === null ? null : [...o.renditions] });
        else if (tier === c.tier) c.renditions = narrow(c.renditions, o.renditions);
      }
      for (const t of e.trackers) trackers.set(t, (trackers.get(t) ?? 0) + 1);
      // One seeder is the creator, and its beacon names at most 4 (PER_BEACON).
      if (e.creator) stunCreator.push(...e.stun);
      if (e.stun.length > 0) stunSeeders.push({ seeder, urls: [...e.stun], expiration: e.expiration });
      if (e.holds === 'all') {
        holders += 1;
        all += 1;
      } else if (e.holds.length > 0) {
        holders += 1;
        for (const id of e.holds) named.set(id, (named.get(id) ?? 0) + 1);
      }
    }
    // Tell-only seeders' origins (NFX-17 §4.1): open sources, and nothing else.
    for (const e of this.#pool.values()) {
      if (e.expiration <= now) continue;
      for (const o of e.origins) {
        const c = origins.get(o.url);
        if (!c) origins.set(o.url, { tier: 3, renditions: o.renditions === null ? null : [...o.renditions] });
        else if (c.tier === 3) c.renditions = narrow(c.renditions, o.renditions);
      }
    }
    // Array#sort is stable, so equal counts keep first-heard order.
    const ranked = (m: Map<string, number>): string[] => [...m].sort((x, y) => y[1] - x[1]).map(([u]) => u);
    const order = (url: string): number => mix(this.#salt, url);
    const originsRanked = [...origins]
      .sort((x, y) => x[1].tier - y[1].tier || (x[1].tier === 3 ? order(x[0]) - order(y[0]) : 0))
      .slice(0, MAX_ORIGINS);
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
      originSources: originsRanked.map(([url, c]): OriginSource =>
        c.renditions === null ? { url, tier: c.tier } : { url, renditions: c.renditions, tier: c.tier },
      ),
      trackers: ranked(trackers).slice(0, MAX_TRACKERS),
      stunServers: selectStun([], stunCreator),
      stunCreator,
      stunSeeders,
      seeders,
      availability,
    };
  }

  /**
   * Take in a beacon that arrived only in a tell (NFX-17 §4.1), already verified, at `now`:
   * held in a pool of at most `MAX_POOL` keys, apart from the seeders heard broadcast, which it
   * never displaces. Only its `https` origins are used, as open sources (§4.2), and it adds no
   * weight to any count. True if it changed what the book holds.
   */
  addTold(b: VerifiedBeacon, now: number): boolean {
    if (typeof b.seeder !== 'string' || !Number.isSafeInteger(b.expiration) || b.expiration <= now) return false;
    if (this.#seeders.has(b.seeder)) return false;
    const origins: NamedOrigin[] = [];
    const endpoints = Array.isArray(b.content?.endpoints) ? (b.content.endpoints as unknown[]) : [];
    for (const e of endpoints) {
      if (e === null || typeof e !== 'object') continue;
      const { t, url, renditions } = e as { t?: unknown; url?: unknown; renditions?: unknown };
      if (t !== 'https' || typeof url !== 'string') continue;
      const r = endpointRenditions(renditions);
      const o = originBase(url);
      if (r === null || o === null || origins.some((x) => x.url === o) || origins.length >= PER_BEACON) continue;
      origins.push({ url: o, renditions: r === 'all' ? null : r });
    }
    const held = this.#pool.get(b.seeder);
    if (!held && this.#pool.size >= MAX_POOL) {
      for (const [k, e] of this.#pool) if (e.expiration <= now) this.#pool.delete(k);
      if (this.#pool.size >= MAX_POOL) {
        const keys = [...this.#pool.keys()];
        const k = keys[Math.min(keys.length - 1, Math.floor(this.#random() * keys.length))];
        if (k !== undefined) this.#pool.delete(k);
      }
    }
    this.#pool.set(b.seeder, { expiration: b.expiration, origins });
    return true;
  }

  /**
   * When the next beacon held expires (unix seconds), or null when none is live: what the
   * book names may change then with nothing new heard.
   */
  nextExpiration(now: number): number | null {
    let next: number | null = null;
    for (const e of [...this.#seeders.values(), ...this.#pool.values()]) {
      if (e.expiration > now && (next === null || e.expiration < next)) next = e.expiration;
    }
    return next;
  }

  #prune(now: number): void {
    for (const [k, e] of this.#seeders) if (e.expiration <= now) this.#seeders.delete(k);
  }

}

/** The scheme, host and port of an origin URL, or null. */
function originHost(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** A 31-bit FNV-1a hash of `s` under `salt`: an order only this book knows. */
function mix(salt: number, s: string): number {
  let h = (0x811c9dc5 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h & 0x7fffffff;
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

/**
 * The signaling a session may use, normalised; null for none; throws otherwise. Nostr
 * signaling keeps `remoteCandidates` when given (`all` or `global`). Trackers signaling
 * refuses `remoteCandidates` other than `all`: their SDP goes through the engine's tracker
 * clients, which this option does not filter, and a filter asked for must not be silently
 * missing. `stunFallback` is for Nostr signaling only, for the same reason.
 */
export function checkSignaling(s: Signaling | undefined): Signaling | null {
  if (s === undefined) return null;
  const kind = (s as { kind?: unknown } | null)?.kind;
  const remote = (s as { remoteCandidates?: unknown } | null)?.remoteCandidates;
  if (!(remote === undefined || remote === 'all' || remote === 'global')) {
    throw new TypeError(`nfx: remoteCandidates must be 'all' or 'global', not ${typeof remote === 'string' ? JSON.stringify(remote) : typeof remote}`);
  }
  const fallback = (s as { stunFallback?: unknown } | null)?.stunFallback;
  if (kind === 'trackers') {
    if (remote === 'global') throw new TypeError("nfx: remoteCandidates 'global' needs nostr signaling");
    if (fallback !== undefined) throw new TypeError('nfx: stunFallback needs nostr signaling');
    const urls = checkTrackers((s as { urls: string[] }).urls ?? []);
    if (urls.length === 0) throw new TypeError('nfx: trackers signaling needs at least one tracker');
    return { kind, urls };
  }
  if (kind === 'nostr') {
    const relays = checkRelays((s as { relays: string[] }).relays ?? []);
    if (relays.length === 0) throw new TypeError('nfx: nostr signaling needs at least one relay');
    return {
      kind,
      relays,
      ...(remote === undefined ? {} : { remoteCandidates: remote }),
      ...(fallback === undefined ? {} : { stunFallback: checkStunFallback(fallback) }),
    };
  }
  throw new TypeError(`nfx: signaling of kind ${JSON.stringify(kind)} is not in this build`);
}

/**
 * `stunFallback` as given: 0 to 4 distinct STUN URLs of the page's own (none: the page has no
 * STUN server of its own, and falls back too), and a function.
 */
function checkStunFallback(raw: unknown): StunFallback {
  const f = raw as { own?: unknown; seeders?: unknown } | null;
  const own = f?.own;
  if (!Array.isArray(own) || own.length > MAX_ICE_SERVERS || !own.every((u) => typeof u === 'string' && STUN_URL.test(u))) {
    throw new TypeError(`nfx: stunFallback.own must be 0 to ${MAX_ICE_SERVERS} stun: or stuns: URLs`);
  }
  if (typeof f?.seeders !== 'function') throw new TypeError('nfx: stunFallback.seeders must be a function');
  return { own: [...new Set(own as string[])], seeders: f.seeders as StunFallback['seeders'] };
}

/** Throws unless every server `stunFallback` calls the page's own is one the session asks. */
export function checkStunFallbackServers(s: Signaling | null, iceServers: readonly RTCIceServer[]): void {
  if (s?.kind !== 'nostr' || s.stunFallback === undefined) return;
  const asked = iceServers.flatMap((i) => i.urls);
  if (!s.stunFallback.own.every((u) => asked.includes(u))) throw new TypeError('nfx: stunFallback.own must be among iceServers');
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
  /** NFX-17 §4.2's tier; 4 (configured by the caller) when the caller names none. */
  tier: 1 | 2 | 3 | 4;
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
    const t: unknown = src?.tier;
    if (t !== undefined && t !== 1 && t !== 2 && t !== 3 && t !== 4) throw new TypeError(`nfx: the tier of ${url} must be 1, 2, 3 or 4`);
    const tier = (t ?? 4) as 1 | 2 | 3 | 4;
    if (!out.some((o) => o.url === url)) out.push({ url, renditions, tier });
    if (out.length > MAX_ORIGINS + 8) throw new TypeError(`nfx: at most ${MAX_ORIGINS + 8} origins`);
  }
  if (out.length === 0) throw new TypeError('nfx: no origin to try');
  return out;
}

/** The origins a session may try, as bare bases, normalised; throws on any it may not. */
export function checkOrigins(list: readonly string[]): string[] {
  return checkOriginSources(list).map((o) => o.url);
}
