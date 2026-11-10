/**
 * NFX-10 §6 through NATs (nfx #71, phase 3): two real browsers, each behind its own NAT,
 * signaling ONLY through a stock Nostr relay (strfry) and taking server-reflexive
 * candidates ONLY from a public nfxd's STUN responder (`nfxd --stun`). No tracker, no TURN.
 *
 * e2e-nat/run.sh builds the network (network namespaces and nftables routers, as root),
 * starts strfry and nfxd in its "public" namespace, and runs this driver there once per
 * cell. The driver:
 *   - fronts strfry with TLS (wss://<public>:7443 → strfry's plain ws on <public>:7777, the
 *     way a relay is deployed: the library takes `ws:` only on loopback);
 *   - subscribes to strfry for every kind, to record what it carried;
 *   - starts one headless Chromium in each LAN namespace (a fresh, non-persistent context;
 *     never a real profile), through e2e-nat/chromium-netns.sh as Playwright's executable,
 *     so the browser runs inside the LAN while Playwright drives it over its pipe;
 *   - serves the test page to each browser at http://127.0.0.1:8000 by request interception
 *     (a secure context with no server), with `&signal=nostr&relay=wss://…&stun=stun:…`;
 *   - reads the routers' byte counters (run.sh meter) and cuts router B's path to the origin
 *     (run.sh cut b).
 *
 * The cells (NAT_EXPECT):
 *   punch     A plays from the origin first, then B. Once B plays with a peer, router B cuts
 *             the origin. B must play 15 s past the cut. The selected candidate pair on both
 *             sides must be srflx ↔ srflx on the routers' public addresses; router B must have
 *             taken at least B's mesh bytes as UDP from router A's public address, and nothing
 *             from the public namespace but signaling (the relay) and STUN; nothing else
 *             crossed either router.
 *   no-punch  The same two pages, no cut. Every peer connection of B must end, never
 *             connected, within NAT_FAIL_BOUND_MS of its creation; B must take no mesh bytes
 *             and keep playing from the origin.
 *   record    The same, judged only on playback continuing; the outcome is recorded.
 *   nfxd      No browser A: run.sh started an nfxd with the mesh endpoint behind router A
 *             (#71 phase 2). B plays, and once it has a peer router B cuts the origin; B must
 *             play 15 s past the cut on mesh bytes alone, router B must have taken at least
 *             those as UDP from router A, the selected pair must be srflx ↔ srflx, and nfxd's
 *             last `mesh:` line (NAT_NFXD_LOG) must count a connection opened and a segment
 *             served. nfxd to browser only: the endpoint never takes bytes from a peer.
 * Every cell: strfry carried only kind-25050 `nfx-mesh/1` events, offers and answers as
 * NIP-44 v2 ciphertext naming no SDP, candidate or address in clear; no page opened a socket
 * to anything but the relay.
 *
 * Output: one JSON object on stdout after `NAT_RESULT `, and NAT_OUT/<cell>.json plus
 * NAT_OUT/<cell>-diag.json (page logs, peer-connection timelines, relay counts). Exit 0 when
 * the cell passed, 1 otherwise.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { type Socket, connect as tcpConnect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { type Browser, type Page, chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const player = resolve(here, '..');

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: e2e-nat/run.sh runs this driver`);
  return v;
}
const CELL = need('NAT_CELL');
const EXPECT = need('NAT_EXPECT') as 'punch' | 'no-punch' | 'record' | 'nfxd';
const NAT_A = need('NAT_A');
const NAT_B = need('NAT_B');
const PUB = need('NAT_PUB_IP');
const ROUTER_A = need('NAT_ROUTER_A_IP');
const ROUTER_B = need('NAT_ROUTER_B_IP');
const NS_A = need('NAT_NS_A');
const NS_B = need('NAT_NS_B');
const ORIGIN = `http://${PUB}:${need('NAT_ORIGIN_PORT')}`;
const STUN = `stun:${PUB}:${need('NAT_STUN_PORT')}`;
const RELAY_TLS_PORT = Number(need('NAT_RELAY_TLS_PORT'));
const RELAY = `wss://${PUB}:${RELAY_TLS_PORT}`;
const STRFRY_PORT = Number(need('NAT_STRFRY_PORT'));
const ROOT = need('NAT_ROOT');
const CTL = need('NAT_CTL');
const OUT = need('NAT_OUT');
const FAIL_BOUND_MS = Number(need('NAT_FAIL_BOUND_MS'));
const TLS_KEY = readFileSync(need('NAT_TLS_KEY'));
const TLS_CERT = readFileSync(need('NAT_TLS_CERT'));
const TLS_SPKI = need('NAT_TLS_SPKI');
const WRAPPER = join(here, 'chromium-netns.sh');
if (!['punch', 'no-punch', 'record', 'nfxd'].includes(EXPECT)) throw new Error(`NAT_EXPECT ${EXPECT}`);
/** The NAT'd nfxd's stderr, in the nfxd cell. */
const NFXD_LOG = need('NAT_NFXD_LOG');
if (!/^[0-9a-f]{64}$/.test(ROOT)) throw new Error('NAT_ROOT is not 64 hex');
if (!/^[A-Za-z0-9+/]{43}=$/.test(TLS_SPKI)) throw new Error('NAT_TLS_SPKI is not a base64 sha256');

