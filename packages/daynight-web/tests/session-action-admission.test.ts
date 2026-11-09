import { afterEach, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { OperationRequestError } from '../src/features/task-agent-session/operation-error';
import { sessionBinding, type SessionCommand, type SessionOperation } from '../../daynight/src/session/protocol';
import { botFixture, botOwner } from './helpers/bot-session';

const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); sessionStorage.clear(); });

const interaction = { interactionId: 'approval', revision: '1', state: 'pending' as const, kind: 'approval' as const, title: 'Run tool', detail: 'Tool request', actions: ['allow_once' as const] };
function receipt(command: SessionCommand, state: SessionOperation['state'] = 'confirmed'): SessionOperation {
  return { protocol: command.protocol, ...sessionBinding(command), sessionId: command.sessionId, executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state, providerResult: 'handled', error: null };
}
function fixture(initialActionAdmitted?: boolean) {
  const f = botFixture();
  f.change({ ...f.snapshot(), activity: 'working', currentTurnId: 'turn-1', operations: { canSend: true, canCancel: true, canRespond: true }, controls: { revision: '4', settings: [{ id: 'model', category: 'model', label: 'Model', value: 'a', description: null, mutable: true, scope: 'session', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } });
  vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, items: [...f.page.items, { kind: 'interaction', entryId: 'approval', entrySeq: '2', revision: '1', interaction }] });
  vi.mocked(f.api.command).mockImplementation(async (_id, command) => receipt(command));
  const client = new TaskSessionClient({ api: f.api, userId: botOwner, testSessionId: f.binding.sessionId, bot: f.binding, ...(initialActionAdmitted === undefined ? {} : { initialActionAdmitted }), isCurrent: () => true, onPrincipalMismatch: vi.fn(), storage: sessionStorage });
  clients.push(client);
  return { ...f, client, ready: async () => { await client.start(); await vi.waitFor(() => expect(client.snapshot().historyReady).toBe(true)); } };
}

const actions = {
  send: (client: TaskSessionClient) => client.send('draft'),
  cancel: (client: TaskSessionClient) => client.cancel(),
  respond: (client: TaskSessionClient) => client.respond(interaction, { kind: 'approval', action: 'allow_once' }),
  updateSetting: (client: TaskSessionClient) => client.updateSetting('model', 'b', '4'),
  executeCommand: (client: TaskSessionClient) => client.executeCommand('compact', '', '4', 'draft'),
  refreshControls: (client: TaskSessionClient) => client.refreshControls(),
};
const stored = () => Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)]));

it.each(Object.keys(actions) as (keyof typeof actions)[])('refuses %s before generating IDs or creating recoverable side effects when initial admission is false', async action => {
  const f = fixture(false); await f.ready(); f.client.setDraft('draft');
  const before = f.client.snapshot(), disk = stored(), uuid = vi.spyOn(crypto, 'randomUUID');
  const failure = await actions[action](f.client).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(OperationRequestError);
  expect(uuid).not.toHaveBeenCalled();
  expect(f.api.command).not.toHaveBeenCalled();
  expect(f.client.snapshot()).toMatchObject({ actionAdmitted: false, connected: true, authPaused: false });
  expect(f.client.snapshot().state.operations).toBe(before.state.operations);
  expect(f.client.snapshot().state.responseTargets).toBe(before.state.responseTargets);
  expect(f.client.snapshot().operationProgress).toBe(before.operationProgress);
  expect(f.client.snapshot().settingIntents).toBe(before.settingIntents);
  expect(f.client.snapshot().draft).toBe(before.draft);
  expect(stored()).toEqual(disk);
});

it('changes admission synchronously without duplicate publication, closing reads, or preventing local drafts', async () => {
  const f = fixture(); await f.ready();
  expect(f.client.snapshot().actionAdmitted).toBe(true);
  await f.client.send('default admitted');
  const listener = vi.fn(), unsubscribe = f.client.subscribe(listener);
  f.client.setActionAdmission(true);
  expect(listener).not.toHaveBeenCalled();
  f.client.setActionAdmission(false);
  expect(f.client.snapshot().actionAdmitted).toBe(false);
  expect(listener).toHaveBeenCalledOnce();
  const revoked = f.client.snapshot();
  f.client.setActionAdmission(false);
  expect(f.client.snapshot()).toBe(revoked);
  expect(listener).toHaveBeenCalledOnce();
  expect(f.client.canInteract()).toBe(true);
  expect(f.client.snapshot()).toMatchObject({ connected: true, historyReady: true, authPaused: false });
  expect(f.channel.close).not.toHaveBeenCalled();
  unsubscribe();
  f.client.setDraft('editable while checking');
  expect(f.client.snapshot().draft.text).toBe('editable while checking');
});

