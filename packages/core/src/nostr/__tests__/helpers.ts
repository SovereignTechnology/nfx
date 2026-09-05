/**
 * Test-only helpers. The ONLY place in this lane that touches a secret key, and only
 * through `nostr-tools` (`generateSecretKey` / `finalizeEvent`), per the lane rules.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import type {
  NostrEvent,
  NostrPubkey,
  RelayConfig,
  RelayUrl,
  Signer,
  UnixSeconds,
  UnsignedNostrEvent,
  VideoManifest,
} from '../../contracts/index.js';
import { buildVideoEvent } from '../../manifest/build.js';
import { NostrClient } from '../client.js';
import { FakeRelayPool } from '../fake-relay.js';
import type { EventDraft } from '../types.js';

export const T0 = 1_757_000_000 as UnixSeconds;
export const unixAt = (n: number): UnixSeconds => n as UnixSeconds;

export interface SignerCall {
  readonly method: 'signEvent' | 'nip44Encrypt' | 'nip44Decrypt' | 'getPublicKey';
  readonly peer?: string;
}

/**
 * Fake `Signer`: real Schnorr signatures (so `verifyEvent` is exercised for real), but
 * a reversible NON-cryptographic "encryption" so tests can prove the data layer routed
 * plaintext through `nip44Encrypt`/`nip44Decrypt` and nothing else.
 */
export class TestSigner implements Signer {
  readonly kind = 'local' as const;
  readonly calls: SignerCall[] = [];
  readonly #sk: Uint8Array;
  readonly pubkey: NostrPubkey;
  #locked = false;

  constructor() {
    this.#sk = generateSecretKey();
    this.pubkey = getPublicKey(this.#sk) as NostrPubkey;
  }

  getPublicKey(): Promise<NostrPubkey> {
    this.calls.push({ method: 'getPublicKey' });
    return Promise.resolve(this.pubkey);
  }

  signEvent(
    event: Omit<UnsignedNostrEvent, 'pubkey'> & { pubkey?: NostrPubkey },
  ): Promise<NostrEvent> {
    this.calls.push({ method: 'signEvent' });
    if (event.pubkey !== undefined && event.pubkey !== this.pubkey) {
      return Promise.reject(new Error('pubkey mismatch'));
    }
    const signed = finalizeEvent(
      {
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags.map((t) => [...t]),
        content: event.content,
      },
      this.#sk,
    );
    // A real signer (NIP-46/07) hands back plain JSON; strip nostr-tools' symbol cache too.
    return Promise.resolve(JSON.parse(JSON.stringify(signed)) as NostrEvent);
  }

  nip44Encrypt(peerPubkey: NostrPubkey, plaintext: string): Promise<string> {
    this.calls.push({ method: 'nip44Encrypt', peer: peerPubkey });
    return Promise.resolve(
      `fake44:${peerPubkey}:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
    );
  }

  nip44Decrypt(peerPubkey: NostrPubkey, ciphertext: string): Promise<string> {
    this.calls.push({ method: 'nip44Decrypt', peer: peerPubkey });
    const m = /^fake44:([0-9a-f]{64}):(.*)$/.exec(ciphertext);
    if (m?.[1] !== peerPubkey) return Promise.reject(new Error('fake nip44: cannot decrypt'));
    return Promise.resolve(Buffer.from(m[2] ?? '', 'base64').toString('utf8'));
  }

  lock(): Promise<void> {
    this.#locked = true;
    return Promise.resolve();
  }

  isLocked(): boolean {
    return this.#locked;
  }
}

export const RELAY_A = 'wss://a.test' as RelayUrl;
export const RELAY_B = 'wss://b.test' as RelayUrl;
export const RELAYS: readonly RelayConfig[] = [
  { url: RELAY_A, read: true, write: true },
  { url: RELAY_B, read: true, write: false },
];

export interface Rig {
  readonly pool: FakeRelayPool;
  readonly client: NostrClient;
  readonly signer: TestSigner;
  readonly dropped: { reason: string; raw: unknown }[];
  readonly now: () => UnixSeconds;
}

/**
 * Test rig. The clock is a deterministic counter (T0, T0+1, …) so consecutive
 * replaceable events never share a second — a real relay would keep only one of two
 * same-second replacements (lowest id wins), and so does `FakeRelayPool`.
 */
export function rig(opts: { signer?: TestSigner | null; now?: UnixSeconds } = {}): Rig {
  const pool = new FakeRelayPool();
  const signer = opts.signer === undefined ? new TestSigner() : opts.signer;
  const dropped: { reason: string; raw: unknown }[] = [];
  let tick = (opts.now ?? T0) - 1;
  const now = (): UnixSeconds => {
    tick += 1;
    return tick as UnixSeconds;
  };
  const client = new NostrClient({
    pool,
    relays: RELAYS,
    ...(signer ? { signer } : {}),
    now,
    onDropped: (reason, raw) => dropped.push({ reason, raw }),
  });
  return { pool, client, signer: signer ?? new TestSigner(), dropped, now };
}

export async function sign(signer: TestSigner, draft: EventDraft): Promise<NostrEvent> {
  return signer.signEvent(draft);
}

/** A byte-for-byte plausible event whose content was changed after signing. */
export function tamper(
  ev: NostrEvent,
  patch: Partial<NostrEvent> = { content: `${ev.content} (tampered)` },
): NostrEvent {
  return { ...ev, ...patch };
}

/** Sign a fixture manifest as `signer`, returning the event and what the parse should yield. */
export async function signedVideo(signer: TestSigner, fixture: VideoManifest): Promise<NostrEvent> {
  return signer.signEvent(buildVideoEvent(fixture));
}

export function asRaw(ev: NostrEvent): unknown {
  return JSON.parse(JSON.stringify(ev));
}

// vitest treats every file under __tests__ as a suite, so the helpers test themselves.
describe('TestSigner', () => {
  it('produces plain, verifiable events and a reversible fake nip44', async () => {
    const s = new TestSigner();
    const ev = await s.signEvent({ kind: 1, created_at: T0, tags: [['t', 'x']], content: 'c' });
    expect(Object.getOwnPropertySymbols(ev)).toEqual([]);
    expect(ev.pubkey).toBe(s.pubkey);
    const { verifyIncoming } = await import('../event.js');
    expect(verifyIncoming(ev)).not.toBeNull();
    expect(verifyIncoming(tamper(ev))).toBeNull();
    const ct = await s.nip44Encrypt(s.pubkey, 'secret');
    expect(ct).not.toContain('secret');
    expect(await s.nip44Decrypt(s.pubkey, ct)).toBe('secret');
    await expect(s.nip44Decrypt(new TestSigner().pubkey, ct)).rejects.toThrow();
  });
});
