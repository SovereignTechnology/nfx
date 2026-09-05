/**
 * Content-addressed index: sha256 of the full file (Blossom identity, BUD-01) →
 * `{ coreKey, blob }` (transport identity: Hypercore key + Hyperblobs id). Build-plan §2.1.
 *
 * File: `<dataDir>/cas-index.json`. Also the source of truth for the disk-cap accounting
 * (sum of `size` over entries) after a restart.
 */
import type { CoreKeyHex, HyperblobId, HyperblobRef, Sha256Hex, UnixSeconds } from '@sovit/core';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import { isHex } from '../util/hex.js';
import { JsonStore } from './json-store.js';

export const CAS_INDEX_FILE = 'cas-index.json' as const;

export interface CasEntry {
  readonly sha256: Sha256Hex;
  readonly coreKey: CoreKeyHex;
  readonly blob: HyperblobId;
  /** Payload bytes. Equals `blob.byteLength`; kept explicit for the cap accounting. */
  readonly size: number;
  readonly addedAt: UnixSeconds;
  /** Optional MIME hint recorded at put time (Blossom `type`). */
  readonly mime?: string;
}

interface CasFile {
  readonly version: 1;
  readonly entries: readonly CasEntry[];
}

function isBlobId(x: unknown): x is HyperblobId {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (['byteOffset', 'blockOffset', 'blockLength', 'byteLength'] as const).every(
    (k) => Number.isInteger(o[k]) && (o[k] as number) >= 0,
  );
}

function validateCasFile(raw: unknown): CasFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || !Array.isArray(o['entries'])) return null;
  const entries: CasEntry[] = [];
  for (const e of o['entries'] as unknown[]) {
    if (typeof e !== 'object' || e === null) return null;
    const r = e as Record<string, unknown>;
    const sha = r['sha256'];
    const core = r['coreKey'];
    if (typeof sha !== 'string' || !isHex(sha, 32)) return null;
    if (typeof core !== 'string' || !isHex(core, 32)) return null;
    if (!isBlobId(r['blob'])) return null;
    if (!Number.isInteger(r['size']) || !Number.isInteger(r['addedAt'])) return null;
    const mime = r['mime'];
    if (mime !== undefined && typeof mime !== 'string') return null;
    entries.push({
      sha256: sha as Sha256Hex,
      coreKey: core as CoreKeyHex,
      blob: r['blob'],
      size: r['size'] as number,
      addedAt: r['addedAt'] as UnixSeconds,
      ...(mime !== undefined ? { mime } : {}),
    });
  }
  return { version: 1, entries };
}

export interface CasIndexOptions {
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly dataDir: string;
  readonly now?: () => UnixSeconds;
}

export class CasIndex {
  private readonly map = new Map<string, CasEntry>();
  private readonly store: JsonStore<CasFile>;
  private readonly now: () => UnixSeconds;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  corruptOnLoad = false;
  lastPersistError: Error | null = null;

  constructor(opts: CasIndexOptions) {
    this.store = new JsonStore<CasFile>(
      opts.fs,
      opts.crypto,
      opts.fs.join(opts.dataDir, CAS_INDEX_FILE),
      validateCasFile,
      () => ({ version: 1, entries: [] }),
    );
    this.now = opts.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  async load(): Promise<void> {
    const { value, corrupt } = await this.store.load();
    this.corruptOnLoad = corrupt;
    this.map.clear();
    for (const e of value.entries) this.map.set(e.sha256, e);
    this.loaded = true;
  }

  get(sha256: string): CasEntry | undefined {
    return this.map.get(sha256.toLowerCase());
  }

  has(sha256: string): boolean {
    return this.map.has(sha256.toLowerCase());
  }

  /** Blossom-style lookup: what L3 needs for `GET /<sha256>`. */
  resolve(sha256: string): HyperblobRef | undefined {
    const e = this.get(sha256);
    return e ? { core: e.coreKey, blob: e.blob } : undefined;
  }

  add(entry: Omit<CasEntry, 'addedAt'>): CasEntry {
    this.assertLoaded();
    const full: CasEntry = { ...entry, addedAt: this.now() };
    this.map.set(entry.sha256, full);
    this.persist();
    return full;
  }

  remove(sha256: string): boolean {
    this.assertLoaded();
    const ok = this.map.delete(sha256.toLowerCase());
    if (ok) this.persist();
    return ok;
  }

  entries(): readonly CasEntry[] {
    return [...this.map.values()];
  }

  /** Sum of payload bytes across all entries. */
  totalBytes(): number {
    let n = 0;
    for (const e of this.map.values()) n += e.size;
    return n;
  }

  flushed(): Promise<void> {
    return this.writeChain;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('CasIndex: call load() before mutating');
  }

  private persist(): void {
    const snapshot: CasFile = { version: 1, entries: this.entries() };
    this.writeChain = this.writeChain
      .then(() => this.store.save(snapshot))
      .catch((err: unknown) => {
        this.lastPersistError = err instanceof Error ? err : new Error(String(err));
      });
  }
}
