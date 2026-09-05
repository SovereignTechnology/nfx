/**
 * NIP-56 kind 1984 reports. Gateways honour them (BUD-09); this lane only builds and
 * publishes.
 */
import type { NostrEvent, NostrTag, Sha256Hex, UnixSeconds } from '../contracts/index.js';
import { NostrKind } from '../contracts/index.js';
import type { NostrClient } from './client.js';
import type { EventDraft, EventRef } from './types.js';

export const REPORT_TYPES = [
  'nudity',
  'malware',
  'profanity',
  'illegal',
  'spam',
  'impersonation',
  'other',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportInput {
  readonly target: EventRef;
  readonly type: ReportType;
  /** Free text; sent as-is (rendered as text by the UI, T15). */
  readonly reason?: string;
  /** Blob hash when reporting a specific rendition/thumbnail (`x` tag). */
  readonly blob?: { readonly sha256: Sha256Hex; readonly server?: string };
}

export function buildReportEvent(input: ReportInput, createdAt: UnixSeconds): EventDraft {
  const tags: NostrTag[] = [
    ['e', input.target.id, input.type],
    ['p', input.target.pubkey],
  ];
  if (input.blob) {
    tags.push(['x', input.blob.sha256, input.type]);
    if (input.blob.server !== undefined) tags.push(['server', input.blob.server]);
  }
  return { kind: NostrKind.Report, created_at: createdAt, tags, content: input.reason ?? '' };
}

export async function report(client: NostrClient, input: ReportInput): Promise<NostrEvent> {
  return (await client.publish(buildReportEvent(input, client.now()))).event;
}
