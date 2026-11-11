import { fireEvent, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import type { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { GoalDetailSurface } from '../src/features/goal-detail/GoalDetailSurface';
import { GoalCreate } from '../src/features/goal-detail/GoalCreate';
import { ApiError, createTask } from '../src/api/client';
import { detailFixture } from './helpers/taskDetail';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));
vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({ TaskAttachmentsPanel: () => null }));
vi.mock('../src/features/task-thread/TaskDiscussion', () => ({ TaskDiscussion: () => null }));
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), createTask: vi.fn() }));
vi.mock('../src/features/task-detail/TaskOrganization', () => ({ TaskOrganization: () => null, FormDialog: ({ title, children }: { title: string; children: ReactNode }) => <section role="dialog" aria-label={title}>{children}</section> }));
vi.mock('../src/features/projects/ProjectAccess', async original => ({ ...await original<typeof import('../src/features/projects/ProjectAccess')>(), useProjectAccess: () => ({ ready: true, session: { waitForFreshAccess: async () => ({}) } }) }));
vi.mock('../src/features/task-assignment/TaskAssigneeSelect', () => ({ TaskAssigneeSelect: () => null }));
vi.mock('../src/features/task-assignment/TaskAssigneeIdentity', () => ({ TaskAssigneeIdentity: () => null }));
vi.mock('../src/features/task-assignment/AssigneePicker', () => ({ AssigneePicker: () => null }));

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

it.each(['api', 'confirmed-api', 'non-api'] as const)('reports an unknown Goal creation after a %s error without claiming failure', async kind => {
  vi.mocked(createTask).mockImplementation(async (_project, _input, _signal, admission) => {
    if (kind === 'api') throw new ApiError('server', 503, 'invalid_input', 'request-2');
    if (kind === 'confirmed-api') { admission.onWriteConfirmed?.(); throw new ApiError('server', 400, 'invalid_input', 'request-2'); }
    throw new Error('Unclassified creation outcome');
  });
  renderWithLocale(<GoalCreate projectId={projectId} onClose={() => {}} onRefreshGraph={() => {}} />, { locale: 'en', taskCache: true, container: root });
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft title' } });
  fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
  expect(await screen.findByText(/The creation outcome is unknown\. Check the Goal list/)).toBeVisible();
  expect(screen.queryByText('Creation failed')).toBeNull();
  expect(screen.queryByText(/Goal information is invalid/i)).toBeNull();
  expect(screen.getByRole('button', { name: /^Create$/ })).toBeDisabled();
  if (kind !== 'non-api') expect(screen.getByText('request-2').closest('p')).toHaveTextContent('(invalid_input)');
  expect(createTask).toHaveBeenCalledTimes(1);
});
