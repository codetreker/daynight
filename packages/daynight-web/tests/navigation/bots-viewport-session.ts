export * from '../../src/api/sessions';
import type { BotSessionBinding, SessionApi } from '../../src/api/sessions';
import type { SessionSnapshot } from '../../src/api/types';

// Only the Bot transport is controlled. AuthenticatedApp, the cache, client,
// renderer, composer and pagination hooks are production implementations.
const metrics = { tail: 0, before: 0, commands: 0, channels: 0, closed: 0, bindings: [] as string[] };
declare global { interface Window { botViewport: { metrics: typeof metrics } } }
window.botViewport = { metrics };
export function createBotSessionApi(binding: BotSessionBinding): SessionApi {
  metrics.bindings.push(JSON.stringify(binding));
  const snapshot: SessionSnapshot = {
    protocol: 'daynight.session.v1', schemaVersion: 1, projectionVersion: 1,
    sessionId: binding.sessionId, testExecutionId: binding.testExecutionId,
    executionGeneration: '1', connectionEpoch: '1',
    identity: { ownerUserId: binding.ownerUserId, controllerId: '00000007-1111-4111-8111-111111111111', controllerInstanceId: '00000008-1111-4111-8111-111111111111', agentControlMode: 'web', provider: 'codex', nativeSessionId: 'viewport-fixture' },
    sessionRevision: '1', historyEpoch: 'viewport-history', lastEventSeq: '0', lastTimelineSeq: '2000',
    initialInputState: 'not_required', synchronized: true, lifecycle: 'active', connectionState: 'connected', activity: 'idle', currentTurnId: null,
    capabilities: { send: true, steer: true, cancel: true, respond: true }, operations: { canSend: true, canCancel: false, canRespond: false },
  };
  const page = (start: number, end: number) => ({
    sessionId: binding.sessionId, historyEpoch: snapshot.historyEpoch,
    items: Array.from({ length: end - start + 1 }, (_, index) => ({ kind: 'assistant_message' as const, entryId: `${binding.botId}-${index + start}`, entrySeq: String(index + start), revision: '1', content: [{ type: 'text' as const, text: `### Message ${index + start}\n\nLong history from ${binding.botId}. Each message has sufficient content to exercise a bounded timeline.\n\nThis paragraph must not push the composer below the window.` }] })),
    resources: [], beforeCursor: start > 1 ? String(start) : null, afterCursor: null, hasMoreBefore: start > 1, hasMoreAfter: false, lastEventSeq: '0',
  });
  return {
    current: async () => ({ status: 'registered', session: snapshot }),
    timeline: async (_id, direction, cursor) => {
      if (direction === 'tail') { metrics.tail++; return page(1901, 2000); }
      metrics.before++; const end = Number(cursor) - 1; return page(Math.max(1, end - 99), end);
    },
    channel: (_id, _after, receive) => {
      metrics.channels++; let active = true;
      queueMicrotask(() => { if (active) receive({ protocol: snapshot.protocol, type: 'snapshot', userId: binding.ownerUserId, snapshot, cursor: 'zero' }); });
      return { close() { active = false; metrics.closed++; } };
    },
    command: async () => { metrics.commands++; throw new Error('No command is expected in viewport acceptance.'); },
    operation: async () => { throw new Error('No operation is expected.'); },
    archive: async () => { throw new Error('No archive is expected.'); },
    archiveContent: async () => { throw new Error('No archive is expected.'); },
    resource: async () => new Blob(), resourceUrl: () => '/unused',
  };
}
