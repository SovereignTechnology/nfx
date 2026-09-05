/**
 * @sovit/ui — React design system (lane L4, docs/lanes/L4.md), screens (L5) and player chrome.
 * Talks only to `NetworkAdapter` types from `@sovit/core`; components are presentational.
 * Stylesheets are NOT imported from JS (CSP `style-src 'self'`): shells load
 * `@sovit/ui/ui.css` (or `tokens.css` + `components.css`) from `dist/`, built by `build:css`.
 */
export const PACKAGE = '@sovit/ui' as const;

export * from './tokens/index.js';
export * from './components/index.js';
