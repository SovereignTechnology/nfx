/**
 * `ws` WebSocket ⇄ streamx `Duplex` (spike S-B: "a WebSocket→streamx Duplex adapter is
 * the only bridge code"). One WebSocket = one Hypercore replication stream: the raw side
 * of `seeder.replicate(false)` is piped into this and this back into it.
 *
 * Semantics chosen (and tested in `__tests__/ws-duplex.test.ts`):
 *   - Every message is a binary frame carrying raw Noise bytes. A TEXT frame is a protocol
 *     violation and destroys the stream (nothing on this socket is ever text).
 *   - Write backpressure is real: `_write` completes when `ws` has flushed the frame to the
 *     socket (`send(data, cb)`), so a slow browser stalls Hypercore instead of buffering
 *     unboundedly in the gateway.
 *   - Read backpressure is real: when `push()` reports a full buffer the socket is
 *     `pause()`d and `resume()`d from `_read`.
 *   - Destroy is GRACEFUL where possible: a seeder-side cut (spike S-A) destroys the Noise
 *     stream, which destroys this duplex; we `close()` (not `terminate()`) so the frames
 *     already handed to the socket still reach the viewer — that is what makes "the viewer
 *     holds exactly `window` blocks" hold over a real socket. `ws` itself terminates if the
 *     peer never answers the close handshake (its own `closeTimeout`, 30 s).
 *   - The remote closing the socket destroys the duplex, which the streamx pipeline
 *     propagates to the Noise stream, which closes the seeder's `PeerSession`.
 *
 * `streamx` is a transitive dependency of `hypercore` (lockfile 2.28.1). It is imported
 * directly here because the Hypercore side of the pipe IS a streamx stream and mixing in
 * a `node:stream` Duplex costs a compatibility shim for nothing. See docs/lanes/L3.md.
 */
import { Duplex } from 'streamx';
import type { WebSocket } from 'ws';

export interface WsDuplexOptions {
  /** streamx highWaterMark for both sides (bytes). Default 1 MiB. */
  readonly highWaterMark?: number;
}

const OPEN = 1;
const CONNECTING = 0;

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class WsDuplex extends Duplex {
  private readonly ws: WebSocket;
  private remoteClosed = false;

  constructor(ws: WebSocket, opts: WsDuplexOptions = {}) {
    super({ highWaterMark: opts.highWaterMark ?? 1024 * 1024 });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.destroy(new Error('ws-duplex: text frame on a binary-only socket'));
        return;
      }
      if (!this.push(toBuffer(data))) ws.pause();
    });
    ws.on('close', () => {
      this.remoteClosed = true;
      if (!this.destroyed) this.destroy();
    });
    ws.on('error', (err) => {
      if (!this.destroyed) this.destroy(err);
    });
  }

  override _read(cb: (err: Error | null) => void): void {
    if (this.ws.isPaused) this.ws.resume();
    cb(null);
  }

  override _write(data: unknown, cb: (err: Error | null) => void): void {
    if (this.ws.readyState !== OPEN) {
      cb(new Error('ws-duplex: socket not open'));
      return;
    }
    const buf = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : null;
    if (buf === null) {
      cb(new Error('ws-duplex: non-binary write'));
      return;
    }
    this.ws.send(buf, { binary: true }, (err) => {
      cb(err ?? null);
    });
  }

  override _final(cb: (err: Error | null) => void): void {
    if (this.ws.readyState === OPEN) this.ws.close(1000);
    cb(null);
  }

  override _destroy(cb: (err: Error | null) => void): void {
    // A socket paused for read backpressure never sees the peer's close frame; let it
    // flow again (pushes into a destroyed stream are dropped) so the handshake completes.
    if (this.ws.isPaused) this.ws.resume();
    if (!this.remoteClosed) {
      const state = this.ws.readyState;
      if (state === OPEN) this.ws.close(1000);
      else if (state === CONNECTING) this.ws.terminate();
    }
    cb(null);
  }
}
