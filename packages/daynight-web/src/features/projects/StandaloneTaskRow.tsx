import { memo, useCallback, useLayoutEffect, useRef } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { TaskTagList } from "../task-tags/TaskTagList";
import { TagColorFeedback } from "../task-tags/TagColor";
import type { GraphTask, TaskSummary, TaskTag } from "../../api/types";
import { completedAtFor } from "../task-completion/model";
import { useCompletionTime } from "../task-completion/useCompletionTime";
import { CompletionTimeLabel } from "../task-completion/CompletionTimeLabel";
import { useCompletionHint } from "../task-completion/useCompletionHint";
import { TaskPausedBadge, useTaskPaused } from "../task-pause/TaskPause";
import { useTaskExecution } from "../task-execution/TaskExecutionClock";
import { TaskExecutionDescription, TaskExecutionDuration, TaskExecutionWarning } from "../task-execution/TaskExecutionPresentation";
import { TaskPlatformBadge } from "../task-detail/TaskPlatform";
import { TaskAgentPermissionBadge } from "../task-detail/TaskAgentPermissionBadge";
import { ProjectSessionStatus } from "../task-session-summary/ProjectSessionStatus";
import { useProjectTaskObservation } from "../task-session-summary/ProjectTaskObservationsProvider";
import { TaskAssigneeIdentity } from "../task-assignment/TaskAssigneeIdentity";
import "../../styles/graph.css";
import "../../styles/task-status-rows.css";

type StandaloneTaskRowProps = {
  readonly projectId: string;
  readonly task: GraphTask;
  readonly title: string;
  readonly summary?: TaskSummary;
  readonly instanceId: string;
  readonly tags?: readonly TaskTag[];
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
};

export const StandaloneTaskRow = memo(({ projectId, task, title, summary, instanceId, tags, onSelectTask, onOpenSession }: StandaloneTaskRowProps) => {
  const { messages: { workspace: { standalone: m, project }, common }, format } = useI18n();
  const execution = useTaskExecution(task);
  const paused = useTaskPaused(task.id);
  const completion = useCompletionTime(completedAtFor(task));
  const hint = useCompletionHint(completion);
  const descriptionId = `${instanceId}-execution`;
  const session = useProjectTaskObservation(task, summary);
  const main = useRef<HTMLButtonElement | null>(null);
  const focusedSession = useRef<HTMLElement | null>(null);
  const mainRef = useCallback((element: HTMLButtonElement | null) => { main.current = element; hint.triggerRef(element); }, [hint.triggerRef]);
  useLayoutEffect(() => {
    const control = focusedSession.current;
    if (control === null || control.isConnected) return;
    focusedSession.current = null;
    if (document.activeElement === document.body && main.current?.isConnected && main.current.closest('[hidden], [inert]') === null)
      main.current.focus({ preventScroll: true });
  });
  return <li onFocusCapture={(event) => {
    focusedSession.current = event.target instanceof HTMLElement && event.target.classList.contains('session-status-action') ? event.target : null;
  }} onBlurCapture={(event) => { if (event.relatedTarget !== null) focusedSession.current = null; }}><div className="standalone-item"><button className={`standalone-row task-status-surface${execution?.overdue ? " standalone-row-stuck" : ""}`} data-task-status={task.status} id={instanceId} type="button"
    ref={mainRef} {...hint.triggerEvents} aria-describedby={[execution === null ? null : descriptionId, completion === null ? null : hint.descriptionId].filter(Boolean).join(" ") || undefined} onClick={(event) => { hint.triggerEvents.onClick(); onSelectTask(task.id, event.currentTarget); }}>
    <span className="root-heading"><span className="root-title">{title}</span>
      <span className="root-meta"><span className="standalone-task-id">{task.id}</span> · <time dateTime={task.createdAt}>{m.createdOn({ date: format.date(task.createdAt) })}</time>
      <TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} />
      {execution !== null && <span className="standalone-execution" aria-hidden="true"><TaskExecutionDuration execution={execution} />{execution.overdue && <TaskExecutionWarning />}</span>}{completion !== null && <CompletionTimeLabel value={completion} {...hint.labelEvents} />}</span>{tags !== undefined && <TaskTagList projectId={projectId} tags={tags} feedback={false} />}</span>
    <span className="task-row-status">{paused && <TaskPausedBadge />}<TaskAgentPermissionBadge allowAgents={task.allowAgents} /><TaskPlatformBadge requiredPlatform={task.requiredPlatform} /><span className={`root-status graph-status-${task.status}`}>{common.status[task.status]}</span>{task.ready && <span className="task-ready">{project.ready}</span>}{task.blockedBy.length > 0 && <span className="graph-blocked-badge">{project.blocked}</span>}</span>
    <svg className="standalone-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </button>{session !== null && <ProjectSessionStatus title={title} status={task.status} observation={session} showTaskStatus={false}
      {...(onOpenSession !== undefined ? { onActivate: (event) => onOpenSession(task.id, event.currentTarget) } : {})} />}{hint.hint}{execution !== null && <TaskExecutionDescription execution={execution} id={descriptionId} />}</div>{tags !== undefined && <TagColorFeedback projectId={projectId} ids={tags.map(tag => tag.id)} />}</li>;
});
