/**
 * STUN at the relays a session signals through (NFX-10 §1), as one session's state: the STUN
 * servers its relays name in their NIP-11 documents (`nfx.stun_port`, NFX-04 §3), and every
 * STUN server the session has asked so far, which is never more than 4.
 *
 * The documents are read when the session starts, all at once and beside the relay sockets
 * (./relay-info.ts), and nothing waits for them: a peer connection takes the servers known
 * when it is made (`serversFor`), so one that comes late counts from the next connection.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { RelayStun } from './api';
import { MAX_ICE_SERVERS, relayStunHost, relayStunServers, relayStunUrl } from './endpoints';
import { type FetchFn, RelayInfoCache } from './relay-info';

export class RelayStunBook {
  readonly #own: readonly string[];
  readonly #relays: readonly string[];
  /** By relay URL, the STUN server it names, once its document has come. */
  readonly #named = new Map<string, string>();
  /** Every STUN URL the session has asked: at most `MAX_ICE_SERVERS`. */
  readonly #asked = new Set<string>();
  readonly #cache: RelayInfoCache;
  #destroyed = false;

  /**
   * Starts reading the NIP-11 document of each of `relays` whose host may be asked
   * (`relayStunHost`); the others, an IP address that is not global unicast such as a test
   * relay on loopback, are never asked for one.
   */
  constructor(
    relayStun: RelayStun,
    relays: readonly string[],
    log: (m: string) => void,
    options: { timeoutMs?: number; fetch?: FetchFn } = {},
  ) {
    this.#own = relayStun.own;
    this.#relays = relays;
    this.#cache = new RelayInfoCache(options);
    for (const relay of relays) {
      if (relayStunHost(relay) === null) continue;
      void this.#cache.get(relay).then((info) => {
        const url = relayStunUrl(relay, info);
        if (url === null || this.#destroyed) return;
        this.#named.set(relay, url);
        const late = !this.#asked.has(url) && this.#asked.size >= MAX_ICE_SERVERS ? ` (not asked: this session already asks ${MAX_ICE_SERVERS})` : '';
        log(`mesh: relay ${relay} answers STUN at ${url}${late}`);
      });
    }
  }

  /** The servers the relays have named so far, in the order of the relays. */
  get named(): string[] {
    return this.#relays.flatMap((r) => this.#named.get(r) ?? []);
  }

  /** Every STUN server the session has asked so far. */
  get asked(): string[] {
    return [...this.#asked];
  }

  /**
   * The STUN URLs of a new peer connection, given `configured` (every URL of the session's
   * `iceServers`): its own, the relays', then the rest (`relayStunServers`). They count as
   * asked from here on.
   */
  serversFor(configured: readonly string[]): string[] {
    return relayStunServers(configured, this.#own, this.named, this.#asked);
  }

  /** `urls` (the fallback's) were asked too: they count toward the 4. */
  noteAsked(urls: readonly string[]): void {
    for (const u of urls) this.#asked.add(u);
  }

  /** Stop reading documents; nothing more is learned. */
  destroy(): void {
    this.#destroyed = true;
    this.#cache.destroy();
  }
}
