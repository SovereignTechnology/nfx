import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DARK,
  LIGHT,
  MOTION,
  SEMANTIC_COLOR_NAMES,
  SPACING,
  THEMES,
  colorVar,
  generateTokensCss,
} from '../tokens.js';
import { applyTheme, readThemeOverride, resolveTheme } from '../theme.js';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'tokens.css'), 'utf8');

/** Extracts the body of the first CSS block whose selector line contains `marker`. */
function block(marker: string): string {
  const start = css.indexOf(marker);
  expect(start, `block "${marker}" present`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block ${marker}`);
}

const COLOR_RE = /^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, (0|1|0?\.\d+)\))$/;

describe('semantic colour tokens', () => {
  it('both themes define every semantic token, and nothing else', () => {
    for (const theme of ['light', 'dark'] as const) {
      const keys = Object.keys(THEMES[theme]).sort();
      expect(keys).toEqual([...SEMANTIC_COLOR_NAMES].sort());
    }
  });

  it('every value is a plain hex or rgba colour (no references, no empties)', () => {
    for (const name of SEMANTIC_COLOR_NAMES) {
      expect(LIGHT[name], `light ${name}`).toMatch(COLOR_RE);
      expect(DARK[name], `dark ${name}`).toMatch(COLOR_RE);
    }
  });

  it('the light and dark palettes actually differ on the surfaces and text', () => {
    for (const name of ['bg', 'bg-subtle', 'text', 'text-secondary', 'text-link'] as const) {
      expect(LIGHT[name]).not.toBe(DARK[name]);
    }
  });

  it('tokens.css declares every semantic token in the light block, the dark media block and the data-theme override', () => {
    const light = block(':root {');
    const darkMedia = block('@media (prefers-color-scheme: dark)');
    const darkOverride = block(":root[data-theme='dark']");
    for (const name of SEMANTIC_COLOR_NAMES) {
      const decl = `${colorVar(name)}:`;
      expect(light, `light ${name}`).toContain(`${decl} ${LIGHT[name]};`);
      expect(darkMedia, `dark media ${name}`).toContain(`${decl} ${DARK[name]};`);
      expect(darkOverride, `dark override ${name}`).toContain(`${decl} ${DARK[name]};`);
    }
    expect(darkMedia).toContain(":root:not([data-theme='light'])");
    expect(light).toContain('color-scheme: light;');
    expect(darkOverride).toContain('color-scheme: dark;');
  });

  it('tokens.css is in sync with tokens.ts (run `npm run -w packages/ui build:tokens`)', () => {
    expect(css).toBe(generateTokensCss());
  });
});

describe('scales', () => {
  it('spacing is an 8-pt scale (every 8-pt major present, only 4 px half steps otherwise)', () => {
    const px = Object.values(SPACING).map((v) => Number.parseInt(v, 10));
    expect(px[0]).toBe(0);
    for (const v of px) expect(v % 4).toBe(0);
    for (const major of [8, 16, 24, 32, 40, 48, 64]) expect(px).toContain(major);
    expect(px.filter((v) => v % 8 !== 0)).toEqual([4, 12]);
  });

  it('motion never exceeds 200 ms and collapses to 0 under prefers-reduced-motion', () => {
    for (const v of [MOTION.fast, MOTION.base, MOTION.slow]) {
      expect(Number.parseInt(v, 10)).toBeLessThanOrEqual(200);
    }
    const reduced = block('@media (prefers-reduced-motion: reduce)');
    expect(reduced).toContain('--nf-motion-fast: 0ms;');
    expect(reduced).toContain('--nf-motion-base: 0ms;');
    expect(reduced).toContain('--nf-motion-slow: 0ms;');
  });

  it('exposes a focus-ring token and a focus-visible outline', () => {
    expect(css).toContain('--nf-focus-ring:');
    expect(css).toContain(':focus-visible {');
  });
});

describe('theme helpers', () => {
  it('resolveTheme follows the system only for `system`', () => {
    const dark = () => ({ matches: true });
    const light = () => ({ matches: false });
    expect(resolveTheme('system', dark)).toBe('dark');
    expect(resolveTheme('system', light)).toBe('light');
    expect(resolveTheme('light', dark)).toBe('light');
    expect(resolveTheme('dark', light)).toBe('dark');
    expect(resolveTheme('system', undefined)).toBe('light');
  });

  it('applyTheme pins or clears the data-theme attribute on the root', () => {
    const root = document.createElement('html');
    applyTheme('dark', root);
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(readThemeOverride(root)).toBe('dark');
    applyTheme('light', root);
    expect(readThemeOverride(root)).toBe('light');
    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(readThemeOverride(root)).toBeUndefined();
  });
});
