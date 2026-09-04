/**
 * The verification boundary (T9) and small event/tag helpers.
 *
 * `verifyIncoming` is the ONLY function in this package that turns an untrusted object
 * into a `NostrEvent`. Every read path goes through it. Signature checking is delegated
 * to `nostr-tools` (`verifyEvent`); nothing here touches curves or hashes.
 */
import type { Event as WireEvent } from 'nostr-tools/core';
import { validateEvent, verifyEvent } from 'nostr-tools/pure';

import type {
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  NostrTag,
  UnixSeconds,
} from '../contracts/index.js';
import type { DropReason } from './types.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export const isHex64 = (s: string): boolean => HEX64.test(s);

/** Shape check for every tag: non-empty array of strings (contract `NostrTag`, T15). */
export function isWellFormedTag(tag: unknown): tag is NostrTag {
  return Array.isArray(tag) && tag.length > 0 && tag.every((v) => typeof v === 'string');
}

/**
 * Validate shape, then signature, of an object that came off the wire (or out of an
 * in-memory relay). Returns a frozen, freshly-built copy on success — never the input.
 *
 * Why a fresh copy: `nostr-tools` caches its verdict on the object under a symbol key,
 * and object spread copies symbol-keyed properties, so a tampered `{ ...verified,
 * content: 'x' }` would otherwise be reported as verified. Rebuilding from primitives
 * discards any such cache (and any prototype or extra properties) before checking.
 */
export function verifyIncoming(raw: unknown): NostrEvent | null {
  return classifyIncoming(raw).event;
}

export function classifyIncoming(
  raw: unknown,
):
  | { readonly event: NostrEvent; readonly reason?: undefined }
  | { readonly event: null; readonly reason: DropReason } {
  // `validateEvent` checks kind/content/created_at/pubkey types, pubkey hex32, and that
  // tags is an array of string arrays. It does not look at id/sig or tag emptiness.
  if (!validateEvent(raw)) return { event: null, reason: 'malformed' };
  const extra = raw as unknown as Record<string, unknown>;
  const id = extra['id'];
  const sig = extra['sig'];
  if (typeof id !== 'string' || !HEX64.test(id)) return { event: null, reason: 'malformed' };
  if (typeof sig !== 'string' || !HEX128.test(sig)) return { event: null, reason: 'malformed' };
  if (!Number.isInteger(raw.created_at) || raw.created_at < 0) {
    return { event: null, reason: 'malformed' };
  }
  if (!Number.isInteger(raw.kind) || raw.kind < 0 || raw.kind > 65_535) {
    return { event: null, reason: 'malformed' };
  }
  const tags: string[][] = [];
  for (const t of raw.tags) {
    if (!isWellFormedTag(t)) return { event: null, reason: 'bad-tag' };
    tags.push([...t]);
  }
  // Fresh plain object: no symbol cache, no prototype, no extra keys.
  const fresh: WireEvent = {
    id,
    pubkey: raw.pubkey,
    kind: raw.kind,
    created_at: raw.created_at,
    tags,
    content: raw.content,
    sig,
  };
  if (!verifyEvent(fresh)) return { event: null, reason: 'bad-signature' };
  for (const t of tags) Object.freeze(t);
  Object.freeze(tags);
  const event: NostrEvent = Object.freeze({
    id: fresh.id as NostrEventId,
    pubkey: fresh.pubkey as NostrPubkey,
    kind: fresh.kind,
    created_at: fresh.created_at,
    tags,
    content: fresh.content,
    sig: fresh.sig,
  });
  return { event };
}

/** Mutable copy in the exact shape `nostr-tools` wants (it types tags as `string[][]`). */
export function toWire(ev: NostrEvent): WireEvent {
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    kind: ev.kind,
    created_at: ev.created_at,
    tags: ev.tags.map((t) => [...t]),
    content: ev.content,
    sig: ev.sig,
  };
}

/** First value of the first tag named `name`, or `undefined`. */
export function tagValue(
  ev: { readonly tags: readonly NostrTag[] },
  name: string,
): string | undefined {
  for (const t of ev.tags) if (t[0] === name) return t[1];
  return undefined;
}

/** All first values of tags named `name`, in order, skipping tags with no value. */
export function tagValues(ev: { readonly tags: readonly NostrTag[] }, name: string): string[] {
  const out: string[] = [];
  for (const t of ev.tags) if (t[0] === name && t[1] !== undefined) out.push(t[1]);
  return out;
}

/** All tags named `name`, in order. */
export function tagsNamed(ev: { readonly tags: readonly NostrTag[] }, name: string): NostrTag[] {
  return ev.tags.filter((t) => t[0] === name);
}

export const nowSeconds = (): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds;

/** Newest first; ties broken by id so ordering is deterministic. */
export function byNewest(a: NostrEvent, b: NostrEvent): number {
  return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Keep only the newest event per key (replaceable-event semantics for a result set). */
export function newestPer(
  events: readonly NostrEvent[],
  key: (ev: NostrEvent) => string,
): NostrEvent[] {
  const best = new Map<string, NostrEvent>();
  for (const ev of events) {
    const k = key(ev);
    const cur = best.get(k);
    if (!cur || byNewest(ev, cur) < 0) best.set(k, ev);
  }
  return [...best.values()];
}

/** Dedupe by id, preserving first occurrence. */
export function dedupeById(events: readonly NostrEvent[]): NostrEvent[] {
  const seen = new Set<string>();
  const out: NostrEvent[] = [];
  for (const ev of events) {
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.push(ev);
  }
  return out;
}

/** Parses a non-negative integer written in decimal; `undefined` for anything else. */
export function parseUint(s: string | undefined): number | undefined {
  if (s === undefined || !/^\d{1,15}$/.test(s)) return undefined;
  return Number(s);
}
