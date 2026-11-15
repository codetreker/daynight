import type { GraphTask, TaskSummary, TaskTag, WorkerClaim } from '../../api/types';
import { taskDetailUrl } from '../../app/router';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import { useTaskPaused } from '../task-pause/TaskPause';
import { useProjectTaskObservation } from '../task-session-summary/ProjectTaskObservationsProvider';
import type { ProjectTaskObservation } from '../task-session-summary/project-observations';
import { TaskRow, type TaskRowModel } from '../task-row/TaskRow';

type ProjectRowInput = {
  readonly task: GraphTask;
  readonly title: string;
  readonly tags?: readonly TaskTag[];
  readonly workerMachine: Pick<WorkerClaim, 'state' | 'machine'> | undefined;
  readonly hasSummary: boolean;
  readonly paused: boolean;
  readonly session: ProjectTaskObservation | null;
};

export const projectTaskRowModel = ({ task, title, tags, workerMachine, hasSummary, paused, session }: ProjectRowInput): TaskRowModel => ({
  id: task.id, title, createdAt: task.createdAt, status: task.status, assignedTo: task.assignedTo,
  tags: tags ?? 'unknown', allowAgents: task.allowAgents, requiredPlatform: task.requiredPlatform,
  ready: task.ready, blocked: task.blockedBy.length > 0, startedAt: task.startedAt,
  completedAt: task.completedAt, cancelledAt: task.cancelledAt, paused, session,
  worker: workerMachine === undefined ? { kind: hasSummary ? 'none' : 'unknown' }
    : { kind: workerMachine.state === 'active' ? 'active' : 'historical', name: workerMachine.machine.name },
});

export const ProjectTaskRow = ({ projectId, task, title, summary, tags, workerMachine, instanceId, onOpenTask, onOpenSession }: {
  readonly projectId: string;
  readonly task: GraphTask;
  readonly title: string;
  readonly summary?: TaskSummary;
  readonly tags?: readonly TaskTag[];
  readonly workerMachine: Pick<WorkerClaim, 'state' | 'machine'> | undefined;
  readonly instanceId: string;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
}) => {
  const paused = useTaskPaused(task.id);
  const session = useProjectTaskObservation(task, summary);
  const model = projectTaskRowModel({ task, title, ...(tags === undefined ? {} : { tags }), workerMachine, hasSummary: summary !== undefined, paused, session });
  return <TaskRow model={model} href={taskDetailUrl(projectId, task.id, { tab: 'overview', path: null })} instanceId={instanceId}
    assignee={<TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} />} onOpenTask={onOpenTask}
    {...(onOpenSession === undefined ? {} : { onOpenSession })} />;
};
