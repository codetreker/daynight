import { memo, useCallback, useId, useLayoutEffect, useRef } from 'react';
import { TaskTagList } from '../task-tags/TaskTagList';
import { TagColorFeedback } from '../task-tags/TagColor';
import type { GraphTask, TaskSummary, TaskTag, WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskExecution } from '../task-execution/TaskExecutionClock';
import { completedAtFor } from '../task-completion/model';
import { useCompletionTime } from '../task-completion/useCompletionTime';
import { CompletionTimeLabel } from '../task-completion/CompletionTimeLabel';
import { useCompletionHint } from '../task-completion/useCompletionHint';
import { TaskExecutionDescription, TaskExecutionDuration } from '../task-execution/TaskExecutionPresentation';
import { TaskPausedBadge, useTaskPaused } from '../task-pause/TaskPause';
import { ProjectSessionStatus } from '../task-session-summary/ProjectSessionStatus';
import { useProjectTaskObservation } from '../task-session-summary/ProjectTaskObservationsProvider';
import { TaskAgentPermissionBadge } from '../task-detail/TaskAgentPermissionBadge';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';

type TaskMemberRowProps = {
  readonly projectId: string;
  readonly task: GraphTask;
  readonly title: string;
  readonly summary?: TaskSummary;
  readonly instanceId: string;
  readonly tags?: readonly TaskTag[];
  readonly active?: boolean;
  readonly workerMachine: Pick<WorkerClaim, "state" | "machine"> | undefined;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
};

export const TaskMemberRow = memo(({ projectId, task, title, summary, instanceId, tags, active = true, workerMachine, onOpenTask, onOpenSession }: TaskMemberRowProps) => {
  const { messages: { graph, workspace: { project } } } = useI18n();
  const execution = useTaskExecution(task);
  const paused = useTaskPaused(task.id);
  const completion = useCompletionTime(completedAtFor(task));
  const hint = useCompletionHint(completion);
  const main = useRef<HTMLButtonElement | null>(null);
  const focusedSession = useRef<HTMLElement | null>(null);
  const mainRef = useCallback((element: HTMLButtonElement | null) => {
    main.current = element;
    hint.triggerRef(element);
  }, [hint.triggerRef]);
  useLayoutEffect(() => {
    const control = focusedSession.current;
    if (control === null || control.isConnected) return;
    focusedSession.current = null;
    if (document.activeElement === document.body && main.current?.isConnected && main.current.closest('[hidden], [inert]') === null)
      main.current.focus({ preventScroll: true });
  });
  const labelId = useId();
  const session = useProjectTaskObservation(task, summary);
  return <li onFocusCapture={(event) => {
    focusedSession.current = event.target instanceof HTMLElement && event.target.classList.contains('session-status-action') ? event.target : null;
  }} onBlurCapture={(event) => {
    if (event.relatedTarget !== null) focusedSession.current = null;
  }}>
    <div className="goal-task-row task-status-surface" data-task-status={task.status}>
      <button className="goal-task-main" data-task-status={task.status} id={`chain-task-${instanceId}-${task.id}`} aria-labelledby={`${labelId}-title${tags !== undefined && tags.length > 0 ? ` ${labelId}-tags` : ""} ${labelId}-assignee ${labelId}-permission ${labelId}-machine${paused ? ` ${labelId}-paused` : ''} ${labelId}-status${task.ready ? ` ${labelId}-ready` : ''}${task.blockedBy.length > 0 ? ` ${labelId}-blocked` : ''}`} type="button" ref={mainRef} {...hint.triggerEvents} aria-describedby={[execution === null ? null : `${labelId}-execution`, completion === null ? null : hint.descriptionId].filter(Boolean).join(" ") || undefined} onClick={(event) => { hint.triggerEvents.onClick(); onOpenTask(task.id, event.currentTarget); }} aria-haspopup="dialog">
        <span className={`goal-task-dot graph-status-${task.status}`} aria-hidden="true" />
        <span className="root-heading"><span className="root-title" id={`${labelId}-title`}>{title}</span>{execution !== null && <span className="goal-task-execution" aria-hidden="true"><TaskExecutionDuration execution={execution} tooltip="duration" /></span>}{completion !== null && <CompletionTimeLabel value={completion} {...hint.labelEvents} />}<span className="task-assignee-row-meta"><span id={`${labelId}-assignee`} className="goal-task-assignee"><TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} /></span><span id={`${labelId}-permission`}><TaskAgentPermissionBadge allowAgents={task.allowAgents} /></span><span id={`${labelId}-machine`} className="goal-task-machine">{workerMachine === undefined ? graph.noMachineRecord : workerMachine.state === "active" ? graph.claimMachine({ name: workerMachine.machine.name }) : graph.recordedMachine({ name: workerMachine.machine.name })}</span></span>{tags !== undefined && <TaskTagList projectId={projectId} id={`${labelId}-tags`} tags={tags} active={active} feedback={false} />}</span>
      </button>
      {hint.hint}{execution !== null && <TaskExecutionDescription execution={execution} id={`${labelId}-execution`} />}
      <span className="goal-task-status">{paused && <span id={`${labelId}-paused`}><TaskPausedBadge /></span>}<ProjectSessionStatus statusId={`${labelId}-status`} title={title} status={task.status} observation={session}
        {...(onOpenSession !== undefined ? { onActivate: (event) => onOpenSession(task.id, event.currentTarget) } : {})} />{task.ready && <span id={`${labelId}-ready`} className="task-ready">{project.ready}</span>}{task.blockedBy.length > 0 && <span id={`${labelId}-blocked`} className="graph-blocked-badge">{project.blocked}</span>}</span>
      <svg className="goal-task-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
    </div>
    {active && tags !== undefined && <TagColorFeedback projectId={projectId} ids={tags.map(tag => tag.id)} />}
  </li>;
});
