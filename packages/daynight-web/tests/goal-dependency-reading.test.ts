import { afterEach, expect, it, vi } from 'vitest';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { finishGoalDependencyReturn, goalDependencyReturn, markGoalDependencyDeparture, rememberGoalDependencyReading, type GoalDependencyPosition } from '../src/features/goal-detail/goal-dependency-reading';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const projectId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const position: GoalDependencyPosition = { projectId, goalId, history: 3, cursor: 'page-3', previous: [null, 'page-2'] };
const href = '/projects/10000000-0000-4000-8000-000000000002/tasks/20000000-0000-4000-8000-000000000002?tab=description';
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
const scope = () => { const created = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(created); return created; };
afterEach(() => { for (const current of scopes.splice(0)) current.dispose(); });

it('retains only the departed entry coordinates and consumes the matching return once', () => {
  const current = scope();
  rememberGoalDependencyReading(current, 'source-entry', position, href);
  expect(goalDependencyReturn(current, 'source-entry', position)).toBeNull();
  markGoalDependencyDeparture(current, 'source-entry', href);
  const reading = goalDependencyReturn(current, 'source-entry', position)!;
  expect(reading).toEqual({ position, href, departed: true });
  expect(reading.position.previous).not.toBe(position.previous);
  expect(goalDependencyReturn(current, 'other-entry', position)).toBeNull();
  expect(goalDependencyReturn(current, 'source-entry', { ...position, history: 4 })).toBeNull();
  expect(goalDependencyReturn(current, 'source-entry', { ...position, goalId: '20000000-0000-4000-8000-000000000003' })).toBeNull();
  expect(goalDependencyReturn(scope(), 'source-entry', position)).toBeNull();
  expect(finishGoalDependencyReturn(current, 'source-entry', reading)).toBe(true);
  expect(finishGoalDependencyReturn(current, 'source-entry', reading)).toBe(false);
  expect(goalDependencyReturn(current, 'source-entry', position)).toBeNull();
});

it('discards an uncommitted dependency click when a different route is later chosen', () => {
  const current = scope();
  rememberGoalDependencyReading(current, 'source-entry', position, href);
  markGoalDependencyDeparture(current, 'source-entry', '/projects');
  markGoalDependencyDeparture(current, 'source-entry', href);
  expect(goalDependencyReturn(current, 'source-entry', position)).toBeNull();
});

it('invalidates saved coordinates on source permission loss even with no Goal component mounted', () => {
  const current = scope();
  rememberGoalDependencyReading(current, 'source-entry', position, href);
  markGoalDependencyDeparture(current, 'source-entry', href);
  const reading = goalDependencyReturn(current, 'source-entry', position)!;
  current.suspendProject(projectId);
  expect(goalDependencyReturn(current, 'source-entry', position)).toBeNull();
  expect(finishGoalDependencyReturn(current, 'source-entry', reading)).toBe(false);
});

it('clears return metadata when the authenticated scope is retired', () => {
  const current = scope();
  rememberGoalDependencyReading(current, 'source-entry', position, href);
  markGoalDependencyDeparture(current, 'source-entry', href);
  current.principalMismatch();
  expect(goalDependencyReturn(current, 'source-entry', position)).toBeNull();
});
