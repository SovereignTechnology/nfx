/**
 * @sovit/app-desktop — Electron + pear-runtime Bare-worker shell (ADR 0003). The shell
 * itself lands in Stage 1 Wave 2 (lane L6); Wave 1 contributed the transcode worker.
 */
export const PACKAGE = '@sovit/app-desktop' as const;
export * as transcode from './worker/transcode/index.js';
