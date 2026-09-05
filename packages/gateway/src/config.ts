/**
 * Gateway configuration: JSON file (`--config <path>`, the canonical systemd unit passes
 * `/etc/nutflix/gateway.json`) + environment overrides, validated on load. No `any`: every
 * field is checked by hand and the error list names PATHS and expected shapes only — never
 * the offending value, so a config error can be logged verbatim (SECURITY.md invariant 7).
 *
 * Defaults are safe-by-default: loopback listener, mirror disabled, markup 0 (build-plan §9
 * Q4 is open — parametrised, not resolved), modest body/connection caps.
 */
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrPubkey,
  PricePolicy,
  Sats,
} from '@sovit/core';
import { DEFAULT_BLOCK_SIZE } from '@sovit/core';
import type { LogLevel, RateLimitConfig, SwarmConfig } from '@sovit/seeder';
import { DEFAULT_RATE_LIMITS } from '@sovit/seeder';

// --------------------------------------------------------------------------- shapes

export interface ListenConfig {
  readonly host: string;
  readonly port: number;
}

export interface HttpLimits {
  /** `PUT /upload` body cap (bytes). 413 above it. */
  readonly maxUploadBytes: number;
  /** JSON bodies (`/mirror`, `/report`) cap (bytes). */
  readonly maxJsonBodyBytes: number;
  /** Time allowed for a client to send its request headers (slow-loris). */
  readonly headersTimeoutMs: number;
  /** Max silence between body chunks before the upload is aborted. */
  readonly bodyIdleTimeoutMs: number;
  /** Idle timeout on a plain HTTP socket (keep-alive, slow readers). */
  readonly socketIdleTimeoutMs: number;
  /** Concurrent HTTP requests, global. */
  readonly maxConcurrentRequests: number;
  /** Concurrent HTTP requests per client address. */
  readonly maxConcurrentPerClient: number;
  /** Requests per client address per `windowMs`. */
  readonly requestsPerWindow: number;
  readonly windowMs: number;
  /**
   * Trust `X-Forwarded-For` (first hop) for the client address. ONLY behind the TLS proxy
   * the deploy unit assumes; on a directly exposed listener it lets anyone pick their
   * rate-limit bucket.
   */
  readonly trustProxy: boolean;
}

export interface WsLimits {
  /** URL path the WebSocket bridge upgrades on. */
  readonly path: string;
  /** Concurrent WebSocket connections (pre- and post-handshake). */
  readonly maxConnections: number;
  /** Noise handshake must complete within this, else the socket is dropped. */
  readonly handshakeTimeoutMs: number;
  /** Liveness ping interval; a socket that misses a pong is terminated. */
  readonly pingIntervalMs: number;
  /** Largest single WebSocket frame accepted (bytes). */
  readonly maxFrameBytes: number;
}

export interface BlossomConfig {
  /** Public base URL used in blob descriptors (`url` field). No trailing slash. */
  readonly publicUrl: string;
  readonly allowUpload: boolean;
  readonly allowMirror: boolean;
  /** Hosts `PUT /mirror` may fetch from (exact host[:port] match). Empty = none. */
  readonly mirrorAllowedHosts: readonly string[];
  readonly allowReport: boolean;
  /** `null` = any MIME type; otherwise an exact allowlist (415 otherwise). */
  readonly allowedMimeTypes: readonly string[] | null;
  /** Pubkeys passed to `BlossomAuth.allow()` / `.deny()` at start. */
  readonly allowPubkeys: readonly NostrPubkey[];
  readonly denyPubkeys: readonly NostrPubkey[];
  /** Require a kind-24242 token on `HEAD /upload` (default false: tokens are single-use). */
  readonly authHeadUpload: boolean;
}

export interface UpstreamConfig {
  /** Pay after every N verified blocks from a peer (contiguous run). Must be ≤ the window. */
  readonly payEveryBlocks: number;
  /**
   * Per-core `PricePolicy` overrides for paying upstream (creator P2PK etc. from the
   * manifest). Keys are core keys (hex). Missing cores fall back to `policy` + HELLO.
   */
  readonly policies: Readonly<Record<string, PricePolicy>>;
}

