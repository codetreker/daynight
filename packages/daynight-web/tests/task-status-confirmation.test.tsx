import { summariesForGraph } from './helpers/taskSync';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID } from './helpers/taskSync';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, setTaskStatus } from '../src/api/client';
import type { Project, TaskDetail, TaskGraph, TaskStatus, WorkerClaim } from '../src/api/types';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskDetailDialog, type TaskDetailDialogProps } from '../src/features/task-detail/TaskDetailDialog';
import * as taskDetailHook from '../src/features/task-detail/useTaskDetail';
import * as taskReading from '../src/features/task-detail/TaskDetailReading';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { renderWithLocale } from './helpers/renderWithLocale';
vi.mock('../src/api/client', async (original) => { const actual = await original<typeof import('../src/api/client')>(); const { fixtureTaskEpoch } = await import('./helpers/taskSync'); const read = vi.fn(); return { ...actual, getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }), setTaskStatus: vi.fn() }; });
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => <section aria-label="Attachment materials"><input aria-label="Attachment draft" defaultValue="" /></section> }));
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
vi.mock('../src/features/task-tags/TagPicker', () => ({ TagPicker: ({ value, onChange }: { value: readonly { id: string; name: string }[]; onChange: (value: readonly { id: string; name: string }[]) => void }) => <input aria-label="Tag draft" value={value[0]?.name ?? ''} onChange={(event) => onChange([{ id: '30000000-0000-4000-8000-000000000001', name: event.currentTarget.value }])} /> }));
const projectId = '10000000-0000-4000-8000-000000000001'; const taskId = '20000000-0000-4000-8000-000000000001'; const dependencyId = '20000000-0000-4000-8000-000000000002';
const time = '2026-10-22T00:00:00Z'; const later = '2026-10-22T00:01:00Z';
const project: Project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, id: projectId, name: 'Status project', repoUrl: 'https://example.com/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const source = (status: TaskStatus = 'todo'): TaskDetail => ({ tags: [], type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: status === 'proposed' || status === 'todo' ? null : time, completedAt: status === 'done' ? time : null, cancelledAt: status === 'cancelled' ? time : null, id: taskId, projectId, title: 'Reviewed task', description: 'Reviewed content',
  status, version: 9007199254740993n, properties: { pullRequests: [] }, dependsOn: [dependencyId], blockedBy: [], ready: status === 'todo', createdAt: time, updatedAt: time });
const result = (detail: TaskDetail, status: TaskStatus): TaskDetail => detail.status === status ? detail : ({ ...detail, status, version: detail.version + 1n, ready: status === 'todo', updatedAt: later,
  startedAt: status === 'cancelled' ? detail.startedAt : status === 'in_progress' ? later : status === 'proposed' || status === 'todo' || detail.status === 'proposed' || detail.status === 'todo' ? null : detail.startedAt, completedAt: status === 'cancelled' ? detail.completedAt : status === 'done' ? later : null, cancelledAt: status === 'cancelled' ? later : null });
