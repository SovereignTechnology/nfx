/**
 * `hyper://` transport references as written in the imeta `url` field.
 *
 * Grammar (matches the fixtures in `mocks/fixtures.ts`):
 *
 *   hyper://<core-key-hex64>/<blockOffset>-<blockLength>[+<byteOffset>]
 *
 * `byteLength` is the imeta `size`, so it is not repeated here; `byteOffset` is only
 * written when non-zero (a blob that is not first in its core). The core key is the
 * 64-char hex form (`CoreKeyHex`); z32 is not accepted in this version (noted in
 * docs/lanes/L1.md).
 */
import type { CoreKeyHex, HyperblobRef } from '../contracts/index.js';

const RE = /^hyper:\/\/([0-9a-f]{64})\/(\d{1,12})-(\d{1,12})(?:\+(\d{1,15}))?$/;

export function encodeHyperUrl(ref: HyperblobRef): string {
  const { blockOffset, blockLength, byteOffset } = ref.blob;
  const base = `hyper://${ref.core}/${blockOffset}-${blockLength}`;
  return byteOffset === 0 ? base : `${base}+${byteOffset}`;
}

/** Decode; `byteLength` must come from the imeta `size`. `null` when malformed. */
export function decodeHyperUrl(url: string, byteLength: number): HyperblobRef | null {
  const m = RE.exec(url);
  if (!m) return null;
  const blockOffset = Number(m[2]);
  const blockLength = Number(m[3]);
  const byteOffset = m[4] === undefined ? 0 : Number(m[4]);
  if (blockLength < 1 || !Number.isInteger(byteLength) || byteLength < 0) return null;
  return {
    core: m[1] as CoreKeyHex,
    blob: { byteOffset, blockOffset, blockLength, byteLength },
  };
}

export const isHyperUrl = (url: string): boolean => RE.test(url);
