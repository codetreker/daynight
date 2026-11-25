import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, createTask, getTask, getTaskObservation, listTaskChildren, type TaskChildrenPage } from '../src/api/client';
import { OrdinaryTaskRelations } from '../src/features/task-detail/OrdinaryTaskRelations';
import { ClockInputProvider } from '../src/features/task-execution/TaskExecutionClock';
import { browserNavigation } from '../src/app/navigation';
import type { TaskDetail } from '../src/api/types';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';

vi.mock('../src/app/polling', () => ({ pollingInterval: () => 500 }));
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), createTask: vi.fn(), getTask: vi.fn(), getTaskObservation: vi.fn(), listTaskChildren: vi.fn() }));
const gate = vi.hoisted(() => ({ generation: 1, revision: 1, qualified: true, possible: true, verify: true, verifyRead: null as null | (() => Promise<boolean>), revoked: false, accessReady: true, observe: async () => 'current', listeners: new Set<(event: { projectId: string; accessRevoked?: true; directAccessUncertain?: true; scopeSuspended?: true; peerHintWithdrawal?: true; error?: unknown }) => void>(), ready: async () => {} }));
vi.mock('../src/features/task-cache/TaskCacheProvider', () => {
  const scope = { userId: 'viewer', signal: new AbortController().signal, isInvalidated: false, hasIdentityMismatch: false, isProjectSuspended: () => gate.revoked, principalMismatch: vi.fn(), getHistoryGeneration: () => gate.generation, getProjectRevision: () => gate.revision, ready: () => gate.ready(), subscribe: (listener: (event: { projectId: string; accessRevoked?: true; directAccessUncertain?: true; scopeSuspended?: true; peerHintWithdrawal?: true; error?: unknown }) => void) => { gate.listeners.add(listener); return () => gate.listeners.delete(listener); }, beginTaskRead: async () => ({}), observeHistory: () => gate.observe(), prepareProjection: async () => new Map(), qualifyProjection: async (_snapshot: unknown, items: readonly { projectId: string; id: string }[]) => new Set(items.map(item => `${item.projectId}/${item.id}`)), reportTaskDeleted: vi.fn(), verifyTaskRead: () => gate.verifyRead?.() ?? Promise.resolve(gate.verify), isTaskReadCurrent: () => gate.qualified, isTaskHistoryPossiblyCurrent: () => gate.possible, isTaskHistoryConfirmedCurrent: () => gate.qualified };
  return { useTaskCacheScope: () => scope };
});
vi.mock('../src/features/task-detail/TaskDetailSession', () => ({ useTaskDetailSessions: () => sessions }));
const sessions = { captureDirectQualification: () => gate.qualified ? {} : null, verifyDirectQualificationHistory: async () => gate.qualified, isDirectQualificationHistoryCurrent: () => gate.qualified, verifyDirectQualification: async () => gate.qualified };
vi.mock('../src/features/projects/ProjectAccess', () => ({ useProjectAccess: () => ({ ready: gate.accessReady, status: 'ready', session: { waitForFreshAccess: async () => ({}), snapshot: () => ({ status: 'ready', refreshing: !gate.accessReady }) } }), ProjectAccessBoundary: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../src/features/task-assignment/AssigneePicker', () => ({ AssigneePicker: ({ children, onSelect }: { children: React.ReactNode; onSelect: (value: string) => void }) => <button type="button" onClick={() => onSelect('another')}>{children}</button> }));
const auxiliary = vi.hoisted(() => ({
  usage: vi.fn(), colors: vi.fn(), assignees: vi.fn(),
  people: new Map([['30000000-0000-4000-8000-000000000001', { name: 'Child owner', avatarUrl: null, hasProjectAccess: true }]]),
}));
vi.mock('../src/features/task-assignees/TaskAssignees', () => ({ useTaskAssigneeDemand: (projectId: string, ids: readonly (string | null)[]) => {
  auxiliary.assignees(projectId, ids); return { people: auxiliary.people };
} }));
vi.mock('../src/features/usage/useTaskUsage', () => ({ useTaskUsage: (projectId: string, taskId: string, active: boolean) => {
  auxiliary.usage(projectId, taskId, active); return { summary: null, error: null, pending: false };
} }));
vi.mock('../src/features/task-tags/useTagColors', () => ({ useTagColors: (projectId: string, ids: readonly string[]) => {
  auxiliary.colors(projectId, ids); return { items: new Map(), loading: false, error: null, retry: vi.fn() };
} }));
vi.mock('../src/features/task-tags/TagPicker', () => ({ TagPicker: () => null }));
const project = '10000000-0000-4000-8000-000000000001';
const parentId = '20000000-0000-4000-8000-000000000001';
const parent = detailFixture(project, parentId, { title: 'Parent', parentTaskId: null });
const { parentTaskId: _relation, ...oldParent } = parent;
const child = (n: number, status: 'proposed' | 'todo' | 'in_progress' | 'done' | 'cancelled') => detailFixture(project, `20000000-0000-4000-8000-00000000000${n}`, { title: `Child ${n}`, status, parentTaskId: parentId });
vi.mocked(getTaskObservation).mockImplementation(async () => ({ epoch: 'epoch', detail: parent }));
const panel = (detail = parent) => <ClockInputProvider input={{ observedAt: '2026-10-22T10:02:00Z', receivedMonotonic: performance.now(), warningMinutes: 60 }}><OrdinaryTaskRelations projectId={project} detail={detail} history={1} active onRefreshGraph={vi.fn()} /></ClockInputProvider>;
afterEach(() => { cleanup(); document.getElementById('root')?.remove(); vi.resetAllMocks(); vi.mocked(getTaskObservation).mockImplementation(async () => ({ epoch: 'epoch', detail: parent })); gate.generation = 1; gate.revision = 1; gate.qualified = true; gate.possible = true; gate.verify = true; gate.revoked = false; gate.listeners.clear(); gate.ready = async () => {}; gate.observe = async () => 'current'; gate.verifyRead = null; gate.accessReady = true; });

it('loads the authorized page, five states and real Task links, without treating missing projection as no parent', async () => {
  const ancestor = detailFixture(project, '20000000-0000-4000-8000-000000000009', { title: 'Ancestor', parentTaskId: null });
  vi.mocked(getTaskObservation).mockResolvedValueOnce({ epoch: 'epoch', detail: { ...parent, parentTaskId: ancestor.id } }); vi.mocked(getTask).mockResolvedValueOnce(ancestor);
  vi.mocked(listTaskChildren).mockResolvedValueOnce({ items: [child(2, 'proposed'), child(3, 'todo'), child(4, 'in_progress'), child(5, 'done'), child(6, 'cancelled')], nextCursor: null });
  renderWithLocale(panel(oldParent), { locale: 'en' });
  await screen.findByText('Ancestor');
  const section = screen.getByRole('region', { name: 'Subtasks' });
  for (const name of ['Proposed', 'To do', 'In progress', 'Done', 'Cancelled']) expect(within(section).getByText(name)).toBeVisible();
  expect([...section.querySelectorAll('.task-row')].map(row => row.getAttribute('data-task-status'))).toEqual(['proposed', 'todo', 'in_progress', 'done', 'cancelled']);
  expect(within(section).getByRole('link', { name: 'Child 6' })).toHaveAttribute('href', `/projects/${project}/tasks/20000000-0000-4000-8000-000000000006`);
  expect(getTaskObservation).toHaveBeenCalledOnce(); expect(getTask).toHaveBeenCalledOnce();
});

it('maps the authorized child detail into standard metadata without fabricating Worker or Session facts', async () => {
  const current = { ...child(2, 'in_progress'), title: 'Complete child title', assignedTo: '30000000-0000-4000-8000-000000000001',
    tags: [{ id: '40000000-0000-4000-8000-000000000001', name: 'Important' }], allowAgents: true,
    requiredPlatform: 'windows' as const, ready: true, blockedBy: [parentId], properties: { paused: true }, startedAt: '2026-10-22T10:00:00Z' };
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [current], nextCursor: null });
  renderWithLocale(panel(), { locale: 'en' });
  const row = (await screen.findByRole('link', { name: current.title })).closest('.task-row')!;
  expect(row).toHaveTextContent(current.id);
  for (const text of ['Child owner', 'Important', 'Windows', 'Automatic execution', 'Ready', 'Worker record unknown']) expect(row).toHaveTextContent(text);
  expect(row.querySelector('time')).toHaveAttribute('datetime', current.createdAt);
  expect(row.querySelector('.task-row-execution')).toBeVisible();
  expect(row.querySelector('.task-paused-badge')).toBeVisible(); expect(row.querySelector('.graph-blocked-badge')).toBeVisible();
  expect(row.querySelector('.task-row-primary-status')).toHaveTextContent(/^In progress$/);
  expect(within(row as HTMLElement).queryByRole('button', { name: /Open Session/ })).toBeNull();
  expect(getTask).not.toHaveBeenCalled();
  expect(vi.mocked(getTaskObservation).mock.calls.every(call => call[1] === parentId)).toBe(true);
});

it('preserves modified links and copies the real child ID without navigating', async () => {
  const current = child(2, 'todo');
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [current], nextCursor: null });
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: write } });
  const navigate = vi.spyOn(browserNavigation(), 'navigate').mockImplementation(() => {});
  renderWithLocale(panel(), { locale: 'en' });
  const link = await screen.findByRole('link', { name: current.title });
  for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, [key]: true });
    act(() => link.dispatchEvent(event)); expect(event.defaultPrevented).toBe(false);
  }
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Copy task ID' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Copied');
  expect(write).toHaveBeenCalledExactlyOnceWith(current.id); expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledExactlyOnceWith(`/projects/${project}/tasks/${current.id}`);
  navigate.mockRestore(); vi.unstubAllGlobals();
});

