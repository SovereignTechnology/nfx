#!/usr/bin/env node
// Build-plan §7 / threat T15: "Electron renderer: contextIsolation: true, nodeIntegration:
// false, sandbox: true, preload exposes only the NetworkAdapter methods."
//
// Scans a source tree for `new BrowserWindow(` / `new BrowserView(` / `new WebContentsView(`
// and every `webPreferences: { … }` object literal, and FAILS unless each webPreferences
// explicitly sets
//     contextIsolation: true
//     nodeIntegration: false
//     sandbox: true
// and FAILS on any of
//     webSecurity: false
//     allowRunningInsecureContent: true
//     enableRemoteModule (any value)        nodeIntegrationInWorker: true
//     nodeIntegrationInSubFrames: true      experimentalFeatures: true
//     webviewTag: true                      import/require of @electron/remote
// A window constructed with no inline webPreferences in a file that has none at all is a
// failure too: Electron's defaults happen to be safe today, but the plan wants the posture
// written down where a reviewer can see it.
//
// Deliberately a text scanner, not a parser: it must run with zero dependencies from
// `npm run ci`, and a webPreferences object is a flat literal in every sane codebase. A
// value that is not a literal `true`/`false` (a variable, a spread) is reported as a
// failure rather than guessed at.
//
// Usage: node scripts/electron-security-lint.mjs <dir-or-file> [more…] [--quiet]
//   exit 0: no violations   exit 1: violations   exit 2: usage error
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'build', 'out']);

const REQUIRED = { contextIsolation: 'true', nodeIntegration: 'false', sandbox: 'true' };
const FORBIDDEN_VALUE = {
  webSecurity: 'false',
  allowRunningInsecureContent: 'true',
  nodeIntegrationInWorker: 'true',
  nodeIntegrationInSubFrames: 'true',
  experimentalFeatures: 'true',
  webviewTag: 'true',
};
const FORBIDDEN_KEY = ['enableRemoteModule'];
const CTORS = ['BrowserWindow', 'BrowserView', 'WebContentsView'];

export function* sourceFiles(root) {
  const st = statSync(root);
  if (st.isFile()) {
    if (EXTS.has(extname(root))) yield root;
    return;
  }
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* sourceFiles(p);
    } else if (EXTS.has(extname(e.name))) {
      yield p;
    }
  }
}

/** Strip // and /* comments and string contents (keeps length/newlines so offsets hold). */
function blank(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += ' ';
          i++;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += q;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index of the `}` matching the `{` at `open` in blanked source, or -1. */
function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;

/** Top-level `key: value` pairs of an object literal body (nested objects are opaque). */
function topLevelPairs(body) {
  const pairs = [];
  let depth = 0;
  let cur = '';
  const flush = () => {
    const m = /^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*?)\s*$/.exec(cur);
    if (m) pairs.push({ key: m[1] ?? m[2] ?? m[3], value: m[4] });
    else if (/^\s*\.\.\./.test(cur)) pairs.push({ key: '...', value: cur.trim() });
    else if (/^\s*([A-Za-z_$][\w$]*)\s*$/.test(cur))
      pairs.push({ key: cur.trim(), value: cur.trim() }); // shorthand
    cur = '';
  };
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) flush();
    else cur += ch;
  }
  if (cur.trim()) flush();
  return pairs;
}

function checkWebPreferences(file, src, blanked, open, findings) {
  const close = matchBrace(blanked, open);
  const line = lineOf(src, open);
  if (close === -1) {
    findings.push(`${file}:${line}: unbalanced webPreferences object`);
    return;
  }
  const pairs = topLevelPairs(blanked.slice(open + 1, close));
  const byKey = new Map(pairs.map((p) => [p.key, p.value]));
  if (byKey.has('...')) {
    findings.push(
      `${file}:${line}: webPreferences uses a spread (${byKey.get('...')}); values must be literal so a reviewer can read them`,
    );
  }
  for (const [key, want] of Object.entries(REQUIRED)) {
    if (!byKey.has(key))
      findings.push(`${file}:${line}: webPreferences is missing ${key}: ${want}`);
    else if (byKey.get(key) !== want)
      findings.push(
        `${file}:${line}: webPreferences.${key} must be the literal ${want}, found \`${byKey.get(key)}\``,
      );
  }
  for (const [key, bad] of Object.entries(FORBIDDEN_VALUE)) {
    if (byKey.has(key) && byKey.get(key) === bad)
      findings.push(`${file}:${line}: webPreferences.${key}: ${bad} is forbidden`);
    else if (byKey.has(key) && !/^(true|false)$/.test(byKey.get(key))) {
      findings.push(
        `${file}:${line}: webPreferences.${key} must be a literal boolean, found \`${byKey.get(key)}\``,
      );
    }
  }
  for (const key of FORBIDDEN_KEY) {
    if (byKey.has(key))
      findings.push(
        `${file}:${line}: webPreferences.${key} is forbidden (remote module is removed; use contextBridge)`,
      );
  }
}

