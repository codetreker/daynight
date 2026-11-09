import { sessionFenceKey, type SessionFence } from '../../../../daynight/src/session/protocol';
import type { SessionResource, TimelineEntry } from '../../api/types';
import type { SessionState } from './state';

/** Historical display data carries neither live capabilities nor an operation owner. */
export type SessionHistoryPreview = {
  readonly fence: SessionFence;
  readonly historyEpoch: string;
  readonly lastEventSeq: string;
  readonly entries: readonly TimelineEntry[];
  readonly resources: readonly SessionResource[];
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
