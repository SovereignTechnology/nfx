/**
 * WS bridge (build-plan §5.1): one WebSocket = one Hypercore replication stream + `pay/1`.
 *
 * On upgrade the socket is wrapped as a streamx Duplex (`ws-duplex.ts`) and piped into the
 * raw side of `seeder.replicate(false)` — the browser is the Noise initiator, exactly as
 * in spike S-B. From there the seeder does what it does for a hyperswarm connection: the
 * session is admitted after the Noise handshake (ban list → rate limits), every seeded
 * core's synchronous `upload` gate accounts blocks against the peer, and a non-payer is
 * cut at `windowBlocks + 1` inside the `upload` handler (S-A). The `pay/1` protocol is
 * attached by the `Gateway` on `session-open`, like any other session.
 *
 * Hardening (SECURITY.md T11), all config-driven (`ws` block):
 *   - connection cap counted from the upgrade, i.e. BEFORE the Noise handshake — the
 *     seeder's stream cap only sees admitted sessions;
 *   - Noise handshake deadline: a socket that has not completed the handshake in time is
 *     dropped (a pre-handshake socket costs the seeder nothing but a file descriptor);
 *   - ping/pong liveness: a peer that misses a pong is terminated;
 *   - `maxPayload` on frames; `perMessageDeflate` off (CRIME-class + CPU).
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex as NodeDuplex } from 'node:stream';

import type { Logger, Seeder } from '@sovit/seeder';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import type { WsLimits } from '../config.js';
import { WsDuplex } from './ws-duplex.js';

export interface WsBridgeOptions {
  readonly seeder: Seeder;
  readonly limits: WsLimits;
  readonly logger: Logger;
}

export type UpgradeRefusal = 'wrong-path' | 'connection-cap';

export class WsBridge {
  private readonly wss: WebSocketServer;
  private readonly seeder: Seeder;
  private readonly limits: WsLimits;
  private readonly log: Logger;
  private readonly sockets = new Set<WebSocket>();
  private closed = false;
  private readonly counters = { accepted: 0, refused: 0, handshakeTimeouts: 0, pingTimeouts: 0 };

  constructor(o: WsBridgeOptions) {
    this.seeder = o.seeder;
    this.limits = o.limits;
    this.log = o.logger.child({ component: 'ws-bridge' });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: o.limits.maxFrameBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  get connections(): number {
    return this.sockets.size;
  }

  stats(): Readonly<typeof this.counters> {
    return { ...this.counters };
  }

  /**
   * Handle an HTTP `upgrade`. Returns the refusal reason when the socket was NOT taken
   * (the response has been written and the socket destroyed), or `null` on success.
   */
  handleUpgrade(req: IncomingMessage, socket: NodeDuplex, head: Buffer): UpgradeRefusal | null {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== this.limits.path) {
      this.refuse(socket, 404, 'Not Found');
      return 'wrong-path';
    }
    if (this.closed || this.sockets.size >= this.limits.maxConnections) {
      this.counters.refused++;
      this.refuse(socket, 503, 'Service Unavailable');
      return 'connection-cap';
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws);
    });
    return null;
  }

  private refuse(socket: NodeDuplex, status: number, text: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => {
        socket.destroy();
      },
    );
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    this.counters.accepted++;
    const duplex = new WsDuplex(ws);
    const raw = this.seeder.replicate(false);
    const noise = raw.noiseStream;

    raw.on('error', () => undefined);
    duplex.on('error', () => undefined);
    raw.pipe(duplex).pipe(raw);

    // Noise handshake deadline.
    const handshakeTimer = setTimeout(() => {
      if (noise.remotePublicKey === null) {
        this.counters.handshakeTimeouts++;
        this.log.info('ws: noise handshake timeout — dropping');
        raw.destroy(new Error('handshake timeout'));
      }
    }, this.limits.handshakeTimeoutMs);

    // Liveness: ping; a missed pong terminates.
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const pinger = setInterval(() => {
      if (!alive) {
        this.counters.pingTimeouts++;
        this.log.info('ws: pong missed — terminating');
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, this.limits.pingIntervalMs);

    const cleanup = (): void => {
      clearTimeout(handshakeTimer);
      clearInterval(pinger);
      this.sockets.delete(ws);
    };
    ws.once('close', cleanup);
    noise.once('close', () => {
      cleanup();
      if (!duplex.destroyed) duplex.destroy();
    });
    this.log.debug('ws: connection accepted', { connections: this.sockets.size });
  }

  /** Drop every socket. Sessions close through the seeder as their streams die. */
  close(): Promise<void> {
    this.closed = true;
    for (const ws of this.sockets) ws.terminate();
    return new Promise((resolve) => {
      this.wss.close(() => {
        resolve();
      });
    });
  }
}
