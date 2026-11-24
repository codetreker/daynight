import { parseSessionResource, parseTimelineEntry, sessionFence, sessionFenceKey, type SessionFence, type SessionResource, type TimelineEntry } from '../../../../daynight/src/session/protocol';
import { sessionArchiveReferences } from '../../../../daynight/src/session/archive';
import { BOT_HISTORY_WINDOW_ENTRIES, parseBotHistoryWindowEntry } from '../../../../daynight/src/session/bot-history-window';
import type { BotSessionBinding } from '../../api/sessions';
import type { BotHistoryView } from '../task-agent-session/bot-history-window';

export const MAX_SNAPSHOTS = 6;
export const MAX_ENTRIES = 150;
export const MAX_SNAPSHOT_UNITS = 750_000;
export const MAX_TOTAL_UNITS = 1_500_000;
export const MAX_SNAPSHOT_BYTES = 750_000;
export const MAX_TOTAL_BYTES = 1_500_000;

const encoder = new TextEncoder();
export const snapshotBytes = (json: string): number => encoder.encode(json).byteLength;
type SavedWindow = BotHistoryView & { readonly botHistoryWindowVersion: 1 };

/** Inert historical display data. The binding and sequence never grant live admission. */
export type BotDisplayPreview = {
  readonly schemaVersion: 1 | 2;
  readonly ownerUserId: string;
  readonly botId: string;
  readonly lastKnownBinding: BotSessionBinding;
  readonly botName: string;
  readonly fence: SessionFence;
  readonly historyEpoch: string;
  readonly lastEventSeq: string;
  readonly entries: readonly TimelineEntry[];
  readonly resources: readonly SessionResource[];
  readonly botHistoryWindow?: SavedWindow;
  readonly savedAt: number;
  readonly readingAnchor?: { readonly entryId: string; readonly offset: number; readonly following: boolean };
};

const invalid = (): never => { throw new Error('Invalid Bot display snapshot.'); };
const fields = (value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return data;
};
const uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) ? value : invalid();
const text = (value: unknown): string => typeof value === 'string' && value.isWellFormed() && /[^\p{White_Space}]/u.test(value) && !value.includes('\0') ? value : invalid();
const sequence = (value: unknown): string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n ? value : invalid();
// Display snapshots may retain unresolved projections and their last known images.
const referencedResources = (entry: TimelineEntry): readonly string[] => [...sessionArchiveReferences([entry], false).resources];

function parseSavedWindow(value: unknown): SavedWindow {
  const data = fields(value, ['botHistoryWindowVersion', 'windowRevision', 'retainedFromSeq', 'throughSeq', 'earlierHistoryUnavailable', 'entries'], ['localEviction']);
  if (data.botHistoryWindowVersion !== 1 || typeof data.earlierHistoryUnavailable !== 'boolean' || !Array.isArray(data.entries) || data.entries.length > BOT_HISTORY_WINDOW_ENTRIES) return invalid();
  if (Object.hasOwn(data, 'localEviction') && (data.localEviction !== true || !data.earlierHistoryUnavailable)) return invalid();
  const positiveSequence = (value: unknown) => { const result = sequence(value); return result === '0' ? invalid() : result; };
  const windowRevision = positiveSequence(data.windowRevision);
  const retainedFromSeq = data.retainedFromSeq === null ? null : positiveSequence(data.retainedFromSeq);
  const throughSeq = data.throughSeq === null ? null : positiveSequence(data.throughSeq);
  const earlierHistoryUnavailable = data.earlierHistoryUnavailable;
  if (throughSeq === null ? retainedFromSeq !== null || earlierHistoryUnavailable : retainedFromSeq === null ? !earlierHistoryUnavailable : BigInt(retainedFromSeq) > BigInt(throughSeq)) return invalid();
  const entries = data.entries.map(parseBotHistoryWindowEntry);
  const ids = new Set<string>();
  let previous = 0n;
  for (const entry of entries) {
    const position = BigInt(entry.entrySeq);
    if (ids.has(entry.entryId) || position <= previous || retainedFromSeq === null || throughSeq === null || position < BigInt(retainedFromSeq) || position > BigInt(throughSeq)) return invalid();
    ids.add(entry.entryId);
    previous = position;
  }
  return { botHistoryWindowVersion: 1, windowRevision, retainedFromSeq, throughSeq, earlierHistoryUnavailable, ...(data.localEviction ? { localEviction: true as const } : {}), entries };
}

