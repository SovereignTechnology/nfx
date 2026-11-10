/**
 * Which levels a session offers (NFX-10 §1, NFX-03 §§4–5), as plain data: no network, no
 * hls.js, no WASM. `open()` (./lib.ts) applies it; unit.ts tests it.
 *
 * A level is matched to its rendition by its playlist's content name (NFX-10 §2), never by
 * bitrate or size: the last element of the playlist URL's path is `<sha256>.<ext>`, and the
 * hash list's `renditions[].playlist` names the playlist file with that sha256. This is
 * nfx-proto's `HashList::rendition_for_playlist`, the rule the mesh's swarm IDs follow.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Most ids `open()`'s `renditions` and an `OriginSource` take, and a beacon's seeder names. */
export const MAX_RENDITIONS = 32;
/** Longest rendition id counted from a beacon (a hash list's ids are labels like `720p`). */
export const MAX_RENDITION_ID_LENGTH = 64;
/** The rendition id reserved for the metadata collection (NFX-03 §4, NFX-06 §2). */
export const RESERVED_RENDITION_ID = 'meta';

/** A rendition id a beacon may name and this player counts: non-empty, not `meta`, at most 64 characters. */
export function beaconRenditionId(id: unknown): id is string {
  return typeof id === 'string' && id !== '' && id !== RESERVED_RENDITION_ID && id.length <= MAX_RENDITION_ID_LENGTH;
}

/** `id` for an error message: quoted, and cut short (ids come from callers and creators). */
function show(id: unknown): string {
  return JSON.stringify(typeof id === 'string' && id.length > 64 ? `${id.slice(0, 64)}…` : id) ?? String(id);
}

/** One rendition of a verified hash list: its id, and the sha256 of its playlist. */
export interface HashListRendition {
  id: string;
  playlist: string;
}

/** What `open()` reads from a verified hash list. */
export interface HashListLevels {
  /** Its renditions, in its order. */
  renditions: HashListRendition[];
  /** The sha256 of its master playlist. */
  master: string | null;
}

/**
 * The renditions and master playlist of a hash list that nfx-proto has verified, from its
 * canonical JSON (`VerifiedHashList.toJSON()`). Verification guarantees each rendition names
 * a distinct playlist file; anything else is left out rather than guessed at.
 */
export function hashListLevels(json: string): HashListLevels {
  const list = JSON.parse(json) as { files?: unknown; renditions?: unknown };
  const playlists = new Map<string, string>();
  let master: string | null = null;
  for (const f of Array.isArray(list.files) ? (list.files as unknown[]) : []) {
    const { name, role, sha256 } = (f ?? {}) as { name?: unknown; role?: unknown; sha256?: unknown };
    if (typeof name !== 'string' || typeof sha256 !== 'string') continue;
    if (role === 'playlist' && !playlists.has(name)) playlists.set(name, sha256);
    if (role === 'playlist-master' && master === null) master = sha256;
  }
  const renditions: HashListRendition[] = [];
  for (const r of Array.isArray(list.renditions) ? (list.renditions as unknown[]) : []) {
    const { id, playlist } = (r ?? {}) as { id?: unknown; playlist?: unknown };
    const sha = typeof playlist === 'string' ? playlists.get(playlist) : undefined;
    if (typeof id === 'string' && sha !== undefined) renditions.push({ id, playlist: sha });
  }
  return { renditions, master };
}

/**
 * The sha256 that `url`'s last path element names as a content name (`<sha256>.<ext>`,
 * NFX-05 §3), or null: how a playlist URL maps to its rendition (NFX-10 §2).
 */
