/**
 * Which source each file comes from, and what happens to a source after each outcome
 * (NFX-17 §§4.2-4.3). Pure: callers pass the time (ms) and, for tests, the random source.
 *
 * A source is an origin URL (NFX-05 §6); its host is the URL's scheme, host and port. Sources
 * come in tiers: 1 the creator's own beacon, 2 keys with a positive trusted score, 3 open
 * sources (every other beacon), 4 sources the caller configured, the last resort. Within
 * tier 3, sources whose host has delivered at real-time speed come first, in the order they
 * first did; the rest follow in an order drawn at random when each is first seen. How many
 * keys name a source never matters here.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export type Tier = 1 | 2 | 3 | 4;

export interface SourceInfo {
  /** `https://host[:port][/prefix]`, without a trailing slash. */
  url: string;
  tier: Tier;
  /** Renditions it is said to serve; null: every one. Asked first for those, never only (nfx #85). */
  renditions: readonly string[] | null;
  /** Renditions every key of its tier claims for it; null: every one. A 404 outside it is no strike. */
  firm: readonly string[] | null;
}

/** Open sources held at once (§4.3); tiers 1, 2 and 4 are never dropped for room. */
export const MAX_OPEN_SOURCES = 32;
/** Open hosts asked for one file (§4.2). */
export const OPEN_HOSTS_PER_FILE = 3;
/** Open hosts not asked before, per session, before the budget refills one at a time (§4.2). */
export const NEW_OPEN_HOSTS = 6;
export const NEW_OPEN_HOST_EVERY_MS = 30_000;
/** Strikes in the last `STRIKE_WINDOW` requests that stop a source (§4.3). */
export const STRIKES_TO_STOP = 2;
export const STRIKE_WINDOW = 6;
/** How long a source stopped once rests (§4.3). */
export const REST_MS = 30_000;

/** What a request to a source came to (§4.3's table, and a delivery). */
export type Outcome =
  | { kind: 'delivered'; realTime: boolean }
  | { kind: 'bad-bytes' }
  | { kind: 'error' }
  | { kind: 'not-held'; rendition: string }
  | { kind: 'give-up' };

/** The better of two standings: 1 or 2 by rank, then the caller's 4 over an open 3. */
export function bestTier(a: Tier, b: Tier): Tier {
  if (a === 1 || b === 1) return 1;
  if (a === 2 || b === 2) return 2;
  if (a === 4 || b === 4) return 4;
  return 3;
}

/** The scheme, host and port of an origin URL, or null when it is not one. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

interface State {
  info: SourceInfo;
  host: string;
  /** The last `STRIKE_WINDOW` results: true for a strike. */
  results: boolean[];
  /** When it was last stopped by strikes; null while it is not resting. */
  stoppedAt: number | null;
  stops: number;
  /** Bytes that did not verify: never asked again in this session (NFX-05 §4). */
  bad: boolean;
  /** Set on each give-up: it goes to the end of its tier, the latest last. */
  demoted: number;
  /**
   * Its order within its tier: for an open source, drawn at random when first seen; for any
   * other, the order it was given in (the caller's, or the score's).
   */
  draw: number;
  asked: boolean;
  usedAt: number;
}

/** A host's standing in this session. */
interface HostState {
  /** The order in which it first delivered at real-time speed, or null. */
  delivered: number | null;
  asked: boolean;
}

/** One file's way through the sources: what has been tried, and how many open hosts. */
export interface FilePlan {
  readonly rendition: string | null;
  readonly tried: Set<string>;
  readonly openHosts: Set<string>;
}

export class SourceSet {
  readonly #sources = new Map<string, State>();
  readonly #hosts = new Map<string, HostState>();
  readonly #random: () => number;
  /** Hosts that sent bytes that do not verify: never used again, whatever URL names them. */
  readonly #badHosts = new Set<string>();
  #delivered = 0;
  #demoted = 0;
  #given = 0;
  /** Open hosts asked for the first time in this session, and when the last of the first six was. */
  #newUsed = 0;
  #sixthAt: number | null = null;
  /** The source that delivered the previous file, and whether at real-time speed. */
  #last: { url: string; realTime: boolean } | null = null;

  constructor(random: () => number = Math.random) {
    this.#random = random;
  }

