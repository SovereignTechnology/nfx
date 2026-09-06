/**
 * Shared screen scaffolding (orchestrator-owned, interfaces only — lane L5 screens consume
 * this and never redefine it). A screen is a React component that receives the
 * `NetworkAdapter` and a `navigate` callback; routing itself belongs to the shells (L6/L7).
 */
import type { NetworkAdapter, NostrEventId, NostrPubkey } from '@sovit/core';

export type Route =
  | { readonly name: 'home'; readonly tab?: 'subscriptions' | 'trending' | 'tags' }
  | { readonly name: 'watch'; readonly videoId: NostrEventId; readonly t?: number }
  | {
      readonly name: 'channel';
      readonly pubkey: NostrPubkey;
      readonly tab?: 'videos' | 'shorts' | 'playlists' | 'about';
    }
  | { readonly name: 'search'; readonly q: string }
  | { readonly name: 'shorts'; readonly videoId?: NostrEventId }
  | { readonly name: 'library'; readonly tab?: 'history' | 'watch-later' | 'playlists' | 'liked' }
  | { readonly name: 'studio'; readonly tab?: 'upload' | 'videos' | 'analytics' | 'seeder' }
  | { readonly name: 'wallet' }
  | { readonly name: 'settings' };

export type RouteName = Route['name'];

/** Props every screen accepts. Screens add their own route-specific props on top. */
export interface ScreenProps {
  readonly adapter: NetworkAdapter;
  readonly navigate: (to: Route) => void;
  /** Present while a video plays in the mini-player (Watch → elsewhere). Optional. */
  readonly miniPlayer?: React.ReactNode;
}
