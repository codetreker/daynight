import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import type { SessionApi } from '../src/api/sessions';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionOperation } from '../src/api/types';
import { sessionControlGate, emptySessionState } from '../src/features/task-agent-session/state';
import { sessionBinding, sessionFence } from '../../daynight/src/session/protocol';
import { SessionDraftStore } from '../src/features/task-agent-session/drafts/draft-store';
import type { TaskSessionSnapshot } from './helpers/session';
const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
const stores: SessionDraftStore[] = [];
afterEach(async () => { const closing = clients.splice(0); closing.forEach(client => client.close()); await Promise.all(closing.map(client => client.imageDrafts.close())); stores.splice(0).forEach(store => store.close()); });
function fixture(storage: Storage | null = null, ownerUserId = userId) {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), lastEventSeq: '0', controls: { revision: '4', settings: [{ id: 'model', category: 'model', label: 'Model', value: 'a', description: null, mutable: true, scope: 'session', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], commands: [{ id: 'native-compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } };
  let receive!: (message: BrowserMessage) => void, paused = false;
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: s })), timeline: vi.fn(async () => page), command: vi.fn(async (_id, command) => ({ protocol: command.protocol, ...sessionBinding(command), sessionId: command.sessionId, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'handled', error: null } as SessionOperation)), operation: vi.fn(), resource: vi.fn(), resources: () => { throw new Error('Unexpected image resource client call.'); }, resourceUrl: () => '/unused', channel: vi.fn((_id, _after, next) => { receive = next; return { close: vi.fn() }; }) };
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, ownerUserId, isCurrent: () => true, isPaused: () => paused, onPrincipalMismatch: vi.fn(), storage });
  client.setCurrentReadVisible(true); clients.push(client);
  return { api, s, client, pause: () => { paused = true; }, ready: async () => { await client.start(); receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot: s, cursor: 'zero' }); await vi.waitFor(() => expect(client.snapshot().connected).toBe(true)); } };
}
async function durableDraft(f: ReturnType<typeof fixture>, text?: string) {
  const store = new SessionDraftStore(); stores.push(store);
  const identity = { target: { serverOrigin: window.location.origin, actorUserId: userId, fence: sessionFence(f.s), expectedNativeSessionId: f.s.identity.nativeSessionId }, resolver: { kind: 'task' as const, projectId: f.s.identity.projectId, taskId: f.s.identity.taskId } };
  if (text !== undefined) await store.importLegacy(identity, { text, revision: '1', submission: null });
  f.client.setImageDraftAdmission(true, true); await f.client.imageDrafts.sync();
  return { store, identity };
}
it.each(['confirmed', 'provider_accepted'] as const)('settles a durable command draft on exact %s without changing its command payload', async state => {
  const f = fixture(); await f.ready(); const text = '  /compact   keep\n  spacing  ', args = '  keep\n  spacing  ';
  const durable = await durableDraft(f, text), reply = vi.mocked(f.api.command).getMockImplementation()!;
  vi.mocked(f.api.command).mockImplementation(async (...parameters) => {
    expect((await durable.store.readExisting(durable.identity))?.submission).toMatchObject({ state: 'dispatch_claimed', kind: 'execute_command', snapshot: { text } });
    return { ...await reply(...parameters), state };
  });
  await f.client.executeCommand('native-compact', args, '4', text);
  expect(f.api.command).toHaveBeenCalledOnce(); expect(vi.mocked(f.api.command).mock.calls[0]![1]).toMatchObject({ kind: 'execute_command', payload: { commandId: 'native-compact', arguments: args, expectedControlsRevision: '4', expectedTurnId: null } });
  expect(f.client.snapshot().draft).toMatchObject({ text: '', submission: null });
  expect((await durable.store.readExisting(durable.identity))?.editable?.text).toBe('');
});
it('restores a durable unknown command under its original operation and preserves an explicitly created successor', async () => {
  const f = fixture(); await f.ready(); const durable = await durableDraft(f, '/compact');
  vi.mocked(f.api.command).mockRejectedValue(new Error('lost receipt'));
  await f.client.executeCommand('native-compact', '', '4', '/compact').catch(() => {});
  const command = vi.mocked(f.api.command).mock.calls[0]![1];
  expect((await durable.store.readExisting(durable.identity))?.submission).toMatchObject({ operationId: command.operationId, kind: 'execute_command', state: 'unknown' });
  f.client.close(); await f.client.imageDrafts.close();
  const next = fixture(); await next.ready();
  const receipt: SessionOperation = { protocol: command.protocol, ...sessionFence(command), operationId: command.operationId, kind: 'execute_command', state: 'unknown', providerResult: null, error: null };
  vi.mocked(next.api.operation).mockResolvedValue(receipt); await durableDraft(next);
  expect(next.client.snapshot().draft.submission).toMatchObject({ operationId: command.operationId, kind: 'execute_command' });
  await expect(next.client.executeCommand('native-compact', '', '4', '/compact')).rejects.toThrow();
  expect(next.api.command).not.toHaveBeenCalled();
  await next.client.imageDrafts.continueEditing(); next.client.setDraft('new successor'); await next.client.imageDrafts.flush();
  vi.mocked(next.api.operation).mockResolvedValue({ ...receipt, state: 'provider_accepted' }); await next.client.checkOperation(command.operationId);
  expect(next.client.snapshot().draft).toMatchObject({ text: 'new successor', submission: null }); expect(next.api.command).not.toHaveBeenCalled();
});
it('keeps toolbar command execution independent from an unrelated durable text draft', async () => {
  const f = fixture(); await f.ready(); const durable = await durableDraft(f, 'keep this text');
  await f.client.executeCommand('native-compact', '', '4');
  expect(f.api.command).toHaveBeenCalledOnce(); expect((await durable.store.readExisting(durable.identity))?.editable?.text).toBe('keep this text');
  expect((await durable.store.readExisting(durable.identity))?.submission).toBeNull();
});
it('resumes a prepared durable native command with its original IDs after reopening', async () => {
  const f = fixture(); await f.ready(); const durable = await durableDraft(f, '/compact');
  vi.spyOn(SessionDraftStore.prototype, 'claimDispatch').mockRejectedValueOnce(new Error('page ended before dispatch claim'));
  await f.client.executeCommand('native-compact', '', '4', '/compact');
  const prepared = (await durable.store.readExisting(durable.identity))!.submission!; expect(prepared.state).toBe('prepared'); expect(f.api.command).not.toHaveBeenCalled();
  f.client.close(); await f.client.imageDrafts.close();
  const next = fixture(); await next.ready(); await durableDraft(next); expect(next.api.command).not.toHaveBeenCalled();
  expect(next.client.imageDrafts.getSnapshot().canResumePrepared).toBe(true);
  await next.client.imageDrafts.resumePrepared();
  expect(vi.mocked(next.api.command).mock.calls[0]![1]).toEqual(prepared.command); expect(next.api.command).toHaveBeenCalledOnce(); expect(next.client.snapshot().draft.text).toBe('');
});
it.each(['revision', 'availability'] as const)('allows safe cancellation of a prepared durable command after its catalog %s changes', async change => {
  const f = fixture(); await f.ready(); const durable = await durableDraft(f, '/compact');
  vi.spyOn(SessionDraftStore.prototype, 'claimDispatch').mockRejectedValueOnce(new Error('page ended before dispatch claim'));
  await f.client.executeCommand('native-compact', '', '4', '/compact');
  const prepared = (await durable.store.readExisting(durable.identity))!.submission!; f.client.close(); await f.client.imageDrafts.close();
  const next = fixture(); Object.assign(next.s, { controls: { ...next.s.controls!, revision: change === 'revision' ? '5' : '4', commands: next.s.controls!.commands.map(command => ({ ...command, available: change !== 'availability' })) } });
  await next.ready(); await durableDraft(next);
  const recovery = next.client.imageDrafts.getSnapshot().recoveries.find(entry => entry.ref.operationId === prepared.operationId)!;
  expect(next.client.imageDrafts.getSnapshot().canResumePrepared).toBe(false); expect(recovery.canCancelPrepared).toBe(true);
  await next.client.imageDrafts.cancelPrepared(recovery.ref);
  expect((await durable.store.readExisting(durable.identity))?.editable?.text).toBe('/compact'); expect(next.client.imageDrafts.getSnapshot().executionBlocked).toBe(false); expect(next.api.command).not.toHaveBeenCalled();
});
it('does not add the message send capability gate to a durable native command', async () => {
  const f = fixture(); Object.assign(f.s, { capabilities: { ...f.s.capabilities, send: false }, operations: { ...f.s.operations, canSend: false } }); await f.ready();
  await durableDraft(f, '/compact'); expect(f.client.imageDrafts.getSnapshot().canSend).toBe(false);
  await f.client.executeCommand('native-compact', '', '4', '/compact'); expect(f.api.command).toHaveBeenCalledOnce(); expect(f.client.snapshot().draft.text).toBe('');
});
it.each([['/compact', 'different args'], ['/another', ''], ['/compact-extra', '']])('refuses mismatched durable command text %s and arguments %s before freezing', async (text, args) => {
  const f = fixture(); await f.ready(); const durable = await durableDraft(f, text);
  await expect(f.client.executeCommand('native-compact', args, '4', text)).rejects.toThrow('image_command_unavailable');
  expect(f.api.command).not.toHaveBeenCalled(); expect((await durable.store.readExisting(durable.identity))?.submission).toBeNull();
});
it('rejects stale catalogs, unknown settings/commands, and auth pause before any control dispatch', async () => {
  const f = fixture();await f.ready();
  await expect(f.client.updateSetting('model', 'b', '3')).rejects.toThrow();
  await expect(f.client.updateSetting('model', 'unlisted', '4')).rejects.toThrow();
  await expect(f.client.executeCommand('not-listed', '', '4')).rejects.toThrow();
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

it('refuses all native catalog mutations for a non-owner even when the catalog advertises them', async () => {
  const f = fixture(null, '00000010-1111-4111-8111-111111111111'); await f.ready();
  expect(sessionControlGate(f.client.snapshot().state, true)).toBe(true);
  await expect(f.client.updateSetting('model', 'b', '4')).rejects.toThrow();
  await expect(f.client.executeCommand('native-compact', '', '4')).rejects.toThrow();
  await expect(f.client.refreshControls()).rejects.toThrow();
  expect(f.api.command).not.toHaveBeenCalled();
  expect(f.client.snapshot()).toMatchObject({ status: 'ready', connected: true });
});
