/**
 * The fallback for when a session's own STUN fails (NFX-10 §1), as one session's state:
 * whether its gatherings found a mapping, which addresses each peer's SDP named, and the
 * servers picked so far. Pure: no network, no WebRTC, no WASM.
 *
 * A peer's session key says nothing of who signed a beacon (NFX-10 §6.4), so "a seeder this
 * client is signaling with" is decided by address: a beacon's server counts for a peer only
 * at an IP address that same peer's SDP gave this session's ICE agent to check.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { SeederStun, StunFallback } from './api';
import { selectStunFallback, stunHost } from './endpoints';
import { candidateAddresses, hasServerReflexive } from './remote-sdp';

/** Peers whose candidate addresses are held at most; the oldest goes first. */
const MAX_PEERS = 256;

export class StunFallbackBook {
  readonly #own: readonly string[];
  readonly #inUse: readonly string[];
  readonly #seeders: () => readonly SeederStun[];
  /** Whether the last gathering with the session's own servers found no mapping. */
  #noMapping = false;
  readonly #peers = new Map<string, string[]>();
  /** By URL, the seeder it was picked for. Kept for the session: it counts toward the 4. */
  readonly #picked = new Map<string, string>();

  /** `inUse`: every STUN URL the session's `iceServers` name. */
  constructor(fallback: StunFallback, inUse: readonly string[]) {
    this.#own = fallback.own;
    this.#inUse = inUse;
    this.#seeders = fallback.seeders;
  }

  /** A gathering with the session's own servers ended, with this local SDP. */
  gathered(localSdp: string): void {
    this.#noMapping = !hasServerReflexive(localSdp);
  }

  /** `peer` sent this SDP. */
  signaled(peer: string, remoteSdp: string): void {
    this.#peers.delete(peer);
    this.#peers.set(peer, candidateAddresses(remoteSdp));
    if (this.#peers.size > MAX_PEERS) this.#peers.delete(this.#peers.keys().next().value as string);
  }

  /** `peer` left. */
  forget(peer: string): void {
    this.#peers.delete(peer);
  }

  /** The extra STUN URLs for a new connection to `peer` at `now` (unix seconds), if any. */
  serversFor(peer: string, now: number): string[] {
    const ips = this.#peers.get(peer);
    if (!this.#noMapping || ips === undefined || ips.length === 0) return [];
    try {
      const seeders = this.#seeders().filter((s) => s.expiration > now);
      const out: string[] = [];
      for (const [url, seeder] of this.#picked) {
        const named = seeders.some((s) => s.seeder === seeder && s.urls.includes(url));
        if (named && ips.includes(stunHost(url) ?? '')) out.push(url);
      }
      const taken = new Set(this.#picked.values());
      const rest = seeders.filter((s) => !taken.has(s.seeder));
      for (const { seeder, url } of selectStunFallback(this.#own, [...this.#inUse, ...this.#picked.keys()], false, rest, ips)) {
        this.#picked.set(url, seeder);
        out.push(url);
      }
      return out;
    } catch {
      return []; // the page's `seeders` threw or returned something else: no fallback
    }
  }
}
