/**
 * Deterministic fixtures for MockNetworkAdapter / Storybook / screen lanes.
 * No randomness: the same call always yields the same data so screenshots are diffable.
 */
import type {
  CashuP2pkPubkey,
  CoreKeyHex,
  MintUrl,
  NostrEvent,
  NostrEventId,
  NostrPubkey,
  Profile,
  Sats,
  Sha256Hex,
  UnixSeconds,
  VideoManifest,
  Rendition,
  PricePolicy,
  Comment,
} from '../contracts/index.js';
import { DEFAULT_BLOCK_SIZE, NostrKind } from '../contracts/index.js';

/** Deterministic 64-hex from a seed string (NOT a hash function — fixture data only). */
export function fakeHex64(seed: string): string {
  let out = '';
  let x = 0x9e3779b9;
  for (let i = 0; i < seed.length; i++)
    x = (Math.imul(x ^ seed.charCodeAt(i), 0x85ebca6b) >>> 0) ^ (x >>> 13);
  for (let i = 0; i < 64; i++) {
    x = (Math.imul(x, 0xc2b2ae35) + i + 1) >>> 0;
    out += (x & 0xf).toString(16);
  }
  return out;
}

export const asPubkey = (s: string): NostrPubkey => fakeHex64(`pk:${s}`) as NostrPubkey;
export const asEventId = (s: string): NostrEventId => fakeHex64(`ev:${s}`) as NostrEventId;
export const asSha256 = (s: string): Sha256Hex => fakeHex64(`sha:${s}`) as Sha256Hex;
export const asCoreKey = (s: string): CoreKeyHex => fakeHex64(`core:${s}`) as CoreKeyHex;
export const asP2pk = (s: string): CashuP2pkPubkey =>
  `02${fakeHex64(`p2pk:${s}`)}` as CashuP2pkPubkey;
export const asMint = (s: string): MintUrl => s as MintUrl;
export const sats = (n: number): Sats => n as Sats;
export const unix = (n: number): UnixSeconds => n as UnixSeconds;

export const FIXTURE_NOW = unix(1_757_000_000); // 2025-09-04T14:13:20Z, stable

export const MINTS = {
  a: asMint('https://mint.fixture-a.example'),
  b: asMint('https://mint.fixture-b.example'),
} as const;

export interface FixtureChannel {
  readonly pubkey: NostrPubkey;
  readonly profile: Profile;
  readonly seeds: boolean;
}

const channelDefs: readonly {
  readonly slug: string;
  readonly name: string;
  readonly nip05?: string;
  readonly seeds: boolean;
}[] = [
  { slug: 'orbital', name: 'Orbital Mechanics', nip05: 'orbital@fixture.example', seeds: true },
  { slug: 'kilnfire', name: 'Kilnfire Ceramics', nip05: 'kiln@fixture.example', seeds: false },
  { slug: 'lowtide', name: 'Low Tide Sessions', seeds: true },
  { slug: 'matrixops', name: 'matrixops', nip05: 'ops@fixture.example', seeds: false },
  { slug: 'greenroom', name: 'The Green Room', seeds: false },
];

export const CHANNELS: readonly FixtureChannel[] = channelDefs.map((c) => {
  const pubkey = asPubkey(c.slug);
  const base = {
    pubkey,
    name: c.slug,
    displayName: c.name,
    about: `Fixture channel "${c.name}". Everything here is generated test data.`,
    picture: `https://fixture.example/avatars/${c.slug}.png`,
    banner: `https://fixture.example/banners/${c.slug}.png`,
    nip05Status: c.nip05 ? 'verified' : 'none',
    fetchedAt: FIXTURE_NOW,
  } as const;
  const profile: Profile = c.nip05 ? { ...base, nip05: c.nip05 } : base;
  return { pubkey, profile, seeds: c.seeds };
});

export const ME: NostrPubkey = asPubkey('me');
export const MY_PROFILE: Profile = {
  pubkey: ME,
  name: 'me',
  displayName: 'Fixture Viewer',
  nip05Status: 'none',
  fetchedAt: FIXTURE_NOW,
};

interface VideoDef {
  readonly slug: string;
  readonly title: string;
  readonly channel: number;
  readonly kind: 21 | 22;
  readonly durationSec: number;
  readonly tags: readonly string[];
  readonly satsPerBlock: number;
  readonly ageHours: number;
  readonly mints: readonly MintUrl[];
}

