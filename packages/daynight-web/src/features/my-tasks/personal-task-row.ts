import type { PersonalTaskItem } from '../../api/personal-tasks';
import type { TaskRowModel, TaskRowSession } from '../task-row/model';

export const personalTaskRowModel = (item: PersonalTaskItem, principalId: string, session: TaskRowSession): TaskRowModel => {
  const { task } = item;
  return {
    id: task.id, title: task.title, createdAt: task.createdAt, status: task.status, assignedTo: principalId,
    tags: task.tags, allowAgents: task.allowAgents, requiredPlatform: task.requiredPlatform,
    ready: task.ready, blocked: task.blockedBy.length > 0, startedAt: task.startedAt,
    completedAt: null, cancelledAt: null, paused: task.paused, session,
    worker: task.worker === null ? { kind: 'none' }
      : { kind: task.worker.state === 'active' ? 'active' : 'historical', name: task.worker.machine.name },
  };
};
