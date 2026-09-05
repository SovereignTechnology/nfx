/**
 * Theme selection helpers (ADR 0005: light + dark, follow the system, Settings toggle).
 *
 * The CSS does the real work (`tokens.css` reacts to `prefers-color-scheme` and to the
 * `data-theme` attribute on `<html>`); these helpers only set/remove that attribute and
 * tell React code which theme is currently resolved.
 */
import { useEffect, useState } from 'react';
import type { Settings } from '@sovit/core';
import type { ThemeName } from './tokens.js';

/** `Settings['theme']` from the frozen contracts: `'dark' | 'light' | 'system'`. */
export type ThemePreference = Settings['theme'];

export const THEME_ATTRIBUTE = 'data-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

type MatchMediaLike = (query: string) => { matches: boolean };

/** `window.matchMedia` when the environment has one (jsdom does not). */
function systemMatchMedia(): MatchMediaLike | undefined {
  // jsdom declares `window.matchMedia` but leaves it undefined, so check the function itself.
  if (typeof window === 'undefined') return undefined;
  const w = window as { matchMedia?: unknown };
  return typeof w.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined;
}

/** Resolves a preference to a concrete theme. `system` consults `matchMedia` when available. */
export function resolveTheme(
  preference: ThemePreference,
  matchMedia: MatchMediaLike | undefined = systemMatchMedia(),
): ThemeName {
  if (preference === 'light' || preference === 'dark') return preference;
  return matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Applies a preference to the document: `system` removes the override attribute so the
 * `prefers-color-scheme` media query decides; `light`/`dark` pin it.
 */
export function applyTheme(
  preference: ThemePreference,
  root: Element | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): void {
  if (!root) return;
  if (preference === 'system') root.removeAttribute(THEME_ATTRIBUTE);
  else root.setAttribute(THEME_ATTRIBUTE, preference);
}

/** Reads the current override attribute (`undefined` = following the system). */
export function readThemeOverride(
  root: Element | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): ThemeName | undefined {
  const v = root?.getAttribute(THEME_ATTRIBUTE);
  return v === 'light' || v === 'dark' ? v : undefined;
}

/**
 * The theme currently in effect, re-evaluated when the system preference or the override
 * attribute changes. Presentational code rarely needs this — CSS handles both themes — but
 * a Settings screen wants to show which one the system picked.
 */
export function useResolvedTheme(preference: ThemePreference): ThemeName {
  const [theme, setTheme] = useState<ThemeName>(() => resolveTheme(preference));
  useEffect(() => {
    setTheme(resolveTheme(preference));
    const mm = systemMatchMedia();
    if (preference !== 'system' || !mm) return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      setTheme(mql.matches ? 'dark' : 'light');
    };
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, [preference]);
  return theme;
}