export interface GatewayConfig {
  readonly listen: ListenConfig;
  readonly dataDir: string;
  readonly diskCapBytes: number;
  readonly blockSize: number;
  /** Gateway's own payment identity (public values only). */
  readonly identity: { readonly pubkey: NostrPubkey; readonly p2pk: CashuP2pkPubkey };
  /** Base price policy the embedded seeder verifies against (before markup). */
  readonly policy: PricePolicy;
  /** Q4 (open): flat per-block markup disclosed in `HELLO`. Default 0. */
  readonly markupSatsPerBlock: Sats;
  /** Mints this gateway accepts payment at (its `HELLO.acceptedMints`). */
  readonly acceptedMints: readonly MintUrl[];
  readonly swarm: SwarmConfig | null;
  readonly rateLimits: RateLimitConfig;
  readonly http: HttpLimits;
  readonly ws: WsLimits;
  readonly blossom: BlossomConfig;
  readonly upstream: UpstreamConfig;
  readonly logLevel: LogLevel;
  readonly flushEveryBlocks: number;
  readonly flushEveryMs: number;
}

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  maxUploadBytes: 2 * 1024 ** 3,
  maxJsonBodyBytes: 64 * 1024,
  headersTimeoutMs: 15_000,
  bodyIdleTimeoutMs: 30_000,
  socketIdleTimeoutMs: 60_000,
  maxConcurrentRequests: 256,
  maxConcurrentPerClient: 16,
  requestsPerWindow: 600,
  windowMs: 60_000,
  trustProxy: false,
};

export const DEFAULT_WS_LIMITS: WsLimits = {
  path: '/ws',
  maxConnections: 64,
  handshakeTimeoutMs: 10_000,
  pingIntervalMs: 30_000,
  maxFrameBytes: 4 * 1024 * 1024,
};

export const DEFAULT_BLOSSOM: BlossomConfig = {
  publicUrl: 'http://127.0.0.1',
  allowUpload: true,
  allowMirror: false,
  mirrorAllowedHosts: [],
  allowReport: true,
  allowedMimeTypes: null,
  allowPubkeys: [],
  denyPubkeys: [],
  authHeadUpload: false,
};

export const DEFAULT_UPSTREAM: UpstreamConfig = { payEveryBlocks: 2, policies: {} };

/** Environment variable names honoured by `loadConfig` (override the file). */
export const ENV = {
  configPath: 'NUTFLIX_GATEWAY_CONFIG',
  listenHost: 'NUTFLIX_GATEWAY_LISTEN_HOST',
  listenPort: 'NUTFLIX_GATEWAY_LISTEN_PORT',
  dataDir: 'NUTFLIX_GATEWAY_DATA_DIR',
  diskCapBytes: 'NUTFLIX_GATEWAY_DISK_CAP_BYTES',
  logLevel: 'NUTFLIX_GATEWAY_LOG_LEVEL',
  publicUrl: 'NUTFLIX_GATEWAY_PUBLIC_URL',
  /** systemd `StateDirectory=` → default `dataDir`. */
  stateDirectory: 'STATE_DIRECTORY',
} as const;

// --------------------------------------------------------------------------- validation

