/**
 * From a manifest address to something playable, trusting only signatures and hashes:
 *
 * - the **anchor** (`root`, `video`, `segs`) comes from the current revision of the signed
 *   manifest (NFX-02 §4, verified by nfx-proto in WASM);
 * - **where to fetch** comes from verified beacons' `https` endpoints (NFX-03 §5) or an
 *   operator's hint. Those are hints only: every byte is still checked against the anchor.
 */
import type { Endpoints, ResolvedManifest } from './api';
import { parseATag, verifyBeacon, verifyDeletion, verifyManifest } from '../out/wasm/nfx_wasm.js';
import { EndpointBook, type VerifiedBeacon } from './endpoints';
import { query, subscribe } from './nostr';
import { loadWasm } from './verify';

export { originBase } from './endpoints';

/** A revision dated beyond this is ignored (NFX-02 §4 "Revisions"). */
const FUTURE_HORIZON = 15 * 60;

const now = (): number => Math.floor(Date.now() / 1000);

/** The current revision of the manifest at `a` across `relays`. */
export async function resolveManifest(a: string, relays: string[], timeoutMs = 8000): Promise<ResolvedManifest> {
  await loadWasm();
  const want = JSON.parse(parseATag(a)) as { creator: string; video: string };
  const filter = { kinds: [38504], authors: [want.creator], '#d': [want.video] };
  const answers = await Promise.all(relays.map((r) => query(r, filter, timeoutMs)));
  let best: ResolvedManifest | null = null;
  for (const json of answers.flat()) {
    let m: ResolvedManifest;
    try {
      const v = JSON.parse(verifyManifest(json)) as Omit<ResolvedManifest, 'event'>;
      m = {
        id: v.id,
        a: v.a,
        author: v.author,
        created_at: v.created_at,
        video: v.video,
        namespace: v.namespace,
        title: v.title,
        root: v.root,
        segs: v.segs,
        event: json,
      };
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
 * Watch seeders' live beacons for `a` (in `namespace`) and report what they name together
 * (`Endpoints`) each time that changes: `https` origins (with the renditions each serves),
 * `webrtc` trackers, `stun` servers, and which renditions the seeders hold, from the newest
 * unexpired beacon of each seeder (./endpoints.ts). Beacons are ephemeral, so a
 * fresh subscription hears each seeder at its next republish (≤ TTL/2). Returns `stop`.
 */
export function watchEndpoints(
  a: string,
  namespace: string,
  relays: string[],
  onChange: (endpoints: Endpoints) => void,
): () => void {
  const filter = { kinds: [20464], '#n': [namespace], '#a': [a] };
  const book = new EndpointBook();
  let last = '';
  let stopped = false;
  const hear = (json: string): void => {
    if (stopped) return;
    let b: VerifiedBeacon;
    try {
      b = JSON.parse(verifyBeacon(json, now())) as VerifiedBeacon;
    } catch {
      return; // fails NFX-03: not a beacon
    }
    if (b.a !== a || !book.add(b, now())) return;
    const snapshot = book.snapshot(now());
    const key = JSON.stringify(snapshot);
    if (key === last) return;
    last = key;
    onChange(snapshot);
  };
  const subs = relays.map((r) =>
    subscribe(
      r,
      filter,
      // Events can arrive before the WASM has loaded only if the caller skipped init().
      (json) => void loadWasm().then(() => hear(json), () => {}),
      () => {},
      () => {},
    ),
  );
  return () => {
    stopped = true;
    subs.forEach((s) => s.close());
  };
}
