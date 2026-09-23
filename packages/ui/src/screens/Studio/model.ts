/**
 * Studio — pure model: upload-progress reducer, draft validation, price/split arithmetic for
 * DISPLAY, error classification. No React, no adapter calls, no DOM beyond types.
 *
 * Nothing here decides what anyone is charged: `splitPayment` mirrors ADR 0005 Q1 so the
 * screen can SHOW the rule; the payment engine applies it.
 */
import type {
  DEFAULT_BLOCK_SIZE,
  FileLike,
  MintUrl,
  Rendition,
  Sats,
  UploadInput,
  UploadProgress,
  VideoManifest,
} from '@sovit/core';

// ---- constants -------------------------------------------------------------------------

/** Hyperblobs block size (contracts `DEFAULT_BLOCK_SIZE`, A9); the type ties the two together. */
export const BLOCK_SIZE: typeof DEFAULT_BLOCK_SIZE = 65_536;

/**
 * The standard encode targets (video + audio kbps) of core's rendition ladder
 * (`media.LADDER_TIERS`, H.264). Used ONLY for the pre-upload "typical cost to watch"
 * estimate: the real renditions are not known until the file is probed and transcoded (the
 * ladder never upscales, so a 720p source has no 1080p). A test keeps this in sync with core.
 */
export const TYPICAL_RENDITIONS: readonly { readonly label: string; readonly kbps: number }[] = [
  { label: '1080p', kbps: 5128 },
  { label: '720p', kbps: 2628 },
  { label: '360p', kbps: 896 },
];

export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const TAGS_MAX = 10;
export const TAG_MAX_CHARS = 40;
export const PRICE_MAX = 1000;
export const DEFAULT_PRICE = 1;
export const DEFAULT_SPLIT = { seeder: 50, creator: 50 } as const;

// ---- files -------------------------------------------------------------------------------

/**
 * What `UploadInput.file` gets. Desktop: an absolute path (the shell resolves it — a DOM
 * `File` has no path under Electron's sandbox). Web: the `File` itself (structurally a
 * `FileLike`).
 */
export type StudioFileSource = string | FileLike;

/** A file chosen in (or handed to) the screen, with the display facts the screen needs. */
export interface StudioFile {
  readonly source: StudioFileSource;
  /** Display name (never parsed from a path). */
  readonly name: string;
  readonly size?: number | undefined;
  readonly type?: string | undefined;
}

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|mpe?g|ts|mts|m2ts|wmv|flv|ogv|3gp)$/i;

