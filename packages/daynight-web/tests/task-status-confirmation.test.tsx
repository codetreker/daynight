import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID } from './helpers/taskSync';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTask, setTaskStatus } from '../src/api/client';
import type { Project, TaskDetail, TaskGraph, TaskStatus } from '../src/api/types';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskDetailDialog, type TaskDetailDialogProps } from '../src/features/task-detail/TaskDetailDialog';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { renderWithLocale } from './helpers/renderWithLocale';
vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), setTaskStatus: vi.fn() }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => <section aria-label="Attachment materials"><input aria-label="Attachment draft" defaultValue="" /></section> }));
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
const projectId = '10000000-0000-4000-8000-000000000001'; const taskId = '20000000-0000-4000-8000-000000000001'; const dependencyId = '20000000-0000-4000-8000-000000000002';
const time = '2026-10-22T00:00:00Z'; const later = '2026-10-22T00:01:00Z';
const project: Project = { id: projectId, name: 'Status project', repoUrl: 'https://example.com/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const source = (status: TaskStatus = 'todo'): TaskDetail => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: status === 'todo' ? null : time, completedAt: status === 'done' ? time : null, id: taskId, projectId, title: 'Reviewed task', description: 'Reviewed content',
  status, version: 9007199254740993n, properties: { worker: null, pullRequests: [] }, dependsOn: [dependencyId], blockedBy: [], ready: status === 'todo', createdAt: time, updatedAt: time });
const result = (detail: TaskDetail, status: TaskStatus): TaskDetail => detail.status === status ? detail : ({ ...detail, status, version: detail.version + 1n, ready: status === 'todo', updatedAt: later,
  startedAt: status === 'in_progress' ? later : status === 'todo' || detail.status === 'todo' ? null : detail.startedAt, completedAt: status === 'done' ? later : null });
