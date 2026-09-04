/**
 * Follows (kind 3) and channel subscriptions (NIP-51 kind 30000 set `d=channels`).
 *
 * Build-plan §2.2 recommends keeping subscriptions separate from social follows, so
 * `subscriptions()` reads the channel set first and falls back to kind 3 when the user
 * has never created one.
 */
import type { NostrEvent, NostrPubkey, NostrTag, UnixSeconds } from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { isHex64 } from './event.js';
import { fetchSet, publishSet, SetId } from './sets.js';
import type { EventDraft } from './types.js';

export interface FollowEntry {
  readonly pubkey: NostrPubkey;
  readonly relayHint?: string;
  readonly petname?: string;
}

/** `p` tags of a VERIFIED kind-3 (or any list) event, deduped, malformed pubkeys skipped. */
export function parseFollows(ev: { readonly tags: readonly NostrTag[] }): FollowEntry[] {
  const out: FollowEntry[] = [];
  const seen = new Set<string>();
  for (const t of ev.tags) {
    if (t[0] !== 'p' || t[1] === undefined || !isHex64(t[1]) || seen.has(t[1])) continue;
    seen.add(t[1]);
    out.push({
      pubkey: t[1] as NostrPubkey,
      ...(t[2] !== undefined && t[2] !== '' ? { relayHint: t[2] } : {}),
      ...(t[3] !== undefined && t[3] !== '' ? { petname: t[3] } : {}),
    });
  }
  return out;
}

export function buildFollowsEvent(
  follows: readonly FollowEntry[],
  createdAt: UnixSeconds,
): EventDraft {
  return {
    kind: NostrKind.Follows,
    created_at: createdAt,
    tags: follows.map((f) =>
      f.petname !== undefined
        ? ['p', f.pubkey, f.relayHint ?? '', f.petname]
        : f.relayHint !== undefined
          ? ['p', f.pubkey, f.relayHint]
          : ['p', f.pubkey],
    ),
    content: '',
  };
}

/** Newest kind 3 for `pubkey`, parsed. Empty when none. */
export async function fetchFollows(
  client: NostrClient,
  pubkey: NostrPubkey,
): Promise<FollowEntry[]> {
  const ev = await client.queryOne({ kinds: [NostrKind.Follows], authors: [pubkey] });
  return ev ? parseFollows(ev) : [];
}

/** Channel subscriptions = the `channels` follow set, else kind 3 as a fallback. */
export async function fetchSubscriptions(
  client: NostrClient,
  pubkey: NostrPubkey,
): Promise<{
  readonly pubkeys: NostrPubkey[];
  readonly source: 'channel-set' | 'follows' | 'none';
}> {
  const set = await fetchSet(client, pubkey, NostrKind.ChannelSet, SetId.Channels);
  if (set) {
    const all = parseFollows({ tags: [...set.publicItems, ...set.privateItems] });
    return { pubkeys: all.map((f) => f.pubkey), source: 'channel-set' };
  }
  const follows = await fetchFollows(client, pubkey);
  return follows.length > 0
    ? { pubkeys: follows.map((f) => f.pubkey), source: 'follows' }
    : { pubkeys: [], source: 'none' };
}

/** Add or remove a channel from our subscription set (read-modify-write). */
export async function setSubscribed(
  client: NostrClient,
  channel: NostrPubkey,
  on: boolean,
): Promise<NostrEvent | null> {
  const me = await client.me();
  if (me === null) throw new Error('cannot subscribe without a signer');
  const current = (await fetchSubscriptions(client, me)).pubkeys;
  const has = current.includes(channel);
  if (on === has) return null;
  const next = on ? [...current, channel] : current.filter((p) => p !== channel);
  return publishSet(client, {
    kind: NostrKind.ChannelSet,
    d: SetId.Channels,
    title: 'Channels',
    publicItems: next.map((p) => ['p', p]),
  });
}