function validate(value: unknown, ownerUserId: string, botId: string): BotDisplayPreview {
  const data = fields(value, ['schemaVersion', 'ownerUserId', 'botId', 'lastKnownBinding', 'botName', 'fence', 'historyEpoch', 'lastEventSeq', 'entries', 'resources', 'savedAt'], ['readingAnchor', 'botHistoryWindow']);
  if (data.schemaVersion !== 1 && data.schemaVersion !== 2 || uuid(data.ownerUserId) !== uuid(ownerUserId) || uuid(data.botId) !== uuid(botId)) return invalid();
  const binding = fields(data.lastKnownBinding, ['ownerUserId', 'botId', 'sessionId', 'testExecutionId']);
  const lastKnownBinding: BotSessionBinding = { ownerUserId: uuid(binding.ownerUserId), botId: uuid(binding.botId), sessionId: uuid(binding.sessionId), testExecutionId: uuid(binding.testExecutionId) };
  const rawFence = fields(data.fence, ['sessionId', 'testExecutionId', 'executionGeneration']);
  const fence = sessionFence(rawFence as SessionFence);
  if (lastKnownBinding.ownerUserId !== ownerUserId || lastKnownBinding.botId !== botId || fence.sessionId !== lastKnownBinding.sessionId || fence.testExecutionId !== lastKnownBinding.testExecutionId) return invalid();
  const botName = text(data.botName), historyEpoch = text(data.historyEpoch);
  if (/\p{Cc}/u.test(botName) || [...botName].length > 40 || new TextEncoder().encode(historyEpoch).length > 256) return invalid();
  if (data.schemaVersion === 2) uuid(historyEpoch);
  if (typeof data.savedAt !== 'number' || !Number.isSafeInteger(data.savedAt) || data.savedAt < 0) return invalid();
  if (!Array.isArray(data.entries) || !Array.isArray(data.resources)) return invalid();
  const window = data.schemaVersion === 2 ? parseSavedWindow(data.botHistoryWindow) : undefined;
  if (window ? data.entries.length > 0 || data.resources.length > 0 : Object.hasOwn(data, 'botHistoryWindow')) return invalid();
  const entries = data.entries.map(parseTimelineEntry), resources = data.resources.map(parseSessionResource);
  const entryIds = new Set<string>(), resourceIds = new Set<string>();
  let previous = 0n;
  for (const entry of entries) {
    if (entryIds.has(entry.entryId) || BigInt(entry.entrySeq) <= previous) return invalid();
    entryIds.add(entry.entryId); previous = BigInt(entry.entrySeq);
  }
  for (const resource of resources) {
    if (resourceIds.has(resource.resourceId)) return invalid();
    resourceIds.add(resource.resourceId);
  }
  for (const entry of entries) if (referencedResources(entry).some(id => !resourceIds.has(id))) return invalid();
  let readingAnchor: BotDisplayPreview['readingAnchor'];
  if (Object.hasOwn(data, 'readingAnchor')) {
    const anchor = fields(data.readingAnchor, ['entryId', 'offset', 'following']);
    if (typeof anchor.offset !== 'number' || !Number.isFinite(anchor.offset) || anchor.offset < 0 || anchor.offset > Number.MAX_SAFE_INTEGER || typeof anchor.following !== 'boolean') return invalid();
    readingAnchor = { entryId: uuid(anchor.entryId), offset: anchor.offset, following: anchor.following };
  }
  return { schemaVersion: data.schemaVersion, ownerUserId, botId, lastKnownBinding, botName, fence, historyEpoch, lastEventSeq: sequence(data.lastEventSeq), entries, resources, savedAt: data.savedAt, ...(window ? { botHistoryWindow: window } : {}), ...(readingAnchor ? { readingAnchor } : {}) };
}

/** Validates a bounded stored record and its authenticated outer storage identity; throws on failure. */
export function parseBotDisplayPreview(value: unknown, ownerUserId: string, botId: string): BotDisplayPreview {
  const preview = validate(value, ownerUserId, botId);
  const window = preview.botHistoryWindow, entries = window?.entries ?? preview.entries, serialized = JSON.stringify(preview);
  if (entries.length > MAX_ENTRIES || serialized.length > MAX_SNAPSHOT_UNITS || preview.readingAnchor && !entries.some(entry => entry.entryId === preview.readingAnchor!.entryId)) return invalid();
  if (window && (snapshotBytes(serialized) > MAX_SNAPSHOT_BYTES || !window.earlierHistoryUnavailable && entries[0]?.entrySeq !== (window.retainedFromSeq ?? undefined))) return invalid();
  return preview;
}

