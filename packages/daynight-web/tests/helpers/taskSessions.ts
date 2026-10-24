import type { GraphTask, TaskDetail, TaskGraph } from '../../src/api/types';
import { createTaskCacheScope, type TaskCacheScope } from '../../src/features/task-cache/TaskCacheProvider';
import type { CachedProject } from '../../src/features/task-cache/project-cache';
import { graphFixture } from './taskDetail';
import { taskSyncEpoch, taskSyncFromGraph, TEST_VIEWER_ID } from './taskSync';

export const admitTaskGraph = async (scope: TaskCacheScope, graph: TaskGraph, { versionForTask, epoch = taskSyncEpoch(graph.project.id) }: {
  readonly versionForTask: (task: GraphTask) => bigint;
  readonly epoch?: string;
}): Promise<CachedProject> => {
  const ticket = await scope.beginSync(graph.project.id, scope.signal);
  const sync = taskSyncFromGraph(graph, { epoch, query: ticket.epoch === null ? {} : { epoch: ticket.epoch }, versionForTask });
  return (await scope.applySync(ticket, sync, scope.signal)).project;
};

export const createTaskSessionWorld = ({ viewerId = TEST_VIEWER_ID, onIdentityMismatch = () => { throw new Error('The fixture returned another principal.'); } }: {
  readonly viewerId?: string;
  readonly onIdentityMismatch?: () => void;
} = {}) => {
  const scope = createTaskCacheScope({ userId: viewerId, onIdentityMismatch });
  const projects = new Map<string, { readonly epoch: string; readonly details: Map<string, TaskDetail> }>();
  return {
    scope,
    sync: async (details: readonly TaskDetail[]): Promise<void> => {
      const changedProjects = new Set<string>();
      for (const detail of details) {
        let project = projects.get(detail.projectId);
        if (project === undefined) { project = { epoch: crypto.randomUUID(), details: new Map() }; projects.set(detail.projectId, project); }
        project.details.set(detail.id, detail);
        changedProjects.add(detail.projectId);
      }
      for (const projectId of changedProjects) {
        const project = projects.get(projectId)!;
        await admitTaskGraph(scope, graphFixture([...project.details.values()]), { epoch: project.epoch, versionForTask: (task) => project.details.get(task.id)!.version });
      }
    },
    node: (projectId: string, taskId: string): GraphTask => {
      const node = scope.getAuthorizedProject(projectId)?.index.nodes.get(taskId);
      if (node === undefined) throw new Error(`The fixture has not admitted task ${projectId}/${taskId}.`);
      return node;
    },
    dispose: () => scope.dispose(),
  };
};
