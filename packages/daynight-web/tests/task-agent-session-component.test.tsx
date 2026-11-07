import { pauseAuthRequests } from '../src/api/client';
import { sessionBinding } from '../../daynight/src/session/protocol';
import type { TaskSessionSnapshot } from './helpers/session';
import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskAgentSession } from '../src/features/task-agent-session/TaskAgentSession';
import { createSessionApi, type SessionApi } from '../src/api/sessions';
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { SessionSnapshot } from '../src/api/types';
import type { BrowserMessage } from '../../daynight/src/session/controller-protocol';
vi.mock('../src/api/sessions', () => ({ createSessionApi: vi.fn() }));
const render = createLocaleRender('en');
const scopes: TaskCacheScope[] = [];
afterEach(() => scopes.splice(0).forEach((scope) => scope.dispose()));
const userId = '00000009-1111-4111-8111-111111111111';
const initial = (): TaskSessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), executionGeneration: '1', connectionEpoch: '1', lastEventSeq: '0' });
function fixture(snapshot = initial(), ownerUserId = userId) {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  let receive!: (message: BrowserMessage) => void;
  const api: SessionApi = { archive: vi.fn(), archiveContent: vi.fn(), current: vi.fn(async () => ({ status: 'registered' as const, session: snapshot })), timeline: vi.fn(async () => ({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' })), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused', channel: vi.fn((_id, _after, onMessage) => { receive = onMessage; return { close: vi.fn() }; }) };
  vi.mocked(createSessionApi).mockReturnValue(api);
  const element = (current = true) => <TaskCacheProvider scope={scope}><TaskAgentSession ownerUserId={ownerUserId} projectId={snapshot.identity.projectId} taskId={snapshot.identity.taskId} claimId={snapshot.claimId} active current={current} /></TaskCacheProvider>;
  return { scope, api, element, receive: (message: BrowserMessage) => act(() => receive(message)), snapshot };
}
describe('production task session panel', () => {
  it('connects once, accepts input quietly, and retains drafts across permission refresh', async () => {
    const f = fixture(); const view = render(f.element());
    await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    f.receive({ protocol: f.snapshot.protocol, type: 'snapshot', userId, snapshot: f.snapshot, cursor: 'zero' });
    await screen.findByText('Ready', { exact: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hello' } });
    vi.mocked(f.api.command).mockImplementation(async (_id, command) => ({ protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'provider_accepted', providerResult: 'started', error: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    expect(screen.queryByText('Accepted by provider')).toBeNull();
    expect(screen.queryByText('Confirmed')).toBeNull();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsent draft' } });
    view.rerender(f.element(false));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveValue('unsent draft');
  });
  it('keeps unknown delivery visible and only queries its original receipt', async () => {
    const f = fixture(); render(f.element());
    await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    f.receive({ protocol: f.snapshot.protocol, type: 'snapshot', userId, snapshot: f.snapshot, cursor: 'zero' });
    await screen.findByText('Ready', { exact: true });
    vi.mocked(f.api.command).mockRejectedValue(new Error('Lost acknowledgement'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'do once' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Unable to confirm whether this operation completed. Check the original operation.');
    const command = vi.mocked(f.api.command).mock.calls[0]![1];
    vi.mocked(f.api.operation).mockResolvedValue({ protocol: command.protocol, sessionId: command.sessionId, ...sessionBinding(command), executionGeneration: command.executionGeneration, operationId: command.operationId, kind: command.kind, state: 'confirmed', providerResult: 'started', error: null });
    fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    expect(screen.queryByText('Accepted by provider')).toBeNull();
    expect(screen.queryByText('Confirmed')).toBeNull();
    expect(screen.queryByText('Lost acknowledgement')).toBeNull();
    expect(f.api.command).toHaveBeenCalledOnce();
    expect(f.api.operation).toHaveBeenCalledWith(f.snapshot.sessionId, command.operationId, expect.any(AbortSignal));
  });
});

it('identifies Copilot and honors its missing steer capability', async () => {
  const original = initial();
  const snapshot = { ...original, identity: { ...original.identity, provider: 'copilot' as const }, activity: 'working' as const, currentTurnId: 'native-turn', capabilities: { ...original.capabilities, steer: false }, operations: { ...original.operations, canSend: false } };
  const f = fixture(snapshot); render(f.element());
  await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
  f.receive({ protocol: snapshot.protocol, type: 'snapshot', userId, snapshot, cursor: 'zero' });
  await screen.findByText('GitHub Copilot');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'later' } });
  expect(screen.getByRole('button', { name: 'Add to current turn' })).toBeDisabled();
  expect(f.api.command).not.toHaveBeenCalled();
});

it('retains a task session channel and draft through a short identity pause, but disconnects stale task content', async () => {
  const f = fixture(); const view = render(f.element());
  await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
  f.receive({ protocol: f.snapshot.protocol, type: 'snapshot', userId, snapshot: f.snapshot, cursor: 'zero' });
  await screen.findByText('Ready', { exact: true });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'keep draft' } });
  const close = vi.mocked(f.api.channel).mock.results[0]!.value.close;
  const resume = pauseAuthRequests();
  try {
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByText('Restoring session')).toBeNull();
    expect(screen.getByRole('textbox')).toBe(input);
  } finally { resume(); }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  expect(f.api.current).toHaveBeenCalledOnce();
  expect(f.api.channel).toHaveBeenCalledOnce();
  expect(f.api.timeline).toHaveBeenCalledOnce();
  expect(input).toHaveValue('keep draft');
  view.rerender(f.element(false));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it('keeps the channel, draft and retained message when changing display mode', async () => {
  const f = fixture();
  vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: f.snapshot.sessionId, historyEpoch: f.snapshot.historyEpoch, items: [
    { kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Retained answer' }] },
    { kind: 'reasoning', entryId: 'reasoning', entrySeq: '2', revision: '1', text: 'Reasoning text' },
  ], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
  render(f.element());
  await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
  f.receive({ protocol: f.snapshot.protocol, type: 'snapshot', userId, snapshot: f.snapshot, cursor: 'zero' });
  const message = await screen.findByText('Retained answer'), input = screen.getByRole('textbox');
  expect(screen.queryByText('Reasoning')).toBeNull();
  fireEvent.change(input, { target: { value: 'Unsubmitted draft' } });
  const calls = vi.mocked(f.api.current).mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Standard' }));
  expect(screen.getByText('Reasoning')).toBeInTheDocument();
  expect(screen.getByText('Retained answer')).toBe(message);
  expect(screen.getByRole('textbox')).toBe(input); expect(input).toHaveValue('Unsubmitted draft');
  expect(f.api.channel).toHaveBeenCalledOnce(); expect(f.api.current).toHaveBeenCalledTimes(calls);
  expect(f.api.command).not.toHaveBeenCalled();
  expect(localStorage.getItem(`daynight.web.session.display.v1:${JSON.stringify([userId, f.snapshot.sessionId])}`)).toBe('"standard"');
});

it('does not combine a new account with the previous client snapshot before its replacement starts', async () => {
  const f = fixture(); const rendered = render(f.element());
  await screen.findByRole('button', { name: 'Display' });
  vi.mocked(f.api.current).mockImplementation(() => new Promise(() => {}));
  const nextScope = createTaskCacheScope({ userId: '00000019-1111-4111-8111-111111111111', onIdentityMismatch: vi.fn() }); scopes.push(nextScope);
  const getItem = vi.spyOn(Storage.prototype, 'getItem');
  rendered.rerender(<TaskCacheProvider scope={nextScope}><TaskAgentSession ownerUserId={userId} projectId={f.snapshot.identity.projectId} taskId={f.snapshot.identity.taskId} claimId={f.snapshot.claimId} active current /></TaskCacheProvider>);
  expect(getItem.mock.calls.filter(([key]) => key.startsWith('daynight.web.session.display.v1:'))).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Display' })).toBeNull();
});

it('retains the live client, channel and draft through Session fullscreen and layered Display Escape', async () => {
  const f = fixture();
  render(f.element());
  await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
  f.receive({ protocol: f.snapshot.protocol, type: 'snapshot', userId, snapshot: f.snapshot, cursor: 'zero' });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Fullscreen draft' } });
  const currentReads = vi.mocked(f.api.current).mock.calls.length;
  const timelineReads = vi.mocked(f.api.timeline).mock.calls.length;
  const close = vi.mocked(f.api.channel).mock.results[0]!.value.close;
  const trigger = screen.getByRole('button', { name: 'Enter Session fullscreen' });
  fireEvent.click(trigger);
  expect(screen.getByRole('textbox')).toBe(input);
  expect(input).toHaveValue('Fullscreen draft');
  fireEvent.click(screen.getByRole('button', { name: 'Display' }));
  fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Conversation' }), { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Exit Session fullscreen' })).toBe(trigger);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Enter Session fullscreen' })).toBe(trigger);
  expect(input).toHaveValue('Fullscreen draft');
  expect(f.api.current).toHaveBeenCalledTimes(currentReads);
  expect(f.api.timeline).toHaveBeenCalledTimes(timelineReads);
  expect(f.api.channel).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(f.api.command).not.toHaveBeenCalled();
});

it('shows live messages and disabled pending approval controls to another project member', async () => {
  const s = { ...initial(), activity: 'waiting_input' as const, operations: { canSend: true, canCancel: true, canRespond: true } };
  const f = fixture(s, '00000010-1111-4111-8111-111111111111');
  vi.mocked(f.api.timeline).mockResolvedValue({ sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [
    { kind: 'assistant_message', entryId: 'message', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Shared live output' }] },
    { kind: 'interaction', entryId: 'request', entrySeq: '2', revision: '1', interaction: { interactionId: 'approval', revision: '1', kind: 'approval', state: 'pending', title: 'Approve Write', detail: 'notes/review.txt', actions: ['allow_once', 'reject'] } }
  ], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
  render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
  f.receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot: s, cursor: 'zero' });
  expect(await screen.findByText('Shared live output')).toBeVisible();
  expect(screen.getByLabelText('Message')).toHaveAttribute('readonly');
  for (const button of screen.getByRole('region', { name: 'Approve Write' }).querySelectorAll('button')) expect(button).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Display' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(f.api.current).toHaveBeenCalledTimes(2));
  expect(f.api.command).not.toHaveBeenCalled();
  expect(screen.getByText('Shared live output')).toBeVisible();
});
