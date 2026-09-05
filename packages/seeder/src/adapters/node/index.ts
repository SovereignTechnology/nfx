import type { SeederCrypto } from '../crypto.js';
import type { SeederFs } from '../fs.js';
import type { SeederProcess } from '../process.js';
import { nodeCrypto } from './crypto.js';
import { nodeFs } from './fs.js';
import { nodeProcess } from './process.js';

export interface SeederAdapters {
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly process: SeederProcess;
}

/** The Node 22 adapter bundle. L6 provides a `bare-*` equivalent of the same shape. */
export const nodeAdapters: SeederAdapters = {
  fs: nodeFs,
  crypto: nodeCrypto,
  process: nodeProcess,
};

export { nodeCrypto, nodeFs, nodeProcess };