const videoDefs: readonly VideoDef[] = [
  {
    slug: 'hohmann',
    title: 'Hohmann transfers explained with a garden hose',
    channel: 0,
    kind: 21,
    durationSec: 754,
    tags: ['space', 'physics'],
    satsPerBlock: 1,
    ageHours: 3,
    mints: [MINTS.a],
  },
  {
    slug: 'raku',
    title: 'Raku firing at night — full session',
    channel: 1,
    kind: 21,
    durationSec: 2810,
    tags: ['ceramics', 'craft'],
    satsPerBlock: 2,
    ageHours: 9,
    mints: [MINTS.a, MINTS.b],
  },
  {
    slug: 'tide-01',
    title: 'Low Tide Sessions #01: bass + rain',
    channel: 2,
    kind: 21,
    durationSec: 1980,
    tags: ['music', 'live'],
    satsPerBlock: 1,
    ageHours: 26,
    mints: [MINTS.b],
  },
  {
    slug: 'kube-1',
    title: 'What actually happens when a pod is evicted',
    channel: 3,
    kind: 21,
    durationSec: 1123,
    tags: ['devops', 'kubernetes'],
    satsPerBlock: 3,
    ageHours: 40,
    mints: [MINTS.a],
  },
  {
    slug: 'short-glaze',
    title: 'Glaze test tiles in 40 seconds',
    channel: 1,
    kind: 22,
    durationSec: 41,
    tags: ['ceramics'],
    satsPerBlock: 1,
    ageHours: 5,
    mints: [MINTS.a],
  },
  {
    slug: 'short-launch',
    title: 'T-minus 10 from the press site',
    channel: 0,
    kind: 22,
    durationSec: 28,
    tags: ['space'],
    satsPerBlock: 1,
    ageHours: 12,
    mints: [MINTS.a],
  },
  {
    slug: 'greenroom-4',
    title: 'Green Room ep.4 — touring on a budget',
    channel: 4,
    kind: 21,
    durationSec: 3330,
    tags: ['music', 'interview'],
    satsPerBlock: 1,
    ageHours: 70,
    mints: [MINTS.b],
  },
  {
    slug: 'orbit-decay',
    title: 'Why Starlink satellites fall out of the sky',
    channel: 0,
    kind: 21,
    durationSec: 902,
    tags: ['space', 'physics'],
    satsPerBlock: 2,
    ageHours: 100,
    mints: [MINTS.a],
  },
  {
    slug: 'wheel',
    title: 'Centering 5 kg on the wheel (no talking)',
    channel: 1,
    kind: 21,
    durationSec: 1415,
    tags: ['ceramics', 'asmr'],
    satsPerBlock: 1,
    ageHours: 150,
    mints: [MINTS.a],
  },
  {
    slug: 'tide-02',
    title: 'Low Tide Sessions #02: modular + field recordings',
    channel: 2,
    kind: 21,
    durationSec: 2400,
    tags: ['music', 'live'],
    satsPerBlock: 1,
    ageHours: 200,
    mints: [MINTS.b],
  },
  {
    slug: 'short-cable',
    title: 'Cable management in 30 s',
    channel: 3,
    kind: 22,
    durationSec: 31,
    tags: ['devops'],
    satsPerBlock: 1,
    ageHours: 15,
    mints: [MINTS.a],
  },
  {
    slug: 'etcd',
    title: 'etcd from first principles',
    channel: 3,
    kind: 21,
    durationSec: 2711,
    tags: ['devops', 'databases'],
    satsPerBlock: 2,
    ageHours: 400,
    mints: [MINTS.a],
  },
];

function rendition(
  slug: string,
  label: string,
  height: number,
  kbps: number,
  durationSec: number,
): Rendition {
  const size = Math.floor((kbps * 1000 * durationSec) / 8);
  const core = asCoreKey(`${slug}:${label}`);
  const blockLength = Math.ceil(size / DEFAULT_BLOCK_SIZE);
  const sha = asSha256(`${slug}:${label}`);
  return {
    label,
    mime: 'video/mp4',
    sha256: sha,
    size,
    width: Math.round((height * 16) / 9),
    height,
    bitrateKbps: kbps,
    hyper: { core, blob: { byteOffset: 0, blockOffset: 0, blockLength, byteLength: size } },
    hyperUrl: `hyper://${core}/0-${blockLength}`,
    fallbacks: [`https://gateway.fixture.example/${sha}`],
    image: {
      url: `https://fixture.example/thumbs/${slug}-${label}.jpg`,
      sha256: asSha256(`thumb:${slug}`),
    },
    placeholder: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  };
}

