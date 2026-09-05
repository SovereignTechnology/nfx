// Node implementation of SeederFs. The only file in the seeder that imports `node:fs`.
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FileStat, SeederFs } from '../fs.js';

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

export const nodeFs: SeederFs = {
  readFile: (path) => readFile(path).then((b) => new Uint8Array(b.buffer, b.byteOffset, b.length)),
  writeFile: (path, data) => writeFile(path, data),
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  mkdir: async (path, opts) => {
    await mkdir(path, { recursive: opts?.recursive ?? false });
  },
  stat: async (path): Promise<FileStat | null> => {
    try {
      const s = await stat(path);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  },
  readStream: (path) => createReadStream(path) as AsyncIterable<Uint8Array>,
  join: (...parts) => join(...parts),
};
