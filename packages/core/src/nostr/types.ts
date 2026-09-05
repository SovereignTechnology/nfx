/**
 * Types owned by the Nostr data layer (lane L1). Contract types come from
 * `../contracts/`; nothing here duplicates them.
 */
import type {
  NostrEvent,
  NostrFilter,
  NostrPubkey,
  RelayConfig,
  RelayUrl,
  Signer,
  UnixSeconds,
  UnsignedNostrEvent,
} from '../contracts/index.js';

/** An unsigned event without a pubkey — what builders emit and `Signer.signEvent` consumes. */
export type EventDraft = Omit<UnsignedNostrEvent, 'pubkey'>;

/** Outcome of publishing one event to one relay. */
export interface PublishResult {
  readonly url: RelayUrl;
  readonly ok: boolean;
  /** Relay-supplied OK message or the failure reason. */
  readonly reason?: string;
}

export interface SubscriptionHandlers {
  /**
   * Raw, UNVERIFIED wire object. The only way to turn it into a `NostrEvent` is
   * `verifyIncoming` (see `event.ts`); `NostrClient` does that for you.
   */
  readonly onevent: (raw: unknown) => void;
  readonly oneose?: () => void;
  readonly onclose?: (reason: string) => void;
}

export type Unsubscribe = () => void;

/**
 * The relay/pool port. Everything the data layer needs from the network, and nothing
 * more, so it can be backed by `nostr-tools` `SimplePool` in production and by
 * `FakeRelayPool` in tests (tests never open a socket).
 *
 * Events come back as `unknown` on purpose: a relay is an untrusted source (T9), and the
 * type system should not let an unverified object masquerade as a `NostrEvent`.
 */
export interface PoolLike {
  query(
    relays: readonly RelayUrl[],
    filter: NostrFilter,
    opts?: { readonly maxWaitMs?: number },
  ): Promise<readonly unknown[]>;
  subscribe(
    relays: readonly RelayUrl[],
    filters: readonly NostrFilter[],
    handlers: SubscriptionHandlers,
    opts?: { readonly maxWaitMs?: number },
  ): Unsubscribe;
  publish(relays: readonly RelayUrl[], event: NostrEvent): Promise<readonly PublishResult[]>;
  close(): void;
}

/** Why an incoming object was dropped at the verification boundary. */
export type DropReason = 'malformed' | 'bad-tag' | 'bad-signature';

/**
 * Structural `fetch` for NIP-05 lookups. Core has no DOM lib; the shell passes the real
 * `fetch`, tests pass a stub. Only what the lookup uses is required.
 */
export type FetchLike = (
  url: string,
  init: { readonly redirect: 'manual' },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export interface NostrClientOptions {
  readonly pool: PoolLike;
  readonly relays: readonly RelayConfig[];
  /** Absent = read-only client; every write path throws `NoSignerError`. */
  readonly signer?: Signer;
  readonly now?: () => UnixSeconds;
  /** Observability hook for the verification boundary. Never receives a verified event. */
  readonly onDropped?: (reason: DropReason, raw: unknown) => void;
  /** Per-query relay wait, ms. */
  readonly maxWaitMs?: number;
}

/** Author + id pointer for a regular event, as needed by reaction/comment builders. */
export interface EventRef {
  readonly id: NostrEvent['id'];
  readonly pubkey: NostrPubkey;
  readonly kind: number;
  readonly relayHint?: RelayUrl | undefined;
}
