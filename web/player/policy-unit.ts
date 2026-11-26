/**
 * Unit checks for the mesh engine's choice of source with peers first (`tsx policy-unit.ts`,
 * after `npm run engine`): `decidePeerModeSource`, the pure function the engine patch adds
 * (web/player/engine), which says for one segment whether it comes from a peer, over HTTP as
 * a rescue, or waits. `segmentSource` `peers-then-https` is the engine's `peer-first`,
 * `peers-only` its `peer-only`.
 */
import { decidePeerModeSource } from './out-engine/p2p-media-loader-core/src/utils/stream';

type Input = Parameters<typeof decidePeerModeSource>[0];

let ran = 0;
let bad = 0;
function eq(what: string, got: unknown, want: unknown): void {
  ran += 1;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad += 1;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

/** The segment the player is asking for, well ahead of playback, no peer yet, peers had their wait. */
const base: Input = { policy: 'peer-first', loading: undefined, hasHolder: false, inGrace: false, late: false, waited: false, httpBudget: true };
const d = (o: Partial<Input>): string => decidePeerModeSource({ ...base, ...o });

// A peer holds it: it comes from the peer.
eq('a holder: ask the peer', d({ hasHolder: true }), 'p2p');
eq('a holder, in the wait for peers: ask the peer', d({ hasHolder: true, inGrace: true }), 'p2p');
eq('a holder, playback about to need it but asked only now: ask the peer (a seek)', d({ hasHolder: true, late: true }), 'p2p');
eq('a holder, asked for long but playback far from it: ask the peer', d({ hasHolder: true, waited: true }), 'p2p');
eq('a holder, late and asked for the whole wait: a rescue', d({ hasHolder: true, late: true, waited: true }), 'http');
eq('a peer is sending it: left alone', d({ hasHolder: true, loading: 'p2p' }), 'keep');
eq('a peer is sending it, late but not waited for: left alone', d({ hasHolder: true, loading: 'p2p', late: true }), 'keep');
eq('a peer is sending it too slowly: a rescue takes its place', d({ hasHolder: true, loading: 'p2p', late: true, waited: true }), 'http');
eq('the peer sending it is gone: left alone until the engine fails it', d({ loading: 'p2p' }), 'keep');
eq('the peer sending it is gone, and playback needs it: a rescue', d({ loading: 'p2p', late: true, waited: true }), 'http');

// No peer holds it.
eq('no holder, peers had their wait: a rescue at once', d({}), 'http');
eq('no holder, peers still connecting: wait', d({ inGrace: true }), 'wait');
eq('no holder, peers still connecting, even when playback needs it: wait', d({ inGrace: true, late: true, waited: true }), 'wait');
eq('no holder, not the segment asked for (or no HTTP attempt left): wait', d({ httpBudget: false }), 'wait');
eq('a holder, late and waited, but no HTTP attempt left: ask the peer', d({ hasHolder: true, late: true, waited: true, httpBudget: false }), 'p2p');

// An HTTP download is never interrupted.
for (const policy of ['peer-first', 'peer-only'] as const) {
  eq(`${policy}: an HTTP download runs on`, d({ policy, loading: 'http', hasHolder: true, late: true, waited: true }), 'keep');
}

// Peers only: HTTP never, whatever else holds.
const flags = [false, true];
let never = true;
for (const loading of [undefined, 'p2p'] as const) {
  for (const hasHolder of flags) for (const inGrace of flags) for (const late of flags) for (const waited of flags) for (const httpBudget of flags) {
    const got = decidePeerModeSource({ policy: 'peer-only', loading, hasHolder, inGrace, late, waited, httpBudget });
    if (got === 'http') never = false;
    const want = loading === 'p2p' ? 'keep' : hasHolder ? 'p2p' : 'wait';
    if (got !== want) eq(`peer-only ${JSON.stringify({ loading, hasHolder, inGrace, late, waited, httpBudget })}`, got, want);
  }
}
eq('peer-only: no input gives HTTP', never, true);
ran += 64;

// Peers first: HTTP only outside the wait and with an attempt left, over every input.
let guarded = true;
for (const loading of [undefined, 'p2p'] as const) {
  for (const hasHolder of flags) for (const inGrace of flags) for (const late of flags) for (const waited of flags) for (const httpBudget of flags) {
    const got = decidePeerModeSource({ policy: 'peer-first', loading, hasHolder, inGrace, late, waited, httpBudget });
    if (got === 'http' && (inGrace || !httpBudget)) guarded = false;
    if (got === 'http' && (hasHolder || loading === 'p2p') && !(late && waited)) guarded = false;
  }
}
eq('peer-first: a rescue only outside the wait, with an attempt left, and never ahead of a peer that still has time', guarded, true);

console.log(`policy-unit: ${ran - bad}/${ran} ok`);
process.exit(bad === 0 ? 0 : 1);