it('starts row helper demands only for visible authorized subtasks and withdraws rows on access loss', async () => {
  const current = { ...child(2, 'todo'), assignedTo: '30000000-0000-4000-8000-000000000001', tags: [{ id: '40000000-0000-4000-8000-000000000001', name: 'Important' }] };
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [current], nextCursor: null });
  const tree = (subtasksActive: boolean) => <OrdinaryTaskRelations projectId={project} detail={parent} history={1} active subtasksActive={subtasksActive} onRefreshGraph={vi.fn()} />;
  const view = renderWithLocale(tree(false), { locale: 'en' });
  await screen.findByRole('link', { name: current.title });
  expect(auxiliary.usage.mock.calls.every(call => call[2] === false)).toBe(true);
  expect(auxiliary.colors.mock.calls.every(call => call[1].length === 0)).toBe(true);
  expect(auxiliary.assignees).not.toHaveBeenCalled();
  view.rerender(tree(true));
  expect(auxiliary.usage).toHaveBeenCalledWith(project, current.id, true);
  expect(auxiliary.colors).toHaveBeenCalledWith(project, [current.tags[0]!.id]);
  expect(auxiliary.assignees).toHaveBeenCalledWith(project, [current.assignedTo]);
  auxiliary.usage.mockClear(); auxiliary.colors.mockClear(); auxiliary.assignees.mockClear();
  view.rerender(tree(false));
  expect(auxiliary.usage.mock.calls.every(call => call[2] === false)).toBe(true);
  expect(auxiliary.colors.mock.calls.every(call => call[1].length === 0)).toBe(true);
  expect(auxiliary.assignees).not.toHaveBeenCalled();
  auxiliary.usage.mockClear(); auxiliary.colors.mockClear();
  act(() => { gate.revoked = true; gate.possible = false; for (const listener of [...gate.listeners]) listener({ projectId: project, accessRevoked: true }); });
  expect(screen.queryByRole('link', { name: current.title })).toBeNull();
  expect(auxiliary.usage).not.toHaveBeenCalled(); expect(auxiliary.colors).not.toHaveBeenCalled(); expect(auxiliary.assignees).not.toHaveBeenCalled();
});

