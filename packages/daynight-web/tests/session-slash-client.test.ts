import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import type { SessionApi } from '../src/api/sessions';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import { sessionBinding, type SessionCommand, type SessionOperation, type SessionSnapshot } from '../../daynight/src/session/protocol';
import type { TaskSessionSnapshot } from './helpers/session';

const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); });
const receipt = (command: SessionCommand, state: SessionOperation['state'] = 'provider_accepted'): SessionOperation => ({
  protocol: command.protocol, ...sessionBinding(command), sessionId: command.sessionId,
  executionGeneration: command.executionGeneration, operationId: command.operationId,
  kind: command.kind, state, providerResult: state === 'provider_accepted' ? 'started' : null, error: null,
});
function fixture(kind: 'task' | 'test') {
  const task: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), lastEventSeq: '0' };
  const { claimId: _claim, ...base } = task;
  const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = task.identity;
  const s: SessionSnapshot = kind === 'task' ? task : { ...base, testExecutionId: '00000017-1111-4111-8111-111111111111', identity: { ...identity, ownerUserId: userId }, initialInputState: 'not_required' };
  let receive!: (message: BrowserMessage) => void, disconnect!: () => void, paused = false, current = true;
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  const api: SessionApi = {
    archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: s })),
    timeline: vi.fn(async () => page), command: vi.fn(async (_id, command) => receipt(command)), operation: vi.fn(),
    resource: vi.fn(), resourceUrl: () => '/unused', channel: vi.fn((_id, _cursor, next, close) => { receive = next; disconnect = close; return { close: vi.fn() }; }),
  };
  const client = new TaskSessionClient({ api, userId, isCurrent: () => current, isPaused: () => paused, onPrincipalMismatch: vi.fn(), storage: null,
    ...(kind === 'task' ? { projectId: task.identity.projectId, taskId: task.identity.taskId, claimId: task.claimId } : { testSessionId: s.sessionId }),
  });
  clients.push(client);
  const publish = (next = s, principal = userId) => receive({ protocol: next.protocol, type: 'snapshot', userId: principal, snapshot: next, cursor: 'zero' });
  return { s, api, client, publish, pause: () => { paused = true; }, supersede: () => { current = false; }, disconnect: () => disconnect(),
    ready: async () => { await client.start(); publish(); await vi.waitFor(() => expect(client.snapshot().connected).toBe(true)); },
  };
}

