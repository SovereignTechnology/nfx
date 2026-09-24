/**
 * NFX-05 §4 in the browser, by nfx-proto itself (compiled to WASM, `crates/nfx-wasm`):
 * the hash list must hash to `root` (and, given a manifest's `video` and `segs`, match
 * them), every file must hash to the listed content name its URL names, and playlists
 * must obey the content-name rule. sha256 is RustCrypto's, so this works without
 * WebCrypto and therefore without a secure context (spike S3).
 */
import init, { VerifiedHashList } from '../out/wasm/nfx_wasm.js';

let ready: Promise<unknown> | null = null;

/** Load the WASM module once; it sits next to the bundle in out/wasm/. */
export function loadWasm(): Promise<unknown> {
  ready ??= init({ module_or_path: new URL('./wasm/nfx_wasm_bg.wasm', import.meta.url) });
  return ready;
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

  static async load(origin: string, root: string, manifest?: ManifestBinding): Promise<Anchor> {
    if (!/^[0-9a-f]{64}$/.test(root)) throw new Error('root must be 64 lowercase hex');
    await loadWasm();
    const res = await fetch(`${origin}/${root}`);
    if (!res.ok) throw new Error(`hash list: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
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
