/**
 * Hash adapter. sha256 is the CAS identity (Blossom BUD-01); the seeder never implements
 * hashing itself — it calls the platform library (`node:crypto` here, `bare-crypto` on Bare).
 */
export interface Sha256Hasher {
  update(chunk: Uint8Array): void;
  /** Lower-case hex digest. Single use. */
  digestHex(): string;
}

export interface SeederCrypto {
  createSha256(): Sha256Hasher;
  /** Cryptographically random bytes (for temp-file suffixes; never for keys — keys are not L2's). */
  randomHex(bytes: number): string;
}
