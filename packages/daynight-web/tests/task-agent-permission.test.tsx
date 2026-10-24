import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, setTaskStatus, getTask, setTaskAgentPermission } from '../src/api/client';
import type { GraphTask, Project, TaskDetail, TaskGraph } from '../src/api/types';
import { TaskDetailDialog, type TaskDetailDialogProps } from '../src/features/task-detail/TaskDetailDialog';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), setTaskStatus: vi.fn(), setTaskAgentPermission: vi.fn() }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => <section><input aria-label="Attachment draft" defaultValue="" /></section> }));
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
const projectId = '10000000-0000-4000-8000-000000000001';
const taskId = '20000000-0000-4000-8000-000000000001';
const time = '2026-10-24T00:00:00Z';
const project: Project = { id: projectId, name: 'Automatic tasks', repoUrl: 'https://example.com/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const detail: TaskDetail = { requiredPlatform: null, id: taskId, projectId, title: 'Reviewed task', description: 'Keep this content', allowAgents: false, status: 'todo', version: 9007199254740993n,
  dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true, properties: { worker: null, pullRequests: [] }, startedAt: null, completedAt: null, createdAt: time, updatedAt: time };
const graphTask = (value: TaskDetail): GraphTask => ({ id: value.id, titlePreview: value.title, titleTruncated: false, status: value.status,
  requiredPlatform: value.requiredPlatform, allowAgents: value.allowAgents, dependsOn: value.dependsOn, externalDependsOn: value.externalDependsOn, blockedBy: value.blockedBy, ready: value.ready,
  startedAt: value.startedAt, completedAt: value.completedAt, createdAt: value.createdAt, updatedAt: value.updatedAt });
const snapshot = (value: TaskDetail, revision = 1) => {
  const graph: TaskGraph = { observedAt: time, project, tasks: [graphTask(value)], summary: { total: 1,
    todo: value.status === 'todo' ? 1 : 0, inProgress: value.status === 'in_progress' ? 1 : 0, done: value.status === 'done' ? 1 : 0, ready: value.ready ? 1 : 0, blocked: value.status === 'todo' && !value.ready ? 1 : 0 } };
  return { observedAt: time, graph, index: buildGraphIndex(graph), receivedMonotonic: performance.now(), receivedAt: 1, revision };
};
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const writes = vi.mocked(setTaskAgentPermission);
let root: HTMLDivElement;
beforeEach(() => { root = document.createElement('div'); root.id = 'root'; document.body.append(root); vi.mocked(getTask).mockReset(); writes.mockReset(); vi.mocked(setTaskStatus).mockReset(); });
afterEach(() => { cleanup(); root.remove(); });
const open = async (value = detail, locale: 'en' | 'zh-CN' = 'en') => {
  vi.mocked(getTask).mockResolvedValue(value);
  const props: TaskDetailDialogProps = { projectId, taskId: value.id, snapshot: snapshot(value), onClose: vi.fn(), onSelectTask: vi.fn(), onRestoreFocus: vi.fn(), onRefreshGraph: vi.fn() };
  const view = renderWithLocale(<TaskDetailDialog {...props} />, { locale, container: root });
  await screen.findByRole('heading', { name: value.title });
  return { ...view, props };
};