export type ConfigResult =
  | { readonly ok: true; readonly config: GatewayConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX66 = /^[0-9a-f]{66}$/;
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

class Errors {
  readonly list: string[] = [];
  add(path: string, expected: string): void {
    this.list.push(`${path}: ${expected}`);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function str(e: Errors, o: Record<string, unknown>, k: string, path: string, dflt: string): string {
  const v = o[k];
  if (v === undefined) return dflt;
  if (typeof v !== 'string' || v.length === 0) {
    e.add(`${path}.${k}`, 'expected non-empty string');
    return dflt;
  }
  return v;
}

function int(
  e: Errors,
  o: Record<string, unknown>,
  k: string,
  path: string,
  dflt: number,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const v = o[k];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    e.add(`${path}.${k}`, `expected integer in [${min}, ${max}]`);
    return dflt;
  }
  return v;
}

function bool(
  e: Errors,
  o: Record<string, unknown>,
  k: string,
  path: string,
  dflt: boolean,
): boolean {
  const v = o[k];
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') {
    e.add(`${path}.${k}`, 'expected boolean');
    return dflt;
  }
  return v;
}

function strList(
  e: Errors,
  o: Record<string, unknown>,
  k: string,
  path: string,
  dflt: readonly string[],
  each?: (s: string) => boolean,
): readonly string[] {
  const v = o[k];
  if (v === undefined) return dflt;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && (each?.(s) ?? true))) {
    e.add(`${path}.${k}`, each ? 'expected array of well-formed strings' : 'expected string array');
    return dflt;
  }
  return v as string[];
}

function sub(
  e: Errors,
  o: Record<string, unknown>,
  k: string,
  path: string,
): Record<string, unknown> {
  const v = o[k];
  if (v === undefined) return {};
  if (!isRecord(v)) {
    e.add(`${path}.${k}`, 'expected object');
    return {};
  }
  return v;
}

const isMintUrl = (s: string): boolean =>
  /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(s) && !s.endsWith('/');

function policy(
  e: Errors,
  o: Record<string, unknown>,
  path: string,
  blockSize: number,
): PricePolicy {
  const satsPerBlock = int(e, o, 'satsPerBlock', path, 0, 0);
  const mints = strList(e, o, 'mints', path, [], isMintUrl);
  const split = sub(e, o, 'split', path);
  const seeder = int(e, split, 'seeder', `${path}.split`, 50, 0, 100);
  const creator = int(e, split, 'creator', `${path}.split`, 100 - seeder, 0, 100);
  if (seeder + creator !== 100) e.add(`${path}.split`, 'seeder + creator must equal 100');
  const creatorP2pk = str(e, o, 'creatorP2pk', path, '');
  if (creatorP2pk !== '' && !HEX66.test(creatorP2pk))
    e.add(`${path}.creatorP2pk`, 'expected 33-byte compressed pubkey, 66 lower-case hex chars');
  return {
    satsPerBlock: satsPerBlock as Sats,
    blockSize,
    mints: mints as MintUrl[],
    split: { seeder, creator },
    creatorP2pk: creatorP2pk as CashuP2pkPubkey,
  };
}