let world: ReturnType<typeof createTaskSessionWorld>;
const snapshotDetails = new WeakMap<object, readonly TaskDetail[]>();
const snapshot = (detail: TaskDetail, revision = 1): GraphSnapshot => {
  const tasks = [detail, { ...source('done'), id: dependencyId, title: 'Prerequisite', dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false }];
  const graph: TaskGraph = { observedAt: time, project, tasks: tasks.map(({ version: _version, projectId: _project, title, description: _description, properties: _properties, ...task }) => ({ ...task, titlePreview: title, titleTruncated: false })),
    summary: { proposed: tasks.filter((task) => task.status === "proposed").length, total: 2, todo: tasks.filter((task) => task.status === 'todo').length, inProgress: tasks.filter((task) => task.status === 'in_progress').length, done: tasks.filter((task) => task.status === 'done').length, cancelled: tasks.filter((task) => task.status === 'cancelled').length, ready: detail.ready ? 1 : 0, blocked: 0 } };
  const result = { observedAt: time, graph, index: buildGraphIndex(graph), summaries: summariesForGraph(graph), workerMachines: new Map(), pausedTaskIds: new Set<string>(), receivedMonotonic: performance.now(), receivedAt: 1, revision };
  snapshotDetails.set(result, tasks);
  return result;
};
const labels = { proposed: 'Proposed', todo: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
let root: HTMLDivElement;
beforeEach(() => { world = createTaskSessionWorld(); root = document.createElement('div'); root.id = 'root'; document.body.append(root); vi.mocked(getTask).mockReset(); vi.mocked(setTaskStatus).mockReset(); });
afterEach(() => { cleanup(); world.dispose(); root.remove(); });
const open = async (detail = source()) => {
  vi.mocked(getTask).mockResolvedValue(detail); const props: TaskDetailDialogProps = { projectId, taskId, snapshot: snapshot(detail), onClose: vi.fn(), onRestoreFocus: vi.fn(), onRefreshGraph: vi.fn(), onSelectTask: vi.fn() };
  await world.sync(snapshotDetails.get(props.snapshot!)!);
  const view = renderWithLocale(<TaskDetailDialog {...props} />, { locale: 'en', container: root, taskCache: { scope: world.scope } }); await screen.findByRole('heading', { name: detail.title }); return { ...view, props, sync: async (value: TaskDetail) => { vi.mocked(getTask).mockResolvedValue(value); await world.sync([value]); view.rerender(<TaskDetailDialog {...props} snapshot={snapshot(value, 2)} />); }, dialog: screen.getByRole('dialog'), rerender: async (ui: React.ReactElement<TaskDetailDialogProps>) => { await world.sync(snapshotDetails.get(ui.props.snapshot!)!); view.rerender(ui); } };
};
const select = (dialog: HTMLElement, current: TaskStatus, target: TaskStatus) => { fireEvent.click(within(dialog).getByRole('button', { name: labels[current] })); fireEvent.click(within(dialog).getByRole('menuitemradio', { name: labels[target] })); return screen.getByRole('alertdialog', { name: 'Set task status' }); };
describe('status menu and reviewed confirmation', () => {
  it('keeps the tag draft during a refresh failure and discards it on confirmed Task access loss', () => {
    const detail = source(); const noOp = vi.fn();
    const state = { detail, status: 'ready', error: null, historyGeneration: 1, displayRequiresFreshRead: false,
      mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null },
      canSetTags: true, setTags: noOp, reconcile: noOp } as unknown as ReturnType<typeof taskDetailHook.useTaskDetail>;
    const hook = vi.spyOn(taskDetailHook, 'useTaskDetail').mockReturnValue(state);
    const reading = vi.spyOn(taskReading, 'TaskDetailReading').mockImplementation(({ overview }) => <>{overview(null)}</>);
    const props: TaskDetailDialogProps = { projectId, taskId, snapshot: snapshot(detail), onClose: noOp, onRestoreFocus: noOp, onRefreshGraph: noOp, onSelectTask: noOp };
    const view = renderWithLocale(<TaskDetailDialog {...props} />, { locale: 'en', container: root, taskCache: { scope: world.scope } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Tag draft' }), { target: { value: 'Unsubmitted' } });
    hook.mockReturnValue({ ...state, error: new ApiError('network') }); view.rerender(<TaskDetailDialog {...props} />);
    expect(screen.getByRole('textbox', { name: 'Tag draft' })).toHaveValue('Unsubmitted');
    hook.mockReturnValue({ ...state, error: new ApiError('server', 403, 'forbidden') }); view.rerender(<TaskDetailDialog {...props} />);
    expect(screen.queryByRole('textbox', { name: 'Tag draft', hidden: true })).toBeNull();
    hook.mockReturnValue(state); view.rerender(<TaskDetailDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
    expect(screen.getByRole('textbox', { name: 'Tag draft' })).toHaveValue('');
    hook.mockRestore(); reading.mockRestore();
  });
  it('opens beside the platform selector on either tab and preserves attachment drafts through cancellation and Escape', async () => {
    const { dialog, props } = await open(); const opener = within(dialog).getByRole('button', { name: 'To do' });
    expect(opener.closest('.task-detail-header')).toBeNull();
    expect(opener.closest('.task-detail-state-controls')).toContainElement(within(dialog).getByRole('combobox', { name: 'Execution platform' }));
    expect(opener.parentElement!.nextElementSibling).toContainElement(within(dialog).getByRole('button', { name: 'Assignee: Unassigned' }));
    expect(opener.closest('.task-detail-status-assignee')!.nextElementSibling).toContainElement(within(dialog).getByRole('combobox', { name: 'Execution platform' }));
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Attachments' })); const draft = within(dialog).getByRole('textbox', { name: 'Attachment draft' }); fireEvent.change(draft, { target: { value: 'Retained review notes' } });
    opener.focus(); let confirmation = select(dialog, 'todo', 'done'); expect(dialog).toHaveAttribute('inert'); expect(within(confirmation).getByText('Reviewed task')).toBeVisible(); expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' })); expect(opener).toHaveFocus(); expect(dialog).not.toHaveAttribute('inert'); expect(draft).toHaveValue('Retained review notes');
    confirmation = select(dialog, 'todo', 'in_progress'); const user = userEvent.setup(); await user.tab({ shift: true }); expect(confirmation.querySelector('.dialog-body')).toHaveFocus(); await user.tab({ shift: true }); expect(within(confirmation).getByRole('button', { name: 'Close confirmation' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(opener).toHaveFocus(); expect(props.onClose).not.toHaveBeenCalled(); expect(draft).toHaveValue('Retained review notes'); expect(setTaskStatus).not.toHaveBeenCalled();
  });
  it('offers exactly five radio options and supports current selection, arrows, Home/End and Escape focus', async () => {
    const { dialog, props } = await open(source('in_progress')); const opener = within(dialog).getByRole('button', { name: 'In progress' }); opener.focus(); fireEvent.click(opener);
    const menu = within(dialog).getByRole('menu', { name: 'Task status' }); const options = within(menu).getAllByRole('menuitemradio'); expect(options).toHaveLength(5); expect(options[2]).toHaveAttribute('aria-checked', 'true'); expect(options[2]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' }); expect(options[4]).toHaveFocus(); fireEvent.keyDown(menu, { key: 'ArrowDown' }); expect(options[0]).toHaveFocus(); fireEvent.keyDown(menu, { key: 'ArrowUp' }); expect(options[4]).toHaveFocus(); fireEvent.keyDown(menu, { key: 'Home' }); expect(options[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(opener).toHaveFocus(); expect(props.onClose).not.toHaveBeenCalled();
    select(dialog, 'in_progress', 'in_progress'); expect(screen.getByText(/status and execution times will remain unchanged/)).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(setTaskStatus).not.toHaveBeenCalled();
  });
  it('selects the current radio option with Enter and Space through the keyboard', async () => {
    const { dialog } = await open(source('in_progress')); const user = userEvent.setup(); const opener = within(dialog).getByRole('button', { name: 'In progress' }); opener.focus();
    await user.keyboard('{Enter}'); expect(within(dialog).getByRole('menuitemradio', { name: 'In progress' })).toHaveFocus();
    await user.keyboard(' '); expect(screen.getByRole('alertdialog', { name: 'Set task status' })).toBeVisible(); expect(screen.getByText(/status and execution times will remain unchanged/)).toBeVisible();
    expect(setTaskStatus).not.toHaveBeenCalled();
  });
  it.each((['proposed', 'todo', 'in_progress', 'done'] as const).flatMap((from) => (['proposed', 'todo', 'in_progress', 'done'] as const).map((to) => ({ from, to }))))('routes the reviewed $from → $to and version to the session', ({ from, to }) => {
    const detail = source(from);
    const setStatus = vi.fn();
    const noOp = vi.fn();
    const state = {
      revision: 1, loadedRevision: 1, detail, status: 'ready', refreshing: false, requiresFreshRead: false, graphMismatch: false, error: null,
      mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null },
      historyGeneration: 1, displayRequiresFreshRead: false, assignmentUncertain: false, sessionCurrent: false,
      canDisplayAssignee: true, canDisplayStatus: true, canDisplayDelete: true, canDisplayAgentPermission: true, canDisplayRequiredPlatform: true, canDisplayWithdrawClaim: false,
      canUnpause: false, canWithdrawClaim: false, canDelete: true, canSetAssignedTo: true, canSetRequiredPlatform: true, canSetAgentPermission: true, canSetStatus: true,
      canSetParent: true, canEditGoal: false, canSetTags: true,
      retry: noOp, unpause: noOp, deleteTask: noOp, withdrawClaim: noOp, setStatus, setAgentPermission: noOp, setAssignedTo: noOp, setRequiredPlatform: noOp, setParent: noOp, editGoal: noOp, setTags: noOp, reconcile: noOp,
    } as const;
    vi.spyOn(taskDetailHook, 'useTaskDetail').mockReturnValue(state);
    vi.spyOn(taskReading, 'TaskDetailReading').mockReturnValue(<></>);
    const props: TaskDetailDialogProps = { projectId, taskId, snapshot: snapshot(detail), onClose: vi.fn(), onRestoreFocus: vi.fn(), onRefreshGraph: vi.fn(), onSelectTask: vi.fn() };
    renderWithLocale(<TaskDetailDialog {...props} />, { locale: 'en', container: root, taskCache: { scope: world.scope } });
    const confirmation = select(screen.getByRole('dialog'), from, to);
    expect(confirmation.querySelector('.task-status-route')).toHaveTextContent(`${labels[from]}→${labels[to]}`);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm status' }));
    expect(setStatus).toHaveBeenCalledExactlyOnceWith(to, detail.version);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('submits once through the real session, disables pending status and re-enables it after confirmation', async () => {
    const from = 'todo'; const to = 'in_progress';
    const detail = source(from); const saved = result(detail, to); const pending = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(pending.promise); const { dialog, sync } = await open(detail);
    const confirmation = select(dialog, from, to); expect(confirmation.querySelector('.task-status-route')).toHaveTextContent(`${labels[from]}→${labels[to]}`); const confirm = within(confirmation).getByRole('button', { name: 'Confirm status' }); fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, to, detail.version, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onDispatch: expect.any(Function), onWriteConfirmed: expect.any(Function), onWriteRejected: expect.any(Function) })); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(within(dialog).getByRole('button', { name: labels[from] })).toBeDisabled();
    await act(async () => pending.resolve(saved)); await within(dialog).findByText('Task status confirmed.'); await sync(saved); await waitFor(() => expect(within(dialog).getByRole('button', { name: labels[to] })).toBeEnabled());
  });
  it.each([
    { from: 'proposed', to: 'in_progress' }, { from: 'proposed', to: 'done' },
    { from: 'in_progress', to: 'proposed' }, { from: 'done', to: 'proposed' },
  ] as const)('confirms $from → $to through the real session without an intermediate state', async ({ from, to }) => {
    const detail = source(from); const saved = result(detail, to);
    vi.mocked(setTaskStatus).mockResolvedValueOnce(saved);
    const { dialog, sync } = await open(detail);
    const confirmation = select(dialog, from, to);
    if (to === 'proposed') expect(confirmation).toHaveTextContent('Returning to Proposed clears both execution timestamps.');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm status' }));
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, to, detail.version, expect.any(AbortSignal), expect.any(Object)));
    await within(dialog).findByText('Task status confirmed.');
    await sync(saved);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: labels[to] })).toBeEnabled());
  });
  it.each(['version', 'external classification', 'execution platform'] as const)('invalidates a confirmation after a fresh read changes %s', async (change) => {
    const detail = source(); const fresh = change === 'version' ? { ...detail, title: 'Revised task', version: detail.version + 1n, updatedAt: later } : change === 'execution platform' ? { ...detail, requiredPlatform: 'linux' as const, version: detail.version + 1n } : { ...detail, externalDependsOn: [dependencyId], version: detail.version + 1n };
    const { dialog, props, rerender } = await open(detail); const confirmation = select(dialog, 'todo', 'in_progress'); const oldConfirm = within(confirmation).getByRole('button', { name: 'Confirm status' });
    vi.mocked(getTask).mockResolvedValueOnce(fresh); await rerender(<TaskDetailDialog {...props} snapshot={snapshot(fresh, 2)} />); await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()); fireEvent.click(oldConfirm); expect(setTaskStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'To do' })).toBeEnabled()); select(dialog, 'todo', 'in_progress'); expect(screen.getByText(fresh.title, { selector: '.task-confirmation-task' })).toBeVisible();
  });
});