  /**
   * Take in what is known now. A source already held takes the new tier and claims; one no
   * longer named stays usable (§4.3). Past `MAX_OPEN_SOURCES` open sources, the least
   * recently used goes, never one of tier 1, 2 or 4.
   */
  update(sources: readonly SourceInfo[], now: number): void {
    for (const info of sources) {
      const host = hostOf(info.url);
      if (host === null) continue;
      if (this.#badHosts.has(host)) continue;
      const held = this.#sources.get(info.url);
      if (held) {
        // A source keeps the best standing anyone gave it: a beacon cannot demote a source the
        // creator, a rated key or the caller named (tier 4 stays the caller's last resort).
        const tier = bestTier(held.info.tier, info.tier);
        held.info = tier === info.tier ? { ...info } : held.info;
        continue;
      }
      this.#sources.set(info.url, {
        info: { ...info },
        host,
        results: [],
        stoppedAt: null,
        stops: 0,
        bad: false,
        demoted: 0,
        draw: info.tier === 3 ? this.#random() : ++this.#given,
        asked: false,
        usedAt: now,
      });
      if (!this.#hosts.has(host)) this.#hosts.set(host, { delivered: null, asked: false });
    }
    const open = [...this.#sources.values()].filter((s) => s.info.tier === 3);
    if (open.length > MAX_OPEN_SOURCES) {
      open.sort((x, y) => x.usedAt - y.usedAt);
      for (const s of open.slice(0, open.length - MAX_OPEN_SOURCES)) this.#sources.delete(s.info.url);
    }
  }

  /** A new file's plan. */
  plan(rendition: string | null): FilePlan {
    return { rendition, tried: new Set(), openHosts: new Set() };
  }

  /** How many open hosts never asked before the session may ask now: 6, then one per 30 s. */
  #newBudget(now: number): number {
    if (this.#newUsed < NEW_OPEN_HOSTS || this.#sixthAt === null) return NEW_OPEN_HOSTS - this.#newUsed;
    return Math.floor((now - this.#sixthAt) / NEW_OPEN_HOST_EVERY_MS) - (this.#newUsed - NEW_OPEN_HOSTS);
  }

  #isNew(s: State): boolean {
    return s.info.tier === 3 && !this.#hosts.get(s.host)?.asked;
  }

  /** Whether `s` may be asked for the plan's file now. */
  #eligible(s: State, plan: FilePlan, now: number): boolean {
    if (s.bad || this.#badHosts.has(s.host) || plan.tried.has(s.info.url)) return false;
    if (s.stoppedAt !== null && now - s.stoppedAt < REST_MS) return false;
    if (s.info.tier === 3 && !plan.openHosts.has(s.host) && plan.openHosts.size >= OPEN_HOSTS_PER_FILE) return false;
    if (this.#isNew(s) && this.#newBudget(now) <= 0) return false;
    return true;
  }

  /**
   * §4.2's order for the plan's file: the previous file's source first if it delivered at
   * real-time speed; then tiers 1 and 2; then open sources (delivered hosts first, then the
   * drawn order, one source per host before a second of the same host); then tier 4; then
   * open hosts new to the session once six have been asked; then open sources that gave up,
   * the latest last; and last, sources stopped twice. A tier 1, 2 or 4 source that gave up
   * goes to the end of its own tier.
   */
  #ordered(plan: FilePlan, now: number): State[] {
    const live = [...this.#sources.values()].filter((s) => this.#eligible(s, plan, now));
    const group = (s: State): number => {
      if (s.stops >= 2) return 6;
      if (s.info.tier === 1) return 0;
      if (s.info.tier === 2) return 1;
      if (s.info.tier === 4) return 3;
      if (s.demoted > 0) return 5;
      // Past the first six new hosts, a new one waits behind tier 4 (§4.2).
      return this.#isNew(s) && this.#newUsed >= NEW_OPEN_HOSTS ? 4 : 2;
    };
    const deliveredAt = (s: State): number => this.#hosts.get(s.host)?.delivered ?? Number.MAX_SAFE_INTEGER;
    // One source per host at a time: a host already asked for this file, and a host's other
    // URLs, follow the first URL of every host not yet asked for it.
    const triedHosts = new Set([...plan.tried].map((u) => this.#sources.get(u)?.host));
    const firstOfHost = new Map<string, State>();
    for (const s of live) {
      const held = firstOfHost.get(s.host);
      if (!held || s.draw < held.draw) firstOfHost.set(s.host, s);
    }
    const second = (s: State): number => (triedHosts.has(s.host) || firstOfHost.get(s.host) !== s ? 1 : 0);
    // A claim orders, never removes (nfx #85): within a group, sources said to serve the file's
    // rendition first.
    const unclaimed = (s: State): number =>
      plan.rendition !== null && s.info.renditions !== null && !s.info.renditions.includes(plan.rendition) ? 1 : 0;
    const sorted = live.sort((x, y) => {
      const g = group(x) - group(y);
      if (g !== 0) return g;
      if (x.demoted !== y.demoted) return x.demoted - y.demoted;
      const c = unclaimed(x) - unclaimed(y);
      if (c !== 0) return c;
      if (x.info.tier === 3) {
        const d = deliveredAt(x) - deliveredAt(y);
        if (d !== 0) return d;
        const sx = second(x) - second(y);
        if (sx !== 0) return sx;
      }
      return x.draw - y.draw;
    });
    const last = this.#last;
    if (last?.realTime) {
      const i = sorted.findIndex((s) => s.info.url === last.url && s.stops < 2);
      if (i > 0) sorted.unshift(...sorted.splice(i, 1));
    }
    return sorted;
  }

  /** The next source to ask for the plan's file, marked as asked; null when none is left now. */
  next(plan: FilePlan, now: number): SourceInfo | null {
    const s = this.#ordered(plan, now)[0];
    return s ? this.#take(s, plan, now) : null;
  }

  /**
   * The best tier 1, 2 or 4 source not yet asked for the plan's file (§4.3: the third source
   * fetching a file), or null. Marked as asked when returned.
   */
  reserved(plan: FilePlan, now: number): SourceInfo | null {
    const s = this.#ordered(plan, now).find((x) => x.info.tier !== 3 && x.stops < 2);
    return s ? this.#take(s, plan, now) : null;
  }

  #take(s: State, plan: FilePlan, now: number): SourceInfo {
    plan.tried.add(s.info.url);
    s.asked = true;
    s.usedAt = now;
    if (s.info.tier === 3) {
      plan.openHosts.add(s.host);
      const host = this.#hosts.get(s.host);
      if (host && !host.asked) {
        host.asked = true;
        this.#newUsed += 1;
        if (this.#newUsed === NEW_OPEN_HOSTS) this.#sixthAt = now;
      }
    }
    return { ...s.info };
  }

  /** Record what a request to `url` came to. */
  outcome(url: string, o: Outcome, now: number): void {
    const s = this.#sources.get(url);
    if (!s) return;
    switch (o.kind) {
      case 'delivered': {
        this.#last = { url, realTime: o.realTime };
        this.#push(s, false, now);
        const host = this.#hosts.get(s.host);
        if (o.realTime && host && host.delivered === null) host.delivered = ++this.#delivered;
        return;
      }
      case 'bad-bytes':
        s.bad = true;
        this.#badHosts.add(s.host);
        s.stoppedAt = now;
        if (this.#last?.url === url) this.#last = null;
        return;
      case 'error':
        this.#push(s, true, now);
        return;
      case 'not-held':
        // A 404 for a rendition every key of its tier claims is a strike; otherwise nothing.
        this.#push(s, s.info.firm === null || s.info.firm.includes(o.rendition), now);
        return;
      case 'give-up':
        s.demoted = ++this.#demoted;
        this.#push(s, false, now);
        if (this.#last?.url === url) this.#last = null;
        return;
    }
  }

  #push(s: State, strike: boolean, now: number): void {
    s.results.push(strike);
    if (s.results.length > STRIKE_WINDOW) s.results.shift();
    if (strike && s.results.filter(Boolean).length >= STRIKES_TO_STOP) {
      s.stops += 1;
      s.stoppedAt = now;
      s.results = [];
      if (this.#last?.url === s.info.url) this.#last = null;
    }
  }

  /** Sources stopped by strikes become eligible again (§4.3: every source failed a file). */
  wake(): void {
    for (const s of this.#sources.values()) if (!s.bad) s.stoppedAt = null;
  }

  /** For stats and tests: each held source, its tier, and whether it is stopped or bad. */
  list(now: number): { url: string; tier: Tier; stopped: boolean; bad: boolean }[] {
    return [...this.#sources.values()].map((s) => ({
      url: s.info.url,
      tier: s.info.tier,
      stopped: s.stoppedAt !== null && now - s.stoppedAt < REST_MS,
      bad: s.bad,
    }));
  }
}
