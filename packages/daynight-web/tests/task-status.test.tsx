import { selectTaskList } from './helpers/projectViews';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { performance as nodePerformance } from 'node:perf_hooks';
import { TEST_VIEWER_ID, taskSyncFromGraph } from "./helpers/taskSync";
import { act, cleanup, fireEvent, screen, waitFor as waitForWithRealTimers, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ApiError, setTaskStatus, checkAttachmentPreview, getTask, getTaskSync, listAttachments, putAttachment, readAttachmentText } from '../src/api/client';
import type { TaskDetail, TaskGraph } from '../src/api/types';
import { App } from '../src/app/App';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { renderWithLocale } from './helpers/renderWithLocale';
import { installGraphMeasurements } from './graph-measurements';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(),
  getTask: vi.fn(), getTaskSync: vi.fn(), setTaskStatus: vi.fn(), listAttachments: vi.fn(), putAttachment: vi.fn(),
  readAttachmentText: vi.fn(), checkAttachmentPreview: vi.fn(),
}));
// Durable cache checks finish on event-loop tasks while polling time stays under test control.
const waitFor: typeof waitForWithRealTimers = async (assertion, options) => {
  if (!vi.isFakeTimers()) return waitForWithRealTimers(assertion, options);
  const deadline = nodePerformance.now() + (options?.timeout ?? 1_000);
  for (;;) {
    await act(async () => { await nextEventLoopTurn(); });
    try { return await assertion(); }
    catch (error) { if (nodePerformance.now() >= deadline) throw error; }
  }
};

const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();

const confirmStatus = async (button: HTMLElement) => {
  const previousWrites = vi.mocked(setTaskStatus).mock.calls.length;
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'In progress' }));
  const confirmation = screen.getByRole('alertdialog', { name: 'Set task status' });
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm status' }));
  await waitFor(() => expect(setTaskStatus).toHaveBeenCalledTimes(previousWrites + 1));
};
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const project = id(100); const parent = id(1); const child = id(2); const standalone = id(3);
const time = '2026-10-22T00:00:00Z';
const seed = (number: number, dependsOn: readonly string[] = []): TaskDetail => ({ requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: id(number), projectId: project,
  version: 9007199254740993n, title: `Task ${number}`, description: `Complete description ${number}`, properties: { worker: null, pullRequests: [] },
  status: 'todo', dependsOn, blockedBy: [], ready: true, createdAt: time, updatedAt: time });
let records: Map<string, TaskDetail>;
const otherRecords = new Map<string, TaskDetail>();
const graph = (): TaskGraph => {
  const tasks = [...records.values()].map((task) => {
    const blockedBy = task.dependsOn.filter((dependency) => records.get(dependency)!.status !== 'done');
    return { requiredPlatform: task.requiredPlatform, allowAgents: task.allowAgents, externalDependsOn: task.externalDependsOn, startedAt: task.startedAt, completedAt: task.completedAt, id: task.id, titlePreview: task.title, titleTruncated: false, status: task.status, dependsOn: task.dependsOn,
      blockedBy, ready: task.status === 'todo' && blockedBy.length === 0, createdAt: time, updatedAt: task.updatedAt };
  });
  return { observedAt: "2026-10-20T12:00:00Z", project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: project, name: 'Approval project', repoUrl: 'https://example.com/repo', createdAt: time, updatedAt: time }, tasks,
    summary: { total: tasks.length,
      todo: tasks.filter((task) => task.status === 'todo').length, inProgress: tasks.filter((task) => task.status === 'in_progress').length, done: tasks.filter((task) => task.status === 'done').length,
      ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => task.status === 'todo' && !task.ready).length } };
};
const commit = (taskId = child): TaskDetail => {
  const prior = records.get(taskId)!;
  const result: TaskDetail = { ...prior, status: 'in_progress', version: prior.version + 1n, startedAt: '2026-10-22T00:01:00Z',
    ready: false, updatedAt: '2026-10-22T00:01:00Z' };
  records.set(taskId, result); return result;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
};
const stat = (label: string) => screen.getByText(label, { selector: '.stat-label' }).parentElement!.querySelector('.stat-number')!;
let root: HTMLDivElement;
beforeEach(() => {
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => taskSyncFromGraph(await graphRequest(projectId, signal), { query, versionForTask: (task) => (projectId === project ? records : otherRecords).get(task.id)!.version }));
});

