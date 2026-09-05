/**
 * `WsDuplex` against a real `ws` server + client on a loopback port.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { WsDuplex } from '../ws/ws-duplex.js';

interface Pair {
  readonly server: WsDuplex;
  readonly client: WebSocket;
  readonly close: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function pair(opts?: { highWaterMark?: number }): Promise<Pair> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const serverSide = new Promise<WsDuplex>((resolve) => {
    wss.once('connection', (ws) => {
      resolve(new WsDuplex(ws, opts));
    });
  });
  const client = new WebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((r) => client.once('open', r));
  const server = await serverSide;
  const close = async (): Promise<void> => {
    client.terminate();
    if (!server.destroyed) server.destroy();
    wss.close();
    await new Promise<void>((r) =>
      http.close(() => {
        r();
      }),
    );
  };
  cleanups.push(close);
  return { server, client, close };
}

const onceClose = (s: {
  once: (e: 'close', cb: () => void) => unknown;
  destroyed: boolean;
}): Promise<void> =>
  new Promise((r) => {
    if (s.destroyed) r();
    else s.once('close', r);
  });

describe('WsDuplex', () => {
  it('binary frames flow both ways as bytes (client → duplex readable, duplex write → client)', async () => {
    const { server, client } = await pair();
    const got: Buffer[] = [];
    server.on('data', (d: unknown) => got.push(d as Buffer));
    client.send(Buffer.from([1, 2, 3]));
    client.send(new Uint8Array([4, 5]));
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(got)).toEqual(Buffer.from([1, 2, 3, 4, 5]));

    const fromServer = new Promise<Buffer>((r) =>
      client.once('message', (d) => {
        r(d as Buffer);
      }),
    );
    server.write(Buffer.from('hello'));
    expect((await fromServer).toString()).toBe('hello');
    const asU8 = new Promise<Buffer>((r) =>
      client.once('message', (d) => {
        r(d as Buffer);
      }),
    );
    server.write(new Uint8Array([9, 9]));
    expect([...(await asU8)]).toEqual([9, 9]);
  });

  it('a text frame is a protocol violation: the duplex destroys and the socket closes', async () => {
    const { server, client } = await pair();
    server.on('error', () => undefined);
    const closed = onceClose(server);
    client.send('not binary');
    await closed;
    expect(server.destroyed).toBe(true);
    await new Promise<void>((r) => {
      if (client.readyState === WebSocket.CLOSED) r();
      else
        client.once('close', () => {
          r();
        });
    });
  });

  it('remote close destroys the duplex; destroying the duplex closes the socket gracefully', async () => {
    const a = await pair();
    const closedA = onceClose(a.server);
    a.client.close(1000);
    await closedA;
    expect(a.server.destroyed).toBe(true);

    const b = await pair();
    const clientClosed = new Promise<number>((r) =>
      b.client.once('close', (code) => {
        r(code);
      }),
    );
    b.server.destroy();
    expect(await clientClosed).toBe(1000); // close frame, not a TCP reset
  });

  it('bytes written before a destroy still reach the client (graceful close, spike S-A cut semantics)', async () => {
    const { server, client } = await pair();
    const received: Buffer[] = [];
    client.on('message', (d) => received.push(d as Buffer));
    const clientClosed = new Promise<void>((r) =>
      client.once('close', () => {
        r();
      }),
    );
    for (let i = 0; i < 5; i++) server.write(Buffer.alloc(1024, i));
    // streamx `destroy()` after `write()`: pending writes are dropped by streamx itself, so
    // give the queue one turn to drain into `ws.send` before destroying — that is exactly
    // what happens when Hypercore has already handed blocks to the Noise stream.
    await new Promise((r) => setImmediate(r));
    server.destroy();
    await clientClosed;
    expect(received.length).toBe(5);
  });

  it('write backpressure: `write()` returns false once the socket buffer is full and drains later', async () => {
    const { server, client } = await pair({ highWaterMark: 4096 });
    const chunk = Buffer.alloc(64 * 1024, 7);
    // Client does not read → server socket buffers fill; ws.send callbacks wait on flush.
    client.pause();
    let falseSeen = false;
    for (let i = 0; i < 64 && !falseSeen; i++) if (!server.write(chunk)) falseSeen = true;
    expect(falseSeen).toBe(true);
    const drained = new Promise<void>((r) =>
      server.once('drain', () => {
        r();
      }),
    );
    client.resume();
    await drained;
  });

  it('read backpressure: frames that arrive while nobody reads are paused, not lost, and drain in order', async () => {
    const { server, client } = await pair({ highWaterMark: 1024 });
    const N = 32;
    for (let i = 0; i < N; i++) client.send(Buffer.alloc(8 * 1024, i));
    await new Promise((r) => setTimeout(r, 100));
    const got: Buffer[] = [];
    await new Promise<void>((resolve) => {
      server.on('data', (d: unknown) => {
        got.push(d as Buffer);
        if (Buffer.concat(got).byteLength === N * 8 * 1024) resolve();
      });
    });
    const all = Buffer.concat(got);
    for (let i = 0; i < N; i++) expect(all[i * 8 * 1024]).toBe(i);
  });
});
