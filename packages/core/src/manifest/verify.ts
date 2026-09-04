/**
 * `verifyVideoEvent`: untrusted object → `VideoManifest` or a `ManifestError`.
 *
 * Order: shape + signature (`verifyIncoming`, T9) → kind → tags. A bad signature is
 * reported before anything else about the event is believed.
 */
import type { ManifestError, Result, VideoManifest } from '../contracts/index.js';
import { verifyIncoming } from '../nostr/event.js';
import { parseVideoEvent } from './parse.js';

export function verifyVideoEvent(raw: unknown): Result<VideoManifest, ManifestError> {
  const ev = verifyIncoming(raw);
  if (!ev) return { ok: false, error: { code: 'bad-signature' } };
  return parseVideoEvent(ev);
}

/** Batch helper: verified manifests only, in input order; failures are counted, not returned. */
export function verifyVideoEvents(raws: readonly unknown[]): {
  readonly manifests: VideoManifest[];
  readonly rejected: ManifestError[];
} {
  const manifests: VideoManifest[] = [];
  const rejected: ManifestError[] = [];
  for (const raw of raws) {
    const r = verifyVideoEvent(raw);
    if (r.ok) manifests.push(r.value);
    else rejected.push(r.error);
  }
  return { manifests, rejected };
}
