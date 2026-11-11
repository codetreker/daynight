import { describe, expect, it } from 'vitest';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { projectTaskScope } from '../src/features/task-graph/scope';

const time = '2026-10-20T12:00:00Z';
const task = (id: string, parentId: string | null, status: GraphTask['status'], dependsOn: string[] = []): GraphTask => ({
  type: 'task', parentId, id, status, titlePreview: id, titleTruncated: false, assignedTo: null, requiredPlatform: null, allowAgents: false,
  dependsOn, externalDependsOn: [], blockedBy: [], ready: status === 'todo', startedAt: null, completedAt: null, cancelledAt: null, createdAt: time, updatedAt: time,
});

describe('task scope projection', () => {
  it('classifies before applying parent scope and counts each actual task once', () => {
    const tasks = [task('root', 'a', 'done'), task('child', 'b', 'todo', ['root']), task('alone', 'b', 'cancelled'), task('unowned', null, 'todo', ['root'])];
    const graph: TaskGraph = { observedAt: time, project: { id: 'p', name: 'p', repoUrl: 'https://example.test/p', ownership: { teamId: 't', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time }, tasks,
      summary: { total: 4, proposed: 0, todo: 2, inProgress: 0, done: 1, cancelled: 1, ready: 2, blocked: 0 } };
    const index = buildGraphIndex(graph);
    expect(projectTaskScope(index, 'b')).toEqual({ chains: [{ representativeId: 'root', memberIds: ['child'] }], standaloneIds: ['alone'], taskIds: ['child', 'alone'], progress: { total: 2, done: 0, cancelled: 1, unfinished: 1 } });
    expect(projectTaskScope(index, null)).toEqual({ chains: [{ representativeId: 'root', memberIds: ['unowned'] }], standaloneIds: [], taskIds: ['unowned'], progress: { total: 1, done: 0, cancelled: 0, unfinished: 1 } });
    expect(projectTaskScope(index, 'empty').progress).toEqual({ total: 0, done: 0, cancelled: 0, unfinished: 0 });
  });
});
