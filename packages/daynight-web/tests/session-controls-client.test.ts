import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import type { SessionApi } from '../src/api/sessions';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionOperation } from '../src/api/types';
import { sessionControlGate, emptySessionState } from '../src/features/task-agent-session/state';
import { sessionBinding } from '../../daynight/src/session/protocol';
import type { TaskSessionSnapshot } from './helpers/session';
const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); });
function fixture(storage: Storage | null = null) {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), lastEventSeq: '0', controls: { revision: '4', settings: [{ id: 'model', category: 'model', label: 'Model', value: 'a', description: null, mutable: true, scope: 'session', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], commands: [{ id: 'native-compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } };
  let receive!: (message: BrowserMessage) => void, paused = false;
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), command: vi.fn(async (_id, command) => ({ protocol: command.protocol, ...sessionBinding(command), sessionId: command.sessionId, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null } as SessionOperation)), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused', channel: vi.fn((_id, _after, next) => { receive = next; return { close: vi.fn() }; }) };
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, isCurrent: () => true, isPaused: () => paused, onPrincipalMismatch: vi.fn(), storage }); clients.push(client);
  return { api, s, client, pause: () => { paused = true; }, ready: async () => { await client.start(); receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot: s, cursor: 'zero' }); await vi.waitFor(() => expect(client.snapshot().connected).toBe(true)); } };
}
it('rejects stale catalogs, unknown settings/commands, and auth pause before any control dispatch', async () => {
  const f = fixture();await f.ready();
  await expect(f.client.updateSetting('model', 'b', '3')).rejects.toThrow();
  await expect(f.client.updateSetting('model', 'unlisted', '4')).rejects.toThrow();
  await expect(f.client.executeCommand('not-listed', '', '4')).rejects.toThrow();
  await expect(f.client.send('/not-a-message')).rejects.toThrow();
  f.pause();
  await expect(f.client.updateSetting('model', 'b', '4')).rejects.toThrow();
  await expect(f.client.executeCommand('native-compact', '', '4')).rejects.toThrow();
  await expect(f.client.refreshControls()).rejects.toThrow();
  expect(f.api.command).not.toHaveBeenCalled();
});
it('records setting intent without treating it as the confirmed native value or modifying a draft', async () => {
  const f = fixture();await f.ready();f.client.setDraft('keep my draft');
  await f.client.updateSetting('model', 'b', '4');
  expect(f.client.snapshot().state.snapshot?.controls?.settings[0]?.value).toBe('a');
  expect(f.client.snapshot().settingIntents.get('model')).toMatchObject({ value: 'b', confirmedValue: 'a' });
  expect(f.client.snapshot().draft.text).toBe('keep my draft');
  expect(vi.mocked(f.api.command).mock.calls[0]?.[1]).toMatchObject({ kind: 'update_setting', payload: { settingId: 'model', value: 'b', expectedControlsRevision: '4' } });
});
it('keeps unknown command delivery and draft, then clears only the accepted original draft revision', async () => {
  const f = fixture();await f.ready();f.client.setDraft('/compact');
  vi.mocked(f.api.command).mockRejectedValue(new Error('lost receipt'));
  await expect(f.client.executeCommand('native-compact', '', '4', '/compact')).rejects.toThrow('lost receipt');
  const command = vi.mocked(f.api.command).mock.calls[0]![1];
  expect(f.client.snapshot().draft).toMatchObject({ text: '/compact', submission: { operationId: command.operationId, kind: 'execute_command' } });
  await expect(f.client.executeCommand('native-compact', '', '4', '/compact')).rejects.toThrow();
  vi.mocked(f.api.operation).mockResolvedValue({ protocol: command.protocol, ...sessionBinding(command), sessionId: command.sessionId, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: 'execute_command', state: 'provider_accepted', providerResult: 'handled', error: null });
  f.client.setDraft('new draft');await f.client.checkOperation(command.operationId);
  expect(f.client.snapshot().draft.text).toBe('new draft');expect(f.client.snapshot().draft.submission).toBeNull();expect(f.api.command).toHaveBeenCalledOnce();
});
it('clears a command draft on provider acceptance and never binds controls refresh to draft input', async () => {
  const f = fixture();await f.ready();f.client.setDraft('/compact');
  const reply = vi.mocked(f.api.command).getMockImplementation()!;
  vi.mocked(f.api.command).mockImplementation(async (...args) => ({ ...await reply(...args), state: 'provider_accepted' }));
  await f.client.executeCommand('native-compact', '', '4', '/compact');expect(f.client.snapshot().draft.text).toBe('');
  vi.mocked(f.api.command).mockImplementation(reply);f.client.setDraft('stay');await f.client.refreshControls();expect(f.client.snapshot().draft.text).toBe('stay');
});
it('restores a pending setting intent within its session fence and invalidation removes it', async () => {
  const storage = window.sessionStorage;storage.clear();const f = fixture(storage);await f.ready();
  vi.mocked(f.api.command).mockRejectedValue(new Error('lost receipt'));
  await expect(f.client.updateSetting('model', 'b', '4')).rejects.toThrow();f.client.close();
  const restored = fixture(storage);await restored.ready();
  expect(restored.client.snapshot().settingIntents.get('model')).toMatchObject({ value: 'b', confirmedValue: 'a' });
  restored.client.invalidate();expect(restored.client.snapshot().settingIntents.size).toBe(0);
  expect([...Array(storage.length)].map((_, i) => storage.key(i)).some(key => key?.startsWith(`daynight:session-operations:${userId}:`))).toBe(false);
});

it.each(['initializing','stopped','unknown'] as const)('does not authorize controls from an otherwise mutable %s snapshot', activity => {
  const f=fixture();
  expect(sessionControlGate({...emptySessionState(),snapshot:{...f.s,activity}},true)).toBe(false);
});
