/**
 * From a manifest address to something playable, trusting only signatures and hashes:
 *
 * - the **anchor** (`root`, `video`, `segs`) comes from the current revision of the signed
 *   manifest (NFX-02 §4, verified by nfx-proto in WASM);
 * - **where to fetch** comes from verified beacons' `https` endpoints (NFX-03 §5) or an
 *   operator's hint. Those are hints only: every byte is still checked against the anchor.
 */
import { parseATag, verifyBeacon, verifyDeletion, verifyManifest } from '../out/wasm/nfx_wasm.js';
import { query, subscribe } from './nostr';
import { loadWasm } from './verify';

/** A revision dated beyond this is ignored (NFX-02 §4 "Revisions"). */
const FUTURE_HORIZON = 15 * 60;
/** Most distinct beacon-named origins one watch reports. */
const MAX_ORIGINS = 8;

/**
 * A beacon-named origin as a plain `https://host[:port][/prefix]` base, or null. Beacons
 * are untrusted and the player appends `/<root>/…` to this, so a query string, fragment or
 * credentials (which would steer requests to attacker-chosen URLs) are refused.
 */
export function originBase(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.search || u.hash || u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export interface Resolved {
  id: string;
  a: string;
  author: string;
  created_at: number;
  video: string;
  namespace: string;
  title: string;
  root: string;
  segs: number;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** The current revision of the manifest at `a` across `relays`. */
export async function resolveManifest(a: string, relays: string[], timeoutMs = 8000): Promise<Resolved> {
  await loadWasm();
  const want = JSON.parse(parseATag(a)) as { creator: string; video: string };
  const filter = { kinds: [38504], authors: [want.creator], '#d': [want.video] };
  const answers = await Promise.all(relays.map((r) => query(r, filter, timeoutMs)));
  let best: Resolved | null = null;
  for (const json of answers.flat()) {
    let m: Resolved;
    try {
      m = JSON.parse(verifyManifest(json)) as Resolved;
    } catch {
      continue; // fails NFX-02: whichever relay sent it, it does not exist
    }
    if (m.a !== a || m.created_at > now() + FUTURE_HORIZON) continue;
    if (!best || m.created_at > best.created_at || (m.created_at === best.created_at && m.id < best.id)) {
      best = m;
    }
  }
  // NFX-02 §6: a valid deletion by the author withdraws every revision at least as old as
  // itself. Relays that apply deletions drop the manifest too, so a withdrawn video is
  // reported as such whether or not a revision is still around.
  const deletions = await Promise.all(
    relays.map((r) => query(r, { kinds: [5], authors: [want.creator], '#a': [a] }, timeoutMs)),
  );
  for (const json of deletions.flat()) {
    let d: { author: string; created_at: number; addresses: string[] };
    try {
      d = JSON.parse(verifyDeletion(json));
    } catch {
      continue;
    }
    if (d.author !== want.creator || !d.addresses.includes(want.video)) continue;
    if (!best || d.created_at >= best.created_at) throw new Error(`${a} was deleted by its creator`);
  }
  if (!best) throw new Error(`no valid manifest for ${a} on ${relays.length} relay(s)`);
  return best;
}

/**
 * Report each `https` endpoint of a verified, unexpired beacon for `a`, as beacons arrive.
 * Beacons are ephemeral, so a fresh subscription sees the next republish (≤ TTL/2).
 */
export function watchOrigins(
  a: string,
  namespace: string,
  relays: string[],
  onOrigin: (url: string, seeder: string) => void,
): () => void {
  const filter = { kinds: [20464], '#n': [namespace], '#a': [a] };
  const reported = new Set<string>();
  const subs = relays.map((r) =>
    subscribe(
      r,
      filter,
      (json) => {
        let b: { a: string; seeder: string; content: { endpoints?: { t?: string; url?: unknown }[] } };
        try {
          b = JSON.parse(verifyBeacon(json, now()));
        } catch {
          return;
        }
        if (b.a !== a) return;
        for (const e of b.content.endpoints ?? []) {
          if (e.t !== 'https' || typeof e.url !== 'string') continue;
          const base = originBase(e.url);
          if (!base || reported.has(base) || reported.size >= MAX_ORIGINS) continue;
          reported.add(base);
          onOrigin(base, b.seeder);
        }
      },
      () => {},
      () => {},
    ),
  );
  return () => subs.forEach((s) => s.close());
}
