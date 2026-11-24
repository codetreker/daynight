import type { TaskDetail } from '../../api/types';
import { readTaskPaused } from '../../api/task-properties';
import { browserNavigation } from '../../app/navigation';
import { taskDetailUrl } from '../../app/router';
import { TaskAssigneeDisplay, TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import { TaskRow, type TaskRowModel } from '../task-row/TaskRow';

export const ordinarySubtaskRowModel = (task: TaskDetail): TaskRowModel => ({
  id: task.id,
  title: task.title,
  createdAt: task.createdAt,
  status: task.status,
  assignedTo: task.assignedTo,
  tags: task.tags,
  allowAgents: task.allowAgents,
  requiredPlatform: task.requiredPlatform,
  ready: task.ready,
  blocked: task.blockedBy.length > 0,
  startedAt: task.startedAt,
  completedAt: task.completedAt,
  cancelledAt: task.cancelledAt,
  paused: readTaskPaused(task.properties) === true,
  worker: { kind: 'unknown' },
  session: null,
});

export const OrdinarySubtaskRow = ({ projectId, parentTaskId, task, active }: {
  readonly projectId: string;
  readonly parentTaskId: string;
  readonly task: TaskDetail;
  readonly active: boolean;
}) => {
  const href = taskDetailUrl(projectId, task.id, { tab: 'overview', path: null });
  return <TaskRow model={ordinarySubtaskRowModel(task)} projectId={projectId} tagsActive={active}
    href={href} instanceId={`ordinary-subtask-${projectId}-${parentTaskId}-${task.id}`}
    assignee={active ? <TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} /> : <TaskAssigneeDisplay assignedTo={task.assignedTo} />}
    onOpenTask={() => browserNavigation().navigate(href)} />;
};
