/**
 * NFX-05 §4 in the browser, by nfx-proto itself (compiled to WASM, `crates/nfx-wasm`):
 * the hash list must hash to `root` (and, given a manifest's `video` and `segs`, match
 * them), every file must hash to the listed content name its URL names, and playlists
 * must obey the content-name rule. sha256 is RustCrypto's, so this works without
 * WebCrypto and therefore without a secure context (spike S3).
 */
import init, { VerifiedHashList } from '../out/wasm/nfx_wasm.js';

/** The largest hash list fetched, as native peers cap it (nfx-node `MAX_HASH_LIST_BYTES`). */
export const MAX_HASH_LIST_BYTES = 16 * 1024 * 1024;

let ready: Promise<unknown> | null = null;
let readyFrom: string | null = null;

/**
 * Load the WASM module once, from `url` or by default from `./wasm/nfx_wasm_bg.wasm` next
 * to the bundle. A second call with another URL is an error; a failed load may be retried.
 */
export function loadWasm(url?: string | URL): Promise<unknown> {
  const from = url === undefined ? null : new URL(url, location.href).href;
  if (ready !== null) {
    if (from !== null && from !== readyFrom) {
      return Promise.reject(new Error(`nfx: WASM already loaded from ${readyFrom ?? 'the default URL'}`));
    }
    return ready;
  }
  readyFrom = from;
  const attempt = init({ module_or_path: from ?? new URL('./wasm/nfx_wasm_bg.wasm', import.meta.url) });
  ready = attempt.catch((e: unknown) => {
    ready = null;
    readyFrom = null;
    throw e;
  });
  return ready;
}

/** `res`'s body, refused past `max` bytes without reading the rest. */
async function cappedBody(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Error(`hash list: over ${max} bytes`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`hash list: over ${max} bytes`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Optional manifest binding for the hash list (NFX-02 `d` and `segs`). */
export interface ManifestBinding {
  video: string;
  segs: number;
}

/** A hash list fetched by `root` and verified against it. */
export class Anchor {
  private constructor(
    readonly origin: string,
    readonly root: string,
    private readonly list: VerifiedHashList,
  ) {}

  static async load(origin: string, root: string, manifest?: ManifestBinding, signal?: AbortSignal): Promise<Anchor> {
    if (!/^[0-9a-f]{64}$/.test(root)) throw new Error('root must be 64 lowercase hex');
    await loadWasm();
    const res = await fetch(`${origin}/${root}`, { signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`hash list: HTTP ${res.status}`);
    const bytes = await cappedBody(res, MAX_HASH_LIST_BYTES);
    const list = manifest
      ? new VerifiedHashList(bytes, root, manifest.video, manifest.segs)
      : VerifiedHashList.fromRoot(bytes, root);
    return new Anchor(origin, root, list);
  }

  get size(): number {
    return this.list.size;
  }

  get video(): string {
    return this.list.video;
  }

  /** The sha256 `url`'s bytes must have; throws for anything the list does not name. */
  expected(url: string): string {
    return this.list.expected(new URL(url, location.href).pathname);
  }

  /** The NFX-10 §2 stream swarm ID of the stream whose playlist is at `url`, if any. */
  streamSwarmId(url: string): string | undefined {
    return this.list.streamSwarmId(new URL(url, location.href).pathname);
  }

  /** The verified sha256 of `bytes` fetched from `url`; throws on any mismatch. */
  check(url: string, bytes: ArrayBuffer): string {
    return this.list.check(new URL(url, location.href).pathname, new Uint8Array(bytes));
  }
}
