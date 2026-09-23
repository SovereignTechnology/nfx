/**
 * Studio → Upload (build-plan §6.1 Studio "Upload", §6.4). Drop zone / file picker → details
 * form (title, Markdown description, tags, kind, mints, price, split, thumbnail, mirrors) →
 * `adapter.studio.upload` with a per-stage progress view → published / failed.
 *
 * The form state and the running upload live in `Studio` (so switching Studio tabs keeps
 * them); this panel renders them and reports edits.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactElement,
  type SyntheticEvent,
} from 'react';
import type { MintUrl, NetworkAdapter, VideoManifest } from '@sovit/core';
import {
  Button,
  ErrorState,
  Icon,
  Markdown,
  MintChip,
  SatsBadge,
  cx,
  formatDuration,
  formatRelativeTime,
  renditionPriceSats,
} from '../../components/index.js';
import type { Route } from '../shared/route.js';
import {
  BLOCK_SIZE,
  DESCRIPTION_MAX,
  PRICE_MAX,
  TAGS_MAX,
  TITLE_MAX,
  TYPICAL_RENDITIONS,
  describeStudioError,
  formatBytes,
  looksLikeImage,
  looksLikeVideo,
  normalizeMintUrl,
  parsePrice,
  parseSplit,
  parseTags,
  renditionKbps,
  satsPerGigabyte,
  satsPerMinute,
  splitPayment,
  uploadSteps,
  validateDraft,
  type DraftErrors,
  type StudioDraft,
  type StudioFile,
  type StudioFileSource,
  type UploadRun,
} from './model.js';
import { FfmpegMissing, StudioImage, WebUploadNotice, type FfmpegStatus } from './parts.js';

export type ResolveUploadFile = (file: File) => StudioFileSource | Promise<StudioFileSource>;

export interface UploadPanelProps {
  readonly adapter: NetworkAdapter;
  readonly navigate: (to: Route) => void;
  readonly draft: StudioDraft;
  readonly onDraft: (patch: Partial<StudioDraft>) => void;
  readonly onChooseFile: (file: StudioFile) => void;
  /** Mints offered as chips: `Settings.defaultMints` ∪ wallet mints ∪ added ones. */
  readonly knownMints: readonly MintUrl[];
  readonly onAddMint: (mint: MintUrl) => void;
  readonly run: UploadRun;
  readonly ffmpeg: FfmpegStatus | undefined;
  readonly onRecheckFfmpeg: (() => void) | undefined;
  readonly resolveFile: ResolveUploadFile | undefined;
  readonly onPublish: () => void;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
  readonly onReset: () => void;
  readonly onShowVideos: () => void;
  readonly now: number;
}

const VIDEO_ACCEPT = 'video/*,.mkv,.mov,.m4v,.webm,.avi,.ts,.mts';

export function UploadPanel(props: UploadPanelProps): ReactElement {
  const { adapter, run, ffmpeg } = props;
  const goSettings = (): void => {
    props.navigate({ name: 'settings' });
  };
  if (run.phase !== 'idle') return <UploadRunView {...props} run={run} />;
  if (ffmpeg !== undefined && !ffmpeg.found) {
    return (
      <FfmpegMissing status={ffmpeg} onSettings={goSettings} onRecheck={props.onRecheckFfmpeg} />
    );
  }
  return (
    <div className="nf-studio__upload">
      {adapter.platform === 'web' ? <WebUploadNotice /> : null}
      {props.draft.file === undefined ? <DropZone {...props} /> : <DetailsForm {...props} />}
    </div>
  );
}

// ---- drop zone -----------------------------------------------------------------------

