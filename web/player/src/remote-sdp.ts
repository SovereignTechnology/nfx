/**
 * The remote candidate filter (`remoteCandidates`, ./api.ts): a peer's SDP, cut to the ICE
 * candidates this session's ICE agent may try, before `setRemoteDescription` sees it. Pure:
 * no network, no WASM, no DOM, so a consumer can test it as it is.
 *
 * The SDP comes from a stranger, and the browser's own SDP parser reads it after this does,
 * so the two must not disagree about what a candidate is. This reads strictly and drops
 * whatever it is not sure of:
 *
 * - every piece of the SDP that any common reader could take for a line (split at CRLF, LF
 *   or a bare CR) that starts `a=candidate` in any letter case once spaces and control
 *   characters are taken out is a candidate line;
 * - a candidate line is kept only in the exact form RFC 8839 §5.1 gives, as browsers write
 *   it: `a=candidate:<foundation> <component> udp <priority> <address> <port> typ <type>`,
 *   then name-value pairs, fields separated by one space, every field printable ASCII;
 *   `<address>` a canonical IP literal that is global unicast (`globalUnicast`, rule `ice`),
 *   so never a name (mDNS or otherwise: the agent would resolve it), and `<port>` 1-65535;
 *   `raddr` and `rport`, when present, an IP literal and a port (they are never checked
 *   against, only reported);
 * - at most `MAX_REMOTE_CANDIDATES` are kept, the first in SDP order;
 * - every other line, and every line ending, is kept byte for byte.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { RemoteCandidates } from './api';
import { globalUnicast, ipFamily } from './endpoints';

/** Most candidates `global` keeps from one SDP. */
export const MAX_REMOTE_CANDIDATES = 16;

/** A filtered SDP, and how many candidate lines it kept and dropped. */
export interface FilteredSdp {
  sdp: string;
  kept: number;
  dropped: number;
}

/** Whether any reader might take `line` for a candidate attribute, however lenient. */
function candidateLike(line: string): boolean {
  return /^a=candidate/i.test(line.replace(/[^\x21-\x7e]+/g, ''));
}
const FIELD = /^[\x21-\x7e]+$/;
const TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);

function port(s: string | undefined, min: number): boolean {
  if (s === undefined || !/^(0|[1-9]\d{0,4})$/.test(s)) return false;
  const n = Number(s);
  return n >= min && n <= 65535;
}

/** Whether a candidate line (`a=candidate:…`, no line ending) is one `global` keeps. */
function keepsCandidate(line: string): boolean {
  const prefix = 'a=candidate:';
  if (!line.startsWith(prefix)) return false;
  const f = line.slice(prefix.length).split(' ');
  if (f.length < 8 || !f.every((x) => FIELD.test(x))) return false;
  const [foundation, component, transport, priority, address, p, typ, type] = f as [string, string, string, string, string, string, string, string];
  if (!/^[A-Za-z0-9+/]{1,32}$/.test(foundation)) return false;
  if (!/^[1-9]\d{0,2}$/.test(component) || Number(component) > 256) return false;
  if (transport.toLowerCase() !== 'udp') return false;
  if (!/^(0|[1-9]\d{0,9})$/.test(priority) || Number(priority) > 0xffffffff) return false;
  if (!globalUnicast(address, 'ice') || !port(p, 1)) return false;
  if (typ !== 'typ' || !TYPES.has(type)) return false;
  const rest = f.slice(8);
  if (rest.length % 2 !== 0) return false;
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i], rest[i + 1]];
    if (name === 'raddr' && ipFamily(value ?? '') === null) return false;
    if (name === 'rport' && !port(value, 0)) return false;
  }
  return true;
}

/** `filterRemoteSdp`, with the counts of candidate lines kept and dropped (both 0 for `all`). */
export function filterRemoteSdpCounted(sdp: string, mode: RemoteCandidates): FilteredSdp {
  if (typeof sdp !== 'string') throw new TypeError('nfx: the SDP must be a string');
  if (mode === 'all') return { sdp, kept: 0, dropped: 0 };
  if (mode !== 'global') throw new TypeError(`nfx: remoteCandidates must be 'all' or 'global'`);
  // [line, ending, line, ending, …, line]: what is dropped is a line and its ending.
  const parts = sdp.split(/(\r\n|\n|\r)/);
  let out = '';
  let kept = 0;
  let dropped = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';
    const ending = parts[i + 1] ?? '';
    if (candidateLike(line)) {
      if (kept < MAX_REMOTE_CANDIDATES && keepsCandidate(line)) kept += 1;
      else {
        dropped += 1;
        continue;
      }
    }
    out += line + ending;
  }
  return { sdp: out, kept, dropped };
}

/**
 * A peer's SDP with only the candidates `mode` lets this session's ICE agent try
 * (`RemoteCandidates`): `all` returns it as it is; `global` keeps at most 16 UDP candidates
 * at global unicast addresses and every non-candidate line, byte for byte. Never throws for
 * an SDP left with no candidate; throws a `TypeError` for a mode other than these two.
 */
export function filterRemoteSdp(sdp: string, mode: RemoteCandidates): string {
  return filterRemoteSdpCounted(sdp, mode).sdp;
}

/**
 * The distinct IP addresses of the candidates in a peer's SDP that this session's ICE agent
 * will check, for the STUN fallback (NFX-10 §1): only lines in the strict form above, of a
 * media section (a candidate before the first `m=` line belongs to none), among the first
 * `MAX_REMOTE_CANDIDATES`. Whatever this is not sure of counts for nothing.
 */
export function candidateAddresses(sdp: string): string[] {
  const out: string[] = [];
  let media = false;
  let kept = 0;
  for (const line of sdp.split(/\r\n|\n|\r/)) {
    if (line.startsWith('m=')) media = true;
    if (!candidateLike(line) || kept >= MAX_REMOTE_CANDIDATES || !keepsCandidate(line)) continue;
    kept += 1;
    const address = line.split(' ')[4] ?? '';
    if (media && !out.includes(address)) out.push(address);
  }
  return out;
}

/** Whether a local SDP carries a server-reflexive candidate: some STUN server answered. */
export function hasServerReflexive(sdp: string): boolean {
  return sdp.split(/\r\n|\n|\r/).some((l) => /^a=candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ srflx(?: |$)/i.test(l));
}
