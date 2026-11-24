import { expect, it } from 'vitest';
import type { Project, TaskDetail, TaskSummary } from '../src/api/types';
import { projectCommittedTasks, type CommittedTaskProjection } from '../src/features/projects/committed-task-projection';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { projectSummaries } from '../src/features/task-cache/projection';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const time = '2026-11-23T12:00:00Z';
const project: Project = { id: id(1), name: 'Project', repoUrl: 'https://example.test/repo', ownership: { teamId: id(2), version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time };
const goal: TaskSummary = { id: id(3), type: 'goal', parentId: null, title: 'Goal', titlePreview: 'Goal', titleTruncated: false, status: 'todo', version: 1n, properties: {}, tags: [], dependsOn: [id(4)], externalDependsOn: [], allowAgents: false, assignedTo: null, requiredPlatform: null, startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time };
const detail = (summary: TaskSummary): TaskDetail => {
  const { titlePreview: _titlePreview, titleTruncated: _titleTruncated, ...fields } = summary;
  return { ...fields, projectId: project.id, description: '', dependsOn: [], blockedBy: [], ready: false };
};
const snapshot = (summary: TaskSummary): GraphSnapshot => ({ ...projectSummaries(project, [summary], new Map(), time), summaries: new Map([[summary.id, summary]]), observedAt: time, receivedMonotonic: 1, receivedAt: 1, revision: 1 });
const fence = { cacheGeneration: 'generation', scopeRevision: 1, historyGeneration: 1 };
const receipt = (before: TaskDetail, current: TaskDetail): ReadonlyMap<string, CommittedTaskProjection> => new Map([[current.id, { before, detail: current, ...fence }]]);

it.each([
  { title: 'Renamed Goal', titlePreview: 'Renamed Goal' },
  { status: 'in_progress' as const, startedAt: time },
])('preserves synchronized Goal edges while projecting a newer detail receipt: %j', (change) => {
  const updated = { ...goal, ...change, version: 2n };
  const original = snapshot(goal);
  const result = projectCommittedTasks(original, receipt(detail(goal), detail(updated)), fence);
  expect(result.error).toBeNull();
  expect(result.snapshot.summaries.get(goal.id)).toEqual(updated);
  expect(result.snapshot.graph.tasks).toEqual([]);
  expect(original.summaries.get(goal.id)).toBe(goal);
});

it('compares a same-version Goal detail only on fields covered by the receipt', () => {
  const original = snapshot(goal);
  expect(projectCommittedTasks(original, receipt(detail(goal), detail(goal)), fence)).toEqual({ snapshot: original, error: null });
  const conflicting = { ...detail(goal), title: 'Conflicting title' };
  expect(projectCommittedTasks(original, receipt(detail(goal), conflicting), fence).error?.kind).toBe('protocol');
  const updated = { ...detail(goal), version: 2n, title: 'New title' };
  expect(projectCommittedTasks(original, receipt(conflicting, updated), fence).error?.kind).toBe('protocol');
});

it('lets the confirmed same-version sync replace edges after a Goal detail edit', () => {
  const updated = { ...goal, version: 2n, title: 'Renamed Goal', titlePreview: 'Renamed Goal' };
  const cleared = { ...updated, dependsOn: [] };
  const original = snapshot(cleared);
  const result = projectCommittedTasks(original, receipt(detail(goal), detail(updated)), fence);
  expect(result).toEqual({ snapshot: original, error: null });
  expect(result.snapshot.summaries.get(goal.id)?.dependsOn).toEqual([]);
});

it('preserves known parent facts and unrelated legacy observations across detail receipts', () => {
  const child: TaskSummary = { ...goal, type: 'task', parentTaskId: id(8), dependsOn: [], allowAgents: true };
  const { parentTaskId: _parent, ...withoutParent } = child;
  const legacy: TaskSummary = { ...withoutParent, id: id(5) };
  const states = new Map([child, legacy].map(task => [task.id, { taskVersion: task.version, ready: true, blockedBy: [] }]));
  const projection = projectSummaries(project, [child, legacy], states, time);
  const original: GraphSnapshot = { ...projection, index: { ...projection.index, legacyTaskParentIds: new Set([legacy.id]) },
    summaries: new Map([[child.id, child], [legacy.id, legacy]]), observedAt: time, receivedMonotonic: 1, receivedAt: 1, revision: 1 };
  const { parentTaskId: _detailParent, ...beforeFields } = detail(child);
  const before = { ...beforeFields, ready: true };
  const updated = { ...before, version: 2n, title: 'Updated' };
  const result = projectCommittedTasks(original, receipt(before, updated), fence);
  expect(result.error).toBeNull();
  expect(result.snapshot.index.nodes.get(child.id)?.parentTaskId).toBe(id(8));
  expect(result.snapshot.index.legacyTaskParentIds?.has(legacy.id)).toBe(true);
  expect(projectCommittedTasks(original, receipt(before, { ...updated, parentTaskId: null }), fence).error?.kind).toBe('protocol');
});
