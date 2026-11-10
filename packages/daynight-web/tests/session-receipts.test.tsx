import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionFence, type SessionOperation } from '../../daynight/src/session/protocol';
import type { BrowserMessage, TimelinePage } from '../../daynight/src/session/controller-protocol';
import type { SessionApi } from '../src/api/sessions';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { TaskSessionSnapshot } from './helpers/session';

const render = createLocaleRender('en');
const userId = '00000009-1111-4111-8111-111111111111';
const clients: TaskSessionClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); vi.useRealTimers(); });

const interaction = { interactionId: 'approval', revision: '1', state: 'pending' as const, title: 'Run command', kind: 'approval' as const, detail: 'Run this command?', actions: ['allow_once' as const] };
async function fixture(kind?: SessionOperation['kind']) {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), lastEventSeq: '0' };
  Object.assign(s, { controls: { revision: '1', settings: [{ id: 'model', category: 'model', label: 'Model', value: 'a', description: null, mutable: true, scope: 'session', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }], commands: [{ id: 'compact', name: 'compact', description: 'Compact', argumentHint: null, available: true }], settingsError: null, commandsError: null } });
  if (kind === 'cancel') Object.assign(s, { activity: 'working', currentTurnId: 'turn', operations: { ...s.operations, canCancel: true } });
  if (kind === 'interaction_response') Object.assign(s, { operations: { ...s.operations, canRespond: true } });
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: kind === 'interaction_response' ? [{ entryId: 'approval', entrySeq: '1', revision: '1', kind: 'interaction', interaction }] : [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  let receive!: (value: BrowserMessage) => void;
  const api: SessionApi = { current: vi.fn(async () => ({ status: 'registered' as const, session: s })), archive: vi.fn(), archiveContent: vi.fn(), channel: vi.fn((_id, _cursor, next) => { receive = next; return { close: vi.fn() }; }), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resources: () => { throw new Error('Unexpected image resource client call.'); }, resourceUrl: () => '/unused' };
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, ownerUserId: userId, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn() });
  client.setCurrentReadVisible(true);
  clients.push(client);
  await client.start();
  receive({ protocol: s.protocol, type: 'snapshot', userId, snapshot: s, cursor: 'zero' });
  await vi.waitFor(() => expect(client.snapshot().connected).toBe(true));
  let seq = 0;
  return {
    api, client,
    operation: (state: SessionOperation['state'], kind: SessionOperation['kind'] = 'send_message', error: SessionOperation['error'] = null): SessionOperation => ({ protocol: s.protocol, ...sessionFence(s), operationId: crypto.randomUUID(), kind, state, providerResult: null, error }),
    emit: (operation: SessionOperation) => {
      seq += 1;
      act(() => receive({ protocol: s.protocol, type: 'event', cursor: String(seq), event: { protocol: s.protocol, ...sessionFence(s), connectionEpoch: s.connectionEpoch, historyEpoch: s.historyEpoch, eventSeq: String(seq), kind: 'operation', payload: operation } }));
    },
  };
}

it('keeps consecutive successful operations in the ledger without a receipt region', async () => {
  const f = await fixture();
  const { container } = render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={f.client} active current />);
  for (const kind of ['send_message', 'cancel', 'interaction_response', 'update_setting', 'execute_command', 'refresh_controls'] as const) f.emit(f.operation('confirmed', kind));
  for (const kind of ['send_message', 'execute_command'] as const) f.emit(f.operation('provider_accepted', kind));
  expect(screen.queryByText('Confirmed')).toBeNull();
  expect(screen.queryByText('Accepted by provider')).toBeNull();
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(f.client.snapshot().state.operations.size).toBe(8);
});

it.each(['cancel', 'interaction_response', 'update_setting', 'refresh_controls'] as const)('keeps provider acceptance visible while %s still needs confirmation', async kind => {
  const f = await fixture();
  render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={f.client} active current />);
  f.emit(f.operation('provider_accepted', kind));
  expect(screen.getByText('Unable to confirm whether this operation completed. Check the original operation.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Check original operation' })).toBeEnabled();
});

