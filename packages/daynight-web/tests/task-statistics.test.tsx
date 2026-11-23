import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { CacheEvent } from '../src/features/task-cache/project-cache';
import { TaskStatistics } from '../src/features/project-statistics/TaskStatistics';
import { createDateWindow } from '../src/features/project-statistics/date-window';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/features/task-assignees/TaskAssignees', () => ({ useTaskAssigneeDemand: () => ({ people: new Map([['user-a', { name: 'Same' }], ['user-b', { name: 'Same' }]]) }) }));
const listeners = new Set<(event: CacheEvent) => void>();
vi.mock('../src/features/task-cache/TaskCacheProvider', () => ({ useTaskCacheScope: () => scope }));
vi.mock('../src/features/projects/ProjectAccess', () => ({ useProjectAccessSession: () => null }));
const scope = { subscribe: (listener: (event: CacheEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
const render = createLocaleRender('en');
const dateWindow = createDateWindow(Date.parse('2026-03-08T12:00:00Z'), () => 0);
const snapshot = (tasks: { id: string; createdAt: string; assignedTo: string | null }[]) => ({ graph: { tasks }, observedAt: '2026-03-08T12:00:00Z', revision: 1 } as unknown as GraphSnapshot);
const entries = [
  { id: 'one', createdAt: '2026-03-08T00:00:00Z', assignedTo: 'user-a' },
  { id: 'two', createdAt: '2026-03-08T23:59:59Z', assignedTo: null },
  { id: 'old', createdAt: '2026-01-01T00:00:00Z', assignedTo: 'user-b' },
];

describe('task statistics', () => {
  it('uses the entire snapshot for the total, filters by stable assignee, and preserves the all-person scale', () => {
    const view = render(<TaskStatistics projectId="project" snapshot={snapshot(entries)} error={null} onRetry={() => {}} window={dateWindow} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    const filter = screen.getByRole('combobox', { name: 'Filter tasks by assignee' });
    expect(within(filter).getByRole('option', { name: 'Same · user-a' })).toBeInTheDocument();
    const chart = screen.getByRole('listbox', { name: 'Tasks created daily' });
    expect(within(chart).getAllByRole('option')).toHaveLength(30);
    expect(within(chart).getAllByRole('option')[29]).toHaveAccessibleName(/: 2$/);
    fireEvent.change(filter, { target: { value: 'user-a' } });
    expect(within(chart).getAllByRole('option')[29]).toHaveAccessibleName(/: 1$/);
    expect(chart.closest('.bar-chart')!.querySelector('.bar-chart__scale')).toHaveTextContent('2');
    view.rerender(<TaskStatistics projectId="project" snapshot={snapshot([{ ...entries[0]!, assignedTo: 'user-b' }, entries[1]!, entries[2]!])} error={null} onRetry={() => {}} window={dateWindow} />);
    expect(filter).toHaveValue('');
    expect(within(chart).getAllByRole('option')[29]).toHaveAccessibleName(/: 2$/);
  });
  it('does not present a failed or pending snapshot as zero and offers retry', () => {
    const retry = vi.fn();
    const view = render(<TaskStatistics projectId="project" snapshot={null} error={null} onRetry={retry} window={dateWindow} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByRole('listbox')).toBeNull();
    view.rerender(<TaskStatistics projectId="project" snapshot={null} error={new Error('failed')} onRetry={retry} window={dateWindow} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('retains the selection while the admitted snapshot is unavailable and resets it only when a new snapshot excludes it', () => {
    const view = render(<TaskStatistics projectId="project" snapshot={snapshot(entries)} error={null} onRetry={() => {}} window={dateWindow} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter tasks by assignee' }), { target: { value: 'user-a' } });
    view.rerender(<TaskStatistics projectId="project" snapshot={null} error={null} onRetry={() => {}} window={dateWindow} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    view.rerender(<TaskStatistics projectId="project" snapshot={snapshot(entries)} error={null} onRetry={() => {}} window={dateWindow} />);
    expect(screen.getByRole('combobox', { name: 'Filter tasks by assignee' })).toHaveValue('user-a');
    expect(within(screen.getByRole('listbox', { name: 'Tasks created daily' })).getAllByRole('option')[29]).toHaveAccessibleName(/: 1$/);
    view.rerender(<TaskStatistics projectId="project" snapshot={snapshot(entries.filter(entry => entry.assignedTo !== 'user-a'))} error={null} onRetry={() => {}} window={dateWindow} />);
    expect(screen.getByRole('combobox', { name: 'Filter tasks by assignee' })).toHaveValue('');
  });
  it('retains the selection across temporary isolation but clears it after confirmed access withdrawal', () => {
    const view = render(<TaskStatistics projectId="project" snapshot={snapshot(entries)} error={null} onRetry={() => {}} window={dateWindow} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter tasks by assignee' }), { target: { value: 'user-a' } });
    act(() => { for (const listener of listeners) listener({ projectId: 'project', accessRevoked: true, directAccessUncertain: true, error: new ApiError('server', 404, 'not_found') }); });
    act(() => { for (const listener of listeners) listener({ projectId: 'project', accessRevoked: true, peerHintWithdrawal: true, error: new ApiError('server', 404, 'not_found') }); });
    view.rerender(<TaskStatistics projectId="project" snapshot={null} error={null} onRetry={() => {}} window={dateWindow} />);
    act(() => { for (const listener of listeners) listener({ projectId: 'project', directAccessRecheck: true, accessRestored: true }); });
    view.rerender(<TaskStatistics projectId="project" snapshot={snapshot(entries)} error={null} onRetry={() => {}} window={dateWindow} />);
    expect(screen.getByRole('combobox', { name: 'Filter tasks by assignee' })).toHaveValue('user-a');
    act(() => { for (const listener of listeners) listener({ projectId: 'project', directAccessUncertain: true }); });
    act(() => { for (const listener of listeners) listener({ projectId: 'project', directAccessRecheck: true, error: new ApiError('server', 404, 'not_found') }); });
    expect(screen.getByRole('combobox', { name: 'Filter tasks by assignee' })).toHaveValue('');
  });
});
