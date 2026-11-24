import type { BotHistoryWindowBoundary, BotHistoryWindowEntry } from '../../../../daynight/src/session/bot-history-window';
import type { SessionSnapshot } from '../../../../daynight/src/session/protocol';

export type BotHistoryView = Pick<BotHistoryWindowBoundary, 'earlierHistoryUnavailable' | 'retainedFromSeq' | 'throughSeq' | 'windowRevision'> & {
  readonly entries: readonly BotHistoryWindowEntry[];
  readonly localEviction?: true;
};

const encoder = new TextEncoder();
const limits = { entries: 150, bytes: 750_000 };
const position = (seq: string | null): bigint => BigInt(seq ?? '0');

export function matchesBotHistoryWindow(boundary: BotHistoryWindowBoundary, snapshot: SessionSnapshot): boolean {
  return boundary.sessionId === snapshot.sessionId && boundary.testExecutionId === snapshot.testExecutionId &&
    boundary.executionGeneration === snapshot.executionGeneration && boundary.connectionEpoch === snapshot.connectionEpoch &&
    boundary.historyEpoch === snapshot.historyEpoch;
}

export function advancesBotHistoryWindow(current: BotHistoryView, next: Pick<BotHistoryView, 'windowRevision' | 'retainedFromSeq' | 'throughSeq'>): boolean {
  const revision = position(next.windowRevision) - position(current.windowRevision);
  if (revision < 0n) return false;
  if (revision === 0n) return next.retainedFromSeq === current.retainedFromSeq && next.throughSeq === current.throughSeq;
  if (position(next.throughSeq) < position(current.throughSeq)) return false;
  const floor = (value: Pick<BotHistoryView, 'retainedFromSeq' | 'throughSeq'>) => value.retainedFromSeq === null
    ? value.throughSeq === null ? 0n : position(value.throughSeq) + 1n
    : position(value.retainedFromSeq);
  return floor(next) >= floor(current);
}

/** Retain the newest rows that fit both budgets. The local gap survives serialization. */
export function boundBotHistoryWindow(boundary: Omit<BotHistoryView, 'entries'>, rows: readonly BotHistoryWindowEntry[], budget = limits): BotHistoryView {
  const { retainedFromSeq, throughSeq, windowRevision, localEviction } = boundary;
  const view = { retainedFromSeq, throughSeq, windowRevision, earlierHistoryUnavailable: boundary.earlierHistoryUnavailable };
  const entries: BotHistoryWindowEntry[] = [];
  let bytes = encoder.encode(JSON.stringify({ ...view, earlierHistoryUnavailable: false, localEviction: true, entries })).length;
  for (let index = rows.length - 1; index >= 0 && entries.length < budget.entries; index--) {
    const row = rows[index]!;
    if (retainedFromSeq === null || position(row.entrySeq) < position(retainedFromSeq)) break;
    bytes += encoder.encode(JSON.stringify(row)).length + (entries.length ? 1 : 0);
    if (bytes > budget.bytes) break;
    entries.push(row);
  }
  const eligible = rows.filter(row => retainedFromSeq !== null && position(row.entrySeq) >= position(retainedFromSeq)).length;
  const clipped = entries.length < eligible;
  entries.reverse();
  if (clipped) {
    const firstCompleteTurn = entries.findIndex(entry => entry.kind === 'user_message');
    if (firstCompleteTurn > 0) entries.splice(0, firstCompleteTurn);
  }
  return { ...view, earlierHistoryUnavailable: view.earlierHistoryUnavailable || localEviction === true || clipped,
    ...(clipped || localEviction ? { localEviction: true } : {}), entries };
}

export function mergeBotHistoryWindowEntries(current: readonly BotHistoryWindowEntry[], incoming: readonly BotHistoryWindowEntry[]): readonly BotHistoryWindowEntry[] {
  const entries = new Map(current.map(entry => [entry.entryId, entry]));
  for (const entry of incoming) {
    const previous = entries.get(entry.entryId);
    if (!previous || previous.entrySeq === entry.entrySeq && position(entry.revision) > position(previous.revision)) entries.set(entry.entryId, entry);
  }
  return [...entries.values()].sort((a, b) => position(a.entrySeq) < position(b.entrySeq) ? -1 : 1);
}