/** Validate a parsed JSON document into a `GatewayConfig`. Pure. */
export function validateConfig(raw: unknown): ConfigResult {
  const e = new Errors();
  if (!isRecord(raw)) return { ok: false, errors: ['$: expected a JSON object'] };
  const P = '$';

  const listenRaw = sub(e, raw, 'listen', P);
  const listen: ListenConfig = {
    host: str(e, listenRaw, 'host', `${P}.listen`, '127.0.0.1'),
    port: int(e, listenRaw, 'port', `${P}.listen`, 8080, 0, 65_535),
  };

  const dataDir = str(e, raw, 'dataDir', P, '');
  if (dataDir === '') e.add(`${P}.dataDir`, 'required (or STATE_DIRECTORY / env override)');
  const diskCapBytes = int(e, raw, 'diskCapBytes', P, 50 * 1024 ** 3, 0);
  const blockSize = int(e, raw, 'blockSize', P, DEFAULT_BLOCK_SIZE, 1024, 16 * 1024 * 1024);

  const identRaw = sub(e, raw, 'identity', P);
  const pubkey = str(e, identRaw, 'pubkey', `${P}.identity`, '');
  if (!HEX64.test(pubkey)) e.add(`${P}.identity.pubkey`, 'expected 64 lower-case hex chars');
  const p2pk = str(e, identRaw, 'p2pk', `${P}.identity`, '');
  if (!HEX66.test(p2pk)) e.add(`${P}.identity.p2pk`, 'expected 66 lower-case hex chars');

  const pol = policy(e, sub(e, raw, 'policy', P), `${P}.policy`, blockSize);
  const markupSatsPerBlock = int(e, raw, 'markupSatsPerBlock', P, 0, 0) as Sats;
  const acceptedMints = strList(e, raw, 'acceptedMints', P, pol.mints, isMintUrl) as MintUrl[];

  let swarm: SwarmConfig | null = null;
  const swarmRaw = raw['swarm'];
  if (swarmRaw !== undefined && swarmRaw !== null) {
    if (!isRecord(swarmRaw)) e.add(`${P}.swarm`, 'expected object or null');
    else {
      const bs = swarmRaw['bootstrap'];
      let bootstrap: { host: string; port: number }[] | undefined;
      if (bs !== undefined) {
        if (
          !Array.isArray(bs) ||
          !bs.every(
            (b) => isRecord(b) && typeof b['host'] === 'string' && Number.isInteger(b['port']),
          )
        )
          e.add(`${P}.swarm.bootstrap`, 'expected array of { host, port }');
        else bootstrap = bs as { host: string; port: number }[];
      }
      const maxPeers = int(e, swarmRaw, 'maxPeers', `${P}.swarm`, 0, 1);
      // A gateway both announces what it seeds and looks up upstream cores.
      const server = bool(e, swarmRaw, 'server', `${P}.swarm`, true);
      const client = bool(e, swarmRaw, 'client', `${P}.swarm`, true);
      swarm = {
        ...(bootstrap ? { bootstrap } : {}),
        ...(swarmRaw['maxPeers'] !== undefined ? { maxPeers } : {}),
        server,
        client,
      };
    }
  }

  const rl = sub(e, raw, 'rateLimits', P);
  const rateLimits: RateLimitConfig = {
    maxStreams: int(e, rl, 'maxStreams', `${P}.rateLimits`, DEFAULT_RATE_LIMITS.maxStreams, 1),
    maxStreamsPerKey: int(
      e,
      rl,
      'maxStreamsPerKey',
      `${P}.rateLimits`,
      DEFAULT_RATE_LIMITS.maxStreamsPerKey,
      1,
    ),
    connectsPerWindow: int(
      e,
      rl,
      'connectsPerWindow',
      `${P}.rateLimits`,
      DEFAULT_RATE_LIMITS.connectsPerWindow,
      1,
    ),
    windowMs: int(e, rl, 'windowMs', `${P}.rateLimits`, DEFAULT_RATE_LIMITS.windowMs, 1),
  };

  const h = sub(e, raw, 'http', P);
  const D = DEFAULT_HTTP_LIMITS;
  const http: HttpLimits = {
    maxUploadBytes: int(e, h, 'maxUploadBytes', `${P}.http`, D.maxUploadBytes, 1),
    maxJsonBodyBytes: int(e, h, 'maxJsonBodyBytes', `${P}.http`, D.maxJsonBodyBytes, 1),
    headersTimeoutMs: int(e, h, 'headersTimeoutMs', `${P}.http`, D.headersTimeoutMs, 1),
    bodyIdleTimeoutMs: int(e, h, 'bodyIdleTimeoutMs', `${P}.http`, D.bodyIdleTimeoutMs, 1),
    socketIdleTimeoutMs: int(e, h, 'socketIdleTimeoutMs', `${P}.http`, D.socketIdleTimeoutMs, 1),
    maxConcurrentRequests: int(
      e,
      h,
      'maxConcurrentRequests',
      `${P}.http`,
      D.maxConcurrentRequests,
      1,
    ),
    maxConcurrentPerClient: int(
      e,
      h,
      'maxConcurrentPerClient',
      `${P}.http`,
      D.maxConcurrentPerClient,
      1,
    ),
    requestsPerWindow: int(e, h, 'requestsPerWindow', `${P}.http`, D.requestsPerWindow, 1),
    windowMs: int(e, h, 'windowMs', `${P}.http`, D.windowMs, 1),
    trustProxy: bool(e, h, 'trustProxy', `${P}.http`, D.trustProxy),
  };

  const w = sub(e, raw, 'ws', P);
  const W = DEFAULT_WS_LIMITS;
  const wsPath = str(e, w, 'path', `${P}.ws`, W.path);
  if (!wsPath.startsWith('/')) e.add(`${P}.ws.path`, 'must start with /');
  const ws: WsLimits = {
    path: wsPath,
    maxConnections: int(e, w, 'maxConnections', `${P}.ws`, W.maxConnections, 1),
    handshakeTimeoutMs: int(e, w, 'handshakeTimeoutMs', `${P}.ws`, W.handshakeTimeoutMs, 1),
    pingIntervalMs: int(e, w, 'pingIntervalMs', `${P}.ws`, W.pingIntervalMs, 1),
    maxFrameBytes: int(e, w, 'maxFrameBytes', `${P}.ws`, W.maxFrameBytes, 1024),
  };

  const b = sub(e, raw, 'blossom', P);
  const B = DEFAULT_BLOSSOM;
  const publicUrl = str(e, b, 'publicUrl', `${P}.blossom`, B.publicUrl);
  if (!/^https?:\/\/[^\s]+$/.test(publicUrl) || publicUrl.endsWith('/'))
    e.add(`${P}.blossom.publicUrl`, 'expected http(s) URL without trailing slash');
  let allowedMimeTypes: readonly string[] | null = B.allowedMimeTypes;
  if (b['allowedMimeTypes'] !== undefined && b['allowedMimeTypes'] !== null)
    allowedMimeTypes = strList(e, b, 'allowedMimeTypes', `${P}.blossom`, []);
  const isHex64 = (s: string): boolean => HEX64.test(s);
  const blossom: BlossomConfig = {
    publicUrl,
    allowUpload: bool(e, b, 'allowUpload', `${P}.blossom`, B.allowUpload),
    allowMirror: bool(e, b, 'allowMirror', `${P}.blossom`, B.allowMirror),
    mirrorAllowedHosts: strList(e, b, 'mirrorAllowedHosts', `${P}.blossom`, B.mirrorAllowedHosts),
    allowReport: bool(e, b, 'allowReport', `${P}.blossom`, B.allowReport),
    allowedMimeTypes,
    allowPubkeys: strList(e, b, 'allowPubkeys', `${P}.blossom`, [], isHex64) as NostrPubkey[],
    denyPubkeys: strList(e, b, 'denyPubkeys', `${P}.blossom`, [], isHex64) as NostrPubkey[],
    authHeadUpload: bool(e, b, 'authHeadUpload', `${P}.blossom`, B.authHeadUpload),
  };

  const u = sub(e, raw, 'upstream', P);
  const policies: Record<string, PricePolicy> = {};
  const polRaw = u['policies'];
  if (polRaw !== undefined) {
    if (!isRecord(polRaw)) e.add(`${P}.upstream.policies`, 'expected object keyed by core hex');
    else
      for (const [k, v] of Object.entries(polRaw)) {
        if (!HEX64.test(k)) {
          e.add(`${P}.upstream.policies[…]`, 'keys must be 64 lower-case hex chars');
          continue;
        }
        if (!isRecord(v)) {
          e.add(`${P}.upstream.policies.${k.slice(0, 8)}…`, 'expected policy object');
          continue;
        }
        policies[k] = policy(e, v, `${P}.upstream.policies.${k.slice(0, 8)}…`, blockSize);
      }
  }
  const upstream: UpstreamConfig = {
    payEveryBlocks: int(
      e,
      u,
      'payEveryBlocks',
      `${P}.upstream`,
      DEFAULT_UPSTREAM.payEveryBlocks,
      1,
    ),
    policies,
  };

  const logLevelRaw = str(e, raw, 'logLevel', P, 'info');
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel))
    e.add(`${P}.logLevel`, 'expected debug | info | warn | error');

  const flushEveryBlocks = int(e, raw, 'flushEveryBlocks', P, 64, 1);
  const flushEveryMs = int(e, raw, 'flushEveryMs', P, 60_000, 1);

  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) e.add(`${P}.${k}`, 'unknown key');

  if (e.list.length > 0) return { ok: false, errors: e.list };
  return {
    ok: true,
    config: {
      listen,
      dataDir,
      diskCapBytes,
      blockSize,
      identity: { pubkey: pubkey as NostrPubkey, p2pk: p2pk as CashuP2pkPubkey },
      policy: pol,
      markupSatsPerBlock,
      acceptedMints,
      swarm,
      rateLimits,
      http,
      ws,
      blossom,
      upstream,
      logLevel: logLevelRaw as LogLevel,
      flushEveryBlocks,
      flushEveryMs,
    },
  };
}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'listen',
  'dataDir',
  'diskCapBytes',
  'blockSize',
  'identity',
  'policy',
  'markupSatsPerBlock',
  'acceptedMints',
  'swarm',
  'rateLimits',
  'http',
  'ws',
  'blossom',
  'upstream',
  'logLevel',
  'flushEveryBlocks',
  'flushEveryMs',
]);

