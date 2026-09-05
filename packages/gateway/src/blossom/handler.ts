/**
 * Blossom HTTP (build-plan §5.2): BUD-01 `GET/HEAD /<sha256>[.ext]` with ranges, BUD-02
 * `PUT /upload` + `GET /list/<pubkey>`, BUD-04 `PUT /mirror`, BUD-06 `HEAD /upload`, BUD-09
 * `PUT /report`. Served straight from the seeder's sha256 → blob index; an upload makes
 * the gateway the blob's first seeder (`seeder.putFile`).
 *
 * Every verb that needs authorization goes through the injected `BlossomAuth` interface
 * (`src/auth/index.ts`, LOCKED — the implementation is Stage 2's). This file never parses
 * a token, never checks a signature, and never echoes a header: rejections carry only the
 * fixed `reason` string from the interface. With no `BlossomAuth` wired (Stage 1 runtime)
 * the authenticated verbs answer 503 rather than degrading to "open".
 *
 * `hypercore-blob-server` was read (node_modules/hypercore-blob-server/index.js) and NOT
 * embedded: it owns its own listener, addresses blobs by `?key=&blob=&token=`, and its
 * range parser drops suffix ranges. Its range/416 semantics are reproduced in `range.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

import type { NostrPubkey, Sha256Hex } from '@sovit/core';
import type { CasEntry, Logger, Seeder } from '@sovit/seeder';

import type { BlossomAuth, BlossomVerb } from '../auth/index.js';
import type { BlossomConfig, HttpLimits } from '../config.js';
import { readTextBody, spoolIterableToFile, spoolToFile } from '../http/body.js';
import type { BodyFailure } from '../http/body.js';
import { resolveRange } from './range.js';
import type { OwnerIndex, ReportStore, StoredReport } from './store.js';

export const UPLOAD_SPOOL_DIR = 'upload-spool' as const;
const HEX64 = /^[0-9a-f]{64}$/;
const BLOB_PATH = /^\/([0-9a-fA-F]{64})(?:\.[A-Za-z0-9]{1,16})?$/;
const LIST_PATH = /^\/list\/([0-9a-fA-F]{64})$/;
const OCTET = 'application/octet-stream';

/** MIME → file extension for descriptor URLs (BUD-02 "MUST include a file extension"). */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/vtt': 'vtt',
  'text/plain': 'txt',
  'application/json': 'json',
  [OCTET]: 'bin',
};

export interface BlobDescriptor {
  readonly url: string;
  readonly sha256: Sha256Hex;
  readonly size: number;
  readonly type: string;
  readonly uploaded: number;
}

/** Outbound fetch for BUD-04 mirroring. Injected so tests never touch the network. */
export type MirrorFetch = (url: URL) => Promise<{
  readonly status: number;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  readonly body: AsyncIterable<Uint8Array>;
} | null>;

export interface BlossomHandlerOptions {
  readonly seeder: Seeder;
  /** `null` = no authorization provider wired; authenticated verbs answer 503. */
  readonly auth: BlossomAuth | null;
  readonly config: BlossomConfig;
  readonly http: HttpLimits;
  readonly dataDir: string;
  readonly owners: OwnerIndex;
  readonly reports: ReportStore;
  readonly logger: Logger;
  /** Milliseconds since epoch. */
  readonly now?: () => number;
  readonly mirrorFetch?: MirrorFetch;
}

type Res = ServerResponse;

function cors(res: Res): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function fail(
  res: Res,
  status: number,
  reason: string,
  extra?: Readonly<Record<string, string>>,
): void {
  cors(res);
  res.statusCode = status;
  res.setHeader('X-Reason', reason);
  // An error may leave an unread request body behind (over-cap PUT): close rather than
  // let Node drain gigabytes into /dev/null to keep the connection alive.
  res.setHeader('Connection', 'close');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (extra) for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(reason);
}

