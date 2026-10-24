import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { TaskAgentPermissionFeedback, TaskAgentPermissionSwitch } from '../src/features/task-detail/TaskAgentPermission';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { LanguageSelector } from '../src/i18n/LanguageSelector';
import { renderWithLocale } from './helpers/renderWithLocale';

const detail: TaskDetail = {
  requiredPlatform: null, allowAgents: false, id: 'task', projectId: 'project', title: 'Deployment acceptance', description: '',
  properties: { worker: null, pullRequests: [] }, status: 'todo', version: 12n, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: true,
  startedAt: null, completedAt: null, createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
};
const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };
const permission: TaskMutationState = { ...idle, operation: { action: 'allowAgents', allowAgents: true, version: detail.version } };
const feedbackId = 'automation-feedback';
const mount = (mutation: TaskMutationState = idle, task: TaskDetail | null = detail, disabled = false) => {
  const onClick = vi.fn();
  const onReconcile = vi.fn();
  const content = (state: TaskMutationState, current: TaskDetail | null, unavailable = false) => <>
    <LanguageSelector />
    {current !== null && <TaskAgentPermissionSwitch detail={current} disabled={unavailable} describedBy={feedbackId} onClick={onClick} />}
    <TaskAgentPermissionFeedback detail={current} mutation={state} id={feedbackId} onReconcile={onReconcile} />
  </>;
  const view = renderWithLocale(content(mutation, task, disabled), { locale: 'en' });
  return { ...view, onClick, onReconcile, update: (state: TaskMutationState, current: TaskDetail | null = task, unavailable = disabled) => view.rerender(content(state, current, unavailable)) };
};

