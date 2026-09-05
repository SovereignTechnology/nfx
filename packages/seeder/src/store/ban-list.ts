/**
 * Persisted ban list keyed on BOTH the Noise public key (transport identity, what
 * hyperswarm's firewall sees) and the Nostr pubkey (payment identity bound in `HELLO`).
 * Spike S-A finding 6 / SECURITY.md invariant 6: a banned peer must be refused on either.
 *
 * File: `<dataDir>/bans.json`. Reloaded on start. Writes are serialised and atomic.
 */
import type { BanEntry, NostrPubkey, UnixSeconds } from '@sovit/core';

import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';
import { fromHex, isHex, toHex } from '../util/hex.js';
import { JsonStore } from './json-store.js';

export const BAN_FILE = 'bans.json' as const;

export interface PersistedBan {
  readonly pubkey: string | null;
  readonly noiseKey: string | null;
  readonly reason: string;
  readonly at: number;
}

interface BanFile {
  readonly version: 1;
  readonly bans: readonly PersistedBan[];
}

function validateBanFile(raw: unknown): BanFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== 1 || !Array.isArray(o['bans'])) return null;
  const bans: PersistedBan[] = [];
  for (const b of o['bans'] as unknown[]) {
    if (typeof b !== 'object' || b === null) return null;
    const e = b as Record<string, unknown>;
    const pubkey = e['pubkey'];
    const noiseKey = e['noiseKey'];
    if (pubkey !== null && (typeof pubkey !== 'string' || !isHex(pubkey, 32))) return null;
    if (noiseKey !== null && (typeof noiseKey !== 'string' || !isHex(noiseKey, 32))) return null;
    if (pubkey === null && noiseKey === null) return null;
    if (typeof e['reason'] !== 'string' || typeof e['at'] !== 'number') return null;
    bans.push({
      pubkey,
      noiseKey,
      reason: e['reason'],
      at: e['at'],
    });
  }
  return { version: 1, bans };
}

export interface BanListOptions {
  readonly fs: SeederFs;
  readonly crypto: SeederCrypto;
  readonly dataDir: string;
  readonly now?: () => UnixSeconds;
}

export class BanList {
  private readonly byPubkey = new Map<string, PersistedBan>();
  private readonly byNoise = new Map<string, PersistedBan>();
  private readonly store: JsonStore<BanFile>;
  private readonly now: () => UnixSeconds;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  /** True if the file on disk was unparseable and has been ignored (caller logs it). */
  corruptOnLoad = false;
  /** Last persistence failure, if any (caller logs it; bans stay effective in memory). */
  lastPersistError: Error | null = null;

  constructor(opts: BanListOptions) {
    this.store = new JsonStore<BanFile>(
      opts.fs,
      opts.crypto,
      opts.fs.join(opts.dataDir, BAN_FILE),
      validateBanFile,
      () => ({ version: 1, bans: [] }),
    );
    this.now = opts.now ?? ((): UnixSeconds => Math.floor(Date.now() / 1000) as UnixSeconds);
  }

  async load(): Promise<void> {
    const { value, corrupt } = await this.store.load();
    this.corruptOnLoad = corrupt;
    this.byPubkey.clear();
    this.byNoise.clear();
    for (const b of value.bans) this.index(b);
    this.loaded = true;
  }

  /** Ban by Nostr pubkey and/or Noise key. At least one must be given. Persists. */
  ban(entry: {
    readonly pubkey?: NostrPubkey | null;
    readonly noiseKey?: Uint8Array | null;
    readonly reason: string;
  }): PersistedBan {
    this.assertLoaded();
    const pubkey = entry.pubkey ?? null;
    const noiseKey = entry.noiseKey ? toHex(entry.noiseKey) : null;
    if (pubkey === null && noiseKey === null) throw new Error('ban needs a pubkey or a noise key');
    const b: PersistedBan = { pubkey, noiseKey, reason: entry.reason, at: this.now() };
    this.index(b);
    this.persist();
    return b;
  }

  unban(key: { readonly pubkey?: NostrPubkey; readonly noiseKey?: Uint8Array }): boolean {
    this.assertLoaded();
    let removed = false;
    const victims = new Set<PersistedBan>();
    if (key.pubkey !== undefined) {
      const b = this.byPubkey.get(key.pubkey);
      if (b) victims.add(b);
    }
    if (key.noiseKey !== undefined) {
      const b = this.byNoise.get(toHex(key.noiseKey));
      if (b) victims.add(b);
    }
    for (const b of victims) {
      if (b.pubkey !== null) this.byPubkey.delete(b.pubkey);
      if (b.noiseKey !== null) this.byNoise.delete(b.noiseKey);
      removed = true;
    }
    if (removed) this.persist();
    return removed;
  }

  isPubkeyBanned(pubkey: string): boolean {
    return this.byPubkey.has(pubkey);
  }

  entryFor(pubkey: string): PersistedBan | undefined {
    return this.byPubkey.get(pubkey);
  }

  isNoiseBanned(noiseKey: Uint8Array | string): boolean {
    return this.byNoise.has(typeof noiseKey === 'string' ? noiseKey : toHex(noiseKey));
  }

  /** hyperswarm `firewall` predicate: `true` = reject. */
  readonly firewall = (remotePublicKey: Uint8Array): boolean => this.isNoiseBanned(remotePublicKey);

  entries(): readonly PersistedBan[] {
    const seen = new Set<PersistedBan>();
    for (const b of this.byPubkey.values()) seen.add(b);
    for (const b of this.byNoise.values()) seen.add(b);
    return [...seen].sort((a, b) => a.at - b.at);
  }

  /** Contract-shaped view (`PaymentEngineSeeder.bans()`), for entries that carry a pubkey. */
  asBanEntries(): readonly BanEntry[] {
    return this.entries()
      .filter((b) => b.pubkey !== null)
      .map((b) => ({
        pubkey: b.pubkey as NostrPubkey,
        reason: b.reason,
        at: b.at as UnixSeconds,
        ...(b.noiseKey !== null ? { noiseKey: fromHex(b.noiseKey) } : {}),
      }));
  }

  /** Resolves once every ban issued so far has hit the disk. */
  flushed(): Promise<void> {
    return this.writeChain;
  }

  private index(b: PersistedBan): void {
    if (b.pubkey !== null) this.byPubkey.set(b.pubkey, b);
    if (b.noiseKey !== null) this.byNoise.set(b.noiseKey, b);
  }

  private persist(): void {
    const snapshot: BanFile = { version: 1, bans: this.entries() };
    this.writeChain = this.writeChain
      .then(() => this.store.save(snapshot))
      .catch((err: unknown) => {
        this.lastPersistError = err instanceof Error ? err : new Error(String(err));
      });
  }

  private assertLoaded(): void {
    // Never clobber a file we have not read yet.
    if (!this.loaded) throw new Error('BanList: call load() before mutating');
  }
}
