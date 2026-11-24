import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverySnapshot } from '../src/subtask-compat-recovery-snapshot.ts';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const project = id('1'), goal = id('2'), child = id('3'), pending = id('4'), epoch = id('5');
const snapshot = { mode: 'snapshot', epoch, observedAt: '2026-11-24T11:00:00.123456Z', project: { id: project }, tasks: [{ id: pending, type: 'task', parentId: null }, { id: goal, type: 'goal', parentId: null }, { id: child, type: 'task', parentId: goal }] };

test('snapshot evidence requires the complete original visible fixture and Goal relationship', () => {
  assert.deepEqual(recoverySnapshot(snapshot, project, goal, child, pending), { epoch, observedAt: snapshot.observedAt, tasks: [goal, child, pending] });
  for (const invalid of [
    { ...snapshot, mode: 'delta' }, { ...snapshot, epoch: 'invalid' }, { ...snapshot, observedAt: 'invalid' },
    { ...snapshot, project: { id: id('6') } }, { ...snapshot, tasks: snapshot.tasks.slice(1) },
    { ...snapshot, tasks: [...snapshot.tasks, { id: id('6') }] },
    { ...snapshot, tasks: [...snapshot.tasks, snapshot.tasks[0]] },
    { ...snapshot, tasks: snapshot.tasks.map(task => task.id === child ? { ...task, parentId: null } : task) },
  ]) assert.throws(() => recoverySnapshot(invalid, project, goal, child, pending));
});
