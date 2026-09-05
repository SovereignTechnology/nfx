/**
 * Tiny atomic JSON file store on top of the fs adapter: write to `<path>.<rand>.tmp`, then
 * rename over the target. Used for the ban list and the CAS index under the data dir.
 */
import type { SeederCrypto } from '../adapters/crypto.js';
import type { SeederFs } from '../adapters/fs.js';

export class JsonStore<T> {
  constructor(
    private readonly fs: SeederFs,
    private readonly crypto: SeederCrypto,
    readonly path: string,
    private readonly validate: (raw: unknown) => T | null,
    private readonly empty: () => T,
  ) {}

  /** Missing or unreadable file → the empty value (and a `corrupt` flag for the caller to log). */
  async load(): Promise<{ readonly value: T; readonly corrupt: boolean }> {
    const st = await this.fs.stat(this.path);
    if (st === null) return { value: this.empty(), corrupt: false };
    try {
      const bytes = await this.fs.readFile(this.path);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const v = this.validate(parsed);
      return v === null ? { value: this.empty(), corrupt: true } : { value: v, corrupt: false };
    } catch {
      return { value: this.empty(), corrupt: true };
    }
  }

  async save(value: T): Promise<void> {
    const tmp = `${this.path}.${this.crypto.randomHex(4)}.tmp`;
    await this.fs.writeFile(tmp, JSON.stringify(value, null, 2));
    try {
      await this.fs.rename(tmp, this.path);
    } catch (err) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}
