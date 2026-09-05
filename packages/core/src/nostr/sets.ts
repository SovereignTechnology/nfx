/**
 * NIP-51 sets (kind 30000 follow sets, 30005 video sets) with public and private items.
 *
 * Private items are a JSON array of tags encrypted with NIP-44 to the author's OWN
 * pubkey, via `Signer.nip44Encrypt` / `nip44Decrypt` only. No key material here.
 */
import type {
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  NostrTag,
  Playlist,
  Signer,
  UnixSeconds,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { isHex64, isWellFormedTag, tagValue } from './event.js';
import type { EventDraft } from './types.js';

export interface SetInput {
  readonly kind: number;
  /** NIP-51 `d` identifier. */
  readonly d: string;
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
  readonly publicItems: readonly NostrTag[];
  readonly privateItems?: readonly NostrTag[];
}

export type PrivateItemsStatus =
  /** Empty content: nothing private. */
  | 'none'
  /** Decrypted with the signer. */
  | 'decrypted'
  /** No signer, or the set belongs to someone else. */
  | 'locked'
  /** Decrypt threw, or the plaintext was not a tag array. */
  | 'failed'
  /** Legacy NIP-04 ciphertext (`?iv=`); deliberately unsupported. */
  | 'unsupported';

export interface ParsedSet {
  readonly event: NostrEvent;
  readonly kind: number;
  readonly d: string;
  readonly author: NostrPubkey;
  readonly title?: string;
  readonly description?: string;
  readonly image?: string;
  readonly publicItems: readonly NostrTag[];
  readonly privateItems: readonly NostrTag[];
  readonly privateStatus: PrivateItemsStatus;
}

const META = new Set(['d', 'title', 'description', 'image']);

/** Build the set event; encrypts `privateItems` to our own pubkey through the signer. */
export async function buildSetEvent(
  input: SetInput,
  signer: Signer,
  createdAt: UnixSeconds,
): Promise<EventDraft> {
  for (const t of [...input.publicItems, ...(input.privateItems ?? [])]) {
    if (!isWellFormedTag(t)) throw new Error('set item tags must be non-empty string arrays');
  }
  const tags: NostrTag[] = [['d', input.d]];
  if (input.title !== undefined) tags.push(['title', input.title]);
  if (input.description !== undefined) tags.push(['description', input.description]);
  if (input.image !== undefined) tags.push(['image', input.image]);
  tags.push(...input.publicItems);
  let content = '';
  if (input.privateItems && input.privateItems.length > 0) {
    const me = await signer.getPublicKey();
    content = await signer.nip44Encrypt(me, JSON.stringify(input.privateItems));
  }
  return { kind: input.kind, created_at: createdAt, tags, content };
}

/**
 * Parse a VERIFIED set event. Private items are decrypted only when `signer` is given
 * and the set's author is the signer's pubkey.
 */
export async function parseSet(ev: NostrEvent, signer?: Signer): Promise<ParsedSet | null> {
  const d = tagValue(ev, 'd');
  if (d === undefined) return null;
  const base = {
    event: ev,
    kind: ev.kind,
    d,
    author: ev.pubkey,
    ...optional('title', tagValue(ev, 'title')),
    ...optional('description', tagValue(ev, 'description')),
    ...optional('image', tagValue(ev, 'image')),
    publicItems: ev.tags.filter((t) => t[0] !== undefined && !META.has(t[0])),
  };
  if (ev.content === '') return { ...base, privateItems: [], privateStatus: 'none' };
  if (ev.content.includes('?iv='))
    return { ...base, privateItems: [], privateStatus: 'unsupported' };
  if (!signer) return { ...base, privateItems: [], privateStatus: 'locked' };
  const me = await signer.getPublicKey();
  if (me !== ev.pubkey) return { ...base, privateItems: [], privateStatus: 'locked' };
  try {
    const plain = await signer.nip44Decrypt(ev.pubkey, ev.content);
    const parsed = JSON.parse(plain) as unknown;
    if (!Array.isArray(parsed) || !parsed.every(isWellFormedTag)) {
      return { ...base, privateItems: [], privateStatus: 'failed' };
    }
    return { ...base, privateItems: parsed, privateStatus: 'decrypted' };
  } catch {
    return { ...base, privateItems: [], privateStatus: 'failed' };
  }
}

function optional<K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> {
  return v === undefined ? {} : ({ [k]: v } as Record<K, V>);
}

/** Newest set of `kind`/`d` for `author`, parsed (private items need the client's signer). */
export async function fetchSet(
  client: NostrClient,
  author: NostrPubkey,
  kind: number,
  d: string,
): Promise<ParsedSet | null> {
  const ev = await client.queryOne({ kinds: [kind], authors: [author], '#d': [d] });
  if (!ev) return null;
  return parseSet(ev, client.hasSigner ? client.signer() : undefined);
}

/** Publish (replace) one of our own sets. */
export async function publishSet(client: NostrClient, input: SetInput): Promise<NostrEvent> {
  const draft = await buildSetEvent(input, client.signer(), client.now());
  return (await client.publish(draft)).event;
}

// ---- well-known sets used by the product --------------------------------------------

/** NIP-51 `d` values this network uses. Single source of truth. */
export const SetId = {
  /** kind 30000: channel subscriptions, kept separate from social follows (build-plan §2.2). */
  Channels: 'channels',
  /** kind 30005, private items only. */
  WatchLater: 'watch-later',
  /** kind 30005, private items only; items are `["watched", id, positionSec, at]`. */
  History: 'history',
  /** kind 30005, private items only; mirrors our own kind-7 likes for the library screen. */
  Liked: 'liked',
} as const;

/** `e` item ids of a set (public + private), deduped, in list order. */
export function setEventIds(set: ParsedSet): NostrEventId[] {
  const ids: NostrEventId[] = [];
  const seen = new Set<string>();
  for (const t of [...set.publicItems, ...set.privateItems]) {
    if (t[0] === 'e' && t[1] !== undefined && isHex64(t[1]) && !seen.has(t[1])) {
      seen.add(t[1]);
      ids.push(t[1] as NostrEventId);
    }
  }
  return ids;
}

export function toPlaylist(set: ParsedSet): Playlist {
  const isPrivate = set.publicItems.every((t) => t[0] !== 'e') && set.privateStatus !== 'none';
  return {
    id: set.d,
    author: set.author,
    title: set.title ?? set.d,
    ...optional('description', set.description),
    videoIds: setEventIds(set),
    isPrivate,
  };
}

export interface PlaylistInput {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly videoIds: readonly NostrEventId[];
  readonly isPrivate: boolean;
}

export function playlistToSetInput(p: PlaylistInput): SetInput {
  const items: NostrTag[] = p.videoIds.map((id) => ['e', id]);
  return {
    kind: NostrKind.VideoSet,
    d: p.id,
    title: p.title,
    ...optional('description', p.description),
    publicItems: p.isPrivate ? [] : items,
    ...(p.isPrivate ? { privateItems: items } : {}),
  };
}

/** All kind-30005 sets by `author` (excluding the private library sets), as playlists. */
export async function fetchPlaylists(
  client: NostrClient,
  author: NostrPubkey,
): Promise<Playlist[]> {
  const evs = await client.query({ kinds: [NostrKind.VideoSet], authors: [author] });
  const out: Playlist[] = [];
  const seen = new Set<string>();
  const signer = client.hasSigner ? client.signer() : undefined;
  for (const ev of evs) {
    const set = await parseSet(ev, signer);
    if (!set || seen.has(set.d) || LIBRARY_IDS.has(set.d)) continue;
    seen.add(set.d);
    out.push(toPlaylist(set));
  }
  return out;
}

const LIBRARY_IDS: ReadonlySet<string> = new Set([SetId.WatchLater, SetId.History, SetId.Liked]);

export async function savePlaylist(client: NostrClient, p: PlaylistInput): Promise<Playlist> {
  const ev = await publishSet(client, playlistToSetInput(p));
  const set = await parseSet(ev, client.signer());
  if (!set) throw new Error('published playlist did not parse back');
  return toPlaylist(set);
}

// ---- private library sets --------------------------------------------------------------

async function fetchOwnSet(client: NostrClient, d: string): Promise<ParsedSet | null> {
  const me = await client.me();
  if (me === null) return null;
  return fetchSet(client, me, NostrKind.VideoSet, d);
}

/** Watch-later ids (private set). Empty when signed out or nothing saved. */
export async function fetchWatchLater(client: NostrClient): Promise<NostrEventId[]> {
  const set = await fetchOwnSet(client, SetId.WatchLater);
  return set ? setEventIds(set) : [];
}

/** Add/remove a video in the private watch-later set (read-modify-write, appends at end). */
export async function setWatchLater(
  client: NostrClient,
  videoId: NostrEventId,
  on: boolean,
): Promise<void> {
  const current = await fetchWatchLater(client);
  const next = on
    ? current.includes(videoId)
      ? current
      : [...current, videoId]
    : current.filter((id) => id !== videoId);
  if (sameIds(current, next)) return;
  await publishSet(client, {
    kind: NostrKind.VideoSet,
    d: SetId.WatchLater,
    publicItems: [],
    privateItems: next.map((id) => ['e', id]),
  });
}

export interface HistoryEntry {
  readonly videoId: NostrEventId;
  readonly positionSec: number;
  readonly at: UnixSeconds;
}

/** Private history, most recent first. Items are `["watched", id, positionSec, at]`. */
export async function fetchHistory(client: NostrClient): Promise<HistoryEntry[]> {
  const set = await fetchOwnSet(client, SetId.History);
  if (!set) return [];
  return parseHistoryItems(set.privateItems).sort((a, b) => b.at - a.at);
}

export function parseHistoryItems(items: readonly NostrTag[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const t of items) {
    if (t[0] !== 'watched' || t[1] === undefined || !isHex64(t[1])) continue;
    const pos = Number(t[2]);
    const at = Number(t[3]);
    if (!Number.isFinite(pos) || pos < 0 || !Number.isInteger(at) || at < 0) continue;
    out.push({ videoId: t[1] as NostrEventId, positionSec: pos, at: at as UnixSeconds });
  }
  return out;
}

export const DEFAULT_HISTORY_CAP = 500;

/** Upsert a history entry (one per video, newest wins) and republish, capped. */
export async function recordProgress(
  client: NostrClient,
  videoId: NostrEventId,
  positionSec: number,
  cap = DEFAULT_HISTORY_CAP,
): Promise<void> {
  const entries = (await fetchHistory(client)).filter((e) => e.videoId !== videoId);
  entries.unshift({ videoId, positionSec, at: client.now() });
  const kept = entries.slice(0, cap).reverse(); // chronological in the stored list
  await publishSet(client, {
    kind: NostrKind.VideoSet,
    d: SetId.History,
    publicItems: [],
    privateItems: kept.map((e) => ['watched', e.videoId, String(e.positionSec), String(e.at)]),
  });
}

/** Ids in our private "liked" set. */
export async function fetchLiked(client: NostrClient): Promise<NostrEventId[]> {
  const set = await fetchOwnSet(client, SetId.Liked);
  return set ? setEventIds(set) : [];
}

export async function setLiked(
  client: NostrClient,
  videoId: NostrEventId,
  on: boolean,
): Promise<void> {
  const current = await fetchLiked(client);
  const next = on
    ? current.includes(videoId)
      ? current
      : [...current, videoId]
    : current.filter((id) => id !== videoId);
  if (sameIds(current, next)) return;
  await publishSet(client, {
    kind: NostrKind.VideoSet,
    d: SetId.Liked,
    publicItems: [],
    privateItems: next.map((id) => ['e', id]),
  });
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
