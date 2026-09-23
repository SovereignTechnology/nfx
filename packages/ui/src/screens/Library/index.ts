/**
 * Library screen export surface. Only Library-prefixed names, so the orchestrator's
 * `export *` barrel cannot collide with another screen's (Home already exports
 * `describeError`). Pure helpers stay internal to `./libraryFormat.ts`.
 */
export { LIBRARY_TABS, Library } from './Library.js';
export type { HistoryEntry as LibraryHistoryEntry, LibraryProps, LibraryTab } from './Library.js';
export { describeLibraryError } from './libraryFormat.js';
