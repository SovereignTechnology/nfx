/**
 * Search screen export surface. Only Search-prefixed names, so the orchestrator's `export *`
 * barrel cannot collide with another screen's (Home already exports `describeError`).
 * The other helpers in `./Search.tsx` are exported for the tests only.
 */
export {
  DEFAULT_SEARCH_FILTERS,
  SEARCH_DEBOUNCE_MS,
  SEARCH_DURATIONS,
  SEARCH_UPLOAD_DATES,
  Search,
  buildSearchFilters,
  describeSearchError,
  normalizeSearchFilters,
} from './Search.js';
export type { SearchDuration, SearchFilterState, SearchProps, SearchUploadDate } from './Search.js';
