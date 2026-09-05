/** Runtime-agnostic base64 (RFC 4648, padded). `btoa` is not guaranteed on Bare. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const sym = (v: number): string => ALPHABET.charAt(v & 63);

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += sym(n >>> 18) + sym(n >>> 12) + sym(n >>> 6) + sym(n);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += sym(n >>> 18) + sym(n >>> 12) + '==';
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += sym(n >>> 18) + sym(n >>> 12) + sym(n >>> 6) + '=';
  }
  return out;
}

export function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64Encode(bytes)}`;
}
