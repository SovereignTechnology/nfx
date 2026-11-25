/**
 * From a manifest address to something playable, trusting only signatures and hashes:
 *
 * - the **anchor** (`root`, `video`, `segs`) comes from the current revision of the signed
 *   manifest (NFX-02 §4, verified by nfx-proto in WASM);
 * - **where to fetch** comes from verified beacons' `https` endpoints (NFX-03 §5) or an
 *   operator's hint. Those are hints only: every byte is still checked against the anchor.
 */
import type { Endpoints, ResolvedManifest } from './api';
import { LookupAsker, parseATag, verifyBeacon, verifyDeletion, verifyManifest } from '../out/wasm/nfx_wasm.js';
import { EndpointBook, type VerifiedBeacon } from './endpoints';
import { type Subscription, publish, query, subscribe } from './nostr';
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
 * `watchEndpoints`'s result: call it to stop; `delivered(url)` tells it an origin delivered a
 * file; `ask()` asks the video's seeders to answer at once (NFX-17 §4), when the watch was
 * made with `ask: true`. Call `ask()` when the viewer presses Play, not when a page opens.
 */
export type EndpointWatch = (() => void) & { delivered(url: string): void; ask(): void };

export interface WatchOptions {
  /**
   * Ask seeders when `ask()` is called (NFX-17): one public event per wait, signed by a
   * throwaway key, that says which video is starting. Off: nothing is ever published.
   */
  ask?: boolean;
}

/** NFX-17 §4's numbers. */
const ASK_RELAYS = 3;
const ASK_AFTER_MS = 1_000;
const REASK_AFTER_MS = 3_000;
const TELLS_OPEN_MS = 10_000;
const TELLS_PER_RELAY = 64;
const PUBLISH_TIMEOUT_MS = 5_000;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Watch seeders' live beacons for `a` (in `namespace`) and report what they name together
 * (`Endpoints`) each time that changes: `https` origins (with the renditions claimed for each),
 * `webrtc` trackers, `stun` servers, and which renditions the seeders hold, from the newest
 * unexpired beacon of each seeder (./endpoints.ts). Beacons are ephemeral, so a
 * fresh subscription hears each seeder at its next republish (≤ TTL/2). STUN service
 * announcements (kind 33478) are not read: NFX-10 §1 never uses one on its own. Returns
 * `stop`.
 */
export function watchEndpoints(
  a: string,
  namespace: string,
  relays: string[],
  onChange: (endpoints: Endpoints) => void,
  options: WatchOptions = {},
): EndpointWatch {
  const filter = { kinds: [20464], '#n': [namespace], '#a': [a] };
  let heardAny = false;
  const book = new EndpointBook();
  let last = '';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Report what the book names now, if it changed, and look again when the next beacon held
  // expires: what it named counts no longer, even with nothing new heard meanwhile.
  const report = (): void => {
    if (stopped) return;
    const t = now();
    const snapshot = book.snapshot(t);
    const key = JSON.stringify(snapshot);
    if (key !== last) {
      last = key;
      onChange(snapshot);
    }
    clearTimeout(timer);
    const next = book.nextExpiration(t);
    if (next !== null) timer = setTimeout(report, Math.min(Math.max(next - t, 1), 3600) * 1000);
  };
  const hear = (json: string, relay: string): void => {
    if (stopped) return;
    let changed: boolean;
    try {
      const b = JSON.parse(verifyBeacon(json, now())) as VerifiedBeacon;
      // The relay a key was first heard on bounds how many keys it may bring (NFX-17 §4.2).
      changed = b.a === a && book.add(b, now(), relay);
      if (b.a === a) heardAny = true;
    } catch {
      return; // fails NFX-03: not a beacon
    }
    if (changed) report();
  };
  const subs = relays.map((r) =>
    subscribe(
      r,
      filter,
      // Events can arrive before the WASM has loaded only if the caller skipped init().
      (json) => void loadWasm().then(() => hear(json, r), () => {}),
      () => {},
      () => {},
    ),
  );
  // Seeder lookup (NFX-17 §4): one throwaway key per video and watch, made on the first ask.
  let asker: LookupAsker | null = null;
  let asks = 0;
  let asking = false;
  const skipped = new Set<string>();
  let tellSubs: Subscription[] = [];
  let tellTimer: ReturnType<typeof setTimeout> | undefined;
  let reaskTimer: ReturnType<typeof setTimeout> | undefined;
  const closeTells = (): void => {
    clearTimeout(tellTimer);
    tellSubs.forEach((s) => s.close());
    tellSubs = [];
  };
  const sendAsk = (targets: string[]): void => {
    if (stopped || asker === null) return;
    asks += 1;
    const ev = asker.ask(now());
    for (const r of targets) {
      void publish(r, ev, PUBLISH_TIMEOUT_MS).then(({ ok, message }) => {
        // `blocked:` says the relay does not carry the kind: skip it for the session.
        if (!ok && message.startsWith('blocked:')) skipped.add(r);
      });
    }
    clearTimeout(tellTimer);
    tellTimer = setTimeout(closeTells, TELLS_OPEN_MS);
  };
  const ask = (): void => {
    if (stopped || options.ask !== true || asking) return;
    const targets = relays.filter((r) => !skipped.has(r)).slice(0, ASK_RELAYS);
    if (targets.length === 0) return;
    asking = true;
    void loadWasm().then(() => {
      if (stopped) return;
      if (asker === null) {
        const secret = randomBytes(32);
        asker = new LookupAsker(secret, a);
        secret.fill(0);
      }
      const me = asker;
      const tellFilter = { kinds: [20465], '#n': [namespace], '#p': [me.pubkey], '#t': ['tell'], '#a': [a], since: now() - 60 };
      let live = 0;
      let sent = false;
      const go = (): void => {
        if (!sent) {
          sent = true;
          sendAsk(targets);
        }
      };
      for (const r of targets) {
        let seen = 0;
        // Assigned just below; a tell cannot arrive before `subscribe` returns.
        let sub: Subscription | null = null;
        sub = subscribe(
          r,
          tellFilter,
          (json) => {
            // At most 64 tells per ask on each relay, counted before verification; then that
            // relay's tell subscription closes (§4.1).
            if (stopped) return;
            if (++seen > TELLS_PER_RELAY) {
              sub?.close();
              return;
            }
            try {
              const b = JSON.parse(me.readTell(json, now())) as VerifiedBeacon;
              if (b.a === a && book.addTold(b, now())) {
                heardAny = true;
                report();
              }
            } catch {
              // not a tell to this key about this video
            }
          },
          () => {
            live += 1;
            if (live === targets.length) go();
          },
          () => {},
        );
        if (sub !== null) tellSubs.push(sub);
      }
      // A relay that never sends EOSE does not hold the ask up for more than a second.
      setTimeout(go, ASK_AFTER_MS);
      // Once more, after 3 s, if no beacon has been heard at all (§4: at most twice per wait).
      reaskTimer = setTimeout(() => {
        if (!heardAny && asks < 2) sendAsk(targets.filter((r) => !skipped.has(r)));
      }, REASK_AFTER_MS + ASK_AFTER_MS);
    }, () => {});
  };

  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(reaskTimer);
    subs.forEach((s) => s.close());
    closeTells();
    asker?.free();
    asker = null;
  };
  // A session tells the book which origins delivered, so the first key that named each is
  // never replaced (NFX-17 §4.2).
  return Object.assign(stop, { delivered: (url: string): void => book.delivered(url), ask });
}
