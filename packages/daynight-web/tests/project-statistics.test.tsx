import { fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { ProjectStatistics } from '../src/features/project-statistics/ProjectStatistics';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/features/task-cache/TaskCacheProvider', () => ({ useTaskCacheScope: () => scope }));
vi.mock('../src/features/projects/ProjectAccess', () => ({ useProjectAccessSession: () => null }));
vi.mock('../src/features/task-assignees/TaskAssignees', () => ({ useTaskAssigneeDemand: () => ({ people: new Map() }) }));
const scope = { subscribe: () => () => {} };
vi.mock('../src/features/project-statistics/useDateWindow', () => ({ useDateWindow: () => ({ dates: Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`), endDate: '2026-03-30', segments: [], encoded: 'window' }) }));
vi.mock('../src/features/project-statistics/pr-statistics', () => ({ usePRStatistics: () => ({ data: { projectTotal: '4', availability: 'ready', hasAuthors: true, daily: Array(30).fill('4'), authorId: '8', author: null, authorDaily: Array(30).fill('0') }, error: null, loading: false, author: null, refresh: () => {}, setAuthor: () => {}, authors: { items: [], query: '', loaded: false, loading: false, error: null, nextCursor: null, rebuilding: false, open: () => {}, close: () => {}, setQuery: () => {}, loadMore: () => {}, retry: () => {} } }) }));

it('renders the whole-project series when a missing author is cleared', () => {
  createLocaleRender('en')(<ProjectStatistics userId="user" projectId="project" canRead active snapshot={null} taskError={null} onTaskRetry={() => {}} onPrincipalMismatch={() => {}} onAccessError={() => {}} refreshRevision={0} />);
  expect(screen.getByRole('button', { name: 'Creator: All' })).toBeInTheDocument();
  const chart = screen.getByRole('listbox', { name: 'PRs created daily' });
  expect(within(chart).getAllByRole('option')[0]).toHaveAccessibleName(/: 4$/);
});

it('isolates the task selection across identity and project changes', () => {
  const snapshot = { graph: { tasks: [{ id: 'one', createdAt: '2026-03-30T12:00:00Z', assignedTo: 'user-a' }] }, observedAt: '2026-03-30T12:00:00Z', revision: 1 } as unknown as GraphSnapshot;
  const props = { userId: 'user', projectId: 'project', canRead: true, active: true, snapshot, taskError: null, onTaskRetry: () => {}, onPrincipalMismatch: () => {}, onAccessError: () => {}, refreshRevision: 0 };
  const view = createLocaleRender('en')(<ProjectStatistics {...props} />);
  const select = () => screen.getByRole('combobox', { name: 'Filter tasks by assignee' });
  fireEvent.change(select(), { target: { value: 'user-a' } });
  view.rerender(<ProjectStatistics {...props} userId="other-user" />);
  expect(select()).toHaveValue('');
  fireEvent.change(select(), { target: { value: 'user-a' } });
  view.rerender(<ProjectStatistics {...props} userId="other-user" projectId="other-project" />);
  expect(select()).toHaveValue('');
});
