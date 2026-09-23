/*
 * Settings screen export surface. Deliberately small: the screens barrel re-exports with
 * `export *`, so generic helper names (validators, `Validation`, …) stay internal.
 */
export { SETTINGS_SECTIONS, Settings } from './Settings.js';
export type { SettingsProps, SettingsSectionId } from './Settings.js';