/**
 * Apply environment overrides to a raw (pre-validation) document. `STATE_DIRECTORY`
 * (systemd) only fills `dataDir` when the file has none; the `NUTFLIX_GATEWAY_*` variables
 * always win. Returns a new object; the input is not mutated.
 */
export function applyEnvOverrides(
  raw: unknown,
  env: (name: string) => string | undefined,
): unknown {
  if (!isRecord(raw)) return raw;
  const out: Record<string, unknown> = { ...raw };
  const listen: Record<string, unknown> = isRecord(out['listen']) ? { ...out['listen'] } : {};
  const host = env(ENV.listenHost);
  if (host !== undefined) listen['host'] = host;
  const port = env(ENV.listenPort);
  if (port !== undefined) listen['port'] = Number(port);
  if (Object.keys(listen).length > 0) out['listen'] = listen;

  const dataDir =
    env(ENV.dataDir) ?? (out['dataDir'] === undefined ? env(ENV.stateDirectory) : undefined);
  if (dataDir !== undefined) out['dataDir'] = dataDir;
  const cap = env(ENV.diskCapBytes);
  if (cap !== undefined) out['diskCapBytes'] = Number(cap);
  const level = env(ENV.logLevel);
  if (level !== undefined) out['logLevel'] = level;
  const publicUrl = env(ENV.publicUrl);
  if (publicUrl !== undefined) {
    const blossom: Record<string, unknown> = isRecord(out['blossom']) ? { ...out['blossom'] } : {};
    blossom['publicUrl'] = publicUrl;
    out['blossom'] = blossom;
  }
  return out;
}