it.each([true, false])('provides an explicit %s graph clock for timed child rows outside an inherited clock', async observed => {
  const current = { ...child(2, 'in_progress'), startedAt: '2026-10-22T09:00:00Z' };
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [current], nextCursor: null });
  renderWithLocale(<OrdinaryTaskRelations projectId={project} detail={parent} history={1} active snapshot={observed ? snapshotFixture([parent]) : null} onRefreshGraph={vi.fn()} />, { locale: 'en' });
  const row = (await screen.findByRole('link', { name: current.title })).closest('.task-row')!;
  if (observed) expect(row.querySelector('.task-row-execution')).toBeVisible();
  else { expect(row.querySelector('.task-row-execution')).toBeNull(); expect(row).toHaveTextContent('Duration unknown'); }
});

it('distinguishes empty, read failure and retry, and pages by the server cursor', async () => {
  vi.mocked(listTaskChildren).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce({ items: [child(2, 'todo')], nextCursor: 'next' }).mockResolvedValueOnce({ items: [], nextCursor: null });
  renderWithLocale(panel(), { locale: 'en' });
  await screen.findByText(/Could not load subtasks/); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('Child 2'); fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('No subtasks'); expect(vi.mocked(listTaskChildren).mock.calls[2]![2]).toBe('next');
});

