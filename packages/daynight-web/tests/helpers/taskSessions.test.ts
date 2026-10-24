import { afterEach, expect, it } from 'vitest';
import { detailFixture } from './taskDetail';
import { createTaskSessionWorld } from './taskSessions';

const projectId = '00000000-0000-4000-8000-000000000100';
const taskId = '00000000-0000-4000-8000-000000000001';
const dependencyId = '00000000-0000-4000-8000-000000000002';
const worlds: ReturnType<typeof createTaskSessionWorld>[] = [];
const world = () => { const current = createTaskSessionWorld(); worlds.push(current); return current; };
afterEach(() => { for (const current of worlds.splice(0)) current.dispose(); });

it('admits exact own versions and derives dependency state from the explicitly synchronized world', async () => {
  const current = world();
  const dependency = detailFixture(projectId, dependencyId, { status: 'done', version: 9_007_199_254_740_993n });
  const dependent = detailFixture(projectId, taskId, { dependsOn: [dependencyId], version: 7n });
  await current.sync([dependency, dependent]);
  expect(current.node(projectId, taskId).ready).toBe(true);
  await current.sync([{ ...dependency, status: 'todo', version: dependency.version + 1n }]);
  expect(current.node(projectId, taskId).blockedBy).toEqual([dependencyId]);
  expect(current.scope.getSummaryVersion(projectId, taskId)).toBe(7n);
  expect(current.scope.getSummaryVersion(projectId, dependencyId)).toBe(9_007_199_254_740_994n);
});

it('gives independent server worlds their own snapshot epoch in the same user namespace', async () => {
  const first = world();
  await first.sync([detailFixture(projectId, taskId, { version: 10n, status: 'done' })]);
  const epoch = first.scope.getAuthorizedProject(projectId)!.manifest.epoch;
  first.dispose();
  const second = world();
  await second.sync([detailFixture(projectId, taskId, { version: 1n })]);
  expect(second.scope.getSummaryVersion(projectId, taskId)).toBe(1n);
  expect(second.scope.getAuthorizedProject(projectId)!.manifest.epoch).not.toBe(epoch);
});