it.each([
  ['accepted', 'Unable to confirm whether this operation completed. Check the original operation.'], ['offered', 'Unable to confirm whether this operation completed. Check the original operation.'], ['dispatching', 'Unable to confirm whether this operation completed. Check the original operation.'], ['unknown', 'Unable to confirm whether this operation completed. Check the original operation.'], ['failed', 'The operation failed. No further details are available.'], ['rejected', 'The operation was rejected. No further details are available.'], ['expired', 'The operation expired before completion.'],
] as const)('keeps %s visible after newer successful operations', async (state, label) => {
  const f = await fixture();
  render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={f.client} active current />);
  f.emit(f.operation(state));
  for (let i = 0; i < 13; i += 1) f.emit(f.operation('confirmed'));
  expect(screen.getByText(label)).toBeVisible();
  if (['accepted', 'offered', 'dispatching', 'unknown'].includes(state)) expect(screen.getByRole('button', { name: 'Check original operation' })).toBeEnabled();
});

it.each(['confirmed', 'provider_accepted'] as const)('preserves error details even on a %s receipt', async state => {
  const f = await fixture();
  render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={f.client} active current />);
  f.emit(f.operation(state, 'send_message', { code: 'provider_error', message: 'Provider details need attention.' }));
  expect(screen.getByText('Provider details need attention.')).toBeVisible();
});

it('checks an unknown operation and hides its confirmation without resending or changing a newer draft', async () => {
  const f = await fixture();
  const operation = f.operation('unknown');
  vi.mocked(f.api.operation).mockResolvedValue({ ...operation, state: 'confirmed' });
  const { container } = render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={f.client} active current />);
  act(() => f.client.setDraft('New unsent text'));
  f.emit(operation);
  fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
  await waitFor(() => expect(container.querySelector('.session-receipts')).toBeNull());
  expect(f.api.operation).toHaveBeenCalledWith(operation.sessionId, operation.operationId, expect.any(AbortSignal));
  expect(f.api.command).not.toHaveBeenCalled();
  expect(f.client.snapshot().state.operations.get(operation.operationId)?.state).toBe('confirmed');
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('New unsent text');
});

it.each(['confirmed', 'provider_accepted'] as const)('clears only the submitted draft on %s without showing a success receipt', async state => {
  const f = await fixture();
  vi.mocked(f.api.command).mockImplementation(async (_session, command) => ({ ...f.operation(state), operationId: command.operationId }));
  const { container } = render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={f.client} active current />);
  act(() => f.client.setDraft('Send this text'));
  await act(async () => f.client.send('Send this text'));
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  expect(f.client.snapshot().state.operations.size).toBe(1);
  expect(container.querySelector('.session-receipts')).toBeNull();
});


