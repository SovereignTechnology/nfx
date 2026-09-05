import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures, runNode, tempDir } from './helpers.js';

const sri = (file: string): string =>
  `sha384-${createHash('sha384').update(readFileSync(file)).digest('base64')}`;

describe('scripts/csp-sri.mjs', () => {
  let work: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ dir: work, cleanup } = tempDir('csp'));
    cpSync(join(fixtures, 'csp-sri'), work, { recursive: true });
  });
  afterEach(() => {
    cleanup();
  });

  it('rewrites script/link tags with integrity + crossorigin and injects the CSP meta', () => {
    const html = join(work, 'pass', 'index.html');
    const out = join(work, 'out.html');
    const headers = join(work, 'headers.txt');
    const r = runNode('csp-sri.mjs', [
      html,
      '--out',
      out,
      '--headers',
      headers,
      '--connect',
      'wss://gw.example',
    ]);
    expect(r.status, r.stderr).toBe(0);
    const result = readFileSync(out, 'utf8');
    const appJs = sri(join(work, 'pass', 'assets', 'app.js'));
    const appCss = sri(join(work, 'pass', 'assets', 'app.css'));
    const vendor = sri(join(work, 'pass', 'assets', 'vendor.js'));

    // query string kept, stale integrity replaced, bare `crossorigin` normalised
    expect(result).toContain(
      `<script type="module" src="assets/app.js?v=1" integrity="${appJs}" crossorigin="anonymous"></script>`,
    );
    expect(result).toContain(
      `<link rel="stylesheet" href="/assets/app.css" integrity="${appCss}" crossorigin="anonymous" />`,
    );
    expect(result).toContain(
      `<link rel="modulepreload" href="assets/vendor.js" integrity="${vendor}" crossorigin="anonymous">`,
    );
    expect(result).not.toContain('sha384-STALE');
    // the commented-out <script> is untouched and did not count as inline
    expect(result).toContain('<!-- a commented-out <script>alert(1)</script> must be ignored -->');

    // CSP meta is the first element in <head>
    const head = /<head>\s*<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(
      result,
    );
    expect(head).not.toBeNull();
    const csp = head![1]!;
    expect(csp).toMatch(/^default-src 'none'; /);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self' wss://gw.example");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('frame-ancestors'); // meta cannot carry it

    // headers file carries the same policy plus frame-ancestors and the companions
    const h = readFileSync(headers, 'utf8');
    expect(h).toContain(`Content-Security-Policy: ${csp}; frame-ancestors 'none'`);
    expect(h).toContain('X-Content-Type-Options: nosniff');
    expect(h).toContain('Referrer-Policy: no-referrer');
    expect(h).toContain('X-Frame-Options: DENY');
    expect(h).toContain('Cross-Origin-Opener-Policy: same-origin');
  });

  it('is idempotent and --check passes on an up-to-date output', () => {
    const html = join(work, 'pass', 'index.html');
    const out = join(work, 'out.html');
    const headers = join(work, 'headers.txt');
    expect(runNode('csp-sri.mjs', [html, '--out', out, '--headers', headers]).status).toBe(0);
    const first = readFileSync(out, 'utf8');
    // feed the rewritten file back in (assets resolve relative to the original dir)
    const out2 = join(work, 'out2.html');
    const r = runNode('csp-sri.mjs', [
      out,
      '--root',
      join(work, 'pass'),
      '--out',
      out2,
      '--headers',
      join(work, 'h2.txt'),
    ]);
    expect(r.status, r.stderr).toBe(1); // relative assets/app.js does not exist next to out.html
    // idempotence proper: rewrite in place inside the fixture dir
    const inplace = join(work, 'pass', 'index.html');
    expect(runNode('csp-sri.mjs', [inplace, '--headers', headers]).status).toBe(0);
    const second = readFileSync(inplace, 'utf8');
    expect(second).toBe(first);
    expect(runNode('csp-sri.mjs', [inplace, '--headers', headers]).status).toBe(0);
    expect(readFileSync(inplace, 'utf8')).toBe(first);
    // --check: up to date → 0
    expect(runNode('csp-sri.mjs', [inplace, '--headers', headers, '--check']).status).toBe(0);
    // --check: drift → 1
    writeFileSync(join(work, 'pass', 'assets', 'app.js'), 'console.log("changed")');
    const drift = runNode('csp-sri.mjs', [inplace, '--headers', headers, '--check']);
    expect(drift.status).toBe(1);
    expect(drift.stderr).toMatch(/not up to date/);
    expect(readFileSync(inplace, 'utf8')).toBe(first); // --check never writes
  });

  it('fails on inline script/style/handlers/javascript: URLs', () => {
    const r = runNode('csp-sri.mjs', [
      join(work, 'fail-inline', 'index.html'),
      '--out',
      join(work, 'x.html'),
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/inline <script> \(type=text\/javascript\)/);
    expect(r.stderr).toMatch(/inline <script> \(type=importmap\)/);
    expect(r.stderr).toMatch(/inline <style>/);
    expect(r.stderr).toMatch(/inline event handler onload=/);
    expect(r.stderr).toMatch(/javascript: URL on <a>/);
    expect(r.stderr).toMatch(/style attribute on <a>/);
    expect(existsSync(join(work, 'x.html'))).toBe(false);
  });

  it('fails on third-party and missing assets', () => {
    const r = runNode('csp-sri.mjs', [
      join(work, 'fail-foreign', 'index.html'),
      '--out',
      join(work, 'y.html'),
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(
      /link references another origin \(https:\/\/cdn\.example\.com\/x\.css\)/,
    );
    expect(r.stderr).toMatch(/script references another origin \(\/\/cdn\.example\.com\/y\.js\)/);
    expect(r.stderr).toMatch(/missing file missing\.js/);
  });

  it('usage errors exit 2', () => {
    expect(runNode('csp-sri.mjs', []).status).toBe(2);
    expect(runNode('csp-sri.mjs', [join(work, 'nope.html')]).status).toBe(2);
  });
});