describe.each(['task', 'test'] as const)('%s Session slash message transport', kind => {
  it.each(['/Users/zhangxian/.local/share/copilot 请检查这里', '/made-up', '/mo', '/', '/Users/目录/copilot  中文说明\n  第二行  保留空格'])('sends %j exactly once as text without native command dispatch', async text => {
    const f = fixture(kind); await f.ready(); f.client.setDraft(text);
    await f.client.send(text);
    expect(f.api.command).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.command).mock.calls[0]?.[1]).toMatchObject({ kind: 'send_message', payload: { content: [{ type: 'text', text }], expectedTurnId: null } });
    expect(f.client.snapshot().draft.text).toBe('');
  });

  it('uses the ordinary steer gate and exact current turn even with a failed command catalog', async () => {
    const f = fixture(kind);
    Object.assign(f.s, { activity: 'working', currentTurnId: 'active-turn', controls: { revision: '4', settings: [], commands: [], settingsError: null, commandsError: 'Catalog unavailable' } });
    await f.ready();
    await f.client.send('/Users/path 继续检查');
    expect(vi.mocked(f.api.command).mock.calls[0]?.[1]).toMatchObject({ kind: 'send_message', payload: { content: [{ type: 'text', text: '/Users/path 继续检查' }], expectedTurnId: 'active-turn' } });
    expect(f.api.command).toHaveBeenCalledOnce();
  });

  it.each(['offline', 'auth pause', 'stale owner', 'read only', 'no send capability', 'no steer', 'unsynchronized', 'wrong principal'] as const)('does not bypass %s restrictions for slash text', async restriction => {
    const f = fixture(kind);
    if (restriction === 'read only') Object.assign(f.s, { operations: { ...f.s.operations, canSend: false } });
    if (restriction === 'no send capability') Object.assign(f.s, { capabilities: { ...f.s.capabilities, send: false } });
    if (restriction === 'no steer') Object.assign(f.s, { activity: 'working', currentTurnId: 'active-turn', capabilities: { ...f.s.capabilities, steer: false } });
    await f.ready();
    if (restriction === 'offline') f.disconnect();
    if (restriction === 'auth pause') f.pause();
    if (restriction === 'stale owner') f.supersede();
    if (restriction === 'unsynchronized') f.publish({ ...f.s, synchronized: false });
    if (restriction === 'wrong principal') f.publish(f.s, '00000010-1111-4111-8111-111111111111');
    await expect(f.client.send('/Users/path 不应发送')).rejects.toThrow();
    expect(f.api.command).not.toHaveBeenCalled();
  });

  it.each([false, true])('retains an unknown slash operation and clears only its own accepted draft (edited=%s)', async edited => {
    const f = fixture(kind); await f.ready();
    const text = '/Users/path  请检查\n  保留空格'; f.client.setDraft(text);
    vi.mocked(f.api.command).mockRejectedValueOnce(new Error('lost receipt'));
    await expect(f.client.send(text)).rejects.toThrow('lost receipt');
    const command = vi.mocked(f.api.command).mock.calls[0]![1];
    expect(f.client.snapshot().draft).toMatchObject({ text, submission: { operationId: command.operationId, kind: 'send_message' } });
    await expect(f.client.send(text)).rejects.toThrow();
    if (edited) f.client.setDraft('/another 新编辑');
    vi.mocked(f.api.operation).mockResolvedValue(receipt(command)); await f.client.checkOperation(command.operationId);
    expect(f.client.snapshot().draft.text).toBe(edited ? '/another 新编辑' : '');
    expect(f.api.command).toHaveBeenCalledOnce();
    expect(command.kind).toBe('send_message');
  });

  it('blocks rapid duplicate submissions until the original response and preserves later edits', async () => {
    const f = fixture(kind); await f.ready();
    let resolve!: (value: SessionOperation) => void;
    vi.mocked(f.api.command).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    f.client.setDraft('/Users/original'); const sending = f.client.send('/Users/original').catch(error => error);
    await expect(f.client.send('/Users/original')).rejects.toThrow();
    expect(f.api.command).toHaveBeenCalledOnce();
    f.client.setDraft('/Users/edited');
    resolve(receipt(vi.mocked(f.api.command).mock.calls[0]![1])); expect(await sending).toBeUndefined();
    expect(f.api.command).toHaveBeenCalledOnce(); expect(f.client.snapshot().draft.text).toBe('/Users/edited');
  });

  it.each(['execute_command', 'refresh_controls', 'update_setting'] as const)('retains the pending %s barrier for slash messages', async pendingKind => {
    const f = fixture(kind);
    Object.assign(f.s, { controls: { revision: '4', settings: [{ id: 'model', category: 'model', label: 'Model', value: 'a', description: null, mutable: true, scope: 'session', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } });
    await f.ready(); vi.mocked(f.api.command).mockRejectedValueOnce(new Error('lost receipt'));
    const pending = pendingKind === 'execute_command' ? f.client.executeCommand('compact', '', '4') : pendingKind === 'update_setting' ? f.client.updateSetting('model', 'b', '4') : f.client.refreshControls();
    await expect(pending).rejects.toThrow('lost receipt');
    await expect(f.client.send('/Users/path')).rejects.toThrow();
    expect(f.api.command).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.command).mock.calls[0]![1].kind).toBe(pendingKind);
  });

  it('retains a provider-rejected slash draft without trying another operation kind', async () => {
    const f = fixture(kind); await f.ready(); f.client.setDraft('/made-up');
    vi.mocked(f.api.command).mockImplementationOnce(async (_id, command) => ({ ...receipt(command, 'rejected'), error: { code: 'rejected', message: 'Provider refused' } }));
    await expect(f.client.send('/made-up')).rejects.toThrow('Provider refused');
    expect(f.client.snapshot().draft.text).toBe('/made-up');
    expect(f.api.command).toHaveBeenCalledOnce(); expect(vi.mocked(f.api.command).mock.calls[0]![1].kind).toBe('send_message');
  });
});