/** @returns {{ findings: string[], windows: number, webPreferences: number }} */
export function lintSource(file, src) {
  const findings = [];
  const blanked = blank(src);
  let windows = 0;
  let webPreferences = 0;

  // every webPreferences object literal
  const wpRe = /\bwebPreferences\s*:\s*\{/g;
  let m;
  while ((m = wpRe.exec(blanked)) !== null) {
    webPreferences++;
    checkWebPreferences(file, src, blanked, m.index + m[0].length - 1, findings);
  }
  // webPreferences: identifier / spread → not reviewable
  const wpNonLiteral = /\bwebPreferences\s*:\s*(?!\{)([A-Za-z_$][\w$.]*)/g;
  while ((m = wpNonLiteral.exec(blanked)) !== null) {
    webPreferences++;
    findings.push(
      `${file}:${lineOf(src, m.index)}: webPreferences is not an object literal (${m[1]}); write the posture inline`,
    );
  }

  // constructors
  const ctorRe = new RegExp(`\\bnew\\s+(?:electron\\.)?(${CTORS.join('|')})\\s*\\(`, 'g');
  while ((m = ctorRe.exec(blanked)) !== null) {
    windows++;
    const argStart = m.index + m[0].length;
    const objOpen = blanked.indexOf('{', argStart);
    const parenClose = blanked.indexOf(')', argStart);
    const line = lineOf(src, m.index);
    // object literal as the argument?
    if (objOpen !== -1 && (parenClose === -1 || objOpen < parenClose)) {
      const objClose = matchBrace(blanked, objOpen);
      const body = objClose === -1 ? '' : blanked.slice(objOpen, objClose + 1);
      if (!/\bwebPreferences\s*:/.test(body)) {
        findings.push(
          `${file}:${line}: new ${m[1]}({…}) has no webPreferences; set contextIsolation/nodeIntegration/sandbox explicitly`,
        );
      }
    } else if (webPreferences === 0) {
      findings.push(
        `${file}:${line}: new ${m[1]}(…) with no webPreferences object anywhere in this file`,
      );
    }
  }

  if (/@electron\/remote/.test(src)) {
    findings.push(
      `${file}:${lineOf(src, src.indexOf('@electron/remote'))}: @electron/remote is forbidden (use contextBridge + ipc)`,
    );
  }
  if (/<webview\b/i.test(blanked)) {
    findings.push(
      `${file}:${lineOf(src, blanked.search(/<webview\b/i))}: <webview> tag is forbidden`,
    );
  }
  return { findings, windows, webPreferences };
}

export function lintPaths(paths) {
  const findings = [];
  let files = 0;
  let windows = 0;
  let webPreferences = 0;
  for (const root of paths) {
    for (const file of sourceFiles(root)) {
      files++;
      const rel = relative(process.cwd(), file) || file;
      const r = lintSource(rel, readFileSync(file, 'utf8'));
      findings.push(...r.findings);
      windows += r.windows;
      webPreferences += r.webPreferences;
    }
  }
  return { findings, files, windows, webPreferences };
}

function main(argv) {
  const paths = [];
  let quiet = false;
  for (const a of argv) {
    if (a === '--quiet') quiet = true;
    else if (a.startsWith('-')) {
      process.stderr.write(`unknown option ${a}\n`);
      return 2;
    } else paths.push(a);
  }
  if (paths.length === 0) {
    process.stderr.write('usage: electron-security-lint.mjs <dir-or-file> [more…] [--quiet]\n');
    return 2;
  }
  for (const p of paths) {
    if (!existsSync(p)) {
      process.stderr.write(`electron-security-lint: no such path: ${p}\n`);
      return 2;
    }
  }
  const r = lintPaths(paths);
  for (const f of r.findings) process.stdout.write(`${f}\n`);
  if (r.findings.length) {
    process.stderr.write(
      `electron-security-lint: FAIL — ${r.findings.length} violation(s) in ${r.files} file(s)\n`,
    );
    return 1;
  }
  if (!quiet) {
    process.stderr.write(
      `electron-security-lint: OK — ${r.files} file(s), ${r.windows} window constructor(s), ${r.webPreferences} webPreferences object(s), 0 violations\n`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
