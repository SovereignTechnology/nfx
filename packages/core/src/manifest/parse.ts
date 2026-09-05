/**
 * Parse a NIP-71 event into a `VideoManifest`. Accepts a superset of what `build`
 * emits and ignores unknown tags/imeta keys. Does NOT check the signature — that is
 * `verifyVideoEvent`'s job; `parseVideoEvent` must only be handed events that already
 * passed `verifyIncoming` (the type system cannot enforce that, the call sites do).
 */
import type {
  CashuP2pkPubkey,
  ManifestError,
  MintUrl,
  NostrEvent,
  NostrTag,
  PricePolicy,
  Rendition,
  Result,
  Sats,
  Sha256Hex,
  UnixSeconds,
  VideoManifest,
} from '../contracts/index.js';
import { DEFAULT_BLOCK_SIZE, NostrKind } from '../contracts/index.js';
import { decodeHyperUrl } from './hyper-url.js';
import { imetaAll, imetaFirst, parseImetaTag } from './imeta.js';

const HEX64 = /^[0-9a-f]{64}$/;
const P2PK = /^0[23][0-9a-f]{64}$/;

const fail = (error: ManifestError): Result<never, ManifestError> => ({ ok: false, error });

function first(tags: readonly NostrTag[], name: string): NostrTag | undefined {
  return tags.find((t) => t[0] === name);
}
function values(tags: readonly NostrTag[], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) if (t[0] === name && t[1] !== undefined) out.push(t[1]);
  return out;
}