describe('confirmed automatic execution header control', () => {
  it('combines the saved setting and operation in one header switch on both detail tabs', async () => {
    await open();
    const control = screen.getByRole('switch', { name: 'Automatic execution' });
    expect(control).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'To do' }).closest('.task-detail-title-row')).not.toBeNull();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    expect(document.querySelector('.task-detail-heading .task-agent-permission')).toBeNull();
    expect(document.querySelector('.task-detail-panel-overview [role=switch]')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    const draft = screen.getByRole('textbox', { name: 'Attachment draft' }); fireEvent.change(draft, { target: { value: 'Keep attachment draft' } });
    control.focus(); fireEvent.click(control);
    const confirmation = screen.getByRole('alertdialog', { name: 'Enable automatic execution' });
    expect(within(confirmation).getByText(detail.title)).toBeVisible();
    expect(within(confirmation).getByText(/completed prerequisites/)).toBeVisible();
    expect(control).not.toBeChecked(); expect(writes).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(control).toHaveFocus(); expect(draft).toHaveValue('Keep attachment draft');
  });
  it.each(['enable', 'disable'] as const)('requires confirmation for %s and each cancellation sends no mutation', async (operation) => {
    await open({ ...detail, allowAgents: operation === 'disable' });
    const control = screen.getByRole('switch', { name: 'Automatic execution' });
    for (const cancel of ['Cancel', 'Close confirmation', 'Escape', 'backdrop']) {
      control.focus(); fireEvent.click(control);
      expect(screen.getByRole('alertdialog', { name: operation === 'enable' ? 'Enable automatic execution' : 'Turn off automatic execution' })).toBeVisible();
      if (cancel === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else if (cancel === 'backdrop') fireEvent.click(document.querySelector('.task-confirmation-backdrop')!);
      else fireEvent.click(screen.getByRole('button', { name: cancel }));
      expect(screen.queryByRole('alertdialog')).toBeNull(); expect(control).toHaveFocus();
      expect(control).toHaveAttribute('aria-checked', String(operation === 'disable'));
    }
    expect(writes).not.toHaveBeenCalled();
  });
  it('traps focus in the confirmation and preserves the parent dialog through Escape', async () => {
    const { props } = await open(); screen.getByRole('switch').focus(); fireEvent.click(screen.getByRole('switch'));
    const confirmation = screen.getByRole('alertdialog'); const user = userEvent.setup();
    await user.tab({ shift: true }); expect(confirmation.querySelector('.dialog-body')).toHaveFocus();
    await user.tab({ shift: true }); expect(screen.getByRole('button', { name: 'Close confirmation' })).toHaveFocus();
    await user.tab({ shift: true }); expect(screen.getByRole('button', { name: 'Enable automatic execution' })).toHaveFocus();
    await user.tab(); expect(screen.getByRole('button', { name: 'Close confirmation' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(props.onClose).not.toHaveBeenCalled(); expect(screen.getByRole('switch')).toHaveFocus();
  });
  it('submits the captured version once, retains the checked state while pending and preserves attachment UI', async () => {
    await open(); const pending = deferred<TaskDetail>(); writes.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' })); const draft = screen.getByRole('textbox', { name: 'Attachment draft' });
    fireEvent.change(draft, { target: { value: 'Retained' } });
    fireEvent.click(screen.getByRole('switch')); fireEvent.click(screen.getByRole('button', { name: 'Enable automatic execution' }));
    expect(writes).toHaveBeenCalledExactlyOnceWith(projectId, taskId, true, detail.version, expect.any(AbortSignal));
    expect(screen.getByRole('switch')).toBeDisabled(); expect(screen.getByRole('switch')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'To do' })).toBeDisabled();
    await act(async () => pending.resolve({ ...detail, allowAgents: true, version: detail.version + 1n }));
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
    expect(draft).toHaveValue('Retained'); expect(screen.getByRole('tab', { name: 'Attachments' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Automatic execution updated.')).toBeVisible();
    expect(screen.getByText('Task details differ from the current task graph. Refresh to see consistent progress and relationships.')).toBeVisible();
    expect(screen.queryByText(/The status operation is confirmed/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Task status' })).toBeNull();
  });
  it('closes a captured confirmation when an authoritative refresh changes the task version', async () => {
    const { rerender, props } = await open(); fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    const changed = { ...detail, allowAgents: true, version: detail.version + 1n, updatedAt: '2026-10-24T00:01:00Z' };
    vi.mocked(getTask).mockResolvedValueOnce(changed);
    rerender(<TaskDetailDialog {...props} snapshot={snapshot(changed, 2)} />);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes).not.toHaveBeenCalled();
  });
  it.each(['todo', 'done'] as const)('allows explicit changes in %s while locking in-progress tasks', async (status) => {
    await open({ ...detail, status, ready: status === 'todo' });
    expect(screen.getByRole('switch')).toBeEnabled();
  });
  it('preserves the checked flag and explains the execution lock', async () => {
    await open({ ...detail, allowAgents: true, status: 'in_progress', ready: false });
    expect(screen.getByRole('switch')).toBeDisabled(); expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByText('This task is in progress. Automatic execution settings cannot change while it remains in progress.')).toBeVisible();
  });
  it('uses bilingual title-row controls and the correct disabling confirmation', async () => {
    await open({ ...detail, allowAgents: true }, 'zh-CN');
    fireEvent.click(screen.getByRole('switch', { name: '自动执行' }));
    expect(screen.getByRole('alertdialog', { name: '关闭自动执行' })).toBeVisible();
    expect(screen.getByText('关闭后，worker 将不再自动领取此任务。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(writes).not.toHaveBeenCalled();
  });
  it.each([false, true])('provides the permission-specific Chinese accessible close action for saved flag %s', async (allowAgents) => {
    await open({ ...detail, allowAgents }, 'zh-CN');
    const control = screen.getByRole('switch', { name: '自动执行' }); control.focus(); fireEvent.click(control);
    const confirmation = screen.getByRole('alertdialog', { name: allowAgents ? '关闭自动执行' : '开启自动执行' });
    expect(within(confirmation).queryByRole('button', { name: '关闭确认窗' })).toBeNull();
    fireEvent.click(within(confirmation).getByRole('button', { name: '关闭确认框' }));
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(control).toHaveFocus();
    expect(control).toHaveAttribute('aria-checked', String(allowAgents)); expect(writes).not.toHaveBeenCalled();
  });
  it('retains the original setting after a refusal and offers a fresh confirmation', async () => {
    await open(); writes.mockRejectedValueOnce(new ApiError('server', 403, 'forbidden', 'permission-refusal'));
    fireEvent.click(screen.getByRole('switch')); fireEvent.click(screen.getByRole('button', { name: 'Enable automatic execution' }));
    await screen.findByText('permission-refusal'); expect(screen.getByRole('switch')).not.toBeChecked();
    fireEvent.click(screen.getByRole('switch')); expect(screen.getByRole('alertdialog')).toBeVisible(); expect(writes).toHaveBeenCalledTimes(1);
  });
});
