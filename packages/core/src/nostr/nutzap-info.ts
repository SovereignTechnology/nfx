/**
 * NIP-61 kind 10019 — where and how a pubkey accepts nutzaps (creator payout target,
 * seeder announcement). READ side only in this lane; the wallet lane publishes it.
 */
import type {
  CashuP2pkPubkey,
  MintUrl,
  NostrEvent,
  NostrPubkey,
  RelayUrl,
  UnixSeconds,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { isHex64, tagsNamed } from './event.js';

export interface NutzapMint {
  readonly url: MintUrl;
  /** Base units the mint is listed for; empty = unspecified (treat as `sat`). */
  readonly units: readonly string[];
}

export interface NutzapInfo {
  readonly pubkey: NostrPubkey;
  readonly relays: readonly RelayUrl[];
  readonly mints: readonly NutzapMint[];
  /** 33-byte compressed hex (`02…`). NIP-61: never the Nostr key itself. */
  readonly p2pk: CashuP2pkPubkey;
  readonly createdAt: UnixSeconds;
  readonly event: NostrEvent;
}

/** NIP-65-style normalisation: lower-case scheme+host, no trailing slash, no hash. */
export function normalizeMintUrl(u: string): MintUrl | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  let s = url.toString();
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s as MintUrl;
}

/** Parse a VERIFIED kind-10019 event. `null` without a usable `pubkey` tag or mint. */
export function parseNutzapInfo(ev: NostrEvent): NutzapInfo | null {
  if (ev.kind !== NostrKind.NutzapInfo) return null;
  const raw = tagsNamed(ev, 'pubkey').at(-1)?.[1];
  if (raw === undefined) return null;
  let p2pk: string;
  if (/^0[23][0-9a-f]{64}$/.test(raw)) p2pk = raw;
  else if (isHex64(raw))
    p2pk = `02${raw}`; // x-only given; NIP-61 says clients prefix 02
  else return null;
  if (p2pk.slice(2) === ev.pubkey) return null; // MUST NOT be the Nostr key
  const mints: NutzapMint[] = [];
  const seen = new Set<string>();
  for (const t of tagsNamed(ev, 'mint')) {
    const url = t[1] === undefined ? null : normalizeMintUrl(t[1]);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    mints.push({ url, units: t.slice(2).filter((u) => u !== '') });
  }
  if (mints.length === 0) return null;
  const relays: RelayUrl[] = [];
  for (const t of tagsNamed(ev, 'relay')) {
    if (t[1] !== undefined && /^wss?:\/\//.test(t[1])) relays.push(t[1] as RelayUrl);
  }
  return {
    pubkey: ev.pubkey,
    relays,
    mints,
    p2pk: p2pk as CashuP2pkPubkey,
    createdAt: ev.created_at as UnixSeconds,
    event: ev,
  };
}

export async function fetchNutzapInfo(
  client: NostrClient,
  pubkey: NostrPubkey,
): Promise<NutzapInfo | null> {
  const ev = await client.queryOne({ kinds: [NostrKind.NutzapInfo], authors: [pubkey] });
  return ev ? parseNutzapInfo(ev) : null;
}
