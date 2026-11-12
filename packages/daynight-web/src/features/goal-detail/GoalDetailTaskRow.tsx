import type { GraphTask } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import { CompletionTimeLabel } from '../task-completion/CompletionTimeLabel';
import { completedAtFor } from '../task-completion/model';
import { useCompletionHint } from '../task-completion/useCompletionHint';
import { useCompletionTime } from '../task-completion/useCompletionTime';
import { TaskPausedBadge } from '../task-pause/TaskPause';

export const GoalDetailTaskRow = ({ projectId, task, paused, onSelectTask }: {
  readonly projectId: string;
  readonly task: GraphTask;
  readonly paused: boolean;
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
}) => {
  const { messages } = useI18n();
  const completion = useCompletionTime(completedAtFor(task));
  const hint = useCompletionHint(completion);
  return <li><button type="button" className="goal-detail-task" data-goal-task-id={task.id} ref={hint.triggerRef} {...hint.triggerEvents} aria-describedby={hint.descriptionId} onClick={(event) => { hint.triggerEvents.onClick(); onSelectTask(task.id, event.currentTarget); }}><span className={`goal-detail-dot graph-status-${task.status}`} aria-hidden="true" /><span className="goal-detail-task-title">{task.titlePreview}{task.titleTruncated ? '…' : ''}</span><TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} compact />{paused && <TaskPausedBadge />}<span>{messages.common.status[task.status]}</span><CompletionTimeLabel value={completion} {...hint.labelEvents} /></button>{hint.hint}</li>;
};
