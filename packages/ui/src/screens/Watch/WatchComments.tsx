/**
 * Watch — NIP-22 comments (build-plan §6.1): sort Newest / Top, one reply level, a composer
 * for signed-in viewers, "More comments" paging. Every comment body goes through the L4
 * `Markdown` subset — never raw HTML. Owns its own fetches; cancels on unmount / sort change.
 * The screen keys it by video id, so a new video starts clean (Newest, no half-written reply).
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type { Comment, NetworkAdapter, NostrEventId, NostrPubkey } from '@sovit/core';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  Markdown,
  ProfileAvatar,
  Skeleton,
  cx,
  formatInteger,
  formatRelativeTime,
  shortPubkey,
} from '../../components/index.js';
import { buildCommentThreads, describeWatchError, type Me } from './model.js';
import type { Resolvers } from './useResolvers.js';

export type CommentSort = 'new' | 'top';

interface CommentsState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly items: readonly Comment[];
  readonly next: string | undefined;
  readonly error: unknown;
  readonly more: 'idle' | 'loading' | 'error';
}

const LOADING: CommentsState = {
  status: 'loading',
  items: [],
  next: undefined,
  error: undefined,
  more: 'idle',
};

export interface WatchCommentsProps {
  readonly adapter: NetworkAdapter;
  readonly videoId: NostrEventId;
  readonly me: Me;
  readonly nowSec: number;
  /** `VideoStats.comments` when known — the heading count before/while paging. */
  readonly totalHint: number | undefined;
  readonly resolvers: Pick<Resolvers, 'profiles' | 'avatars' | 'resolveProfile'>;
  readonly onOpenChannel: (pubkey: NostrPubkey) => void;
  /** Signed-out call to action ("Connect signer" → Settings). */
  readonly onSignIn: () => void;
  readonly onError: (title: string, detail?: string) => void;
  /** DOM id prefix (from the screen's `useId`). */
  readonly idPrefix: string;
}

