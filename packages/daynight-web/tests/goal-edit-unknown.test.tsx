import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions, type TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { createTaskCacheScope } from '../src/features/task-cache/project-cache';
import { GoalDetailSurface } from '../src/features/goal-detail/GoalDetailSurface';
import { GoalCreate } from '../src/features/goal-detail/GoalCreate';
import type { TaskDetail, TaskStatus } from '../src/api/types';
import { ApiError, createTask, pauseAuthRequests } from '../src/api/client';
import { detailFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';
import { wireResponse } from './helpers/wireJson';

vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => null }));
vi.mock('../src/features/task-thread/TaskDiscussion', () => ({ TaskDiscussion: () => null }));
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), createTask: vi.fn() }));
vi.mock('../src/features/task-detail/TaskOrganization', () => ({ TaskOrganization: () => null, FormDialog: ({ title, children }: { title: string; children: ReactNode }) => <section role="dialog" aria-label={title}>{children}</section> }));
vi.mock('../src/features/projects/ProjectAccess', async original => ({ ...await original<typeof import('../src/features/projects/ProjectAccess')>(), useProjectAccess: () => ({ ready: true, session: { waitForFreshAccess: async () => ({}) } }) }));
vi.mock('../src/features/task-assignment/TaskAssigneeSelect', () => ({ TaskAssigneeSelect: () => null }));
vi.mock('../src/features/task-assignment/TaskAssigneeIdentity', () => ({ TaskAssigneeIdentity: () => null }));
vi.mock('../src/features/task-assignment/AssigneePicker', () => ({ AssigneePicker: () => null }));
vi.mock('../src/features/task-tags/TagPicker', () => ({ TagPicker: ({ value, onChange, canWrite }: { value: readonly { id: string; name: string }[]; onChange: (value: readonly { id: string; name: string }[]) => void; canWrite: boolean }) => <div><output aria-label="Selected tags">{value.map(tag => tag.name).join(',')}</output><button type="button" disabled={!canWrite} onClick={() => onChange([{ id: 'tag-a', name: 'Alpha' }])}>Select Alpha</button></div> }));

const projectId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const detail = detailFixture(projectId, goalId, { type: 'goal', title: 'Goal', description: 'Original', ready: false });
const failure = new Error('Unclassified write outcome');
const write = vi.fn();
const check = vi.fn();
let root: HTMLDivElement;

beforeEach(() => { root = document.createElement('div'); root.id = 'root'; document.body.append(root); write.mockReset(); check.mockReset(); vi.mocked(createTask).mockReset(); });
afterEach(() => { root.remove(); });

const Harness = ({ clearError, apiFailure = false }: { readonly clearError: boolean; readonly apiFailure?: boolean }) => {
  const [phase, setPhase] = useState<'idle' | 'unknown' | 'reconciled'>('idle');
  const mutation: TaskMutationState = {
    operation: phase === 'idle' ? null : { action: 'editGoal', title: 'Draft title', description: 'Draft body', version: detail.version },
    phase, error: phase === 'idle' || phase === 'reconciled' && clearError ? null : apiFailure ? new ApiError('server', 503, 'forbidden', 'request-edit') : failure,
    reconciling: false, reconciliationError: null, ...(phase === 'reconciled' ? { reconciledFrom: 'unknown' as const } : {}),
  };
  const task = { detail, mutation, historyGeneration: 1, canEditGoal: phase !== 'unknown', canDisplayStatus: true, canSetStatus: true,
    canDisplayAssignee: true, canSetAssignedTo: true, canDisplayDelete: true, canDelete: true, assignmentUncertain: false,
    editGoal: (...args: unknown[]) => { write(...args); setPhase('unknown'); }, reconcile: () => { check(); setPhase('reconciled'); },
  } as unknown as ReturnType<typeof useTaskDetail>;
  return <GoalDetailSurface projectId={projectId} taskId={goalId} detail={detail} resourceState={task} snapshot={null} presentation="dialog"
    fullscreen={{ active: false, onChange: () => {} }} onSelectTask={() => {}} onClose={() => {}} onRefreshGraph={() => {}} />;
};

