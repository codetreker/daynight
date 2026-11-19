import { afterEach, expect, it, vi } from 'vitest';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { finishGoalDependencyReturn, goalDependencyPosition, saveGoalDependencyPosition, goalDependencyReturn, markGoalDependencyDeparture, rememberGoalDependencyReading, type GoalDependencyPosition } from '../src/features/goal-detail/goal-dependency-reading';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const projectId = '10000000-0000-4000-8000-000000000001';
const goalId = '20000000-0000-4000-8000-000000000001';
const position: GoalDependencyPosition = { projectId, goalId, history: 3, cursor: 'page-3', previous: [null, 'page-2'] };
const href = '/projects/10000000-0000-4000-8000-000000000002/tasks/20000000-0000-4000-8000-000000000002?tab=description';
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
const scope = () => { const created = createTaskCacheScope({ userId: TEST_VIEWER_ID, onIdentityMismatch: vi.fn() }); scopes.push(created); return created; };
afterEach(() => { for (const current of scopes.splice(0)) current.dispose(); });

it('retains entry coordinates independently from focus across repeated native traversals', () => {
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
  expect(goalDependencyPosition(current, 'source-entry', position)).toEqual(position);
  for (let cycle = 0; cycle < 2; cycle++) {
    markGoalDependencyDeparture(current, 'source-entry', href);
    const next = goalDependencyReturn(current, 'source-entry', position)!;
    expect(next.position).toEqual(position);
    expect(finishGoalDependencyReturn(current, 'source-entry', next)).toBe(true);
  }
  const latest = { ...position, cursor: 'page-4', previous: [...position.previous, position.cursor] };
  saveGoalDependencyPosition(current, 'source-entry', latest);
  markGoalDependencyDeparture(current, 'source-entry', href);
  expect(goalDependencyReturn(current, 'source-entry', position)?.position).toEqual(latest);
});

it('discards an uncommitted dependency click when a different route is later chosen', () => {
  const current = scope();
  rememberGoalDependencyReading(current, 'source-entry', position, href);
  markGoalDependencyDeparture(current, 'source-entry', '/projects');
  markGoalDependencyDeparture(current, 'source-entry', href);
  expect(goalDependencyReturn(current, 'source-entry', position)).toBeNull();
  expect(goalDependencyPosition(current, 'source-entry', position)).toEqual(position);
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

it('isolates simultaneous Goal readers in one entry while only the clicked reader owns return focus', () => {
  const current = scope(), other = { ...position, goalId: '20000000-0000-4000-8000-000000000003', cursor: 'other-page', previous: [null] };
  rememberGoalDependencyReading(current, 'shared-entry', other, '/other-goal');
  rememberGoalDependencyReading(current, 'shared-entry', position, href);
  markGoalDependencyDeparture(current, 'shared-entry', href);
  saveGoalDependencyPosition(current, 'shared-entry', other);
  expect(goalDependencyPosition(current, 'shared-entry', position)).toEqual(position);
  expect(goalDependencyPosition(current, 'shared-entry', other)).toEqual(other);
  expect(goalDependencyReturn(current, 'shared-entry', other)).toBeNull();
  const returned = goalDependencyReturn(current, 'shared-entry', position)!;
  expect(returned.href).toBe(href);
  expect(finishGoalDependencyReturn(current, 'shared-entry', returned)).toBe(true);
  markGoalDependencyDeparture(current, 'shared-entry', href);
  saveGoalDependencyPosition(current, 'shared-entry', other);
  expect(goalDependencyReturn(current, 'shared-entry', position)?.href).toBe(href);
});
