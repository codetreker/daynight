import { useState } from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteTask, getTask } from '../src/api/client';
import { TaskDetailDialog, type TaskDetailDialogProps } from '../src/features/task-detail/TaskDetailDialog';
import { TaskDetailSessionBoundary } from '../src/features/task-detail/TaskDetailSession';
import { TaskDetailSurface } from '../src/features/task-detail/TaskDetailSurface';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, snapshotFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID } from './helpers/taskSync';

vi.mock('../src/api/client', async (original) => ({ ...await original<typeof import('../src/api/client')>(), getTask: vi.fn(), deleteTask: vi.fn() }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => <section aria-label="Attachment materials"><input aria-label="Attachment draft" defaultValue="" /></section> }));
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
const project = '10000000-0000-4000-8000-000000000001'; const task = '20000000-0000-4000-8000-000000000001';
const initial = detailFixture(project, task, { title: 'Reviewed task', description: 'Original task materials', version: 9_007_199_254_740_993n });
const reads = vi.mocked(getTask); const writes = vi.mocked(deleteTask);
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
let world: ReturnType<typeof createTaskSessionWorld>; let root: HTMLDivElement;
beforeEach(() => { world = createTaskSessionWorld(); root = document.createElement('div'); root.id = 'root'; document.body.append(root); reads.mockReset().mockResolvedValue(initial); writes.mockReset(); });
afterEach(() => { cleanup(); world.dispose(); root.remove(); });
const open = async (locale: 'en' | 'zh-CN' = 'en') => {
  const props: TaskDetailDialogProps = { projectId: project, taskId: task, snapshot: snapshotFixture([initial]), onClose: vi.fn(), onRestoreFocus: vi.fn(), onRefreshGraph: vi.fn(), onSelectTask: vi.fn() };
  await world.sync([initial]); const view = renderWithLocale(<TaskDetailDialog {...props} />, { locale, container: root, taskCache: { scope: world.scope } });
  await screen.findByRole('heading', { name: initial.title }); await waitFor(() => expect(screen.getByRole('button', { name: locale === 'en' ? 'To do' : '待处理' })).toBeEnabled());
  return { ...view, props, dialog: screen.getByRole('dialog') };
};
const IndependentDetail = () => {
  const [fullscreen, setFullscreen] = useState(false);
  return <TaskDetailSessionBoundary><TaskDetailSurface presentation="page" fullscreen={{ active: fullscreen, onChange: setFullscreen }} projectId={project} taskId={task} snapshot={snapshotFixture([initial])} navigation={{ tab: 'overview', path: null }} onNavigate={vi.fn()} onSelectTask={vi.fn()} onRefreshGraph={vi.fn()} /></TaskDetailSessionBoundary>;
};
const deletionAction = (dialog: HTMLElement, locale: 'en' | 'zh-CN' = 'en') => {
  const trigger = within(dialog).getByRole('button', { name: locale === 'en' ? 'More task actions' : '更多任务操作' });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return within(dialog).getByRole('menuitem', { name: locale === 'en' ? 'Delete task' : '删除任务' });
};
const review = (dialog: HTMLElement) => { const opener = deletionAction(dialog); opener.focus(); fireEvent.click(opener); return screen.getByRole('alertdialog', { name: 'Delete and remove dependencies?' }); };

