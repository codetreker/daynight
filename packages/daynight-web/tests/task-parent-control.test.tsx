import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskDetail, TaskSummary } from '../src/api/types';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { ExistingSelection } from '../src/features/task-detail/TaskOrganization';
import * as taskDetailHook from '../src/features/task-detail/useTaskDetail';
import type { TaskMutationState } from '../src/features/task-detail/TaskDetailSession';
import { renderWithLocale } from './helpers/renderWithLocale';

const goal = (id: string, title: string) => ({ id, type: 'goal', titlePreview: title, titleTruncated: false } as TaskSummary);
const snapshot = { summaries: new Map([['a', goal('a', 'Goal A')], ['b', goal('b', 'Goal B')]]), index: { nodes: new Map() }, revision: 1 } as unknown as GraphSnapshot;
const detail = { parentId: 'a', version: 9007199254740993n } as TaskDetail;
const idle: TaskMutationState = { operation: null, phase: 'idle', error: null, reconciling: false, reconciliationError: null };

describe('Task Goal control', () => {
  it('requires a new review if the selected Task changes Goal or version before submission', () => {
    const setParent = vi.fn();
    const source = { ...detail, title: 'Selected Task', parentId: 'a' };
    const state = { detail: source, canSetParent: true, mutation: idle, error: null, status: 'ready', setParent, retry: vi.fn() } as unknown as ReturnType<typeof taskDetailHook.useTaskDetail>;
    const hook = vi.spyOn(taskDetailHook, 'useTaskDetail').mockReturnValue(state);
    const view = renderWithLocale(<ExistingSelection projectId="project" taskId="task" goalId="target" snapshot={snapshot} onClose={vi.fn()} />, { locale: 'en' });
    expect(screen.getByText('Current Goal: Goal A (a)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeEnabled();
    hook.mockReturnValue({ ...state, detail: { ...source, parentId: 'b', version: source.version + 1n } });
    view.rerender(<ExistingSelection projectId="project" taskId="task" goalId="target" snapshot={snapshot} onClose={vi.fn()} />);
    expect(screen.getByText('Current Goal: Goal B (b)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add to Goal' })).toBeDisabled();
    expect(setParent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review current Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Goal' }));
    expect(setParent).toHaveBeenCalledExactlyOnceWith('target', source.version + 1n);
    hook.mockRestore();
  });
});
