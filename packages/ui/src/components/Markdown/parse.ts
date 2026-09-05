/**
 * Fixed markdown subset (build-plan §6.3): **bold**, *italic*, [links](https://…), bare
 * http(s) URLs, `nostr:` URIs, paragraphs and line breaks. Everything else — including any
 * HTML — is literal text. The parser produces a token tree; `Markdown.tsx` renders it as
 * React elements, so there is no HTML string at any point and nothing to sanitise.
 *
 * Links are only ever `http:`/`https:` (anything else stays text) or `nostr:` (rendered as
 * a profile-chip slot, never as an `<a href="nostr:…">` unless the caller opts in).
 */

export type InlineToken =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'strong'; readonly children: readonly InlineToken[] }
  | { readonly type: 'em'; readonly children: readonly InlineToken[] }
  | { readonly type: 'link'; readonly href: string; readonly children: readonly InlineToken[] }
  | {
      readonly type: 'nostr';
      /** Full URI, e.g. `nostr:npub1…`. */
      readonly uri: string;
      /** bech32 prefix: `npub`, `nprofile`, `note`, `nevent`, `naddr`. */
      readonly entity: NostrEntity;
      /** Everything after `nostr:`. */
      readonly bech32: string;
      /** Optional link text from `[text](nostr:…)`. */
      readonly label?: string;
    }
  | { readonly type: 'br' };

export type NostrEntity = 'npub' | 'nprofile' | 'note' | 'nevent' | 'naddr';

export interface Paragraph {
  readonly type: 'paragraph';
  readonly children: readonly InlineToken[];
}

export type MarkdownTree = readonly Paragraph[];

/** Upper bound on parsed input; longer text is cut (with an ellipsis) before parsing. */
export const MARKDOWN_MAX_CHARS = 20_000;