it.each(Object.keys(actions) as (keyof typeof actions)[])('rejects a captured %s call after synchronous revocation and never dispatches it on readmission', async action => {
  const f = fixture(); await f.ready(); f.client.setDraft('draft');
  const staleCall = () => actions[action](f.client);
  f.client.setActionAdmission(false);
  const before = f.client.snapshot(), disk = stored(), uuid = vi.spyOn(crypto, 'randomUUID');
  const failure = await staleCall().catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(OperationRequestError);
  expect(uuid).not.toHaveBeenCalled();
  expect(f.api.command).not.toHaveBeenCalled();
  expect(f.client.snapshot().state.operations).toBe(before.state.operations);
  expect(f.client.snapshot().state.responseTargets).toBe(before.state.responseTargets);
  expect(f.client.snapshot().operationProgress).toBe(before.operationProgress);
  expect(f.client.snapshot().settingIntents).toBe(before.settingIntents);
  expect(f.client.snapshot().draft).toBe(before.draft);
  expect(stored()).toEqual(disk);
  vi.useFakeTimers();
  f.client.setActionAdmission(true);
  f.client.syncAvailability();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.api.command).not.toHaveBeenCalled();
  await staleCall();
  expect(f.api.command).toHaveBeenCalledOnce();
});

it('accepts an already dispatched receipt after admission is revoked', async () => {
  const f = fixture(); await f.ready(); f.client.setDraft('draft');
  let resolve!: (operation: SessionOperation) => void;
  vi.mocked(f.api.command).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const sending = f.client.send('draft'), command = vi.mocked(f.api.command).mock.calls[0]![1];
  f.client.setActionAdmission(false);
  expect(f.client.snapshot().operationProgress.get(command.operationId)).toBe('sending');
  expect(f.client.snapshot().draft.submission?.operationId).toBe(command.operationId);
  resolve(receipt(command, 'provider_accepted'));
  await sending;
  expect(f.client.snapshot().state.operations.get(command.operationId)?.state).toBe('provider_accepted');
  expect(f.client.snapshot().draft.text).toBe('');
  expect(f.api.command).toHaveBeenCalledOnce();
  expect(f.channel.close).not.toHaveBeenCalled();
});

it('queries an existing unknown receipt by its original ID while admission is revoked', async () => {
  const f = fixture(); await f.ready(); f.client.setDraft('draft');
  vi.mocked(f.api.command).mockRejectedValueOnce(new Error('Lost receipt'));
  await expect(f.client.send('draft')).rejects.toThrow('Lost receipt');
  const command = vi.mocked(f.api.command).mock.calls[0]![1];
  f.client.setActionAdmission(false);
  const before = f.client.snapshot(), disk = stored(), uuid = vi.spyOn(crypto, 'randomUUID');
  await expect(f.client.send('draft')).rejects.toThrow();
  expect(uuid).not.toHaveBeenCalled();
  expect(f.client.snapshot().state.operations).toBe(before.state.operations);
  expect(f.client.snapshot().draft).toBe(before.draft);
  expect(stored()).toEqual(disk);
  vi.mocked(f.api.operation).mockResolvedValueOnce(receipt(command, 'provider_accepted'));
  await f.client.checkOperation(command.operationId);
  expect(f.api.operation).toHaveBeenCalledExactlyOnceWith(command.sessionId, command.operationId, expect.any(AbortSignal));
  expect(f.client.snapshot().state.operations.get(command.operationId)?.state).toBe('provider_accepted');
  expect(f.client.snapshot().draft.text).toBe('');
  expect(f.api.command).toHaveBeenCalledOnce();
});

it('restores and reconciles an original unknown receipt without admitting new operations', async () => {
  const first = fixture(); await first.ready(); first.client.setDraft('draft');
  vi.mocked(first.api.command).mockRejectedValueOnce(new Error('Lost receipt'));
  await expect(first.client.send('draft')).rejects.toThrow('Lost receipt');
  const command = vi.mocked(first.api.command).mock.calls[0]![1]; first.client.close();
  const restored = fixture(false);
  vi.mocked(restored.api.operation).mockResolvedValueOnce(receipt(command, 'provider_accepted'));
  await restored.ready();
  await vi.waitFor(() => expect(restored.client.snapshot().state.operations.get(command.operationId)?.state).toBe('provider_accepted'));
  expect(restored.api.operation).toHaveBeenCalledExactlyOnceWith(command.sessionId, command.operationId, expect.any(AbortSignal));
  expect(restored.client.snapshot()).toMatchObject({ actionAdmitted: false, connected: true, draft: { text: '' } });
  expect(restored.api.command).not.toHaveBeenCalled();
});