it('discards a delayed page when the project history changes', async () => {
  const pending = Promise.withResolvers<never>(); vi.mocked(listTaskChildren).mockReturnValueOnce(pending.promise);
  renderWithLocale(panel(), { locale: 'en' }); await waitFor(() => expect(listTaskChildren).toHaveBeenCalledOnce());
  gate.generation++; await act(async () => pending.resolve({ items: [child(2, 'todo')], nextCursor: null } as never));
  expect(screen.queryByText('Child 2')).toBeNull();
});

it('submits the fixed ordinary parent and assignee exactly once; uncertain results are not retried', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null }); vi.mocked(createTask).mockRejectedValueOnce(new ApiError('network'));
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(panel(), { locale: 'en', container: root }); await screen.findByText('No subtasks');
  const opener = screen.getByRole('button', { name: 'New subtask' }); opener.focus(); fireEvent.click(opener);
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Fix' } });
  fireEvent.click(screen.getByRole('button', { name: 'Assignee: viewer' })); fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'todo' } }); fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByText(/creation outcome is unknown/i);
  expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ title: 'Fix', parentTaskId: parentId, status: 'todo', assignedTo: 'another' });
  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Refresh subtasks' }));
  expect(createTask).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: 'Create another subtask' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(opener).toHaveFocus();
});

it('shows the server refusal when nested creation is disabled', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(createTask).mockRejectedValueOnce(new ApiError('server', 400, 'invalid_input', null, undefined, 'Nested subtasks are disabled for this Team.'));
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(panel(), { locale: 'en', container: root }); await screen.findByText('No subtasks');
  fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Nested' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Nested subtasks are disabled for this Team.');
  expect(createTask).toHaveBeenCalledOnce();
});

it('refreshes child versions without replacing focused links or requiring a parent version change', async () => {
  const first = child(2, 'todo');
  vi.mocked(listTaskChildren).mockResolvedValueOnce({ items: [first], nextCursor: null }).mockResolvedValue({ items: [{ ...first, status: 'done', version: 2n }], nextCursor: null });
  renderWithLocale(panel(), { locale: 'en' });
  const link = await screen.findByRole('link', { name: 'Child 2' }); link.focus();
  await waitFor(() => expect(screen.getByText('Done')).toBeVisible(), { timeout: 2000 });
  expect(screen.getByRole('link', { name: 'Child 2' })).toBe(link); expect(link).toHaveFocus();
});

