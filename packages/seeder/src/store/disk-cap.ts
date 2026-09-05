/**
 * Disk cap: refuse new blobs once stored payload bytes would exceed `capBytes`.
 *
 * Accounting is in blob PAYLOAD bytes (what the CAS index records), not on-disk bytes —
 * Hypercore's Merkle tree, bitfields and RocksDB overhead are not counted. Size the cap
 * with a margin (a few percent) below the real budget. Reservations make concurrent puts
 * safe: a put reserves its full size before writing and releases on failure.
 */
export class DiskCap {
  private reserved = 0;

  constructor(
    readonly capBytes: number,
    private committed: number,
  ) {
    if (!Number.isFinite(capBytes) || capBytes < 0) throw new Error('capBytes must be >= 0');
    if (committed < 0) throw new Error('committed must be >= 0');
  }

  get usedBytes(): number {
    return this.committed;
  }

  get pendingBytes(): number {
    return this.reserved;
  }

  get freeBytes(): number {
    return Math.max(0, this.capBytes - this.committed - this.reserved);
  }

  /** Would a blob of `bytes` fit right now? */
  fits(bytes: number): boolean {
    return bytes >= 0 && this.committed + this.reserved + bytes <= this.capBytes;
  }

  /**
   * Reserve `bytes` for an in-flight put. Returns a handle to `commit()` (bytes are now
   * stored) or `release()` (put failed). `null` when it does not fit.
   */
  reserve(bytes: number): { commit(): void; release(): void } | null {
    if (!this.fits(bytes)) return null;
    this.reserved += bytes;
    let done = false;
    return {
      commit: () => {
        if (done) return;
        done = true;
        this.reserved -= bytes;
        this.committed += bytes;
      },
      release: () => {
        if (done) return;
        done = true;
        this.reserved -= bytes;
      },
    };
  }

  /** Bytes freed by a removal. */
  free(bytes: number): void {
    this.committed = Math.max(0, this.committed - bytes);
  }
}