it.each(['en', 'zh-CN'] as const)('keeps current-page delivery silent through slow acceptance and background checks in %s', async locale => {
  const f = await fixture();
  vi.useFakeTimers();
  let acknowledge!: (operation: SessionOperation) => void;
  vi.mocked(f.api.command).mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
  const { container } = createLocaleRender(locale)(<SessionView userId={userId} client={f.client} active current />);
  act(() => f.client.setDraft('Wait for native acceptance'));
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.focus(); input.setSelectionRange(2, 6);
  const timeline = container.querySelector('.session-timeline')!; timeline.scrollTop = 40;
  fireEvent.submit(container.querySelector('form')!);
  fireEvent.submit(container.querySelector('form')!);
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(container.querySelector('.session-notice')).toBeNull();
  expect(container.querySelector('.session-receipt.unknown')).toBeNull();
  expect(container.querySelector('.session-receipt-progress')).toBeNull();
  expect(screen.queryByRole('button', { name: locale === 'en' ? 'Check original operation' : '核对原操作' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Awaiting provider confirmation' })).toBeDisabled();
  expect(screen.getByRole('textbox')).toHaveValue('Wait for native acceptance');
  const command = vi.mocked(f.api.command).mock.calls[0]![1];
  const operation = { ...f.operation('accepted'), operationId: command.operationId };
  vi.mocked(f.api.operation).mockResolvedValue(operation);
  await act(async () => acknowledge(operation));
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(container.querySelector('.session-notice')).toBeNull();
  for (const state of ['offered', 'dispatching'] as const) {
    f.emit({ ...operation, state });
    expect(container.querySelector('.session-receipts')).toBeNull();
  }
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(container.querySelector('.session-notice')).toBeNull();
  expect(screen.queryByRole('button', { name: locale === 'en' ? 'Check original operation' : '核对原操作' })).toBeNull();
  expect(f.api.operation).toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
  expect(container.querySelector('.session-timeline')).toBe(timeline);
  expect(timeline.scrollTop).toBe(40);
  expect(f.api.command).toHaveBeenCalledOnce();
  vi.mocked(f.api.operation).mockResolvedValue({ ...operation, state: 'provider_accepted', providerResult: 'started' });
  f.emit({ ...operation, state: 'provider_accepted', providerResult: 'started' });
  await act(async () => vi.advanceTimersByTimeAsync(750));
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(screen.getByRole('textbox')).toHaveValue('');
});

it('keeps an uncertain result visible and its draft intact when delivery fails', async () => {
  const f = await fixture();
  vi.mocked(f.api.command).mockRejectedValue(new Error('Connection interrupted'));
  const { container } = render(<SessionView userId={userId} client={f.client} active current />);
  act(() => f.client.setDraft('Unconfirmed input'));
  fireEvent.submit(container.querySelector('form')!);
  await waitFor(() => expect(screen.getByText('Unable to confirm whether this operation completed. Check the original operation.')).toBeVisible());
  expect(screen.getByText('Delivery outcome is unknown. Check this operation; do not resend it.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Check original operation' })).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveValue('Unconfirmed input');
  expect(container.querySelector('.session-receipt-progress')).toBeNull();
  expect(f.api.command).toHaveBeenCalledOnce();
});


it('keeps each failed check with its original operation until that operation recovers', async () => {
  const f = await fixture();
  const first = f.operation('unknown'), second = f.operation('unknown');
  vi.mocked(f.api.operation).mockImplementation(async (_session, id) => {
    if (id === first.operationId) throw new Error('First operation lookup unavailable');
    return { ...second, state: 'confirmed' };
  });
  const { container } = render(<SessionView userId={userId} client={f.client} active current />);
  f.emit(first); f.emit(second);
  fireEvent.click(screen.getAllByRole('button', { name: 'Check original operation' })[0]!);
  await waitFor(() => expect(screen.getByText('First operation lookup unavailable')).toBeVisible());
  fireEvent.click(screen.getAllByRole('button', { name: 'Check original operation' })[1]!);
  await waitFor(() => expect(container.querySelectorAll('.session-receipt')).toHaveLength(1));
  expect(within(container.querySelector('.session-receipt') as HTMLElement).getByText('First operation lookup unavailable')).toBeVisible();
  f.emit({ ...first, state: 'confirmed' });
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(screen.queryByText('First operation lookup unavailable')).toBeNull();
  expect(f.api.command).not.toHaveBeenCalled();
});


it.each(['update_setting', 'cancel', 'interaction_response'] as const)('clears the recovered %s error while preserving another unresolved operation', async kind => {
  const f = await fixture(kind);
  vi.mocked(f.api.command).mockRejectedValue(new Error('Original operation response was lost'));
  const { container } = render(<SessionView userId={userId} client={f.client} active current />);
  if (kind === 'interaction_response') fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  else if (kind === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
  else {
    fireEvent.click(screen.getByRole('button', { name: 'Model' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
  }
  await screen.findByText('Original operation response was lost');
  const command = vi.mocked(f.api.command).mock.calls[0]![1];
  const other = f.operation('failed', 'send_message', { code: 'failure', message: 'Another operation failed' });
  f.emit(other);
  vi.mocked(f.api.operation).mockResolvedValue({ ...f.operation('confirmed', kind), operationId: command.operationId });
  fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
  await waitFor(() => expect(screen.queryByText('Original operation response was lost')).toBeNull());
  expect(screen.getByText('Another operation failed')).toBeVisible();
  expect(container.querySelectorAll('.session-receipt')).toHaveLength(1);
  expect(f.api.command).toHaveBeenCalledOnce();
});

it('shows the error reason without native stack frames', async () => {
  const f = await fixture();
  render(<SessionView userId={userId} client={f.client} active current />);
  f.emit(f.operation('failed', 'send_message', { code: 'provider_error', message: 'Permission was revoked\n    at dispatch (/private/worker/provider.js:27:9)\n    at async run (/private/worker/run.js:14:1)' }));
  expect(screen.getByText('Permission was revoked')).toBeVisible();
  expect(screen.queryByText(/private\/worker/)).toBeNull();
});

it.each(['send_message', 'execute_command', 'update_setting', 'refresh_controls', 'cancel', 'interaction_response'] as const)('keeps every normal %s stage silent without weakening its acceptance contract', async kind => {
  const f = await fixture(kind);
  vi.useFakeTimers();
  let receipt!: SessionOperation;
  vi.mocked(f.api.command).mockImplementation(async (_id, command) => receipt = { ...f.operation('accepted', kind), operationId: command.operationId });
  vi.mocked(f.api.operation).mockImplementation(async () => receipt);
  const { container } = render(<SessionView userId={userId} client={f.client} active current />);
  let work!: Promise<void>;
  act(() => {
    work = kind === 'send_message' ? f.client.send('Send once') : kind === 'execute_command' ? f.client.executeCommand('compact', '', '1') : kind === 'update_setting' ? f.client.updateSetting('model', 'b', '1') : kind === 'refresh_controls' ? f.client.refreshControls() : kind === 'cancel' ? f.client.cancel() : f.client.respond(interaction, { kind: 'approval', action: 'allow_once' });
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
  for (const phase of ['accepted', 'offered', 'dispatching'] as const) {
    receipt = { ...receipt, state: phase }; f.emit(receipt);
    expect(container.querySelector('.session-receipts')).toBeNull();
  }
  await act(async () => vi.advanceTimersByTimeAsync(10_001));
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(f.client.snapshot().operationProgress.get(receipt.operationId)).toBe('waiting');
  receipt = { ...receipt, state: 'provider_accepted' }; f.emit(receipt);
  expect(container.querySelector('.session-receipts')).toBeNull();
  if (!['send_message', 'execute_command'].includes(kind)) expect(f.client.snapshot().operationProgress.has(receipt.operationId)).toBe(true);
  receipt = { ...receipt, state: 'confirmed' }; f.emit(receipt);
  await act(async () => { await vi.advanceTimersByTimeAsync(750); await work; });
  expect(container.querySelector('.session-receipts')).toBeNull();
  expect(f.api.command).toHaveBeenCalledOnce();
  expect(vi.mocked(f.api.operation).mock.calls.every(([_session, id]) => id === receipt.operationId)).toBe(true);
});

it('reveals the existing 30-second unknown deadline while keeping the unanswered input intact', async () => {
  const f = await fixture(); vi.useFakeTimers();
  let reply!: (operation: SessionOperation) => void;
  vi.mocked(f.api.command).mockImplementation(() => new Promise(resolve => { reply = resolve; }));
  const { container } = render(<SessionView userId={userId} client={f.client} active current />);
  act(() => f.client.setDraft('Unanswered request'));
  fireEvent.submit(container.querySelector('form')!);
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  expect(container.querySelector('.session-receipts')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole('button', { name: 'Check original operation' })).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveValue('Unanswered request');
  expect(f.api.command).toHaveBeenCalledOnce();
  const command = vi.mocked(f.api.command).mock.calls[0]![1];
  await act(async () => reply({ ...f.operation('confirmed'), operationId: command.operationId }));
  expect(container.querySelector('.session-receipts')).toBeNull();
});
