/**
 * Desktop worker transcode adapter (lane L8). Runs inside the Bare worker (L6), which owns
 * `require('bare-subprocess')` and the path to the ffmpeg binary (shipped or system — the
 * path is injected config either way, see docs/lanes/L8.md).
 *
 * Wiring sketch for L6:
 *   const { spawn } = require('bare-subprocess')
 *   const runner = createBareProcessRunner(spawn)
 *   const pipeline = createMediaPipeline({ runner, fs: bareFsAdapter, sha256, binaries })
 */
export {
  createBareProcessRunner,
  LineSplitter,
  ProcessRunnerError,
  type BareProcessRunnerOptions,
  type ProcessRunnerErrorCode,
} from './bare-process-runner.js';
export type {
  BareReadable,
  BareSpawn,
  BareSpawnOptions,
  BareStdio,
  BareSubprocessHandle,
  UvError,
} from './bare-subprocess-types.js';
