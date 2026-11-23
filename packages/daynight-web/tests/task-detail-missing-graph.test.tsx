import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskDetailPage } from '../src/features/task-detail/TaskDetailPage';
import { taskDetailUrl } from '../src/app/router';
import { renderWithLocale } from './helpers/renderWithLocale';

const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const refresh = vi.hoisted(() => vi.fn());

vi.mock('../src/features/projects/useTaskGraph', () => ({ useTaskGraph: () => ({ snapshot: null, error: null, refresh }) }));
vi.mock('../src/features/task-assignees/TaskAssignees', async original => ({
  ...await original<typeof import('../src/features/task-assignees/TaskAssignees')>(),
  useProjectAssigneeReceipt: () => {},
}));
vi.mock('../src/features/task-detail/TypedDetail', () => ({
  TypedDetail: ({ onNavigateExternalTask }: { onNavigateExternalTask: (id: string, trigger: HTMLElement) => void }) =>
    <button onClick={event => onNavigateExternalTask(targetId, event.currentTarget)}>Open target</button>,
}));

describe('detail navigation without a graph snapshot', () => {
  it('opens the actual task URL instead of waiting for a graph refresh', () => {
    history.replaceState(null, '', taskDetailUrl(projectId, taskId, { tab: 'overview', path: null }));
    renderWithLocale(<TaskDetailPage projectId={projectId} taskId={taskId} navigation={{ tab: 'overview', path: null }} />, { locale: 'en', taskCache: true });
    fireEvent.click(screen.getByRole('button', { name: 'Open target' }));
    expect(location.pathname).toBe(taskDetailUrl(projectId, targetId, { tab: 'overview', path: null }));
    expect(refresh).not.toHaveBeenCalled();
  });
});
