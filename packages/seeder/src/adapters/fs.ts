/**
 * Filesystem adapter. The seeder never imports `node:fs` outside `adapters/node/`; on Bare
 * L6 supplies an implementation over `bare-fs` with the same shape.
 */
export interface FileStat {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export interface SeederFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts?: { readonly recursive?: boolean }): Promise<void>;
  /** Resolves `null` when the path does not exist. */
  stat(path: string): Promise<FileStat | null>;
  /** Streaming read for large files. Chunk size is implementation-defined. */
  readStream(path: string): AsyncIterable<Uint8Array>;
  join(...parts: string[]): string;
}
