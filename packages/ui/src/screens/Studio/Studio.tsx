/**
 * Studio screen (build-plan §6.1 row "Studio", §6.4 upload pipeline): a creator's workspace
 * behind four chip tabs — Upload, Videos, Analytics, Seeder — backed by
 * `adapter.studio.{upload, myVideos, analytics}` and `adapter.seeder.*`.
 *
 * Talks ONLY to `NetworkAdapter`; renders ONLY `@sovit/ui` components + semantic HTML.
 * Images pass through `adapter.image` (T16). Every price is a `SatsBadge` that precedes the
 * control that would open the video. Studio needs a signer: signed out, it shows the
 * `signer-not-detected` state and nothing else.
 *
 * The upload form and a running upload live HERE (not in the Upload panel), so switching
 * Studio tabs keeps both. A shell must keep `Studio` mounted across `studio` routes (render
 * it at the same place; do not key it by tab) or an in-flight upload's progress view is
 * lost — the upload itself keeps running in the adapter either way (v3 has no cancel).
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import type {
  MintUrl,
  NostrEventId,
  NostrPubkey,
  UnixSeconds,
  UploadInput,
  VideoManifest,
} from '@sovit/core';
import { Button, EmptyState, ErrorState, Skeleton, cx } from '../../components/index.js';
import type { Route, ScreenProps } from '../shared/route.js';
import { AnalyticsPanel } from './AnalyticsPanel.js';
import {
  EMPTY_DRAFT,
  IDLE_RUN,
  INITIAL_PROGRESS,
  describeStudioError,
  errorMessage,
  failProgress,
  reduceUploadProgress,
  titleFromFileName,
  toUploadInput,
  type StudioDraft,
  type StudioFile,
  type UploadRun,
} from './model.js';
import type { FfmpegStatus } from './parts.js';
import { SeederPanel } from './SeederPanel.js';
import { UploadPanel, uploadStatusLabel, type ResolveUploadFile } from './UploadPanel.js';
import { EMPTY_VIDEOS, VideosPanel, type VideosState } from './VideosPanel.js';

/** The four Studio tabs; kept in sync with `Route['tab']` for `name: 'studio'`. */
export type StudioTab = NonNullable<Extract<Route, { readonly name: 'studio' }>['tab']>;

export const STUDIO_TABS: readonly { readonly id: StudioTab; readonly label: string }[] = [
  { id: 'upload', label: 'Upload' },
  { id: 'videos', label: 'Videos' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'seeder', label: 'Seeder' },
];

export interface StudioProps extends ScreenProps {
  /** Initial/controlled tab (`Route['tab']`); default `upload`. A changed prop is followed. */
  readonly tab?: StudioTab | undefined;
  /**
   * The shell's system-ffmpeg probe (ADR 0005; L6). `found: false` shows the "ffmpeg not
   * found" state instead of the upload form, before anything is filled in. Omitted = the
   * screen learns it only from an upload that fails with `ffmpeg-not-found`.
   */
  readonly ffmpeg?: FfmpegStatus | undefined;
  /** Re-run the shell's probe ("Check again" on the ffmpeg state). */
  readonly onRecheckFfmpeg?: (() => void) | undefined;
  /**
   * Turns a picked/dropped DOM `File` into `UploadInput.file`. Desktop MUST pass this: under
   * Electron's sandbox a `File` has no path, so the shell maps it with its preload (e.g.
   * `webUtils.getPathForFile`) to an absolute path. Omitted = the `File` itself is used
   * (web: it is a `FileLike`).
   */
  readonly resolveFile?: ResolveUploadFile | undefined;
  /** A file the shell hands over already resolved (dropped on the window, "Open with…"). */
  readonly pendingFile?: StudioFile | undefined;
  /** Blossom servers to pre-fill in "Mirrors" (e.g. the user's gateway). */
  readonly mirrorServers?: readonly string[] | undefined;
  /** "now" for relative times; stories/tests pin it. */
  readonly now?: UnixSeconds | number | undefined;
  /** Melt-out confirm sheet in flow instead of fixed (Storybook/embedding). */
  readonly inlineSheet?: boolean | undefined;
  readonly className?: string | undefined;
}

/** `'pending'` until `adapter.me()` answers; `null` = signed out. */
type Me = 'pending' | NostrPubkey | null;

