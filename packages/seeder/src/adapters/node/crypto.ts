// Node implementation of SeederCrypto. The only file in the seeder that imports `node:crypto`.
import { createHash, randomBytes } from 'node:crypto';

import type { SeederCrypto } from '../crypto.js';

export const nodeCrypto: SeederCrypto = {
  createSha256() {
    const h = createHash('sha256');
    return {
      update: (chunk) => {
        h.update(chunk);
      },
      digestHex: () => h.digest('hex'),
    };
  },
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
};
