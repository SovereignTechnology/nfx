import { describe, expect, it } from 'vitest';

import type { NostrEvent, Rendition, VideoManifest } from '../../contracts/index.js';
import { DEFAULT_BLOCK_SIZE } from '../../contracts/index.js';
import { VIDEOS, asCoreKey, asSha256 } from '../../mocks/fixtures.js';
import { TestSigner, asRaw, tamper } from '../../nostr/__tests__/helpers.js';
import { ManifestBuildError, buildVideoEvent, renditionToImeta } from '../build.js';
import { decodeHyperUrl, encodeHyperUrl, isHyperUrl } from '../hyper-url.js';
import { imetaAll, imetaFirst, parseImetaTag, serializeImetaTag } from '../imeta.js';
import { parseVideoEvent } from '../parse.js';
import { verifyVideoEvent, verifyVideoEvents } from '../verify.js';

const signer = new TestSigner();
const FIXTURE_IMETA_KEYS = new Set(['url', 'm', 'x', 'size', 'dim', 'image', 'fallback']);

async function signFixture(v: VideoManifest): Promise<NostrEvent> {
  return signer.signEvent(buildVideoEvent(v));
}

function expectedAfterSigning(v: VideoManifest, ev: NostrEvent): VideoManifest {
  return { ...v, id: ev.id, author: ev.pubkey, event: ev };
}

describe('NIP-71 build → sign → verify round-trips every fixture', () => {
  it.each(VIDEOS.map((v) => [v.title, v] as const))('%s', async (_title, v) => {
    const ev = await signFixture(v);
    const r = verifyVideoEvent(asRaw(ev));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Strict: optional keys that are absent on the fixture must be absent on the parse.
    expect(r.value).toStrictEqual(expectedAfterSigning(v, ev));
    // And the event we built carries exactly the fixture's tags once our extra imeta
    // keys (label/bitrate/placeholder/image-x) are removed.
    const stripped = ev.tags.map((t) =>
      t[0] === 'imeta'
        ? t.filter((e, i) => i === 0 || FIXTURE_IMETA_KEYS.has(e.split(' ')[0] ?? ''))
        : t,
    );
    expect(stripped).toEqual(v.event.tags);
    expect(ev.content).toBe(v.event.content);
    expect(ev.created_at).toBe(v.event.created_at);
    expect(ev.kind).toBe(v.kind);
  });

  it('build is stable: parse(build(x)) → build → identical tags', async () => {
    const v = VIDEOS[1]!;
    const ev = await signFixture(v);
    const parsed = parseVideoEvent(ev);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(buildVideoEvent(parsed.value).tags).toEqual(buildVideoEvent(v).tags);
  });
});