function manifest(def: VideoDef): VideoManifest {
  const channel = CHANNELS[def.channel];
  if (!channel) throw new Error('fixture channel index out of range');
  const publishedAt = unix(FIXTURE_NOW - def.ageHours * 3600);
  const renditions =
    def.kind === 22
      ? [rendition(def.slug, '720p', 720, 2500, def.durationSec)]
      : [
          rendition(def.slug, '1080p', 1080, 5000, def.durationSec),
          rendition(def.slug, '720p', 720, 2500, def.durationSec),
          rendition(def.slug, '360p', 360, 800, def.durationSec),
        ];
  const price: PricePolicy = {
    satsPerBlock: sats(def.satsPerBlock),
    blockSize: DEFAULT_BLOCK_SIZE,
    mints: def.mints,
    split: { seeder: 50, creator: 50 },
    creatorP2pk: asP2pk(channel.pubkey),
  };
  const id = asEventId(def.slug);
  const event: NostrEvent = {
    id,
    pubkey: channel.pubkey,
    kind: def.kind,
    created_at: publishedAt,
    content: `Fixture description for **${def.title}**. Links like https://example.com and nostr:npub… get rendered by the markdown subset.`,
    tags: [
      ['title', def.title],
      ['published_at', String(publishedAt)],
      ...renditions.map((r) => [
        'imeta',
        `url ${r.hyperUrl}`,
        `m ${r.mime}`,
        `x ${r.sha256}`,
        `size ${r.size}`,
        `dim ${r.width}x${r.height}`,
        `image ${r.image?.url ?? ''}`,
        `fallback ${r.fallbacks[0] ?? ''}`,
      ]),
      ...def.mints.map((m) => ['mint', m]),
      ['price', String(def.satsPerBlock), 'sat'],
      ['split', 'seeder:50', 'creator:50'],
      ['p2pk', price.creatorP2pk],
      ...def.tags.map((t) => ['t', t]),
      ['duration', String(def.durationSec)],
      ['blossom', 'https://gateway.fixture.example'],
    ],
    sig: fakeHex64(`sig:${def.slug}`) + fakeHex64(`sig2:${def.slug}`),
  };
  return {
    id,
    kind: def.kind,
    author: channel.pubkey,
    title: def.title,
    description: event.content,
    publishedAt,
    durationSec: def.durationSec,
    tags: def.tags,
    renditions,
    price,
    blossomServers: ['https://gateway.fixture.example'],
    event,
  };
}

export const VIDEOS: readonly VideoManifest[] = videoDefs.map(manifest);

/**
 * NIP-22 comment tags on a regular (kind 21/22) video event: root = `E`/`K`/`P`, parent =
 * `e`/`k`/`p`. A top-level comment's parent IS the root (same id, kind, pubkey); a reply's
 * parent is the kind-1111 comment it answers. Mirrors `nostr/comments.ts` `buildCommentEvent`,
 * which is what `fetchComments` (`#E` filter) and `parseComment` read.
 */
export function commentTags(
  video: { readonly id: NostrEventId; readonly kind: 21 | 22; readonly author: NostrPubkey },
  parent?: { readonly id: NostrEventId; readonly author: NostrPubkey },
): string[][] {
  const root = [
    ['E', video.id, '', video.author],
    ['K', String(video.kind)],
    ['P', video.author],
  ];
  return parent
    ? [
        ...root,
        ['e', parent.id, '', parent.author],
        ['k', String(NostrKind.Comment)],
        ['p', parent.author],
      ]
    : [...root, ['e', video.id, '', video.author], ['k', String(video.kind)], ['p', video.author]];
}

function videoRef(videoId: NostrEventId): {
  readonly id: NostrEventId;
  readonly kind: 21 | 22;
  readonly author: NostrPubkey;
} {
  const v = VIDEOS.find((x) => x.id === videoId);
  return { id: videoId, kind: v?.kind ?? 21, author: v?.author ?? ME };
}

export function fixtureComments(videoId: NostrEventId): Comment[] {
  const out: Comment[] = [];
  const video = videoRef(videoId);
  const n = 3 + (parseInt(videoId.slice(0, 2), 16) % 5);
  for (let i = 0; i < n; i++) {
    const author = CHANNELS[(i + 1) % CHANNELS.length]?.pubkey ?? ME;
    const id = asEventId(`c:${videoId}:${i}`);
    const createdAt = unix(FIXTURE_NOW - (i + 1) * 1800);
    const isReply = i % 3 === 2;
    const content = isReply
      ? 'Reply with a *link*: https://example.com/notes'
      : `Comment #${i + 1} on this video. Plain text only.`;
    const parent = isReply ? out[i - 1] : undefined;
    const event: NostrEvent = {
      id,
      pubkey: author,
      kind: NostrKind.Comment,
      created_at: createdAt,
      content,
      tags: commentTags(video, parent ? { id: parent.id, author: parent.author } : undefined),
      sig: fakeHex64(`csig:${id}`) + fakeHex64(`csig2:${id}`),
    };
    const base = { id, author, content, createdAt, reactions: (i * 7) % 23, event };
    out.push(parent ? { ...base, parent: parent.id } : base);
  }
  return out;
}
