/**
 * Two small persisted side tables the seeder's CAS index does not carry:
 *
 *   - `OwnerIndex`  — uploader pubkey → sha256[] so `GET /list/<pubkey>` (BUD-02, detail
 *                     in the unvendored BUD-12) can answer. `<dataDir>/blossom-owners.json`.
 *   - `ReportStore` — BUD-09 reports, append-only JSON lines at
 *                     `<dataDir>/blossom-reports.jsonl`, capped in count so the endpoint
 *                     cannot be used to fill the disk.
 *
 * Both are written atomically (tmp + rename) and a corrupt file is ignored with an
 * `error` log rather than a crash — same posture as the seeder's JSON stores.
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { NostrPubkey, Sha256Hex, UnixSeconds } from '@sovit/core';
import type { Logger } from '@sovit/seeder';

export const OWNERS_FILE = 'blossom-owners.json' as const;
export const REPORTS_FILE = 'blossom-reports.jsonl' as const;

const HEX64 = /^[0-9a-f]{64}$/;

interface OwnersFile {
  readonly version: 1;
  readonly owners: Readonly<Record<string, readonly string[]>>;
}

function parseOwners(raw: unknown): OwnersFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || typeof o['owners'] !== 'object' || o['owners'] === null) return null;
  const owners: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(o['owners'] as Record<string, unknown>)) {
    if (
      !HEX64.test(k) ||
      !Array.isArray(v) ||
      !v.every((s) => typeof s === 'string' && HEX64.test(s))
    )
      return null;
    owners[k] = v as string[];
  }
  return { version: 1, owners };
}

export class OwnerIndex {
  private readonly map = new Map<string, Set<string>>();
  private readonly file: string;
  private chain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(
    dataDir: string,
    private readonly log: Logger,
  ) {
    this.file = path.join(dataDir, OWNERS_FILE);
  }

  async load(): Promise<void> {
    this.map.clear();
    try {
      const text = await readFile(this.file, 'utf8');
      const parsed = parseOwners(JSON.parse(text));
      if (parsed === null) this.log.error('owner index on disk was unreadable; starting empty');
      else for (const [pk, list] of Object.entries(parsed.owners)) this.map.set(pk, new Set(list));
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT'))
        this.log.error('owner index on disk was unreadable; starting empty');
    }
    this.loaded = true;
  }

  add(pubkey: NostrPubkey, sha256: Sha256Hex): void {
    if (!this.loaded) throw new Error('OwnerIndex: call load() first');
    let set = this.map.get(pubkey);
    if (!set) {
      set = new Set();
      this.map.set(pubkey, set);
    }
    if (set.has(sha256)) return;
    set.add(sha256);
    this.persist();
  }

  remove(sha256: Sha256Hex): void {
    let changed = false;
    for (const [pk, set] of this.map) {
      if (set.delete(sha256)) changed = true;
      if (set.size === 0) this.map.delete(pk);
    }
    if (changed) this.persist();
  }

  list(pubkey: NostrPubkey): readonly Sha256Hex[] {
    return [...(this.map.get(pubkey) ?? [])] as Sha256Hex[];
  }

  flushed(): Promise<void> {
    return this.chain;
  }

  private persist(): void {
    const owners: Record<string, string[]> = {};
    for (const [pk, set] of this.map) owners[pk] = [...set];
    const doc: OwnersFile = { version: 1, owners };
    this.chain = this.chain
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
        await rename(tmp, this.file);
      })
      .catch((err: unknown) => {
        this.log.error('owner index persist failed', { error: err });
      });
  }
}

export interface StoredReport {
  readonly at: UnixSeconds;
  readonly reporter: NostrPubkey;
  readonly hashes: readonly Sha256Hex[];
  /** The kind-1984 event as received. Its signature is NOT verified here (Stage 2). */
  readonly event: unknown;
  readonly signatureVerified: false;
}

export class ReportStore {
  private readonly file: string;
  private count = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly log: Logger,
    private readonly maxReports = 10_000,
  ) {
    this.file = path.join(dataDir, REPORTS_FILE);
  }

  async load(): Promise<void> {
    try {
      const st = await stat(this.file);
      if (st.size === 0) return;
      const text = await readFile(this.file, 'utf8');
      this.count = text.split('\n').filter((l) => l.length > 0).length;
    } catch {
      this.count = 0;
    }
  }

  get size(): number {
    return this.count;
  }

  /** `false` when the cap is reached (caller answers 429/507). */
  append(report: StoredReport): boolean {
    if (this.count >= this.maxReports) return false;
    this.count++;
    const line = JSON.stringify(report) + '\n';
    this.chain = this.chain
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, line, { mode: 0o600 });
      })
      .catch((err: unknown) => {
        this.log.error('report append failed', { error: err });
      });
    return true;
  }

  flushed(): Promise<void> {
    return this.chain;
  }
}