export function WatchComments({
  adapter,
  videoId,
  me,
  nowSec,
  totalHint,
  resolvers,
  onOpenChannel,
  onSignIn,
  onError,
  idPrefix,
}: WatchCommentsProps): ReactElement {
  const { profiles, avatars, resolveProfile } = resolvers;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [sort, setSort] = useState<CommentSort>('new');
  const [state, setState] = useState<CommentsState>(LOADING);
  const [gen, setGen] = useState(0);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<NostrEventId | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (typeof me === 'string' && me !== 'pending') resolveProfile(me);
  }, [me, resolveProfile]);

  useEffect(() => {
    const ac = new AbortController();
    setState(LOADING);
    adapter.comments(videoId, sort).then(
      (page) => {
        if (ac.signal.aborted) return;
        setState({
          status: 'ready',
          items: page.items,
          next: page.next,
          error: undefined,
          more: 'idle',
        });
        for (const c of page.items) resolveProfile(c.author);
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setState({ ...LOADING, status: 'error', error: err });
      },
    );
    return () => {
      ac.abort();
    };
  }, [adapter, videoId, sort, gen, resolveProfile]);

  const loadMore = useCallback((): void => {
    const cursor = state.next;
    if (cursor === undefined || state.more === 'loading') return;
    setState((prev) => ({ ...prev, more: 'loading' }));
    adapter.comments(videoId, sort, cursor).then(
      (page) => {
        if (!alive.current) return;
        setState((prev) => {
          const seen = new Set(prev.items.map((c) => c.id));
          return {
            ...prev,
            items: [...prev.items, ...page.items.filter((c) => !seen.has(c.id))],
            next: page.next,
            more: 'idle',
          };
        });
        for (const c of page.items) resolveProfile(c.author);
      },
      () => {
        if (alive.current) setState((prev) => ({ ...prev, more: 'error' }));
      },
    );
  }, [adapter, videoId, sort, state.next, state.more, resolveProfile]);

  const submit = useCallback(
    (content: string, parent?: NostrEventId): void => {
      const text = content.trim();
      if (text === '' || posting) return;
      if (me === null || me === 'pending') {
        onSignIn();
        return;
      }
      setPosting(true);
      adapter.comment(videoId, text, parent).then(
        () => {
          if (!alive.current) return;
          setPosting(false);
          if (parent === undefined) setDraft('');
          setReplyDraft('');
          setReplyTo(null);
          setGen((g) => g + 1);
        },
        (err: unknown) => {
          if (!alive.current) return;
          setPosting(false);
          onError('Comment failed', err instanceof Error ? err.message : String(err));
        },
      );
    },
    [adapter, videoId, me, posting, onSignIn, onError],
  );

  const threads = buildCommentThreads(state.items);
  const count = Math.max(totalHint ?? 0, state.items.length);
  const signedIn = me !== null && me !== 'pending';
  const headingId = `${idPrefix}-comments`;

  const renderComment = (c: Comment, isReply: boolean): ReactElement => {
    const p = profiles[c.author] ?? null;
    const name = p?.displayName ?? p?.name ?? shortPubkey(c.author);
    return (
      <article
        className={cx('nf-watch__comment', isReply && 'nf-watch__comment--reply')}
        aria-label={`Comment by ${name}`}
      >
        <button
          type="button"
          className="nf-watch__comment-avatar"
          aria-label={`${name} — open channel`}
          onClick={() => {
            onOpenChannel(c.author);
          }}
        >
          <ProfileAvatar
            profile={p ?? { pubkey: c.author }}
            src={avatars[c.author]}
            size={isReply ? 'sm' : 'md'}
          />
        </button>
        <div className="nf-watch__comment-text">
          <div className="nf-watch__comment-head">
            <button
              type="button"
              className="nf-watch__comment-author"
              onClick={() => {
                onOpenChannel(c.author);
              }}
            >
              {name}
            </button>
            {p?.nip05Status === 'verified' ? (
              <Icon name="verified" size={14} label="NIP-05 verified" />
            ) : null}
            <span className="nf-watch__comment-time">
              {formatRelativeTime(c.createdAt, nowSec)}
            </span>
          </div>
          <Markdown source={c.content} className="nf-watch__comment-body" />
          <div className="nf-watch__comment-meta">
            {c.reactions > 0 ? (
              <span className="nf-watch__comment-reactions">
                {formatInteger(c.reactions)} {c.reactions === 1 ? 'reaction' : 'reactions'}
              </span>
            ) : null}
            {!isReply && signedIn ? (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={replyTo === c.id}
                onClick={() => {
                  setReplyTo((cur) => (cur === c.id ? null : c.id));
                  setReplyDraft('');
                }}
              >
                Reply
              </Button>
            ) : null}
          </div>
          {replyTo === c.id ? (
            <div className="nf-watch__composer nf-watch__composer--reply">
              <div className="nf-watch__composer-body">
                <label className="nf-watch__sr" htmlFor={`${idPrefix}-reply-${c.id}`}>
                  Reply to {name}
                </label>
                <textarea
                  id={`${idPrefix}-reply-${c.id}`}
                  className="nf-watch__input"
                  rows={2}
                  placeholder={`Reply to ${name}…`}
                  value={replyDraft}
                  onChange={(e) => {
                    setReplyDraft(e.target.value);
                  }}
                />
                <div className="nf-watch__composer-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setReplyTo(null);
                      setReplyDraft('');
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={replyDraft.trim() === ''}
                    loading={posting}
                    onClick={() => {
                      submit(replyDraft, c.id);
                    }}
                  >
                    Reply
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <section className="nf-watch__comments" aria-labelledby={headingId}>
      <div className="nf-watch__comments-head">
        <h2 id={headingId} className="nf-watch__comments-title">
          {count > 0
            ? `${formatInteger(count)} ${count === 1 ? 'comment' : 'comments'}`
            : 'Comments'}
        </h2>
        <div className="nf-watch__comments-sort" role="group" aria-label="Sort comments">
          <Button
            size="sm"
            variant={sort === 'new' ? 'primary' : 'secondary'}
            pressed={sort === 'new'}
            onClick={() => {
              setSort('new');
            }}
          >
            Newest
          </Button>
          <Button
            size="sm"
            variant={sort === 'top' ? 'primary' : 'secondary'}
            pressed={sort === 'top'}
            onClick={() => {
              setSort('top');
            }}
          >
            Top
          </Button>
        </div>
      </div>

      {me === null ? (
        <div className="nf-watch__signin">
          <Icon name="key" size={20} />
          <p className="nf-watch__signin-text">
            Comments are Nostr notes (NIP-22). Connect a signer to join the conversation.
          </p>
          <Button variant="secondary" size="sm" onClick={onSignIn}>
            Connect signer
          </Button>
        </div>
      ) : me === 'pending' ? null : (
        <div className="nf-watch__composer">
          <ProfileAvatar profile={profiles[me] ?? { pubkey: me }} src={avatars[me]} size="md" />
          <div className="nf-watch__composer-body">
            <label className="nf-watch__sr" htmlFor={`${idPrefix}-comment`}>
              Add a comment
            </label>
            <textarea
              id={`${idPrefix}-comment`}
              className="nf-watch__input"
              rows={1}
              placeholder="Add a comment…"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
            />
            {draft !== '' ? (
              <div className="nf-watch__composer-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={draft.trim() === ''}
                  loading={posting}
                  onClick={() => {
                    submit(draft);
                  }}
                >
                  Comment
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {state.status === 'loading' ? (
        <div className="nf-watch__comments-loading" aria-busy="true" aria-label="Loading comments">
          {[0, 1, 2].map((i) => (
            <div key={i} className="nf-watch__comment">
              <Skeleton variant="circle" width={40} height={40} />
              <div className="nf-watch__comment-text">
                <Skeleton variant="text" width="30%" height={12} />
                <Skeleton variant="text" width="85%" height={14} />
              </div>
            </div>
          ))}
        </div>
      ) : state.status === 'error' ? (
        <ErrorState
          compact
          title={describeWatchError(state.error).title}
          description="Comments could not be loaded."
          detail={describeWatchError(state.error).detail}
          onRetry={() => {
            setGen((g) => g + 1);
          }}
        />
      ) : threads.length === 0 ? (
        <EmptyState preset="no-comments" compact />
      ) : (
        <ol className="nf-watch__comment-list">
          {threads.map((t) => (
            <li key={t.root.id} className="nf-watch__thread">
              {renderComment(t.root, false)}
              {t.replies.length > 0 ? (
                <ul className="nf-watch__replies" aria-label="Replies">
                  {t.replies.map((r) => (
                    <li key={r.id}>{renderComment(r, true)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {state.more === 'error' ? (
        <ErrorState compact title="Could not load more comments" onRetry={loadMore} />
      ) : null}
      {state.status === 'ready' && state.next !== undefined && state.more !== 'error' ? (
        <div className="nf-watch__comments-more">
          <Button variant="secondary" loading={state.more === 'loading'} onClick={loadMore}>
            More comments
          </Button>
        </div>
      ) : null}
    </section>
  );
}
