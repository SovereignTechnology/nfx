/**
 * BlossomAuth — kind 24242 authorization for BUD-02 (upload), BUD-04 (mirror), BUD-09
 * (report) and the BUD-01 `get`/`list` verbs, with replay protection, expiry and pubkey
 * allow/deny (execution plan §3 Part A step 5; `packages/gateway/src/auth/index.ts`).
 *
 * Rules exercised (BUD-01 "Authorization events" / BUD-11 draft — NOTE: the vendored
 * `docs/vendor/BUD-01.md` is the newer revision that moved the event definition out to
 * BUD-11, which is not vendored; the rules below are the ones every Blossom server
 * implements and the contract's `reason` enum mirrors):
 *   - header is `Nostr <base64(JSON event)>`
 *   - `kind` MUST be 24242
 *   - `created_at` MUST be in the past
 *   - an `expiration` tag MUST be present and in the future
 *   - a `t` tag MUST name the verb (`upload` | `delete` | `list` | `get`); BUD-04 mirror
 *     reuses the original `upload` token
 *   - `x` tags carry the sha256 of the blob(s) the token authorises; for a verb that targets
 *     a blob the requested hash MUST be among them
 *   - the signature MUST verify for `pubkey`
 * plus the contract's own: each event is accepted at most once (`replayed`), and denied
 * pubkeys get 403 `denied`.
 *
 * Signed test events are produced ONLY via nostr-tools `finalizeEvent` / `generateSecretKey`
 * (the sole permitted way to build fixtures here — no hand-rolled crypto). nostr-tools is a
 * dependency of @sovit/core and resolves from packages/gateway through the hoisted workspace
 * `node_modules` (verified at runtime and under `tsc -b`).
 *
 * The whole suite is real and skipped only until Stage 2 wires `getBlossomAuth()`.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { beforeEach, describe, expect, it } from 'vitest';

import type { NostrPubkey, Sha256Hex } from '@sovit/core';
import type { BlossomAuth, BlossomAuthRequest, BlossomAuthResult, BlossomVerb } from '../index.js';
import { SKIP_REASON, getBlossomAuth } from './provider.mjs';

const KIND_BLOSSOM_AUTH = 24242;
const NOW = 1_757_000_000; // unix seconds, fixed
const BLOB = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553' as Sha256Hex;
const OTHER_BLOB = 'c2785292b99fd6dee844f5351b92914216ed523e7d7819e64bca5fd359f5f664' as Sha256Hex;

interface TemplateOpts {
  readonly kind?: number;
  readonly verb?: string | null; // null = omit the `t` tag
  readonly x?: readonly string[];
  readonly expiration?: number | null; // null = omit
  readonly createdAt?: number;
  readonly content?: string;
  readonly extraTags?: readonly string[][];
}

function template(o: TemplateOpts = {}): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const tags: string[][] = [];
  if (o.verb !== null) tags.push(['t', o.verb ?? 'upload']);
  for (const x of o.x ?? [BLOB]) tags.push(['x', x]);
  if (o.expiration !== null) tags.push(['expiration', String(o.expiration ?? NOW + 600)]);
  tags.push(...(o.extraTags ?? []));
  return {
    kind: o.kind ?? KIND_BLOSSOM_AUTH,
    created_at: o.createdAt ?? NOW - 5,
    tags,
    content: o.content ?? 'Upload a fixture blob',
  };
}

function toHeader(event: object): string {
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}

function signedHeader(sk: Uint8Array, o: TemplateOpts = {}): string {
  return toHeader(finalizeEvent(template(o), sk));
}

function request(
  header: string,
  verb: BlossomVerb = 'upload',
  sha256: Sha256Hex | null = BLOB, // null = request carries no hash
  now = NOW,
): BlossomAuthRequest {
  return sha256 === null ? { verb, header, now } : { verb, header, sha256, now };
}

const rejected = (r: BlossomAuthResult): r is Extract<BlossomAuthResult, { ok: false }> => !r.ok;

describe('BlossomAuth fixtures self-check (always on)', () => {
  it('nostr-tools produces a verifiable kind 24242 event from the test template', () => {
    const sk = generateSecretKey();
    const ev = finalizeEvent(template(), sk);
    expect(ev.kind).toBe(KIND_BLOSSOM_AUTH);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.tags).toContainEqual(['t', 'upload']);
    expect(ev.tags).toContainEqual(['x', BLOB]);
    expect(ev.tags.find((t) => t[0] === 'expiration')?.[1]).toBe(String(NOW + 600));
    const header = toHeader(ev);
    expect(header.startsWith('Nostr ')).toBe(true);
    // (`ev` also carries nostr-tools' non-JSON `verifiedSymbol`; compare the JSON projection.)
    expect(JSON.parse(Buffer.from(header.slice(6), 'base64').toString('utf8'))).toEqual(
      JSON.parse(JSON.stringify(ev)),
    );
  });
});

describe.skipIf(getBlossomAuth() === undefined)(`BlossomAuth kind 24242 (${SKIP_REASON})`, () => {
  let auth: BlossomAuth;
  let sk: Uint8Array;
  let pubkey: NostrPubkey;

  beforeEach(() => {
    auth = getBlossomAuth()!;
    sk = generateSecretKey();
    pubkey = getPublicKey(sk) as NostrPubkey;
  });

  it('happy path: a fresh, signed, unexpired upload token for the requested hash is accepted and yields the signer pubkey and the event', async () => {
    const header = signedHeader(sk);
    const res = await auth.verify(request(header));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.pubkey).toBe(pubkey);
      expect(res.event.kind).toBe(KIND_BLOSSOM_AUTH);
      expect(res.event.pubkey).toBe(pubkey);
      expect(res.event.tags).toContainEqual(['x', BLOB]);
      expect(verifyEvent({ ...res.event, tags: res.event.tags.map((t) => [...t]) })).toBe(true);
    }
  });

  it('malformed header: missing scheme, bad base64, non-JSON, non-event JSON, missing fields → 401 malformed', async () => {
    const good = finalizeEvent(template(), sk);
    const { sig: _sig, ...noSig } = good;
    const { id: _id, ...noId } = good;
    const headers = [
      '',
      'Nostr',
      'Nostr ',
      'Bearer abc',
      `Basic ${Buffer.from('a:b').toString('base64')}`,
      'Nostr !!!not-base64!!!',
      `Nostr ${Buffer.from('not json').toString('base64')}`,
      `Nostr ${Buffer.from('[]').toString('base64')}`,
      `Nostr ${Buffer.from('null').toString('base64')}`,
      `Nostr ${Buffer.from('{}').toString('base64')}`,
      toHeader(noSig),
      toHeader(noId),
      toHeader({ ...good, tags: 'not-an-array' }),
      toHeader({ ...good, created_at: 'yesterday' }),
      toHeader({ ...good, pubkey: 'nothex' }),
    ];
    for (const header of headers) {
      const res = await auth.verify(request(header));
      expect(rejected(res), `header=${JSON.stringify(header).slice(0, 60)}`).toBe(true);
      if (rejected(res)) {
        expect(res.reason).toBe('malformed');
        expect(res.status).toBe(401);
      }
    }
  });

  it('wrong kind: a correctly signed event of any kind other than 24242 → 401 wrong-kind', async () => {
    for (const kind of [1, 0, 24241, 24243, 1984, 10063]) {
      const res = await auth.verify(request(signedHeader(sk, { kind })));
      expect(rejected(res), `kind=${kind}`).toBe(true);
      if (rejected(res)) {
        expect(res.reason).toBe('wrong-kind');
        expect(res.status).toBe(401);
      }
    }
  });

  it('expired: an `expiration` tag in the past → 401 expired; a missing `expiration` tag is never accepted', async () => {
    const past = await auth.verify(request(signedHeader(sk, { expiration: NOW - 1 })));
    expect(rejected(past)).toBe(true);
    if (rejected(past)) {
      expect(past.reason).toBe('expired');
      expect(past.status).toBe(401);
    }
    const longAgo = await auth.verify(request(signedHeader(sk, { expiration: NOW - 86_400 })));
    expect(longAgo).toMatchObject({ ok: false, reason: 'expired' });

    // `now` is the request's clock, not the wall clock: the same token is fine before it expires…
    const header = signedHeader(sk, { expiration: NOW + 60 });
    expect(await auth.verify(request(header, 'upload', BLOB, NOW))).toMatchObject({ ok: true });
    // …and expired after (a second instance, so this is not confused with a replay).
    const later = getBlossomAuth()!;
    expect(await later.verify(request(header, 'upload', BLOB, NOW + 61))).toMatchObject({
      ok: false,
      reason: 'expired',
    });

    // No expiration tag at all: MUST be rejected (BUD: the tag is required). `expired` is the
    // natural reason; `malformed` is also acceptable for a structurally-missing tag.
    const missing = await auth.verify(request(signedHeader(sk, { expiration: null })));
    expect(rejected(missing)).toBe(true);
    if (rejected(missing)) expect(['expired', 'malformed']).toContain(missing.reason);
  });

  it('created_at in the future is never accepted', async () => {
    const res = await auth.verify(request(signedHeader(sk, { createdAt: NOW + 3600 })));
    expect(rejected(res)).toBe(true);
    if (rejected(res)) {
      expect(res.status).toBe(401);
      expect(['expired', 'malformed']).toContain(res.reason);
    }
  });

  it('wrong verb: the `t` tag must match the request verb → 401 wrong-verb; missing `t` is never accepted', async () => {
    const pairs: [string, BlossomVerb][] = [
      ['delete', 'upload'],
      ['upload', 'delete'],
      ['get', 'upload'],
      ['list', 'delete'],
      ['upload', 'list'],
      ['media', 'upload'], // BUD-05 verb, not what this request is
    ];
    for (const [tag, verb] of pairs) {
      const sha = verb === 'list' ? null : BLOB;
      const res = await auth.verify(request(signedHeader(sk, { verb: tag }), verb, sha));
      expect(rejected(res), `t=${tag} verb=${verb}`).toBe(true);
      if (rejected(res)) {
        expect(res.reason).toBe('wrong-verb');
        expect(res.status).toBe(401);
      }
    }
    const missing = await auth.verify(request(signedHeader(sk, { verb: null })));
    expect(rejected(missing)).toBe(true);
    if (rejected(missing)) expect(['wrong-verb', 'malformed']).toContain(missing.reason);
  });

  it('wrong hash: for blob-targeting verbs the requested sha256 must be among the `x` tags → 401 wrong-hash', async () => {
    const wrong = await auth.verify(request(signedHeader(sk, { x: [OTHER_BLOB] }), 'upload', BLOB));
    expect(rejected(wrong)).toBe(true);
    if (rejected(wrong)) {
      expect(wrong.reason).toBe('wrong-hash');
      expect(wrong.status).toBe(401);
    }
    const del = await auth.verify(
      request(signedHeader(sk, { verb: 'delete', x: [OTHER_BLOB] }), 'delete', BLOB),
    );
    expect(del).toMatchObject({ ok: false, reason: 'wrong-hash' });

    // No `x` tag at all for a verb that targets a blob.
    const none = await auth.verify(request(signedHeader(sk, { x: [] }), 'upload', BLOB));
    expect(rejected(none)).toBe(true);
    if (rejected(none)) expect(['wrong-hash', 'malformed']).toContain(none.reason);

    // Near-miss hashes: case and truncation are not equality.
    for (const near of [BLOB.toUpperCase(), BLOB.slice(0, 63), `${BLOB}0`]) {
      const res = await auth.verify(request(signedHeader(sk, { x: [near] }), 'upload', BLOB));
      expect(res, near).toMatchObject({ ok: false, reason: 'wrong-hash' });
    }

    // Several `x` tags, one of which matches → accepted (a token may cover many blobs).
    const multi = await auth.verify(
      request(signedHeader(sk, { x: [OTHER_BLOB, BLOB] }), 'upload', BLOB),
    );
    expect(multi).toMatchObject({ ok: true, pubkey });
  });

  it('verbs that do not target a blob (`list`, `get` without a hash) are accepted without `x` tags', async () => {
    expect(
      await auth.verify(request(signedHeader(sk, { verb: 'list', x: [] }), 'list', null)),
    ).toMatchObject({
      ok: true,
      pubkey,
    });
    expect(
      await auth.verify(request(signedHeader(sk, { verb: 'get', x: [] }), 'get', null)),
    ).toMatchObject({
      ok: true,
      pubkey,
    });
    // `get` for a specific blob still requires a matching `x`.
    const getWrong = await auth.verify(
      request(signedHeader(sk, { verb: 'get', x: [OTHER_BLOB] }), 'get', BLOB),
    );
    expect(getWrong).toMatchObject({ ok: false, reason: 'wrong-hash' });
  });

  it('BUD-04 mirror reuses the original `upload` token for the same hash', async () => {
    const header = signedHeader(sk, { verb: 'upload', x: [BLOB] });
    expect(await auth.verify(request(header, 'mirror', BLOB))).toMatchObject({ ok: true, pubkey });
    const other = getBlossomAuth()!;
    expect(await other.verify(request(header, 'mirror', OTHER_BLOB))).toMatchObject({
      ok: false,
      reason: 'wrong-hash',
    });
  });

  it('replayed: the same event is accepted at most once → second use is 401 replayed', async () => {
    const header = signedHeader(sk);
    expect(await auth.verify(request(header))).toMatchObject({ ok: true });
    const again = await auth.verify(request(header));
    expect(rejected(again)).toBe(true);
    if (rejected(again)) {
      expect(again.reason).toBe('replayed');
      expect(again.status).toBe(401);
    }
    // Replay is keyed on the event, not the header bytes: re-encoding the same JSON is still a replay.
    const ev = JSON.parse(
      Buffer.from(header.slice('Nostr '.length), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(ev).reverse());
    const reencoded = `Nostr ${Buffer.from(JSON.stringify(reordered)).toString('base64')}`;
    expect(reencoded).not.toBe(header);
    expect(await auth.verify(request(reencoded))).toMatchObject({ ok: false, reason: 'replayed' });
    // A genuinely new event from the same key is fine.
    expect(
      await auth.verify(request(signedHeader(sk, { content: 'second upload' }))),
    ).toMatchObject({
      ok: true,
    });
    // A rejected event is not "used": a wrong-verb attempt followed by the correct verb is not a replay.
    const h2 = signedHeader(sk, { verb: 'delete', content: 'delete it' });
    expect(await auth.verify(request(h2, 'upload'))).toMatchObject({
      ok: false,
      reason: 'wrong-verb',
    });
    expect(await auth.verify(request(h2, 'delete'))).toMatchObject({ ok: true });
  });

  it('denied pubkey: `deny()` → 403 denied regardless of a valid token; `allow()` lifts it', async () => {
    auth.deny(pubkey);
    const res = await auth.verify(request(signedHeader(sk)));
    expect(rejected(res)).toBe(true);
    if (rejected(res)) {
      expect(res.reason).toBe('denied');
      expect(res.status).toBe(403);
    }
    // Other pubkeys are unaffected.
    const sk2 = generateSecretKey();
    expect(await auth.verify(request(signedHeader(sk2)))).toMatchObject({
      ok: true,
      pubkey: getPublicKey(sk2),
    });
    // Lifting the deny restores access (a new event: the denied one was never accepted).
    auth.allow(pubkey);
    expect(await auth.verify(request(signedHeader(sk, { content: 'after allow' })))).toMatchObject({
      ok: true,
      pubkey,
    });
  });

  it('bad signature: a signature from a different key, or a tampered event, → 401 bad-signature', async () => {
    const ev = finalizeEvent(template(), sk);
    const impostor = finalizeEvent(template(), generateSecretKey());
    // (a) valid-looking sig that does not belong to `pubkey`
    const swapped = await auth.verify(request(toHeader({ ...ev, sig: impostor.sig })));
    expect(rejected(swapped)).toBe(true);
    if (rejected(swapped)) {
      expect(swapped.reason).toBe('bad-signature');
      expect(swapped.status).toBe(401);
    }
    // (b) pubkey swapped under a sig that was made by another key
    expect(await auth.verify(request(toHeader({ ...ev, pubkey: impostor.pubkey })))).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
    // (c) content tampered after signing (id no longer matches, sig no longer verifies)
    const tampered = await auth.verify(request(toHeader({ ...ev, content: `${ev.content}!` })));
    expect(rejected(tampered)).toBe(true);
    if (rejected(tampered)) expect(['bad-signature', 'malformed']).toContain(tampered.reason);
    // (d) tag tampered after signing: an attacker cannot add the hash they want to a real token
    const retagged = await auth.verify(
      request(toHeader({ ...ev, tags: [...ev.tags, ['x', OTHER_BLOB]] }), 'upload', OTHER_BLOB),
    );
    expect(rejected(retagged)).toBe(true);
    if (rejected(retagged)) expect(['bad-signature', 'malformed']).toContain(retagged.reason);
    // (e) sig field garbage
    for (const sig of ['', '00', 'zz'.repeat(64), ev.sig.slice(0, 127)]) {
      const res = await auth.verify(request(toHeader({ ...ev, sig })));
      expect(rejected(res), `sig=${sig.slice(0, 8)}`).toBe(true);
      if (rejected(res)) expect(['bad-signature', 'malformed']).toContain(res.reason);
    }
  });

  it('a rejection never echoes the token: the result carries no header, sig or event for failures', async () => {
    const header = signedHeader(sk, { expiration: NOW - 1 });
    const res = await auth.verify(request(header));
    expect(res.ok).toBe(false);
    const text = JSON.stringify(res);
    expect(text).not.toContain(header.slice(6, 40));
    expect(Object.keys(res).sort()).toEqual(['ok', 'reason', 'status']);
  });
});