/** Parse JSON text, apply env, validate. The JSON error never includes file content. */
export function parseConfigText(
  text: string,
  env: (name: string) => string | undefined = () => undefined,
): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['$: config file is not valid JSON'] };
  }
  return validateConfig(applyEnvOverrides(raw, env));
}

/** The seeder's price with the gateway markup applied — what `HELLO` discloses. */
export function gatewayPrice(c: Pick<GatewayConfig, 'policy' | 'markupSatsPerBlock'>): Sats {
  return (c.policy.satsPerBlock + c.markupSatsPerBlock) as Sats;
}

/** The policy the embedded seeder verifies downstream `PAY`s against (marked up). */
export function gatewayPolicy(
  c: Pick<GatewayConfig, 'policy' | 'markupSatsPerBlock'>,
): PricePolicy {
  return { ...c.policy, satsPerBlock: gatewayPrice(c) };
}

export type CoreKeyLike = CoreKeyHex | string;

/**
 * True for a listen host that can only be reached from this machine: `localhost`, `::1`
 * (bracketed `[::1]` accepted too, since that is how it is written in URLs), and any
 * IPv4 in `127.0.0.0/8`. `0.0.0.0` / `::` / LAN addresses are NOT loopback. Pure; used to
 * fence `--dev-mocks` (cli/main.ts).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m === null) return false;
  const octets = m.slice(1).map(Number);
  return octets[0] === 127 && octets.every((o) => o <= 255);
}