export function parseVideoEvent(ev: NostrEvent): Result<VideoManifest, ManifestError> {
  if (ev.kind !== NostrKind.Video && ev.kind !== NostrKind.ShortVideo) {
    return fail({ code: 'wrong-kind', kind: ev.kind });
  }
  const tags = ev.tags;

  const title = first(tags, 'title')?.[1];
  if (title === undefined || title === '') return fail({ code: 'missing-tag', tag: 'title' });

  const publishedRaw = first(tags, 'published_at')?.[1];
  const published = publishedRaw === undefined ? undefined : parseUintStr(publishedRaw);
  const publishedAt = (published ?? ev.created_at) as UnixSeconds;

  // ---- price policy --------------------------------------------------------------
  const mints = values(tags, 'mint').filter((m) => /^https?:\/\//.test(m)) as MintUrl[];
  if (mints.length === 0) return fail({ code: 'missing-tag', tag: 'mint' });

  const priceTag = first(tags, 'price');
  if (!priceTag) return fail({ code: 'missing-tag', tag: 'price' });
  const satsPerBlock = parseUintStr(priceTag[1]);
  if (satsPerBlock === undefined)
    return fail({ code: 'bad-price', reason: 'not a non-negative integer' });
  if (priceTag[2] !== undefined && priceTag[2] !== 'sat') {
    return fail({ code: 'bad-price', reason: `unit must be sat, got ${priceTag[2]}` });
  }
  const blockSizeRaw = first(tags, 'block_size')?.[1];
  const blockSize = blockSizeRaw === undefined ? DEFAULT_BLOCK_SIZE : parseUintStr(blockSizeRaw);
  if (blockSize === undefined || blockSize === 0)
    return fail({ code: 'bad-price', reason: 'bad block_size' });

  const splitTag = first(tags, 'split');
  const split = splitTag
    ? parseSplit(splitTag)
    : { ok: true as const, value: { seeder: 50, creator: 50 } };
  if (!split.ok) return fail({ code: 'bad-split', reason: split.reason });

  const p2pk = first(tags, 'p2pk')?.[1];
  if (p2pk === undefined) return fail({ code: 'missing-tag', tag: 'p2pk' });
  if (!P2PK.test(p2pk))
    return fail({ code: 'bad-price', reason: 'p2pk is not a 33-byte compressed pubkey' });

  const price: PricePolicy = {
    satsPerBlock: satsPerBlock as Sats,
    blockSize,
    mints,
    split: split.value,
    creatorP2pk: p2pk as CashuP2pkPubkey,
  };

  // ---- renditions ----------------------------------------------------------------
  const imetas = tags.filter((t) => t[0] === 'imeta');
  if (imetas.length === 0) return fail({ code: 'missing-tag', tag: 'imeta' });
  const renditions: Rendition[] = [];
  for (const [index, tag] of imetas.entries()) {
    const r = parseRendition(tag, index);
    if (!r.ok) return r;
    renditions.push(r.value);
  }

  const durationRaw = first(tags, 'duration')?.[1];
  const durationSec = durationRaw === undefined ? undefined : parseNonNegNumber(durationRaw);

  const manifest: VideoManifest = {
    id: ev.id,
    kind: ev.kind,
    author: ev.pubkey,
    title,
    description: ev.content,
    publishedAt,
    ...(durationSec === undefined ? {} : { durationSec }),
    tags: values(tags, 't'),
    renditions,
    price,
    blossomServers: values(tags, 'blossom'),
    event: ev,
  };
  return { ok: true, value: manifest };
}

function parseRendition(tag: NostrTag, index: number): Result<Rendition, ManifestError> {
  const bad = (reason: string): Result<never, ManifestError> =>
    fail({ code: 'bad-imeta', index, reason });
  const entries = parseImetaTag(tag);
  if (!entries) return bad('imeta entries must be "key value"');
  const url = imetaFirst(entries, 'url');
  if (url === undefined) return bad('missing url');
  const x = imetaFirst(entries, 'x');
  if (x === undefined) return bad('missing x (sha256)');
  if (!HEX64.test(x)) return bad('x is not a sha256 hex');
  const mime = imetaFirst(entries, 'm');
  if (mime === undefined) return bad('missing m (mime type)');
  const sizeRaw = imetaFirst(entries, 'size');
  const size = sizeRaw === undefined ? undefined : parseUintStr(sizeRaw);
  if (size === undefined) return bad('missing or invalid size');
  const hyper = decodeHyperUrl(url, size);
  if (!hyper) return bad('url is not a well-formed hyper:// reference');

  let width: number | undefined;
  let height: number | undefined;
  const dim = imetaFirst(entries, 'dim');
  if (dim !== undefined) {
    const m = /^(\d{1,6})x(\d{1,6})$/.exec(dim);
    if (!m) return bad('dim must be <w>x<h>');
    width = Number(m[1]);
    height = Number(m[2]);
  }

  const imageUrl = imetaFirst(entries, 'image');
  const imageX = imetaFirst(entries, 'image-x');
  if (imageX !== undefined && !HEX64.test(imageX)) return bad('image-x is not a sha256 hex');

  const label =
    imetaFirst(entries, 'label') ?? (height !== undefined ? `${height}p` : `variant-${index + 1}`);
  const bitrateRaw = imetaFirst(entries, 'bitrate');
  const bitrateBps = bitrateRaw === undefined ? undefined : parseNonNegNumber(bitrateRaw);
  const placeholder = imetaFirst(entries, 'placeholder');

  const captions: { lang: string; url: string; sha256?: Sha256Hex }[] = [];
  for (const c of imetaAll(entries, 'caption')) {
    const parts = c.split(' ');
    const [lang, curl, sha] = parts;
    if (parts.length < 2 || parts.length > 3 || !lang || !curl)
      return bad('caption must be <lang> <url> [sha256]');
    if (sha !== undefined && !HEX64.test(sha)) return bad('caption sha256 is not hex');
    captions.push({ lang, url: curl, ...(sha === undefined ? {} : { sha256: sha as Sha256Hex }) });
  }

  let storyboard: Rendition['storyboard'];
  const sb = imetaFirst(entries, 'storyboard');
  if (sb !== undefined) {
    const parts = sb.split(' ');
    const [surl, cols, rows, interval, sha] = parts;
    if (parts.length < 4 || parts.length > 5 || !surl)
      return bad('storyboard must be <url> <cols> <rows> <intervalSec> [sha256]');
    const c = parseUintStr(cols);
    const r = parseUintStr(rows);
    const i = parseNonNegNumber(interval ?? '');
    if (c === undefined || r === undefined || i === undefined)
      return bad('storyboard numbers are invalid');
    if (sha !== undefined && !HEX64.test(sha)) return bad('storyboard sha256 is not hex');
    storyboard = {
      url: surl,
      cols: c,
      rows: r,
      intervalSec: i,
      ...(sha === undefined ? {} : { sha256: sha as Sha256Hex }),
    };
  }

  const rendition: Rendition = {
    label,
    mime,
    sha256: x as Sha256Hex,
    size,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(bitrateBps === undefined ? {} : { bitrateKbps: bitrateBps / 1000 }),
    hyper,
    hyperUrl: url,
    fallbacks: imetaAll(entries, 'fallback'),
    ...(imageUrl === undefined
      ? {}
      : {
          image: {
            url: imageUrl,
            ...(imageX === undefined ? {} : { sha256: imageX as Sha256Hex }),
          },
        }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(captions.length === 0 ? {} : { captions }),
    ...(storyboard === undefined ? {} : { storyboard }),
  };
  return { ok: true, value: rendition };
}

function parseSplit(
  tag: NostrTag,
): { ok: true; value: { seeder: number; creator: number } } | { ok: false; reason: string } {
  let seeder: number | undefined;
  let creator: number | undefined;
  for (const part of tag.slice(1)) {
    const m = /^(seeder|creator):(\d{1,3})$/.exec(part);
    if (!m) return { ok: false, reason: `unrecognised split entry "${part}"` };
    if (m[1] === 'seeder') seeder = Number(m[2]);
    else creator = Number(m[2]);
  }
  if (seeder === undefined || creator === undefined)
    return { ok: false, reason: 'split needs both seeder and creator' };
  if (seeder + creator !== 100)
    return { ok: false, reason: `split sums to ${seeder + creator}, not 100` };
  return { ok: true, value: { seeder, creator } };
}

function parseUintStr(s: string | undefined): number | undefined {
  if (s === undefined || !/^\d{1,15}$/.test(s)) return undefined;
  return Number(s);
}

function parseNonNegNumber(s: string): number | undefined {
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) return undefined;
  return Number(s);
}
