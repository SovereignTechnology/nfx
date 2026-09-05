/**
 * NIP-05 lookup with an injected `fetch` (no module-global state, unlike
 * `nostr-tools/nip05`'s `useFetchImplementation`). Pure JSON-over-HTTPS; no crypto.
 *
 * Spec points enforced: local part charset `a-z0-9-_.` (identifiers are lower-cased
 * first — domains are case-insensitive and servers key names in lower case), GET
 * `https://<domain>/.well-known/nostr.json?name=<local>`, redirects ignored
 * (`redirect: 'manual'`, anything but 200 fails), `names[<local>]` must be lower-case hex.
 */
import type { NostrPubkey, RelayUrl } from '../contracts/index.js';
import { isHex64 } from './event.js';
import type { FetchLike } from './types.js';

export interface Nip05Identifier {
  readonly local: string;
  readonly domain: string;
  /** `local@domain`, lower-cased; `_@domain` is displayed as just the domain. */
  readonly normalized: string;
  readonly display: string;
}

const LOCAL = /^[a-z0-9-_.]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Split and validate an identifier. `domain` alone is treated as `_@domain`. */
export function parseNip05(identifier: string): Nip05Identifier | null {
  const s = identifier.trim().toLowerCase();
  const at = s.indexOf('@');
  const local = at === -1 ? '_' : s.slice(0, at);
  const domain = at === -1 ? s : s.slice(at + 1);
  if (!LOCAL.test(local) || !DOMAIN.test(domain) || domain.length > 253) return null;
  return {
    local,
    domain,
    normalized: `${local}@${domain}`,
    display: local === '_' ? domain : `${local}@${domain}`,
  };
}

export interface Nip05Lookup {
  readonly pubkey: NostrPubkey;
  readonly relays: readonly RelayUrl[];
}

/** Resolve an identifier to the pubkey the domain claims for it. `null` on any failure. */
export async function lookupNip05(
  identifier: string,
  fetch: FetchLike,
): Promise<Nip05Lookup | null> {
  const id = parseNip05(identifier);
  if (!id) return null;
  let body: unknown;
  try {
    const res = await fetch(
      `https://${id.domain}/.well-known/nostr.json?name=${encodeURIComponent(id.local)}`,
      { redirect: 'manual' },
    );
    if (res.status !== 200) return null;
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const names = (body as Record<string, unknown>)['names'];
  if (typeof names !== 'object' || names === null) return null;
  const pubkey = (names as Record<string, unknown>)[id.local];
  if (typeof pubkey !== 'string' || !isHex64(pubkey)) return null;
  const relaysMap = (body as Record<string, unknown>)['relays'];
  const relays: RelayUrl[] = [];
  if (typeof relaysMap === 'object' && relaysMap !== null) {
    const list = (relaysMap as Record<string, unknown>)[pubkey];
    if (Array.isArray(list)) {
      for (const r of list)
        if (typeof r === 'string' && /^wss?:\/\//.test(r)) relays.push(r as RelayUrl);
    }
  }
  return { pubkey: pubkey as NostrPubkey, relays };
}

/** Does the domain vouch for `pubkey` under `identifier`? Failure and mismatch are both `false`. */
export async function verifyNip05(
  identifier: string,
  pubkey: NostrPubkey,
  fetch: FetchLike,
): Promise<boolean> {
  const hit = await lookupNip05(identifier, fetch);
  return hit !== null && hit.pubkey === pubkey;
}