it('refuses to infer absence from an old service and refreshes a changed parent', async () => {
  vi.mocked(getTaskObservation).mockResolvedValueOnce({ epoch: 'epoch', detail: oldParent });
  const refresh = vi.fn(); const view = renderWithLocale(<OrdinaryTaskRelations projectId={project} detail={parent} history={1} active onRefreshGraph={refresh} />, { locale: 'en' });
  expect(await screen.findByText(/does not support ordinary Task relationships/)).toBeVisible(); expect(listTaskChildren).not.toHaveBeenCalled();
  vi.mocked(getTaskObservation).mockResolvedValueOnce({ epoch: 'epoch', detail: { ...parent, version: 2n, status: 'done' } });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText(/Task changed/); expect(refresh).toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'New subtask' })).toBeDisabled();
  view.unmount();
});


it('retains a confirmed creation receipt if post-write history verification fails', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(createTask).mockImplementationOnce(async () => { gate.verify = false; return child(2, 'proposed'); });
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(panel(), { locale: 'en', container: root }); await screen.findByText('No subtasks');
  fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Child 2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(await screen.findByText(/Subtask created:/)).toHaveTextContent('Child 2');
  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); expect(createTask).toHaveBeenCalledOnce(); fireEvent.click(within(screen.getByRole('dialog').querySelector('footer')!).getByRole('button', { name: 'Close' }));
});


it('withdraws an open form on access loss and does not restore a late creation receipt', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const pending = Promise.withResolvers<never>(); vi.mocked(createTask).mockReturnValueOnce(pending.promise);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(panel(), { locale: 'en', container: root }); await screen.findByText('No subtasks');
  fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Private draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  act(() => { gate.revoked = true; gate.possible = false; for (const listener of [...gate.listeners]) listener({ projectId: project, accessRevoked: true, error: new ApiError('server', 404, 'not_found') }); });
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => pending.resolve(child(2, 'proposed') as never));
  expect(screen.queryByText(/Subtask created:/)).toBeNull(); expect(screen.queryByText('Private draft')).toBeNull();
});


it.each(['confirmed', 'unknown', 'refused'] as const)('settles a %s result after navigation and restores it without replay', async outcome => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const pending = Promise.withResolvers<never>(); vi.mocked(createTask).mockReturnValueOnce(pending.promise);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const first = renderWithLocale(panel(), { locale: 'en', container: root }); await screen.findByText('No subtasks');
  fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Unfinished delivery' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  first.unmount();
  await act(async () => { if (outcome === 'confirmed') pending.resolve(child(2, 'proposed') as never); else pending.reject(outcome === 'unknown' ? new ApiError('network') : new ApiError('server', 400, 'invalid_input')); });
  root.remove(); const nextRoot = document.createElement('div'); nextRoot.id = 'root'; document.body.append(nextRoot);
  const second = renderWithLocale(panel(), { locale: 'en', container: nextRoot }); await screen.findByText('No subtasks');
  fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  if (outcome === 'confirmed') { expect(screen.getByText(/Subtask created:/)).toHaveTextContent('Child 2'); expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); fireEvent.click(within(screen.getByRole('dialog').querySelector('footer')!).getByRole('button', { name: 'Close' })); fireEvent.click(screen.getByRole('button', { name: 'New subtask' })); expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(''); }
  else if (outcome === 'unknown') { expect(screen.getByText(/creation outcome is unknown/i)).toBeVisible(); expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Create another subtask' })); }
  else { expect(screen.getByRole('alert')).toBeVisible(); expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Unfinished delivery'); expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled(); }
  expect(createTask).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); second.unmount();
});

