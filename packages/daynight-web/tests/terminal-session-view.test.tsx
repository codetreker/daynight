import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { parseTerminalSessionState, terminalEnvelope, type TerminalSessionApi, type TerminalSessionState } from '../src/api/terminal-sessions';
import { TerminalSessionView } from '../src/features/task-agent-session/TerminalSessionView';
import { ApiError, pauseAuthRequests } from '../src/api/client';
const read = (name: string) => JSON.parse(readFileSync(`../daynight/test/session/fixtures/v2/${name}.json`, 'utf8'));
const r = read('valid-registration'), owner = r.payload.owner;
const render = createLocaleRender('en', { taskCache: { viewerId: owner.ownerUserId } });
afterEach(() => { sessionStorage.clear(); });
function fixture() {
  let value = parseTerminalSessionState({ status: 'registered', ...terminalEnvelope(r), owner, binding: r.payload.binding, connectionEpoch: '1', connected: true, capabilities: r.payload.capabilities, control: { ...read('valid-control').payload, state: 'automation', lease: null, availableActions: ['acquire_control'] }, snapshot: read('valid-snapshot').payload, ledger: read('valid-active-ledger').payload, archive: read('valid-status-pending').payload, recording: [] }, owner.projectId, owner.taskId, owner.serverOrigin);
  let receive: (s: TerminalSessionState) => void = () => {}; const close = vi.fn();
  const api: TerminalSessionApi = { current: vi.fn(async () => value), state: vi.fn(async () => value), history: vi.fn(), archive: vi.fn(), nativeArchive: vi.fn(), command: vi.fn(async (_id, _browser, command) => ({ ...terminalEnvelope(value), type: 'operation_result' as const, payload: { operationId: command.payload.operationId, state: 'transport_completed' as const, errorCode: null } })), operation: vi.fn(), channel: vi.fn((_id, _browser, onState) => { receive = onState; return { close }; }) };
  return { api, close, set(next: TerminalSessionState) { value = next; act(() => receive(value)); }, get: () => value, show: () => act(() => receive(value)), element: (active = true, current = true) => <TerminalSessionView projectId={owner.projectId} api={api} claimId={r.claimId} active={active} current={current} /> };
}
describe('terminal production view', () => {
  it('only observes by default and releases its subscription when the tab hides', async () => {
    const f = fixture(); const view = render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce()); f.show();
    expect(screen.getByRole('button', { name: 'Paste text' })).toBeDisabled(); expect(f.api.command).not.toHaveBeenCalled();
    view.rerender(f.element(false)); await waitFor(() => expect(f.close).toHaveBeenCalled());
    view.rerender(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledTimes(2));
  });
  it('survives temporary identity verification and resumes observation without automatic input', async () => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce()); f.show();
    const resume = pauseAuthRequests(); await waitFor(() => expect(f.close).toHaveBeenCalledOnce()); resume();
    await waitFor(() => expect(f.api.channel).toHaveBeenCalledTimes(2)); expect(f.api.command).not.toHaveBeenCalled();
  });
  it('requires separate checked decisions for initial disposition and automation resumption', async () => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    f.set({ ...f.get(), control: { ...f.get().control!, state: 'suspended', initialAssignment: 'unknown', availableActions: ['resolve_initial_assignment', 'acquire_control'] } });
    expect(screen.getByRole('button', { name: 'Resume automatic execution' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve initial submission' }));
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled(); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
    expect(vi.mocked(f.api.command).mock.calls[0]![2].payload).toMatchObject({ action: 'resolve_initial_assignment', draftHandled: false, initialUnknownDisposition: 'delivered_continue' });
    f.set({ ...f.get(), control: { ...f.get().control!, controlEpoch: '3', state: 'suspended', initialAssignment: 'transport_completed', availableActions: ['resume_automation', 'acquire_control'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Resume automatic execution' })); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(f.api.command).toHaveBeenCalledTimes(2)); expect(vi.mocked(f.api.command).mock.calls[1]![2].payload).toMatchObject({ action: 'resume_automation', draftHandled: true, initialUnknownDisposition: null });
  });
  it('removes terminal content and reports permission loss', async () => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce()); f.show();
    vi.mocked(f.api.state).mockRejectedValue(new ApiError('server', 403, 'permission_denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission to access this Session.');
    expect(f.close).toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Take control' })).toBeDisabled();
  });
});
