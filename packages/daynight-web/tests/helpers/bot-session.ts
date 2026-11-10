import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import type { BotSessionBinding, SessionApi } from '../../src/api/sessions';
import type { BrowserMessage, TimelinePage } from '../../../daynight/src/session/controller-protocol';
import type { SessionSnapshot } from '../../src/api/types';

export const botOwner = '00000009-1111-4111-8111-111111111111';
export const botBinding = (n: number): BotSessionBinding => ({ ownerUserId: botOwner, botId: `000000${n}0-1111-4111-8111-111111111111`, sessionId: `000000${n}1-1111-4111-8111-111111111111`, testExecutionId: `000000${n}2-1111-4111-8111-111111111111` });
export function botFixture(binding = botBinding(1)) {
  const task = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const { claimId: _claim, ...base } = task;
  const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = task.identity;
  let snapshot: SessionSnapshot = { ...base, sessionId: binding.sessionId, testExecutionId: binding.testExecutionId, identity: { ...identity, ownerUserId: binding.ownerUserId }, activity: 'idle', currentTurnId: null, initialInputState: 'not_required', lastEventSeq: '0' };
  let receive: (message: BrowserMessage) => void = () => {};
  const page: TimelinePage = { sessionId: binding.sessionId, historyEpoch: snapshot.historyEpoch, items: [{ kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: `Message ${binding.botId}` }] }], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const channel = { close: vi.fn() };
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: snapshot })), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(async () => { throw new Error('receipt pending'); }), resource: vi.fn(), resources: () => { throw new Error('Unexpected image resource client call.'); }, resourceUrl: () => '/unused', channel: vi.fn((_id, _after, handler) => { receive = handler; queueMicrotask(() => receive({ protocol: snapshot.protocol, type: 'snapshot', userId: binding.ownerUserId, snapshot, cursor: 'zero' })); return channel; }) };
  return { binding, api, channel, page, snapshot: () => snapshot, change: (next: SessionSnapshot) => { snapshot = next; }, receive: (message: BrowserMessage) => receive(message) };
}