it('retains the in-flight outcome across a temporarily uncertain history and resumes without replay', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const pending = Promise.withResolvers<never>(); vi.mocked(createTask).mockReturnValueOnce(pending.promise);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(panel(), { locale: 'en', container: root }); await screen.findByText('No subtasks');
  fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Retained draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  act(() => { gate.qualified = false; for (const listener of [...gate.listeners]) listener({ projectId: project, accessRevoked: true, directAccessUncertain: true, error: new ApiError('server', 404, 'not_found') }); });
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => pending.reject(new ApiError('network')));
  act(() => { gate.qualified = true; for (const listener of [...gate.listeners]) listener({ projectId: project }); });
  fireEvent.click(await screen.findByRole('button', { name: 'New subtask' }));
  await screen.findByText(/creation outcome is unknown/i);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Retained draft'); expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); expect(createTask).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Create another subtask' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
});


it('retains pending and unknown creation across a peer cache withdrawal', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const pending = Promise.withResolvers<never>(); vi.mocked(createTask).mockReturnValueOnce(pending.promise);
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(panel(), { locale: 'en', container: root }); await screen.findByText('No subtasks');
  fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Peer retained draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  const withdraw = () => { gate.qualified = false; for (const listener of [...gate.listeners]) listener({ projectId: project, accessRevoked: true, peerHintWithdrawal: true, error: new ApiError('server', 404, 'not_found') }); };
  const restore = () => { gate.qualified = true; for (const listener of [...gate.listeners]) listener({ projectId: project }); };
  act(withdraw); expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => pending.reject(new ApiError('network')));
  act(restore); fireEvent.click(await screen.findByRole('button', { name: 'New subtask' })); await screen.findByText(/creation outcome is unknown/i);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Peer retained draft');
  act(withdraw); expect(screen.queryByRole('dialog')).toBeNull(); act(restore);
  fireEvent.click(await screen.findByRole('button', { name: 'New subtask' }));
  expect(await screen.findByText(/creation outcome is unknown/i)).toBeVisible(); expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); expect(createTask).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Create another subtask' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
});


it('publishes parent and children independently and retries each failure', async () => {
  const ancestor = detailFixture(project, '20000000-0000-4000-8000-000000000009', { title: 'Ancestor', parentTaskId: null });
  vi.mocked(getTaskObservation).mockResolvedValue({ epoch: 'epoch', detail: { ...parent, parentTaskId: ancestor.id } });
  const pending = Promise.withResolvers<TaskChildrenPage>();
  vi.mocked(getTask).mockResolvedValue(ancestor);
  vi.mocked(listTaskChildren).mockReturnValueOnce(pending.promise).mockResolvedValue({ items: [child(2, 'todo')], nextCursor: null });
  renderWithLocale(panel(), { locale: 'en' });
  expect(await screen.findByText('Ancestor')).toBeVisible();
  await act(async () => pending.reject(new ApiError('network')));
  expect(await screen.findByText(/Could not load subtasks/)).toBeVisible();
  expect(screen.getByText('Ancestor')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Child 2')).toBeVisible();
});

it('publishes children when the parent read fails and recovers the parent', async () => {
  const ancestor = detailFixture(project, '20000000-0000-4000-8000-000000000009', { title: 'Ancestor', parentTaskId: null });
  vi.mocked(getTaskObservation).mockResolvedValue({ epoch: 'epoch', detail: { ...parent, parentTaskId: ancestor.id } });
  vi.mocked(getTask).mockRejectedValueOnce(new ApiError('network')).mockResolvedValue(ancestor);
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [child(2, 'todo')], nextCursor: null });
  renderWithLocale(panel(), { locale: 'en' });
  expect(await screen.findByText('Child 2')).toBeVisible();
  expect(await screen.findByText(/Could not load parent Task/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Ancestor')).toBeVisible();
  expect(screen.getByText('Child 2')).toBeVisible();
});

it('does not send an old preflight after leaving and returning to the tab', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const pending = Promise.withResolvers<string>(); let observations = 0;
  gate.observe = () => ++observations === 2 ? pending.promise : Promise.resolve('current');
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const renderPanel = (visible: boolean) => <OrdinaryTaskRelations projectId={project} detail={parent} history={1} active subtasksActive={visible} onRefreshGraph={vi.fn()} />;
  const view = renderWithLocale(renderPanel(true), { locale: 'en', container: root });
  await screen.findByText('No subtasks'); fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Old operation' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(observations).toBe(2));
  view.rerender(renderPanel(false)); expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(renderPanel(true)); fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  await act(async () => pending.resolve('current'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled());
  expect(createTask).not.toHaveBeenCalled();
});

it('consumes a dispatched receipt once while leaving a later presentation open', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const pending = Promise.withResolvers<TaskDetail>(); vi.mocked(createTask).mockReturnValueOnce(pending.promise);
  const refresh = vi.fn(); const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const renderPanel = (visible: boolean) => <OrdinaryTaskRelations projectId={project} detail={parent} history={1} active subtasksActive={visible} onRefreshGraph={refresh} />;
  const view = renderWithLocale(renderPanel(true), { locale: 'en', container: root });
  await screen.findByText('No subtasks'); fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Dispatched' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  view.rerender(renderPanel(false)); expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(renderPanel(true)); fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  await act(async () => pending.resolve(child(2, 'proposed')));
  expect(await screen.findByText(/Subtask created:/)).toBeVisible();
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByRole('dialog')).toBeVisible(); expect(createTask).toHaveBeenCalledOnce();
  fireEvent.click(within(screen.getByRole('dialog').querySelector('footer')!).getByRole('button', { name: 'Close' }));
});


