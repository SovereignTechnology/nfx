/**
 * Screen barrel (orchestrator wiring). Each L5 lane exports its screen from
 * `./<Screen>/index.ts`; the orchestrator adds the re-export line here at merge.
 */
export * from './shared/index.js';
