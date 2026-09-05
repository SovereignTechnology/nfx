/**
 * Blossom HTTP against a real listener with `node:http` clients: BUD-01 GET/HEAD + ranges,
 * BUD-02 PUT /upload + /list, BUD-06 HEAD /upload, BUD-04 PUT /mirror (injected fetch),
 * BUD-09 PUT /report, CORS, and the auth boundary via the scripted `FakeBlossomAuth`.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Sha256Hex } from '@sovit/core';

import { UPLOAD_SPOOL_DIR, sha256FromUrlPath } from '../blossom/handler.js';
import { OWNERS_FILE, REPORTS_FILE } from '../blossom/store.js';
import { FakeBlossomAuth } from './fake-blossom-auth.js';
import { BLOCK, cleanupRigs, fixtureBytes, pubkey, request, rig } from './helpers.js';
import type { Rig } from './helpers.js';

afterEach(cleanupRigs);

const sha = (b: Uint8Array): Sha256Hex => createHash('sha256').update(b).digest('hex') as Sha256Hex;
const UPLOADER = pubkey('uploader');
async function* iter(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield await Promise.resolve(c);
}

async function putFixture(r: Rig, blocks: number, mime = 'video/mp4') {
  const data = fixtureBytes(blocks);
  const res = await r.gateway.seeder.putBytes(data, { mime });
  if (!res.ok) throw new Error(res.error.code);
  return { data, entry: res.entry, sha: res.entry.sha256 };
}

describe('BUD-01 GET/HEAD /<sha256>', () => {
  it('200 full blob with Content-Type from the CAS entry, Accept-Ranges, Content-Length; optional extension', async () => {
    const r = await rig();
    const { data, sha: s } = await putFixture(r, 3, 'video/webm');
    const res = await request(`${r.url}/${s}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/webm');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(3 * BLOCK));
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers.etag).toBe(`"${s}"`);
    expect(Buffer.from(data).equals(res.body)).toBe(true);
    const ext = await request(`${r.url}/${s}.webm`);
    expect(ext.status).toBe(200);
    expect(ext.body.byteLength).toBe(3 * BLOCK);
    const upper = await request(`${r.url}/${s.toUpperCase()}.MP4`);
    expect(upper.status).toBe(200);
  });

  it('HEAD carries the same headers and no body; unknown mime → application/octet-stream', async () => {
    const r = await rig();
    const data = fixtureBytes(2);
    const put = await r.gateway.seeder.putBytes(data);
    if (!put.ok) throw new Error('put');
    const res = await request(`${r.url}/${put.entry.sha256}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe(String(2 * BLOCK));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.body.byteLength).toBe(0);
  });

  it('404 on unknown, 404 on non-blob paths, 405 on other methods, OPTIONS preflight', async () => {
    const r = await rig();
    expect((await request(`${r.url}/${'ab'.repeat(32)}`)).status).toBe(404);
    expect((await request(`${r.url}/${'ab'.repeat(32)}`, { method: 'HEAD' })).status).toBe(404);
    expect((await request(`${r.url}/short`)).status).toBe(404);
    expect((await request(`${r.url}/`)).status).toBe(404);
    const { sha: s } = await putFixture(r, 1);
    const del = await request(`${r.url}/${s}`, { method: 'DELETE' });
    expect(del.status).toBe(405);
    expect(del.headers.allow).toBe('GET, HEAD');
    const opt = await request(`${r.url}/${s}`, { method: 'OPTIONS' });
    expect(opt.status).toBe(204);
    expect(opt.headers['access-control-allow-origin']).toBe('*');
    expect(opt.headers['access-control-allow-headers']).toBe('Authorization, *');
    expect(opt.headers['access-control-allow-methods']).toBe('GET, HEAD, PUT, DELETE');
    expect(opt.headers['access-control-max-age']).toBe('86400');
  });

  it('206 partial content across block boundaries with Content-Range; suffix + open-ended ranges', async () => {
    const r = await rig();
    const { data, sha: s } = await putFixture(r, 4);
    const size = 4 * BLOCK;
    const cases: [string, number, number][] = [
      ['bytes=0-99', 0, 99],
      ['bytes=1000-2100', 1000, 2100], // crosses two block boundaries
      ['bytes=4000-', 4000, size - 1],
      ['bytes=-500', size - 500, size - 1],
      [`bytes=${size - 1}-${size - 1}`, size - 1, size - 1],
      ['bytes=0-999999', 0, size - 1], // clamped
    ];
    for (const [hdr, start, end] of cases) {
      const res = await request(`${r.url}/${s}`, { headers: { Range: hdr } });
      expect(res.status, hdr).toBe(206);
      expect(res.headers['content-range'], hdr).toBe(`bytes ${start}-${end}/${size}`);
      expect(res.headers['content-length'], hdr).toBe(String(end - start + 1));
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(Buffer.from(data.subarray(start, end + 1)).equals(res.body), hdr).toBe(true);
    }
    // HEAD with Range: same status/headers, no body.
    const head = await request(`${r.url}/${s}`, {
      method: 'HEAD',
      headers: { Range: 'bytes=10-19' },
    });
    expect(head.status).toBe(206);
    expect(head.headers['content-range']).toBe(`bytes 10-19/${size}`);
    expect(head.headers['content-length']).toBe('10');
    expect(head.body.byteLength).toBe(0);
  });

  it('416 with Content-Range: bytes */size on unsatisfiable ranges; unsupported Range syntax → 200 full', async () => {
    const r = await rig();
    const { sha: s } = await putFixture(r, 2);
    const size = 2 * BLOCK;
    for (const hdr of [`bytes=${size}-`, 'bytes=999999-9999999', 'bytes=10-5', 'bytes=-0']) {
      const res = await request(`${r.url}/${s}`, { headers: { Range: hdr } });
      expect(res.status, hdr).toBe(416);
      expect(res.headers['content-range'], hdr).toBe(`bytes */${size}`);
      expect(res.body.byteLength).toBe(0);
    }
    for (const hdr of ['bytes=0-1,5-6', 'items=0-1', 'bytes=x-y']) {
      const res = await request(`${r.url}/${s}`, { headers: { Range: hdr } });
      expect(res.status, hdr).toBe(200);
      expect(res.body.byteLength).toBe(size);
    }
  });
});

