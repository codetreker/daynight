import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { GoalDependencies as DependencyPage } from '../src/api/goal-dependencies';
import { browserNavigation } from '../src/app/navigation';
import { GoalDependencies } from '../src/features/goal-detail/GoalDependencies';
import type { useGoalDependencies } from '../src/features/goal-detail/useGoalDependencies';
import { renderWithLocale } from './helpers/renderWithLocale';

const projectId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const internal = { projectId, projectName: 'Client', goalId: '20000000-0000-4000-8000-000000000002', title: 'Release criteria', status: 'done' as const, kind: 'internal' as const };
const external = { ...internal, projectId: '10000000-0000-4000-8000-000000000002', projectName: 'Identity service', goalId: '20000000-0000-4000-8000-000000000003', title: 'Upgrade authentication', status: 'cancelled' as const, kind: 'external' as const };
const page: DependencyPage = { goalId, canEdit: false, completionBlocked: true, prerequisites: [{ target: internal }, { target: external }, { target: null }], successors: [internal], nextCursor: 'next-page' };
const view = (changes: Partial<ReturnType<typeof useGoalDependencies>> = {}) => ({ page, error: null, unavailable: false, pending: false, hasPrevious: false,
  position: { projectId, goalId, history: 0, cursor: null, previous: [] }, refresh: vi.fn(), next: vi.fn(), previous: vi.fn(), ...changes });
const panel = (dependencies = view(), canComplete = true, refusal: unknown = null) => <GoalDependencies dependencies={dependencies} canComplete={canComplete} refusal={refusal} fallbackFocus={{ current: null }} />;
afterEach(() => { cleanup(); browserNavigation().dispose(); vi.restoreAllMocks(); });

it('renders authorized targets, actual resource URLs, lifecycle and relation kinds in both languages', () => {
  const result = renderWithLocale(panel(), { locale: 'en', taskCache: true });
  const section = screen.getByRole('region', { name: 'Goal acceptance dependencies' });
  expect(within(section).getAllByText('Same project')).toHaveLength(2);
  expect(within(section).getByText('External · Identity service')).toBeVisible();
  expect(within(section).getByText('Cancelled')).toBeVisible();
  expect(within(section).getByText('You cannot access this Goal')).toBeVisible();
  const link = within(section).getByRole('link', { name: external.title });
  expect(link).toHaveAttribute('href', `/projects/${external.projectId}/tasks/${external.goalId}?tab=description`);
  expect(within(section).getAllByRole('link')).toHaveLength(3);
  expect(within(section).getByText('Completion blocked. A prerequisite Goal is unfinished.')).toBeVisible();
  result.setLocale('zh-CN');
  expect(screen.getByRole('region', { name: 'Goal 验收依赖' })).toBe(section);
  expect(within(section).getByText('无法访问此 Goal')).toBeVisible();
  expect(within(section).getByText('外部 · Identity service')).toBeVisible();
});

it('keeps blocking tied to the server projection and available completion controls', () => {
  const dependencies = view({ page: { ...page, completionBlocked: false } });
  const result = renderWithLocale(panel(dependencies), { locale: 'en', taskCache: true });
  expect(screen.queryByText(/Completion blocked/)).toBeNull();
  result.rerender(panel(view(), false)); expect(screen.queryByText(/Completion blocked/)).toBeNull();
  result.rerender(panel(view(), true, new ApiError('server', 409, 'goal_dependency_unsatisfied')));
  expect(screen.getByRole('alert')).toHaveTextContent('Cannot complete this Goal. A prerequisite Goal is unfinished.');
});

it('distinguishes loading, empty, unsupported and failed reads, and retains relations on refresh failure', () => {
  const loading = view({ page: null });
  const result = renderWithLocale(panel(loading), { locale: 'en', taskCache: true });
  expect(screen.getByRole('status')).toHaveTextContent('Loading Goal dependencies');
  const failed = view({ page: null, error: new Error('Offline') });
  result.rerender(panel(failed)); expect(screen.getByRole('alert')).toHaveTextContent('Could not load Goal dependencies.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(failed.refresh).toHaveBeenCalledOnce();
  const refresh = view({ error: new Error('Offline') }); result.rerender(panel(refresh));
  expect(screen.getByRole('alert')).toHaveTextContent('Showing the last loaded relationships.');
  expect(screen.getByRole('link', { name: external.title })).toBeVisible();
  result.rerender(panel(view({ page: { ...page, prerequisites: [], successors: [], nextCursor: null, completionBlocked: false } })));
  expect(screen.getAllByText('No related Goals')).toHaveLength(2); expect(screen.queryByRole('alert')).toBeNull();
  result.rerender(panel(view({ page: null, unavailable: true })));
  expect(screen.getByText('This server does not support Goal dependencies yet.')).toBeVisible();
  expect(screen.queryByRole('status')).toBeNull();
});

it('provides keyboard-accessible downstream pagination without implying hidden counts', () => {
  const dependencies = view();
  const result = renderWithLocale(panel(dependencies), { locale: 'en', taskCache: true });
  const pagination = screen.getByRole('navigation', { name: 'Dependent Goal pages' });
  expect(within(pagination).getByRole('button', { name: 'Previous' })).toBeDisabled();
  fireEvent.click(within(pagination).getByRole('button', { name: 'Next' })); expect(dependencies.next).toHaveBeenCalledOnce();
  result.rerender(panel(view({ hasPrevious: true, page: { ...page, nextCursor: null } })));
  expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});
