/**
 * NIP-65 kind 10002 relay lists ⇄ `RelayConfig[]`. Marker omitted = read + write.
 */
import type {
  NostrEvent,
  NostrPubkey,
  RelayConfig,
  RelayUrl,
  UnixSeconds,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { tagsNamed } from './event.js';
import type { EventDraft } from './types.js';

/** Lower-case scheme/host, strip trailing slash and fragment; `null` if not ws(s). */
export function normalizeRelayUrl(u: string): RelayUrl | null {
  let url: URL;
  try {
    url = new URL(u.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null;
  url.hash = '';
  let s = url.toString();
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s as RelayUrl;
}

export function parseRelayList(ev: NostrEvent): RelayConfig[] {
  if (ev.kind !== NostrKind.RelayList) return [];
  const out = new Map<RelayUrl, RelayConfig>();
  for (const t of tagsNamed(ev, 'r')) {
    const url = t[1] === undefined ? null : normalizeRelayUrl(t[1]);
    if (url === null) continue;
    const marker = t[2];
    const cfg: RelayConfig = {
      url,
      read: marker !== 'write',
      write: marker !== 'read',
    };
    const prev = out.get(url);
    out.set(url, prev ? { url, read: prev.read || cfg.read, write: prev.write || cfg.write } : cfg);
  }
  return [...out.values()];
}

export function buildRelayListEvent(
  relays: readonly RelayConfig[],
  createdAt: UnixSeconds,
): EventDraft {
  const tags = relays
    .filter((r) => r.read || r.write)
    .map((r) =>
      r.read && r.write ? ['r', r.url] : r.read ? ['r', r.url, 'read'] : ['r', r.url, 'write'],
    );
  return { kind: NostrKind.RelayList, created_at: createdAt, tags, content: '' };
}

export async function fetchRelayList(
  client: NostrClient,
  pubkey: NostrPubkey,
): Promise<RelayConfig[]> {
  const ev = await client.queryOne({ kinds: [NostrKind.RelayList], authors: [pubkey] });
  return ev ? parseRelayList(ev) : [];
}
