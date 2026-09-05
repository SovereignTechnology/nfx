#!/usr/bin/env node
// Build-plan §7 / threats T13, T15: SRI on every script and stylesheet, strict CSP with no
// inline code and no third-party origins, identical for the web build and the Electron
// renderer.
//
// Rewrites an HTML file so that every `<script src>` and `<link rel=stylesheet|modulepreload>`
// carries `integrity="sha384-…"` (computed with node:crypto from the file on disk) and
// `crossorigin="anonymous"`, inserts a `<meta http-equiv="Content-Security-Policy">` as the
// first element of <head>, and writes the same policy plus companion hardening headers to
// a headers file for whatever serves the static tree.
//
// It FAILS (exit 1) on anything the policy would break at runtime, so the build cannot
// ship a page that only works with a weaker CSP:
//   - inline <script> (including importmap / JSON blocks), <style>, style="" attributes,
//     on*="" handlers, javascript: URLs
//   - script/stylesheet references to another origin (http(s)://, //, data:, blob:)
//   - referenced asset files that do not exist under --root
//
// Usage: node scripts/csp-sri.mjs <html> [options]
//   --root <dir>        directory that `/`-rooted asset paths resolve against (default: html's dir)
//   --out <file>        write the rewritten HTML here (default: overwrite in place)
//   --headers <file>    write the headers file here (default: <out dir>/_headers.txt)
//   --connect <origin>  extra connect-src origin, repeatable (gateway WS, relays)
//   --img <src>         extra img-src source, repeatable
//   --media <src>       extra media-src source, repeatable
//   --check             do not write anything; exit 1 if the file would change or violates
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Build the CSP directive list. Meta CSP ignores frame-ancestors/sandbox/report-*, so those
 *  are emitted only in the headers variant. */
export function buildCsp({ connect = [], img = [], media = [] } = {}) {
  const uniq = (xs) => [...new Set(xs)];
  const common = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src ${uniq(["'self'", 'blob:', ...img]).join(' ')}`,
    `media-src ${uniq(["'self'", 'blob:', ...media]).join(' ')}`,
    "font-src 'self'",
    `connect-src ${uniq(["'self'", ...connect]).join(' ')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "child-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    'upgrade-insecure-requests',
  ];
  return {
    meta: common.join('; '),
    header: [...common, "frame-ancestors 'none'"].join('; '),
  };
}

export function companionHeaders(csp) {
  return [
    `Content-Security-Policy: ${csp.header}`,
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
    'Referrer-Policy: no-referrer',
    'Cross-Origin-Opener-Policy: same-origin',
    'Cross-Origin-Resource-Policy: same-origin',
    'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Strict-Transport-Security: max-age=63072000; includeSubDomains',
    'Cache-Control: no-cache',
  ].join('\n');
}

export function sriDigest(buf) {
  return `sha384-${createHash('sha384').update(buf).digest('base64')}`;
}