function draftFor(
  file: StudioFile | undefined,
  mirrors: readonly string[] | undefined,
): StudioDraft {
  return {
    ...EMPTY_DRAFT,
    file,
    title: file ? titleFromFileName(file.name) : '',
    mirrors: mirrors?.join('\n') ?? '',
  };
}

export function Studio({
  adapter,
  navigate,
  miniPlayer,
  tab,
  ffmpeg,
  onRecheckFfmpeg,
  resolveFile,
  pendingFile,
  mirrorServers,
  now,
  inlineSheet,
  className,
}: StudioProps): ReactElement {
  const id = useId();
  const nowSec = now ?? Math.floor(Date.now() / 1000);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // ---- tab -------------------------------------------------------------------------
  const [activeTab, setActiveTab] = useState<StudioTab>(tab ?? 'upload');
  useEffect(() => {
    if (tab !== undefined) setActiveTab(tab);
  }, [tab]);
  const selectTab = useCallback(
    (next: StudioTab): void => {
      setActiveTab(next);
      navigate({ name: 'studio', tab: next });
    },
    [navigate],
  );

  // ---- identity --------------------------------------------------------------------
  const [me, setMe] = useState<Me>('pending');
  const [identityError, setIdentityError] = useState<unknown>(undefined);
  const [identityGen, setIdentityGen] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setIdentityError(undefined);
    adapter.me().then(
      (pk) => {
        if (!cancelled) setMe(pk);
      },
      (err: unknown) => {
        if (!cancelled) setIdentityError(err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, identityGen]);
  const signedIn = me !== 'pending' && me !== null;

  // ---- upload form ------------------------------------------------------------------
  const [draft, setDraft] = useState<StudioDraft>(() => draftFor(pendingFile, mirrorServers));
  const mintsTouched = useRef(false);
  const onDraft = useCallback((patch: Partial<StudioDraft>): void => {
    if (patch.mints !== undefined) mintsTouched.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  }, []);
  const onChooseFile = useCallback((file: StudioFile): void => {
    setDraft((d) => ({
      ...d,
      file,
      title: d.title.trim() ? d.title : titleFromFileName(file.name),
    }));
  }, []);

  // A file handed over by the shell after mount replaces the chosen one (idle form only).
  const handedOver = useRef(pendingFile);
  const runRef = useRef<UploadRun>(IDLE_RUN);
  useEffect(() => {
    if (pendingFile === undefined || pendingFile === handedOver.current) return;
    handedOver.current = pendingFile;
    if (runRef.current.phase === 'idle') onChooseFile(pendingFile);
  }, [onChooseFile, pendingFile]);

  // Mints offered: Settings.defaultMints (pre-selected) ∪ wallet mints ∪ added ones.
  const [knownMints, setKnownMints] = useState<readonly MintUrl[]>([]);
  const [defaultMints, setDefaultMints] = useState<readonly MintUrl[]>([]);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void Promise.allSettled([adapter.settings(), adapter.wallet.mints()]).then(
      ([settings, wallet]) => {
        if (cancelled) return;
        const defaults = settings.status === 'fulfilled' ? settings.value.defaultMints : [];
        const held = wallet.status === 'fulfilled' ? wallet.value : [];
        setDefaultMints(defaults);
        setKnownMints((prev) => [...new Set([...defaults, ...held, ...prev])]);
        if (!mintsTouched.current)
          setDraft((d) => (d.mints.length > 0 ? d : { ...d, mints: defaults }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, signedIn]);
  const onAddMint = useCallback((mint: MintUrl): void => {
    setKnownMints((prev) => (prev.includes(mint) ? prev : [...prev, mint]));
  }, []);

  // ---- videos (shared by Videos + Analytics) ---------------------------------------
  const [videos, setVideos] = useState<VideosState>(EMPTY_VIDEOS);
  const videosGen = useRef(0);
  const needVideos = signedIn && (activeTab === 'videos' || activeTab === 'analytics');
  useEffect(() => {
    if (!needVideos || videos.status !== 'idle') return;
    const gen = ++videosGen.current;
    setVideos({ ...EMPTY_VIDEOS, status: 'loading' });
    adapter.studio.myVideos().then(
      (page) => {
        if (alive.current && videosGen.current === gen) {
          setVideos({ ...EMPTY_VIDEOS, status: 'ready', items: page.items, next: page.next });
        }
      },
      (error: unknown) => {
        if (alive.current && videosGen.current === gen) {
          setVideos({ ...EMPTY_VIDEOS, status: 'error', error });
        }
      },
    );
  }, [adapter, needVideos, videos.status]);
  // An unmount mid-load leaves `loading` behind; the gen check drops the late answer.
  useEffect(
    () => () => {
      videosGen.current++;
    },
    [],
  );
  const reloadVideos = useCallback((): void => {
    videosGen.current++;
    setVideos(EMPTY_VIDEOS);
  }, []);
  const loadMoreVideos = useCallback((): void => {
    const cursor = videos.next;
    if (videos.status !== 'ready' || cursor === undefined || videos.more === 'loading') return;
    const gen = videosGen.current;
    setVideos((v) => ({ ...v, more: 'loading', moreError: undefined }));
    adapter.studio.myVideos(cursor).then(
      (page) => {
        if (!alive.current || videosGen.current !== gen) return;
        setVideos((v) => {
          const seen = new Set(v.items.map((x) => x.id));
          return {
            ...v,
            items: [...v.items, ...page.items.filter((x) => !seen.has(x.id))],
            next: page.next,
            more: 'idle',
          };
        });
      },
      (moreError: unknown) => {
        if (alive.current && videosGen.current === gen) {
          setVideos((v) => ({ ...v, more: 'error', moreError }));
        }
      },
    );
  }, [adapter, videos]);
  const [analyticsId, setAnalyticsId] = useState<NostrEventId | undefined>(undefined);
  const openAnalytics = useCallback(
    (videoId: NostrEventId): void => {
      setAnalyticsId(videoId);
      selectTab('analytics');
    },
    [selectTab],
  );

  // ---- upload run -----------------------------------------------------------------
  const [run, setRun] = useState<UploadRun>(IDLE_RUN);
  runRef.current = run;
  const runSeq = useRef(0);
  const startUpload = useCallback(
    (input: UploadInput, file: StudioFile): void => {
      const runId = ++runSeq.current;
      const current = (): boolean => alive.current && runSeq.current === runId;
      setRun({
        phase: 'running',
        id: runId,
        input,
        file,
        progress: INITIAL_PROGRESS,
        video: undefined,
        error: undefined,
      });
      const patch = (fn: (r: Exclude<UploadRun, { phase: 'idle' }>) => UploadRun): void => {
        setRun((prev) => (prev.phase !== 'idle' && prev.id === runId ? fn(prev) : prev));
      };
      let pending: Promise<VideoManifest>;
      try {
        pending = adapter.studio.upload(input, (p) => {
          if (current()) patch((r) => ({ ...r, progress: reduceUploadProgress(r.progress, p) }));
        });
      } catch (err: unknown) {
        pending = Promise.reject(err instanceof Error ? err : new Error(errorMessage(err)));
      }
      pending.then(
        (video) => {
          if (!current()) return;
          patch((r) =>
            r.progress.stage === 'error'
              ? r
              : {
                  ...r,
                  phase: 'done',
                  video,
                  progress: { ...r.progress, stage: 'done', video: r.progress.video ?? video },
                },
          );
          // The new video belongs in Videos/Analytics next time they are shown.
          reloadVideos();
        },
        (error: unknown) => {
          if (!current()) return;
          patch((r) => ({
            ...r,
            phase: 'failed',
            error,
            progress: failProgress(r.progress, errorMessage(error) || undefined),
          }));
        },
      );
    },
    [adapter, reloadVideos],
  );
  const publish = useCallback((): void => {
    const input = toUploadInput(draft);
    if (input === undefined || draft.file === undefined) return;
    startUpload(input, draft.file);
  }, [draft, startUpload]);
  const retry = useCallback((): void => {
    if (run.phase !== 'idle') startUpload(run.input, run.file);
  }, [run, startUpload]);
  const editDetails = useCallback((): void => {
    runSeq.current++;
    setRun(IDLE_RUN);
  }, []);
  const resetUpload = useCallback((): void => {
    runSeq.current++;
    setRun(IDLE_RUN);
    mintsTouched.current = false;
    setDraft({ ...draftFor(undefined, mirrorServers), mints: defaultMints });
  }, [defaultMints, mirrorServers]);

  // ---- tabs keyboard ---------------------------------------------------------------
  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const i = tabs.findIndex((el) => el === document.activeElement);
    if (i < 0) return;
    let nextIndex: number | undefined;
    if (e.key === 'ArrowRight') nextIndex = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIndex = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    e.preventDefault();
    const target = STUDIO_TABS[nextIndex];
    tabs[nextIndex]?.focus();
    if (target) selectTab(target.id);
  };

  const goSettings = (): void => {
    navigate({ name: 'settings' });
  };

  // ---- render ----------------------------------------------------------------------
  const renderPanel = (): ReactElement => {
    if (me === 'pending') {
      return (
        <div className="nf-studio__loading" aria-hidden="true">
          <Skeleton variant="block" height={280} />
          <Skeleton variant="text" width="40%" />
          <Skeleton variant="text" width="65%" />
        </div>
      );
    }
    switch (activeTab) {
      case 'upload':
        return (
          <UploadPanel
            adapter={adapter}
            navigate={navigate}
            draft={draft}
            onDraft={onDraft}
            onChooseFile={onChooseFile}
            knownMints={knownMints}
            onAddMint={onAddMint}
            run={run}
            ffmpeg={ffmpeg}
            onRecheckFfmpeg={onRecheckFfmpeg}
            resolveFile={resolveFile}
            onPublish={publish}
            onRetry={retry}
            onEdit={editDetails}
            onReset={resetUpload}
            onShowVideos={() => {
              selectTab('videos');
            }}
            now={nowSec}
          />
        );
      case 'videos':
        return (
          <VideosPanel
            adapter={adapter}
            navigate={navigate}
            videos={videos}
            onLoadMore={loadMoreVideos}
            onRetry={reloadVideos}
            onUpload={() => {
              selectTab('upload');
            }}
            onAnalytics={openAnalytics}
            now={nowSec}
          />
        );
      case 'analytics':
        return (
          <AnalyticsPanel
            adapter={adapter}
            navigate={navigate}
            videos={videos}
            selected={analyticsId}
            onSelect={setAnalyticsId}
            onRetryVideos={reloadVideos}
            onUpload={() => {
              selectTab('upload');
            }}
            onSeeder={() => {
              selectTab('seeder');
            }}
            now={nowSec}
          />
        );
      case 'seeder':
        return (
          <SeederPanel
            adapter={adapter}
            navigate={navigate}
            now={nowSec}
            inlineSheet={inlineSheet}
          />
        );
    }
  };

  const status = activeTab === 'upload' ? undefined : uploadStatusLabel(run);
  const busy =
    (me === 'pending' && identityError === undefined) ||
    ((activeTab === 'videos' || activeTab === 'analytics') &&
      (videos.status === 'loading' || videos.more === 'loading'));

  let body: ReactElement;
  if (identityError !== undefined) {
    const e = describeStudioError(identityError, 'load');
    body = (
      <ErrorState
        title={e.title}
        description={e.description}
        detail={e.detail}
        onRetry={() => {
          setIdentityGen((g) => g + 1);
        }}
      />
    );
  } else if (me === null) {
    body = (
      <EmptyState
        preset="signer-not-detected"
        title="Sign in to use Studio"
        description="Studio publishes videos signed with your Nostr key and pays seeder earnings out to you. Connect a signer (NIP-07 extension, NIP-46 remote signer, or a local key) to upload."
        onAction={goSettings}
      />
    );
  } else {
    body = (
      <>
        <div className="nf-studio__bar">
          <div
            role="tablist"
            aria-label="Studio sections"
            className="nf-studio__tabs"
            onKeyDown={onTabKeyDown}
          >
            {STUDIO_TABS.map((t) => {
              const selected = t.id === activeTab;
              return (
                <Button
                  key={t.id}
                  id={`${id}-tab-${t.id}`}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${id}-panel`}
                  tabIndex={selected ? 0 : -1}
                  variant={selected ? 'primary' : 'secondary'}
                  className="nf-studio__tab"
                  onClick={() => {
                    selectTab(t.id);
                  }}
                >
                  {t.label}
                </Button>
              );
            })}
          </div>
          {status !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              className="nf-studio__run-chip"
              onClick={() => {
                selectTab('upload');
              }}
            >
              {status}
            </Button>
          ) : null}
        </div>
        <div
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${activeTab}`}
          className="nf-studio__panel"
          aria-busy={busy || undefined}
          tabIndex={-1}
        >
          {renderPanel()}
        </div>
      </>
    );
  }

  return (
    <section className={cx('nf-studio', className)} aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="nf-studio__title">
        Studio
      </h1>
      {body}
      {miniPlayer !== undefined && miniPlayer !== null ? (
        <div className="nf-studio__mini">{miniPlayer}</div>
      ) : null}
    </section>
  );
}
