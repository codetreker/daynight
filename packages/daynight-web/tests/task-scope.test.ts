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

it('retains snapshot order and complete graph classification within a Goal', () => {
  const root = { ...task('root', 'outside', 'in_progress'), createdAt: '2026-10-20T12:00:00.000000001Z' };
  const scoped = task('scoped', 'a', 'cancelled', ['root']);
  const branch = task('branch', 'a', 'done', ['root']);
  const chain2 = { ...task('chain2', 'a', 'todo'), createdAt: '2026-10-20T12:00:00.000000002Z' };
  const chain2child = task('chain2child', 'outside', 'in_progress', ['chain2']);
  const aloneOld = { ...task('alone-old', 'a', 'todo'), createdAt: '2026-10-20T12:00:00.000000001Z' };
  const aloneNew = { ...task('alone-new', 'a', 'todo'), createdAt: '2026-10-20T12:00:00.000000002Z' };
  const proposal = task('proposal', 'a', 'proposed');
  const all = [root, scoped, branch, chain2, chain2child, aloneOld, aloneNew, proposal];
  const graph: TaskGraph = { observedAt: time, project: { id: 'p', name: 'p', repoUrl: 'https://example.test/p', ownership: { teamId: 't', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time }, tasks: all,
    summary: { total: all.length, proposed: 1, todo: 3, inProgress: 2, done: 1, cancelled: 1, ready: 3, blocked: 0 } };
  const index = buildGraphIndex(graph);
  const result = projectTaskScope(index, 'a');
  expect(result.taskIds).toEqual(['scoped', 'branch', 'chain2', 'alone-old', 'alone-new', 'proposal']);
  expect(result.standaloneIds).toEqual(['alone-old', 'alone-new', 'proposal']);
  expect(result.chains).toEqual(expect.arrayContaining([{ representativeId: 'chain2', memberIds: ['chain2'] }, { representativeId: 'root', memberIds: ['scoped', 'branch'] }]));
  expect(result.progress).toEqual({ total: 6, done: 1, cancelled: 1, unfinished: 4 });
});

it('retains all five states and deduplicates a converging chain with external context', async () => {
  const { compareTaskMembers } = await import('../src/features/projects/task-order');
  const old = '2025-01-01T00:00:00.000000001Z';
  const recent = '2025-01-01T00:00:00.000000002Z';
  const all = [task('external', null, 'todo'), task('one', 'a', 'proposed'), task('two', 'a', 'todo'),
    { ...task('join', 'a', 'in_progress', ['one', 'two', 'external']), externalDependsOn: ['external'] },
    { ...task('done', 'a', 'done', ['join']), completedAt: old },
    { ...task('cancelled', 'a', 'cancelled', ['join']), cancelledAt: recent }, task('alone', 'a', 'todo')];
  const graph: TaskGraph = { observedAt: time, project: { id: 'p', name: 'p', repoUrl: 'https://example.test/p', ownership: { teamId: 't', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time }, tasks: all,
    summary: { total: all.length, proposed: 1, todo: 3, inProgress: 1, done: 1, cancelled: 1, ready: 3, blocked: 0 } };
  const index = buildGraphIndex(graph);
  const result = projectTaskScope(index, 'a');
  expect(result.standaloneIds).toEqual(['alone']);
  expect(result.chains).toHaveLength(1);
  const members = result.chains[0]!.memberIds;
  expect(new Set(members)).toEqual(new Set(['one', 'two', 'join', 'done', 'cancelled']));
  expect(members).toHaveLength(5);
  expect(members.map(id => index.nodes.get(id)!).toSorted(compareTaskMembers).map(item => item.id)).toEqual(['join', 'two', 'one', 'cancelled', 'done']);
  expect(result.progress).toEqual({ total: 6, done: 1, cancelled: 1, unfinished: 4 });
  expect(result.taskIds.map(id => index.nodes.get(id)!).toSorted(compareTaskMembers).map(item => item.id)).toEqual(['join', 'two', 'alone', 'one', 'cancelled', 'done']);
});
