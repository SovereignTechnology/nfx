/**
 * `@sovit/core` nostr — the Nostr data layer (lane L1, build-plan §2.2).
 *
 * Read paths: `PoolLike` → `NostrClient` (verification boundary, T9) → parsers.
 * Write paths: builders → `Signer.signEvent` → `NostrClient.publish`.
 */
export type {
  DropReason,
  EventDraft,
  EventRef,
  FetchLike,
  NostrClientOptions,
  PoolLike,
  PublishResult,
  SubscriptionHandlers,
  Unsubscribe,
} from './types.js';
export {
  verifyIncoming,
  classifyIncoming,
  isWellFormedTag,
  isHex64,
  toWire,
  tagValue,
  tagValues,
  tagsNamed,
  byNewest,
  newestPer,
  dedupeById,
  nowSeconds,
} from './event.js';
export { NostrClient, NoSignerError, PublishError } from './client.js';
export type { PublishReport } from './client.js';
export { SimplePoolAdapter, toWireFilter } from './simple-pool-adapter.js';
export type { PoolBackend } from './simple-pool-adapter.js';
export { FakeRelayPool } from './fake-relay.js';
export type { FakeRelayPoolOptions } from './fake-relay.js';
export {
  encodeTimeCursor,
  decodeTimeCursor,
  applyTimeCursor,
  encodeOffsetCursor,
  decodeOffsetCursor,
} from './cursor.js';
export type { TimeCursor } from './cursor.js';
export { parseNip05, lookupNip05, verifyNip05 } from './nip05.js';
export type { Nip05Identifier, Nip05Lookup } from './nip05.js';
export {
  parseProfile,
  buildProfileEvent,
  withNip05Status,
  fetchProfile,
  fetchProfiles,
  publishProfile,
} from './profiles.js';
export type { ProfileInput, FetchProfileOptions } from './profiles.js';
export {
  parseFollows,
  buildFollowsEvent,
  fetchFollows,
  fetchSubscriptions,
  setSubscribed,
} from './follows.js';
export type { FollowEntry } from './follows.js';
export {
  SetId,
  buildSetEvent,
  parseSet,
  fetchSet,
  publishSet,
  setEventIds,
  toPlaylist,
  playlistToSetInput,
  fetchPlaylists,
  savePlaylist,
  fetchWatchLater,
  setWatchLater,
  fetchHistory,
  parseHistoryItems,
  recordProgress,
  fetchLiked,
  setLiked,
  DEFAULT_HISTORY_CAP,
} from './sets.js';
export type {
  SetInput,
  ParsedSet,
  PrivateItemsStatus,
  PlaylistInput,
  HistoryEntry,
} from './sets.js';
export {
  VIDEO_KINDS,
  DEFAULT_PAGE,
  MAX_PAGE,
  toManifests,
  videoPage,
  subscriptionsFeed,
  tagsFeed,
  authorFeed,
  shortsFeed,
  latestFeed,
  fetchVideos,
  fetchVideo,
  searchVideos,
  relatedVideos,
  watchNewVideos,
} from './feeds.js';
export type { FeedOptions } from './feeds.js';
export {
  DEFAULT_DECAY,
  decayWeight,
  scorePaidEvents,
  rankTrending,
  parseNutzap,
  groupNutzapsByVideo,
  trendingFeed,
  fetchPaidStats,
} from './trending.js';
export type {
  DecayOptions,
  PaidEvent,
  TrendingScore,
  TrendingEntry,
  Nutzap,
  TrendingOptions,
  TrendingPage,
} from './trending.js';
export {
  buildCommentEvent,
  parseComment,
  fetchComments,
  postComment,
  watchReplies,
} from './comments.js';
export type { CommentInput, ParsedComment, CommentsOptions } from './comments.js';
export {
  classifyReaction,
  buildReactionEvent,
  parseReaction,
  summarizeReactions,
  fetchReactions,
  countLikesByTarget,
  react,
} from './reactions.js';
export type { ReactionKind, ParsedReaction, ReactionSummary } from './reactions.js';
export { normalizeMintUrl, parseNutzapInfo, fetchNutzapInfo } from './nutzap-info.js';
export type { NutzapMint, NutzapInfo } from './nutzap-info.js';
export {
  normalizeRelayUrl,
  parseRelayList,
  buildRelayListEvent,
  fetchRelayList,
} from './relay-list.js';
export { REPORT_TYPES, buildReportEvent, report } from './report.js';
export type { ReportType, ReportInput } from './report.js';
