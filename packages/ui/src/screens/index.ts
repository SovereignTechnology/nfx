/**
 * Screen barrel (orchestrator wiring). Each L5 lane exports its screen from
 * `./<Screen>/index.ts`; the orchestrator adds the re-export line here at merge.
 */
export * from './shared/index.js';
export { Home } from './Home/index.js';
export type { HomeProps, HomeTab } from './Home/index.js';
export { Channel } from './Channel/index.js';
export type { ChannelProps, ChannelTab } from './Channel/index.js';
