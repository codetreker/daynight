import { sessionFenceKey, type SessionFence } from '../../../../daynight/src/session/protocol';
import type { BotHistoryWindowEntry } from '../../../../daynight/src/session/bot-history-window';
import type { SessionResource, TimelineEntry } from '../../api/types';
import { boundBotHistoryWindow, type BotHistoryView } from './bot-history-window';
import type { SessionState } from './state';

/** Historical display data carries neither live capabilities nor an operation owner. */
export type SessionHistoryPreview = {
  readonly fence: SessionFence;
  readonly historyEpoch: string;
  readonly lastEventSeq: string;
  readonly entries: readonly TimelineEntry[];
  readonly resources: readonly SessionResource[];
  readonly botHistoryWindow?: BotHistoryView;
  readonly savedAt?: number;
  readonly readingAnchor?: { readonly entryId: string; readonly offset: number; readonly following: boolean };
};

/** Boundaries established by accepted protocol history pages, independent of current snapshots. */
export type SessionHistoryCoverage = {
  readonly firstEntrySeq: string | null;
  readonly throughEntrySeq: string;
  readonly completeBefore: boolean;
  readonly lastEventSeq: string;
};
export type SessionHistoryRow = { readonly entry: TimelineEntry; readonly preview: boolean };
export type SessionTimelineRow = { readonly entry: TimelineEntry | BotHistoryWindowEntry; readonly preview: boolean };

export function matchingSessionHistoryPreview(state: SessionState, preview: SessionHistoryPreview | undefined): SessionHistoryPreview | undefined {
  const snapshot = state.snapshot;
  return preview && (!snapshot || sessionFenceKey(snapshot) === sessionFenceKey(preview.fence) && snapshot.historyEpoch === preview.historyEpoch) ? preview : undefined;
}

/** Merge only for presentation. Verified rows own their IDs even when cached revisions are newer. */
export function selectSessionHistoryRows(state: SessionState, preview: SessionHistoryPreview | undefined, historyLoaded: boolean, coverage: SessionHistoryCoverage | null): readonly SessionHistoryRow[] {
  const valid = matchingSessionHistoryPreview(state, preview);
  const rows = new Map<string, SessionHistoryRow>();
  if (valid) for (const entry of valid.entries) {
    const seq = BigInt(entry.entrySeq);
    const covered = historyLoaded && coverage && (coverage.completeBefore && (BigInt(coverage.lastEventSeq) >= BigInt(valid.lastEventSeq) || seq <= BigInt(coverage.throughEntrySeq)) || coverage.firstEntrySeq !== null && seq >= BigInt(coverage.firstEntrySeq) && seq <= BigInt(coverage.throughEntrySeq));
    if (!covered) rows.set(entry.entryId, { entry, preview: true });
  }
  for (const entry of state.entries) rows.set(entry.entryId, { entry, preview: false });
  return [...rows.values()].sort((a, b) => BigInt(a.entry.entrySeq) < BigInt(b.entry.entrySeq) ? -1 : BigInt(a.entry.entrySeq) > BigInt(b.entry.entrySeq) ? 1 : a.entry.entryId.localeCompare(b.entry.entryId));
}

/** A settled window owns covered rows, including authoritative omissions. */
export function selectSessionTimeline(state: SessionState, preview: SessionHistoryPreview | undefined, historyLoaded: boolean, coverage: SessionHistoryCoverage | null, liveWindow: BotHistoryView | null | undefined): {
  readonly rows: readonly SessionTimelineRow[];
  readonly earlierHistoryUnavailable: boolean;
  readonly cachedWindow: boolean;
} {
  const cached = matchingSessionHistoryPreview(state, preview)?.botHistoryWindow;
  const window = liveWindow ?? (historyLoaded ? undefined : cached);
  if (!window) return { rows: selectSessionHistoryRows(state, preview, historyLoaded, coverage), earlierHistoryUnavailable: false, cachedWindow: false };
  const verified = new Set(liveWindow?.entries.map(entry => entry.entryId));
  const first = liveWindow?.entries[0]?.entrySeq;
  const floor = liveWindow?.retainedFromSeq;
  const unconfirmed = liveWindow && !liveWindow.localEviction && cached && first !== undefined && floor != null
    ? cached.entries.filter(entry => !verified.has(entry.entryId) && BigInt(entry.entrySeq) >= BigInt(floor) && BigInt(entry.entrySeq) < BigInt(first)) : [];
  const combined = unconfirmed.length ? boundBotHistoryWindow(window, [...unconfirmed, ...window.entries]) : window;
  const rows: SessionTimelineRow[] = combined.entries.map(entry => ({ entry, preview: !verified.has(entry.entryId) }));
  const ids = new Set(rows.map(row => row.entry.entryId));
  // Live control cards retain their own lifecycle and write admission.
  for (const entry of state.entries) if (entry.kind === 'interaction' && !ids.has(entry.entryId)) rows.push({ entry, preview: false });
  rows.sort((a, b) => BigInt(a.entry.entrySeq) < BigInt(b.entry.entrySeq) ? -1 : BigInt(a.entry.entrySeq) > BigInt(b.entry.entrySeq) ? 1 : a.entry.entryId.localeCompare(b.entry.entryId));
  return { rows, earlierHistoryUnavailable: combined.earlierHistoryUnavailable, cachedWindow: !liveWindow };
}