describe('task cancellation confirmation', () => {
  it('explains permanent cancellation and dependency satisfaction while keeping attachment drafts through Cancel and Escape', async () => {
    const { dialog, props } = await open();
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Attachments' }));
    const draft = within(dialog).getByRole('textbox', { name: 'Attachment draft' }); fireEvent.change(draft, { target: { value: 'Retained cancellation notes' } });
    let confirmation = select(dialog, 'todo', 'cancelled');
    expect(confirmation).toHaveTextContent('Cancellation cannot be undone');
    expect(confirmation).toHaveTextContent('dependencies on this task will count as satisfied');
    expect(confirmation).toHaveTextContent('records and materials remain readable');
    expect(within(confirmation).getByRole('button', { name: 'Confirm cancellation' })).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(draft).toHaveValue('Retained cancellation notes');
    confirmation = select(dialog, 'todo', 'cancelled'); fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(props.onClose).not.toHaveBeenCalled();
    expect(draft).toHaveValue('Retained cancellation notes'); expect(setTaskStatus).not.toHaveBeenCalled();
  });

  it('confirms cancellation and retains the same readable attachment tab after the status control becomes unavailable', async () => {
    const initial = source('done'); const saved = result(initial, 'cancelled');
    const pending = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(pending.promise);
    const { dialog, sync } = await open(initial); fireEvent.click(within(dialog).getByRole('tab', { name: 'Attachments' }));
    const draft = within(dialog).getByRole('textbox', { name: 'Attachment draft' }); fireEvent.change(draft, { target: { value: 'Saved material stays readable' } });
    fireEvent.click(within(select(dialog, 'done', 'cancelled')).getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledOnce()); pending.resolve(saved); await sync(saved);
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancelled' })).toBeDisabled());
    expect(draft).toBeInTheDocument(); expect(draft).toHaveValue('Saved material stays readable');
    expect(within(dialog).getByRole('tab', { name: 'Attachments' })).toHaveAttribute('aria-selected', 'true');
    expect(saved.startedAt).toBe(initial.startedAt); expect(saved.completedAt).toBe(initial.completedAt);
    expect(setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, 'cancelled', initial.version, expect.any(AbortSignal), expect.any(Object));
  });

  it('exposes the active release restriction on keyboard focus without dispatching a cancellation', async () => {
    const claim: WorkerClaim = { claimId: dependencyId, state: 'active', userId: TEST_VIEWER_ID, workerId: projectId, machine: { id: projectId, name: 'Active machine' }, platform: 'linux', agent: 'codex', agentControlMode: 'web', worktreeId: taskId, phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time };
    const { dialog } = await open({ ...source('in_progress'), properties: { worker: claim } });
    const opener = within(dialog).getByRole('button', { name: 'In progress' }); fireEvent.click(opener);
    const blocked = within(dialog).getByRole('menuitemradio', { name: 'Cancelled' }); expect(blocked).toHaveAttribute('aria-disabled', 'true'); expect(blocked).toHaveAccessibleDescription('Release the active Worker execution before cancelling this task.');
    fireEvent.focus(blocked); expect(within(blocked.parentElement!).getByRole('tooltip')).toHaveTextContent('Release the active Worker execution');
    fireEvent.click(blocked); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(setTaskStatus).not.toHaveBeenCalled();
    fireEvent.keyDown(blocked, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(opener).toHaveFocus();
  });
});
