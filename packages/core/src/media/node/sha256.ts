import { createHash } from 'node:crypto';

import type { Sha256Hex } from '../../contracts/primitives.js';
import type { Sha256Factory } from '../types.js';

/** `node:crypto` SHA-256 behind the pipeline's incremental hasher interface. */
export const nodeSha256: Sha256Factory = () => {
  const h = createHash('sha256');
  return {
    update(chunk) {
      h.update(chunk);
    },
    digest() {
      return h.digest('hex') as Sha256Hex;
    },
  };
};