function DropZone({ adapter, onChooseFile, resolveFile, ffmpeg }: UploadPanelProps): ReactElement {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const accept = (file: File | undefined): void => {
    if (!file) return;
    setError(undefined);
    if (!looksLikeVideo(file.name, file.type)) {
      setError(`“${file.name}” does not look like a video. Choose an MP4, MOV, MKV or WebM file.`);
      return;
    }
    setBusy(true);
    Promise.resolve()
      .then(() => (resolveFile ? resolveFile(file) : file))
      .then(
        (source) => {
          if (!alive.current) return;
          setBusy(false);
          if (typeof source === 'string' && source.trim() === '') {
            setError('The app could not tell where that file is stored. Try Select file again.');
            return;
          }
          onChooseFile({ source, name: file.name, size: file.size, type: file.type });
        },
        () => {
          if (!alive.current) return;
          setBusy(false);
          setError('The app could not open that file. Try Select file again.');
        },
      );
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    accept(e.dataTransfer.files[0]);
  };

  return (
    <div
      className={cx('nf-studio__drop', dragging && 'nf-studio__drop--over')}
      onDragEnter={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
      aria-busy={busy || undefined}
    >
      <span className="nf-studio__drop-icon" aria-hidden="true">
        ↑
      </span>
      <h2 id={`${id}-title`} className="nf-studio__drop-title">
        Drag and drop a video file to upload
      </h2>
      <p className="nf-studio__drop-text">
        Nothing is published until you press Publish.{' '}
        {adapter.platform === 'web'
          ? 'An MP4 (H.264) plays for every viewer.'
          : 'MP4, MOV, MKV and WebM all work.'}
      </p>
      <input
        ref={input}
        id={`${id}-file`}
        className="nf-studio__sr"
        type="file"
        accept={VIDEO_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          accept(e.currentTarget.files?.[0]);
          e.currentTarget.value = '';
        }}
      />
      <Button
        variant="primary"
        loading={busy}
        onClick={() => {
          input.current?.click();
        }}
        aria-describedby={`${id}-title`}
      >
        Select file
      </Button>
      {error ? (
        <p className="nf-studio__error" role="alert">
          {error}
        </p>
      ) : null}
      {ffmpeg?.found ? (
        <p className="nf-studio__drop-meta">
          Transcoding with ffmpeg{ffmpeg.version ? ` ${ffmpeg.version}` : ''}
          {ffmpeg.path ? (
            <>
              {' '}
              at <code>{ffmpeg.path}</code>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

// ---- details form --------------------------------------------------------------------

function fieldProps(
  id: string,
  field: keyof DraftErrors,
  errors: DraftErrors,
  hint?: boolean,
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  const ids = [hint ? `${id}-${field}-hint` : '', errors[field] ? `${id}-${field}-error` : '']
    .filter(Boolean)
    .join(' ');
  return {
    ...(errors[field] ? { 'aria-invalid': true as const } : {}),
    ...(ids ? { 'aria-describedby': ids } : {}),
  };
}

function FieldError({
  id,
  field,
  errors,
}: {
  readonly id: string;
  readonly field: keyof DraftErrors;
  readonly errors: DraftErrors;
}): ReactElement | null {
  const message = errors[field];
  return message ? (
    <p id={`${id}-${field}-error`} className="nf-studio__error">
      {message}
    </p>
  ) : null;
}

function DetailsForm(props: UploadPanelProps): ReactElement {
  const { draft, onDraft, knownMints, onAddMint, adapter } = props;
  const id = useId();
  const [submitted, setSubmitted] = useState(false);
  const [mintText, setMintText] = useState('');
  const [mintError, setMintError] = useState<string | undefined>(undefined);
  const thumbInput = useRef<HTMLInputElement>(null);
  const errors = submitted ? validateDraft(draft) : {};
  const errorCount = Object.keys(errors).length;

  const price = parsePrice(draft.price);
  const split = parseSplit(draft.seeder, draft.creator);
  const tags = parseTags(draft.tags);

  // After a rejected submit, focus the first invalid control once it is marked.
  const formRef = useRef<HTMLFormElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  const onSubmit = (e: SyntheticEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(validateDraft(draft)).length > 0) {
      setFocusRequest((n) => n + 1);
      return;
    }
    props.onPublish();
  };

  const toggleMint = (m: MintUrl): void => {
    onDraft({
      mints: draft.mints.includes(m) ? draft.mints.filter((x) => x !== m) : [...draft.mints, m],
    });
  };
  const addMint = (): void => {
    const m = normalizeMintUrl(mintText);
    if (m === null) {
      setMintError('Enter a mint address that starts with https://');
      return;
    }
    setMintError(undefined);
    setMintText('');
    onAddMint(m);
    if (!draft.mints.includes(m)) onDraft({ mints: [...draft.mints, m] });
  };
  const setSeeder = (v: string): void => {
    const n = /^\d{1,3}$/.test(v.trim()) ? Number(v) : undefined;
    onDraft(n !== undefined && n <= 100 ? { seeder: v, creator: String(100 - n) } : { seeder: v });
  };
  const setCreator = (v: string): void => {
    const n = /^\d{1,3}$/.test(v.trim()) ? Number(v) : undefined;
    onDraft(n !== undefined && n <= 100 ? { creator: v, seeder: String(100 - n) } : { creator: v });
  };
  const file = draft.file;

  return (
    <form
      ref={formRef}
      className="nf-studio__form"
      onSubmit={onSubmit}
      noValidate
      aria-label="Video details"
    >
      <div className="nf-studio__form-main">
        <fieldset className="nf-studio__fieldset">
          <legend className="nf-studio__legend">Details</legend>
          <div className="nf-studio__field">
            <div className="nf-studio__label-row">
              <label htmlFor={`${id}-title`} className="nf-studio__label">
                Title (required)
              </label>
              <span className="nf-studio__count" aria-hidden="true">
                {draft.title.length}/{TITLE_MAX}
              </span>
            </div>
            <input
              id={`${id}-title`}
              name="title"
              className="nf-studio__input"
              value={draft.title}
              maxLength={TITLE_MAX * 2}
              autoComplete="off"
              onChange={(e) => {
                onDraft({ title: e.currentTarget.value });
              }}
              {...fieldProps(id, 'title', errors)}
            />
            <FieldError id={id} field="title" errors={errors} />
          </div>
          <div className="nf-studio__field">
            <div className="nf-studio__label-row">
              <label htmlFor={`${id}-description`} className="nf-studio__label">
                Description
              </label>
              <span className="nf-studio__count" aria-hidden="true">
                {draft.description.length}/{DESCRIPTION_MAX.toLocaleString('en-US')}
              </span>
            </div>
            <textarea
              id={`${id}-description`}
              name="description"
              className="nf-studio__input nf-studio__textarea"
              value={draft.description}
              rows={6}
              onChange={(e) => {
                onDraft({ description: e.currentTarget.value });
              }}
              {...fieldProps(id, 'description', errors, true)}
            />
            <p id={`${id}-description-hint`} className="nf-studio__hint">
              **Bold**, *italic*, links and nostr: mentions. No HTML. The preview shows what viewers
              see.
            </p>
            <FieldError id={id} field="description" errors={errors} />
          </div>
          <div className="nf-studio__field">
            <label htmlFor={`${id}-tags`} className="nf-studio__label">
              Tags
            </label>
            <input
              id={`${id}-tags`}
              name="tags"
              className="nf-studio__input"
              value={draft.tags}
              autoComplete="off"
              placeholder="space, physics"
              onChange={(e) => {
                onDraft({ tags: e.currentTarget.value });
              }}
              {...fieldProps(id, 'tags', errors, true)}
            />
            <p id={`${id}-tags-hint`} className="nf-studio__hint">
              Separate with commas, up to {TAGS_MAX}. Viewers who follow a tag see your video.
            </p>
            <FieldError id={id} field="tags" errors={errors} />
          </div>
          <div className="nf-studio__field" role="radiogroup" aria-labelledby={`${id}-kind`}>
            <span id={`${id}-kind`} className="nf-studio__label">
              Format
            </span>
            <div className="nf-studio__choices">
              <label className="nf-studio__choice">
                <input
                  type="radio"
                  name="kind"
                  value="21"
                  checked={draft.kind === 21}
                  onChange={() => {
                    onDraft({ kind: 21 });
                  }}
                />
                <span>
                  <span className="nf-studio__choice-title">Video</span>
                  <span className="nf-studio__choice-text">Landscape, any length (kind 21)</span>
                </span>
              </label>
              <label className="nf-studio__choice">
                <input
                  type="radio"
                  name="kind"
                  value="22"
                  checked={draft.kind === 22}
                  onChange={() => {
                    onDraft({ kind: 22 });
                  }}
                />
                <span>
                  <span className="nf-studio__choice-title">Short</span>
                  <span className="nf-studio__choice-text">
                    Vertical, up to a minute, in the Shorts feed (kind 22)
                  </span>
                </span>
              </label>
            </div>
          </div>
        </fieldset>

        <fieldset className="nf-studio__fieldset">
          <legend className="nf-studio__legend">Price</legend>
          <div className="nf-studio__field" role="group" aria-labelledby={`${id}-mints`}>
            <span id={`${id}-mints`} className="nf-studio__label">
              Mints viewers pay at
            </span>
            <p id={`${id}-mints-hint`} className="nf-studio__hint">
              Your earnings arrive as ecash at these mints. Pick mints you trust and can melt out
              of.
            </p>
            <div
              className="nf-studio__mints"
              {...(errors.mints ? { 'aria-describedby': `${id}-mints-error` } : {})}
            >
              {knownMints.map((m) => (
                <MintChip
                  key={m}
                  mint={m}
                  selected={draft.mints.includes(m)}
                  onSelect={toggleMint}
                />
              ))}
              {knownMints.length === 0 ? (
                <span className="nf-studio__hint">No mints yet — add one below.</span>
              ) : null}
            </div>
            <div className="nf-studio__inline">
              <label htmlFor={`${id}-mint-add`} className="nf-studio__sr">
                Add a mint
              </label>
              <input
                id={`${id}-mint-add`}
                className="nf-studio__input"
                value={mintText}
                placeholder="https://mint.example"
                inputMode="url"
                autoComplete="off"
                onChange={(e) => {
                  setMintText(e.currentTarget.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addMint();
                  }
                }}
                {...(mintError
                  ? { 'aria-invalid': true, 'aria-describedby': `${id}-mint-add-error` }
                  : {})}
              />
              <Button variant="secondary" onClick={addMint} disabled={mintText.trim() === ''}>
                Add mint
              </Button>
            </div>
            {mintError ? (
              <p id={`${id}-mint-add-error`} className="nf-studio__error">
                {mintError}
              </p>
            ) : null}
            <FieldError id={id} field="mints" errors={errors} />
          </div>

          <div className="nf-studio__field">
            <label htmlFor={`${id}-price`} className="nf-studio__label">
              Price per block (sats)
            </label>
            <div className="nf-studio__inline">
              <input
                id={`${id}-price`}
                name="price"
                className="nf-studio__input nf-studio__input--num"
                type="number"
                inputMode="numeric"
                min={1}
                max={PRICE_MAX}
                step={1}
                value={draft.price}
                onChange={(e) => {
                  onDraft({ price: e.currentTarget.value });
                }}
                {...fieldProps(id, 'price', errors, true)}
              />
              {price !== undefined ? <SatsBadge sats={price} suffix="per block" size="md" /> : null}
            </div>
            <p id={`${id}-price-hint`} className="nf-studio__hint">
              A block is {BLOCK_SIZE / 1024} KiB of video. Viewers pay per block as they stream,
              only for what they watch.
            </p>
            <FieldError id={id} field="price" errors={errors} />
            {price !== undefined ? <PriceEstimate satsPerBlock={price} /> : null}
          </div>

          <div className="nf-studio__field" role="group" aria-labelledby={`${id}-split`}>
            <span id={`${id}-split`} className="nf-studio__label">
              Split
            </span>
            <div className="nf-studio__split">
              <label className="nf-studio__split-field">
                <span>Seeders %</span>
                <input
                  name="seeder"
                  className="nf-studio__input nf-studio__input--num"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  value={draft.seeder}
                  onChange={(e) => {
                    setSeeder(e.currentTarget.value);
                  }}
                  {...fieldProps(id, 'split', errors, true)}
                />
              </label>
              <label className="nf-studio__split-field">
                <span>You %</span>
                <input
                  name="creator"
                  className="nf-studio__input nf-studio__input--num"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  value={draft.creator}
                  onChange={(e) => {
                    setCreator(e.currentTarget.value);
                  }}
                  {...fieldProps(id, 'split', errors, true)}
                />
              </label>
            </div>
            <p id={`${id}-split-hint`} className="nf-studio__hint">
              Seeders are the computers that stream your video to viewers. On every payment their
              share is rounded up and you get the rest.
            </p>
            <FieldError id={id} field="split" errors={errors} />
            {split !== undefined && price !== undefined ? (
              <SplitExamples satsPerBlock={price} split={split} />
            ) : null}
            {split?.seeder === 0 ? (
              <p className="nf-studio__warn">
                With 0% for seeders nobody is paid to stream this video, so it only plays while your
                own seeder is online.
              </p>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="nf-studio__fieldset">
          <legend className="nf-studio__legend">Thumbnail</legend>
          <div className="nf-studio__choices" role="radiogroup" aria-label="Thumbnail">
            <label className="nf-studio__choice">
              <input
                type="radio"
                name="thumbnail"
                checked={draft.thumbnail.mode === 'auto'}
                onChange={() => {
                  onDraft({ thumbnail: { mode: 'auto' } });
                }}
              />
              <span>
                <span className="nf-studio__choice-title">A frame from the video</span>
                <span className="nf-studio__choice-text">
                  Studio grabs candidate frames while transcoding and uses the first
                </span>
              </span>
            </label>
            <label className="nf-studio__choice">
              <input
                type="radio"
                name="thumbnail"
                checked={draft.thumbnail.mode === 'custom'}
                onChange={() => {
                  onDraft({
                    thumbnail: {
                      mode: 'custom',
                      image: draft.thumbnail.mode === 'custom' ? draft.thumbnail.image : undefined,
                    },
                  });
                }}
              />
              <span>
                <span className="nf-studio__choice-title">Your own image</span>
                <span className="nf-studio__choice-text">JPEG, PNG or WebP, 16:9 looks best</span>
              </span>
            </label>
          </div>
          {draft.thumbnail.mode === 'custom' ? (
            <div className="nf-studio__inline">
              <input
                ref={thumbInput}
                className="nf-studio__sr"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = '';
                  if (f && looksLikeImage(f.type))
                    onDraft({ thumbnail: { mode: 'custom', image: f } });
                }}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  thumbInput.current?.click();
                }}
                {...fieldProps(id, 'thumbnail', errors)}
              >
                {draft.thumbnail.image ? 'Change image' : 'Choose image'}
              </Button>
              {draft.thumbnail.image ? (
                <span className="nf-studio__hint">
                  {draft.thumbnail.image.name} · {formatBytes(draft.thumbnail.image.size)}
                </span>
              ) : null}
            </div>
          ) : null}
          <FieldError id={id} field="thumbnail" errors={errors} />
        </fieldset>

        <details className="nf-studio__fieldset nf-studio__details">
          <summary className="nf-studio__legend">Mirrors (optional)</summary>
          <div className="nf-studio__field">
            <label htmlFor={`${id}-mirrors`} className="nf-studio__label">
              Blossom servers to mirror to
            </label>
            <textarea
              id={`${id}-mirrors`}
              name="mirrors"
              className="nf-studio__input nf-studio__textarea"
              rows={2}
              value={draft.mirrors}
              placeholder="https://blossom.example"
              onChange={(e) => {
                onDraft({ mirrors: e.currentTarget.value });
              }}
              {...fieldProps(id, 'mirrors', errors, true)}
            />
            <p id={`${id}-mirrors-hint`} className="nf-studio__hint">
              One https:// address per line. A copy there keeps the video available when no seeder
              is online.
            </p>
            <FieldError id={id} field="mirrors" errors={errors} />
          </div>
        </details>
      </div>

      <aside className="nf-studio__preview" aria-label="Preview">
        <div className="nf-studio__preview-card">
          <div className={cx('nf-studio__preview-thumb', draft.kind === 22 && 'is-short')}>
            <span className="nf-studio__preview-file">{file?.name}</span>
            <span className="nf-studio__preview-note">
              {draft.thumbnail.mode === 'custom' && draft.thumbnail.image
                ? `Thumbnail: ${draft.thumbnail.image.name}`
                : 'The thumbnail is picked while transcoding'}
            </span>
          </div>
          <div className="nf-studio__preview-body">
            <p className="nf-studio__preview-kicker">
              {draft.kind === 22 ? 'Short' : 'Video'}
              {file?.size !== undefined ? ` · ${formatBytes(file.size)}` : ''}
            </p>
            <h2 className="nf-studio__preview-title">
              {draft.title.trim() || <span className="nf-studio__muted">Untitled</span>}
            </h2>
            {price !== undefined ? <SatsBadge sats={price} suffix="per block" size="sm" /> : null}
            {tags.length > 0 ? (
              <p className="nf-studio__preview-tags">{tags.map((t) => `#${t}`).join(' ')}</p>
            ) : null}
            {draft.description.trim() ? (
              <Markdown source={draft.description} className="nf-studio__preview-desc" />
            ) : (
              <p className="nf-studio__muted">No description</p>
            )}
            {draft.mints.length > 0 ? (
              <div className="nf-studio__preview-mints">
                {draft.mints.map((m) => (
                  <MintChip key={m} mint={m} size="sm" />
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="close"
          onClick={() => {
            onDraft({ file: undefined });
          }}
        >
          Choose a different file
        </Button>
      </aside>

      <div className="nf-studio__form-actions">
        {errorCount > 0 ? (
          <p className="nf-studio__error" role="alert">
            {errorCount === 1 ? 'Fix 1 thing' : `Fix ${errorCount} things`} before publishing.
          </p>
        ) : (
          <p className="nf-studio__hint">
            Publishing signs a NIP-71 event with your key
            {adapter.platform === 'web' ? '.' : ' and starts seeding from this device.'}
          </p>
        )}
        <Button type="submit" variant="accent" icon="check">
          Publish
        </Button>
      </div>
    </form>
  );
}

function PriceEstimate({ satsPerBlock }: { readonly satsPerBlock: number }): ReactElement {
  return (
    <div className="nf-studio__estimate">
      <p className="nf-studio__estimate-title">Typical cost to watch</p>
      <ul className="nf-studio__estimate-list">
        {TYPICAL_RENDITIONS.map((r) => (
          <li key={r.label}>
            <span className="nf-studio__estimate-label">{r.label}</span>
            <SatsBadge
              sats={satsPerMinute(r.kbps, satsPerBlock)}
              prefix="about"
              suffix="per minute"
              size="sm"
            />
          </li>
        ))}
        <li>
          <span className="nf-studio__estimate-label">Any quality</span>
          <SatsBadge sats={satsPerGigabyte(satsPerBlock)} suffix="per GB streamed" size="sm" />
        </li>
      </ul>
      <p className="nf-studio__hint">
        Per-minute figures use the standard encode rates. Your real renditions are measured after
        transcoding, and a rendition taller than your source is never made.
      </p>
    </div>
  );
}

function SplitExamples({
  satsPerBlock,
  split,
}: {
  readonly satsPerBlock: number;
  readonly split: { readonly seeder: number; readonly creator: number };
}): ReactElement {
  const rows = [1, 10].map((blocks) => {
    const amount = blocks * satsPerBlock;
    return { blocks, amount, ...splitPayment(amount, split) };
  });
  return (
    <table className="nf-studio__split-table">
      <caption className="nf-studio__sr">How a payment is split</caption>
      <thead>
        <tr>
          <th scope="col">Payment</th>
          <th scope="col">Seeders</th>
          <th scope="col">You</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.blocks}>
            <th scope="row">
              {r.blocks} {r.blocks === 1 ? 'block' : 'blocks'} ·{' '}
              <SatsBadge sats={r.amount} variant="neutral" size="sm" />
            </th>
            <td>
              <SatsBadge sats={r.seeder} variant="neutral" size="sm" />
            </td>
            <td>
              <SatsBadge sats={r.creator} variant="neutral" size="sm" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- running / done / failed ---------------------------------------------------------

type ActiveRun = Exclude<UploadRun, { readonly phase: 'idle' }>;

function stepStatusText(s: 'pending' | 'active' | 'done' | 'error'): string {
  return s === 'done' ? 'Done' : s === 'active' ? 'In progress' : s === 'error' ? 'Failed' : '';
}

function liveText(run: ActiveRun): string {
  const p = run.progress;
  switch (p.stage) {
    case 'queued':
      return 'Starting upload';
    case 'probing':
      return 'Checking the file';
    case 'transcoding': {
      const cur = p.transcoding[p.transcoding.length - 1];
      return cur ? `Transcoding ${cur.label}` : 'Transcoding';
    }
    case 'thumbnails':
      return 'Thumbnails ready';
    case 'writing': {
      const cur = p.writing[p.writing.length - 1];
      return cur ? `Writing ${cur.label} to your seeder` : 'Writing to your seeder';
    }
    case 'publishing':
      return 'Publishing';
    case 'mirroring':
      return 'Mirroring';
    case 'done':
      return 'Published';
    case 'error':
      return 'Upload failed';
  }
}

/** Short status for the Studio tab bar while another tab is showing. */
export function uploadStatusLabel(run: UploadRun): string | undefined {
  if (run.phase === 'idle') return undefined;
  if (run.phase === 'done') return 'Published';
  if (run.phase === 'failed' || run.progress.stage === 'error') return 'Upload failed';
  const p = run.progress;
  const cur =
    p.stage === 'transcoding'
      ? p.transcoding[p.transcoding.length - 1]
      : p.stage === 'writing'
        ? p.writing[p.writing.length - 1]
        : undefined;
  return cur ? `${liveText(run)} · ${cur.percent}%` : liveText(run);
}

function Bars({
  rows,
  complete,
  verb,
}: {
  readonly rows: readonly { readonly label: string; readonly percent: number }[];
  readonly complete: boolean;
  readonly verb: string;
}): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <ul className="nf-studio__bars-progress">
      {rows.map((r) => {
        const pct = complete ? 100 : r.percent;
        return (
          <li key={r.label}>
            <span className="nf-studio__bar-label">{r.label}</span>
            <progress
              className="nf-studio__progress"
              max={100}
              value={pct}
              aria-label={`${verb} ${r.label}`}
            />
            <span className="nf-studio__bar-pct">{pct}%</span>
          </li>
        );
      })}
    </ul>
  );
}

function UploadRunView(props: UploadPanelProps & { readonly run: ActiveRun }): ReactElement {
  const { run, adapter } = props;
  const failed = run.phase === 'failed' || run.progress.stage === 'error';
  const done = !failed && run.phase === 'done';
  const withMirrors = (run.input.mirrorTo?.length ?? 0) > 0;
  const steps = uploadSteps(run.progress, withMirrors);
  const failure =
    failed && run.error !== undefined
      ? describeStudioError(run.error, 'upload')
      : failed
        ? describeStudioError(run.progress.errorMessage ?? '', 'upload')
        : undefined;
  const custom =
    run.input.thumbnailChoice !== undefined && typeof run.input.thumbnailChoice !== 'number';
  const chosenIndex = typeof run.input.thumbnailChoice === 'number' ? run.input.thumbnailChoice : 0;
  const video = run.video ?? run.progress.video;
  const candidates = run.progress.candidates;
  const id = useId();
  const goSettings = (): void => {
    props.navigate({ name: 'settings' });
  };

  return (
    <div className="nf-studio__run">
      <p className="nf-studio__sr" aria-live="polite">
        {liveText(run)}
      </p>
      {failure?.kind === 'ffmpeg-not-found' ? (
        <FfmpegMissing
          error={failure.detail ?? ''}
          onSettings={goSettings}
          onRetry={props.onRetry}
        />
      ) : failure ? (
        <ErrorState title={failure.title} description={failure.description} detail={failure.detail}>
          <div className="nf-studio__fail-actions">
            <Button variant="secondary" icon="refresh" onClick={props.onRetry}>
              Try again
            </Button>
            <Button variant="ghost" onClick={props.onEdit}>
              Edit details
            </Button>
          </div>
        </ErrorState>
      ) : null}
      {done && video ? (
        <Published
          video={video}
          adapter={adapter}
          navigate={props.navigate}
          onReset={props.onReset}
          onShowVideos={props.onShowVideos}
          mirrors={run.progress.mirrors}
          split={run.input.split}
          now={props.now}
        />
      ) : null}

      <div className="nf-studio__run-grid">
        <section className="nf-studio__card" aria-labelledby={`${id}-steps`}>
          <h2 id={`${id}-steps`} className="nf-studio__card-title">
            {done ? 'What happened' : failed ? 'Where it stopped' : 'Uploading'}
          </h2>
          <ol className="nf-studio__steps">
            {steps.map((s, i) => (
              <li key={s.id} className="nf-studio__step" data-status={s.status}>
                <span className="nf-studio__step-mark" aria-hidden="true">
                  {s.status === 'done' ? (
                    <Icon name="check" size={16} />
                  ) : s.status === 'error' ? (
                    <Icon name="error" size={16} />
                  ) : (
                    i + 1
                  )}
                </span>
                <div className="nf-studio__step-body">
                  <p className="nf-studio__step-head">
                    <span className="nf-studio__step-label">{s.label}</span>
                    <span className="nf-studio__step-status">{stepStatusText(s.status)}</span>
                  </p>
                  {s.id === 'transcode' ? (
                    <Bars
                      rows={run.progress.transcoding}
                      complete={s.status === 'done'}
                      verb="Transcoding"
                    />
                  ) : null}
                  {s.id === 'write' ? (
                    <Bars
                      rows={run.progress.writing}
                      complete={s.status === 'done'}
                      verb="Writing"
                    />
                  ) : null}
                  {s.id === 'thumbnails' && candidates ? (
                    <div className="nf-studio__candidates">
                      <ul className="nf-studio__candidate-list">
                        {candidates.map((c, ci) => {
                          const used =
                            !custom && ci === Math.min(chosenIndex, candidates.length - 1);
                          return (
                            <li key={c} className={cx('nf-studio__candidate', used && 'is-used')}>
                              <StudioImage adapter={adapter} url={c} alt={`Frame ${ci + 1}`} />
                              {used ? (
                                <span className="nf-studio__candidate-tag">Thumbnail</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                      <p className="nf-studio__hint">
                        {custom
                          ? 'Your own image is the thumbnail; these frames are not used.'
                          : 'The first frame is the thumbnail. Choosing a different frame after transcoding is not supported yet — pick “Your own image” before publishing to use another.'}
                      </p>
                    </div>
                  ) : null}
                  {s.id === 'mirror' && run.progress.mirrors.length > 0 ? (
                    <ul className="nf-studio__mirrors">
                      {run.progress.mirrors.map((m) => (
                        <li key={m.server} data-ok={m.ok}>
                          <Icon name={m.ok ? 'check' : 'error'} size={16} />
                          <span>{m.server}</span>
                          <span className="nf-studio__muted">{m.ok ? 'Mirrored' : 'Failed'}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          {!done && !failed ? (
            <p className="nf-studio__hint nf-studio__run-note">
              An upload cannot be stopped once it starts. Switching Studio tabs is fine; leaving
              Studio hides this progress, but the upload keeps going.
            </p>
          ) : null}
        </section>

        <aside className="nf-studio__card nf-studio__summary" aria-label="What you are publishing">
          <p className="nf-studio__preview-kicker">
            {run.input.kind === 22 ? 'Short' : 'Video'} · {run.file.name}
          </p>
          <h2 className="nf-studio__preview-title">{run.input.title}</h2>
          <dl className="nf-studio__facts">
            <dt>Price</dt>
            <dd>
              <SatsBadge sats={run.input.satsPerBlock} suffix="per block" size="sm" />
            </dd>
            <dt>Split</dt>
            <dd>
              Seeders {run.input.split.seeder}% · You {run.input.split.creator}%
            </dd>
            <dt>Mints</dt>
            <dd className="nf-studio__preview-mints">
              {run.input.mints.map((m) => (
                <MintChip key={m} mint={m} size="sm" />
              ))}
            </dd>
            {run.input.tags.length > 0 ? (
              <>
                <dt>Tags</dt>
                <dd>{run.input.tags.map((t) => `#${t}`).join(' ')}</dd>
              </>
            ) : null}
          </dl>
        </aside>
      </div>
    </div>
  );
}

function Published({
  video,
  adapter,
  navigate,
  onReset,
  onShowVideos,
  mirrors,
  split,
  now,
}: {
  readonly video: VideoManifest;
  readonly adapter: NetworkAdapter;
  readonly navigate: (to: Route) => void;
  readonly onReset: () => void;
  readonly onShowVideos: () => void;
  readonly mirrors: readonly { readonly server: string; readonly ok: boolean }[];
  readonly split: { readonly seeder: number; readonly creator: number };
  readonly now: number;
}): ReactElement {
  const image = video.renditions[0]?.image;
  const open = (): void => {
    navigate(
      video.kind === 22
        ? { name: 'shorts', videoId: video.id }
        : { name: 'watch', videoId: video.id },
    );
  };
  const failedMirrors = mirrors.filter((m) => !m.ok).length;
  const id = useId();
  return (
    <section className="nf-studio__card nf-studio__published" aria-labelledby={id}>
      <div className="nf-studio__published-head">
        <span className="nf-studio__published-icon" aria-hidden="true">
          <Icon name="check" size={24} />
        </span>
        <div>
          <h2 id={id} className="nf-studio__card-title">
            Published
          </h2>
          <p className="nf-studio__hint">
            Viewers pay per block as they watch: seeders {split.seeder}%, you {split.creator}%.
            {failedMirrors > 0
              ? ` ${failedMirrors} mirror${failedMirrors === 1 ? '' : 's'} failed; the video is still published.`
              : ''}
          </p>
        </div>
      </div>
      <div className="nf-studio__published-body">
        <div className="nf-studio__published-media">
          <StudioImage
            adapter={adapter}
            url={image?.url}
            sha256={image?.sha256}
            className={cx('nf-studio__published-thumb', video.kind === 22 && 'is-short')}
          />
          <p className="nf-studio__published-title">{video.title}</p>
          <p className="nf-studio__hint">
            {video.durationSec !== undefined ? `${formatDuration(video.durationSec)} · ` : ''}
            Published {formatRelativeTime(video.publishedAt, now)}
          </p>
        </div>
        <div className="nf-studio__published-prices">
          <p className="nf-studio__estimate-title">Cost to watch</p>
          <ul className="nf-studio__estimate-list">
            {video.renditions.map((r) => {
              const kbps = renditionKbps(r, video.durationSec);
              return (
                <li key={r.label}>
                  <span className="nf-studio__estimate-label">
                    {r.label}
                    {r.width && r.height ? ` · ${r.width}×${r.height}` : ''}
                  </span>
                  {kbps !== undefined ? (
                    <SatsBadge
                      sats={satsPerMinute(kbps, video.price.satsPerBlock, video.price.blockSize)}
                      prefix="about"
                      suffix="per minute"
                      size="sm"
                    />
                  ) : null}
                  <SatsBadge
                    sats={renditionPriceSats(r, video.price)}
                    suffix={
                      video.durationSec !== undefined
                        ? `for all ${formatDuration(video.durationSec)}`
                        : 'for the whole video'
                    }
                    size="sm"
                  />
                </li>
              );
            })}
          </ul>
          <div className="nf-studio__published-actions">
            <Button variant="primary" onClick={open}>
              {video.kind === 22 ? 'View in Shorts' : 'View video'}
            </Button>
            <Button variant="secondary" onClick={onShowVideos}>
              Go to your videos
            </Button>
            <Button variant="ghost" onClick={onReset}>
              Upload another
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
