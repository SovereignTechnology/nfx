/**
 * BlobStore — Corestore + one Hyperblobs per named core, sha256 CAS index, disk cap.
 *
 * Put flow (`putBytes` / `putStream`): hash → dedupe against the index → reserve disk cap
 * → chunk into `blockSize` blocks through `Hyperblobs.createWriteStream()` → commit index.
 * For files the hash pass streams the file once before the write pass (two reads, zero
 * risk of writing a duplicate or overshooting the cap).
 */
import type { CoreKeyHex, HyperblobId, Sha256Hex } from '@sovit/core';
import Corestore from 'corestore';
import Hyperblobs from 'hyperblobs';
import type { BlobReadStream, BlobWriteStream } from 'hyperblobs';
import type Hypercore from 'hypercore';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import type { Logger } from '../log/logger.js';
import type { CasEntry, CasIndex } from '../store/cas-index.js';
import type { DiskCap } from '../store/disk-cap.js';
import { toHex } from '../util/hex.js';

export const DEFAULT_CORE_NAME = 'blobs' as const;

export interface SeedCore {
  readonly name: string;
  readonly core: Hypercore;
  readonly blobs: Hyperblobs;
  readonly keyHex: CoreKeyHex;
}

export type PutError =
  | { readonly code: 'disk-cap'; readonly needed: number; readonly free: number }
  | { readonly code: 'size-mismatch'; readonly declared: number; readonly actual: number }
  | { readonly code: 'not-a-file'; readonly path: string }
  | { readonly code: 'write-failed'; readonly message: string };

export type PutResult =
  | { readonly ok: true; readonly entry: CasEntry; readonly deduplicated: boolean }
  | { readonly ok: false; readonly error: PutError };

export interface PutOptions {
  readonly core?: string;
  readonly mime?: string;
}

export interface BlobStoreOptions {
  readonly storageDir: string;
  readonly blockSize: number;
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly index: CasIndex;
  readonly diskCap: DiskCap;
  readonly logger: Logger;
  /** Called for every core the store opens (the seeder attaches the upload gate + swarm join). */
  readonly onCoreOpened?: (c: SeedCore) => void;
}

export class BlobStore {
  readonly store: Corestore;
  private readonly cores = new Map<string, SeedCore>();
  private readonly byKey = new Map<string, SeedCore>();
  private readonly log: Logger;
  private closed = false;

  constructor(private readonly opts: BlobStoreOptions) {
    this.store = new Corestore(opts.storageDir);
    this.log = opts.logger.child({ component: 'blobs' });
  }

  get blockSize(): number {
    return this.opts.blockSize;
  }

  async ready(): Promise<void> {
    await this.store.ready();
  }

  /** Open (or create) a named core and its Hyperblobs. Idempotent. */
  async openCore(name: string = DEFAULT_CORE_NAME): Promise<SeedCore> {
    const existing = this.cores.get(name);
    if (existing) return existing;
    const core = this.store.get({ name });
    await core.ready();
    const blobs = new Hyperblobs(core, { blockSize: this.opts.blockSize });
    const sc: SeedCore = { name, core, blobs, keyHex: toHex(core.key) as CoreKeyHex };
    this.cores.set(name, sc);
    this.byKey.set(sc.keyHex, sc);
    this.log.info('core opened', { name, core: sc.keyHex, length: core.length });
    this.opts.onCoreOpened?.(sc);
    return sc;
  }

  /** Open a core by key (read-only replica, e.g. a gateway fetching upstream). */
  async openCoreByKey(key: Uint8Array): Promise<SeedCore> {
    const hex = toHex(key);
    const existing = this.byKey.get(hex);
    if (existing) return existing;
    const core = this.store.get({ key });
    await core.ready();
    const blobs = new Hyperblobs(core, { blockSize: this.opts.blockSize });
    const sc: SeedCore = { name: `key:${hex}`, core, blobs, keyHex: hex as CoreKeyHex };
    this.cores.set(sc.name, sc);
    this.byKey.set(hex, sc);
    this.opts.onCoreOpened?.(sc);
    return sc;
  }

  coreByKey(keyHex: string): SeedCore | undefined {
    return this.byKey.get(keyHex);
  }

  openCores(): readonly SeedCore[] {
    return [...this.cores.values()];
  }

  async putBytes(bytes: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    const h = this.opts.crypto.createSha256();
    h.update(bytes);
    const sha = h.digestHex() as Sha256Hex;
    return this.writeHashed(sha, bytes.byteLength, [bytes], opts);
  }

  /** `source` must be re-iterable if it is a file; `size` is enforced. */
  async putStream(
    source: () => AsyncIterable<Uint8Array>,
    size: number,
    opts: PutOptions = {},
  ): Promise<PutResult> {
    const h = this.opts.crypto.createSha256();
    let seen = 0;
    for await (const chunk of source()) {
      h.update(chunk);
      seen += chunk.byteLength;
    }
    if (seen !== size)
      return { ok: false, error: { code: 'size-mismatch', declared: size, actual: seen } };
    const sha = h.digestHex() as Sha256Hex;
    return this.writeHashed(sha, size, source(), opts);
  }

