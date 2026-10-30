import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID } from './helpers/taskSync';
import userEvent from '@testing-library/user-event';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getTask, setTaskAgentPermission, setTaskRequiredPlatform } from '../src/api/client';
import type { GraphTask, Project, TaskDetail, TaskGraph } from '../src/api/types';
import { TaskDetailDialog, type TaskDetailDialogProps } from '../src/features/task-detail/TaskDetailDialog';
import { TaskPlatformBadge, TaskPlatformFeedback } from '../src/features/task-detail/TaskPlatform';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), setTaskAgentPermission: vi.fn(), setTaskRequiredPlatform: vi.fn() }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => <section><input aria-label="Attachment draft" defaultValue="" /></section> }));
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const time = '2026-10-24T00:00:00Z';
const project: Project = { id: projectId, name: 'Platform tasks', repoUrl: 'https://example.com/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const detail: TaskDetail = { id: taskId, projectId, title: 'Reviewed task', description: 'Keep this content', allowAgents: false, requiredPlatform: null, status: 'todo', version: 9007199254740993n,
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, properties: { pullRequests: [] }, startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
const graphTask = (value: TaskDetail): GraphTask => ({ id: value.id, titlePreview: value.title, titleTruncated: false, status: value.status,
  requiredPlatform: value.requiredPlatform, allowAgents: value.allowAgents, dependsOn: value.dependsOn, externalDependsOn: value.externalDependsOn, blockedBy: value.blockedBy, ready: value.ready,
  startedAt: value.startedAt, completedAt: value.completedAt, createdAt: value.createdAt, updatedAt: value.updatedAt });
let world: ReturnType<typeof createTaskSessionWorld>;
const snapshotDetails = new WeakMap<object, readonly TaskDetail[]>();
const snapshot = (value: TaskDetail, revision = 1) => {
  const graph: TaskGraph = { observedAt: time, project, tasks: [graphTask(value)], summary: { total: 1,
    todo: value.status === 'todo' ? 1 : 0, inProgress: value.status === 'in_progress' ? 1 : 0, done: value.status === 'done' ? 1 : 0, ready: value.ready ? 1 : 0, blocked: value.status === 'todo' && !value.ready ? 1 : 0 } };
  const result = { observedAt: time, graph, index: buildGraphIndex(graph), receivedMonotonic: performance.now(), receivedAt: 1, revision };
  snapshotDetails.set(result, [value]);
  return result;
};
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const writes = vi.mocked(setTaskRequiredPlatform);
let root: HTMLDivElement;
beforeEach(() => { world = createTaskSessionWorld(); root = document.createElement('div'); root.id = 'root'; document.body.append(root); vi.mocked(getTask).mockReset(); writes.mockReset(); vi.mocked(setTaskAgentPermission).mockReset(); });
afterEach(() => { cleanup(); world.dispose(); root.remove(); });
const open = async (value = detail, locale: 'en' | 'zh-CN' = 'en') => {
  vi.mocked(getTask).mockResolvedValue(value);
  const props: TaskDetailDialogProps = { projectId, taskId: value.id, snapshot: snapshot(value), onClose: vi.fn(), onSelectTask: vi.fn(), onRestoreFocus: vi.fn(), onRefreshGraph: vi.fn() };
  await world.sync(snapshotDetails.get(props.snapshot)!);
  const view = renderWithLocale(<TaskDetailDialog {...props} />, { locale, container: root, taskCache: { scope: world.scope } });
  await screen.findByRole('heading', { name: value.title });
  return { ...view, props, sync: async (value: TaskDetail) => { vi.mocked(getTask).mockResolvedValue(value); await world.sync([value]); view.rerender(<TaskDetailDialog {...props} snapshot={snapshot(value, 2)} />); }, rerender: async (ui: React.ReactElement<TaskDetailDialogProps>) => { await world.sync(snapshotDetails.get(ui.props.snapshot)!); view.rerender(ui); } };
};
const select = () => screen.getByRole('combobox', { name: 'Execution platform' });
const confirmation = () => screen.getByRole('alertdialog', { name: 'Change execution platform?' });
const review = (value: string) => { select().focus(); fireEvent.change(select(), { target: { value } }); };
const confirm = () => fireEvent.click(within(confirmation()).getByRole('button', { name: 'Change platform' }));

describe('confirmed status-row platform selection', () => {
  it('shows one header select and submits only confirmation while retaining the confirmed value', async () => {
    const { sync } = await open(); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    expect(select().closest('.task-detail-status-row')).not.toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Save platform' })).toBeNull();
    expect(document.querySelector('.task-detail-badges .task-platform')).toBeNull();
    expect(select()).toHaveValue('');
    review('linux');
    expect(writes).not.toHaveBeenCalled(); expect(select()).toHaveValue('');
    expect(within(confirmation()).getByText('Current platform: Any platform. New platform: Linux.')).toBeVisible();
    expect(within(confirmation()).getByText(detail.title)).toBeVisible();
    confirm();
    await waitFor(() => expect(writes).toHaveBeenCalledExactlyOnceWith(projectId, taskId, 'linux', detail.version, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(select()).toHaveValue(''); expect(select()).toBeDisabled(); expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'To do' })).toBeDisabled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => pending.resolve({ ...detail, requiredPlatform: 'linux', version: detail.version + 1n }));
    await screen.findByText('Execution platform updated.');
    expect(select()).toHaveValue('linux'); expect(select()).toBeDisabled();
    await sync({ ...detail, requiredPlatform: 'linux', version: detail.version + 1n });
    await waitFor(() => expect(select()).toBeEnabled()); expect(screen.getByRole('switch')).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Task status' })).toBeNull();
  });
  it.each([
    { from: null, to: 'windows' }, { from: 'windows', to: 'linux' }, { from: 'linux', to: 'macos' }, { from: 'macos', to: null },
  ] as const)('confirms $from to $to with the exact reviewed version', async ({ from, to }) => {
    await open({ ...detail, requiredPlatform: from });
    writes.mockResolvedValueOnce({ ...detail, requiredPlatform: to, version: detail.version + 1n });
    review(to === null ? '' : to); expect(select()).toHaveValue(from === null ? '' : from); expect(writes).not.toHaveBeenCalled();
    confirm(); await waitFor(() => expect(writes).toHaveBeenCalledExactlyOnceWith(projectId, taskId, to, detail.version, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    await screen.findByText('Execution platform updated.'); expect(select()).toHaveValue(to === null ? '' : to);
  });
  it.each([null, 'windows', 'linux', 'macos'] as const)('does not review or write the current value %s', async (value) => {
    await open({ ...detail, requiredPlatform: value }); review(value === null ? '' : value);
    expect(select()).toHaveValue(value === null ? '' : value); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(writes).not.toHaveBeenCalled();
  });
  it.each(['Cancel', 'Close confirmation', 'Escape', 'backdrop'])('cancels with %s without a write and restores select focus', async (action) => {
    const { props } = await open({ ...detail, requiredPlatform: 'windows' }); review('linux');
    expect(document.querySelector('.task-detail-dialog')).toHaveAttribute('inert');
    expect(within(confirmation()).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    if (action === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
    else if (action === 'backdrop') fireEvent.click(document.querySelector('.task-confirmation-backdrop')!);
    else fireEvent.click(within(confirmation()).getByRole('button', { name: action }));
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(select()).toHaveValue('windows'); expect(select()).toHaveFocus();
    expect(document.querySelector('.task-detail-dialog')).not.toHaveAttribute('inert'); expect(props.onClose).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });
  it('traps focus in the platform confirmation and preserves the parent through Escape', async () => {
    await open(); review('windows'); const dialog = confirmation(); const user = userEvent.setup();
    await user.tab({ shift: true }); expect(dialog.querySelector('.dialog-body')).toHaveFocus();
    await user.tab({ shift: true }); expect(within(dialog).getByRole('button', { name: 'Close confirmation' })).toHaveFocus();
    await user.tab({ shift: true }); expect(within(dialog).getByRole('button', { name: 'Change platform' })).toHaveFocus();
    await user.tab(); expect(within(dialog).getByRole('button', { name: 'Close confirmation' })).toHaveFocus();
    await user.keyboard('{Escape}'); expect(select()).toHaveFocus(); expect(screen.getByRole('dialog', { name: detail.title })).toBeVisible();
    expect(writes).not.toHaveBeenCalled();
  });
  it('invalidates an open review on a refreshed version and requires a newly reviewed choice', async () => {
    const { rerender, props } = await open(); review('linux');
    const changed = { ...detail, requiredPlatform: 'windows' as const, version: detail.version + 1n, updatedAt: '2026-10-24T00:01:00Z' };
    vi.mocked(getTask).mockResolvedValueOnce(changed); await rerender(<TaskDetailDialog {...props} snapshot={snapshot(changed, 2)} />);
    await waitFor(() => expect(select()).toHaveValue('windows')); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(writes).not.toHaveBeenCalled();
    review('macos'); writes.mockResolvedValueOnce({ ...changed, requiredPlatform: 'macos', version: changed.version + 1n });
    expect(within(confirmation()).getByText('Current platform: Windows. New platform: macOS.')).toBeVisible();
    confirm(); await waitFor(() => expect(writes).toHaveBeenCalledExactlyOnceWith(projectId, taskId, 'macos', changed.version, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    await screen.findByText('Execution platform updated.');
  });
  it('keeps platform, permission and status confirmation mutually exclusive', async () => {
    await open(); const automation = screen.getByRole('switch');
    review('linux'); fireEvent.click(automation);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1); expect(confirmation()).toBeVisible(); expect(writes).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation()).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(automation); review('windows');
    const permission = screen.getByRole('alertdialog', { name: 'Enable automatic execution' });
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1); fireEvent.click(within(permission).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'To do' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
    review('macos'); fireEvent.click(automation); expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    expect(screen.getByRole('alertdialog', { name: 'Set task status' })).toBeVisible(); expect(writes).not.toHaveBeenCalled();
  });
  it('keeps the header control usable on Attachments and retains its state during platform and permission writes', async () => {
    const { sync } = await open(); fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    const draft = screen.getByRole('textbox', { name: 'Attachment draft' }); fireEvent.change(draft, { target: { value: 'Preserve attachment draft' } });
    review('linux'); const platformPending = deferred<TaskDetail>(); writes.mockReturnValueOnce(platformPending.promise); confirm();
    expect(draft).toHaveValue('Preserve attachment draft'); expect(select()).toBeDisabled();
    await act(async () => platformPending.resolve({ ...detail, requiredPlatform: 'linux', version: detail.version + 1n }));
    await screen.findByText('Execution platform updated.'); expect(select()).toHaveValue('linux');
    await sync({ ...detail, requiredPlatform: 'linux', version: detail.version + 1n });
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    const pending = deferred<TaskDetail>(); vi.mocked(setTaskAgentPermission).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('switch')); fireEvent.click(screen.getByRole('button', { name: 'Enable automatic execution' }));
    expect(select()).toBeDisabled(); expect(writes).toHaveBeenCalledTimes(1);
    const saved = { ...detail, requiredPlatform: 'linux' as const, allowAgents: true, version: detail.version + 2n };
    await act(async () => pending.resolve(saved));
    await screen.findByText('Automatic execution updated.');
    await sync(saved);
    await waitFor(() => expect(select()).toBeEnabled()); expect(draft).toHaveValue('Preserve attachment draft');
    expect(screen.getByRole('tab', { name: 'Attachments' })).toHaveAttribute('aria-selected', 'true');
  });
  it('keeps the saved platform after a refusal and requires a fresh confirmation', async () => {
    await open(); writes.mockRejectedValueOnce(new ApiError('server', 403, 'forbidden', 'platform-refusal'));
    review('linux'); confirm(); await screen.findByText('platform-refusal'); expect(select()).toHaveValue('');
    expect(writes).toHaveBeenCalledTimes(1); expect(select()).toBeEnabled();
    review('windows'); expect(confirmation()).toBeVisible(); expect(writes).toHaveBeenCalledTimes(1);
  });
  it('reconciles a conflict to the current platform without retry', async () => {
    const current = { ...detail, requiredPlatform: 'macos' as const, version: detail.version + 1n };
    const { sync } = await open(); vi.mocked(getTask).mockResolvedValue(current); writes.mockRejectedValueOnce(new ApiError('server', 409, 'version_conflict'));
    review('linux'); confirm(); await waitFor(() => expect(writes).toHaveBeenCalledOnce()); await sync(current);
    await screen.findByText('The task changed. Review its current platform before confirming another change.');
    expect(select()).toHaveValue('macos'); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(writes).toHaveBeenCalledTimes(1);
  });
  it('blocks every write after an unknown result until the actual task is read', async () => {
    const { sync } = await open(); vi.mocked(getTask).mockRejectedValueOnce(new ApiError('network')); writes.mockRejectedValueOnce(new ApiError('network'));
    review('linux'); confirm(); const check = await screen.findByRole('button', { name: 'Check actual task' });
    await waitFor(() => expect(check).toBeEnabled()); expect(select()).toHaveValue('');
    expect(select()).toBeDisabled(); expect(screen.getByRole('switch')).toBeDisabled(); expect(screen.getByRole('button', { name: 'To do' })).toBeDisabled();
    const current = { ...detail, requiredPlatform: 'linux' as const, version: detail.version + 1n };
    vi.mocked(getTask).mockResolvedValue(current); fireEvent.click(check);
    await sync(current);
    await screen.findByText('The actual task has been read. The displayed platform is confirmed.');
    expect(select()).toHaveValue('linux'); expect(select()).toBeEnabled(); expect(writes).toHaveBeenCalledTimes(1);
  });
  it('locks an executing task and renders all Chinese platform labels in the header', async () => {
    await open({ ...detail, status: 'in_progress', ready: false, requiredPlatform: 'windows' }, 'zh-CN');
    const platform = screen.getByRole('combobox', { name: '执行平台' });
    expect(platform).toBeDisabled(); expect(platform).toHaveValue('windows'); expect(screen.queryByRole('button', { name: '保存平台' })).toBeNull();
    expect(within(platform).getAllByRole('option').map((option) => option.textContent)).toEqual(['不限平台', 'Windows', 'Linux', 'macOS']);
    expect(screen.getByText('任务正在进行中，保持此状态时无法修改执行平台。')).toBeVisible();
  });
  it('localizes readonly badges and leaves feedback empty for another operation kind', () => {
    const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };
    const view = renderWithLocale(<><TaskPlatformBadge requiredPlatform={null} compact /><TaskPlatformFeedback detail={null} mutation={idle} onReconcile={vi.fn()} /></>, { locale: 'zh-CN' });
    expect(screen.getByText('不限平台')).toHaveClass('task-platform-compact'); expect(document.querySelector('.task-platform-feedback')).toBeEmptyDOMElement(); view.unmount();
  });
  it.each([new ApiError('protocol'), new ApiError('server', 409, 'invalid_transition'), new ApiError('server', 404, 'not_found'), new Error('unexpected')])('renders actionable platform failures %#', (error) => {
    const mutation: TaskMutationState = { operation: { action: 'requiredPlatform', requiredPlatform: 'linux', version: detail.version }, phase: 'refused', error, reconciling: false, reconciliationError: null };
    renderWithLocale(<TaskPlatformFeedback detail={null} mutation={mutation} onReconcile={vi.fn()} />, { locale: 'en' });
    expect(screen.getByRole('alert')).toBeVisible();
  });
});