beforeEach(() => {
  installGraphMeasurements();
  root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  otherRecords.clear();
  records = new Map([{ ...seed(1), status: 'done' as const, ready: false }, seed(2, [parent]), seed(3)].map((task) => [task.id, task]));
  graphRequest.mockReset().mockImplementation(async () => graph());
  vi.mocked(getTask).mockReset().mockImplementation(async (_project, taskId) => records.get(taskId)!);
  vi.mocked(setTaskStatus).mockReset();
  vi.mocked(listAttachments).mockReset().mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(putAttachment).mockReset();
  vi.mocked(readAttachmentText).mockReset().mockResolvedValue('Selected attachment content');
  vi.mocked(checkAttachmentPreview).mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); root.remove(); });
const mount = async () => {
  const view = renderWithLocale(<ProjectPage projectId={project} />, { taskCache: true, locale: 'en', container: root });
  await selectTaskList();
  return view;
};
const openChild = async () => {
  const node = await screen.findByRole('button', { name: 'Task 2, Details' });
  fireEvent.click(node);
  const dialog = await screen.findByRole('dialog', { name: 'Task 2' });
  await within(dialog).findByRole('heading', { name: 'Task 2' });
  return dialog;
};

describe('status in shared production task details', () => {
  it.each(['status', 'automatic poll'] as const)('keeps another task Markdown-linked attachment draft and upload mounted during a background detail refresh triggered by %s', async (trigger) => {
    if (trigger === 'automatic poll') vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const mutation = deferred<TaskDetail>();
    const refresh = deferred<TaskDetail>();
    const kept = { path: 'kept.txt', contentType: 'text/plain', sizeBytes: 27, createdAt: time, updatedAt: time };
    const uploaded = { ...kept, path: 'drafts/new.txt', sizeBytes: 18 };
    const upload = deferred<typeof uploaded>();
    vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    vi.mocked(putAttachment).mockReturnValueOnce(upload.promise);
    vi.mocked(listAttachments).mockResolvedValue({ items: [kept], nextCursor: null });
    records.set(standalone, { ...records.get(standalone)!, description: '# Task materials\n\n[Selected attachment](kept.txt)' });
    let otherReads = 0;
    vi.mocked(getTask).mockImplementation(async (_project, taskId) => taskId === standalone && ++otherReads === 2 ? refresh.promise : records.get(taskId)!);
    await mount(); let dialog = await openChild();
    await confirmStatus(within(dialog).getByRole('button', { name: 'To do' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close task details' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Standalone tasks' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 3/ }));
    dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Task 3' });
    const statusButton = within(dialog).getByRole('button', { name: 'To do' });
    const tab = within(dialog).getByRole('tab', { name: 'Attachments' });
    fireEvent.click(within(dialog).getByRole('link', { name: 'Selected attachment' }));
    expect(tab).toHaveAttribute('aria-selected', 'true');
    const selection = await within(dialog).findByRole('button', { name: /kept.txt/, pressed: true });
    const preview = await within(dialog).findByText('Selected attachment content', { selector: 'pre' });
    const attachments = dialog.querySelector('.task-attachments');
    const input = within(dialog).getByLabelText('Choose one file') as HTMLInputElement;
    const path = within(dialog).getByRole('textbox', { name: 'Target relative path' });
    const file = new File(['pending file bytes'], 'new.txt', { type: 'text/plain' });
    await userEvent.setup().upload(input, file);
    fireEvent.change(path, { target: { value: 'drafts/new.txt' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upload file' }));
    const signal = vi.mocked(putAttachment).mock.calls[0]![4];
    tab.focus();
    const prior = records.get(standalone)!;
    const changed = { ...prior, title: 'Task 3 revised', description: 'Fresh task metadata', version: prior.version + 1n, updatedAt: '2026-10-22T00:02:00Z' };
    records.set(standalone, changed);
    await act(async () => {
      if (trigger === 'status') mutation.resolve(commit());
      else await vi.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(otherReads).toBe(2));
    expect(tab.isConnected).toBe(true);
    expect(dialog.querySelector('.task-attachments')).toBe(attachments);
    expect(within(dialog).getByRole('tab', { name: 'Attachments' })).toBe(tab);
    expect(tab).toHaveAttribute('aria-selected', 'true'); expect(tab).toHaveFocus();
    expect(input.files?.[0]).toBe(file); expect(path).toHaveValue('drafts/new.txt');
    expect(within(dialog).getByRole('button', { name: 'Uploading…' })).toBeDisabled();
    expect(selection).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText('Selected attachment content', { selector: 'pre' })).toBe(preview);
    expect(signal.aborted).toBe(false); expect(putAttachment).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putAttachment).mock.calls[0]?.[3]).toBe(file);
    expect(within(dialog).getByRole('heading', { name: 'Task 3' })).toBeVisible();
    expect(statusButton).toBeDisabled();
    expect(dialog.querySelector('.task-detail-stale')).toBeNull();
    expect(within(dialog).getByText('Showing previously loaded task details. Task changes are unavailable until the current details can be confirmed.')).toBeVisible();
    await act(async () => { refresh.resolve(changed); });
    await within(dialog).findByRole('heading', { name: 'Task 3 revised' });
    expect(dialog.querySelector('.task-attachments')).toBe(attachments); expect(tab).toHaveFocus();
    expect(input.files?.[0]).toBe(file); expect(path).toHaveValue('drafts/new.txt'); expect(signal.aborted).toBe(false);
    expect(statusButton).toBeEnabled(); expect(selection).toHaveAttribute('aria-pressed', 'true');
    expect(vi.mocked(listAttachments).mock.calls.filter((call) => call[1] === standalone)).toHaveLength(1);
    expect(within(dialog).getByText('Selected attachment content', { selector: 'pre' })).toBe(preview);
    vi.mocked(listAttachments).mockResolvedValue({ items: [kept, uploaded], nextCursor: null });
    await act(async () => { upload.resolve(uploaded); });
    await waitFor(() => expect(path).toHaveValue(''));
    expect(putAttachment).toHaveBeenCalledTimes(1);
  });

  it('preserves uncertain status through project access withdrawal and resumes GET-only checking after fresh admission', async () => {
    const original = new ApiError('network');
    const missing = new ApiError('server', 404, 'not_found', 'lost-detail-reconciliation');
    const freshGraph = deferred<TaskGraph>(); const freshDetail = deferred<TaskDetail>();
    let reads = 0; let owner!: TaskDetailSessions;
    const Subject = () => { owner = useTaskDetailSessions(); return <ProjectPage projectId={project} />; };
    vi.mocked(getTask).mockImplementation(async (_project, taskId) => {
      if (taskId === child) {
        reads++;
        if (reads === 2) throw missing;
        if (reads === 3) return freshDetail.promise;
      }
      return records.get(taskId)!;
    });
    vi.mocked(setTaskStatus).mockRejectedValueOnce(original);
    renderWithLocale(<TaskDetailSessionProvider><Subject /></TaskDetailSessionProvider>, { taskCache: true, locale: 'en', container: root });
    await selectTaskList();
    const dialog = await openChild(); graphRequest.mockImplementation(() => freshGraph.promise);
    await confirmStatus(within(dialog).getByRole('button', { name: 'To do' }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    const heading = await screen.findByRole('heading', { name: 'Project not found' }); const denied = heading.closest('[role="alert"]')!;
    expect(denied).toHaveTextContent('This project does not exist. Return to the project list.');
    expect(denied).toHaveTextContent('lost-detail-reconciliation');
    expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByRole('heading', { name: 'Task 2' })).toBeNull();
    expect(screen.queryByText('Complete description 2')).toBeNull(); expect(document.querySelector('.task-detail-panels')).toBeNull();
    const state = owner.snapshot(project, child);
    expect(state).toMatchObject({ detail: null, loadedRevision: null, requiresFreshRead: true, mutation: { phase: 'unknown', reconciling: false } });
    expect(state.mutation.operation).toEqual({ action: 'status', status: 'in_progress', version: records.get(child)!.version });
    expect(state.mutation.error).toBe(original); expect(state.mutation.reconciliationError).toBe(missing);
    const retry = within(denied as HTMLElement).getByRole('button', { name: 'Retry' }); expect(retry).toBeEnabled(); fireEvent.click(retry);
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2)); expect(reads).toBe(2); expect(screen.queryByText('Complete description 2')).toBeNull();
    await act(async () => { freshGraph.resolve(graph()); });
    const resumed = await screen.findByRole('dialog'); const operation = within(resumed).getByRole('region', { name: 'Task status' });
    expect(operation).toHaveTextContent('The status request outcome is unknown. Check the current task state before another operation.');
    expect(operation).toHaveTextContent('The status request did not receive a confirmed response from the service.');
    expect(within(resumed).queryByRole('button', { name: 'To do' })).toBeNull(); expect(reads).toBe(2);
    const check = within(operation).getByRole('button', { name: 'Check task state' }); expect(check).toBeEnabled(); fireEvent.click(check);
    await waitFor(() => expect(reads).toBe(3)); expect(setTaskStatus).toHaveBeenCalledTimes(1);
    expect(within(resumed).queryByText('Complete description 2')).toBeNull(); expect(check).toBeDisabled();
    await act(async () => { freshDetail.resolve(records.get(child)!); });
    await within(resumed).findByRole('heading', { name: 'Task 2' });
    await waitFor(() => expect(within(resumed).getByRole('button', { name: 'To do' })).toBeEnabled());
    expect(within(resumed).getByText('Complete description 2')).toBeVisible();
    expect(within(resumed).getByText('The status request did not receive a confirmed response from the service.')).toBeVisible();
    expect(setTaskStatus).toHaveBeenCalledTimes(1);
  });

  it('owns pending status across real App project routes and isolates its late result from the current project', async () => {
    const otherProject = id(200); const otherTask = id(4);
    const other = { ...seed(4), projectId: otherProject };
    otherRecords.set(otherTask, other);
    const otherGraph: TaskGraph = { observedAt: "2026-10-20T12:00:00Z",
      project: { ...graph().project, id: otherProject, name: 'Other project' },
      tasks: [{ requiredPlatform: other.requiredPlatform, allowAgents: other.allowAgents, externalDependsOn: other.externalDependsOn, startedAt: null, completedAt: null, id: otherTask, titlePreview: other.title, titleTruncated: false, status: 'todo',
        dependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time }],
      summary: { total: 1, todo: 1, inProgress: 0, done: 0, ready: 1, blocked: 0 },
    };
    graphRequest.mockImplementation(async (projectId) => projectId === project ? graph() : otherGraph);
    vi.mocked(getTask).mockImplementation(async (projectId, taskId) => projectId === project ? records.get(taskId)! : other);
    const mutation = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    window.history.replaceState(null, '', `/projects/${project}`);
    renderWithLocale(<App />, { taskCache: true, locale: 'en', container: root });
    const navigateProject = async (projectId: string, name: string) => {
      act(() => { window.history.pushState(null, '', `/projects/${projectId}`); window.dispatchEvent(new PopStateEvent('popstate')); });
      await screen.findByRole('heading', { name });
    };
    const openStandalone = async (title: string) => {
      await selectTaskList();
      fireEvent.click(screen.getByRole('tab', { name: 'Standalone tasks' }));
      fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }));
      const dialog = screen.getByRole('dialog');
      await within(dialog).findByRole('heading', { name: title });
      return dialog;
    };
    const close = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Close task details' }));
    await screen.findByRole('heading', { name: 'Approval project' });
    let dialog = await openStandalone('Task 3');
    await confirmStatus(within(dialog).getByRole('button', { name: 'To do' }));
    close(dialog);
    await navigateProject(otherProject, 'Other project');
    dialog = await openStandalone('Task 4');
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeEnabled();
    close(dialog);
    await navigateProject(project, 'Approval project');
    dialog = await openStandalone('Task 3');
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeDisabled();
    expect(setTaskStatus).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getTask).mock.calls.filter(([projectId, taskId]) => projectId === project && taskId === standalone)).toHaveLength(1);
    close(dialog);
    await navigateProject(otherProject, 'Other project');
    dialog = await openStandalone('Task 4');
    const otherGraphCalls = graphRequest.mock.calls.filter(([projectId]) => projectId === otherProject).length;
    await act(async () => { mutation.resolve(commit(standalone)); });
    expect(within(dialog).getByRole('heading', { name: 'Task 4' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeVisible();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'To do' })).toBeEnabled());
    expect(graphRequest.mock.calls.filter(([projectId]) => projectId === otherProject)).toHaveLength(otherGraphCalls);
    close(dialog);
    await navigateProject(project, 'Approval project');
    dialog = await openStandalone('Task 3');
    expect(within(dialog).getByRole('button', { name: 'In progress' })).toBeVisible();
    expect(within(dialog).queryByText('Task status confirmed.')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'To do' })).toBeNull();
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledExactlyOnceWith(project, standalone, 'in_progress', 9007199254740993n, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
  });

  it.each(['in_progress', 'done'] as const)('retains the status receipt when a later detail read reaches %s', async (status) => {
    vi.mocked(setTaskStatus).mockImplementation(async () => commit(standalone));
    const view = await mount(); await screen.findByRole('tab', { name: 'Standalone tasks' });
    fireEvent.click(screen.getByRole('tab', { name: 'Standalone tasks' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 3/ }));
    let dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('heading', { name: 'Task 3' });
    await confirmStatus(within(dialog).getByRole('button', { name: 'To do' }));
    await within(dialog).findByText('Task status confirmed.');
    const current = records.get(standalone)!;
    records.set(standalone, { ...current, status, ready: false, version: current.version + 1n, updatedAt: '2026-10-22T00:02:00Z' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close task details' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 3/ }));
    dialog = screen.getByRole('dialog');
    await within(dialog).findByRole('button', { name: status === 'done' ? 'Done' : 'In progress' });
    expect(within(dialog).queryByText('Task status confirmed.')).toBeNull();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: status === 'done' ? 'Done' : 'In progress' })).toBeEnabled());
    expect(within(dialog).queryByRole('button', { name: 'To do' })).toBeNull();
    view.setLocale('zh-CN');
    expect(within(dialog).queryByText('任务状态已确认。')).toBeNull();
    expect(within(dialog).getByRole('button', { name: status === 'done' ? '已完成' : '进行中' })).toBeVisible();
  });

  it('starts a ready graph task once across close/reopen and refreshes rows/counts without losing fullscreen or zoom', async () => {
    const mutation = deferred<TaskDetail>(); vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    await mount();
    const inspected = await screen.findByRole('button', { name: 'Task 2, To do' });
    fireEvent.click(inspected);
    expect(inspected).toHaveAttribute('aria-pressed', 'true');
    const inspection = () => [...document.querySelectorAll<HTMLElement>('.task-node,.task-dependency-edge')].map((node) => [node.closest<HTMLElement>('.react-flow__node')?.dataset.id ?? node.dataset.id, node.dataset.inspection]);
    const beforeInspection = inspection();
    const canvas = document.querySelector('.task-graph-canvas');
    const viewport = () => document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform;
    const initial = viewport(); fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(viewport()).not.toBe(initial));
    const transform = viewport();
    fireEvent.click(screen.getByRole('button', { name: 'View fullscreen' }));
    let dialog = await openChild();
    expect(within(dialog).getByRole('region', { name: 'Unfinished prerequisites' })).toHaveTextContent('All prerequisites are complete');
    const action = within(dialog).getByRole('button', { name: 'To do' });
    await confirmStatus(action); fireEvent.click(action);
    expect(action).toBeDisabled();
    expect(within(dialog).getByRole('region', { name: 'Task status' })).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close task details' }));
    dialog = await openChild();
    expect(within(dialog).getByRole('button', { name: 'To do' })).toBeDisabled();
    await waitFor(() => expect(setTaskStatus).toHaveBeenCalledExactlyOnceWith(project, child, 'in_progress', 9007199254740993n, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(getTask).toHaveBeenCalledTimes(1);
    await act(async () => { mutation.resolve(commit()); });
    await waitFor(() => expect(stat('In progress')).toHaveTextContent('1'));
    expect(stat('To do')).toHaveTextContent('1'); expect(stat('Blocked')).toHaveTextContent('0'); expect(stat('Ready')).toHaveTextContent('1');
    expect(within(dialog).queryByRole('button', { name: 'To do' })).toBeNull();
    expect(within(dialog).getByText('Task status confirmed.')).toBeVisible();
    expect(within(dialog).queryByText('Blocked', { selector: '.task-detail-blocked' })).toBeNull();
    expect(document.querySelector('.root-status')).toHaveTextContent('In progress');
    expect(document.querySelector('.task-graph-canvas')).toBe(canvas); expect(viewport()).toBe(transform);
    expect(screen.getByRole('dialog', { name: 'Task dependency graph fullscreen view', hidden: true })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Task 2, Details' })).toHaveFocus());
    expect(inspected).toHaveAttribute('aria-pressed', 'true');
    expect(inspection()).toEqual(beforeInspection);
    expect(viewport()).toBe(transform);
  });

  it('retains confirmed todo details and exposes truthful stale feedback if graph refresh fails', async () => {
    vi.mocked(setTaskStatus).mockImplementation(async () => commit());
    graphRequest.mockResolvedValueOnce(graph()).mockRejectedValueOnce(new ApiError('network')).mockImplementation(async () => graph());
    await mount(); const dialog = await openChild();
    await confirmStatus(within(dialog).getByRole('button', { name: 'To do' }));
    await within(dialog).findByText('Task status confirmed.');
    await screen.findByRole('heading', { name: 'Refresh failed' });
    expect(within(dialog).getByText(/The status response is confirmed and retained/)).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'To do' })).toBeNull();
    expect(within(dialog).getByRole('heading', { name: 'Task 2' })).toBeVisible();
    expect(stat('To do')).toHaveTextContent('2');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh task graph' }));
    await waitFor(() => expect(stat('In progress')).toHaveTextContent('1'));
    await waitFor(() => expect(within(dialog).queryByText(/The status response is confirmed and retained/)).toBeNull());
    expect(within(dialog).queryByRole('button', { name: 'To do' })).toBeNull();
  });

  it('ignores a graph response started before status and keeps a later selected task isolated', async () => {
    const obsolete = deferred<TaskGraph>(); const fresh = deferred<TaskGraph>(); const mutation = deferred<TaskDetail>();
    graphRequest.mockResolvedValueOnce(graph()).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(fresh.promise);
    vi.mocked(setTaskStatus).mockReturnValueOnce(mutation.promise);
    await mount(); await screen.findByRole('heading', { name: 'Approval project' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(graphRequest).toHaveBeenCalledTimes(2));
    const oldSignal = graphRequest.mock.calls[1]![1]; const oldGraph = graph();
    const dialog = await openChild(); await confirmStatus(within(dialog).getByRole('button', { name: 'To do' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close task details' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Standalone tasks' }));
    fireEvent.click(screen.getByRole('button', { name: /Task 3/ }));
    const otherDialog = screen.getByRole('dialog');
    await within(otherDialog).findByRole('heading', { name: 'Task 3' });
    await act(async () => { mutation.resolve(commit()); });
    await waitFor(() => expect(oldSignal.aborted).toBe(true));
    await act(async () => { obsolete.resolve(oldGraph); });
    expect(within(otherDialog).getByRole('heading', { name: 'Task 3' })).toBeVisible();
    await act(async () => { fresh.resolve(graph()); });
    await within(otherDialog).findByRole('heading', { name: 'Task 3' });
    await waitFor(() => expect(stat('In progress')).toHaveTextContent('1'));
    expect(within(otherDialog).getByRole('button', { name: 'To do' })).toBeVisible();
    expect(within(otherDialog).getByRole('button', { name: 'To do' })).toBeEnabled();
    expect(setTaskStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: 'Standalone tasks', hidden: true })).toHaveAttribute('aria-selected', 'true');
  });
});
