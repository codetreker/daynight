import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { TaskStatusFeedback } from '../src/features/task-detail/TaskStatus';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { LanguageSelector } from '../src/i18n/LanguageSelector';
import { renderWithLocale } from './helpers/renderWithLocale';
const detail: TaskDetail = { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'task', projectId: 'project', version: 1n, title: 'Task content', description: '', properties: { worker: null, pullRequests: [] }, status: 'todo', dependsOn: [], blockedBy: [], ready: true, createdAt: '', updatedAt: '' };
const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };
const operation = { action: 'status' as const, status: 'in_progress' as const, version: 1n };
const mount = (mutation = idle, task = detail) => { const onReconcile = vi.fn(); const view = renderWithLocale(<><LanguageSelector /><TaskStatusFeedback detail={task} mutation={mutation} onReconcile={onReconcile} /></>, { locale: 'en' }); return { ...view, onReconcile }; };
describe('task status feedback', () => {
  it.each(['todo', 'in_progress', 'done'] as const)('keeps ordinary %s details free of duplicate mutation controls', (status) => { mount(idle, { ...detail, status }); expect(screen.queryByRole('region', { name: 'Task status' })).toBeNull(); });
  it('announces pending state without an additional write entry', () => { mount({ ...idle, operation, phase: 'pending' }); const section = screen.getByRole('region', { name: 'Task status' }); expect(section).toHaveAttribute('aria-busy', 'true'); expect(within(section).getByRole('status')).toHaveTextContent('Submitting the status request.'); expect(within(section).queryByRole('button')).toBeNull(); });
  it('describes a newly confirmed request in both languages', () => { const view = mount({ ...idle, phase: 'pending', operation }); view.rerender(<><LanguageSelector /><TaskStatusFeedback detail={detail} mutation={{ ...idle, phase: 'confirmed', operation }} onReconcile={vi.fn()} /></>); expect(screen.getByRole('status')).toHaveTextContent('Task status confirmed.'); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } }); expect(screen.getByRole('status')).toHaveTextContent('任务状态已确认。'); });
  it('preserves write and read failures and offers only explicit GET checking while unknown', () => {
    const writeError = new ApiError('protocol', 200, 'protocol', 'write-request'); const readError = new ApiError('network', null, 'network', 'read-request');
    const { onReconcile } = mount({ ...idle, phase: 'unknown', operation, error: writeError, reconciliationError: readError });
    expect(screen.getByText('write-request')).toBeVisible(); expect(screen.getByText('read-request')).toBeVisible(); expect(screen.getByText(/status request outcome is unknown/)).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByRole('button', { name: 'Check task state' })); expect(onReconcile).toHaveBeenCalledOnce(); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zh-CN' } }); expect(screen.getByRole('button', { name: '检查任务状态' })).toBeEnabled();
  });
  it.each([
    [new ApiError('server', 409, 'version_conflict', 'version-request'), 'The task version changed before the status request could be applied.'],
    [new ApiError('server', 409, 'dependency_unsatisfied', 'dependency-request'), 'Unfinished prerequisites or active/completed dependent tasks prevent this status change.'],
    [new ApiError('server', 404, 'not_found', 'notfound-request'), 'The task or project is no longer available.'],
    [new ApiError('server', 400, 'invalid_input', 'validation-request'), 'The service refused the status request.'],
    [new Error('transport failure'), 'The status request failed.'],
  ])('shows refusal with accessible error feedback %#', (error, text) => { mount({ ...idle, operation, phase: 'refused', error }); expect(screen.getByRole('alert')).toHaveTextContent(text); });
  it('describes reconciliation as a read without attributing the request outcome', () => { mount({ ...idle, operation, phase: 'reconciled', error: new ApiError('network') }); expect(screen.getByRole('status')).toHaveTextContent('This does not establish the outcome of the earlier request.'); expect(screen.queryByText('Task status confirmed.')).toBeNull(); });
  it('does not duplicate permission feedback', () => { mount({ ...idle, phase: 'pending', operation: { action: 'allowAgents', allowAgents: true, version: 1n } }); expect(screen.queryByRole('region', { name: 'Task status' })).toBeNull(); });
});
