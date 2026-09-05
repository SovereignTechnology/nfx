/**
 * Design tokens — the single source of truth for `@sovit/ui` (build-plan §6.3).
 *
 * `tokens.css` is GENERATED from this file (`npm run -w packages/ui build:tokens`) and a
 * test fails if the two drift. Every value below is a default L4 chose against the design
 * brief (YouTube first, Rumble second, clean and mainstream); the rationale for each group
 * is recorded in `docs/lanes/L4.md` so sovtech can react to PNGs rather than JSX.
 *
 * Naming: every custom property is `--nf-<group>-<name>`. Semantic colours exist in BOTH
 * themes with identical keys (enforced by the type below and by a test).
 */

/** 8-pt spacing scale (with a 4 px half step). Keys are the pixel value. */
export const SPACING = {
  0: '0px',
  4: '4px',
  8: '8px',
  12: '12px',
  16: '16px',
  24: '24px',
  32: '32px',
  40: '40px',
  48: '48px',
  64: '64px',
} as const;
export type SpacingStep = keyof typeof SPACING;

/** One type scale: size / line-height pairs. `md` is the body default (YouTube: 14–16 px). */
export const TYPE_SCALE = {
  xs: { size: '12px', line: '16px' },
  sm: { size: '14px', line: '20px' },
  md: { size: '16px', line: '22px' },
  lg: { size: '18px', line: '26px' },
  xl: { size: '20px', line: '28px' },
  '2xl': { size: '24px', line: '32px' },
  '3xl': { size: '32px', line: '40px' },
} as const;
export type TypeStep = keyof typeof TYPE_SCALE;

export const FONT = {
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  weightRegular: '400',
  weightMedium: '500',
  weightBold: '600',
} as const;

/** Radii. YouTube: 12 px thumbnails/cards, pill buttons, 8 px chips. */
export const RADIUS = {
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  full: '9999px',
} as const;
export type RadiusStep = keyof typeof RADIUS;