describe('verifyVideoEvent rejections', () => {
  const v = VIDEOS[0]!;

  it('rejects a tampered event before looking at anything else (T9)', async () => {
    const ev = await signFixture(v);
    expect(verifyVideoEvent(asRaw(tamper(ev)))).toEqual({
      ok: false,
      error: { code: 'bad-signature' },
    });
    const tagged = tamper(ev, {
      tags: ev.tags.map((t) => (t[0] === 'title' ? ['title', 'Impostor title'] : t)),
    });
    expect(verifyVideoEvent(asRaw(tagged))).toEqual({
      ok: false,
      error: { code: 'bad-signature' },
    });
    expect(verifyVideoEvent({ not: 'an event' })).toEqual({
      ok: false,
      error: { code: 'bad-signature' },
    });
  });

  it('rejects the wrong kind', async () => {
    const ev = await signer.signEvent({ ...buildVideoEvent(v), kind: 1 });
    expect(verifyVideoEvent(asRaw(ev))).toEqual({
      ok: false,
      error: { code: 'wrong-kind', kind: 1 },
    });
  });

  it.each([
    ['title', 'title'],
    ['mint', 'mint'],
    ['price', 'price'],
    ['p2pk', 'p2pk'],
    ['imeta', 'imeta'],
  ] as const)('rejects a manifest missing the %s tag', async (_label, tag) => {
    const draft = buildVideoEvent(v);
    const ev = await signer.signEvent({ ...draft, tags: draft.tags.filter((t) => t[0] !== tag) });
    expect(verifyVideoEvent(asRaw(ev))).toEqual({ ok: false, error: { code: 'missing-tag', tag } });
  });

  it('rejects an imeta without an x hash, and one with a malformed hash', async () => {
    const draft = buildVideoEvent(v);
    const noX = draft.tags.map((t) =>
      t[0] === 'imeta' ? t.filter((e) => !e.startsWith('x ')) : t,
    );
    let r = verifyVideoEvent(asRaw(await signer.signEvent({ ...draft, tags: noX })));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatchObject({
        code: 'bad-imeta',
        index: 0,
        reason: expect.stringContaining('x'),
      });
    const badX = draft.tags.map((t) =>
      t[0] === 'imeta' ? t.map((e) => (e.startsWith('x ') ? 'x deadbeef' : e)) : t,
    );
    r = verifyVideoEvent(asRaw(await signer.signEvent({ ...draft, tags: badX })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'bad-imeta', index: 0 });
  });

  it.each([
    ['https url', 'url https://cdn.example/video.mp4'],
    ['z32-looking key', 'url hyper://yry4u9x7ki8fm9d1fpp7ax3h5r9dqh8i1kc9g4hbo3ytz4cx1cxy/0-3'],
    ['missing range', `url hyper://${'a'.repeat(64)}`],
    ['zero blocks', `url hyper://${'a'.repeat(64)}/0-0`],
    ['negative-ish', `url hyper://${'a'.repeat(64)}/-1-3`],
    ['trailing junk', `url hyper://${'a'.repeat(64)}/0-3/extra`],
  ])('rejects a malformed hyper:// ref (%s)', async (_label, urlEntry) => {
    const draft = buildVideoEvent(v);
    const tags = draft.tags.map((t, i) =>
      t[0] === 'imeta' && i === 2 ? t.map((e) => (e.startsWith('url ') ? urlEntry : e)) : t,
    );
    const r = verifyVideoEvent(asRaw(await signer.signEvent({ ...draft, tags })));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toMatchObject({
        code: 'bad-imeta',
        index: 0,
        reason: expect.stringContaining('hyper'),
      });
  });

  it('reports the index of the offending rendition', async () => {
    const draft = buildVideoEvent(v);
    let seen = 0;
    const tags = draft.tags.map((t) => {
      if (t[0] !== 'imeta') return t;
      seen += 1;
      return seen === 2 ? t.filter((e) => !e.startsWith('size ')) : t;
    });
    const r = verifyVideoEvent(asRaw(await signer.signEvent({ ...draft, tags })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'bad-imeta', index: 1 });
  });

  it.each([
    [['split', 'seeder:60', 'creator:50'], 'bad-split'],
    [['split', 'seeder:100'], 'bad-split'],
    [['split', 'seeder:50', 'creator:50', 'gateway:0'], 'bad-split'],
    [['price', '1.5', 'sat'], 'bad-price'],
    [['price', '1', 'usd'], 'bad-price'],
    [['p2pk', 'ff'.repeat(32)], 'bad-price'],
  ])('rejects %j as %s', async (replacement, code) => {
    const draft = buildVideoEvent(v);
    const tags = draft.tags.map((t) => (t[0] === replacement[0] ? replacement : t));
    const r = verifyVideoEvent(asRaw(await signer.signEvent({ ...draft, tags })));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('verifyVideoEvents keeps the good ones and counts the rest', async () => {
    const a = await signFixture(VIDEOS[0]!);
    const b = await signFixture(VIDEOS[1]!);
    const out = verifyVideoEvents([asRaw(a), asRaw(tamper(b)), 'junk', asRaw(b)]);
    expect(out.manifests.map((m) => m.id)).toEqual([a.id, b.id]);
    expect(out.rejected.map((e) => e.code)).toEqual(['bad-signature', 'bad-signature']);
  });
});

describe('parse leniency and extras', () => {
  const v = VIDEOS[3]!;

  it('defaults split to 50/50 and published_at to created_at; ignores unknown tags', async () => {
    const draft = buildVideoEvent(v, { createdAt: (v.publishedAt + 60) as typeof v.publishedAt });
    const tags = draft.tags
      .filter((t) => t[0] !== 'split' && t[0] !== 'published_at')
      .concat([['mystery', 'x']]);
    const r = verifyVideoEvent(asRaw(await signer.signEvent({ ...draft, tags })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.price.split).toEqual({ seeder: 50, creator: 50 });
    expect(r.value.publishedAt).toBe(v.publishedAt + 60);
  });

  it('round-trips captions, storyboard, byteOffset, non-default block size and alt', async () => {
    const base = v.renditions[0]!;
    const rich: Rendition = {
      ...base,
      hyper: { core: base.hyper.core, blob: { ...base.hyper.blob, byteOffset: 4096 } },
      hyperUrl: '',
      captions: [
        { lang: 'en', url: 'https://cdn.example/en.vtt', sha256: asSha256('cap-en') },
        { lang: 'de', url: 'https://cdn.example/de.vtt' },
      ],
      storyboard: {
        url: 'https://cdn.example/sb.jpg',
        cols: 10,
        rows: 5,
        intervalSec: 2.5,
        sha256: asSha256('sb'),
      },
    };
    const input: VideoManifest = {
      ...v,
      renditions: [rich],
      price: { ...v.price, blockSize: 32_768 },
    };
    const ev = await signer.signEvent(buildVideoEvent(input, { alt: 'accessible' }));
    expect(ev.tags.some((t) => t[0] === 'block_size' && t[1] === '32768')).toBe(true);
    expect(ev.tags.some((t) => t[0] === 'alt' && t[1] === 'accessible')).toBe(true);
    const r = verifyVideoEvent(asRaw(ev));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = r.value.renditions[0]!;
    expect(got.hyper.blob.byteOffset).toBe(4096);
    expect(got.hyperUrl).toBe(`hyper://${base.hyper.core}/0-${base.hyper.blob.blockLength}+4096`);
    expect(got.captions).toEqual(rich.captions);
    expect(got.storyboard).toEqual(rich.storyboard);
    expect(r.value.price.blockSize).toBe(32_768);
    expect({ ...got, hyperUrl: '' }).toStrictEqual(rich);
  });

  it('derives a label from dim when none is given', async () => {
    const draft = buildVideoEvent(v);
    const tags = draft.tags.map((t) =>
      t[0] === 'imeta' ? t.filter((e) => !e.startsWith('label ')) : t,
    );
    const r = verifyVideoEvent(asRaw(await signer.signEvent({ ...draft, tags })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.renditions.map((x) => x.label)).toEqual(['1080p', '720p', '360p']);
  });

  it('parse does not check signatures (that is verify); build validates inputs', async () => {
    const ev = await signFixture(v);
    expect(parseVideoEvent(tamper(ev)).ok).toBe(true);
    expect(() => buildVideoEvent({ ...v, title: '' })).toThrow(ManifestBuildError);
    expect(() => buildVideoEvent({ ...v, renditions: [] })).toThrow(ManifestBuildError);
    expect(() => buildVideoEvent({ ...v, price: { ...v.price, mints: [] } })).toThrow(
      ManifestBuildError,
    );
    expect(() =>
      buildVideoEvent({ ...v, price: { ...v.price, split: { seeder: 30, creator: 30 } } }),
    ).toThrow(/split/);
    expect(() =>
      buildVideoEvent({ ...v, price: { ...v.price, satsPerBlock: 1.5 as never } }),
    ).toThrow(/satsPerBlock/);
    const r0 = v.renditions[0]!;
    expect(() => renditionToImeta({ ...r0, hyperUrl: 'hyper://mismatch' })).toThrow(/hyperUrl/);
    expect(() => renditionToImeta({ ...r0, size: r0.size + 1 })).toThrow(/byteLength/);
  });
});

describe('hyper:// codec', () => {
  it('encodes and decodes', () => {
    const core = asCoreKey('c');
    const ref = { core, blob: { byteOffset: 0, blockOffset: 3, blockLength: 7, byteLength: 1000 } };
    const url = encodeHyperUrl(ref);
    expect(url).toBe(`hyper://${core}/3-7`);
    expect(decodeHyperUrl(url, 1000)).toEqual(ref);
    const off = { core, blob: { ...ref.blob, byteOffset: 99 } };
    expect(decodeHyperUrl(encodeHyperUrl(off), 1000)).toEqual(off);
    expect(isHyperUrl(url)).toBe(true);
    expect(isHyperUrl('https://x')).toBe(false);
    expect(decodeHyperUrl(url, -1)).toBeNull();
    expect(decodeHyperUrl(url, 1.5)).toBeNull();
    expect(decodeHyperUrl(`hyper://${core.toUpperCase()}/3-7`, 1)).toBeNull();
  });
  it('matches the fixture encoding exactly', () => {
    for (const v of VIDEOS)
      for (const r of v.renditions) expect(encodeHyperUrl(r.hyper)).toBe(r.hyperUrl);
    expect(DEFAULT_BLOCK_SIZE).toBe(65_536);
  });
});

describe('imeta codec', () => {
  it('splits on the first space only and preserves order and repeats', () => {
    const tag = ['imeta', 'url hyper://x', 'alt A scenic photo', 'fallback a', 'fallback b'];
    const e = parseImetaTag(tag)!;
    expect(e).toEqual([
      { key: 'url', value: 'hyper://x' },
      { key: 'alt', value: 'A scenic photo' },
      { key: 'fallback', value: 'a' },
      { key: 'fallback', value: 'b' },
    ]);
    expect(serializeImetaTag(e)).toEqual(tag);
    expect(imetaFirst(e, 'fallback')).toBe('a');
    expect(imetaAll(e, 'fallback')).toEqual(['a', 'b']);
    expect(imetaFirst(e, 'nope')).toBeUndefined();
  });
  it('rejects entries without a value or key', () => {
    expect(parseImetaTag(['imeta', 'url'])).toBeNull();
    expect(parseImetaTag(['imeta', 'url '])).toBeNull();
    expect(parseImetaTag(['imeta', ' x'])).toBeNull();
    expect(parseImetaTag(['x', 'url y'])).toBeNull();
    expect(parseImetaTag(['imeta'])).toEqual([]);
  });
});