/** Where the test page is served, by interception: a secure context, and no server. */
const PAGE = 'http://127.0.0.1:8000';
const PAGE_FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/player.css': ['player.css', 'text/css'],
  '/out/player.js': ['out/player.js', 'text/javascript'],
  '/out/wasm/nfx_wasm_bg.wasm': ['out/wasm/nfx_wasm_bg.wasm', 'application/wasm'],
};

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr.slice(-2000)}`);
  return r.stdout;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- the routers' byte counters (run.sh meter / cut) -----------------------------------------

type Meter = Record<string, number>;
interface Meters {
  a: Meter;
  b: Meter;
}

function meters(): Meters {
  const read = (r: string): Meter => JSON.parse(run('bash', [CTL, 'meter', r])) as Meter;
  return { a: read('a'), b: read('b') };
}

function delta(from: Meter, to: Meter): Meter {
  const d: Meter = {};
  for (const k of new Set([...Object.keys(from), ...Object.keys(to)])) d[k] = (to[k] ?? 0) - (from[k] ?? 0);
  return d;
}

// ---- the relay: TLS in front of strfry, and a subscriber of every kind ------------------------

/** wss://PUB:RELAY_TLS_PORT → strfry's plain ws on PUB:STRFRY_PORT, byte for byte. */
function tlsFront(): Promise<() => void> {
  const open = new Set<Socket>();
  const server = createTlsServer({ key: TLS_KEY, cert: TLS_CERT, minVersion: 'TLSv1.2' }, (client) => {
    const up = tcpConnect(STRFRY_PORT, PUB);
    open.add(client);
    open.add(up);
    const end = (): void => {
      client.destroy();
      up.destroy();
      open.delete(client);
      open.delete(up);
    };
    client.on('error', end).on('close', end);
    up.on('error', end).on('close', end);
    client.pipe(up);
    up.pipe(client);
  });
  server.on('tlsClientError', () => {});
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(RELAY_TLS_PORT, PUB, () =>
      ok(() => {
        for (const s of open) s.destroy();
        server.close();
      }),
    );
  });
}

interface RelayEvent {
  id: string;
  kind: number;
  pubkey: string;
  tags: string[][];
  content: string;
}

function watchRelay(url: string): Promise<{ events: RelayEvent[]; close: () => void }> {
  return new Promise((ok, fail) => {
    const events: RelayEvent[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => fail(new Error('the relay watcher never connected')), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.send(JSON.stringify(['REQ', 'watch', {}]));
      ok({ events, close: () => ws.close() });
    };
    ws.onmessage = (m) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(m.data));
      } catch {
        return; // not a relay message; a throwing listener would take the driver down
      }
      if (Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === 'watch' && msg[2] !== null && typeof msg[2] === 'object') {
        events.push(msg[2] as RelayEvent);
      }
    };
    ws.onerror = () => fail(new Error('the relay watcher could not connect'));
  });
}

/**
 * Everything the relay carried must be NFX-10 §6 signaling, its SDPs only as ciphertext.
 * As e2e-nostr.ts's check, with this network's addresses added to what must not appear.
 */
function relayProblems(events: RelayEvent[]): { problems: string[]; counts: Record<string, number> } {
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  const tag = (e: RelayEvent, name: string): string | undefined => e.tags.find((t) => t[0] === name)?.[1];
  const clear = /v=0|candidate|a=ice-|a=fingerprint|127\.0\.0\.1|192\.168\.|203\.0\.113\.|(?:^|[^0-9])10\.\d+\.\d+\.\d+/;
  for (const e of events) {
    const t = tag(e, 't') ?? '?';
    counts[`${e.kind}/${t}`] = (counts[`${e.kind}/${t}`] ?? 0) + 1;
    if (e.kind !== 25050) {
      problems.push(`kind ${e.kind} event ${e.id}`);
      continue;
    }
    if (tag(e, 'i') !== 'nfx-mesh/1' || tag(e, 'y') !== 'nfx') problems.push(`event ${e.id} is not nfx-mesh/1`);
    if (!e.tags.some((x) => x[0] === 'roomproof')) problems.push(`event ${e.id} has no room proof`);
    if (t === 'connect' || t === 'disconnect') {
      if (e.content !== '') problems.push(`${t} ${e.id} carries content`);
    } else if (t === 'offer' || t === 'answer') {
      let version = -1;
      try {
        version = Buffer.from(e.content, 'base64')[0] ?? -1;
      } catch {
        // not base64
      }
      if (!/^[A-Za-z0-9+/]+=*$/.test(e.content) || version !== 2) problems.push(`${t} ${e.id} is not NIP-44 v2 ciphertext`);
      if (clear.test(e.content)) problems.push(`${t} ${e.id} shows SDP or an address in clear`);
    } else {
      problems.push(`event ${e.id} of type ${t}`);
    }
    if (e.tags.some((x) => x.some((v) => clear.test(v)))) problems.push(`event ${e.id} has an address in a tag`);
  }
  return { problems, counts };
}

// ---- the pages -------------------------------------------------------------------------------

/**
 * Installed before any page script: every RTCPeerConnection the page makes, with its
 * timeline (ms since it was made), the candidates it gathered (type and port) and the
 * candidate types it was given, and when it connected, failed or was closed. The library
 * closes a connection it gives up on, and close() fires no state event, so close() is timed
 * here. A connection counts as a negotiation once it sets a description: p2p-media-loader
 * also makes one at startup that only probes createOffer() and is closed at once
 * (webrtc-utils.ts, supportsPromiseWebRTC).
 */
const RTC_PROBE = `(() => {
  const PC = window.RTCPeerConnection;
  const recs = [], pcs = [];
  class Probe extends PC {
    constructor(...a) {
      super(...a);
      const rec = { created: Date.now(), negotiated: false, ice: [], conn: [], local: [], remote: [], connectedAt: null, failedAt: null, closedAt: null };
      recs.push(rec);
      pcs.push(this);
      Object.defineProperty(this, '__rec', { value: rec });
      this.addEventListener('iceconnectionstatechange', () => {
        rec.ice.push([Date.now() - rec.created, this.iceConnectionState]);
        if (this.iceConnectionState === 'failed' && rec.failedAt === null) rec.failedAt = Date.now();
      });
      this.addEventListener('connectionstatechange', () => {
        rec.conn.push([Date.now() - rec.created, this.connectionState]);
        if (this.connectionState === 'connected' && rec.connectedAt === null) rec.connectedAt = Date.now();
        if (this.connectionState === 'failed' && rec.failedAt === null) rec.failedAt = Date.now();
      });
      this.addEventListener('icecandidate', (e) => {
        if (e.candidate && e.candidate.candidate) rec.local.push({ type: e.candidate.type || 'unknown', port: e.candidate.port ?? null });
      });
    }
    setLocalDescription(...r) {
      this.__rec.negotiated = true;
      return super.setLocalDescription(...r);
    }
    setRemoteDescription(d, ...r) {
      this.__rec.negotiated = true;
      const sdp = d && typeof d.sdp === 'string' ? d.sdp : '';
      for (const line of sdp.split(/\\r?\\n/)) {
        const m = / typ ([a-z]+)/.exec(line);
        if (line.startsWith('a=candidate:') && m) this.__rec.remote.push(m[1]);
      }
      return super.setRemoteDescription(d, ...r);
    }
    close() {
      if (this.__rec.closedAt === null) this.__rec.closedAt = Date.now();
      return super.close();
    }
  }
  window.RTCPeerConnection = Probe;
  window.__rtc = { recs, pcs };
})();`;

interface RtcRec {
  created: number;
  negotiated: boolean;
  ice: [number, string][];
  conn: [number, string][];
  local: { type: string; port: number | null }[];
  remote: string[];
  connectedAt: number | null;
  failedAt: number | null;
  closedAt: number | null;
}

interface Candidate {
  type: string | null;
  address: string | null;
  port: number | null;
  protocol: string | null;
}
interface SelectedPair {
  pc: number;
  local: Candidate | null;
  remote: Candidate | null;
  bytesSent: number | null;
  bytesReceived: number | null;
}

/**
 * The selected candidate pair of each connected peer connection, from getStats(): the
 * transport's selectedCandidatePairId, else the nominated pair that succeeded. A string, as
 * RTC_PROBE is: a function would be sent as tsx compiled it, with helpers the page lacks.
 */
const SELECTED_PAIRS = `(async () => {
  const out = [];
  for (const [i, pc] of window.__rtc.pcs.entries()) {
    if (pc.connectionState !== 'connected') continue;
    const report = await pc.getStats();
    const by = new Map();
    report.forEach((s) => by.set(s.id, s));
    let pair;
    report.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = by.get(s.selectedCandidatePairId) || pair; });
    if (!pair) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    const [local, remote] = [pair && by.get(pair.localCandidateId), pair && by.get(pair.remoteCandidateId)].map((x) =>
      x ? { type: x.candidateType ?? null, address: x.address ?? x.ip ?? null, port: x.port ?? null, protocol: x.protocol ?? null } : null);
    out.push({ pc: i, local, remote, bytesSent: pair?.bytesSent ?? null, bytesReceived: pair?.bytesReceived ?? null });
  }
  return out;
})()`;
const selectedPairs = (p: Page): Promise<SelectedPair[]> => p.evaluate(SELECTED_PAIRS) as Promise<SelectedPair[]>;

interface MeshState {
  peers: number;
  bytes: { http: number; p2p: number };
  uploaded: number;
  rejected: string[];
  signaling: string;
  relays: string[];
  trackers: string[];
}
interface PageState {
  playing: boolean;
  t: number;
  errors: string[];
  mesh: MeshState | null;
}

const state = (p: Page): Promise<PageState> =>
  p.evaluate(() => {
    const s = (window as unknown as { __nfx: { playing: boolean; errors: string[]; mesh: unknown } }).__nfx;
    return {
      playing: s.playing,
      t: (document.querySelector('video') as HTMLVideoElement).currentTime,
      errors: [...s.errors],
      mesh: s.mesh === null ? null : (JSON.parse(JSON.stringify(s.mesh)) as MeshState),
    };
  });

/** The page's negotiations (peer connections that set a description), oldest first. */
const rtc = async (p: Page): Promise<RtcRec[]> =>
  ((await p.evaluate(() => (window as unknown as { __rtc: { recs: unknown[] } }).__rtc.recs)) as RtcRec[]).filter((r) => r.negotiated);

/**
 * How the page's NAT mapped its socket, from the candidates it gathered: `kept` when the
 * srflx candidate (the mapping nfxd's STUN saw) has the host candidate's port, as a
 * consistent router keeps it; `changed` when it differs, as a fully-random one does; null
 * with no srflx candidate. One per negotiation; null entries dropped.
 */
function mappings(recs: RtcRec[]): ('kept' | 'changed')[] {
  const out: ('kept' | 'changed')[] = [];
  for (const r of recs) {
    const host = r.local.find((c) => c.type === 'host')?.port;
    const srflx = r.local.find((c) => c.type === 'srflx')?.port;
    if (host == null || srflx == null) continue;
    out.push(host === srflx ? 'kept' : 'changed');
  }
  return out;
}

const pageLog = (p: Page): Promise<string> =>
  p.evaluate(() => (document.getElementById('log')?.textContent ?? '').slice(-8000)).catch((e: unknown) => String(e));

/** Polls `fn` on the page until it holds or `ms` pass; false on timeout, never throws for it. */
async function until(p: Page, fn: (s: PageState) => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (fn(await state(p))) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

interface Viewer {
  name: 'A' | 'B';
  browser: Browser;
  page: Page;
  sockets: string[];
  console: string[];
}

async function viewer(name: 'A' | 'B', ns: string, httpWindow: number): Promise<Viewer> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.NFX_NETNS = ns;
  env.NFX_CHROMIUM = chromium.executablePath();
  const browser = await chromium.launch({
    headless: true,
    executablePath: WRAPPER,
    env,
    // The relay's TLS key, pinned: the browser trusts this test relay and nothing else new.
    args: [`--ignore-certificate-errors-spki-list=${TLS_SPKI}`],
  });
  const ctx = await browser.newContext();
  // The origin, relay and STUN server are on TEST-NET-3: if Chromium counts those as a
  // local network, the page may still reach them (it would ask a user).
  await ctx.grantPermissions(['local-network-access'], { origin: PAGE }).catch(() => {});
  await ctx.addInitScript({ content: RTC_PROBE });
  await ctx.route(
    (url) => url.origin === PAGE,
    (route) => {
      const f = PAGE_FILES[new URL(route.request().url()).pathname];
      if (!f) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: f[1], body: readFileSync(join(player, f[0])) });
    },
  );
  const page = await ctx.newPage();
  const v: Viewer = { name, browser, page, sockets: [], console: [] };
  page.on('websocket', (w) => v.sockets.push(w.url()));
  page.on('console', (m) => {
    if (v.console.length < 300) v.console.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => v.console.push(`pageerror: ${e.message}`));
  const q = new URLSearchParams({
    origin: ORIGIN,
    root: ROOT,
    signal: 'nostr',
    relay: RELAY,
    stun: STUN,
    httpWindow: String(httpWindow),
    level: '0',
  });
  await page.goto(`${PAGE}/?${q.toString()}`);
  return v;
}

// ---- judging ---------------------------------------------------------------------------------

/** A negotiation's outcome: connected (ms to connect), ended (ms to the end), or open (age). */
function outcome(r: RtcRec, now: number): { kind: 'connected' | 'ended' | 'open'; ms: number; reason: string } {
  if (r.connectedAt !== null) return { kind: 'connected', ms: r.connectedAt - r.created, reason: 'connected' };
  const ends = [r.failedAt, r.closedAt].filter((x): x is number => x !== null);
  if (ends.length > 0) {
    const at = Math.min(...ends);
    return { kind: 'ended', ms: at - r.created, reason: r.failedAt !== null && r.failedAt === at ? 'ICE failed' : 'closed' };
  }
  return { kind: 'open', ms: now - r.created, reason: 'open' };
}

/** The NAT'd nfxd's last `mesh:` status line, parsed (nfxd prints one whenever it changes). */
interface NfxdMesh {
  line: string;
  rooms: number;
  candidates: string[];
  opened: number;
  failed: number;
  served: number;
}
function nfxdMesh(): NfxdMesh | null {
  let text: string;
  try {
    text = readFileSync(NFXD_LOG, 'utf8');
  } catch {
    return null;
  }
  const line = text.split('\n').filter((l) => /^mesh: \d+ room\(s\), /.test(l)).at(-1);
  if (line === undefined) return null;
  const n = (re: RegExp): number => Number(re.exec(line)?.[1] ?? NaN);
  return {
    line,
    rooms: n(/^mesh: (\d+) room/),
    candidates: (/candidates \[([^\]]*)\]/.exec(line)?.[1] ?? '').split(', ').filter(Boolean),
    opened: n(/opened (\d+)/),
    failed: n(/failed (\d+)/),
    served: n(/segments served (\d+)/),
  };
}

/** As `mappings`, from nfxd's own candidates (`host <ip>:<port>`, `srflx <ip>:<port>`). */
function nfxdMapping(m: NfxdMesh | null): ('kept' | 'changed')[] {
  const port = (type: string): string | undefined => m?.candidates.find((c) => c.startsWith(`${type} `))?.split(':').at(-1);
  const host = port('host');
  const srflx = port('srflx');
  return host === undefined || srflx === undefined ? [] : [host === srflx ? 'kept' : 'changed'];
}

/** A server-reflexive candidate on this router's public address (getStats names it). */
const srflxOn = (c: Candidate | null, ip: string): boolean => c !== null && c.type === 'srflx' && c.address === ip;

async function main(): Promise<number> {
  const result: Record<string, unknown> = { cell: CELL, nat_a: NAT_A, nat_b: NAT_B, expect: EXPECT, judged: true };
  const problems: string[] = [];
  const watch = await watchRelay(`ws://${PUB}:${STRFRY_PORT}`);
  const closeFront = await tlsFront();
  const viewers: Viewer[] = [];
  const diag: Record<string, unknown> = {};
  try {
    // ---- A: plays from the origin first, and fetches far ahead over HTTP. In the nfxd
    // cell A is run.sh's nfxd, seeding already. ----
    const a = EXPECT === 'nfxd' ? null : await viewer('A', NS_A, 120);
    if (a !== null) {
      viewers.push(a);
      if (!(await until(a.page, (s) => s.playing || s.errors.length > 0, 90_000)) || !(await state(a.page)).playing) {
        throw new Error(`A did not play: ${JSON.stringify((await state(a.page)).errors)}`);
      }
      await sleep(10_000);
    }

    // ---- B: a 2 s HTTP window, so the rest is the mesh's to bring ----
    const m0 = meters();
    const b = await viewer('B', NS_B, 2);
    viewers.push(b);
    const bStart = Date.now();
    let m1: Meters | null = null;
    let cutAt: number | null = null;
    let atCut: PageState | null = null;
    let pairsB: SelectedPair[] = [];
    let pairsA: SelectedPair[] = [];

    if (EXPECT === 'punch' || EXPECT === 'nfxd') {
      const meshed = await until(b.page, (s) => s.errors.length > 0 || (s.playing && s.t > 3 && (s.mesh?.peers ?? 0) > 0), 120_000);
      if (!meshed) problems.push('B never played with a peer (120 s)');
      // The cut: router B refuses B's path to the origin (resets B's connections to it, drops
      // what it sends back). From here on B can only have segments from A.
      run('bash', [CTL, 'cut', 'b']);
      cutAt = Date.now();
      m1 = meters();
      atCut = await state(b.page);
      pairsB = await selectedPairs(b.page);
      pairsA = a === null ? [] : await selectedPairs(a.page);
      const t0 = atCut.t;
      result.cut_at_video_s = Math.round(t0 * 10) / 10;
      if (!(await until(b.page, (s) => s.errors.length > 0 || s.t > t0 + 15, 120_000))) problems.push('B stopped playing after the cut');
    } else {
      if (!(await until(b.page, (s) => s.errors.length > 0 || (s.playing && s.t > 3), 90_000))) problems.push('B never played');
      // Wait for B's first negotiation, then its end (or its connection), then playback to 30 s.
      const first = Date.now() + 90_000;
      while ((await rtc(b.page)).length === 0 && Date.now() < first) await sleep(500);
      const recs = await rtc(b.page);
      if (recs.length === 0) problems.push('B made no peer connection: no punch was attempted');
      else {
        const settle = recs[0]!.created + FAIL_BOUND_MS + 10_000;
        while (Date.now() < settle) {
          const r = (await rtc(b.page))[0]!;
          if (outcome(r, Date.now()).kind !== 'open') break;
          await sleep(500);
        }
      }
      if (!(await until(b.page, (s) => s.errors.length > 0 || s.t >= 30, 120_000))) problems.push('B did not play to 30 s');
      pairsB = await selectedPairs(b.page);
      pairsA = a === null ? [] : await selectedPairs(a.page);
    }

    const m2 = meters();
    const now = Date.now();
    const bEnd = await state(b.page);
    const aEnd = a === null ? null : await state(a.page);
    const recsB = await rtc(b.page);
    const recsA = a === null ? [] : await rtc(a.page);
    const cutCell = EXPECT === 'punch' || EXPECT === 'nfxd';
    if (cutCell && pairsB.length === 0) pairsB = await selectedPairs(b.page);
    if (EXPECT === 'punch' && a !== null && pairsA.length === 0) pairsA = await selectedPairs(a.page);
    const nfxd = EXPECT === 'nfxd' ? nfxdMesh() : null;
    const session = { a: delta(m0.a, m2.a), b: delta(m0.b, m2.b) };
    const afterCut = m1 === null ? null : { a: delta(m1.a, m2.a), b: delta(m1.b, m2.b) };
    const outB = recsB.map((r) => outcome(r, now));
    const outA = recsA.map((r) => outcome(r, now));
    const firstB = outB[0] ?? null;
    const connected = outB.some((o) => o.kind === 'connected');

    result.outcome = recsB.length === 0 ? 'no attempt' : connected ? 'connected' : outB.every((o) => o.kind === 'ended') ? 'failed' : 'pending';
    result.connect_ms = connected ? outB.find((o) => o.kind === 'connected')!.ms : null;
    result.fail_ms = !connected && firstB !== null && firstB.kind === 'ended' ? firstB.ms : null;
    result.fail_reason = !connected && firstB !== null ? firstB.reason : null;
    // The library's own words for a negotiation it gave up on, from B's log.
    result.library_reason = /mesh: nostr (?:offer to|answer to) \S+ failed: ([^\n]+)/.exec(await pageLog(b.page))?.[1] ?? null;
    result.attempts_b = recsB.length;
    result.negotiations_b = outB;
    result.negotiations_a = outA;
    // UDP between the two routers' public addresses, as each end counted it: what one router
    // sent toward the other, and what the other delivered into its LAN or refused.
    result.udp_a_to_b = { sent: session.a.peer_out ?? 0, delivered: session.b.peer_in ?? 0, refused: session.b.peer_refused ?? 0 };
    result.udp_b_to_a = { sent: session.b.peer_out ?? 0, delivered: session.a.peer_in ?? 0, refused: session.a.peer_refused ?? 0 };
    result.direct_bytes = (session.b.peer_in ?? 0) + (session.a.peer_in ?? 0);
    result.router_b = session.b;
    result.router_a = session.a;
    result.router_b_after_cut = afterCut?.b ?? null;
    result.cut_after_b_ms = cutAt === null ? null : cutAt - bStart;
    result.pairs_b = pairsB;
    result.pairs_a = pairsA;
    result.local_types_b = [...new Set(recsB.flatMap((r) => r.local.map((c) => c.type)))];
    result.remote_types_b = [...new Set(recsB.flatMap((r) => r.remote))];
    const mapA = a === null ? nfxdMapping(nfxd) : mappings(recsA);
    const mapB = mappings(recsB);
    result.mapping = { a: mapA, b: mapB };
    result.viewer = { t: bEnd.t, errors: bEnd.errors, mesh: bEnd.mesh, at_cut: atCut, played_ms: now - bStart };
    result.seeder = aEnd === null ? { nfxd } : { t: aEnd.t, errors: aEnd.errors, mesh: aEnd.mesh };
    result.fail_bound_ms = FAIL_BOUND_MS;
    diag.rtc = { A: recsA, B: recsB };

    // ---- what every cell holds ----
    if (bEnd.errors.length > 0) problems.push(`B errors ${JSON.stringify(bEnd.errors)}`);
    if (aEnd !== null && aEnd.errors.length > 0) problems.push(`A errors ${JSON.stringify(aEnd.errors)}`);
    for (const [n, s] of aEnd === null ? ([['B', bEnd]] as const) : ([['A', aEnd], ['B', bEnd]] as const)) {
      if (s.mesh?.signaling !== 'nostr' || JSON.stringify(s.mesh?.relays) !== JSON.stringify([RELAY])) {
        problems.push(`${n} signaling ${s.mesh?.signaling} ${JSON.stringify(s.mesh?.relays)}`);
      }
      if ((s.mesh?.trackers ?? []).length !== 0) problems.push(`${n} has trackers`);
      if ((s.mesh?.rejected ?? []).length !== 0) problems.push(`${n} rejected ${JSON.stringify(s.mesh?.rejected)}`);
    }
    for (const v of viewers) {
      for (const u of v.sockets) if (u.replace(/\/$/, '') !== RELAY) problems.push(`${v.name} opened a socket to ${u}`);
    }
    // Nothing crossed either router but the relay, STUN, the origin and the other router.
    for (const [r, m] of Object.entries(session)) {
      if ((m.other_in ?? 0) !== 0 || (m.other_out ?? 0) !== 0) problems.push(`router ${r} carried other traffic: ${m.other_in} in, ${m.other_out} out`);
    }
    // The routers behave as named: a consistent one kept the browser's (or the NAT'd nfxd's)
    // port in the mapping the public nfxd's STUN saw, a symmetric one changed it.
    for (const [n, nat, m] of [
      ['A', NAT_A, mapA],
      ['B', NAT_B, mapB],
    ] as const) {
      const want = nat === 'consistent' ? 'kept' : 'changed';
      if (m.length === 0) problems.push(`${n} gathered no srflx candidate: STUN from nfxd did not answer`);
      else if (m.some((x) => x !== want)) problems.push(`${n}'s ${nat} NAT: srflx port ${JSON.stringify(m)}, not ${want}`);
    }

    // ---- per cell ----
    if (EXPECT === 'punch' || EXPECT === 'nfxd') {
      const ms = bEnd.mesh;
      if (atCut !== null && !(bEnd.t > atCut.t + 15)) problems.push(`B played only to ${bEnd.t} s (cut at ${atCut.t} s)`);
      if (!((ms?.peers ?? 0) > 0)) problems.push('B has no peer');
      if (!((ms?.bytes.p2p ?? 0) > 0)) problems.push('no bytes over the mesh');
      // The mesh bytes came straight from router A's public address, as UDP.
      if (!((session.b.peer_in ?? 0) >= (ms?.bytes.p2p ?? Infinity))) {
        problems.push(`router B took ${session.b.peer_in} B of UDP from router A, fewer than B's ${ms?.bytes.p2p} mesh bytes`);
      }
      if (aEnd !== null) {
        if (!((aEnd.mesh?.uploaded ?? 0) > 0)) problems.push('A uploaded nothing');
        if (!((session.a.peer_out ?? 0) >= (aEnd.mesh?.uploaded ?? Infinity))) {
          problems.push(`router A sent ${session.a.peer_out} B of UDP to router B, fewer than A's ${aEnd.mesh?.uploaded} uploaded`);
        }
      } else {
        // The NAT'd nfxd: its last status line counts a connection opened and a segment
        // served, and both routers delivered UDP from the other (the punch, both ways).
        if (nfxd === null) problems.push(`nfxd printed no mesh status line (${NFXD_LOG})`);
        else if (!(nfxd.opened >= 1 && nfxd.served >= 1)) problems.push(`nfxd: ${nfxd.line}`);
        if (!((session.a.peer_in ?? 0) > 0 && (session.b.peer_in ?? 0) > 0)) {
          problems.push(`UDP delivered: ${session.b.peer_in} B nfxd → B, ${session.a.peer_in} B B → nfxd`);
        }
      }
      // After the cut, nothing from the origin reached B (only the relay and STUN from the
      // public namespace), and B took no byte over HTTP: what it played after the cut came
      // from A.
      if (afterCut !== null && (afterCut.b.origin_in ?? 0) !== 0) problems.push(`origin bytes reached B after the cut: ${afterCut.b.origin_in}`);
      if (atCut?.mesh && bEnd.mesh && bEnd.mesh.bytes.http !== atCut.mesh.bytes.http) {
        problems.push(`B took ${bEnd.mesh.bytes.http - atCut.mesh.bytes.http} B over HTTP after the cut`);
      }
      // srflx ↔ srflx, on the routers' public addresses, on both sides.
      if (pairsB.length === 0) problems.push('B has no connected peer connection to read a candidate pair from');
      if (a !== null && pairsA.length === 0) problems.push('A has no connected peer connection to read a candidate pair from');
      for (const p of pairsB) {
        if (!srflxOn(p.local, ROUTER_B) || !srflxOn(p.remote, ROUTER_A)) problems.push(`B's selected pair is not srflx ↔ srflx: ${JSON.stringify(p)}`);
      }
      for (const p of pairsA) {
        if (!srflxOn(p.local, ROUTER_A) || !srflxOn(p.remote, ROUTER_B)) problems.push(`A's selected pair is not srflx ↔ srflx: ${JSON.stringify(p)}`);
      }
    } else if (EXPECT === 'no-punch') {
      const ms = bEnd.mesh;
      if (recsB.length === 0) problems.push('no negotiation to fail');
      if (connected || outA.some((o) => o.kind === 'connected')) problems.push('a peer connection connected through two symmetric NATs');
      if (firstB !== null && firstB.kind !== 'ended') problems.push(`B's first negotiation had not ended after ${firstB.ms} ms`);
      for (const [i, o] of outB.entries()) {
        if (o.ms > FAIL_BOUND_MS) problems.push(`B's negotiation ${i} took ${o.ms} ms (${o.kind}), over the ${FAIL_BOUND_MS} ms bound`);
      }
      if ((ms?.peers ?? 0) !== 0 || (ms?.bytes.p2p ?? 0) !== 0) problems.push(`B has mesh peers or bytes: ${JSON.stringify(ms)}`);
      if (!((ms?.bytes.http ?? 0) > 0)) problems.push('B took nothing from the origin');
      if (!(bEnd.t >= 30)) problems.push(`B played only to ${bEnd.t} s`);
      if ((session.b.peer_in ?? 0) !== 0) problems.push(`router B delivered ${session.b.peer_in} B of UDP from router A`);
      if ((session.a.peer_in ?? 0) !== 0) problems.push(`router A delivered ${session.a.peer_in} B of UDP from router B`);
      // Both tried: each side's checks reached the other's NAT, and it refused them.
      if (!((session.a.peer_refused ?? 0) > 0 && (session.b.peer_refused ?? 0) > 0)) {
        problems.push(`no punch attempt reached both NATs: refused ${session.a.peer_refused} at A, ${session.b.peer_refused} at B`);
      }
    } else {
      if (!(bEnd.t >= 30)) problems.push(`B played only to ${bEnd.t} s`);
    }

    // ---- what the relay carried ----
    await sleep(500);
    const { problems: relayIssues, counts } = relayProblems(watch.events);
    result.relay_carried = counts;
    problems.push(...relayIssues.slice(0, 20));
    if (!((counts['25050/connect'] ?? 0) > 0)) problems.push('no presence went through the relay');
    if (recsB.length > 0 && !((counts['25050/offer'] ?? 0) > 0 && (counts['25050/answer'] ?? 0) > 0)) {
      problems.push('a negotiation ran with no offer and answer through the relay');
    }
  } catch (e) {
    problems.push(`harness: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const v of viewers) {
      diag[v.name] = { log: await pageLog(v.page), console: v.console, sockets: v.sockets };
      await v.browser.close().catch(() => {});
    }
    watch.close();
    closeFront();
  }
  diag.relay = relayProblems(watch.events).counts;
  result.problems = problems;
  result.passed = problems.length === 0;
  writeFileSync(join(OUT, `${CELL}.json`), `${JSON.stringify(result, null, 1)}\n`);
  writeFileSync(join(OUT, `${CELL}-diag.json`), `${JSON.stringify(diag, null, 1)}\n`);
  console.log(`NAT_RESULT ${JSON.stringify(result)}`);
  return result.passed ? 0 : 1;
}

main().then(
  (rc) => process.exit(rc),
  (e: unknown) => {
    console.error(`nat driver: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(2);
  },
);
