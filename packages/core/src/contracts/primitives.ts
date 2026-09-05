/**
 * Branded primitive types shared by every contract.
 *
 * Brands are compile-time only; they exist so a Nostr pubkey cannot be passed where a
 * Cashu P2PK pubkey is expected, and a file sha256 cannot be confused with a core key.
 * Validation (length, charset) is the job of the implementation that mints the value.
 */

declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

/** Lower-case hex, 64 chars: a 32-byte value. */
export type Hex32 = Branded<string, 'Hex32'>;

/** Nostr public key (x-only secp256k1, 32 bytes, hex). */
export type NostrPubkey = Branded<string, 'NostrPubkey'>;

/** Nostr event id (sha256 of the serialised event, hex). */
export type NostrEventId = Branded<string, 'NostrEventId'>;

/** Cashu P2PK (NUT-11) public key: 33-byte compressed secp256k1, hex (66 chars). */
export type CashuP2pkPubkey = Branded<string, 'CashuP2pkPubkey'>;

/** SHA-256 of a full file — the Blossom identity of a blob (BUD-01). */
export type Sha256Hex = Branded<string, 'Sha256Hex'>;

/** Hypercore public key, hex (64 chars). `hyper://` URLs use this hex form (not z32). */
export type CoreKeyHex = Branded<string, 'CoreKeyHex'>;

/** Absolute mint URL, e.g. `https://mint.example`. Normalised: no trailing slash. */
export type MintUrl = Branded<string, 'MintUrl'>;

/** Relay websocket URL, e.g. `wss://relay.example`. */
export type RelayUrl = Branded<string, 'RelayUrl'>;

/** Satoshis. Always an integer. Never a float, never a string on the wire. */
export type Sats = Branded<number, 'Sats'>;

/** Unix seconds. */
export type UnixSeconds = Branded<number, 'UnixSeconds'>;

/** Hypercore block index within a core (0-based). */
export type BlockIndex = number;

/** Discriminated result type used across the money path — no exceptions on hot paths. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