const NOSTR_ENTITIES: readonly NostrEntity[] = ['npub', 'nprofile', 'note', 'nevent', 'naddr'];
const BECH32_RE = /^(npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]{6,}/;
const URL_RE = /^https?:\/\/[^\s<>()[\]{}"'`]+/i;
const TRAILING_PUNCT_RE = /[.,;:!?'"’)]+$/;

/** True for a link target the subset permits: absolute http(s). */
export function isSafeHttpUrl(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    const u = new URL(href);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0;
  } catch {
    return false;
  }
}

function nostrToken(uri: string, label?: string): InlineToken | undefined {
  if (!uri.toLowerCase().startsWith('nostr:')) return undefined;
  const bech32 = uri.slice(6);
  const m = BECH32_RE.exec(bech32);
  if (m?.[0] !== bech32) return undefined;
  const entity = m[1] as NostrEntity;
  if (!NOSTR_ENTITIES.includes(entity)) return undefined;
  return label === undefined
    ? { type: 'nostr', uri: `nostr:${bech32}`, entity, bech32 }
    : { type: 'nostr', uri: `nostr:${bech32}`, entity, bech32, label };
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

/** Finds `close` at or after `from`, requiring a non-space char right before it. */
function findClose(s: string, close: string, from: number): number {
  let i = s.indexOf(close, from);
  while (i !== -1) {
    const before = s[i - 1];
    if (before !== undefined && !/\s/.test(before)) return i;
    i = s.indexOf(close, i + 1);
  }
  return -1;
}

type Push = (t: InlineToken) => void;

function makeSink(out: InlineToken[]): { push: Push; text: (v: string) => void } {
  return {
    push: (t) => out.push(t),
    text: (v) => {
      if (v.length === 0) return;
      const last = out[out.length - 1];
      if (last?.type === 'text') out[out.length - 1] = { type: 'text', value: last.value + v };
      else out.push({ type: 'text', value: v });
    },
  };
}

/** Parses inline markdown into tokens. Safe on any input; never throws. */
export function parseInline(src: string): InlineToken[] {
  const out: InlineToken[] = [];
  const sink = makeSink(out);
  let i = 0;
  const n = src.length;
  let buf = '';
  const flush = (): void => {
    sink.text(buf);
    buf = '';
  };

  while (i < n) {
    const c = src[i] ?? '';
    const next = src[i + 1];
    const prev = src[i - 1];

    // line break
    if (c === '\n') {
      flush();
      sink.push({ type: 'br' });
      i += 1;
      continue;
    }

    // strong: ** or __
    if ((c === '*' || c === '_') && next === c) {
      const delim = c + c;
      const openOk = c === '*' || !isWordChar(prev);
      const inner0 = src[i + 2];
      if (openOk && inner0 !== undefined && !/\s/.test(inner0) && inner0 !== c) {
        let close = findClose(src, delim, i + 2);
        // `***x***` / `**a *b***`: a run of three closers is `*` + `**`; keep the em inside.
        if (close !== -1 && src[close + 2] === c && src[close + 3] !== c) close += 1;
        if (close !== -1 && (c === '*' || !isWordChar(src[close + 2]))) {
          flush();
          sink.push({ type: 'strong', children: parseInline(src.slice(i + 2, close)) });
          i = close + 2;
          continue;
        }
      }
      buf += delim;
      i += 2;
      continue;
    }

    // em: * or _
    if (c === '*' || c === '_') {
      const openOk = c === '*' || !isWordChar(prev);
      if (openOk && next !== undefined && !/\s/.test(next) && next !== c) {
        const close = findClose(src, c, i + 1);
        if (
          close !== -1 &&
          src[close + 1] !== c &&
          (c === '*' || !isWordChar(src[close + 1])) &&
          !src.slice(i + 1, close).includes('\n')
        ) {
          flush();
          sink.push({ type: 'em', children: parseInline(src.slice(i + 1, close)) });
          i = close + 1;
          continue;
        }
      }
      buf += c;
      i += 1;
      continue;
    }

    // [text](target)
    if (c === '[') {
      const closeBracket = src.indexOf(']', i + 1);
      if (closeBracket !== -1 && src[closeBracket + 1] === '(') {
        const closeParen = src.indexOf(')', closeBracket + 2);
        const target = closeParen === -1 ? '' : src.slice(closeBracket + 2, closeParen).trim();
        const label = src.slice(i + 1, closeBracket);
        if (closeParen !== -1 && target.length > 0 && !/\s/.test(target) && label.length > 0) {
          const nostr = nostrToken(target, label);
          if (nostr) {
            flush();
            sink.push(nostr);
            i = closeParen + 1;
            continue;
          }
          if (isSafeHttpUrl(target)) {
            flush();
            sink.push({ type: 'link', href: target, children: parseInline(label) });
            i = closeParen + 1;
            continue;
          }
        }
      }
      buf += c;
      i += 1;
      continue;
    }

    // bare URL
    if ((c === 'h' || c === 'H') && !isWordChar(prev)) {
      const m = URL_RE.exec(src.slice(i));
      if (m) {
        let url = m[0];
        // drop trailing punctuation that is almost certainly prose, keep balanced parens
        const trimmed = url.replace(TRAILING_PUNCT_RE, '');
        url = trimmed.length > 0 ? trimmed : url;
        if (isSafeHttpUrl(url)) {
          flush();
          sink.push({ type: 'link', href: url, children: [{ type: 'text', value: url }] });
          i += url.length;
          continue;
        }
      }
    }

    // nostr: URI
    if (
      (c === 'n' || c === 'N') &&
      !isWordChar(prev) &&
      src.slice(i, i + 6).toLowerCase() === 'nostr:'
    ) {
      const m = BECH32_RE.exec(src.slice(i + 6));
      if (m) {
        const tok = nostrToken(`nostr:${m[0]}`);
        if (tok) {
          flush();
          sink.push(tok);
          i += 6 + m[0].length;
          continue;
        }
      }
    }

    buf += c;
    i += 1;
  }
  flush();
  return out;
}

/** Splits on blank lines into paragraphs; trailing/leading whitespace per paragraph trimmed. */
export function parseMarkdown(src: string, maxChars: number = MARKDOWN_MAX_CHARS): MarkdownTree {
  const text = src.length > maxChars ? `${src.slice(0, maxChars)}…` : src;
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim().length > 0);
  return paragraphs.map((p) => ({ type: 'paragraph', children: parseInline(p) }));
}

/** Plain-text projection of a tree (for previews, `title` attributes, tests). */
export function toPlainText(tree: MarkdownTree): string {
  const inline = (tokens: readonly InlineToken[]): string =>
    tokens
      .map((t) => {
        switch (t.type) {
          case 'text':
            return t.value;
          case 'strong':
          case 'em':
          case 'link':
            return inline(t.children);
          case 'nostr':
            return t.label ?? t.uri;
          case 'br':
            return '\n';
        }
      })
      .join('');
  return tree.map((p) => inline(p.children)).join('\n\n');
}
