import type { HyperblobRef } from '../contracts/manifest.js';

/**
 * Default imeta `url` for a Hyperblobs reference.
 *
 * The exact blob-id encoding is owned by the manifest lane (L1); the only convention in the
 * repo today is the fixture set (`mocks/fixtures.ts`): `hyper://<core hex>/<blockOffset>-<blockLength>`.
 * The pipeline takes a `hyperUrl` formatter in its deps so the orchestrator can swap this
 * without touching the media code. See docs/lanes/L8.md "Uncertainties".
 */
export function defaultHyperUrl(ref: HyperblobRef): string {
  return `hyper://${ref.core}/${ref.blob.blockOffset}-${ref.blob.blockLength}`;
}