  async putFile(path: string, opts: PutOptions = {}): Promise<PutResult> {
    const st = await this.opts.fs.stat(path);
    if (!st?.isFile) return { ok: false, error: { code: 'not-a-file', path } };
    return this.putStream(() => this.opts.fs.readStream(path), st.size, opts);
  }

  has(sha256: string): boolean {
    return this.opts.index.has(sha256);
  }

  entry(sha256: string): CasEntry | undefined {
    return this.opts.index.get(sha256);
  }

  /** Read a whole blob by sha256 (null if unknown or not locally available). */
  async get(sha256: string, opts?: { readonly wait?: boolean }): Promise<Uint8Array | null> {
    const e = this.opts.index.get(sha256);
    if (!e) return null;
    const sc = this.byKey.get(e.coreKey);
    if (!sc) return null;
    return sc.blobs.get(e.blob, { wait: opts?.wait ?? false });
  }

  /** Range read as a stream (what the Blossom `GET /<sha256>` with `Range` needs). `end` is INCLUSIVE (Hyperblobs semantics). */
  createReadStream(
    sha256: string,
    opts?: { readonly start?: number; readonly end?: number; readonly wait?: boolean },
  ): BlobReadStream | null {
    const e = this.opts.index.get(sha256);
    if (!e) return null;
    const sc = this.byKey.get(e.coreKey);
    if (!sc) return null;
    return sc.blobs.createReadStream(e.blob, {
      wait: opts?.wait ?? false,
      ...(opts?.start !== undefined ? { start: opts.start } : {}),
      ...(opts?.end !== undefined ? { end: opts.end } : {}),
    });
  }

  /** Clear the blob's blocks locally, drop the index entry, free the cap. */
  async remove(sha256: string): Promise<boolean> {
    const e = this.opts.index.get(sha256);
    if (!e) return false;
    const sc = this.byKey.get(e.coreKey);
    if (sc) await sc.blobs.clear(e.blob);
    this.opts.index.remove(sha256);
    this.opts.diskCap.free(e.size);
    this.log.info('blob removed', { sha256: e.sha256, size: e.size });
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const sc of this.cores.values()) await sc.core.close();
    this.cores.clear();
    this.byKey.clear();
    await this.store.close();
  }

  private async writeHashed(
    sha: Sha256Hex,
    size: number,
    source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    opts: PutOptions,
  ): Promise<PutResult> {
    const dup = this.opts.index.get(sha);
    if (dup) return { ok: true, entry: dup, deduplicated: true };

    const reservation = this.opts.diskCap.reserve(size);
    if (reservation === null) {
      this.log.warn('disk cap reached — refusing blob', {
        sha256: sha,
        needed: size,
        free: this.opts.diskCap.freeBytes,
      });
      return {
        ok: false,
        error: { code: 'disk-cap', needed: size, free: this.opts.diskCap.freeBytes },
      };
    }

    try {
      const sc = await this.openCore(opts.core ?? DEFAULT_CORE_NAME);
      const id = await this.writeBlocks(sc, source);
      if (id.byteLength !== size) {
        await sc.blobs.clear(id);
        reservation.release();
        return {
          ok: false,
          error: { code: 'size-mismatch', declared: size, actual: id.byteLength },
        };
      }
      reservation.commit();
      const entry = this.opts.index.add({
        sha256: sha,
        coreKey: sc.keyHex,
        blob: id,
        size,
        ...(opts.mime !== undefined ? { mime: opts.mime } : {}),
      });
      this.log.info('blob stored', {
        sha256: sha,
        core: sc.keyHex,
        blocks: id.blockLength,
        size,
      });
      return { ok: true, entry, deduplicated: false };
    } catch (err) {
      reservation.release();
      const message = err instanceof Error ? err.message : String(err);
      this.log.error('blob write failed', { sha256: sha, error: err });
      return { ok: false, error: { code: 'write-failed', message } };
    }
  }

  /** Chunk arbitrary input into exactly `blockSize` blocks (Hyperblobs writes 1 block per write). */
  private async writeBlocks(
    sc: SeedCore,
    source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<HyperblobId> {
    const ws: BlobWriteStream = sc.blobs.createWriteStream();
    const done = new Promise<HyperblobId>((resolve, reject) => {
      ws.once('error', reject);
      ws.once('close', () => {
        resolve(ws.id);
      });
    });
    const blockSize = this.opts.blockSize;
    let pending: Uint8Array | null = null;

    const write = async (block: Uint8Array): Promise<void> => {
      if (!ws.write(block)) await new Promise<void>((r) => ws.once('drain', r));
    };

    try {
      for await (const chunk of source) {
        let buf: Uint8Array = chunk;
        if (pending !== null) {
          const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
          merged.set(pending, 0);
          merged.set(chunk, pending.byteLength);
          buf = merged;
          pending = null;
        }
        let off = 0;
        while (buf.byteLength - off >= blockSize) {
          await write(buf.subarray(off, off + blockSize));
          off += blockSize;
        }
        if (off < buf.byteLength) pending = buf.slice(off);
      }
      if (pending !== null) await write(pending);
      ws.end();
    } catch (err) {
      ws.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    return done;
  }
}
