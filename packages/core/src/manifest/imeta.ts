/**
 * NIP-92 `imeta` codec: `["imeta", "key value", "key value", …]`.
 *
 * Each entry is split at its FIRST space; a value may itself contain spaces (NIP-92's
 * `alt`, NIP-71's `waveform`). Keys may repeat (`image`, `fallback`). Parsing is
 * order-preserving so `build → parse → build` is stable.
 */
import type { NostrTag } from '../contracts/index.js';

export interface ImetaEntry {
  readonly key: string;
  readonly value: string;
}

/** `null` when any entry has no key, no value, or the tag is not an imeta tag. */
export function parseImetaTag(tag: NostrTag): ImetaEntry[] | null {
  if (tag[0] !== 'imeta') return null;
  const out: ImetaEntry[] = [];
  for (const s of tag.slice(1)) {
    const sp = s.indexOf(' ');
    if (sp <= 0 || sp === s.length - 1) return null;
    out.push({ key: s.slice(0, sp), value: s.slice(sp + 1) });
  }
  return out;
}

export function serializeImetaTag(entries: readonly ImetaEntry[]): NostrTag {
  return ['imeta', ...entries.map((e) => `${e.key} ${e.value}`)];
}

export function imetaFirst(entries: readonly ImetaEntry[], key: string): string | undefined {
  for (const e of entries) if (e.key === key) return e.value;
  return undefined;
}

export function imetaAll(entries: readonly ImetaEntry[], key: string): string[] {
  return entries.filter((e) => e.key === key).map((e) => e.value);
}
