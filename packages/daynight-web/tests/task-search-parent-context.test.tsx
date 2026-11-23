import { createRef } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TaskSearchItem } from '../src/api/task-search';
import { TaskSearchWorkspace } from '../src/features/task-search/TaskSearchWorkspace';
import type { TaskSearchController } from '../src/features/task-search/useTaskSearch';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/features/task-assignment/TaskAssigneeFilter', () => ({ TaskAssigneeFilter: () => null }));
vi.mock('../src/features/task-assignment/TaskAssigneeIdentity', () => ({ TaskAssigneeIdentity: () => null }));
vi.mock('../src/features/task-tags/TagColor', () => ({ TagColorFeedback: () => null }));

const projectId = '00000000-0000-4000-8000-000000000100';
const item = (id: string, context: TaskSearchItem['context'], parentTaskContext?: TaskSearchItem['parentTaskContext']): TaskSearchItem => ({
  id, projectId, type: 'task', parentId: context?.taskId ?? null,
  ...(parentTaskContext === undefined ? {} : { parentTaskId: parentTaskContext.taskId, parentTaskContext }),
  title: id, status: 'todo', assignedTo: null, updatedAt: '2026-01-01T00:00:00Z', cancelledAt: null,
  tags: [], context, match: { fields: ['title'], descriptionSnippet: null },
});
const items = [item('child-of-goal', { taskId: 'goal-id', title: 'Release goal' }), item('child-of-task', null, { taskId: 'task-id', title: 'Repair task' })];
const noop = () => {};
const search: TaskSearchController = {
  draft: 'child', applied: 'child', filters: { status: '', assignedTo: '', type: 'task', parentId: null, tagIds: [], tagMatch: 'all', untagged: false },
  items, page: 1, pageIndex: 1, total: 2, canPrevious: false, canNext: false, busy: false, error: null, errorQuery: null,
  tagFilterInvalid: false, serverInvalidRevision: 0, setDraft: noop, setFilters: noop, setTagFilterInvalid: noop, submit: noop, clear: noop, previous: noop, next: noop, retry: noop,
};

describe('search parent context', () => {
  it.each([['en', 'Parent Task'], ['zh-CN', '父 Task']] as const)('keeps the production default and distinguishes enabled context in %s', (locale, parentLabel) => {
    const open = vi.fn();
    const props = { projectId, search, inputRef: createRef<HTMLInputElement>(), onOpenTask: open };
    const view = renderWithLocale(<TaskSearchWorkspace {...props} />, { locale });
    expect(screen.getByText('◇ Release goal')).toBeVisible();
    expect(screen.queryByText(`${parentLabel}: Repair task`)).toBeNull();
    view.rerender(<TaskSearchWorkspace {...props} showOrdinaryParentContext />);
    expect(screen.getByText('◇ Goal: Release goal')).toBeVisible();
    const context = screen.getByText(`${parentLabel}: Repair task`);
    const result = context.closest('button')!;
    expect(result).toHaveTextContent('child-of-task');
    expect(result).toHaveAccessibleName(new RegExp(`${parentLabel}: Repair task`));
    fireEvent.click(result);
    expect(open).toHaveBeenCalledWith('child-of-task', result);
  });
});