it('retries a failed next page at its cursor', async () => {
  vi.mocked(listTaskChildren).mockResolvedValueOnce({ items: [child(2, 'todo')], nextCursor: 'next' })
    .mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce({ items: [child(3, 'done')], nextCursor: null });
  renderWithLocale(panel(), { locale: 'en' });
  await screen.findByText('Child 2'); fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText(/Could not load subtasks/); fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Child 3')).toBeVisible();
  expect(vi.mocked(listTaskChildren).mock.calls[2]![2]).toBe('next');
});


it('retains a receipt until access is ready again, including loss during verification', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const write = Promise.withResolvers<TaskDetail>(); vi.mocked(createTask).mockReturnValueOnce(write.promise);
  const refresh = vi.fn(); const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  const panel = () => <OrdinaryTaskRelations projectId={project} detail={parent} history={1} active onRefreshGraph={refresh} />;
  const view = renderWithLocale(panel(), { locale: 'en', container: root });
  await screen.findByText('No subtasks'); fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Access pending' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' })); await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  const verification = Promise.withResolvers<boolean>(); let verifications = 0;
  gate.verifyRead = () => { verifications++; return verification.promise; };
  await act(async () => write.resolve(child(2, 'proposed')));
  await waitFor(() => expect(verifications).toBeGreaterThan(0));
  gate.accessReady = false;
  await act(async () => verification.resolve(true));
  expect(refresh).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeVisible();
  gate.verifyRead = async () => true;
  view.rerender(panel());
  expect(refresh).not.toHaveBeenCalled();
  gate.accessReady = true; view.rerender(panel());
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(createTask).toHaveBeenCalledOnce();
});


it('checks current project access after the final preflight await before sending', async () => {
  vi.mocked(listTaskChildren).mockResolvedValue({ items: [], nextCursor: null });
  const pending = Promise.withResolvers<string>(); let observations = 0;
  gate.observe = () => ++observations === 2 ? pending.promise : Promise.resolve('current');
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  renderWithLocale(panel(), { locale: 'en', container: root });
  await screen.findByText('No subtasks'); fireEvent.click(screen.getByRole('button', { name: 'New subtask' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Access changed' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(observations).toBe(2));
  gate.accessReady = false;
  await act(async () => pending.resolve('current'));
  expect(await screen.findByText('Creation failed.')).toBeVisible();
  expect(createTask).not.toHaveBeenCalled();
});