function json(res: Res, status: number, body: unknown): void {
  cors(res);
  res.statusCode = status;
  const text = JSON.stringify(body);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', String(Buffer.byteLength(text)));
  res.end(text);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bodyFailureStatus(f: BodyFailure): { status: number; reason: string } {
  switch (f) {
    case 'too-large':
      return { status: 413, reason: 'body exceeds size limit' };
    case 'idle-timeout':
      return { status: 408, reason: 'body idle timeout' };
    case 'aborted':
      return { status: 400, reason: 'request aborted' };
    case 'io':
      return { status: 500, reason: 'storage error' };
  }
}

/** BUD-03 rule: the sha256 is the LAST 64-hex segment of the URL path. */
export function sha256FromUrlPath(pathname: string): Sha256Hex | null {
  const all = pathname.match(/[0-9a-fA-F]{64}/g);
  if (!all) return null;
  const last = all[all.length - 1];
  return last === undefined ? null : (last.toLowerCase() as Sha256Hex);
}

function mimeOf(raw: string | undefined, allowed: readonly string[] | null): string | null {
  const m = (raw ?? OCTET).split(';')[0]?.trim().toLowerCase() ?? OCTET;
  const mime = m === '' ? OCTET : m;
  if (allowed !== null && !allowed.includes(mime)) return null;
  return mime;
}

export class BlossomHandler {
  private readonly seeder: Seeder;
  private readonly auth: BlossomAuth | null;
  private readonly cfg: BlossomConfig;
  private readonly limits: HttpLimits;
  private readonly spoolDir: string;
  private readonly owners: OwnerIndex;
  private readonly reports: ReportStore;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly mirrorFetch: MirrorFetch | null;
  private spoolSeq = 0;

  constructor(o: BlossomHandlerOptions) {
    this.seeder = o.seeder;
    this.auth = o.auth;
    this.cfg = o.config;
    this.limits = o.http;
    this.spoolDir = path.join(o.dataDir, UPLOAD_SPOOL_DIR);
    this.owners = o.owners;
    this.reports = o.reports;
    this.log = o.logger.child({ component: 'blossom' });
    this.now = o.now ?? Date.now;
    this.mirrorFetch = o.mirrorFetch ?? null;
  }

  descriptor(e: CasEntry): BlobDescriptor {
    const type = e.mime ?? OCTET;
    const ext = EXT_BY_MIME[type] ?? 'bin';
    return {
      url: `${this.cfg.publicUrl}/${e.sha256}.${ext}`,
      sha256: e.sha256,
      size: e.size,
      type,
      uploaded: e.addedAt,
    };
  }

  /** Route one request. Resolves when the response has been started/ended. */
  async handle(req: IncomingMessage, res: Res): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';

    if (method === 'OPTIONS') {
      cors(res);
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, *');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, DELETE');
      res.setHeader('Access-Control-Max-Age', '86400');
      res.end();
      return;
    }

    const blob = BLOB_PATH.exec(pathname);
    if (blob) {
      const sha = (blob[1] ?? '').toLowerCase() as Sha256Hex;
      if (method === 'GET' || method === 'HEAD') {
        await this.getBlob(req, res, sha, method === 'HEAD');
        return;
      }
      if (method === 'DELETE') {
        fail(res, 405, 'delete not supported', { Allow: 'GET, HEAD' });
        return;
      }
      fail(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
      return;
    }

    if (pathname === '/upload') {
      if (method === 'PUT') {
        await this.putUpload(req, res);
        return;
      }
      if (method === 'HEAD') {
        await this.headUpload(req, res);
        return;
      }
      fail(res, 405, 'method not allowed', { Allow: 'PUT, HEAD' });
      return;
    }

    if (pathname === '/mirror') {
      if (method === 'PUT') {
        await this.putMirror(req, res);
        return;
      }
      fail(res, 405, 'method not allowed', { Allow: 'PUT' });
      return;
    }

    if (pathname === '/report') {
      if (method === 'PUT') {
        await this.putReport(req, res);
        return;
      }
      fail(res, 405, 'method not allowed', { Allow: 'PUT' });
      return;
    }

    const list = LIST_PATH.exec(pathname);
    if (list) {
      if (method !== 'GET') {
        fail(res, 405, 'method not allowed', { Allow: 'GET' });
        return;
      }
      const pk = (list[1] ?? '').toLowerCase() as NostrPubkey;
      const entries = this.owners
        .list(pk)
        .map((s) => this.seeder.blob(s))
        .filter((e): e is CasEntry => e !== undefined)
        .map((e) => this.descriptor(e));
      json(res, 200, entries);
      return;
    }

    if (pathname === '/') {
      fail(res, 404, 'blossom server: GET /<sha256>, PUT /upload, PUT /mirror, PUT /report');
      return;
    }
    fail(res, 404, 'not found');
  }

  // ------------------------------------------------------------------ BUD-01

  private async getBlob(
    req: IncomingMessage,
    res: Res,
    sha: Sha256Hex,
    head: boolean,
  ): Promise<void> {
    const entry = this.seeder.blob(sha);
    if (!entry) {
      fail(res, 404, 'blob not found');
      return;
    }
    cors(res);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', entry.mime ?? OCTET);
    res.setHeader('ETag', `"${entry.sha256}"`);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const range = resolveRange(header(req, 'range'), entry.size);
    let start = 0;
    let end = entry.size - 1;
    if (range.kind === 'unsatisfiable') {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${entry.size}`);
      res.setHeader('X-Reason', 'range not satisfiable');
      res.end();
      return;
    }
    if (range.kind === 'partial') {
      start = range.start;
      end = range.end;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${entry.size}`);
    } else {
      res.statusCode = 200;
    }
    const length = entry.size === 0 ? 0 : end - start + 1;
    res.setHeader('Content-Length', String(length));
    if (head || length === 0) {
      res.end();
      return;
    }

    const rs = this.seeder.createBlobReadStream(sha, { start, end, wait: true });
    if (rs === null) {
      // Index and store disagree (core not open). Nothing has been sent yet.
      res.removeHeader('Content-Length');
      res.statusCode = 503;
      res.setHeader('X-Reason', 'blob temporarily unavailable');
      res.end();
      return;
    }
    let sent = 0;
    const onClose = (): void => {
      if (!rs.destroyed) rs.destroy();
    };
    res.on('close', onClose);
    try {
      for await (const chunk of rs) {
        if (res.destroyed) break;
        sent += chunk.byteLength;
        if (!res.write(chunk))
          await new Promise<void>((resolve) => {
            res.once('drain', resolve);
            res.once('close', resolve);
          });
      }
      if (!res.destroyed) {
        if (sent === length) res.end();
        else res.destroy();
      }
    } catch (err) {
      this.log.warn('blob read failed mid-response', { sha256: sha, sent, error: err });
      res.destroy();
    } finally {
      res.off('close', onClose);
    }
  }

  // ------------------------------------------------------------------ auth boundary

  private async authorize(
    req: IncomingMessage,
    res: Res,
    verb: BlossomVerb,
    sha256: Sha256Hex | null,
    headerOverride?: string,
  ): Promise<NostrPubkey | null> {
    if (this.auth === null) {
      fail(res, 503, 'authorization provider unavailable');
      return null;
    }
    const h = headerOverride ?? header(req, 'authorization');
    if (h === undefined || h === '') {
      fail(res, 401, 'authorization required');
      return null;
    }
    const now = Math.floor(this.now() / 1000);
    const r = await this.auth.verify(
      sha256 === null ? { verb, header: h, now } : { verb, header: h, sha256, now },
    );
    if (!r.ok) {
      this.log.info('blossom auth rejected', { verb, reason: r.reason, status: r.status });
      fail(res, r.status, `unauthorized: ${r.reason}`);
      return null;
    }
    return r.pubkey;
  }

  // ------------------------------------------------------------------ BUD-02 / BUD-06

  private spoolPath(): string {
    return path.join(this.spoolDir, `up-${String(this.now())}-${String(++this.spoolSeq)}.part`);
  }

  private async headUpload(req: IncomingMessage, res: Res): Promise<void> {
    if (!this.cfg.allowUpload) {
      fail(res, 403, 'uploads disabled');
      return;
    }
    const sha = header(req, 'x-sha-256');
    if (sha === undefined || !HEX64.test(sha)) {
      fail(res, 400, 'X-SHA-256 must be 64 lower-case hex chars');
      return;
    }
    const lenRaw = header(req, 'x-content-length');
    if (lenRaw === undefined) {
      fail(res, 411, 'X-Content-Length required');
      return;
    }
    const len = Number(lenRaw);
    if (!Number.isSafeInteger(len) || len < 0) {
      fail(res, 400, 'X-Content-Length must be a non-negative integer');
      return;
    }
    if (len > this.limits.maxUploadBytes) {
      fail(res, 413, `blob too large; max ${this.limits.maxUploadBytes} bytes`);
      return;
    }
    if (mimeOf(header(req, 'x-content-type'), this.cfg.allowedMimeTypes) === null) {
      fail(res, 415, 'blob type not accepted');
      return;
    }
    if (this.cfg.authHeadUpload) {
      const pk = await this.authorize(req, res, 'upload', sha as Sha256Hex);
      if (pk === null) return;
    }
    if (!this.seeder.hasBlob(sha) && this.seeder.diskCap.freeBytes < len) {
      fail(res, 507, 'insufficient storage');
      return;
    }
    cors(res);
    res.statusCode = 200;
    res.end();
  }

  private async putUpload(req: IncomingMessage, res: Res): Promise<void> {
    if (!this.cfg.allowUpload) {
      fail(res, 403, 'uploads disabled');
      return;
    }
    const lenRaw = header(req, 'content-length');
    if (lenRaw === undefined) {
      fail(res, 411, 'Content-Length required');
      return;
    }
    const declared = Number(lenRaw);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      fail(res, 400, 'Content-Length must be a non-negative integer');
      return;
    }
    if (declared > this.limits.maxUploadBytes) {
      fail(res, 413, `blob too large; max ${this.limits.maxUploadBytes} bytes`);
      return;
    }
    const claimed = header(req, 'x-sha-256');
    if (claimed !== undefined && !HEX64.test(claimed)) {
      fail(res, 400, 'X-SHA-256 must be 64 lower-case hex chars');
      return;
    }
    const mime = mimeOf(header(req, 'content-type'), this.cfg.allowedMimeTypes);
    if (mime === null) {
      fail(res, 415, 'blob type not accepted');
      return;
    }
    // With a claimed hash the token is checked BEFORE any body byte is accepted.
    let pubkey: NostrPubkey | null = null;
    if (claimed !== undefined) {
      pubkey = await this.authorize(req, res, 'upload', claimed as Sha256Hex);
      if (pubkey === null) return;
      if (this.seeder.diskCap.freeBytes < declared && !this.seeder.hasBlob(claimed)) {
        fail(res, 507, 'insufficient storage');
        return;
      }
    }

    const tmp = this.spoolPath();
    const spooled = await spoolToFile(req, tmp, {
      maxBytes: this.limits.maxUploadBytes,
      idleMs: this.limits.bodyIdleTimeoutMs,
    });
    if (!spooled.ok) {
      const { status, reason } = bodyFailureStatus(spooled.reason);
      if (spooled.reason !== 'aborted') fail(res, status, reason);
      else res.destroy();
      return;
    }
    try {
      if (spooled.size !== declared) {
        fail(res, 400, 'body length does not match Content-Length');
        return;
      }
      if (claimed !== undefined && claimed !== spooled.sha256) {
        fail(res, 409, 'X-SHA-256 does not match body');
        return;
      }
      const sha = spooled.sha256 as Sha256Hex;
      pubkey ??= await this.authorize(req, res, 'upload', sha);
      if (pubkey === null) return;

      // Dedupe / cap are decided HERE, before `putFile`: the seeder's `putStream` opens
      // its second read stream eagerly and never consumes it on those two early returns,
      // so the spool file must outlive an open it would otherwise race (docs/lanes/L3.md).
      const existing = this.seeder.blob(sha);
      if (existing) {
        this.owners.add(pubkey, sha);
        this.log.info('blob uploaded', {
          sha256: sha,
          size: existing.size,
          pubkey,
          deduplicated: true,
        });
        json(res, 200, this.descriptor(existing));
        return;
      }
      if (this.seeder.diskCap.freeBytes < spooled.size) {
        fail(res, 507, 'insufficient storage');
        return;
      }
      const r = await this.seeder.putFile(tmp, { mime });
      if (!r.ok) {
        switch (r.error.code) {
          case 'disk-cap':
            fail(res, 507, 'insufficient storage');
            return;
          case 'size-mismatch':
          case 'not-a-file':
            fail(res, 400, 'upload could not be stored');
            return;
          case 'write-failed':
            fail(res, 500, 'storage error');
            return;
        }
      }
      if (r.entry.sha256 !== sha) {
        // Cannot happen (same bytes, same hash function) — refuse rather than mis-attribute.
        this.log.error('spool hash and seeder hash disagree', {
          sha256: sha,
          entry: r.entry.sha256,
        });
        fail(res, 500, 'storage error');
        return;
      }
      this.owners.add(pubkey, sha);
      this.log.info('blob uploaded', {
        sha256: sha,
        size: r.entry.size,
        pubkey,
        deduplicated: r.deduplicated,
      });
      json(res, r.deduplicated ? 200 : 201, this.descriptor(r.entry));
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ BUD-04

  private async putMirror(req: IncomingMessage, res: Res): Promise<void> {
    if (!this.cfg.allowMirror || this.mirrorFetch === null) {
      fail(res, 403, 'mirroring disabled');
      return;
    }
    const body = await readTextBody(req, {
      maxBytes: this.limits.maxJsonBodyBytes,
      idleMs: this.limits.bodyIdleTimeoutMs,
    });
    if (!body.ok) {
      const { status, reason } = bodyFailureStatus(body.reason);
      fail(res, status, reason);
      return;
    }
    let target: URL;
    try {
      const parsed: unknown = JSON.parse(body.text);
      const u =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as Record<string, unknown>)['url']
          : undefined;
      if (typeof u !== 'string') throw new Error('no url');
      target = new URL(u);
    } catch {
      fail(res, 400, 'body must be {"url": "<http(s) url>"}');
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      fail(res, 400, 'url must be http(s)');
      return;
    }
    if (!this.cfg.mirrorAllowedHosts.includes(target.host)) {
      fail(res, 403, 'origin host not allowed');
      return;
    }
    const sha = sha256FromUrlPath(target.pathname);
    if (sha === null) {
      fail(res, 400, 'url does not contain a sha256');
      return;
    }
    const pubkey = await this.authorize(req, res, 'mirror', sha);
    if (pubkey === null) return;

    const existing = this.seeder.blob(sha);
    if (existing) {
      this.owners.add(pubkey, sha);
      json(res, 200, this.descriptor(existing));
      return;
    }

    let origin: Awaited<ReturnType<MirrorFetch>>;
    try {
      origin = await this.mirrorFetch(target);
    } catch {
      origin = null;
    }
    if (origin === null || origin.status < 200 || origin.status >= 300) {
      fail(res, 502, 'could not fetch blob from origin');
      return;
    }
    if (origin.contentLength !== null && origin.contentLength > this.limits.maxUploadBytes) {
      fail(res, 413, `blob too large; max ${this.limits.maxUploadBytes} bytes`);
      return;
    }
    const mime = mimeOf(origin.contentType ?? undefined, this.cfg.allowedMimeTypes);
    if (mime === null) {
      fail(res, 415, 'blob type not accepted');
      return;
    }
    const tmp = this.spoolPath();
    const spooled = await spoolIterableToFile(origin.body, tmp, this.limits.maxUploadBytes);
    if (!spooled.ok) {
      const { status, reason } = bodyFailureStatus(spooled.reason);
      fail(res, spooled.reason === 'too-large' ? 413 : status === 500 ? 502 : status, reason);
      return;
    }
    try {
      if (spooled.sha256 !== sha) {
        fail(res, 409, 'mirrored blob hash does not match url');
        return;
      }
      if (this.seeder.diskCap.freeBytes < spooled.size) {
        fail(res, 507, 'insufficient storage');
        return;
      }
      const r = await this.seeder.putFile(tmp, { mime });
      if (!r.ok) {
        fail(res, r.error.code === 'disk-cap' ? 507 : 500, 'storage error');
        return;
      }
      this.owners.add(pubkey, sha);
      this.log.info('blob mirrored', {
        sha256: sha,
        size: r.entry.size,
        pubkey,
        host: target.host,
      });
      json(res, r.deduplicated ? 200 : 201, this.descriptor(r.entry));
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ BUD-09

  private async putReport(req: IncomingMessage, res: Res): Promise<void> {
    if (!this.cfg.allowReport) {
      fail(res, 403, 'reports disabled');
      return;
    }
    const body = await readTextBody(req, {
      maxBytes: this.limits.maxJsonBodyBytes,
      idleMs: this.limits.bodyIdleTimeoutMs,
    });
    if (!body.ok) {
      const { status, reason } = bodyFailureStatus(body.reason);
      fail(res, status, reason);
      return;
    }
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(body.text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      event = parsed as Record<string, unknown>;
    } catch {
      fail(res, 400, 'body must be a kind 1984 event');
      return;
    }
    const tags = event['tags'];
    const hashes: Sha256Hex[] = [];
    if (Array.isArray(tags))
      for (const t of tags as unknown[])
        if (Array.isArray(t) && t[0] === 'x' && typeof t[1] === 'string' && HEX64.test(t[1]))
          hashes.push(t[1] as Sha256Hex);
    if (
      event['kind'] !== 1984 ||
      typeof event['pubkey'] !== 'string' ||
      !HEX64.test(event['pubkey']) ||
      typeof event['sig'] !== 'string' ||
      typeof event['id'] !== 'string' ||
      typeof event['content'] !== 'string' ||
      hashes.length === 0
    ) {
      fail(res, 400, 'body must be a signed kind 1984 event with at least one x tag');
      return;
    }
    // The signed report IS the credential: hand it to the auth boundary as a `report`
    // verb (`Nostr <base64 event>` is the only header shape the interface takes).
    const synthetic = `Nostr ${Buffer.from(body.text, 'utf8').toString('base64')}`;
    const reporter = await this.authorize(req, res, 'report', hashes[0] ?? null, synthetic);
    if (reporter === null) return;

    const stored: StoredReport = {
      at: Math.floor(this.now() / 1000) as StoredReport['at'],
      reporter,
      hashes,
      event,
      signatureVerified: false,
    };
    if (!this.reports.append(stored)) {
      fail(res, 429, 'report store full');
      return;
    }
    this.log.info('blob reported', { reporter, hashes: hashes.length });
    cors(res);
    res.statusCode = 200;
    res.end();
  }
}
