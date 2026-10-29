import { getTaskSync } from '../../src/api/client';
import type { TaskGraph, TaskSync } from '../../src/api/types';
import { projectSummaries } from '../../src/features/task-cache/projection';
import { TEST_VIEWER_ID } from './taskSync';

export const graphFromTaskSync = (sync: TaskSync): TaskGraph => {
  if (sync.mode !== 'snapshot') throw new Error('A complete project graph requires a task-sync snapshot.');
  return projectSummaries(sync.project, sync.tasks, sync.observedAt).graph;
};

export const readProjectGraph = async (projectId: string, signal: AbortSignal): Promise<TaskGraph> =>
  graphFromTaskSync(await getTaskSync(projectId, {}, TEST_VIEWER_ID, signal));
