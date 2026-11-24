import { waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getTask } from '../src/api/client';
import type { TaskDetail } from '../src/api/types';
import { TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { detailFixture, graphFixture } from './helpers/taskDetail';
import { taskSyncFromGraph } from './helpers/taskSync';

vi.mock('../src/api/client', async original => {
  const actual = await original<typeof import('../src/api/client')>();
  const { fixtureTaskEpoch } = await import('./helpers/taskSync');
  const read = vi.fn();
  return { ...actual, getTask: read, getTaskObservation: async (projectId: string, ...args: unknown[]) => ({ detail: await read(projectId, ...args), epoch: fixtureTaskEpoch(projectId) }) };
});
const projectId = '10000000-0000-4000-8000-000000000001';
const target = detailFixture(projectId, '20000000-0000-4000-8000-000000000001');
const sibling = detailFixture(projectId, '20000000-0000-4000-8000-000000000002');
const resources: { dispose: () => void }[] = [];
afterEach(() => { for (const resource of resources) resource.dispose(); resources.length = 0; vi.mocked(getTask).mockReset(); });

it('withdraws a direct detail on committed removal and rejects its earlier successful read without retiring siblings', async () => {
  const world = createTaskSessionWorld(); resources.push(world);
  await world.sync([target, sibling]);
  const sessions = new TaskDetailSessions(world.scope); resources.push(sessions);
  vi.mocked(getTask).mockResolvedValue(target);
  const release = sessions.subscribe(projectId, target.id, () => {}); resources.push({ dispose: release });
  sessions.openDirect(projectId, target.id);
  await waitFor(() => expect(sessions.snapshot(projectId, target.id).status).toBe('ready'));
  let resolve!: (detail: TaskDetail) => void;
  const late = new Promise<TaskDetail>(done => { resolve = done; });
  vi.mocked(getTask).mockReturnValueOnce(late);
  sessions.load(projectId, target.id, 2, 'automatic');
  await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  const generation = world.scope.getHistoryGeneration(projectId);
  const ticket = await world.scope.beginSync(projectId, world.scope.signal);
  const sync = taskSyncFromGraph(graphFixture([sibling]), { epoch: ticket.epoch!, query: { epoch: ticket.epoch! }, versionForTask: () => sibling.version, propertiesForTask: () => sibling.properties });
  await world.scope.applySync(ticket, { ...sync, deletedTaskIds: [target.id] }, world.scope.signal);
  expect(sessions.snapshot(projectId, target.id).status).toBe('deleted');
  expect(world.scope.getHistoryGeneration(projectId)).toBe(generation);
  expect(world.scope.getAuthorizedProject(projectId)?.summaries.has(sibling.id)).toBe(true);
  resolve(target);
  await new Promise(done => setTimeout(done, 0));
  expect(sessions.snapshot(projectId, target.id).detail).toBeNull();
});
