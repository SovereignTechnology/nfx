import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FsAdapter } from '../../contracts/media.js';

/**
 * `FsAdapter` over `node:fs`. `mkdtemp(prefix)` creates under `tmpDir` (default `os.tmpdir()`),
 * so a bare prefix like `nutflix-transcode-` never lands in the process cwd.
 */
export function nodeFsAdapter(opts: { readonly tmpDir?: string } = {}): FsAdapter {
  const base = opts.tmpDir ?? tmpdir();
  return {
    async readFile(path) {
      const b = await readFile(path);
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    },
    async writeFile(path, data) {
      await writeFile(path, data);
    },
    async stat(path) {
      const s = await stat(path);
      return { size: s.size };
    },
    mkdtemp(prefix) {
      return mkdtemp(join(base, prefix));
    },
    async rm(path, o) {
      await rm(path, { recursive: o?.recursive === true, force: true });
    },
    async *readChunks(path, chunkSize) {
      const stream = createReadStream(path, { highWaterMark: chunkSize });
      for await (const chunk of stream) {
        const b = chunk as Buffer;
        yield new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      }
    },
  };
}
