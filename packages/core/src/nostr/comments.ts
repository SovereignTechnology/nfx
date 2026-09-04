/**
 * NIP-22 comments (kind 1111) on videos.
 *
 * Videos here are REGULAR events (kind 21/22), so the root scope is an `E` tag (id +
 * author) with `K` = video kind and `P` = video author — not `A`, which NIP-22 reserves
 * for addressable events (build-plan §2.2 says "A/a"; the fixtures use `A`; the spec
 * says `E`/`e` for kinds 21/22 — see docs/lanes/L1.md). Parse accepts both.
 *
 * Top-level:  e = video id,      k = video kind, p = video author
 * Reply:      e = parent comment, k = 1111,       p = parent author
 */
import type {
  Comment,
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  NostrTag,
  Page,
  UnixSeconds,
} from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import { applyTimeCursor, decodeTimeCursor, encodeTimeCursor } from './cursor.js';
import { byNewest, isHex64, tagsNamed } from './event.js';
import { countLikesByTarget } from './reactions.js';
import type { EventDraft, EventRef, Unsubscribe } from './types.js';

export interface CommentInput {
  readonly video: EventRef;
  readonly content: string;
  /** Reply target; omit for a top-level comment. */
  readonly parent?: EventRef;
}

export function buildCommentEvent(input: CommentInput, createdAt: UnixSeconds): EventDraft {
  const v = input.video;
  const hint = v.relayHint ?? '';
  const parent = input.parent;
  const tags: NostrTag[] = [
    ['E', v.id, hint, v.pubkey],
    ['K', String(v.kind)],
    ['P', v.pubkey],
  ];
  if (parent) {
    tags.push(['e', parent.id, parent.relayHint ?? '', parent.pubkey]);
    tags.push(['k', String(parent.kind)]);
    tags.push(['p', parent.pubkey]);
  } else {
    tags.push(['e', v.id, hint, v.pubkey]);
    tags.push(['k', String(v.kind)]);
    tags.push(['p', v.pubkey]);
  }
  return { kind: NostrKind.Comment, created_at: createdAt, tags, content: input.content };
}

export interface ParsedComment {
  readonly id: NostrEventId;
  readonly author: NostrPubkey;
  readonly content: string;
  readonly createdAt: UnixSeconds;
  /** Root video id from `E` (or a legacy `A` of the form `<kind>:<id>`). */
  readonly rootId: NostrEventId;
  readonly rootKind?: number;
  /** Parent comment id when this is a reply; absent for top-level comments. */
  readonly parent?: NostrEventId;
  readonly event: NostrEvent;
}

function rootFromTags(ev: NostrEvent): NostrEventId | undefined {
  const E = tagsNamed(ev, 'E').at(-1)?.[1];
  if (E !== undefined && isHex64(E)) return E as NostrEventId;
  // Legacy/fixture shape: ["A", "<kind>:<event-id>"] — not a real NIP-01 address, but
  // the mock adapter emits it, so read it leniently.
  const A = tagsNamed(ev, 'A').at(-1)?.[1];
  if (A !== undefined) {
    const m = /^\d+:([0-9a-f]{64})$/.exec(A);
    if (m) return m[1] as NostrEventId;
  }
  return undefined;
}

/** Parse a VERIFIED kind-1111 event. `null` if it is not a comment on a regular event. */
export function parseComment(ev: NostrEvent): ParsedComment | null {
  if (ev.kind !== NostrKind.Comment) return null;
  const rootId = rootFromTags(ev);
  if (rootId === undefined) return null;
  const K = tagsNamed(ev, 'K').at(-1)?.[1];
  const rootKind = K !== undefined && /^\d{1,5}$/.test(K) ? Number(K) : undefined;
  const e = tagsNamed(ev, 'e').at(-1)?.[1];
  const k = tagsNamed(ev, 'k').at(-1)?.[1];
  const parent =
    e !== undefined && isHex64(e) && e !== rootId && k === String(NostrKind.Comment)
      ? (e as NostrEventId)
      : undefined;
  return {
    id: ev.id,
    author: ev.pubkey,
    content: ev.content,
    createdAt: ev.created_at as UnixSeconds,
    rootId,
    ...(rootKind === undefined ? {} : { rootKind }),
    ...(parent === undefined ? {} : { parent }),
    event: ev,
  };
}

export interface CommentsOptions {
  readonly sort?: 'new' | 'top' | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

const DEFAULT_LIMIT = 50;

/**
 * Comments on `videoId`, verified, with like counts (kind 7 `+`, unique pubkeys).
 * `top` sorts by likes then recency; the cursor is time-based in both modes, so `top`
 * is "top of the newest N" — an honest approximation without a server-side index.
 */
export async function fetchComments(
  client: NostrClient,
  videoId: NostrEventId,
  opts: CommentsOptions = {},
): Promise<Page<Comment>> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const cursor = decodeTimeCursor(opts.cursor);
  const base = { kinds: [NostrKind.Comment], '#E': [videoId], limit: limit + 5 } as const;
  const applied = applyTimeCursor(base, cursor);
  const events = (await client.query(applied.filter)).filter(applied.keep);
  const parsed: ParsedComment[] = [];
  const consumed: NostrEvent[] = [];
  for (const ev of events) {
    const c = parseComment(ev);
    if (c?.rootId !== videoId) continue;
    parsed.push(c);
    consumed.push(ev);
    if (parsed.length === limit) break;
  }
  const likes = await countLikesByTarget(
    client,
    parsed.map((c) => c.id),
  );
  const items: Comment[] = parsed.map((c) => ({
    id: c.id,
    author: c.author,
    content: c.content,
    createdAt: c.createdAt,
    ...(c.parent === undefined ? {} : { parent: c.parent }),
    reactions: likes.get(c.id) ?? 0,
    event: c.event,
  }));
  if (opts.sort === 'top')
    items.sort((a, b) => b.reactions - a.reactions || b.createdAt - a.createdAt);
  const next = parsed.length === limit ? encodeTimeCursor(consumed.sort(byNewest)) : undefined;
  return next === undefined ? { items } : { items, next };
}

/** Sign + publish a comment; returns it in `Comment` shape with 0 reactions. */
export async function postComment(client: NostrClient, input: CommentInput): Promise<Comment> {
  const { event } = await client.publish(buildCommentEvent(input, client.now()));
  return {
    id: event.id,
    author: event.pubkey,
    content: event.content,
    createdAt: event.created_at as UnixSeconds,
    ...(input.parent ? { parent: input.parent.id } : {}),
    reactions: 0,
    event,
  };
}

/** Live: replies to comments authored by `me` (NIP-22 `p` tag = parent author). */
export function watchReplies(
  client: NostrClient,
  me: NostrPubkey,
  since: UnixSeconds,
  onReply: (c: ParsedComment) => void,
): Unsubscribe {
  return client.subscribe([{ kinds: [NostrKind.Comment], '#p': [me], since }], (ev) => {
    const c = parseComment(ev);
    if (c?.parent !== undefined && c.author !== me) onReply(c);
  });
}