let world: ReturnType<typeof createTaskSessionWorld>;
const snapshotDetails = new WeakMap<object, readonly TaskDetail[]>();
const snapshot = (detail: TaskDetail, revision = 1): GraphSnapshot => {
  const tasks = [detail, { ...source('done'), id: dependencyId, title: 'Prerequisite', dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false }];
  const graph: TaskGraph = { observedAt: time, project, tasks: tasks.map(({ version: _version, projectId: _project, title, description: _description, properties: _properties, ...task }) => ({ ...task, workerNeedsAttention: _properties.worker !== null && _properties.worker.signaling !== '', titlePreview: title, titleTruncated: false })),
    summary: { total: 2, todo: tasks.filter((task) => task.status === 'todo').length, inProgress: tasks.filter((task) => task.status === 'in_progress').length, done: tasks.filter((task) => task.status === 'done').length, ready: detail.ready ? 1 : 0, blocked: 0 } };
  const result = { observedAt: time, graph, index: buildGraphIndex(graph), receivedMonotonic: performance.now(), receivedAt: 1, revision };
  snapshotDetails.set(result, tasks);
  return result;
};
const labels = { todo: 'To do', in_progress: 'In progress', done: 'Done' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
let root: HTMLDivElement;
beforeEach(() => { world = createTaskSessionWorld(); root = document.createElement('div'); root.id = 'root'; document.body.append(root); vi.mocked(getTask).mockReset(); vi.mocked(setTaskStatus).mockReset(); });
afterEach(() => { cleanup(); world.dispose(); root.remove(); });
const open = async (detail = source()) => {
  vi.mocked(getTask).mockResolvedValue(detail); const props: TaskDetailDialogProps = { projectId, taskId, snapshot: snapshot(detail), onClose: vi.fn(), onRestoreFocus: vi.fn(), onRefreshGraph: vi.fn(), onSelectTask: vi.fn() };
  await world.sync(snapshotDetails.get(props.snapshot)!);
  const view = renderWithLocale(<TaskDetailDialog {...props} />, { locale: 'en', container: root, taskCache: { scope: world.scope } }); await screen.findByRole('heading', { name: detail.title }); return { ...view, props, sync: async (value: TaskDetail) => { vi.mocked(getTask).mockResolvedValue(value); await world.sync([value]); view.rerender(<TaskDetailDialog {...props} snapshot={snapshot(value, 2)} />); }, dialog: screen.getByRole('dialog'), rerender: async (ui: React.ReactElement<TaskDetailDialogProps>) => { await world.sync(snapshotDetails.get(ui.props.snapshot)!); view.rerender(ui); } };
};
const select = (dialog: HTMLElement, current: TaskStatus, target: TaskStatus) => { fireEvent.click(within(dialog).getByRole('button', { name: labels[current] })); fireEvent.click(within(dialog).getByRole('menuitemradio', { name: labels[target] })); return screen.getByRole('alertdialog', { name: 'Set task status' }); };
describe('status menu and reviewed confirmation', () => {
  it('opens beside the platform selector on either tab and preserves attachment drafts through cancellation and Escape', async () => {
    const { dialog, props } = await open(); const opener = within(dialog).getByRole('button', { name: 'To do' });
    expect(opener.closest('.task-detail-header')).toBeNull();
    expect(opener.closest('.task-detail-state-controls')).toContainElement(within(dialog).getByRole('combobox', { name: 'Execution platform' }));
    expect(opener.parentElement!.nextElementSibling).toContainElement(within(dialog).getByRole('combobox', { name: 'Execution platform' }));
    fireEvent.click(within(dialog).getByRole('tab', { name: 'Attachments' })); const draft = within(dialog).getByRole('textbox', { name: 'Attachment draft' }); fireEvent.change(draft, { target: { value: 'Retained review notes' } });
    opener.focus(); let confirmation = select(dialog, 'todo', 'done'); expect(dialog).toHaveAttribute('inert'); expect(within(confirmation).getByText('Reviewed task')).toBeVisible(); expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' })); expect(opener).toHaveFocus(); expect(dialog).not.toHaveAttribute('inert'); expect(draft).toHaveValue('Retained review notes');
    confirmation = select(dialog, 'todo', 'in_progress'); const user = userEvent.setup(); await user.tab({ shift: true }); expect(confirmation.querySelector('.dialog-body')).toHaveFocus(); await user.tab({ shift: true }); expect(within(confirmation).getByRole('button', { name: 'Close confirmation' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(opener).toHaveFocus(); expect(props.onClose).not.toHaveBeenCalled(); expect(draft).toHaveValue('Retained review notes'); expect(setTaskStatus).not.toHaveBeenCalled();
  });
  it('offers exactly three radio options and supports current selection, arrows, Home/End and Escape focus', async () => {
    const { dialog, props } = await open(source('in_progress')); const opener = within(dialog).getByRole('button', { name: 'In progress' }); opener.focus(); fireEvent.click(opener);
    const menu = within(dialog).getByRole('menu', { name: 'Task status' }); const options = within(menu).getAllByRole('menuitemradio'); expect(options).toHaveLength(3); expect(options[1]).toHaveAttribute('aria-checked', 'true'); expect(options[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' }); expect(options[2]).toHaveFocus(); fireEvent.keyDown(menu, { key: 'ArrowDown' }); expect(options[0]).toHaveFocus(); fireEvent.keyDown(menu, { key: 'ArrowUp' }); expect(options[2]).toHaveFocus(); fireEvent.keyDown(menu, { key: 'Home' }); expect(options[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(opener).toHaveFocus(); expect(props.onClose).not.toHaveBeenCalled();
    select(dialog, 'in_progress', 'in_progress'); expect(screen.getByText(/status and execution times will remain unchanged/)).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(setTaskStatus).not.toHaveBeenCalled();
  });
  it('selects the current radio option with Enter and Space through the keyboard', async () => {
    const { dialog } = await open(source('in_progress')); const user = userEvent.setup(); const opener = within(dialog).getByRole('button', { name: 'In progress' }); opener.focus();
    await user.keyboard('{Enter}'); expect(within(dialog).getByRole('menuitemradio', { name: 'In progress' })).toHaveFocus();
    await user.keyboard(' '); expect(screen.getByRole('alertdialog', { name: 'Set task status' })).toBeVisible(); expect(screen.getByText(/status and execution times will remain unchanged/)).toBeVisible();
    expect(setTaskStatus).not.toHaveBeenCalled();
  });
  it.each((['todo', 'in_progress', 'done'] as const).flatMap((from) => (['todo', 'in_progress', 'done'] as const).map((to) => ({ from, to }))))('submits captured $from → $to once and preserves the exact result', async ({ from, to }) => {
    const detail = source(from); const saved = result(detail, to); const pending = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(pending.promise); const { dialog, sync } = await open(detail);
    const confirmation = select(dialog, from, to); expect(confirmation.querySelector('.task-status-route')).toHaveTextContent(`${labels[from]}→${labels[to]}`); const confirm = within(confirmation).getByRole('button', { name: 'Confirm status' }); fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledExactlyOnceWith(projectId, taskId, to, detail.version, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) })); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(within(dialog).getByRole('button', { name: labels[from] })).toBeDisabled();
    await act(async () => pending.resolve(saved)); await within(dialog).findByText('Task status confirmed.'); await sync(saved); await waitFor(() => expect(within(dialog).getByRole('button', { name: labels[to] })).toBeEnabled());
  });
  it.each(['version', 'external classification', 'execution platform'] as const)('invalidates a confirmation after a fresh read changes %s', async (change) => {
    const detail = source(); const fresh = change === 'version' ? { ...detail, title: 'Revised task', version: detail.version + 1n, updatedAt: later } : change === 'execution platform' ? { ...detail, requiredPlatform: 'linux' as const, version: detail.version + 1n } : { ...detail, externalDependsOn: [dependencyId], version: detail.version + 1n };
    const { dialog, props, rerender } = await open(detail); const confirmation = select(dialog, 'todo', 'in_progress'); const oldConfirm = within(confirmation).getByRole('button', { name: 'Confirm status' });
    vi.mocked(getTask).mockResolvedValueOnce(fresh); await rerender(<TaskDetailDialog {...props} snapshot={snapshot(fresh, 2)} />); await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()); fireEvent.click(oldConfirm); expect(setTaskStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'To do' })).toBeEnabled()); select(dialog, 'todo', 'in_progress'); expect(screen.getByText(fresh.title, { selector: '.task-confirmation-task' })).toBeVisible();
  });
});
