/**
 * Log redaction (SECURITY.md invariant 7, threat T14). Every value that reaches a log sink
 * passes through `redact()` first. It scrubs:
 *
 *   - Cashu tokens (`cashuA…` / `cashuB…`) anywhere in a string
 *   - Nostr secret keys (`nsec1…`) anywhere in a string
 *   - 64-hex strings inside free text → truncated to 8 chars (a 32-byte value never leaves
 *     whole; pubkeys stay recognisable). Structured fields carrying a *public* identifier
 *     (`pubkey`, `peer`, `noiseKey`, `coreKey`, `sha256`, …) keep the full value.
 *   - structured fields whose NAME denotes a secret (`secret`, `C`, `dleq`, `witness`,
 *     `proofs`, `token`, `nsec`, `privateKey`, `seed`, `preimage`, …)
 *   - anything SHAPED like a Cashu proof (`{ amount, secret, C }`), a proof set
 *     (`{ proofs: [...] }`), or a NIP-60-style token object — the whole object is replaced
 *
 * Pure, dependency-free, no crypto. Deliberately over-eager: a false positive costs a
 * debugging hint, a false negative costs a wallet.
 */

export const REDACTED = '[REDACTED]' as const;

const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'c',
  'dleq',
  'witness',
  'proof',
  'proofs',
  'token',
  'tokens',
  'cashutoken',
  'nsec',
  'privkey',
  'privatekey',
  'secretkey',
  'seckey',
  'seed',
  'mnemonic',
  'preimage',
  'password',
  'passphrase',
  'apikey',
  'authorization',
  'cookie',
  'sessionkey',
  'encryptionkey',
  'keypair',
]);

/** Field names that legitimately hold a full 32-byte public identifier. */
const PUBLIC_ID_FIELD_NAMES: ReadonlySet<string> = new Set([
  'pubkey',
  'peer',
  'nostrpubkey',
  'noisekey',
  'noisekeyhex',
  'remotepublickey',
  'publickey',
  'corekey',
  'core',
  'discoverykey',
  'sha256',
  'hash',
  'id',
  'eventid',
  'topic',
]);

const CASHU_TOKEN_RE = /cashu[A-Z][A-Za-z0-9_\-+/=]{4,}/g;
const NSEC_RE = /nsec1[a-z0-9]{6,}/g;
const HEX32_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const HEX_LONG_RE = /(?<![0-9a-fA-F])[0-9a-fA-F]{65,}(?![0-9a-fA-F])/g;
const MAX_DEPTH = 8;

function normaliseKey(k: string): string {
  return k.replace(/[_\-\s]/g, '').toLowerCase();
}

/** Scrub secrets embedded in free text. */
export function redactString(s: string): string {
  return s
    .replace(CASHU_TOKEN_RE, '[REDACTED:cashu-token]')
    .replace(NSEC_RE, '[REDACTED:nsec]')
    .replace(HEX_LONG_RE, (m) => `${m.slice(0, 8)}…[REDACTED:${m.length}hex]`)
    .replace(HEX32_RE, (m) => `${m.slice(0, 8)}…`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** `{ amount, secret, C }` = a Cashu proof, whatever else it carries. */
function looksLikeProof(o: Record<string, unknown>): boolean {
  return 'secret' in o && 'C' in o && ('amount' in o || 'id' in o);
}

/** `{ proofs: [...] }` = a proof set / token entry (LockedProofSet, NUT-00 token, NIP-60 7375). */
function looksLikeProofSet(o: Record<string, unknown>): boolean {
  return Array.isArray(o['proofs']) || (Array.isArray(o['token']) && 'unit' in o);
}

function redactValue(v: unknown, keyHint: string | null, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[REDACTED:depth]';
  if (typeof v === 'string') {
    if (keyHint !== null && PUBLIC_ID_FIELD_NAMES.has(keyHint) && /^[0-9a-f]{64}$/i.test(v))
      return v;
    return redactString(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function' || typeof v === 'symbol') return `[${typeof v}]`;
  if (v instanceof Uint8Array) return `[bytes:${v.byteLength}]`;
  if (v instanceof Error) {
    return {
      name: v.name,
      message: redactString(v.message),
      ...(v.stack !== undefined ? { stack: redactString(v.stack) } : {}),
    };
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, null, depth + 1));
  if (v instanceof Map) return redactValue(Object.fromEntries(v), keyHint, depth);
  if (v instanceof Set) return redactValue([...v], keyHint, depth);
  if (isRecord(v)) {
    if (looksLikeProof(v)) return '[REDACTED:proof]';
    if (looksLikeProofSet(v)) {
      const n = Array.isArray(v['proofs']) ? v['proofs'].length : undefined;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const nk = normaliseKey(k);
        if (nk === 'proofs' || nk === 'token') out[k] = `[REDACTED:${n ?? '?'} proofs]`;
        else if (SECRET_FIELD_NAMES.has(nk)) out[k] = REDACTED;
        else out[k] = redactValue(x, nk, depth + 1);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const nk = normaliseKey(k);
      out[k] = SECRET_FIELD_NAMES.has(nk) ? REDACTED : redactValue(x, nk, depth + 1);
    }
    return out;
  }
  return `[${typeof v}]`;
}

/** Deep-redact any value destined for a log line. Never throws. */
export function redact(v: unknown): unknown {
  try {
    return redactValue(v, null, 0);
  } catch {
    return '[REDACTED:unserialisable]';
  }
}