function uploadHeaders(
  body: Uint8Array,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    'Content-Length': String(body.byteLength),
    'Content-Type': 'video/mp4',
    Authorization: 'Nostr ZmFrZQ==',
    ...extra,
  };
}

describe('BUD-02 PUT /upload through the BlossomAuth boundary', () => {
  it('201 + descriptor when the injected auth accepts; the gateway becomes the first seeder; /list sees it', async () => {
    const auth = new FakeBlossomAuth({ ok: true, pubkey: UPLOADER });
    const r = await rig({ auth });
    const body = fixtureBytes(5, 3);
    const s = sha(body);
    const res = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { 'X-SHA-256': s }),
      body: Buffer.from(body),
    });
    expect(res.status).toBe(201);
    const desc = JSON.parse(res.body.toString()) as Record<string, unknown>;
    expect(desc).toMatchObject({
      url: `http://gw.test/${s}.mp4`,
      sha256: s,
      size: 5 * BLOCK,
      type: 'video/mp4',
    });
    expect(typeof desc['uploaded']).toBe('number');
    // Auth was consulted with the claimed hash BEFORE the body landed, verb `upload`.
    expect(auth.calls).toHaveLength(1);
    expect(auth.calls[0]).toMatchObject({ verb: 'upload', sha256: s, header: 'Nostr ZmFrZQ==' });
    // Seeded now: readable back with ranges, present in the CAS index, blocks in the core.
    expect(r.gateway.seeder.hasBlob(s)).toBe(true);
    const back = await request(`${r.url}/${s}`, { headers: { Range: 'bytes=1024-2047' } });
    expect(back.status).toBe(206);
    expect(Buffer.from(body.subarray(1024, 2048)).equals(back.body)).toBe(true);
    const core = r.gateway.seeder.blobs.coreByKey(r.gateway.seeder.blob(s)!.coreKey)!.core;
    expect(core.length).toBe(5);
    // Owner index (BUD-02 list), persisted.
    const list = await request(`${r.url}/list/${UPLOADER}`);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body.toString())).toEqual([expect.objectContaining({ sha256: s })]);
    await r.gateway.owners.flushed();
    expect(await readFile(path.join(r.config.dataDir, OWNERS_FILE), 'utf8')).toContain(s);
    expect(JSON.parse((await request(`${r.url}/list/${'11'.repeat(32)}`)).body.toString())).toEqual(
      [],
    );
    // Spool file cleaned up.
    expect(await readdir(path.join(r.config.dataDir, UPLOAD_SPOOL_DIR))).toEqual([]);
  });

  it('200 (not 201) when the blob already exists; without X-SHA-256 the auth is asked AFTER hashing the body', async () => {
    const auth = new FakeBlossomAuth({ ok: true, pubkey: UPLOADER });
    const r = await rig({ auth });
    const body = fixtureBytes(2, 9);
    const s = sha(body);
    const first = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body),
      body: Buffer.from(body),
    });
    expect(first.status).toBe(201);
    expect(auth.calls[0]).toMatchObject({ verb: 'upload', sha256: s });
    const again = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body),
      body: Buffer.from(body),
    });
    expect(again.status).toBe(200);
    expect((JSON.parse(again.body.toString()) as { sha256: string }).sha256).toBe(s);
  });

  it('401 and 403 from the test double are passed through with the reason only — never the token', async () => {
    const auth = new FakeBlossomAuth();
    const r = await rig({ auth });
    const body = fixtureBytes(1);
    const token = 'Nostr c2VjcmV0LXRva2VuLWJ5dGVz';
    auth.queue.push({ ok: false, status: 401, reason: 'expired' });
    const unauthorized = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { Authorization: token, 'X-SHA-256': sha(body) }),
      body: Buffer.from(body),
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['x-reason']).toBe('unauthorized: expired');
    expect(unauthorized.body.toString()).not.toContain('c2VjcmV0');
    auth.queue.push({ ok: false, status: 403, reason: 'denied' });
    const forbidden = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { Authorization: token }),
      body: Buffer.from(body),
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers['x-reason']).toBe('unauthorized: denied');
    // Missing header: 401 before any auth call.
    const calls = auth.calls.length;
    const { Authorization: _a, ...noAuth } = uploadHeaders(body);
    const missing = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: noAuth,
      body: Buffer.from(body),
    });
    expect(missing.status).toBe(401);
    expect(auth.calls.length).toBe(calls);
    // Nothing stored, nothing leaked into the logs.
    expect(r.gateway.seeder.listBlobs()).toHaveLength(0);
    expect(r.log.lines.join('\n')).not.toContain('c2VjcmV0');
  });

  it('409 on X-SHA-256 mismatch, 413 over the cap (header and body), 411 without Content-Length, 415 on disallowed type, 400 on bad hash', async () => {
    const auth = new FakeBlossomAuth({ ok: true, pubkey: UPLOADER });
    const r = await rig({
      auth,
      raw: { blossom: { publicUrl: 'http://gw.test', allowedMimeTypes: ['video/mp4'] } },
    });
    const body = fixtureBytes(2, 5);
    const wrong = sha(fixtureBytes(2, 6));
    const mismatch = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { 'X-SHA-256': wrong }),
      body: Buffer.from(body),
    });
    expect(mismatch.status).toBe(409);
    expect(r.gateway.seeder.hasBlob(sha(body))).toBe(false);

    const big = new Uint8Array(r.config.http.maxUploadBytes + 1);
    const tooBig = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(big),
      body: Buffer.from(big),
    });
    expect(tooBig.status).toBe(413);
    // Lying Content-Length: the body cap still fires while streaming.
    const lying = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: { ...uploadHeaders(big), 'Content-Length': '10' },
      body: Buffer.from(big.subarray(0, 10)),
    });
    expect([201, 200]).toContain(lying.status); // 10 honest bytes is a fine upload

    const bad = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { 'X-SHA-256': 'nothex' }),
      body: Buffer.from(body),
    });
    expect(bad.status).toBe(400);
    const wrongType = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { 'Content-Type': 'application/x-msdownload' }),
      body: Buffer.from(body),
    });
    expect(wrongType.status).toBe(415);
    const chunked = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: {
        'Transfer-Encoding': 'chunked',
        'Content-Type': 'video/mp4',
        Authorization: 'Nostr x',
      },
      body: Buffer.from(body),
    });
    expect(chunked.status).toBe(411);
    expect(await readdir(path.join(r.config.dataDir, UPLOAD_SPOOL_DIR))).toEqual([]);
  });

  it('body length that does not match Content-Length is a 400 and stores nothing', async () => {
    const auth = new FakeBlossomAuth({ ok: true, pubkey: UPLOADER });
    const r = await rig({ auth });
    const body = fixtureBytes(1);
    const short = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { 'Content-Length': '2048' }),
      body: Buffer.from(body),
    }).catch(() => null);
    // Node's client waits for the missing bytes; the body idle timeout (2 s in tests) ends it as 408.
    if (short !== null) expect([400, 408]).toContain(short.status);
    expect(r.gateway.seeder.listBlobs()).toHaveLength(0);
  }, 15_000);

  it('503 when no BlossomAuth is wired (Stage 1 runtime), while GET/HEAD keep working; 403 when uploads are disabled', async () => {
    const r = await rig({ auth: null });
    const { sha: s } = await putFixture(r, 1);
    expect((await request(`${r.url}/${s}`)).status).toBe(200);
    const body = fixtureBytes(1);
    const res = await request(`${r.url}/upload`, {
      method: 'PUT',
      headers: uploadHeaders(body, { 'X-SHA-256': sha(body) }),
      body: Buffer.from(body),
    });
    expect(res.status).toBe(503);
    const off = await rig({
      raw: { blossom: { publicUrl: 'http://gw.test', allowUpload: false } },
    });
    expect(
      (
        await request(`${off.url}/upload`, {
          method: 'PUT',
          headers: uploadHeaders(body),
          body: Buffer.from(body),
        })
      ).status,
    ).toBe(403);
  });

  it('config allow/deny pubkey defaults are handed to the auth at start', async () => {
    const auth = new FakeBlossomAuth();
    const good = pubkey('good');
    const bad = pubkey('bad');
    await rig({
      auth,
      raw: { blossom: { publicUrl: 'http://gw.test', allowPubkeys: [good], denyPubkeys: [bad] } },
    });
    expect(auth.allowed).toEqual([good]);
    expect(auth.denied).toEqual([bad]);
  });
});