it('keeps a non-ApiError outcome unknown inside the editor after checking state', () => {
  renderWithLocale(<Harness clearError={false} />, { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
  const editor = screen.getByRole('alertdialog', { name: 'Edit Goal' });
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft title' } });
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Description' }), { target: { value: 'Draft body' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(within(editor).getByText('The original save outcome remains unknown.')).toBeVisible();
  expect(within(editor).queryByText('Save failed')).toBeNull();
  fireEvent.click(within(editor).getByRole('button', { name: 'Check state' }));
  expect(within(editor).getByText('The original save outcome remains unknown.')).toBeVisible();
  expect(within(editor).getByRole('textbox', { name: 'Name' })).toHaveValue('Draft title');
  expect(within(editor).getByRole('textbox', { name: 'Description' })).toHaveValue('Draft body');
  expect(write).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1);
});

it('keeps a newer Goal draft when a locally confirmed edit is published after a pause', () => {
  const operation = { action: 'editGoal' as const, title: 'Submitted', description: 'Original', version: detail.version };
  const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };
  const surface = (mutation: TaskMutationState, current = detail) => {
    const task = { detail: current, mutation, historyGeneration: 1, canEditGoal: true, canDisplayStatus: true, canSetStatus: true,
      canDisplayAssignee: true, canSetAssignedTo: true, canDisplayDelete: true, canDelete: true, assignmentUncertain: false,
      editGoal: write, reconcile: check } as unknown as ReturnType<typeof useTaskDetail>;
    return <GoalDetailSurface projectId={projectId} taskId={goalId} detail={current} resourceState={task} snapshot={null} presentation="dialog"
      fullscreen={{ active: false, onChange: () => {} }} onSelectTask={() => {}} onClose={() => {}} onRefreshGraph={() => {}} />;
  };
  const view = renderWithLocale(surface(idle), { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
  const editor = screen.getByRole('alertdialog', { name: 'Edit Goal' });
  const title = within(editor).getByRole('textbox', { name: 'Name' });
  fireEvent.change(title, { target: { value: 'Submitted' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  const pending: TaskMutationState = { ...idle, operation, phase: 'confirmed', publicationPending: true };
  const resume = pauseAuthRequests();
  try {
    view.rerender(surface(pending));
    expect(title).toBeEnabled();
    fireEvent.change(title, { target: { value: 'Newer draft' } });
    resume();
    view.rerender(surface({ ...pending, publicationPending: false }, { ...detail, title: 'Submitted', version: detail.version + 1n }));
    expect(within(screen.getByRole('alertdialog', { name: 'Edit Goal' })).getByRole('textbox', { name: 'Name' })).toHaveValue('Newer draft');
    expect(write).toHaveBeenCalledOnce();
  } finally { resume(); }
});

it('retains a confirmed Goal draft until a direct retry reaches the real receipt version', async () => {
  const scope = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() });
  const saved = { ...detail, title: 'Submitted', version: detail.version + 1n };
  const epoch = '30000000-0000-4000-8000-000000000001';
  const response = (value: unknown) => wireResponse(value, { headers: viewerHeaders(TEST_VIEWER_ID, { 'Daynight-Task-Epoch': epoch }) });
  let rejectFollowup!: (error: Error) => void; const followup = new Promise<Response>((_resolve, reject) => { rejectFollowup = reject; });
  let reads = 0; let writes = 0; let resume: (() => void) | null = null; let sessions!: TaskDetailSessions;
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    if (init.method === 'PATCH') { writes++; return Promise.resolve(response(saved)); }
    reads++;
    if (reads === 2) { resume = pauseAuthRequests(); return followup; }
    return Promise.resolve(response(reads <= 3 ? detail : saved));
  }));
  const Workspace = () => {
    sessions = useTaskDetailSessions(); const task = useTaskDetail(projectId, goalId, { kind: 'direct' });
    return task.detail === null ? null : <GoalDetailSurface projectId={projectId} taskId={goalId} detail={task.detail} resourceState={task} snapshot={null} presentation="dialog"
      fullscreen={{ active: false, onChange: () => {} }} onSelectTask={() => {}} onClose={() => {}} onRefreshGraph={() => {}} onRetryDetail={task.retry} />;
  };
  const view = renderWithLocale(<TaskCacheProvider scope={scope}><TaskDetailSessionProvider><Workspace /></TaskDetailSessionProvider></TaskCacheProvider>, { locale: 'en', container: root });
  try {
    await waitFor(() => expect(screen.getByRole('button', { name: /^Edit$/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const editor = screen.getByRole('alertdialog', { name: 'Edit Goal' });
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Name' }), { target: { value: 'Submitted' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => { expect(reads).toBe(2); expect(resume).not.toBeNull(); });
    expect(sessions.snapshot(projectId, goalId).mutation).toMatchObject({ phase: 'confirmed', publicationPending: true });
    await act(async () => { rejectFollowup(new Error('Offline')); });
    (resume as (() => void) | null)?.(); resume = null;
    await waitFor(() => expect(sessions.snapshot(projectId, goalId)).toMatchObject({ requiresFreshRead: true, error: { kind: 'network' }, mutation: { phase: 'confirmed', publicationPending: true } }));
    expect(within(screen.getByRole('alertdialog', { name: 'Edit Goal' })).getByRole('textbox', { name: 'Name' })).toHaveValue('Submitted');
    await act(async () => { sessions.load(projectId, goalId, 1, 'refresh'); });
    await waitFor(() => { expect(reads).toBe(3); expect(sessions.snapshot(projectId, goalId).error).not.toBeNull(); });
    expect(sessions.snapshot(projectId, goalId).mutation.publicationPending).toBe(true);
    expect(screen.getByRole('alertdialog', { name: 'Edit Goal' })).toBeVisible();
    await act(async () => { sessions.load(projectId, goalId, 1, 'refresh'); });
    await waitFor(() => expect(sessions.snapshot(projectId, goalId)).toMatchObject({ detail: saved, requiresFreshRead: false, mutation: { phase: 'confirmed', publicationPending: false } }));
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Edit Goal' })).toBeNull());
    expect(writes).toBe(1); expect(reads).toBe(4);
  } finally { (resume as (() => void) | null)?.(); view.unmount(); scope.dispose(); vi.unstubAllGlobals(); }
});

it('shows the unknown outcome after checking even when the error object is cleared', () => {
  renderWithLocale(<Harness clearError />, { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
  const editor = screen.getByRole('alertdialog', { name: 'Edit Goal' });
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft title' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check state' }));
  expect(screen.getByText('The current state was checked, but the original save outcome remains unknown. Your draft is retained.')).toBeVisible();
  expect(screen.queryByText('The save did not complete; your draft is retained.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
  expect(within(screen.getByRole('alertdialog', { name: 'Edit Goal' })).getByRole('textbox', { name: 'Name' })).toHaveValue('Draft title');
  expect(write).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1);
});

it('keeps an unknown Goal edit neutral when a server error carries a business code', () => {
  renderWithLocale(<Harness clearError={false} apiFailure />, { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
  const editor = screen.getByRole('alertdialog', { name: 'Edit Goal' });
  fireEvent.change(within(editor).getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft title' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
  expect(within(editor).getByText('request-edit').closest('p')).toHaveTextContent('(forbidden)');
  expect(within(editor).queryByText(/do not have permission|refused|failed/i)).toBeNull();
  fireEvent.click(within(editor).getByRole('button', { name: 'Check state' }));
  expect(within(editor).getByText('request-edit').closest('p')).toHaveTextContent('(forbidden)');
  expect(within(editor).queryByText(/do not have permission|refused|failed/i)).toBeNull();
  expect(write).toHaveBeenCalledTimes(1); expect(check).toHaveBeenCalledTimes(1);
});

const ControlHarness = ({ action }: { readonly action: 'status' | 'assignedTo' | 'delete' }) => {
  const [checked, setChecked] = useState(false);
  const operation = action === 'status' ? { action, status: 'done' as const, version: detail.version }
    : action === 'assignedTo' ? { action, assignedTo: null, version: detail.version } : { action, removeDepends: false, version: detail.version };
  const task = { detail, mutation: { operation, phase: checked ? 'reconciled' : 'unknown', error: new ApiError('server', 503, 'forbidden', 'request-1'),
    reconciling: false, reconciliationError: null, ...(checked ? { reconciledFrom: 'unknown' } : {}) }, historyGeneration: 1,
    canEditGoal: false, canDisplayStatus: false, canSetStatus: false, canDisplayAssignee: false, canSetAssignedTo: false,
    canDisplayDelete: false, canDelete: false, assignmentUncertain: true, reconcile: () => { check(); setChecked(true); },
  } as unknown as ReturnType<typeof useTaskDetail>;
  return <GoalDetailSurface projectId={projectId} taskId={goalId} detail={detail} resourceState={task} snapshot={null} presentation="dialog"
    fullscreen={{ active: false, onChange: () => {} }} onSelectTask={() => {}} onClose={() => {}} onRefreshGraph={() => {}} />;
};

it.each(['status', 'assignedTo', 'delete'] as const)('reports an unknown %s outcome without claiming refusal', action => {
  renderWithLocale(<ControlHarness action={action} />, { locale: 'en', taskCache: true, container: root });
  expect(screen.getByText('The operation outcome is unknown. Checking the current state will not resend the request.')).toBeVisible();
  expect(screen.getByText('request-1').closest('p')).toHaveTextContent('(forbidden)');
  expect(screen.queryByText(/do not have permission/i)).toBeNull();
  expect(screen.queryByText(/refused|failed/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check state' }));
  expect(screen.getByText('The operation outcome is unknown. Checking the current state will not resend the request.')).toBeVisible();
  expect(screen.queryByText(/do not have permission|refused|failed/i)).toBeNull();
  expect(check).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
});

const goalStatuses = ['todo', 'in_progress', 'done', 'cancelled'] as const;
const statusLabels = {
  en: ['To do', 'In progress', 'Done', 'Cancelled'],
  'zh-CN': ['待处理', '进行中', '已完成', '已取消'],
} as const;
const statusSurface = (current: TaskDetail, setStatus: (status: TaskStatus, version: bigint) => void, canSetStatus = true) => {
  const task = { detail: current, mutation: { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null },
    historyGeneration: 1, canEditGoal: true, canDisplayStatus: true, canSetStatus, canDisplayAssignee: true, canSetAssignedTo: true,
    canDisplayDelete: true, canDelete: true, assignmentUncertain: false, setStatus, reconcile: check,
  } as unknown as ReturnType<typeof useTaskDetail>;
  return <GoalDetailSurface projectId={projectId} taskId={goalId} detail={current} resourceState={task} snapshot={null} presentation="dialog"
    fullscreen={{ active: false, onChange: () => {} }} onSelectTask={() => {}} onClose={() => {}} onRefreshGraph={() => {}} />;
};

it.each((['en', 'zh-CN'] as const).flatMap(locale => goalStatuses.map((status, index) => ({ locale, status, index }))))('presents the four Goal statuses in $locale with $status selected', ({ locale, status, index }) => {
  const current = { ...detail, status };
  renderWithLocale(statusSurface(current, write), { locale, taskCache: true, container: root });
  const trigger = screen.getByRole('button', { name: statusLabels[locale][index]! });
  expect(trigger).toBeEnabled();
  expect(trigger.querySelector(`.task-detail-dot-${status}`)).not.toBeNull();
  expect(screen.queryByRole('combobox', { name: /goal status|goal 状态/i })).toBeNull();
  fireEvent.click(trigger);
  const menu = screen.getByRole('menu', { name: locale === 'zh-CN' ? 'Goal 状态' : 'Goal status' });
  const options = within(menu).getAllByRole('menuitemradio');
  expect(options.map(option => option.textContent?.replace('✓', ''))).toEqual(statusLabels[locale]);
  expect(options[index]).toHaveAttribute('aria-checked', 'true');
  expect(options[index]).toHaveFocus();
  expect(write).not.toHaveBeenCalled();
});

it('supports keyboard navigation and Escape without changing Goal status', () => {
  const current = { ...detail, status: 'in_progress' as const };
  renderWithLocale(statusSurface(current, write), { locale: 'en', taskCache: true, container: root });
  const trigger = screen.getByRole('button', { name: 'In progress' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const menu = screen.getByRole('menu');
  const options = within(menu).getAllByRole('menuitemradio');
  expect(options[0]).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'End' }); expect(options[3]).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'ArrowDown' }); expect(options[0]).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'ArrowUp' }); expect(options[3]).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'Home' }); expect(options[0]).toHaveFocus();
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(trigger).toHaveFocus();
  expect(write).not.toHaveBeenCalled();
});

it.each(goalStatuses.flatMap(from => goalStatuses.filter(to => to !== from).map(to => ({ from, to }))))('routes Goal $from → $to with the reviewed exact version', ({ from, to }) => {
  const current = { ...detail, status: from, version: 9007199254740993n };
  renderWithLocale(statusSurface(current, write), { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: statusLabels.en[goalStatuses.indexOf(from)]! }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: statusLabels.en[goalStatuses.indexOf(to)]! }));
  if (to === 'done' || to === 'cancelled') {
    const confirmation = screen.getByRole('alertdialog', { name: to === 'done' ? 'Complete this Goal?' : 'Cancel this Goal?' });
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm' }));
  }
  expect(write).toHaveBeenCalledExactlyOnceWith(to, current.version);
});

it.each(['done', 'cancelled'] as const)('dismisses the %s confirmation via Back and Escape without a write', target => {
  renderWithLocale(statusSurface(detail, write), { locale: 'en', taskCache: true, container: root });
  const choose = () => {
    fireEvent.click(screen.getByRole('button', { name: 'To do' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: statusLabels.en[goalStatuses.indexOf(target)]! }));
    return screen.getByRole('alertdialog', { name: target === 'done' ? 'Complete this Goal?' : 'Cancel this Goal?' });
  };
  fireEvent.click(within(choose()).getByRole('button', { name: 'Back' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  choose(); fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

it('does not confirm a terminal Goal status against a changed reviewed version', () => {
  const view = renderWithLocale(statusSurface(detail, write), { locale: 'en', taskCache: true, container: root });
  fireEvent.click(screen.getByRole('button', { name: 'To do' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Done' }));
  view.rerender(statusSurface({ ...detail, version: detail.version + 1n }, write));
  const confirm = within(screen.getByRole('alertdialog', { name: 'Complete this Goal?' })).getByRole('button', { name: 'Confirm' });
  expect(confirm).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(confirm);
  expect(write).not.toHaveBeenCalled();
});

it.each(['api', 'confirmed-api', 'non-api'] as const)('reports an unknown Goal creation after a %s error without claiming failure', async kind => {
  vi.mocked(createTask).mockImplementation(async (_project, _input, _signal, admission) => {
    if (kind === 'api') throw new ApiError('server', 503, 'invalid_input', 'request-2');
    if (kind === 'confirmed-api') { admission.onWriteConfirmed?.(); throw new ApiError('server', 400, 'invalid_input', 'request-2'); }
    throw new Error('Unclassified creation outcome');
  });
  renderWithLocale(<GoalCreate projectId={projectId} onClose={() => {}} onRefreshGraph={() => {}} />, { locale: 'en', taskCache: true, container: root });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft title' } });
  fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
  fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
  expect(await screen.findByText(/The creation outcome is unknown\. Check the Goal list/)).toBeVisible();
  expect(screen.queryByText('Creation failed')).toBeNull();
  expect(screen.queryByText(/Goal information is invalid/i)).toBeNull();
  expect(screen.getByRole('button', { name: /^Create$/ })).toBeDisabled();
  expect(screen.getByLabelText('Selected tags')).toHaveTextContent('Alpha');
  expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ type: 'goal', tagIds: ['tag-a'] });
  if (kind !== 'non-api') expect(screen.getByText('request-2').closest('p')).toHaveTextContent('(invalid_input)');
  expect(createTask).toHaveBeenCalledTimes(1);
});

it('submits Goal tags as a frozen selection and clears them after a confirmed create', async () => {
  const pending = Promise.withResolvers<never>();
  vi.mocked(createTask).mockReturnValue(pending.promise);
  const close = vi.fn();
  renderWithLocale(<GoalCreate projectId={projectId} onClose={close} onRefreshGraph={() => {}} />, { locale: 'en', taskCache: true, container: root });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Tagged goal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
  fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
  await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ type: 'goal', title: 'Tagged goal', tagIds: ['tag-a'] });
  expect(screen.getByRole('button', { name: 'Select Alpha' })).toBeDisabled();
  await act(async () => pending.resolve({} as never));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Selected tags')).toHaveTextContent('');
});

it('retains the Goal draft and tags after a definite create rejection', async () => {
  vi.mocked(createTask).mockRejectedValueOnce(new ApiError('server', 400, 'tag_not_found', 'request'));
  const CreateHarness = () => {
    const [open, setOpen] = useState(true);
    return open ? <GoalCreate projectId={projectId} onClose={() => setOpen(false)} onRefreshGraph={() => {}} /> : <button onClick={() => setOpen(true)}>Reopen Goal</button>;
  };
  renderWithLocale(<CreateHarness />, { locale: 'en', taskCache: true, container: root });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft goal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Select Alpha' }));
  fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
  await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole('button', { name: /^Create$/ })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft goal');
  expect(screen.getByLabelText('Selected tags')).toHaveTextContent('Alpha');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Reopen Goal' }));
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Draft goal');
  expect(screen.getByLabelText('Selected tags')).toHaveTextContent('Alpha');
});

it('creates an untagged Goal with an empty tag set', async () => {
  vi.mocked(createTask).mockResolvedValueOnce({} as never);
  renderWithLocale(<GoalCreate projectId={projectId} onClose={() => {}} onRefreshGraph={() => {}} />, { locale: 'en', taskCache: true, container: root });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Untagged goal' } });
  fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
  await waitFor(() => expect(createTask).toHaveBeenCalledOnce());
  expect(vi.mocked(createTask).mock.calls[0]![1]).toMatchObject({ type: 'goal', title: 'Untagged goal', tagIds: [] });
});