describe('reviewed task-deletion confirmation', () => {
  it.each(['Cancel', 'Escape', 'backdrop'] as const)('cancels through %s without writing and restores focus with attachment drafts retained', async (choice) => {
    const { dialog, props } = await open(); fireEvent.click(within(dialog).getByRole('tab', { name: 'Attachments' }));
    const draft = within(dialog).getByRole('textbox', { name: 'Attachment draft' }); fireEvent.change(draft, { target: { value: 'Keep this draft' } });
    const opener = within(dialog).getByRole('button', { name: 'More task actions' }); const confirmation = review(dialog);
    expect(dialog).toHaveAttribute('inert'); expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(confirmation).getByText(initial.title)).toBeVisible(); expect(within(confirmation).getByText(/records and attachments will be retained/)).toBeVisible();
    expect(within(confirmation).getByText(/^All ordinary and external dependencies/)).toBeVisible(); expect(within(confirmation).getByText(/may make successor tasks ready to run/)).toBeVisible(); expect(within(confirmation).queryByRole('checkbox')).toBeNull();
    expect(confirmation).not.toHaveTextContent(/\b\d+ (?:dependencies|successors|tasks)\b/);
    if (choice === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
    else if (choice === 'backdrop') fireEvent.click(confirmation.parentElement!);
    else fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(dialog).not.toHaveAttribute('inert'); expect(opener).toHaveFocus(); expect(draft).toHaveValue('Keep this draft'); expect(writes).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
  });
  it('submits the reviewed version once, shares the operation lock and renders the terminal state', async () => {
    const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); const { dialog } = await open(); const confirmation = review(dialog); const submit = within(confirmation).getByRole('button', { name: 'Delete and remove dependencies' });
    fireEvent.click(submit); fireEvent.click(submit);
    await waitFor(() => expect(writes).toHaveBeenCalledExactlyOnceWith(project, task, initial.version, true, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function), onWriteConfirmed: expect.any(Function) }));
    expect(screen.queryByRole('alertdialog')).toBeNull(); expect(deletionAction(dialog)).toBeDisabled(); expect(within(dialog).getByRole('button', { name: 'To do' })).toBeDisabled();
    await act(async () => pending.resolve()); await screen.findByRole('heading', { name: 'Task deleted' });
    expect(within(dialog).queryByText('Original task materials')).toBeNull(); expect(within(dialog).queryByRole('menuitem', { name: 'Delete task' })).toBeNull(); expect(within(dialog).queryByRole('button', { name: 'Retry details' })).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Return to task project' })).toHaveAttribute('href', `/projects/${project}`); expect(reads).toHaveBeenCalledOnce();
  });
  it('keeps combined deletion consent and the pending operation through fullscreen changes', async () => {
    const pending = deferred<void>(); writes.mockReturnValueOnce(pending.promise); const { dialog, props } = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enter fullscreen' }));
    const cancelled = review(dialog); expect(within(cancelled).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' }); expect(screen.queryByRole('alertdialog')).toBeNull(); expect(dialog).toHaveClass('task-detail-fullscreen'); expect(writes).not.toHaveBeenCalled();
    const confirmation = review(dialog); fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete and remove dependencies' }));
    await waitFor(() => expect(writes).toHaveBeenCalledExactlyOnceWith(project, task, initial.version, true, expect.any(AbortSignal), expect.objectContaining({ userId: TEST_VIEWER_ID })));
    fireEvent.keyDown(document, { key: 'Escape' }); expect(dialog).not.toHaveClass('task-detail-fullscreen'); expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enter fullscreen' })); expect(dialog).toHaveClass('task-detail-fullscreen'); expect(deletionAction(dialog)).toBeDisabled();
    await act(async () => pending.resolve()); await within(dialog).findByRole('heading', { name: 'Task deleted' }); expect(dialog).toHaveClass('task-detail-fullscreen'); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
  });
  it('invalidates a reviewed confirmation when a new task version is observed', async () => {
    const { dialog, props, rerender } = await open(); const confirmation = review(dialog); const oldSubmit = within(confirmation).getByRole('button', { name: 'Delete and remove dependencies' });
    const changed = { ...initial, title: 'Updated task', version: initial.version + 1n }; reads.mockResolvedValue(changed);
    await act(async () => { await world.sync([changed]); rerender(<TaskDetailDialog {...props} snapshot={snapshotFixture([changed], 2)} />); });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()); fireEvent.click(oldSubmit); expect(writes).not.toHaveBeenCalled();
    await waitFor(() => expect(deletionAction(dialog)).toBeEnabled()); review(dialog); expect(screen.getByText(changed.title, { selector: '.task-confirmation-task' })).toBeVisible();
  });
  it('shows a dependency refusal without clearing the task or silently retrying', async () => {
    writes.mockRejectedValueOnce(new ApiError('server', 409, 'dependency_unsatisfied', 'delete-refused')); const { dialog } = await open(); const confirmation = review(dialog); fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete and remove dependencies' }));
    await screen.findByText('Other tasks still depend on this task. Removing those dependencies requires explicit confirmation.'); expect(within(dialog).getByRole('heading', { name: initial.title })).toBeVisible(); expect(screen.getByText('delete-refused')).toBeVisible(); expect(writes).toHaveBeenCalledOnce(); expect(reads).toHaveBeenCalledOnce();
  });
  it('provides the same confirmation and deleted terminal on an independent detail page', async () => {
    await world.sync([initial]); writes.mockResolvedValueOnce();
    renderWithLocale(<IndependentDetail />, { locale: 'en', container: root, taskCache: { scope: world.scope } });
    const page = screen.getByRole('main'); await waitFor(() => expect(deletionAction(page)).toBeEnabled());
    fireEvent.click(within(page).getByRole('button', { name: 'Enter fullscreen' }));
    const confirmation = review(page); fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete and remove dependencies' }));
    await within(page).findByRole('heading', { name: 'Task deleted' }); expect(within(page).getAllByRole('link', { name: 'Return to task project' }).every((link) => link.getAttribute('href') === `/projects/${project}`)).toBe(true); expect(reads).toHaveBeenCalledOnce(); expect(writes).toHaveBeenCalledOnce();
    expect(page).toHaveClass('task-detail-fullscreen');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(page).not.toHaveClass('task-detail-fullscreen');
    expect(within(page).getByRole('button', { name: 'Enter fullscreen' })).toHaveFocus();
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
  });
  it('confirms in Chinese with preservation text and Cancel as the initial focused control', async () => {
    const { dialog } = await open('zh-CN'); fireEvent.click(deletionAction(dialog, 'zh-CN')); const confirmation = screen.getByRole('alertdialog', { name: '删除并解除依赖？' });
    expect(within(confirmation).getByRole('button', { name: '取消' })).toHaveFocus(); expect(within(confirmation).getByText(/任务记录和附件.*保留/)).toBeVisible(); expect(within(confirmation).getByText(/^将解除操作执行时所有其他任务对它的普通和外部依赖/)).toBeVisible(); expect(within(confirmation).getByText(/后继任务可能因此变为可执行/)).toBeVisible(); expect(within(confirmation).queryByRole('checkbox')).toBeNull(); expect(within(confirmation).getByRole('button', { name: '删除并解除依赖' })).toHaveClass('danger');
    fireEvent.click(within(confirmation).getByRole('button', { name: '取消' })); expect(writes).not.toHaveBeenCalled();
  });
});
