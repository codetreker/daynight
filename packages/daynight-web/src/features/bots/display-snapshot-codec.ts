import { parseSessionResource, parseTimelineEntry, sessionFence, sessionFenceKey, type SessionFence, type SessionResource, type TimelineEntry } from '../../../../daynight/src/session/protocol';
import type { BotSessionBinding } from '../../api/sessions';

export const MAX_SNAPSHOTS = 6;
export const MAX_ENTRIES = 150;
export const MAX_SNAPSHOT_UNITS = 750_000;
export const MAX_TOTAL_UNITS = 1_500_000;

/** Inert historical display data. The binding and sequence never grant live admission. */
export type BotDisplayPreview = {
  readonly schemaVersion: 1;
  readonly ownerUserId: string;
  readonly botId: string;
  readonly lastKnownBinding: BotSessionBinding;
  readonly botName: string;
  readonly fence: SessionFence;
  readonly historyEpoch: string;
  readonly lastEventSeq: string;
  readonly entries: readonly TimelineEntry[];
  readonly resources: readonly SessionResource[];
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
const referencedResources = (entry: TimelineEntry): readonly string[] => {
  const parts = entry.kind === 'tool_call' ? entry.output : entry.kind === 'user_message' || entry.kind === 'assistant_message' ? entry.content : [];
  return parts.flatMap(part => part.type === 'resource' ? [part.resourceId] : []);
};

function validate(value: unknown, ownerUserId: string, botId: string): BotDisplayPreview {
  const data = fields(value, ['schemaVersion', 'ownerUserId', 'botId', 'lastKnownBinding', 'botName', 'fence', 'historyEpoch', 'lastEventSeq', 'entries', 'resources', 'savedAt'], ['readingAnchor']);
  if (data.schemaVersion !== 1 || uuid(data.ownerUserId) !== uuid(ownerUserId) || uuid(data.botId) !== uuid(botId)) return invalid();
  const binding = fields(data.lastKnownBinding, ['ownerUserId', 'botId', 'sessionId', 'testExecutionId']);
  const lastKnownBinding: BotSessionBinding = { ownerUserId: uuid(binding.ownerUserId), botId: uuid(binding.botId), sessionId: uuid(binding.sessionId), testExecutionId: uuid(binding.testExecutionId) };
  const rawFence = fields(data.fence, ['sessionId', 'testExecutionId', 'executionGeneration']);
  const fence = sessionFence(rawFence as SessionFence);
  if (lastKnownBinding.ownerUserId !== ownerUserId || lastKnownBinding.botId !== botId || fence.sessionId !== lastKnownBinding.sessionId || fence.testExecutionId !== lastKnownBinding.testExecutionId) return invalid();
  const botName = text(data.botName), historyEpoch = text(data.historyEpoch);
  if (/\p{Cc}/u.test(botName) || [...botName].length > 40 || new TextEncoder().encode(historyEpoch).length > 256) return invalid();
  if (typeof data.savedAt !== 'number' || !Number.isSafeInteger(data.savedAt) || data.savedAt < 0) return invalid();
  if (!Array.isArray(data.entries) || !Array.isArray(data.resources)) return invalid();
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
  return { schemaVersion: 1, ownerUserId, botId, lastKnownBinding, botName, fence, historyEpoch, lastEventSeq: sequence(data.lastEventSeq), entries, resources, savedAt: data.savedAt, ...(readingAnchor ? { readingAnchor } : {}) };
}

/** Validates a bounded stored record and its authenticated outer storage identity; throws on failure. */
export function parseBotDisplayPreview(value: unknown, ownerUserId: string, botId: string): BotDisplayPreview {
  const preview = validate(value, ownerUserId, botId);
  if (preview.entries.length > MAX_ENTRIES || JSON.stringify(preview).length > MAX_SNAPSHOT_UNITS || preview.readingAnchor && !preview.entries.some(entry => entry.entryId === preview.readingAnchor!.entryId)) return invalid();
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

/** Full historical identity; neither save time nor connection epoch determines replacement order. */
export function botDisplayHistoryKey(preview: BotDisplayPreview): string {
  const binding = preview.lastKnownBinding;
  return JSON.stringify([binding.ownerUserId, binding.botId, binding.sessionId, binding.testExecutionId, sessionFenceKey(preview.fence), preview.historyEpoch]);
}