/** Motion. Nothing exceeds 200 ms; `prefers-reduced-motion` collapses all of it to 0. */
export const MOTION = {
  fast: '100ms',
  base: '160ms',
  slow: '200ms',
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;
export type MotionStep = 'fast' | 'base' | 'slow';

/** Fixed control sizes (YouTube: 36 px buttons, 36/40 px avatars). */
export const SIZE = {
  control: '36px',
  controlSm: '28px',
  avatarSm: '24px',
  avatarMd: '36px',
  avatarLg: '40px',
  avatarXl: '80px',
  playerControl: '40px',
} as const;

export const Z_INDEX = {
  miniPlayer: '90',
  sheet: '100',
  toast: '200',
} as const;

/**
 * Semantic colour roles. Add a role here and TypeScript forces it into both themes.
 * Values are raw CSS colours (hex or rgba); no references between tokens so the generated
 * CSS stays trivially readable.
 */
export const SEMANTIC_COLOR_NAMES = [
  // surfaces
  'bg',
  'bg-subtle',
  'bg-elevated',
  'bg-hover',
  'bg-active',
  'bg-inverse',
  'border',
  'border-strong',
  // text
  'text',
  'text-secondary',
  'text-muted',
  'text-inverse',
  'text-link',
  // brand / state
  'accent',
  'accent-fg',
  'focus',
  'success',
  'success-bg',
  'danger',
  'danger-bg',
  'warning',
  'warning-bg',
  // money
  'sats',
  'sats-bg',
  'paid',
  // player overlay (always dark, both themes; kept as tokens so a shell can tune them)
  'overlay',
  'overlay-strong',
  'overlay-fg',
  'overlay-fg-muted',
  'buffered',
  // misc
  'skeleton',
  'skeleton-shine',
  'shadow',
] as const;
export type SemanticColorName = (typeof SEMANTIC_COLOR_NAMES)[number];
export type ThemeName = 'light' | 'dark';
export type ThemeColors = Readonly<Record<SemanticColorName, string>>;

export const LIGHT: ThemeColors = {
  bg: '#ffffff',
  'bg-subtle': '#f2f2f2',
  'bg-elevated': '#ffffff',
  'bg-hover': 'rgba(0, 0, 0, 0.05)',
  'bg-active': 'rgba(0, 0, 0, 0.1)',
  'bg-inverse': '#0f0f0f',
  border: 'rgba(0, 0, 0, 0.1)',
  'border-strong': 'rgba(0, 0, 0, 0.2)',
  text: '#0f0f0f',
  'text-secondary': '#606060',
  'text-muted': '#909090',
  'text-inverse': '#ffffff',
  'text-link': '#065fd4',
  accent: '#e8590c',
  'accent-fg': '#ffffff',
  focus: '#065fd4',
  success: '#1e8e3e',
  'success-bg': '#e6f4ea',
  danger: '#d93025',
  'danger-bg': '#fce8e6',
  warning: '#b06000',
  'warning-bg': '#fef7e0',
  sats: '#9a4b00',
  'sats-bg': '#fff1e0',
  paid: '#f7931a',
  overlay: 'rgba(0, 0, 0, 0.6)',
  'overlay-strong': 'rgba(0, 0, 0, 0.85)',
  'overlay-fg': '#ffffff',
  'overlay-fg-muted': 'rgba(255, 255, 255, 0.7)',
  buffered: 'rgba(255, 255, 255, 0.4)',
  skeleton: '#e5e5e5',
  'skeleton-shine': 'rgba(255, 255, 255, 0.6)',
  shadow: 'rgba(0, 0, 0, 0.2)',
};

export const DARK: ThemeColors = {
  bg: '#0f0f0f',
  'bg-subtle': '#272727',
  'bg-elevated': '#212121',
  'bg-hover': 'rgba(255, 255, 255, 0.1)',
  'bg-active': 'rgba(255, 255, 255, 0.2)',
  'bg-inverse': '#f1f1f1',
  border: 'rgba(255, 255, 255, 0.12)',
  'border-strong': 'rgba(255, 255, 255, 0.24)',
  text: '#f1f1f1',
  'text-secondary': '#aaaaaa',
  'text-muted': '#717171',
  'text-inverse': '#0f0f0f',
  'text-link': '#3ea6ff',
  accent: '#f0662a',
  'accent-fg': '#ffffff',
  focus: '#3ea6ff',
  success: '#2ba640',
  'success-bg': '#12301a',
  danger: '#f28b82',
  'danger-bg': '#3a1c1a',
  warning: '#fdd663',
  'warning-bg': '#3a2e10',
  sats: '#ffb454',
  'sats-bg': '#33240f',
  paid: '#f7931a',
  overlay: 'rgba(0, 0, 0, 0.6)',
  'overlay-strong': 'rgba(0, 0, 0, 0.85)',
  'overlay-fg': '#ffffff',
  'overlay-fg-muted': 'rgba(255, 255, 255, 0.7)',
  buffered: 'rgba(255, 255, 255, 0.4)',
  skeleton: '#303030',
  'skeleton-shine': 'rgba(255, 255, 255, 0.08)',
  shadow: 'rgba(0, 0, 0, 0.6)',
};

export const THEMES: Readonly<Record<ThemeName, ThemeColors>> = { light: LIGHT, dark: DARK };

/** CSS custom property name for a semantic colour, e.g. `--nf-color-bg`. */
export const colorVar = (name: SemanticColorName): `--nf-color-${SemanticColorName}` =>
  `--nf-color-${name}`;

/** `var(--nf-color-<name>)` for use from TS (inline styles in shells, stories). */
export const color = (name: SemanticColorName): string => `var(${colorVar(name)})`;

function colorLines(theme: ThemeColors, indent: string): string {
  return SEMANTIC_COLOR_NAMES.map((n) => `${indent}${colorVar(n)}: ${theme[n]};`).join('\n');
}

/**
 * Generates `tokens.css`. Theme selection (ADR 0005 / docs/design/README.md):
 *   1. light values on `:root`;
 *   2. dark values under `prefers-color-scheme: dark` unless `data-theme="light"` is set;
 *   3. dark values whenever `data-theme="dark"` is set (Settings toggle override).
 * `color-scheme` follows so native form controls and scrollbars match.
 */
export function generateTokensCss(): string {
  const i = '  ';
  const scale: string[] = [];
  for (const [k, v] of Object.entries(SPACING)) scale.push(`${i}--nf-space-${k}: ${v};`);
  for (const [k, v] of Object.entries(TYPE_SCALE)) {
    scale.push(`${i}--nf-text-${k}: ${v.size};`);
    scale.push(`${i}--nf-line-${k}: ${v.line};`);
  }
  scale.push(`${i}--nf-font-sans: ${FONT.sans};`);
  scale.push(`${i}--nf-font-mono: ${FONT.mono};`);
  scale.push(`${i}--nf-weight-regular: ${FONT.weightRegular};`);
  scale.push(`${i}--nf-weight-medium: ${FONT.weightMedium};`);
  scale.push(`${i}--nf-weight-bold: ${FONT.weightBold};`);
  for (const [k, v] of Object.entries(RADIUS)) scale.push(`${i}--nf-radius-${k}: ${v};`);
  scale.push(`${i}--nf-motion-fast: ${MOTION.fast};`);
  scale.push(`${i}--nf-motion-base: ${MOTION.base};`);
  scale.push(`${i}--nf-motion-slow: ${MOTION.slow};`);
  scale.push(`${i}--nf-ease: ${MOTION.ease};`);
  for (const [k, v] of Object.entries(SIZE)) {
    const kebab = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    scale.push(`${i}--nf-size-${kebab}: ${v};`);
  }
  for (const [k, v] of Object.entries(Z_INDEX)) {
    const kebab = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    scale.push(`${i}--nf-z-${kebab}: ${v};`);
  }
  scale.push(`${i}--nf-focus-ring: 0 0 0 2px var(--nf-color-bg), 0 0 0 4px var(--nf-color-focus);`);
  scale.push(`${i}--nf-shadow-sm: 0 1px 2px var(--nf-color-shadow);`);
  scale.push(`${i}--nf-shadow-md: 0 4px 16px var(--nf-color-shadow);`);

  return [
    '/* GENERATED by packages/ui/scripts/build-tokens.mjs from src/tokens/tokens.ts — do not edit. */',
    '',
    ':root {',
    `${i}color-scheme: light;`,
    ...scale,
    colorLines(LIGHT, i),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    `${i}:root:not([data-theme='light']) {`,
    `${i}${i}color-scheme: dark;`,
    colorLines(DARK, i + i),
    `${i}}`,
    '}',
    '',
    ":root[data-theme='dark'] {",
    `${i}color-scheme: dark;`,
    colorLines(DARK, i),
    '}',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    `${i}:root {`,
    `${i}${i}--nf-motion-fast: 0ms;`,
    `${i}${i}--nf-motion-base: 0ms;`,
    `${i}${i}--nf-motion-slow: 0ms;`,
    `${i}}`,
    '}',
    '',
    '/* Base element styles: the shells get a themed page for free. */',
    'html {',
    `${i}background-color: var(--nf-color-bg);`,
    `${i}color: var(--nf-color-text);`,
    `${i}font-family: var(--nf-font-sans);`,
    `${i}font-size: var(--nf-text-sm);`,
    `${i}line-height: var(--nf-line-sm);`,
    `${i}-webkit-font-smoothing: antialiased;`,
    `${i}text-rendering: optimizeLegibility;`,
    '}',
    '',
    'body {',
    `${i}margin: 0;`,
    '}',
    '',
    '*,',
    '*::before,',
    '*::after {',
    `${i}box-sizing: border-box;`,
    '}',
    '',
    ':focus-visible {',
    `${i}outline: 2px solid var(--nf-color-focus);`,
    `${i}outline-offset: 2px;`,
    '}',
    '',
  ].join('\n');
}
