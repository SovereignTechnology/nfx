/**
 * Pure helpers for the Wallet screen: loose bolt11 shape checks, the BOLT11 QR payload, the
 * QR module → `<rect>` run table, poll back-off and error copy. No DOM, no network, no crypto:
 * an invoice is never decoded or verified here — the mint does that in `meltQuote`, and the
 * payer's own Lightning wallet shows the amount before paying.
 */
import type { Settings } from '@sovit/core';

/**
 * Loose BOLT11 shape: a network prefix — `lnbc` (mainnet), `lntb` (testnet/signet), `lnbcrt`
 * (regtest) — then bech32-ish alphanumerics. Case-insensitive. Deliberately NOT a decoder.
 */
export const BOLT11_SHAPE = /^(?:lnbcrt|lnbc|lntb)[0-9a-z]+$/i;

/** Anything shorter than this cannot be a real invoice (a pasted fragment, a typo). */
export const BOLT11_MIN_LENGTH = 20;

/**
 * Trims, drops an optional `lightning:` URI scheme and any whitespace a wrapped paste
 * carried, and lower-cases (bech32 is case-insensitive; lower is the canonical text form).
 */
export function normalizeInvoice(input: string): string {
  let s = input.trim();
  if (/^lightning:/i.test(s)) s = s.slice('lightning:'.length);
  return s.replace(/\s+/g, '').toLowerCase();
}

/** Loose shape check only (prefix + charset + minimum length). Never decodes. */
export function isLikelyBolt11(input: string): boolean {
  const s = normalizeInvoice(input);
  return s.length >= BOLT11_MIN_LENGTH && BOLT11_SHAPE.test(s);
}

/**
 * Sanity check on the MINT's answer to a mint quote (not user input): a Lightning network
 * prefix and printable ASCII with no spaces. Prefix-only on purpose — the mint encoded it and
 * the payer's wallet decodes it; this only catches an answer that is plainly not an invoice
 * (an error page, an empty string). `MockWallet`'s `lnbc…mockquote-1` passes; a hyphen can
 * never occur in real bech32, which is why user-pasted input gets the stricter `isLikelyBolt11`.
 */
export function looksLikeMintInvoice(bolt11: string): boolean {
  const s = normalizeInvoice(bolt11);
  return /^(?:lnbcrt|lnbc|lntb)[\x21-\x7e]+$/i.test(s);
}

/**
 * What the QR encodes: `LIGHTNING:<BOLT11>` upper-cased. BOLT11 / BIP21 convention: an
 * all-caps payload fits the QR alphanumeric mode (5.5 bits/char instead of 8), so the code
 * is a version or two smaller and easier to scan; wallets accept either case.
 */
export function invoiceQrPayload(bolt11: string): string {
  return `lightning:${normalizeInvoice(bolt11)}`.toUpperCase();
}

/** `lightning:` link target (lower case — what OS URI handlers expect). */
export function invoiceHref(bolt11: string): string {
  return `lightning:${normalizeInvoice(bolt11)}`;
}

/** First 12 + last 6 characters, for confirm copy: `lnbc15u1p3xy…k2f9qz`. */
export function shortInvoice(bolt11: string): string {
  const s = normalizeInvoice(bolt11);
  return s.length <= 22 ? s : `${s.slice(0, 12)}…${s.slice(-6)}`;
}

export interface QrRun {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/**
 * Horizontal runs of dark modules, row by row (`matrix[y][x]`, `true` = dark), so the SVG
 * draws one `<rect>` per run instead of one per module (~3× fewer nodes for an invoice).
 */
export function qrRuns(matrix: readonly (readonly boolean[])[]): QrRun[] {
  const runs: QrRun[] = [];
  matrix.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x++) {
      const dark = x < row.length && row[x] === true;
      if (dark && start < 0) start = x;
      else if (!dark && start >= 0) {
        runs.push({ x: start, y, w: x - start });
        start = -1;
      }
    }
  });
  return runs;
}

/** Quiet zone around the code, in modules (ISO/IEC 18004 asks for 4). */
export const QR_QUIET_ZONE = 4;

/** Default first poll delay and cap (ms). The screen accepts overrides for stories/tests. */
export const POLL_INITIAL_MS = 2000;
export const POLL_MAX_MS = 15_000;
/** Consecutive failed polls before the sheet stops and says the mint is unreachable. */
export const POLL_MAX_ERRORS = 3;

/**
 * Back-off between `pollQuote` calls: `initial` for the first (`prevMs` undefined), then ×1.5
 * per poll and never below 500 ms, capped at `max`. ~45 polls over a 10-minute invoice with
 * the defaults. (A `max` below 500 ms is honoured — that is for tests.)
 */
export function nextPollDelay(
  prevMs: number | undefined,
  initialMs: number,
  maxMs: number,
): number {
  const cap = Math.max(0, maxMs);
  if (prevMs === undefined) return Math.min(Math.max(0, initialMs), cap);
  return Math.min(cap, Math.max(500, Math.ceil(prevMs * 1.5)));
}

/** Seconds → `m:ss` / `h:mm:ss`, never negative. */
export function formatCountdown(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

/** Positive whole sats from a text field, or `undefined`. */
export function parseSats(text: string): number | undefined {
  const t = text.trim().replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export type AutoTopUp = NonNullable<Settings['autoTopUp']>;

/**
 * `Settings.autoTopUp` is optional, and under `exactOptionalPropertyTypes` a
 * `Partial<Settings>` patch cannot carry `autoTopUp: undefined` — nor would the key survive a
 * JSON hop to the gateway. So "off" is written as `belowSats: 0` ("top up below 0 sats" can
 * never trigger). See docs/contract-requests/L5-Wallet.md.
 */
export function isAutoTopUpOn(a: Settings['autoTopUp']): a is AutoTopUp {
  return a !== undefined && a.belowSats > 0;
}

/** Human copy for a failed wallet/adapter call. Never a stack trace (the shell logs those). */
export function describeWalletError(err: unknown): {
  readonly title: string;
  readonly description: string;
  readonly detail: string | undefined;
} {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/relay/i.test(message)) {
    return {
      title: 'Relay down',
      description:
        'None of your relays answered, and your wallet lives on them (NIP-60). Check your connection or your relay list in Settings, then retry.',
      detail: message,
    };
  }
  if (/no-signer|signer/i.test(message)) {
    return {
      title: 'Signer not available',
      description:
        'Your wallet is encrypted to your Nostr key. Connect or unlock your signer, then retry.',
      detail: message,
    };
  }
  if (/insufficient|not enough|no-balance/i.test(message)) {
    return {
      title: 'Not enough at this mint',
      description:
        'This mint does not hold enough of your sats for that. Add funds or pick another mint.',
      detail: message,
    };
  }
  if (/unreachable|network|fetch|timed? ?out|econn/i.test(message)) {
    return {
      title: 'Mint unreachable',
      description: 'The mint did not answer. Try again in a moment, or pick another mint.',
      detail: message,
    };
  }
  return {
    title: 'Something went wrong',
    description: 'We could not complete that. Try again in a moment.',
    detail: message || undefined,
  };
}