/** A corrupt, oversized or foreign stored value is a cache miss, never a networking failure. */
export function decodeBotDisplayPreview(raw: string, ownerUserId: string, botId: string): BotDisplayPreview | null {
  try { return raw.length <= MAX_SNAPSHOT_UNITS ? parseBotDisplayPreview(JSON.parse(raw), ownerUserId, botId) : null; }
  catch { return null; }
}

/**
 * Validates all supplied history before trimming its oldest complete entries.
 * Only descriptors referenced by retained entries survive. A nonempty history
 * that cannot retain one whole entry returns null instead of authoritative emptiness.
 */
export function prepareBotDisplayPreview(value: unknown, ownerUserId: string, botId: string): BotDisplayPreview | null {
  try {
    const preview = validate(value, ownerUserId, botId);
    if (preview.botHistoryWindow) return prepareSavedWindow(preview, preview.botHistoryWindow);
    const entries = preview.entries.slice(-MAX_ENTRIES);
    const entryUnits = entries.map(entry => JSON.stringify(entry).length);
    let entriesUnits = entryUnits.reduce((sum, units) => sum + units, 0);
    const uses = new Map<string, number>();
    for (const entry of entries) for (const id of referencedResources(entry)) uses.set(id, (uses.get(id) ?? 0) + 1);
    const resourceUnits = new Map(preview.resources.map(resource => [resource.resourceId, JSON.stringify(resource).length]));
    const { readingAnchor, ...base } = preview;
    for (let start = 0; start <= entries.length; start++) {
      if (start === entries.length && preview.entries.length > 0) return null;
      const retained = entries.slice(start);
      const resources = preview.resources.filter(resource => uses.has(resource.resourceId));
      const anchor = readingAnchor && retained.some(entry => entry.entryId === readingAnchor.entryId) ? { readingAnchor } : {};
      const shell = { ...base, entries: [], resources: [], ...anchor };
      const units = JSON.stringify(shell).length + entriesUnits + Math.max(0, retained.length - 1) + resources.reduce((sum, resource) => sum + resourceUnits.get(resource.resourceId)!, 0) + Math.max(0, resources.length - 1);
      if (units <= MAX_SNAPSHOT_UNITS) return { ...shell, entries: retained, resources };
      const removed = entries[start];
      if (!removed) return null;
      entriesUnits -= entryUnits[start]!;
      for (const id of referencedResources(removed)) {
        const remaining = uses.get(id)! - 1;
        if (remaining === 0) uses.delete(id); else uses.set(id, remaining);
      }
    }
    return null;
  } catch { return null; }
}

function prepareSavedWindow(preview: BotDisplayPreview, window: SavedWindow): BotDisplayPreview | null {
  const { readingAnchor, ...base } = preview;
  const entries = window.entries.slice(-MAX_ENTRIES);
  const encoded = entries.map(entry => snapshotBytes(JSON.stringify(entry)));
  let entryBytes = encoded.reduce((sum, bytes) => sum + bytes, 0);
  for (let start = 0; start <= entries.length; start++) {
    if (start === entries.length && window.entries.length > 0) return null;
    const retained = entries.slice(start);
    const anchor = readingAnchor && retained.some(entry => entry.entryId === readingAnchor.entryId) ? { readingAnchor } : {};
    const clipped = retained.length < window.entries.length;
    const earlierHistoryUnavailable = window.earlierHistoryUnavailable || clipped || retained[0]?.entrySeq !== (window.retainedFromSeq ?? undefined);
    const shell = { ...base, botHistoryWindow: { ...window, earlierHistoryUnavailable, ...(clipped ? { localEviction: true as const } : {}), entries: [] }, ...anchor };
    if (snapshotBytes(JSON.stringify(shell)) + entryBytes + Math.max(0, retained.length - 1) <= MAX_SNAPSHOT_BYTES) return { ...shell, botHistoryWindow: { ...shell.botHistoryWindow, entries: retained } };
    entryBytes -= encoded[start]!;
  }
  return null;
}

/** Full historical identity; neither save time nor connection epoch determines replacement order. */
export function botDisplayHistoryKey(preview: BotDisplayPreview): string {
  const binding = preview.lastKnownBinding;
  return JSON.stringify([binding.ownerUserId, binding.botId, binding.sessionId, binding.testExecutionId, sessionFenceKey(preview.fence), preview.historyEpoch]);
}
