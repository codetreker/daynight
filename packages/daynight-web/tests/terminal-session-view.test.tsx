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
  return { api, close, set(next: TerminalSessionState) { value = next; act(() => receive(value)); }, publish(next: TerminalSessionState) { value = next; receive(value); }, get: () => value, show: () => act(() => receive(value)), element: (active = true, current = true) => <TerminalSessionView projectId={owner.projectId} api={api} claimId={r.claimId} active={active} current={current} /> };
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
  it('keeps the frame, draft, focus and checked confirmation through a paused identity check and reconnect', async () => {
    const f = fixture(); const rendered = render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    const suspended = structuredClone(f.get()); suspended.control = { ...suspended.control!, controlEpoch: '3', state: 'suspended', initialAssignment: 'transport_completed', availableActions: ['resume_automation', 'acquire_control'] };
    f.set(suspended); fireEvent.click(screen.getByRole('button', { name: 'Resume automatic execution' })); fireEvent.click(screen.getByRole('checkbox'));
    const screenNode = screen.getByRole('region', { name: /terminal/i }); const draft = screen.getByRole('textbox', { name: 'Terminal input' }) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: 'local draft' } }); draft.focus(); draft.setSelectionRange(2, 6); screenNode.scrollTop = 42;
    const checkbox = screen.getByRole('checkbox'); const confirm = screen.getByRole('button', { name: 'Confirm' });
    let resolve!: (value: TerminalSessionState) => void; vi.mocked(f.api.state).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const stable = () => {
      expect(screen.getByRole('region', { name: /terminal/i })).toBe(screenNode); expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(draft);
      expect(draft).toHaveValue('local draft'); expect(document.activeElement).toBe(draft); expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 6]); expect(screenNode.scrollTop).toBe(42);
      expect(screen.getByRole('checkbox')).toBe(checkbox); expect(checkbox).toBeChecked();
      expect(screen.queryByText('Loading session…')).not.toBeInTheDocument(); expect(screen.queryByText('This screen may be out of date.')).not.toBeInTheDocument();
      expect(f.api.command).not.toHaveBeenCalled();
    };
    stable(); const resume = pauseAuthRequests(); rendered.rerender(f.element(true, false)); await waitFor(() => expect(f.close).toHaveBeenCalledOnce()); stable(); expect(confirm).toBeDisabled();
    resume(); rendered.rerender(f.element()); await waitFor(() => expect(f.api.state).toHaveBeenCalledOnce()); stable(); expect(confirm).toBeDisabled();
    await act(async () => { resolve(structuredClone(suspended)); }); await waitFor(() => expect(f.api.channel).toHaveBeenCalledTimes(2)); stable(); expect(confirm).toBeDisabled();
    f.set(structuredClone(suspended)); stable(); expect(confirm).toBeEnabled();
  });
  it('keeps the confirmed control label during a pause while refusing input', async () => {
    const f = fixture(); const rendered = render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    const browser = vi.mocked(f.api.channel).mock.calls[0]![1];
    const manual = structuredClone(f.get()); manual.control = structuredClone(read('valid-control').payload); manual.control!.lease!.browserClientId = browser; manual.control!.lease!.holderUserId = owner.ownerUserId; manual.control!.lease!.expiresAt = '2099-01-01T00:00:00Z'; manual.control!.availableActions = ['paste', 'keys', 'release_control', 'renew_control']; f.set(manual);
    expect(screen.getByText('You have control')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Release control' })).toBeEnabled();
    rendered.rerender(f.element(true, false)); await waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(screen.getByText('You have control')).toBeInTheDocument(); expect(screen.queryByText('Another browser has control')).not.toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Release control' })).toBeDisabled();
    expect(f.api.command).not.toHaveBeenCalled();
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
  it.each([['resume_automation', 'Resume automatic execution', 'transport_completed'], ['resolve_initial_assignment', 'Resolve initial submission', 'unknown']] as const)('requires a new checked %s confirmation after another browser changes the control epoch', async (action, label, initialAssignment) => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    const suspended: TerminalSessionState = { ...f.get(), control: { ...f.get().control!, controlEpoch: '3', state: 'suspended', initialAssignment, availableActions: [action, 'acquire_control'] } };
    f.set(suspended);
    fireEvent.click(screen.getByRole('button', { name: label })); fireEvent.click(screen.getByRole('checkbox'));
    const otherLease = { ...read('valid-control').payload.lease, controlEpoch: '4', expiresAt: '2099-01-01T00:00:00Z' };
    f.set({ ...suspended, control: { ...suspended.control!, controlEpoch: '4', state: 'manual', lease: otherLease, availableActions: [] } });
    f.set({ ...suspended, control: { ...suspended.control!, controlEpoch: '5' } });
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument(); expect(f.api.command).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
    expect(vi.mocked(f.api.command).mock.calls[0]![2].payload).toMatchObject({ action, controlEpoch: '5', draftHandled: action === 'resume_automation', initialUnknownDisposition: action === 'resolve_initial_assignment' ? 'delivered_continue' : null });
  });
  it('retains a checked confirmation across frames and native identity enrichment within the same control epoch', async () => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    const suspended = structuredClone(f.get()); suspended.binding.nativeSessionId = null; suspended.snapshot!.binding.nativeSessionId = null;
    suspended.control = { ...suspended.control!, controlEpoch: '3', state: 'suspended', initialAssignment: 'transport_completed', availableActions: ['resume_automation', 'acquire_control'] };
    f.set(suspended); fireEvent.click(screen.getByRole('button', { name: 'Resume automatic execution' })); fireEvent.click(screen.getByRole('checkbox'));
    const enriched = structuredClone(suspended); enriched.binding.nativeSessionId = 'native-session'; enriched.snapshot!.binding.nativeSessionId = 'native-session'; enriched.snapshot!.frame.frameSeq = '8'; f.set(enriched);
    expect(screen.getByRole('checkbox')).toBeChecked(); fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(f.api.command).toHaveBeenCalledOnce());
    expect(vi.mocked(f.api.command).mock.calls[0]![2].payload).toMatchObject({ action: 'resume_automation', controlEpoch: '3', draftHandled: true });
  });
  it('checks the live control identity before a stale confirmation handler can dispatch', async () => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce());
    const suspended: TerminalSessionState = { ...f.get(), control: { ...f.get().control!, controlEpoch: '3', state: 'suspended', initialAssignment: 'transport_completed', availableActions: ['resume_automation', 'acquire_control'] } };
    f.set(suspended); fireEvent.click(screen.getByRole('button', { name: 'Resume automatic execution' })); fireEvent.click(screen.getByRole('checkbox'));
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    act(() => { f.publish({ ...suspended, control: { ...suspended.control!, controlEpoch: '5' } }); confirm.click(); });
    expect(f.api.command).not.toHaveBeenCalled(); expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });
  it('requires a new acknowledgement when a different operation becomes unknown', async () => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce()); f.show();
    vi.mocked(f.api.command).mockRejectedValue(new Error('lost response'));
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    const acknowledge = await screen.findByRole('button', { name: 'Continue after checking' });
    fireEvent.click(acknowledge); fireEvent.click(screen.getByRole('checkbox'));
    const original = vi.mocked(f.api.command).mock.calls[0]![2];
    vi.mocked(f.api.operation).mockResolvedValue({ ...terminalEnvelope(f.get()), type: 'operation_result', payload: { operationId: original.payload.operationId, state: 'transport_completed', errorCode: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take control' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    await waitFor(() => expect(f.api.command).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue after checking' }));
    expect(screen.getByRole('checkbox')).not.toBeChecked(); expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });
  it('removes terminal content and reports permission loss', async () => {
    const f = fixture(); render(f.element()); await waitFor(() => expect(f.api.channel).toHaveBeenCalledOnce()); f.show();
    vi.mocked(f.api.state).mockRejectedValue(new ApiError('server', 403, 'permission_denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); expect(await screen.findByRole('alert')).toHaveTextContent('You no longer have permission to access this Session.');
    expect(f.close).toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Take control' })).toBeDisabled();
  });
});
