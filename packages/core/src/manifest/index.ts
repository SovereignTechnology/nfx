/**
 * `@sovit/core` manifest — NIP-71 video events ⇄ `VideoManifest` (lane L1).
 *
 * `build` → `Signer.signEvent` → relay; relay → `verifyVideoEvent` → `VideoManifest`.
 */
export { buildVideoEvent, renditionToImeta, ManifestBuildError } from './build.js';
export type { BuildVideoOptions, VideoManifestInput } from './build.js';
export { parseVideoEvent } from './parse.js';
export { verifyVideoEvent, verifyVideoEvents } from './verify.js';
export { encodeHyperUrl, decodeHyperUrl, isHyperUrl } from './hyper-url.js';
export { parseImetaTag, serializeImetaTag, imetaFirst, imetaAll } from './imeta.js';
export type { ImetaEntry } from './imeta.js';
