/**
 * Kind 0 profiles (channels) + NIP-05 verification state.
 *
 * `nip05Status` is `verified` ONLY after a live lookup for this exact pubkey succeeded
 * (T9: the UI shows the verified pubkey/NIP-05, not just a display name).
 */
import type { NostrEvent, NostrPubkey, Profile, UnixSeconds } from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { verifyNip05 } from './nip05.js';
import type { EventDraft, FetchLike } from './types.js';

/** Editable profile fields; the `kind 0` content is the JSON of exactly these keys. */
export interface ProfileInput {
  readonly name?: string;
  readonly displayName?: string;
  readonly about?: string;
  readonly picture?: string;
  readonly banner?: string;
  readonly nip05?: string;
  readonly lud16?: string;
}

const str = (o: Record<string, unknown>, k: string): string | undefined => {
  const v = o[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
};

/** Parse a VERIFIED kind-0 event. Returns `null` for the wrong kind or non-object JSON. */
export function parseProfile(ev: NostrEvent, fetchedAt: UnixSeconds): Profile | null {
  if (ev.kind !== NostrKind.Profile) return null;
  let json: unknown;
  try {
    json = JSON.parse(ev.content) as unknown;
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const nip05 = str(o, 'nip05');
  const p: Profile = {
    pubkey: ev.pubkey,
    nip05Status: nip05 === undefined ? 'none' : 'unverified',
    fetchedAt,
    ...opt('name', str(o, 'name')),
    ...opt('displayName', str(o, 'display_name') ?? str(o, 'displayName')),
    ...opt('about', str(o, 'about')),
    ...opt('picture', str(o, 'picture')),
    ...opt('banner', str(o, 'banner')),
    ...opt('nip05', nip05),
    ...opt('lud16', str(o, 'lud16')),
  };
  return p;
}

function opt<K extends string, V>(k: K, v: V | undefined): Partial<Record<K, V>> {
  return v === undefined ? {} : ({ [k]: v } as Record<K, V>);
}

export function buildProfileEvent(input: ProfileInput, createdAt: UnixSeconds): EventDraft {
  const content: Record<string, string> = {};
  if (input.name !== undefined) content['name'] = input.name;
  if (input.displayName !== undefined) content['display_name'] = input.displayName;
  if (input.about !== undefined) content['about'] = input.about;
  if (input.picture !== undefined) content['picture'] = input.picture;
  if (input.banner !== undefined) content['banner'] = input.banner;
  if (input.nip05 !== undefined) content['nip05'] = input.nip05;
  if (input.lud16 !== undefined) content['lud16'] = input.lud16;
  return {
    kind: NostrKind.Profile,
    created_at: createdAt,
    tags: [],
    content: JSON.stringify(content),
  };
}

/** Run the NIP-05 lookup for a parsed profile and return it with the resulting status. */
export async function withNip05Status(profile: Profile, fetch: FetchLike): Promise<Profile> {
  if (profile.nip05 === undefined) return { ...profile, nip05Status: 'none' };
  const ok = await verifyNip05(profile.nip05, profile.pubkey, fetch);
  return { ...profile, nip05Status: ok ? 'verified' : 'failed' };
}

export interface FetchProfileOptions {
  /** When given, the NIP-05 lookup runs and the status is `verified`/`failed`. */
  readonly fetch?: FetchLike;
}

/** Newest kind 0 for `pubkey` from the read relays, verified; `null` if none. */
export async function fetchProfile(
  client: NostrClient,
  pubkey: NostrPubkey,
  opts: FetchProfileOptions = {},
): Promise<Profile | null> {
  const ev = await client.queryOne({ kinds: [NostrKind.Profile], authors: [pubkey] });
  if (!ev) return null;
  const p = parseProfile(ev, client.now());
  if (!p) return null;
  return opts.fetch ? withNip05Status(p, opts.fetch) : p;
}

/** Batch variant: one query, newest event per author. Missing authors are absent from the map. */
export async function fetchProfiles(
  client: NostrClient,
  pubkeys: readonly NostrPubkey[],
): Promise<ReadonlyMap<NostrPubkey, Profile>> {
  const out = new Map<NostrPubkey, Profile>();
  if (pubkeys.length === 0) return out;
  const evs = await client.query({ kinds: [NostrKind.Profile], authors: [...new Set(pubkeys)] });
  const now = client.now();
  for (const ev of evs) {
    if (out.has(ev.pubkey)) continue; // newest-first ordering: first hit wins
    const p = parseProfile(ev, now);
    if (p) out.set(ev.pubkey, p);
  }
  return out;
}

/** Publish (replace) our own kind 0. */
export async function publishProfile(
  client: NostrClient,
  input: ProfileInput,
): Promise<NostrEvent> {
  return (await client.publish(buildProfileEvent(input, client.now()))).event;
}
