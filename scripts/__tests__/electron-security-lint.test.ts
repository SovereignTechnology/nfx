import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtures, repoRoot, runNode } from './helpers.js';

const electron = join(fixtures, 'electron');

describe('scripts/electron-security-lint.mjs', () => {
  it('passes the compliant fixture tree', () => {
    const r = runNode('electron-security-lint.mjs', [join(electron, 'pass')]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(
      /OK — 3 file\(s\), 2 window constructor\(s\), 2 webPreferences object\(s\), 0 violations/,
    );
  });

  it('fails the non-compliant fixture tree with one finding per rule', () => {
    const r = runNode('electron-security-lint.mjs', [join(electron, 'fail')]);
    expect(r.status).toBe(1);
    const lines = r.stdout.trim().split('\n');
    const has = (re: RegExp): boolean => lines.some((l) => re.test(l));
    // required keys
    expect(
      has(
        /insecure\.js:6: webPreferences\.contextIsolation must be the literal true, found `false`/,
      ),
    ).toBe(true);
    expect(
      has(
        /insecure\.js:6: webPreferences\.nodeIntegration must be the literal false, found `true`/,
      ),
    ).toBe(true);
    expect(
      has(/insecure\.js:6: webPreferences\.sandbox must be the literal true, found `false`/),
    ).toBe(true);
    // forbidden values
    expect(has(/insecure\.js:6: webPreferences\.webSecurity: false is forbidden/)).toBe(true);
    expect(
      has(/insecure\.js:6: webPreferences\.allowRunningInsecureContent: true is forbidden/),
    ).toBe(true);
    expect(has(/insecure\.js:6: webPreferences\.nodeIntegrationInWorker: true is forbidden/)).toBe(
      true,
    );
    expect(
      has(/insecure\.js:6: webPreferences\.nodeIntegrationInSubFrames: true is forbidden/),
    ).toBe(true);
    expect(has(/insecure\.js:6: webPreferences\.experimentalFeatures: true is forbidden/)).toBe(
      true,
    );
    expect(has(/insecure\.js:6: webPreferences\.webviewTag: true is forbidden/)).toBe(true);
    expect(has(/insecure\.js:6: webPreferences\.enableRemoteModule is forbidden/)).toBe(true);
    expect(has(/insecure\.js:3: @electron\/remote is forbidden/)).toBe(true);
    // structural
    expect(has(/missing\.ts:3: new BrowserWindow\(\{…\}\) has no webPreferences/)).toBe(true);
    expect(has(/partial\.ts:6: webPreferences uses a spread/)).toBe(true);
    expect(
      has(
        /partial\.ts:6: webPreferences\.contextIsolation must be the literal true, found `isolate`/,
      ),
    ).toBe(true);
    expect(has(/partial\.ts:6: webPreferences is missing nodeIntegration: false/)).toBe(true);
    expect(has(/partial\.ts:6: webPreferences is missing sandbox: true/)).toBe(true);
    expect(has(/variable\.ts:4: webPreferences is not an object literal \(prefs\)/)).toBe(true);
    expect(lines).toHaveLength(17);
    expect(r.stderr).toMatch(/FAIL — 17 violation\(s\) in 4 file\(s\)/);
  });

  it('a single compliant file is enough; a single bad file fails', () => {
    expect(runNode('electron-security-lint.mjs', [join(electron, 'pass', 'main.ts')]).status).toBe(
      0,
    );
    expect(
      runNode('electron-security-lint.mjs', [join(electron, 'fail', 'missing.ts')]).status,
    ).toBe(1);
  });

  it('packages/app-desktop/src passes today (no Electron code yet) and reports zero windows', () => {
    const r = runNode('electron-security-lint.mjs', [
      join(repoRoot, 'packages', 'app-desktop', 'src'),
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/0 window constructor\(s\)/);
  });

  it('usage errors exit 2', () => {
    expect(runNode('electron-security-lint.mjs', []).status).toBe(2);
    expect(runNode('electron-security-lint.mjs', [join(electron, 'nope')]).status).toBe(2);
    expect(runNode('electron-security-lint.mjs', ['--wat', join(electron, 'pass')]).status).toBe(2);
  });
});
