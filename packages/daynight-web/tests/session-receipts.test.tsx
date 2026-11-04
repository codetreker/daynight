import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
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
afterEach(() => clients.splice(0).forEach(client => client.close()));

async function fixture() {
  const s: TaskSessionSnapshot = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), lastEventSeq: '0' };
  const page: TimelinePage = { sessionId: s.sessionId, historyEpoch: s.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' };
  let receive!: (value: BrowserMessage) => void;
  const api: SessionApi = { current: vi.fn(async () => ({ status: 'registered' as const, session: s })), archive: vi.fn(), archiveContent: vi.fn(), channel: vi.fn((_id, _cursor, next) => { receive = next; return { close: vi.fn() }; }), timeline: vi.fn(async () => page), command: vi.fn(), operation: vi.fn(), resource: vi.fn(), resourceUrl: () => '/unused' };
  const client = new TaskSessionClient({ api, userId, projectId: s.identity.projectId, taskId: s.identity.taskId, claimId: s.claimId, isCurrent: () => true, storage: null, onPrincipalMismatch: vi.fn() });
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
  expect(screen.getByText('Accepted by provider')).toBeVisible();
});

it.each([
  ['accepted', 'Received by relay; awaiting controller'], ['offered', 'Delivering to controller'], ['dispatching', 'Submitting to provider'], ['unknown', 'Outcome unknown'], ['failed', 'Failed'], ['rejected', 'Rejected'], ['expired', 'Expired'],
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
