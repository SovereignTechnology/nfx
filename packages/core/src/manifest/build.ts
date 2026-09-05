/**
 * Build a NIP-71 event draft from a `VideoManifest` (minus the fields only signing
 * produces). Emits exactly the tag schema in build-plan §2.2 / `Nip71TagSchema`, plus
 * a few imeta keys this network needs that NIP-92/94 do not define:
 *
 *   image-x <sha256>            thumbnail hash (T16: verify before display)
 *   label <text>                rendition label shown in the player
 *   bitrate <bits/sec>          NIP-71 (kbps × 1000)
 *   placeholder <data-url>      inline blur-up placeholder
 *   caption <lang> <url> [sha]  WebVTT captions (repeatable)
 *   storyboard <url> <cols> <rows> <intervalSec> [sha]
 *   block_size <bytes>          top-level tag, only when not the 64 KiB default
 */
import type { NostrTag, Rendition, UnixSeconds, VideoManifest } from '../contracts/index.js';
import { DEFAULT_BLOCK_SIZE } from '../contracts/index.js';
import type { EventDraft } from '../nostr/types.js';
import { encodeHyperUrl } from './hyper-url.js';
import type { ImetaEntry } from './imeta.js';
import { serializeImetaTag } from './imeta.js';

/** Everything a creator decides; `id`/`author`/`event` come from signing. */
export type VideoManifestInput = Omit<VideoManifest, 'id' | 'author' | 'event'>;

export interface BuildVideoOptions {
  /** Defaults to `publishedAt`, matching the fixtures. */
  readonly createdAt?: UnixSeconds;
  /** NIP-71 `alt` accessibility text. */
  readonly alt?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export class ManifestBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestBuildError';
  }
}

export function buildVideoEvent(
  input: VideoManifestInput,
  opts: BuildVideoOptions = {},
): EventDraft {
  if (input.title === '') throw new ManifestBuildError('title is required');
  if (input.renditions.length === 0) throw new ManifestBuildError('at least one rendition');
  if (input.price.mints.length === 0) throw new ManifestBuildError('at least one mint');
  if (!Number.isInteger(input.price.satsPerBlock) || input.price.satsPerBlock < 0) {
    throw new ManifestBuildError('satsPerBlock must be a non-negative integer');
  }
  const { seeder, creator } = input.price.split;
  if (
    !Number.isInteger(seeder) ||
    !Number.isInteger(creator) ||
    seeder < 0 ||
    creator < 0 ||
    seeder + creator !== 100
  ) {
    throw new ManifestBuildError('split must be non-negative integers summing to 100');
  }
  if (!/^0[23][0-9a-f]{64}$/.test(input.price.creatorP2pk)) {
    throw new ManifestBuildError('creatorP2pk must be a 33-byte compressed pubkey in hex');
  }
  if (!Number.isInteger(input.price.blockSize) || input.price.blockSize <= 0) {
    throw new ManifestBuildError('blockSize must be a positive integer');
  }

  const tags: NostrTag[] = [
    ['title', input.title],
    ['published_at', String(input.publishedAt)],
  ];
  for (const r of input.renditions) tags.push(renditionToImeta(r));
  for (const m of input.price.mints) tags.push(['mint', m]);
  tags.push(['price', String(input.price.satsPerBlock), 'sat']);
  tags.push(['split', `seeder:${seeder}`, `creator:${creator}`]);
  tags.push(['p2pk', input.price.creatorP2pk]);
  for (const t of input.tags) tags.push(['t', t]);
  if (input.durationSec !== undefined) tags.push(['duration', String(input.durationSec)]);
  for (const b of input.blossomServers) tags.push(['blossom', b]);
  if (input.price.blockSize !== DEFAULT_BLOCK_SIZE)
    tags.push(['block_size', String(input.price.blockSize)]);
  if (opts.alt !== undefined) tags.push(['alt', opts.alt]);

  return {
    kind: input.kind,
    created_at: opts.createdAt ?? input.publishedAt,
    tags,
    content: input.description,
  };
}

export function renditionToImeta(r: Rendition): NostrTag {
  if (!HEX64.test(r.sha256))
    throw new ManifestBuildError(`rendition ${r.label}: sha256 must be hex64`);
  if (!Number.isInteger(r.size) || r.size < 0)
    throw new ManifestBuildError(`rendition ${r.label}: bad size`);
  if (r.hyper.blob.byteLength !== r.size) {
    throw new ManifestBuildError(`rendition ${r.label}: blob byteLength must equal size`);
  }
  const url = encodeHyperUrl(r.hyper);
  if (r.hyperUrl !== '' && r.hyperUrl !== url) {
    throw new ManifestBuildError(
      `rendition ${r.label}: hyperUrl does not match hyper ref (${url})`,
    );
  }
  const e: ImetaEntry[] = [
    { key: 'url', value: url },
    { key: 'm', value: r.mime },
    { key: 'x', value: r.sha256 },
    { key: 'size', value: String(r.size) },
  ];
  if (r.width !== undefined && r.height !== undefined)
    e.push({ key: 'dim', value: `${r.width}x${r.height}` });
  if (r.image) {
    e.push({ key: 'image', value: r.image.url });
    if (r.image.sha256 !== undefined) e.push({ key: 'image-x', value: r.image.sha256 });
  }
  for (const f of r.fallbacks) e.push({ key: 'fallback', value: f });
  e.push({ key: 'label', value: r.label });
  if (r.bitrateKbps !== undefined)
    e.push({ key: 'bitrate', value: String(Math.round(r.bitrateKbps * 1000)) });
  if (r.placeholder !== undefined) e.push({ key: 'placeholder', value: r.placeholder });
  for (const c of r.captions ?? []) {
    e.push({
      key: 'caption',
      value: c.sha256 === undefined ? `${c.lang} ${c.url}` : `${c.lang} ${c.url} ${c.sha256}`,
    });
  }
  if (r.storyboard) {
    const s = r.storyboard;
    const base = `${s.url} ${s.cols} ${s.rows} ${s.intervalSec}`;
    e.push({ key: 'storyboard', value: s.sha256 === undefined ? base : `${base} ${s.sha256}` });
  }
  for (const x of e) {
    if (x.value === '' || /\s/.test(x.key))
      throw new ManifestBuildError(`rendition ${r.label}: empty imeta ${x.key}`);
  }
  return serializeImetaTag(e);
}
