import { ApiError } from '../../api/client';
import type { TaskDependencyState, TaskDetail, TaskSummary } from '../../api/types';
import { projectSummaries, sameSummary } from '../task-cache/projection';
import type { GraphSnapshot } from './useTaskGraph';

export type CommittedTaskProjection = {
  readonly detail: TaskDetail;
  readonly before: TaskDetail;
  readonly cacheGeneration: string;
  readonly scopeRevision: number;
  readonly historyGeneration: number;
  readonly conflict?: true;
};

const summaryOf = ({ projectId: _projectId, title, description: _description, ready: _ready, blockedBy: _blockedBy, ...summary }: TaskDetail): TaskSummary => {
  const characters = Array.from(title);
  return { ...summary, titlePreview: characters.slice(0, 160).join(''), titleTruncated: characters.length > 160 };
};

// These receipts are a view-only bridge until the versioned sync catches up.
// They never advance the persisted sync watermark or manufacture dependent states.
export const projectCommittedTasks = (snapshot: GraphSnapshot, receipts: ReadonlyMap<string, CommittedTaskProjection>, fence: {
  readonly cacheGeneration: string | null; readonly scopeRevision: number; readonly historyGeneration: number;
}): { readonly snapshot: GraphSnapshot; readonly error: ApiError | null } => {
  let summaries: Map<string, TaskSummary> | null = null;
  const states = new Map<string, TaskDependencyState>();
  for (const node of snapshot.graph.tasks) {
    const summary = snapshot.summaries.get(node.id);
    if (summary !== undefined) states.set(node.id, { taskVersion: summary.version, ready: node.ready, blockedBy: node.blockedBy });
  }
  for (const [id, receipt] of receipts) {
    if (receipt.cacheGeneration !== fence.cacheGeneration || receipt.scopeRevision !== fence.scopeRevision || receipt.historyGeneration !== fence.historyGeneration) continue;
    const current = snapshot.summaries.get(id);
    if (current === undefined || current.type !== receipt.detail.type || current.version > receipt.detail.version) continue;
    if (receipt.conflict) return { snapshot, error: new ApiError('protocol') };
    const received = summaryOf(receipt.detail);
    if (current.version === received.version) {
      if (!sameSummary(current, received)) return { snapshot, error: new ApiError('protocol') };
      continue;
    }
    if (current.version === receipt.before.version && !sameSummary(current, summaryOf(receipt.before))) return { snapshot, error: new ApiError('protocol') };
    if (current.version > receipt.before.version) continue;
    if (received.type === 'task' && (!snapshot.index.nodes.has(id) || received.parentId !== null && snapshot.summaries.get(received.parentId)?.type !== 'goal')) continue;
    summaries ??= new Map(snapshot.summaries);
    summaries.set(id, received);
    if (received.type === 'task') states.set(id, { taskVersion: received.version, ready: receipt.detail.ready, blockedBy: receipt.detail.blockedBy });
  }
  if (summaries === null) return { snapshot, error: null };
  try {
    const projected = projectSummaries(snapshot.graph.project, [...summaries.values()], states, snapshot.graph.observedAt);
    return { snapshot: { ...snapshot, graph: projected.graph, index: projected.index, summaries, pausedTaskIds: projected.pausedTaskIds, workerMachines: projected.workerMachines }, error: null };
  } catch (error) { return { snapshot, error: new ApiError('protocol', null, 'protocol', null, error) }; }
};
