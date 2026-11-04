import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { ManagedSessionRecords, TaskSessionHost } from '../src/features/task-agent-session/TaskSessionHost';
import { createTerminalSessionApi } from '../src/api/terminal-sessions';
vi.mock('../src/api/terminal-sessions', () => ({ createTerminalSessionApi: vi.fn(), parseSessionHistory: (value: unknown) => value }));
vi.mock('../src/features/task-agent-session/TaskAgentSession', () => ({ TaskAgentSession: () => <div>Native timeline</div> }));
afterEach(() => sessionStorage.clear());
const render = createLocaleRender('en', { taskCache: true });
const projectId = '00000001-1111-4111-8111-111111111111';
const taskId = '00000002-1111-4111-8111-111111111111';
const claimId = '00000003-1111-4111-8111-111111111111';
const record = { sessionId: '00000004-1111-4111-8111-111111111111', claimId, executionGeneration: '1', agentControlMode: 'herdr', contentKind: 'terminal_recording', createdAt: '2026-11-03T10:00:00Z', endedAt: '2026-11-03T10:01:00Z', archive: { state: 'pending', sha256: null, byteLength: null, completeness: null } } as const;
function fixture() {
  const api = { history: vi.fn(async () => ({ items: [record], nextCursor: null })), archive: vi.fn(async () => ({ status: { payload: { state: 'pending' } }, archive: null })), current: vi.fn(), channel: vi.fn(), command: vi.fn() };
  vi.mocked(createTerminalSessionApi).mockReturnValue(api as never); return api;
}
describe('unified Session and managed records', () => {
  it('keeps native current rendering and opens history by original identity without controls', async () => {
    const api = fixture();
    const view = render(<TaskSessionHost projectId={projectId} taskId={taskId} claimId={claimId} mode="web" active current />);
    expect(screen.getByText('Native timeline')).toBeInTheDocument();
    await screen.findByRole('option', { name: /Herdr/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Execution record' }), { target: { value: record.sessionId } });
    await screen.findByText('Recording is waiting to be archived.');
    expect(api.archive).toHaveBeenCalledWith(record, expect.any(AbortSignal));
    view.rerender(<TaskSessionHost projectId={projectId} taskId={taskId} claimId={taskId} mode="web" active current />);
    expect(screen.getByRole('combobox', { name: 'Execution record' })).toHaveValue(record.sessionId);
    expect(api.current).not.toHaveBeenCalled(); expect(api.channel).not.toHaveBeenCalled(); expect(api.command).not.toHaveBeenCalled();
  });
  it('managed attachment entries only open read-only records and do not expose mutation actions', async () => {
    const api = fixture(); render(<ManagedSessionRecords projectId={projectId} taskId={taskId} active />);
    fireEvent.click(await screen.findByRole('button', { name: /Herdr/ }));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith(record, expect.any(AbortSignal)));
    expect(screen.queryByRole('button', { name: /delete|rename|download|take control/i })).toBeNull();
    expect(api.channel).not.toHaveBeenCalled();
  });
});