describe('automatic execution presentation', () => {
  it('uses one bilingual switch that reports the confirmed value and requests a change without changing it', () => {
    const view = mount();
    const control = screen.getByRole('switch', { name: 'Automatic execution' });
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveAttribute('aria-describedby', feedbackId);
    fireEvent.click(control);
    expect(view.onClick).toHaveBeenCalledOnce();
    expect(control).toHaveAttribute('aria-checked', 'false');
    view.update(idle, { ...detail, allowAgents: true });
    expect(control).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } });
    expect(screen.getByRole('switch', { name: '自动执行' })).toBe(control);
    expect(screen.getAllByRole('switch')).toHaveLength(1);
  });

  it('keeps an executing task readable and explains why its switch cannot be changed', () => {
    const view = mount(idle, { ...detail, status: 'in_progress', ready: false, allowAgents: true }, true);
    const control = screen.getByRole('switch', { name: 'Automatic execution' });
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toHaveAccessibleDescription('This task is in progress. Automatic execution settings cannot change while it remains in progress.');
    fireEvent.click(control);
    expect(view.onClick).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } });
    expect(control).toHaveAccessibleDescription('任务正在进行中，保持此状态时无法修改自动执行设置。');
  });

  it('announces a pending write while preserving the saved switch and hiding any retry action', () => {
    const { container, onClick } = mount({ ...permission, phase: 'pending' }, detail, true);
    expect(container.querySelector(`#${feedbackId}`)).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Saving automatic execution. You can close these details while the request completes.');
    const control = screen.getByRole('switch');
    expect(control).toBeDisabled();
    expect(control).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(control);
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Check actual task' })).toBeNull();
  });

  it('keeps both write and reconciliation errors visible until the actual task is confirmed', () => {
    const writeError = new ApiError('network', null, 'network', 'permission-write', undefined, new Error('connection reset'));
    const readError = new ApiError('protocol', 200, 'protocol', 'permission-read', undefined, new Error('malformed response'));
    const failed: TaskMutationState = { ...permission, phase: 'unknown', error: writeError, reconciliationError: readError };
    const view = mount(failed, detail, true);
    expect(screen.getByText('permission-write')).toBeVisible();
    expect(screen.getByText('permission-read')).toBeVisible();
    expect(screen.getByText('The automatic execution change did not reach a confirmed response from the service.')).toBeVisible();
    expect(screen.getByText('The service response could not confirm the automatic execution setting.')).toBeVisible();
    expect(screen.getByText('The actual task could not be confirmed. Changes remain unavailable until it can be read.')).toBeVisible();
    expect(screen.queryByText('connection reset')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check actual task' }));
    expect(view.onReconcile).toHaveBeenCalledOnce();
    view.update({ ...failed, reconciling: true, reconciliationError: null });
    expect(screen.getByRole('button', { name: 'Checking the actual task…' })).toBeDisabled();
    expect(screen.getByText('Checking the actual task…', { selector: 'p' })).toHaveAttribute('role', 'alert');
    view.update({ ...permission, phase: 'reconciled' }, { ...detail, allowAgents: true }, false);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('The actual task has been read. The displayed setting is confirmed.');
    expect(screen.queryByRole('button', { name: 'Check actual task' })).toBeNull();
  });

  it('distinguishes a confirmed permission change from a conflict that needs another decision', () => {
    const view = mount({ ...permission, phase: 'pending' });
    view.update({ ...permission, phase: 'confirmed' }, { ...detail, allowAgents: true });
    expect(screen.getByRole('status')).toHaveTextContent('Automatic execution updated.');
    view.update({ ...permission, phase: 'conflict', error: new ApiError('server', 409, 'version_conflict', 'stale-permission') });
    expect(screen.getByText('The task changed. Review its current setting before confirming another change.')).toHaveAttribute('role', 'alert');
    expect(screen.getByText('The task version changed before this update could be applied.')).toBeVisible();
    expect(screen.getByText('stale-permission')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Check actual task' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } });
    expect(screen.getByText('任务已发生变化，请检查当前设置后重新确认修改。')).toBeVisible();
  });

  it('expires a newly confirmed success after three seconds without replaying it on refresh or reopen', () => {
    vi.useFakeTimers();
    const confirmed = { ...permission, phase: 'confirmed' as const };
    const view = mount({ ...permission, phase: 'pending' });
    view.update(confirmed);
    expect(screen.getByRole('status')).toHaveClass('task-detail-toast');
    expect(view.container.querySelector(`#${feedbackId}`)).toBeEmptyDOMElement();
    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole('status')).toBeVisible();
    view.update({ ...confirmed });
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
    view.update({ ...confirmed }, { ...detail, version: 13n });
    expect(screen.queryByRole('status')).toBeNull();
    view.unmount();
    mount(confirmed);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces each newly confirmed operation and keeps locale changes within the original lifetime', () => {
    vi.useFakeTimers();
    const view = mount({ ...permission, phase: 'pending' });
    view.update({ ...permission, phase: 'confirmed' });
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } });
    expect(screen.getByRole('status')).toHaveTextContent('自动执行设置已更新。');
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('status')).toBeNull();
    const next = { ...permission, operation: { action: 'allowAgents' as const, allowAgents: false, version: 13n } };
    view.update({ ...next, phase: 'pending' });
    view.update({ ...next, phase: 'confirmed' });
    expect(screen.getByRole('status')).toHaveTextContent('自动执行设置已更新。');
  });

  it.each([
    [new ApiError('server', 409, 'invalid_transition', 'permission-lock'), 'Automatic execution cannot be changed while this task is in progress.'],
    [new ApiError('server', 404, 'not_found'), 'The task or project is no longer available.'],
    [new ApiError('server', 403, 'forbidden', 'permission-refused'), 'The service refused the automatic execution change.'],
    [new Error('unexpected adapter failure'), 'The automatic execution change failed.'],
  ])('shows the caller-visible reason for a refused change without altering its saved value %#', (error, message) => {
    mount({ ...permission, phase: 'refused', error });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('unexpected adapter failure')).toBeNull();
  });

  it('does not present status feedback as an automation result when no permission operation exists', () => {
    const status: TaskMutationState = { ...idle, phase: 'unknown', operation: { action: 'status', status: 'in_progress', version: 12n }, error: new ApiError('network'), reconciliationError: new Error('read failed') };
    const view = mount(status);
    expect(view.container.querySelector(`#${feedbackId}`)).toBeEmptyDOMElement();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    view.update(idle, null);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(view.container.querySelector(`#${feedbackId}`)).toBeEmptyDOMElement();
  });
});