/** Parse attributes of a single tag's inside (`<tag ...>` minus the angle brackets). */
function parseAttrs(inner) {
  const attrs = new Map();
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  // Skip the tag name.
  const rest = inner.replace(/^\s*[a-zA-Z][^\s/>]*/, '');
  let m;
  while ((m = re.exec(rest)) !== null) {
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function isForeign(url) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

/** Rebuild a tag with integrity/crossorigin set (replacing existing values). */
function withSri(tagText, integrity) {
  let t = tagText.replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  t = t.replace(/\s+crossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
  const selfClosing = /\/>$/.test(t);
  const body = t.slice(0, selfClosing ? -2 : -1).replace(/\s+$/, '');
  return `${body} integrity="${integrity}" crossorigin="anonymous"${selfClosing ? ' />' : '>'}`;
}

/**
 * @returns {{ html: string, headers: string, violations: string[], assets: {tag:string, path:string, integrity:string}[] }}
 */
export function processHtml(html, { root, htmlDir, csp }) {
  const violations = [];
  const assets = [];

  // Mask comments so nothing inside them is scanned or rewritten.
  const masked = html.replace(COMMENT_RE, (c) => ' '.repeat(c.length));

  // --- violations that no rewrite can fix -------------------------------------------
  const scriptBlockRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = scriptBlockRe.exec(masked)) !== null) {
    const attrs = parseAttrs(`script${m[1]}`);
    if (!attrs.has('src')) {
      violations.push(
        `inline <script> (type=${attrs.get('type') ?? 'text/javascript'}) at offset ${m.index}: CSP script-src 'self' forbids inline scripts`,
      );
    } else if (m[2].trim() !== '') {
      violations.push(`<script src> with inline body at offset ${m.index}`);
    }
  }
  const styleBlockRe = /<style\b[^>]*>/gi;
  while ((m = styleBlockRe.exec(masked)) !== null) {
    violations.push(
      `inline <style> at offset ${m.index}: CSP style-src 'self' forbids inline styles`,
    );
  }
  const tagRe = /<([a-zA-Z][^\s/>]*)\b([^>]*)>/g;
  while ((m = tagRe.exec(masked)) !== null) {
    const attrs = parseAttrs(m[0].slice(1, -1));
    for (const [k, v] of attrs) {
      if (k.startsWith('on'))
        violations.push(`inline event handler ${k}= on <${m[1]}> at offset ${m.index}`);
      if (k === 'style') violations.push(`style attribute on <${m[1]}> at offset ${m.index}`);
      if ((k === 'href' || k === 'src' || k === 'action') && /^\s*javascript:/i.test(v)) {
        violations.push(`javascript: URL on <${m[1]}> at offset ${m.index}`);
      }
    }
  }

  // --- SRI rewrite --------------------------------------------------------------------
  const sriTagRe = /<(script|link)\b([^>]*)>/gi;
  let out = '';
  let last = 0;
  while ((m = sriTagRe.exec(masked)) !== null) {
    const tagName = m[1].toLowerCase();
    const attrs = parseAttrs(m[0].slice(1, -1));
    let ref;
    if (tagName === 'script') {
      ref = attrs.get('src');
    } else {
      const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet') || rel.includes('modulepreload')) ref = attrs.get('href');
    }
    if (ref === undefined) continue;
    if (ref === '') {
      violations.push(`empty ${tagName} reference at offset ${m.index}`);
      continue;
    }
    if (isForeign(ref)) {
      violations.push(
        `${tagName} references another origin (${ref}) at offset ${m.index}: CSP allows 'self' only`,
      );
      continue;
    }
    const clean = ref.split(/[?#]/)[0];
    const file = clean.startsWith('/') ? join(root, clean) : join(htmlDir, clean);
    if (!existsSync(file)) {
      violations.push(`${tagName} references missing file ${ref} (resolved ${file})`);
      continue;
    }
    const integrity = sriDigest(readFileSync(file));
    assets.push({ tag: tagName, path: ref, integrity });
    const original = html.slice(m.index, m.index + m[0].length);
    out += html.slice(last, m.index) + withSri(original, integrity);
    last = m.index + m[0].length;
  }
  out += html.slice(last);

  // --- CSP meta -----------------------------------------------------------------------
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${csp.meta}">`;
  const existingMeta = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>\s*/gi;
  out = out.replace(existingMeta, '');
  const headOpen = /<head\b[^>]*>/i.exec(out);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    out = `${out.slice(0, at)}\n    ${metaTag}${out.slice(at)}`;
  } else {
    violations.push('no <head> element: cannot place the CSP <meta>');
  }

  return { html: out, headers: companionHeaders(csp) + '\n', violations, assets };
}

function parseArgs(argv) {
  const opts = { connect: [], img: [], media: [], check: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--root':
        opts.root = next();
        break;
      case '--out':
        opts.out = next();
        break;
      case '--headers':
        opts.headers = next();
        break;
      case '--connect':
        opts.connect.push(next());
        break;
      case '--img':
        opts.img.push(next());
        break;
      case '--media':
        opts.media.push(next());
        break;
      case '--check':
        opts.check = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        positional.push(a);
    }
  }
  if (positional.length !== 1) throw new Error('usage: csp-sri.mjs <html> [options]');
  opts.html = positional[0];
  return opts;
}

export function run(argv) {
  const opts = parseArgs(argv);
  const htmlPath = resolve(opts.html);
  if (!existsSync(htmlPath)) throw new Error(`no such file: ${htmlPath}`);
  const htmlDir = dirname(htmlPath);
  const root = resolve(opts.root ?? htmlDir);
  const outPath = resolve(opts.out ?? htmlPath);
  const headersPath = resolve(opts.headers ?? join(dirname(outPath), '_headers.txt'));
  const csp = buildCsp({ connect: opts.connect, img: opts.img, media: opts.media });
  const input = readFileSync(htmlPath, 'utf8');
  const result = processHtml(input, { root, htmlDir, csp });

  if (result.violations.length) {
    process.stderr.write(`csp-sri: ${result.violations.length} violation(s) in ${opts.html}:\n`);
    for (const v of result.violations) process.stderr.write(`  - ${v}\n`);
    return 1;
  }
  if (opts.check) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
    const currentHeaders = existsSync(headersPath) ? readFileSync(headersPath, 'utf8') : null;
    if (current !== result.html || currentHeaders !== result.headers) {
      process.stderr.write(`csp-sri: ${opts.html} is not up to date (rerun without --check)\n`);
      return 1;
    }
    process.stderr.write(`csp-sri: OK (${result.assets.length} assets pinned)\n`);
    return 0;
  }
  writeFileSync(outPath, result.html);
  writeFileSync(headersPath, result.headers);
  process.stderr.write(
    `csp-sri: pinned ${result.assets.length} asset(s), wrote ${outPath} and ${headersPath}\n`,
  );
  for (const a of result.assets) process.stderr.write(`  ${a.tag} ${a.path} ${a.integrity}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`csp-sri: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
