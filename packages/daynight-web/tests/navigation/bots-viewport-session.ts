export * from '../../src/api/sessions';
import type { BotSessionBinding, SessionApi } from '../../src/api/sessions';
import type { SessionSnapshot } from '../../src/api/types';
import type { SessionArchive } from '../../../daynight/src/session/archive';
import { sessionFence } from '../../../daynight/src/session/protocol';

export type BotViewportOptions = {
  readonly scenario: 'empty' | 'long' | 'error' | 'archive' | 'hot-switch' | 'persistent';
  readonly text?: string;
  readonly holdCurrent?: boolean;
  readonly holdHistory?: boolean;
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
const image = { resourceId: '40000000-0000-4000-8000-000000000001', status: 'available' as const, name: 'accepted-image.png', mediaType: 'image/png', byteLength: '68', sha256: 'd126d616641d42ac8b0a07ec302c9fa1ec049f86200931a0a60c8f3080284b77', error: null };
let releaseCurrent = () => {}, releaseHistory = () => {};
const currentGate = new Promise<void>(resolve => { releaseCurrent = resolve; });
const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
declare global { interface Window { botViewport: { metrics: typeof metrics; releaseCurrent: () => void; releaseHistory: () => void }; botViewportOptions?: BotViewportOptions } }
window.botViewport = { metrics, releaseCurrent, releaseHistory };
export function createBotSessionApi(binding: BotSessionBinding): SessionApi {
  metrics.bindings.push(JSON.stringify(binding));
  const options = window.botViewportOptions;
  const archived = options?.scenario === 'archive';
  const snapshot: SessionSnapshot = {
    protocol: 'daynight.session.v1', schemaVersion: 1, projectionVersion: 1,
    sessionId: binding.sessionId, testExecutionId: binding.testExecutionId,
    executionGeneration: '1', connectionEpoch: '1',
    identity: { ownerUserId: binding.ownerUserId, controllerId: '00000007-1111-4111-8111-111111111111', controllerInstanceId: '00000008-1111-4111-8111-111111111111', agentControlMode: 'web', provider: 'codex', nativeSessionId: 'viewport-fixture' },
    sessionRevision: '1', historyEpoch: options?.historyEpoch ?? 'viewport-history', lastEventSeq: options?.lastEventSeq ?? '0', lastTimelineSeq: '2000',
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
        if (options?.scenario === 'persistent') return {
          ...page(options.persistentTail?.start ?? 1, options.persistentTail?.end ?? 100),
          items: page(options.persistentTail?.start ?? 1, options.persistentTail?.end ?? 100).items.map(entry => ({ ...entry,
            entryId: `30000000-0000-4000-8000-${String(Number(binding.botId.slice(-12)) * 10000 + Number(entry.entrySeq)).padStart(12, '0')}`,
            revision: options.revision ?? '1',
            content: [{ type: 'text' as const, text: `Persistent message ${entry.entrySeq} from ${binding.botId}. Revision ${options.revision ?? '1'}.\n\nActual accepted history survives browser reopening.` }, ...(entry.entrySeq === '80' ? [{ type: 'resource' as const, resourceId: image.resourceId, label: image.name }] : [])],
          })),
          resources: [image],
        };
        if (options?.scenario === 'error') throw new Error('Controlled history unavailable');
        if (options?.scenario === 'hot-switch') {
          const tail = page(1901, 2000);
          return { ...tail, items: tail.items.map(entry => entry.entrySeq === '1950' ? { kind: 'tool_call' as const, callId: 'hot-switch-tool', entryId: entry.entryId, entrySeq: entry.entrySeq, revision: entry.revision, name: 'commandExecution', status: 'completed' as const, input: 'ls -la', output: [{ type: 'text' as const, text: 'Retained tool output' }], truncated: false } : entry) };
        }
        return options ? content() : page(1901, 2000);
      }
      metrics.before++; const end = Number(cursor) - 1; return page(Math.max(1, end - 99), end);
    },
    channel: (_id, _after, receive) => {
      metrics.channels++; let active = true;
      queueMicrotask(() => { if (active) receive({ protocol: snapshot.protocol, type: 'snapshot', userId: binding.ownerUserId, snapshot, cursor: 'zero' }); });
      return { close() { active = false; metrics.closed++; } };
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
    resource: async () => { metrics.resourceReads++; return options?.scenario === 'persistent' ? new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='), char => char.charCodeAt(0))], { type: 'image/png' }) : new Blob(); }, resources: () => { throw new Error('Unexpected image resource client call.'); }, resourceUrl: () => '/unused',
  };
}
