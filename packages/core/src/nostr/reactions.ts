/**
 * NIP-25 reactions (kind 7). `+`/`` = like, `-` = dislike, anything else = emoji.
 * Counting is per unique pubkey; a pubkey's NEWEST reaction to a target wins.
 */
import type {
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  NostrTag,
  UnixSeconds,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { byNewest, isHex64, tagsNamed } from './event.js';
import type { EventDraft, EventRef } from './types.js';

export type ReactionKind = 'like' | 'dislike' | 'emoji';

export interface ParsedReaction {
  readonly id: NostrEventId;
  readonly author: NostrPubkey;
  readonly target: NostrEventId;
  readonly targetAuthor?: NostrPubkey;
  readonly content: string;
  readonly kind: ReactionKind;
  readonly createdAt: UnixSeconds;
  readonly event: NostrEvent;
}

export function classifyReaction(content: string): ReactionKind {
  if (content === '+' || content === '') return 'like';
  if (content === '-') return 'dislike';
  return 'emoji';
}

export function buildReactionEvent(
  target: EventRef,
  content: string,
  createdAt: UnixSeconds,
): EventDraft {
  const tags: NostrTag[] = [
    ['e', target.id, target.relayHint ?? '', target.pubkey],
    ['p', target.pubkey],
    ['k', String(target.kind)],
  ];
  return { kind: NostrKind.Reaction, created_at: createdAt, tags, content };
}

/** Parse a VERIFIED kind-7 event. NIP-25: the target is the LAST `e` tag. */
export function parseReaction(ev: NostrEvent): ParsedReaction | null {
  if (ev.kind !== NostrKind.Reaction) return null;
  const e = tagsNamed(ev, 'e').at(-1);
  const target = e?.[1];
  if (target === undefined || !isHex64(target)) return null;
  const p = tagsNamed(ev, 'p').at(-1)?.[1];
  return {
    id: ev.id,
    author: ev.pubkey,
    target: target as NostrEventId,
    ...(p !== undefined && isHex64(p) ? { targetAuthor: p as NostrPubkey } : {}),
    content: ev.content,
    kind: classifyReaction(ev.content),
    createdAt: ev.created_at as UnixSeconds,
    event: ev,
  };
}

export interface ReactionSummary {
  readonly likes: number;
  readonly dislikes: number;
  /** emoji → count */
  readonly emoji: ReadonlyMap<string, number>;
  /** What `viewer` (if given) currently has on the target. */
  readonly mine?: ParsedReaction;
}

/** Reduce verified reactions to per-pubkey newest, then count. Pure. */
export function summarizeReactions(
  reactions: readonly ParsedReaction[],
  viewer?: NostrPubkey,
): ReactionSummary {
  const newest = new Map<string, ParsedReaction>();
  for (const r of reactions) {
    const cur = newest.get(r.author);
    if (!cur || byNewest(r.event, cur.event) < 0) newest.set(r.author, r);
  }
  let likes = 0;
  let dislikes = 0;
  const emoji = new Map<string, number>();
  for (const r of newest.values()) {
    if (r.kind === 'like') likes += 1;
    else if (r.kind === 'dislike') dislikes += 1;
    else emoji.set(r.content, (emoji.get(r.content) ?? 0) + 1);
  }
  const mine = viewer === undefined ? undefined : newest.get(viewer);
  return { likes, dislikes, emoji, ...(mine ? { mine } : {}) };
}

export async function fetchReactions(
  client: NostrClient,
  target: NostrEventId,
  viewer?: NostrPubkey,
): Promise<ReactionSummary> {
  const events = await client.query({ kinds: [NostrKind.Reaction], '#e': [target] });
  const parsed = events.flatMap((ev) => {
    const r = parseReaction(ev);
    return r?.target === target ? [r] : [];
  });
  return summarizeReactions(parsed, viewer);
}

const CHUNK = 100;

/** Like counts for many targets in one go (chunked `#e` queries). */
export async function countLikesByTarget(
  client: NostrClient,
  targets: readonly NostrEventId[],
): Promise<ReadonlyMap<NostrEventId, number>> {
  const out = new Map<NostrEventId, number>();
  if (targets.length === 0) return out;
  const wanted = new Set(targets);
  const byTarget = new Map<NostrEventId, ParsedReaction[]>();
  for (let i = 0; i < targets.length; i += CHUNK) {
    const events = await client.query({
      kinds: [NostrKind.Reaction],
      '#e': targets.slice(i, i + CHUNK),
    });
    for (const ev of events) {
      const r = parseReaction(ev);
      if (!r || !wanted.has(r.target)) continue;
      const list = byTarget.get(r.target) ?? [];
      list.push(r);
      byTarget.set(r.target, list);
    }
  }
  for (const [id, list] of byTarget) out.set(id, summarizeReactions(list).likes);
  return out;
}

/** Sign + publish a reaction to `target`. NIP-25 content: `+`, `-` or an emoji. */
export async function react(
  client: NostrClient,
  target: EventRef,
  content = '+',
): Promise<NostrEvent> {
  return (await client.publish(buildReactionEvent(target, content, client.now()))).event;
}
