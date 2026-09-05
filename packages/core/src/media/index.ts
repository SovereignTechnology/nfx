/**
 * `@sovit/core/media` — runtime-agnostic transcode planning (build-plan §6.4, spike S-C,
 * contracts/media.ts). Nothing here imports `node:`; Node adapters live in `./node/`.
 *
 * Intended wiring (orchestrator, packages/core/src/index.ts):
 *   export * as media from './media/index.js';
 * and, for Node hosts, a `./media/node` subpath export (see docs/lanes/L8.md).
 */
export { createMediaPipeline } from './pipeline.js';
export { runStudioUpload } from './upload.js';
export type { RenditionDraft, StudioUploadDeps, UploadDraft } from './upload.js';
export type { FfmpegPaths, MediaPipelineDeps, Sha256Factory, Sha256Hasher } from './types.js';
export {
  MediaError,
  ProcessRunnerError,
  isProcessRunnerError,
  type MediaErrorCode,
  type ProcessRunnerErrorCode,
  type ProcessRunnerErrorShape,
} from './errors.js';

// Pure building blocks (useful to a Bare-side probe or to tests)
export { ffprobeArgv, parseFfprobeJson, parseRational, displayDimensions } from './ffprobe.js';
export {
  planLadder,
  fitToHeight,
  thumbnailTimes,
  storyboardGeometry,
  LADDER_TIERS,
  GOP_SECONDS,
} from './ladder.js';
export {
  renditionArgv,
  thumbnailArgv,
  placeholderArgv,
  storyboardArgv,
  renditionDimensions,
  gopFrames,
  formatSeconds,
  PLACEHOLDER_WIDTH,
  THUMBNAIL_WIDTH,
} from './argv.js';
export {
  parseBoxHeader,
  parseTopLevelBoxes,
  isFaststart,
  Mp4BoxScanner,
  type Mp4Box,
} from './mp4-boxes.js';
export { parseProgressLine, ProgressTracker, type ProgressSample } from './progress.js';
export { storyboardVtt, vttTimestamp, type StoryboardVttInput } from './storyboard.js';
export { defaultHyperUrl } from './hyper-url.js';
export { base64Encode, dataUrl } from './base64.js';