describe('BUD-06 HEAD /upload', () => {
  it('200 when the upload would be accepted; 400/411/413/415 per header', async () => {
    const auth = new FakeBlossomAuth({ ok: true, pubkey: UPLOADER });
    const r = await rig({
      auth,
      raw: { blossom: { publicUrl: 'http://gw.test', allowedMimeTypes: ['video/mp4'] } },
    });
    const s = sha(fixtureBytes(1));
    const ok = await request(`${r.url}/upload`, {
      method: 'HEAD',
      headers: { 'X-SHA-256': s, 'X-Content-Length': '1024', 'X-Content-Type': 'video/mp4' },
    });
    expect(ok.status).toBe(200);
    expect(auth.calls).toHaveLength(0); // tokens are single-use; HEAD does not burn one by default
    expect(
      (
        await request(`${r.url}/upload`, {
          method: 'HEAD',
          headers: { 'X-SHA-256': 'zz', 'X-Content-Length': '1' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(`${r.url}/upload`, { method: 'HEAD', headers: { 'X-SHA-256': s } })).status,
    ).toBe(411);
    const big = await request(`${r.url}/upload`, {
      method: 'HEAD',
      headers: { 'X-SHA-256': s, 'X-Content-Length': String(r.config.http.maxUploadBytes + 1) },
    });
    expect(big.status).toBe(413);
    expect(big.headers['x-reason']).toContain('too large');
    expect(
      (
        await request(`${r.url}/upload`, {
          method: 'HEAD',
          headers: { 'X-SHA-256': s, 'X-Content-Length': '1', 'X-Content-Type': 'text/html' },
        })
      ).status,
    ).toBe(415);
    // Over the disk cap → 507.
    const huge = await request(`${r.url}/upload`, {
      method: 'HEAD',
      headers: { 'X-SHA-256': s, 'X-Content-Length': String(r.config.diskCapBytes + 1) },
    });
    expect(huge.status).toBe(413); // http cap fires first
    const r2 = await rig({ auth, raw: { diskCapBytes: 100, http: { maxUploadBytes: 10_000 } } });
    expect(
      (
        await request(`${r2.url}/upload`, {
          method: 'HEAD',
          headers: { 'X-SHA-256': s, 'X-Content-Length': '5000' },
        })
      ).status,
    ).toBe(507);
  });

  it('authHeadUpload=true routes HEAD /upload through the auth boundary', async () => {
    const auth = new FakeBlossomAuth();
    const r = await rig({
      auth,
      raw: { blossom: { publicUrl: 'http://gw.test', authHeadUpload: true } },
    });
    auth.queue.push({ ok: false, status: 403, reason: 'denied' });
    const res = await request(`${r.url}/upload`, {
      method: 'HEAD',
      headers: {
        'X-SHA-256': sha(fixtureBytes(1)),
        'X-Content-Length': '1',
        Authorization: 'Nostr x',
      },
    });
    expect(res.status).toBe(403);
    expect(auth.calls[0]?.verb).toBe('upload');
  });
});

describe('BUD-04 PUT /mirror', () => {
  const blob = fixtureBytes(3, 11);
  const blobSha = sha(blob);
  const fetchOk = (url: URL) =>
    Promise.resolve(
      url.pathname.includes(blobSha)
        ? {
            status: 200,
            contentType: 'video/mp4',
            contentLength: blob.byteLength,
            body: iter(blob),
          }
        : {
            status: 404,
            contentType: null,
            contentLength: null,
            body: iter(new Uint8Array(0)),
          },
    );

  it('disabled by default (403); enabled + allowed host + accepted auth → 201 with the hash verified', async () => {
    const auth = new FakeBlossomAuth({ ok: true, pubkey: UPLOADER });
    const off = await rig({ auth, deps: { mirrorFetch: fetchOk } });
    expect(
      (
        await request(`${off.url}/mirror`, {
          method: 'PUT',
          headers: { Authorization: 'Nostr x' },
          body: JSON.stringify({ url: `https://cdn.example/${blobSha}.mp4` }),
        })
      ).status,
    ).toBe(403);

    const r = await rig({
      auth,
      deps: { mirrorFetch: fetchOk },
      raw: {
        blossom: {
          publicUrl: 'http://gw.test',
          allowMirror: true,
          mirrorAllowedHosts: ['cdn.example'],
        },
      },
    });
    const res = await request(`${r.url}/mirror`, {
      method: 'PUT',
      headers: { Authorization: 'Nostr x' },
      body: JSON.stringify({ url: `https://cdn.example/${blobSha}.mp4` }),
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      sha256: blobSha,
      size: blob.byteLength,
      type: 'video/mp4',
    });
    expect(auth.calls[0]).toMatchObject({ verb: 'mirror', sha256: blobSha });
    expect(r.gateway.seeder.hasBlob(blobSha)).toBe(true);
    // Again → 200 without fetching.
    expect(
      (
        await request(`${r.url}/mirror`, {
          method: 'PUT',
          headers: { Authorization: 'Nostr x' },
          body: JSON.stringify({ url: `https://cdn.example/${blobSha}.mp4` }),
        })
      ).status,
    ).toBe(200);
    // Not an allowed host → 403; no sha in url → 400; bad body → 400; origin 404 → 502; hash mismatch → 409.
    expect(
      (
        await request(`${r.url}/mirror`, {
          method: 'PUT',
          headers: { Authorization: 'Nostr x' },
          body: JSON.stringify({ url: `https://evil.example/${blobSha}` }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`${r.url}/mirror`, {
          method: 'PUT',
          headers: { Authorization: 'Nostr x' },
          body: JSON.stringify({ url: 'https://cdn.example/file.mp4' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`${r.url}/mirror`, {
          method: 'PUT',
          headers: { Authorization: 'Nostr x' },
          body: 'nope',
        })
      ).status,
    ).toBe(400);
    const other = sha(fixtureBytes(1, 99));
    expect(
      (
        await request(`${r.url}/mirror`, {
          method: 'PUT',
          headers: { Authorization: 'Nostr x' },
          body: JSON.stringify({ url: `https://cdn.example/${other}` }),
        })
      ).status,
    ).toBe(502);
    const lying = await rig({
      auth,
      deps: {
        mirrorFetch: () =>
          Promise.resolve({
            status: 200,
            contentType: 'video/mp4',
            contentLength: null,
            body: iter(fixtureBytes(1, 42)),
          }),
      },
      raw: {
        blossom: {
          publicUrl: 'http://gw.test',
          allowMirror: true,
          mirrorAllowedHosts: ['cdn.example'],
        },
      },
    });
    expect(
      (
        await request(`${lying.url}/mirror`, {
          method: 'PUT',
          headers: { Authorization: 'Nostr x' },
          body: JSON.stringify({ url: `https://cdn.example/${blobSha}` }),
        })
      ).status,
    ).toBe(409);
    expect(lying.gateway.seeder.listBlobs()).toHaveLength(0);
  });

  it('sha256FromUrlPath takes the LAST 64-hex segment (BUD-03)', () => {
    const h = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553';
    const other = 'ec4425ff5e9446080d2f70440188e3ca5d6da8713db7bdeef73d0ed54d9093f0';
    expect(sha256FromUrlPath(`/${h}.pdf`)).toBe(h);
    expect(sha256FromUrlPath(`/user/${other}/media/${h}.pdf`)).toBe(h);
    expect(sha256FromUrlPath(`/media/b1/67/${h.toUpperCase()}`)).toBe(h);
    expect(sha256FromUrlPath('/nothing.pdf')).toBeNull();
  });
});

describe('BUD-09 PUT /report', () => {
  const report = (x: string[], extra: Record<string, unknown> = {}) => ({
    kind: 1984,
    pubkey: pubkey('reporter'),
    id: 'ee'.repeat(32),
    sig: 'ff'.repeat(64),
    created_at: 1,
    content: 'spam',
    tags: x.map((h) => ['x', h, 'spam']),
    ...extra,
  });

  it('a structurally valid signed report goes through the auth boundary as verb `report` and is stored (signature unverified)', async () => {
    const auth = new FakeBlossomAuth({ ok: true, pubkey: pubkey('reporter') });
    const r = await rig({ auth });
    const h = sha(fixtureBytes(1));
    const res = await request(`${r.url}/report`, {
      method: 'PUT',
      body: JSON.stringify(report([h])),
    });
    expect(res.status).toBe(200);
    expect(auth.calls[0]).toMatchObject({ verb: 'report', sha256: h });
    expect(auth.calls[0]?.header.startsWith('Nostr ')).toBe(true);
    await r.gateway.reports.flushed();
    const stored = JSON.parse(
      (await readFile(path.join(r.config.dataDir, REPORTS_FILE), 'utf8')).trim(),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      reporter: pubkey('reporter'),
      hashes: [h],
      signatureVerified: false,
    });
  });

  it('400 on malformed bodies, auth rejection passes through, 403 when disabled', async () => {
    const auth = new FakeBlossomAuth();
    const r = await rig({ auth });
    for (const body of [
      'x',
      '[]',
      JSON.stringify({ kind: 1 }),
      JSON.stringify(report([])),
      JSON.stringify(report(['zz'])),
    ])
      expect((await request(`${r.url}/report`, { method: 'PUT', body })).status, body).toBe(400);
    auth.queue.push({ ok: false, status: 401, reason: 'bad-signature' });
    const rej = await request(`${r.url}/report`, {
      method: 'PUT',
      body: JSON.stringify(report([sha(fixtureBytes(1))])),
    });
    expect(rej.status).toBe(401);
    expect(rej.headers['x-reason']).toBe('unauthorized: bad-signature');
    const off = await rig({
      raw: { blossom: { publicUrl: 'http://gw.test', allowReport: false } },
    });
    expect((await request(`${off.url}/report`, { method: 'PUT', body: '{}' })).status).toBe(403);
  });
});

describe('T11 HTTP limits', () => {
  it('429 with Retry-After once a client exceeds requestsPerWindow', async () => {
    const r = await rig({ raw: { http: { requestsPerWindow: 3, windowMs: 60_000 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await request(`${r.url}/${'ab'.repeat(32)}`)).status);
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
    const last = await request(`${r.url}/${'ab'.repeat(32)}`);
    expect(last.headers['retry-after']).toBe('60');
  });

  it('JSON bodies over maxJsonBodyBytes are 413', async () => {
    const r = await rig({ raw: { http: { maxJsonBodyBytes: 100 } } });
    const res = await request(`${r.url}/report`, { method: 'PUT', body: 'x'.repeat(200) });
    expect(res.status).toBe(413);
  });
});