/** MIME first; many OSes give `.mkv`/`.ts` an empty type, so fall back to the extension. */
export function looksLikeVideo(name: string, type: string | undefined): boolean {
  if (type?.startsWith('video/')) return true;
  if (type && type !== '' && type !== 'application/octet-stream') return false;
  return VIDEO_EXTENSIONS.test(name);
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export function looksLikeImage(type: string | undefined): boolean {
  return type !== undefined && IMAGE_TYPES.has(type);
}

/** YouTube's default title: the file name without its extension. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return (base || name).slice(0, TITLE_MAX);
}

/**
 * `734_003_200` → `700 MB`. Binary steps (1024) with the familiar labels, as Windows and
 * most apps show them, so a 50 GB disk cap set as 50 × 1024³ reads "50 GB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let v = bytes;
  let unit = 'B';
  for (const u of units) {
    v /= 1024;
    unit = u;
    if (v < 1024) break;
  }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))} ${unit}`;
}

// ---- tags / urls -------------------------------------------------------------------------

/** "Space, #Physics, orbital mechanics" → `['space', 'physics', 'orbital-mechanics']`. */
export function parseTags(text: string): readonly string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const t = raw
      .trim()
      .replace(/^#+/, '')
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]/gu, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** An absolute https URL with no trailing slash, or `null`. Used for mints and mirrors. */
export function normalizeHttpsUrl(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  if (u.search || u.hash) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

export function normalizeMintUrl(text: string): MintUrl | null {
  const u = normalizeHttpsUrl(text);
  return u === null ? null : (u as MintUrl);
}

/** One server per line (or comma separated); invalid lines are reported, not dropped. */
export function parseServers(text: string): {
  readonly servers: readonly string[];
  readonly invalid: readonly string[];
} {
  const servers: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.trim();
    if (!line) continue;
    const u = normalizeHttpsUrl(line);
    if (u === null) invalid.push(line);
    else if (!servers.includes(u)) servers.push(u);
  }
  return { servers, invalid };
}

/**
 * Shape check for a pasted Lightning invoice (NOT a decoder: no amount, no checksum).
 * Strips a `lightning:` prefix and whitespace, lower-cases. The mint's melt quote is what
 * states the amount.
 */
export function normalizeInvoice(text: string): string | null {
  const s = text
    .trim()
    .replace(/^lightning:/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  return /^ln(bc|tb|tbs|bcrt)[0-9a-z]{20,}$/.test(s) ? s : null;
}

// ---- price arithmetic (display only) -----------------------------------------------------

function positiveInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whole blocks per minute at `kbps`, rounded up, × price. `kbps × 125` = bytes per second. */
export function satsPerMinute(
  kbps: number,
  satsPerBlock: number,
  blockSize: number = BLOCK_SIZE,
): Sats {
  const bytesPerMin = positiveInt(kbps) * 125 * 60;
  const blocks = Math.ceil(bytesPerMin / (blockSize > 0 ? blockSize : 1));
  return (blocks * positiveInt(satsPerBlock)) as Sats;
}

/** Sats per gigabyte (10^9 bytes) streamed — exact from the price alone, no bitrate needed. */
export function satsPerGigabyte(satsPerBlock: number, blockSize: number = BLOCK_SIZE): Sats {
  return (Math.ceil(1e9 / (blockSize > 0 ? blockSize : 1)) * positiveInt(satsPerBlock)) as Sats;
}

/** A published rendition's bitrate: the imeta value, else size ÷ duration. */
export function renditionKbps(r: Rendition, durationSec: number | undefined): number | undefined {
  if (r.bitrateKbps !== undefined && r.bitrateKbps > 0) return r.bitrateKbps;
  if (durationSec !== undefined && durationSec > 0 && r.size > 0) {
    return (r.size * 8) / 1000 / durationSec;
  }
  return undefined;
}

/**
 * ADR 0005 Q1 (contract text at v4): for a payment of `amount` sats the seeder share is
 * `ceil(amount × seeder / 100)` and the creator takes the remainder. Display only.
 */
export function splitPayment(
  amount: number,
  split: { readonly seeder: number; readonly creator: number },
): { readonly seeder: Sats; readonly creator: Sats } {
  const a = Math.max(0, Math.floor(amount));
  const seeder = Math.min(a, Math.ceil((a * split.seeder) / 100));
  return { seeder: seeder as Sats, creator: (a - seeder) as Sats };
}

// ---- draft -------------------------------------------------------------------------------

export type ThumbnailDraft =
  { readonly mode: 'auto' } | { readonly mode: 'custom'; readonly image: FileLike | undefined };

export interface StudioDraft {
  readonly file: StudioFile | undefined;
  readonly title: string;
  readonly description: string;
  readonly tags: string;
  readonly kind: 21 | 22;
  readonly mints: readonly MintUrl[];
  readonly price: string;
  readonly seeder: string;
  readonly creator: string;
  readonly thumbnail: ThumbnailDraft;
  readonly mirrors: string;
}

export const EMPTY_DRAFT: StudioDraft = {
  file: undefined,
  title: '',
  description: '',
  tags: '',
  kind: 21,
  mints: [],
  price: String(DEFAULT_PRICE),
  seeder: String(DEFAULT_SPLIT.seeder),
  creator: String(DEFAULT_SPLIT.creator),
  thumbnail: { mode: 'auto' },
  mirrors: '',
};

export type DraftField =
  'file' | 'title' | 'description' | 'tags' | 'mints' | 'price' | 'split' | 'thumbnail' | 'mirrors';

export type DraftErrors = Partial<Record<DraftField, string>>;

function wholeNumber(text: string): number | undefined {
  const s = text.trim();
  return /^\d{1,9}$/.test(s) ? Number(s) : undefined;
}

/** The split as numbers when both fields are whole percentages summing to 100. */
export function parseSplit(
  seeder: string,
  creator: string,
): { readonly seeder: number; readonly creator: number } | undefined {
  const s = wholeNumber(seeder);
  const c = wholeNumber(creator);
  if (s === undefined || c === undefined || s > 100 || c > 100 || s + c !== 100) return undefined;
  return { seeder: s, creator: c };
}

export function parsePrice(text: string): number | undefined {
  const n = wholeNumber(text);
  return n !== undefined && n >= 1 && n <= PRICE_MAX ? n : undefined;
}

export function validateDraft(d: StudioDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.file) e.file = 'Choose a video file to upload.';
  const title = d.title.trim();
  if (!title) e.title = 'Add a title.';
  else if (title.length > TITLE_MAX) e.title = `Keep the title under ${TITLE_MAX} characters.`;
  if (d.description.length > DESCRIPTION_MAX) {
    e.description = `Keep the description under ${DESCRIPTION_MAX.toLocaleString('en-US')} characters.`;
  }
  const tags = parseTags(d.tags);
  if (tags.length > TAGS_MAX) e.tags = `Use at most ${TAGS_MAX} tags.`;
  else if (tags.some((t) => t.length > TAG_MAX_CHARS)) {
    e.tags = `Keep each tag under ${TAG_MAX_CHARS} characters.`;
  }
  if (d.mints.length === 0) e.mints = 'Pick at least one mint viewers can pay at.';
  if (parsePrice(d.price) === undefined) {
    e.price = `Enter a whole number of sats from 1 to ${PRICE_MAX.toLocaleString('en-US')}.`;
  }
  if (parseSplit(d.seeder, d.creator) === undefined) {
    e.split = 'Seeders and creator must be whole percentages that add up to 100.';
  }
  if (d.thumbnail.mode === 'custom' && d.thumbnail.image === undefined) {
    e.thumbnail = 'Choose an image, or let Studio pick a frame.';
  }
  if (parseServers(d.mirrors).invalid.length > 0) {
    e.mirrors = 'Each mirror must be an https:// address.';
  }
  return e;
}

/** The contract input for a valid draft, or `undefined` when `validateDraft` has errors. */
export function toUploadInput(d: StudioDraft): UploadInput | undefined {
  const price = parsePrice(d.price);
  const split = parseSplit(d.seeder, d.creator);
  if (!d.file || price === undefined || split === undefined) return undefined;
  if (Object.keys(validateDraft(d)).length > 0) return undefined;
  const mirrors = parseServers(d.mirrors).servers;
  return {
    file: d.file.source,
    title: d.title.trim(),
    description: d.description,
    tags: parseTags(d.tags),
    kind: d.kind,
    mints: d.mints,
    satsPerBlock: price as Sats,
    split,
    ...(d.thumbnail.mode === 'custom' && d.thumbnail.image !== undefined
      ? { thumbnailChoice: d.thumbnail.image }
      : {}),
    ...(mirrors.length > 0 ? { mirrorTo: mirrors } : {}),
  };
}

// ---- upload progress -----------------------------------------------------------------------

export type UploadStepId = 'probe' | 'transcode' | 'thumbnails' | 'write' | 'publish' | 'mirror';
export type UploadStepStatus = 'pending' | 'active' | 'done' | 'error';

export interface RenditionProgress {
  readonly label: string;
  readonly percent: number;
}

export interface UploadProgressView {
  /** Latest stage seen; `queued` before the first event. */
  readonly stage: UploadProgress['stage'] | 'queued';
  readonly transcoding: readonly RenditionProgress[];
  readonly writing: readonly RenditionProgress[];
  readonly candidates: readonly string[] | undefined;
  readonly mirrors: readonly { readonly server: string; readonly ok: boolean }[];
  readonly video: VideoManifest | undefined;
  readonly errorMessage: string | undefined;
  /** The step that was running when the error arrived. */
  readonly failedAt: UploadStepId | undefined;
}

export const INITIAL_PROGRESS: UploadProgressView = {
  stage: 'queued',
  transcoding: [],
  writing: [],
  candidates: undefined,
  mirrors: [],
  video: undefined,
  errorMessage: undefined,
  failedAt: undefined,
};

const STAGE_STEP: Readonly<Record<UploadProgressView['stage'], UploadStepId | undefined>> = {
  queued: 'probe',
  probing: 'probe',
  transcoding: 'transcode',
  thumbnails: 'thumbnails',
  writing: 'write',
  publishing: 'publish',
  mirroring: 'mirror',
  done: undefined,
  error: undefined,
};

function clampPercent(p: number): number {
  return Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;
}

function upsert(
  list: readonly RenditionProgress[],
  label: string,
  percent: number,
): readonly RenditionProgress[] {
  const pct = clampPercent(percent);
  return list.some((r) => r.label === label)
    ? list.map((r) => (r.label === label ? { label, percent: pct } : r))
    : [...list, { label, percent: pct }];
}

/** Folds one `UploadProgress` event into the view (pure; the screen keeps the result). */
export function reduceUploadProgress(
  view: UploadProgressView,
  p: UploadProgress,
): UploadProgressView {
  switch (p.stage) {
    case 'probing':
      return { ...view, stage: 'probing' };
    case 'transcoding':
      return {
        ...view,
        stage: 'transcoding',
        transcoding: upsert(view.transcoding, p.rendition, p.percent),
      };
    case 'thumbnails':
      return { ...view, stage: 'thumbnails', candidates: p.candidates };
    case 'writing':
      return { ...view, stage: 'writing', writing: upsert(view.writing, p.rendition, p.percent) };
    case 'publishing':
      return { ...view, stage: 'publishing' };
    case 'mirroring':
      return {
        ...view,
        stage: 'mirroring',
        mirrors: [
          ...view.mirrors.filter((m) => m.server !== p.server),
          { server: p.server, ok: p.ok },
        ],
      };
    case 'done':
      return { ...view, stage: 'done', video: p.video };
    case 'error':
      return failProgress(view, p.message);
  }
}

/** Marks the view failed (from an `error` event or a rejected `upload()`); idempotent. */
export function failProgress(
  view: UploadProgressView,
  message: string | undefined,
): UploadProgressView {
  if (view.stage === 'error') {
    return view.errorMessage === undefined && message ? { ...view, errorMessage: message } : view;
  }
  return {
    ...view,
    stage: 'error',
    errorMessage: message ?? view.errorMessage,
    failedAt: STAGE_STEP[view.stage] ?? 'publish',
  };
}

export const UPLOAD_STEPS: readonly { readonly id: UploadStepId; readonly label: string }[] = [
  { id: 'probe', label: 'Checking the file' },
  { id: 'transcode', label: 'Transcoding' },
  { id: 'thumbnails', label: 'Thumbnails' },
  { id: 'write', label: 'Writing to your seeder' },
  { id: 'publish', label: 'Publishing' },
  { id: 'mirror', label: 'Mirroring' },
];

/** Step list with a status each; `mirror` only when the input asked for mirrors. */
export function uploadSteps(
  view: UploadProgressView,
  withMirrors: boolean,
): readonly {
  readonly id: UploadStepId;
  readonly label: string;
  readonly status: UploadStepStatus;
}[] {
  const steps = UPLOAD_STEPS.filter((s) => withMirrors || s.id !== 'mirror');
  const ids = steps.map((s) => s.id);
  const current =
    view.stage === 'done'
      ? ids.length
      : view.stage === 'error'
        ? ids.indexOf(view.failedAt ?? 'probe')
        : ids.indexOf(STAGE_STEP[view.stage] ?? 'probe');
  return steps.map((s, i) => ({
    ...s,
    status:
      i < current
        ? 'done'
        : i === current
          ? view.stage === 'error'
            ? 'error'
            : view.stage === 'queued'
              ? 'pending'
              : 'active'
          : 'pending',
  }));
}

// ---- errors ------------------------------------------------------------------------------

export type StudioErrorKind =
  | 'ffmpeg-not-found'
  | 'unsupported-input'
  | 'no-video-stream'
  | 'process-failed'
  | 'verification-failed'
  | 'aborted'
  | 'relay-down'
  | 'no-signer'
  | 'no-balance'
  | 'unknown';

const FFMPEG_MESSAGE =
  /ffmpeg-not-found|could not spawn\b|\b(ffmpeg|ffprobe)\b[^\n]*\b(ENOENT|EACCES|not found|not installed)/i;

function errorCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    if (typeof e !== 'object') break;
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/**
 * Maps a rejected adapter call (or an `UploadProgress` `error` message) to a kind. Core's
 * media errors carry `code` (`MediaError`/`ProcessRunnerError`, possibly as `cause`); an IPC
 * hop may strip it and leave only the message, so the message is matched as a fallback —
 * core words a missing binary as "<step>: could not spawn <file> (ENOENT)".
 */
export function classifyStudioError(err: unknown): StudioErrorKind {
  const code = errorCode(err);
  switch (code) {
    case 'ffmpeg-not-found':
    case 'spawn-failed':
      return 'ffmpeg-not-found';
    case 'unsupported-input':
      return 'unsupported-input';
    case 'no-video-stream':
      return 'no-video-stream';
    case 'process-failed':
    case 'probe-parse':
      return 'process-failed';
    case 'not-faststart':
    case 'hash-mismatch':
      return 'verification-failed';
    case 'aborted':
      return 'aborted';
    case undefined:
    default:
      break;
  }
  const message = errorMessage(err);
  if (FFMPEG_MESSAGE.test(message)) return 'ffmpeg-not-found';
  if (/^relay-down\b|\brelays?\b.*\b(down|unreachable|reachable)\b/i.test(message)) {
    return 'relay-down';
  }
  if (/^no-signer\b|signer not detected|no signer/i.test(message)) return 'no-signer';
  if (/^no-balance\b|insufficient (balance|funds)/i.test(message)) return 'no-balance';
  return 'unknown';
}

export type StudioErrorContext = 'load' | 'upload' | 'seeder' | 'melt';

/** Human copy for a failure. Never a stack trace; `detail` is the short machine message. */
export function describeStudioError(
  err: unknown,
  context: StudioErrorContext = 'load',
): {
  readonly kind: StudioErrorKind;
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const kind = classifyStudioError(err);
  const detail = errorMessage(err) || undefined;
  const d = (title: string, description: string): ReturnType<typeof describeStudioError> => ({
    kind,
    title,
    description,
    detail,
  });
  switch (kind) {
    case 'ffmpeg-not-found':
      return d(
        'ffmpeg not found',
        'Studio uses the ffmpeg installed on this computer to make the versions viewers stream. Install it, or point Settings at it, and try again.',
      );
    case 'unsupported-input':
      return d(
        'Could not open that file',
        'The app could not read the file from where it is stored. Choose it again with Select file.',
      );
    case 'no-video-stream':
      return d(
        'No video in that file',
        'ffmpeg found no video track. Choose a video file (MP4, MOV, MKV or WebM).',
      );
    case 'process-failed':
      return d(
        'Transcoding failed',
        'ffmpeg stopped with an error while making your renditions, so nothing was published. The file may be damaged or in an unusual format — try again, or convert it to MP4 first.',
      );
    case 'verification-failed':
      return d(
        'A rendition failed its check',
        'A finished rendition did not pass verification, so nothing was published. Try again.',
      );
    case 'aborted':
      return d(
        'Upload stopped',
        'The upload was stopped before it finished. Nothing was published.',
      );
    case 'relay-down':
      return context === 'upload'
        ? d(
            'Could not publish',
            'None of your relays answered, so the video event was not published. Check your relays in Settings, then try again.',
          )
        : d(
            'Relay down',
            'None of your relays answered, so there is nothing to show. Check your connection or your relay list in Settings, then retry.',
          );
    case 'no-signer':
      return d(
        'Signer not detected',
        'Studio signs your videos with your Nostr key. Connect a signer in Settings, then try again.',
      );
    case 'no-balance':
      return d(
        'No balance at this mint',
        'There are not enough sats at this mint to pay that invoice and its fee. Pick another mint or a smaller invoice.',
      );
    case 'unknown':
      break;
  }
  switch (context) {
    case 'upload':
      return d('Upload failed', 'Something went wrong, so nothing was published. Try again.');
    case 'melt':
      return d('Melt-out failed', 'The mint did not complete the payment. Try again in a moment.');
    case 'seeder':
      return d('Could not load your seeder', 'The seeder did not answer. Try again in a moment.');
    case 'load':
      return d('Something went wrong', 'We could not load this. Try again in a moment.');
  }
}

/** Seeder ban reasons (payment engine `RejectReason`s and window/double-spend) in words. */
export function describeBanReason(reason: string): string {
  switch (reason) {
    case 'window-exceeded':
      return 'Took more blocks than the unpaid window allows';
    case 'double-spend':
      return 'Paid with ecash that was already spent';
    case 'bad-dleq':
    case 'missing-dleq':
      return 'Sent ecash that could not be verified';
    case 'wrong-amount':
    case 'overpay':
      return 'Paid the wrong amount';
    case 'wrong-p2pk-target':
    case 'missing-creator-set':
    case 'missing-seeder-set':
      return 'Tried to skip the creator’s or seeder’s share';
    case 'range-already-paid':
      return 'Replayed an old payment';
    case 'malformed':
      return 'Sent malformed payment messages';
    default:
      return reason;
  }
}

// ---- upload run --------------------------------------------------------------------------

/** One `studio.upload()` call as the screen tracks it. */
export type UploadRun =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'running' | 'done' | 'failed';
      /** Increments per run; late callbacks from an older run are ignored. */
      readonly id: number;
      readonly input: UploadInput;
      readonly file: StudioFile;
      readonly progress: UploadProgressView;
      readonly video: VideoManifest | undefined;
      readonly error: unknown;
    };

export const IDLE_RUN: UploadRun = { phase: 'idle' };
