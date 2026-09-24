/**
 * NFX-05 §4 in the browser: bytes are trusted only after their sha256 matches the name
 * the hash list gives them, and the hash list only after its sha256 matches `root`.
 * Digests come from WebCrypto (`crypto.subtle`), never from hand-written code.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const CONTENT_NAME = /^([0-9a-f]{64})(\.[a-z0-9]{1,16})?$/;

export interface Listed {
  name: string;
  role: string;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  // WebCrypto exists only in secure contexts (https:, localhost). Without it there is
  // nothing to verify with, and this player refuses rather than play unverified bytes.
  // The nfx-proto WASM build lifts this (status: next).
  if (!globalThis.crypto?.subtle) {
    throw new Error('no WebCrypto here: open this page over https:// or from localhost');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A hash list fetched by `root` and anchored to it. */
export class Anchor {
  private constructor(
    readonly origin: string,
    readonly root: string,
    readonly files: Map<string, Listed>,
    readonly master: string,
  ) {}

  /** Fetch `<origin>/<root>`, check its sha256 is `root`, and index its files. */
  static async load(origin: string, root: string): Promise<Anchor> {
    if (!HEX64.test(root)) throw new Error('root must be 64 lowercase hex');
    const res = await fetch(`${origin}/${root}`);
    if (!res.ok) throw new Error(`hash list: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const got = await sha256Hex(bytes);
    if (got !== root) throw new Error(`hash list sha256 ${got} is not root ${root}`);
    const list = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
      files?: { name: string; role: string; sha256: string }[];
    };
    const files = new Map<string, Listed>();
    for (const f of list.files ?? []) {
      if (!HEX64.test(f.sha256)) throw new Error(`hash list: bad sha256 for ${f.name}`);
      files.set(f.sha256, { name: f.name, role: f.role });
    }
    const master = [...files].find(([, f]) => f.role === 'playlist-master')?.[0];
    if (!master) throw new Error('hash list has no master playlist');
    return new Anchor(origin, root, files, master);
  }

  /**
   * The sha256 a URL's bytes must have: its content name when the hash list lists it,
   * the master playlist's for the convenience URL, and nothing otherwise.
   */
  expected(url: string): string {
    const u = new URL(url, location.href);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.at(-1) ?? '';
    if (parts.length === 2 && parts[0] === this.root && last === 'master.m3u8') return this.master;
    const m = CONTENT_NAME.exec(last);
    if (!m || !m[1]) throw new Error(`not a content name: ${u.pathname}`);
    if (!this.files.has(m[1])) throw new Error(`${m[1]} is not in this hash list`);
    return m[1];
  }

  /** Throws unless `bytes` are what `url` names. */
  async check(url: string, bytes: ArrayBuffer): Promise<string> {
    const want = this.expected(url);
    const got = await sha256Hex(bytes);
    if (got !== want) throw new Error(`sha256 mismatch for ${want}: got ${got}`);
    return want;
  }
}
