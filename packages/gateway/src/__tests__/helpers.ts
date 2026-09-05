/**
 * Shared test rig: a `Gateway` on a tmp dir, loopback port 0, mocks from `@sovit/core`,
 * the two fakes in this directory, and a captured redacting logger. Hermetic: no swarm,
 * no network beyond 127.0.0.1, nothing outside `os.tmpdir()`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { CashuP2pkPubkey, MintUrl, NostrPubkey, PricePolicy, Sats } from '@sovit/core';
import { mocks } from '@sovit/core';
import type { LogRecord, Logger, PeerSessionInfo } from '@sovit/seeder';
import { createLogger } from '@sovit/seeder';

import type { GatewayConfig } from '../config.js';
import { validateConfig } from '../config.js';
import { Gateway } from '../gateway.js';
import type { GatewayDeps } from '../gateway.js';
import { FakeBlossomAuth } from './fake-blossom-auth.js';
import { FakePayProtocol } from './fake-pay-protocol.js';

export const BLOCK = 1024;
export const MINT_A = 'https://mint.fixture-a.example' as MintUrl;
export const MINT_B = 'https://mint.fixture-b.example' as MintUrl;
export const GW_PUBKEY = 'cd'.repeat(32) as NostrPubkey;
export const GW_P2PK = ('02' + 'ab'.repeat(32)) as CashuP2pkPubkey;
export const CREATOR_P2PK = ('03' + 'cc'.repeat(32)) as CashuP2pkPubkey;

export async function tmpDir(
  prefix = 'nutflix-l3-',
): Promise<{ dir: string; rm: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const rmRetry = async (): Promise<void> => {
    for (let i = 0; ; i++) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (err) {
        if (i >= 20) throw err;
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };
  return { dir, rm: rmRetry };
}

export interface CapturedLog {
  readonly logger: Logger;
  readonly lines: string[];
  readonly records: LogRecord[];
}

export function capturedLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): CapturedLog {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  const logger = createLogger({
    level,
    sink: (line, rec) => {
      lines.push(line);
      records.push(rec);
    },
  });
  return { logger, lines, records };
}

export function basePolicy(satsPerBlock = 2): PricePolicy {
  return {
    satsPerBlock: satsPerBlock as Sats,
    blockSize: BLOCK,
    mints: [MINT_A, MINT_B],
    split: { seeder: 50, creator: 50 },
    creatorP2pk: CREATOR_P2PK,
  };
}

/** A validated config for tests (loopback, port 0, small caps). Overrides are RAW JSON. */
export function testConfig(dataDir: string, raw: Record<string, unknown> = {}): GatewayConfig {
  const r = validateConfig({
    listen: { host: '127.0.0.1', port: 0 },
    dataDir,
    diskCapBytes: 4 * 1024 * 1024,
    blockSize: BLOCK,
    identity: { pubkey: GW_PUBKEY, p2pk: GW_P2PK },
    policy: {
      satsPerBlock: 2,
      mints: [MINT_A, MINT_B],
      split: { seeder: 50, creator: 50 },
      creatorP2pk: CREATOR_P2PK,
    },
    acceptedMints: [MINT_A, MINT_B],
    rateLimits: { maxStreams: 16, maxStreamsPerKey: 4, connectsPerWindow: 100, windowMs: 1000 },
    http: {
      maxUploadBytes: 256 * 1024,
      maxJsonBodyBytes: 8 * 1024,
      bodyIdleTimeoutMs: 2000,
      socketIdleTimeoutMs: 5000,
      requestsPerWindow: 10_000,
      windowMs: 1000,
    },
    ws: { handshakeTimeoutMs: 3000, pingIntervalMs: 5000 },
    blossom: { publicUrl: 'http://gw.test' },
    flushEveryBlocks: 1000,
    flushEveryMs: 60_000,
    ...raw,
  });
  if (!r.ok) throw new Error(`test config invalid: ${r.errors.join('; ')}`);
  return r.config;
}

export interface Rig {
  readonly gateway: Gateway;
  readonly config: GatewayConfig;
  readonly engine: mocks.MockPaymentEngine;
  readonly auth: FakeBlossomAuth;
  readonly protocols: FakePayProtocol[];
  readonly sessions: PeerSessionInfo[];
  readonly log: CapturedLog;
  readonly url: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface RigOptions {
  readonly windowBlocks?: number;
  readonly raw?: Record<string, unknown>;
  readonly auth?: FakeBlossomAuth | null;
  readonly payProtocol?: boolean;
  readonly deps?: Partial<GatewayDeps>;
  readonly listen?: boolean;
}

const cleanups: (() => Promise<void>)[] = [];

/** Call from `afterEach`. */
export async function cleanupRigs(): Promise<void> {
  for (const c of cleanups.splice(0).reverse()) await c();
}

export async function rig(o: RigOptions = {}): Promise<Rig> {
  const t = await tmpDir();
  const config = testConfig(t.dir, o.raw);
  const engine = new mocks.MockPaymentEngine({
    mode: 'honest',
    config: {
      windowBlocks: o.windowBlocks ?? 4,
      acceptedMints: [MINT_A, MINT_B],
      ownP2pk: GW_P2PK,
      ownPubkey: GW_PUBKEY,
    },
  });
  const auth = o.auth === undefined ? new FakeBlossomAuth() : o.auth;
  const protocols: FakePayProtocol[] = [];
  const sessions: PeerSessionInfo[] = [];
  const log = capturedLogger();
  const gateway = await Gateway.create(config, {
    seederEngine: engine,
    viewerEngine: engine,
    auth,
    payProtocol:
      o.payProtocol === false
        ? null
        : (session) => {
            sessions.push(session);
            const p = new FakePayProtocol();
            protocols.push(p);
            return p;
          },
    identity: { signChallenge: (c) => Promise.resolve(`sig:${c.slice(0, 8)}`) },
    logger: log.logger,
    ...o.deps,
  });
  let url = '';
  let port = 0;
  if (o.listen !== false) {
    const a = await gateway.listen();
    url = `http://127.0.0.1:${a.port}`;
    port = a.port;
  }
  const close = async (): Promise<void> => {
    await gateway.close();
    await t.rm();
  };
  cleanups.push(close);
  return {
    gateway,
    config,
    engine,
    auth: auth ?? new FakeBlossomAuth(),
    protocols,
    sessions,
    log,
    url,
    port,
    close,
  };
}

export interface HttpResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** Minimal `node:http` client (no fetch: keeps `Content-Length`/HEAD semantics explicit). */
export function request(
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: u.hostname,
        port: Number(u.port),
        path: u.pathname + u.search,
        method: o.method ?? 'GET',
        headers: o.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

export function fixtureBytes(blocks: number, seed = 7): Uint8Array {
  return new Uint8Array(BLOCK * blocks).map((_, i) => (i * 31 + seed) % 256);
}

export const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until(pred: () => boolean, timeoutMs = 5000, step = 20): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until(): timed out');
    await new Promise((r) => setTimeout(r, step));
  }
}

export const pubkey = (seed: string): NostrPubkey => mocks.asPubkey(seed);