export function contentHash(url: string, base?: string): string | null {
  let path: string;
  try {
    path = new URL(url, base).pathname;
  } catch {
    return null;
  }
  const last = path.split('/').filter((p) => p !== '').pop() ?? '';
  const dot = last.indexOf('.');
  if (dot < 0 || dot === last.length - 1) return null;
  const hash = last.slice(0, dot);
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/**
 * `renditions` as `open()` takes it: null for every rendition, else 1 to `MAX_RENDITIONS`
 * distinct non-empty ids, never `meta`, in the caller's order. Throws a `TypeError` for
 * anything else, before anything is fetched.
 */
export function checkRenditions(list: unknown): string[] | null {
  if (list === undefined) return null;
  if (!Array.isArray(list)) throw new TypeError('nfx: renditions must be a list of rendition ids');
  if (list.length === 0) throw new TypeError('nfx: renditions must name at least one rendition (leave it out for every one)');
  if (list.length > MAX_RENDITIONS) throw new TypeError(`nfx: renditions names at most ${MAX_RENDITIONS} renditions`);
  const out: string[] = [];
  for (const id of list as unknown[]) {
    if (typeof id !== 'string' || id === '' || id === RESERVED_RENDITION_ID) {
      throw new TypeError(`nfx: renditions: ${show(id)} is not a rendition id`);
    }
    if (out.includes(id)) throw new TypeError(`nfx: renditions: ${show(id)} is named twice`);
    out.push(id);
  }
  return out;
}

/**
 * Whether an origin that serves `serves` (null: every rendition) can serve any of `wanted`
 * (null: every rendition of the hash list), as far as is known before the hash list is
 * read. `open()` skips one that cannot without fetching from it.
 */
export function mayServe(wanted: readonly string[] | null, serves: readonly string[] | null): boolean {
  if (serves === null) return true;
  return wanted === null ? serves.length > 0 : wanted.some((id) => serves.includes(id));
}

/**
 * A session's renditions on one origin: the allowed ones (`wanted`, or every id of the hash
 * list in its order) that the origin serves (`serves`, or every one), in `wanted`'s order.
 * Empty when it serves none of them. Throws a `RangeError` for an id of `wanted` the hash
 * list (`ids`) does not have: a caller's mistake, the same on every origin.
 */
export function sessionRenditions(
  ids: readonly string[],
  wanted: readonly string[] | null,
  serves: readonly string[] | null,
): string[] {
  const missing = wanted?.find((id) => !ids.includes(id));
  if (missing !== undefined) {
    const has = ids.slice(0, 16).map(show).join(', ') + (ids.length > 16 ? ', …' : '');
    throw new RangeError(`nfx: renditions: ${show(missing)} is not a rendition of this video (it has ${has})`);
  }
  return (wanted ?? ids).filter((id) => serves === null || serves.includes(id));
}

/**
 * hls.js 1.7.3's master playlist pattern (`MASTER_PLAYLIST_REGEX` in its m3u8 parser), so a
 * cut removes exactly what hls.js would read as a variant: `#EXT-X-STREAM-INF` through the
 * next line that is neither empty nor a tag. Every other match is left as it is.
 */
const MASTER_PLAYLIST =
  /#EXT-X-STREAM-INF:([^\r\n]*)(?:[\r\n](?:#[^\r\n]*)?)*([^\r\n]+)|#EXT-X-(I-FRAME-STREAM-INF|SESSION-DATA|SESSION-KEY|DEFINE|CONTENT-STEERING|START):([^\r\n]*)(?:[\r\n]+|$)/g;

/** Each variant hls.js would read in `text`: where it is, and the playlist sha256 its URI names. */
function variants(text: string, base: string): { start: number; end: number; hash: string | null }[] {
  const re = new RegExp(MASTER_PLAYLIST.source, 'g');
  const out: { start: number; end: number; hash: string | null }[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[2] !== undefined) out.push({ start: m.index, end: m.index + m[0].length, hash: contentHash(m[2], base) });
  }
  return out;
}

/**
 * `text`, a verified master playlist fetched from `base`, with every variant whose playlist
 * is not one of `keep` (sha256s) cut out, and how many variants are left. Throws if what is
 * left still names another playlist when read again (fail closed; it cannot happen with the
 * pattern above, and is checked rather than assumed).
 */
export function cutMaster(text: string, base: string, keep: ReadonlySet<string>): { text: string; kept: number } {
  let out = '';
  let at = 0;
  for (const v of variants(text, base)) {
    if (v.hash !== null && keep.has(v.hash)) continue;
    out += text.slice(at, v.start);
    at = v.end;
  }
  out += text.slice(at);
  const left = variants(out, base);
  if (left.some((v) => v.hash === null || !keep.has(v.hash))) throw new Error('nfx: the master playlist could not be cut to the allowed renditions');
  return { text: out, kept: left.length };
}
