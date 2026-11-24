import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, createTask, getTask, getTaskObservation, listTaskChildren } from '../src/api/client';
import { OrdinaryTaskRelations } from '../src/features/task-detail/OrdinaryTaskRelations';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture } from './helpers/taskDetail';

vi.mock('../src/app/polling', () => ({ pollingInterval: () => 500 }));
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), createTask: vi.fn(), getTask: vi.fn(), getTaskObservation: vi.fn(), listTaskChildren: vi.fn() }));
const gate = vi.hoisted(() => ({ generation: 1, revision: 1, qualified: true, possible: true, verify: true, revoked: false, listeners: new Set<(event: { projectId: string; accessRevoked?: true; directAccessUncertain?: true; scopeSuspended?: true; peerHintWithdrawal?: true; error?: unknown }) => void>(), ready: async () => {} }));
vi.mock('../src/features/task-cache/TaskCacheProvider', () => {
  const scope = { userId: 'viewer', signal: new AbortController().signal, isInvalidated: false, hasIdentityMismatch: false, isProjectSuspended: () => gate.revoked, principalMismatch: vi.fn(), getHistoryGeneration: () => gate.generation, getProjectRevision: () => gate.revision, ready: () => gate.ready(), subscribe: (listener: (event: { projectId: string; accessRevoked?: true; directAccessUncertain?: true; scopeSuspended?: true; peerHintWithdrawal?: true; error?: unknown }) => void) => { gate.listeners.add(listener); return () => gate.listeners.delete(listener); }, beginTaskRead: async () => ({}), observeHistory: async () => 'current', verifyTaskRead: async () => gate.verify, isTaskReadCurrent: () => gate.qualified, isTaskHistoryPossiblyCurrent: () => gate.possible, isTaskHistoryConfirmedCurrent: () => gate.qualified };
  return { useTaskCacheScope: () => scope };
});
vi.mock('../src/features/task-detail/TaskDetailSession', () => ({ useTaskDetailSessions: () => sessions }));
const sessions = { captureDirectQualification: () => gate.qualified ? {} : null, verifyDirectQualificationHistory: async () => gate.qualified, isDirectQualificationHistoryCurrent: () => gate.qualified, verifyDirectQualification: async () => gate.qualified };
vi.mock('../src/features/projects/ProjectAccess', () => ({ useProjectAccess: () => ({ ready: true, status: 'ready', session: { waitForFreshAccess: async () => ({}) } }), ProjectAccessBoundary: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../src/features/task-assignment/AssigneePicker', () => ({ AssigneePicker: ({ children, onSelect }: { children: React.ReactNode; onSelect: (value: string) => void }) => <button type="button" onClick={() => onSelect('another')}>{children}</button> }));
vi.mock('../src/features/task-assignment/TaskAssigneeIdentity', () => ({ TaskAssigneeIdentity: ({ assignedTo }: { assignedTo: string | null }) => <span>{assignedTo ?? 'Unassigned'}</span> }));
vi.mock('../src/features/task-tags/TagPicker', () => ({ TagPicker: () => null }));
const project = '10000000-0000-4000-8000-000000000001';
const parentId = '20000000-0000-4000-8000-000000000001';
const parent = detailFixture(project, parentId, { title: 'Parent', parentTaskId: null });
const { parentTaskId: _relation, ...oldParent } = parent;
const child = (n: number, status: 'proposed' | 'todo' | 'in_progress' | 'done' | 'cancelled') => detailFixture(project, `20000000-0000-4000-8000-00000000000${n}`, { title: `Child ${n}`, status, parentTaskId: parentId });
vi.mocked(getTaskObservation).mockImplementation(async () => ({ epoch: 'epoch', detail: parent }));
const panel = (detail = parent) => <OrdinaryTaskRelations projectId={project} detail={detail} history={1} active onRefreshGraph={vi.fn()} />;
afterEach(() => { cleanup(); document.getElementById('root')?.remove(); vi.resetAllMocks(); vi.mocked(getTaskObservation).mockImplementation(async () => ({ epoch: 'epoch', detail: parent })); gate.generation = 1; gate.revision = 1; gate.qualified = true; gate.possible = true; gate.verify = true; gate.revoked = false; gate.listeners.clear(); gate.ready = async () => {}; });

it('loads the authorized page, five states and real Task links, without treating missing projection as no parent', async () => {
  const ancestor = detailFixture(project, '20000000-0000-4000-8000-000000000009', { title: 'Ancestor', parentTaskId: null });
  vi.mocked(getTaskObservation).mockResolvedValueOnce({ epoch: 'epoch', detail: { ...parent, parentTaskId: ancestor.id } }); vi.mocked(getTask).mockResolvedValueOnce(ancestor);
  vi.mocked(listTaskChildren).mockResolvedValueOnce({ items: [child(2, 'proposed'), child(3, 'todo'), child(4, 'in_progress'), child(5, 'done'), child(6, 'cancelled')], nextCursor: null });
  renderWithLocale(panel(oldParent), { locale: 'en' });
  await screen.findByText('Ancestor');
  const section = screen.getByRole('region', { name: 'Subtasks' });
  for (const name of ['Proposed', 'To do', 'In progress', 'Done', 'Cancelled']) expect(within(section).getByText(name)).toBeVisible();
  expect(within(section).getByRole('link', { name: 'Child 6' })).toHaveAttribute('href', `/projects/${project}/tasks/20000000-0000-4000-8000-000000000006`);
  expect(getTaskObservation).toHaveBeenCalledOnce(); expect(getTask).toHaveBeenCalledOnce();
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
  fireEvent.click(screen.getByRole('button', { name: 'viewer' })); fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'todo' } }); fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByText(/creation outcome is unknown/i);
  expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ title: 'Fix', parentTaskId: parentId, status: 'todo', assignedTo: 'another' });
  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Refresh subtasks' }));
  expect(createTask).toHaveBeenCalledOnce(); fireEvent.click(screen.getByRole('button', { name: 'Create another subtask' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(opener).toHaveFocus();
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
  act(restore); await screen.findByText(/creation outcome is unknown/i);
  expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Peer retained draft');
  act(withdraw); expect(screen.queryByRole('dialog')).toBeNull(); act(restore);
  expect(await screen.findByText(/creation outcome is unknown/i)).toBeVisible(); expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled(); expect(createTask).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Create another subtask' })); fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
});
