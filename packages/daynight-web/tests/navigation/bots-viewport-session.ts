export * from '../../src/api/sessions';
import type { BotSessionBinding, SessionApi } from '../../src/api/sessions';
import type { SessionSnapshot } from '../../src/api/types';
import type { SessionArchive } from '../../../daynight/src/session/archive';
import { sessionFence } from '../../../daynight/src/session/protocol';
import { sessionImageBytes } from '../helpers/sessionImages';

export type BotViewportOptions = {
  readonly scenario: 'empty' | 'long' | 'error' | 'archive' | 'hot-switch' | 'persistent';
  readonly text?: string;
  readonly holdCurrent?: boolean;
  readonly holdHistory?: boolean;
  readonly holdBefore?: boolean;
  readonly revision?: string;
  readonly historyEpoch?: string;
  readonly lastEventSeq?: string;
  readonly persistentTail?: { readonly start: number; readonly end: number };
};

// Only the Bot transport is controlled. AuthenticatedApp, the cache, client,
// renderer, composer and pagination hooks are production implementations.
const metrics = { tail: 0, before: 0, commands: 0, channels: 0, closed: 0, archives: 0, archiveContents: 0, resourceReads: 0, snapshotWrites: 0, snapshotEvents: [] as (string | null)[], snapshotChanges: [] as { readonly at: number; readonly writes: number; readonly oldValue: string | null; readonly newValue: string | null }[], bindings: [] as string[] };
const setItem = Storage.prototype.setItem;
Storage.prototype.setItem = function(key, value) { if (key.startsWith('daynight:bot-display:v1:')) metrics.snapshotWrites++; return setItem.call(this, key, value); };
window.addEventListener('storage', event => {
  if (!event.key?.startsWith('daynight:bot-display:v1:')) return;
  metrics.snapshotEvents.push(event.newValue);
  metrics.snapshotChanges.push({ at: Date.now(), writes: metrics.snapshotWrites, oldValue: event.oldValue, newValue: event.newValue });
});
const imageBytes = sessionImageBytes('png');
const image = { resourceId: '40000000-0000-4000-8000-000000000001', status: 'available' as const, name: 'accepted-image.png', mediaType: 'image/png', byteLength: String(imageBytes.length), sha256: 'bdc9537320ea88ca351b0cd5675bef8a24c5da9b2da14b2cf2254e9f85413f7c', error: null };
let releaseCurrent = () => {}, releaseHistory = () => {}, releaseBefore = () => {};
const currentGate = new Promise<void>(resolve => { releaseCurrent = resolve; });
const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
const beforeGate = new Promise<void>(resolve => { releaseBefore = resolve; });
type HistorySnapshotPatch = Partial<Pick<SessionSnapshot, 'historyEpoch' | 'executionGeneration' | 'lastEventSeq' | 'lastTimelineSeq'>>;
const historyControls = new Map<string, { snapshot: (patch: HistorySnapshotPatch) => void; upsert: (sequence: number, revision: string, text: string) => void }>();
declare global { interface Window { botViewport: { metrics: typeof metrics; releaseCurrent: () => void; releaseHistory: () => void; releaseBefore: () => void; publishSnapshot: (botId: string, patch: HistorySnapshotPatch) => void; upsert: (botId: string, sequence: number, revision: string, text: string) => void }; botViewportOptions?: BotViewportOptions } }
window.botViewport = { metrics, releaseCurrent, releaseHistory, releaseBefore,
  publishSnapshot: (botId, patch) => historyControls.get(botId)!.snapshot(patch),
  upsert: (botId, sequence, revision, text) => historyControls.get(botId)!.upsert(sequence, revision, text),
};
export function createBotSessionApi(binding: BotSessionBinding): SessionApi {
  metrics.bindings.push(JSON.stringify(binding));
  const options = window.botViewportOptions;
  const archived = options?.scenario === 'archive';
  let snapshot: SessionSnapshot = {
    protocol: 'daynight.session.v1', schemaVersion: 1, projectionVersion: 1,
    sessionId: binding.sessionId, testExecutionId: binding.testExecutionId,
    executionGeneration: '1', connectionEpoch: '1',
    identity: { ownerUserId: binding.ownerUserId, controllerId: '00000007-1111-4111-8111-111111111111', controllerInstanceId: '00000008-1111-4111-8111-111111111111', agentControlMode: 'web', provider: 'codex', nativeSessionId: 'viewport-fixture' },
    sessionRevision: '1', historyEpoch: options?.historyEpoch ?? 'viewport-history', lastEventSeq: options?.lastEventSeq ?? '0', lastTimelineSeq: options?.scenario === 'persistent' ? String(options.persistentTail?.end ?? 100) : '2000',
    initialInputState: 'not_required', synchronized: !archived, lifecycle: archived ? 'archived' : 'active', connectionState: archived ? 'disconnected' : 'connected', activity: 'idle', currentTurnId: null,
    capabilities: { send: true, steer: true, cancel: true, respond: true }, operations: { canSend: !archived, canCancel: false, canRespond: false },
  };
  const page = (start: number, end: number) => ({
    sessionId: binding.sessionId, historyEpoch: snapshot.historyEpoch,
    items: Array.from({ length: end - start + 1 }, (_, index) => ({ kind: 'assistant_message' as const, entryId: `${binding.botId}-${index + start}`, entrySeq: String(index + start), revision: '1', content: [{ type: 'text' as const, text: `### Message ${index + start}\n\nLong history from ${binding.botId}. Each message has sufficient content to exercise a bounded timeline.\n\nThis paragraph must not push the composer below the window.` }] })),
    resources: [], beforeCursor: start > 1 ? String(start) : null, afterCursor: null, hasMoreBefore: start > 1, hasMoreAfter: false, lastEventSeq: options?.lastEventSeq ?? '0',
  });
  const content = () => ({
    ...page(1, 1),
    items: options?.scenario === 'empty' ? [] : [{ kind: 'assistant_message' as const, entryId: `${binding.botId}-content`, entrySeq: '1', revision: '1', content: [{ type: 'text' as const, text: options?.text ?? 'Saved assistant response.' }] }],
  });
  const persistentPage = (start: number, end: number) => ({
    ...page(start, end),
    items: page(start, end).items.map(entry => ({ ...entry,
      entryId: `30000000-0000-4000-8000-${String(Number(binding.botId.slice(-12)) * 10000 + Number(entry.entrySeq)).padStart(12, '0')}`,
      revision: options?.revision ?? '1',
      content: [{ type: 'text' as const, text: `Persistent message ${entry.entrySeq} from ${binding.botId}. Revision ${options?.revision ?? '1'}.\n\nActual accepted history survives browser reopening.` }, ...(entry.entrySeq === '80' ? [{ type: 'resource' as const, resourceId: image.resourceId, label: image.name }] : [])],
    })), resources: [image],
  });
  const archive = (): SessionArchive => ({
    schemaVersion: 1, ...sessionFence(snapshot), controllerId: snapshot.identity.controllerId,
    controllerInstanceId: snapshot.identity.controllerInstanceId, provider: snapshot.identity.provider,
    nativeSessionId: snapshot.identity.nativeSessionId, entries: content().items, resources: [],
  });
  return {
    current: async () => { if (options?.holdCurrent) await currentGate; return { status: 'registered', session: snapshot }; },
    timeline: async (_id, direction, cursor) => {
      if (direction === 'tail') {
        metrics.tail++;
        if (options?.holdHistory) await historyGate;
        if (options?.scenario === 'persistent') return persistentPage(options.persistentTail?.start ?? 1, options.persistentTail?.end ?? 100);
        if (options?.scenario === 'error') throw new Error('Controlled history unavailable');
        if (options?.scenario === 'hot-switch') {
          const tail = page(1901, 2000);
          return { ...tail, items: tail.items.map(entry => entry.entrySeq === '1950' ? { kind: 'tool_call' as const, callId: 'hot-switch-tool', entryId: entry.entryId, entrySeq: entry.entrySeq, revision: entry.revision, name: 'commandExecution', status: 'completed' as const, input: 'ls -la', output: [{ type: 'text' as const, text: 'Retained tool output' }], truncated: false } : entry) };
        }
        return options ? content() : page(1901, 2000);
      }
      metrics.before++;
      if (options?.holdBefore) await beforeGate;
      const end = Number(cursor) - 1;
      return options?.scenario === 'persistent' ? persistentPage(Math.max(1, end - 99), end) : page(Math.max(1, end - 99), end);
    },
    channel: (_id, _after, receive) => {
      metrics.channels++; let active = true;
      const control = {
        snapshot(patch: HistorySnapshotPatch) {
          snapshot = { ...snapshot, sessionRevision: String(BigInt(snapshot.sessionRevision) + 1n), ...patch };
          if (active) receive({ protocol: snapshot.protocol, type: 'snapshot', userId: binding.ownerUserId, snapshot, cursor: 'replacement' });
        },
        upsert(sequence: number, revision: string, text: string) {
          const eventSeq = String(BigInt(snapshot.lastEventSeq) + 1n);
          snapshot = { ...snapshot, lastEventSeq: eventSeq, lastTimelineSeq: String(Math.max(Number(snapshot.lastTimelineSeq), sequence)) };
          const entry = { ...persistentPage(sequence, sequence).items[0]!, revision, content: [{ type: 'text' as const, text }] };
          if (active) receive({ protocol: snapshot.protocol, type: 'event', cursor: `event-${eventSeq}`, event: { protocol: snapshot.protocol, ...sessionFence(snapshot), connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq, kind: 'timeline_upsert', payload: entry } });
        },
      };
      historyControls.set(binding.botId, control);
      queueMicrotask(() => { if (active) receive({ protocol: snapshot.protocol, type: 'snapshot', userId: binding.ownerUserId, snapshot, cursor: 'zero' }); });
      return { close() { active = false; metrics.closed++; if (historyControls.get(binding.botId) === control) historyControls.delete(binding.botId); } };
    },
    command: async () => { metrics.commands++; throw new Error('No command is expected in viewport acceptance.'); },
    operation: async () => { throw new Error('No operation is expected.'); },
    archive: async () => {
      metrics.archives++;
      if (!archived) throw new Error('No archive is expected.');
      return { state: 'ready', sha256: 'a'.repeat(64), byteLength: String(new TextEncoder().encode(JSON.stringify(archive())).length), errorCode: null };
    },
    archiveContent: async () => {
      metrics.archiveContents++;
      if (!archived) throw new Error('No archive is expected.');
      return archive();
    },
    resource: async () => { metrics.resourceReads++; return options?.scenario === 'persistent' ? new Blob([imageBytes], { type: 'image/png' }) : new Blob(); }, resources: () => { throw new Error('Unexpected image resource client call.'); }, resourceUrl: () => '/unused',
  };
}
