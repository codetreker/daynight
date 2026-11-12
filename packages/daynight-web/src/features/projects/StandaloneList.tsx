import { TaskPausedBadge, useTaskPaused } from "../task-pause/TaskPause";
import { ListPagination } from "./ListPagination";
import type { PaginationState } from "./usePagination";
import { memo, useId, useLayoutEffect, useRef } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import type { GraphTask } from "../../api/types";
import { useTaskExecution } from "../task-execution/TaskExecutionClock";
import { TaskExecutionDescription, TaskExecutionDuration, TaskExecutionWarning } from "../task-execution/TaskExecutionPresentation";
import type { GraphIndex } from "../task-graph/model";
import { TaskPlatformBadge } from "../task-detail/TaskPlatform";
import { TaskAgentPermissionBadge } from "../task-detail/TaskAgentPermissionBadge";
import { TaskAssigneeIdentity } from "../task-assignment/TaskAssigneeIdentity";
import "../../styles/graph.css";
import "../../styles/task-status-rows.css";

type StandaloneListProps = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly taskIds: readonly string[];
  readonly allTaskIds: readonly string[];
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
  readonly pagination?: PaginationState;
};

const StandaloneRow = memo(({ projectId, task, onSelectTask }: { readonly projectId: string; readonly task: GraphTask; readonly onSelectTask: StandaloneListProps["onSelectTask"] }) => {
  const { messages: { workspace: { standalone: m, project }, common }, format } = useI18n();
  const execution = useTaskExecution(task);
  const paused = useTaskPaused(task.id);
  const descriptionId = useId();
  return <li><button className={`standalone-row task-status-surface${execution?.overdue ? " standalone-row-stuck" : ""}`} data-task-status={task.status} id={`standalone-task-${task.id}`} type="button"
    aria-describedby={execution === null ? undefined : descriptionId} onClick={(event) => { onSelectTask(task.id, event.currentTarget); }}>
    <span className="root-heading"><span className="root-title">{task.titlePreview}{task.titleTruncated ? "…" : ""}</span>
      <span className="root-meta"><span className="standalone-task-id">{task.id}</span> · <time dateTime={task.createdAt}>{m.createdOn({ date: format.date(task.createdAt) })}</time>
      <TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} />
      {execution !== null && <span className="standalone-execution" aria-hidden="true"><TaskExecutionDuration execution={execution} />{execution.overdue && <TaskExecutionWarning />}</span>}</span></span>
    <span className="task-row-status">{paused && <TaskPausedBadge />}<TaskAgentPermissionBadge allowAgents={task.allowAgents} /><TaskPlatformBadge requiredPlatform={task.requiredPlatform} /><span className={`root-status graph-status-${task.status}`}>{common.status[task.status]}</span>{task.ready && <span className="task-ready">{project.ready}</span>}{task.blockedBy.length > 0 && <span className="graph-blocked-badge">{project.blocked}</span>}</span>
    <svg className="standalone-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </button>{execution !== null && <TaskExecutionDescription execution={execution} id={descriptionId} />}</li>;
});

export const StandaloneList = ({ projectId, index, taskIds, allTaskIds, onSelectTask, pagination }: StandaloneListProps) => {
  const { messages: { workspace: { standalone: m }, assignment } } = useI18n();
  const container = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (focusedControl.current !== null && !focusedControl.current.isConnected && document.activeElement === document.body) {
      (container.current?.querySelector<HTMLElement>(".standalone-row") ?? container.current)?.focus({ preventScroll: true });
    }
  }, [taskIds]);
  return (
    <section id="project-standalone-list" data-list-empty={allTaskIds.length === 0} tabIndex={-1} aria-label={m.list} ref={container} onFocusCapture={(event) => { focusedControl.current = event.target; }}>
      <div className="task-view-toolbar">
        <span className="task-view-summary" aria-label={m.summaryLabel({ visible: pagination === undefined ? taskIds.length : pagination.total, total: allTaskIds.length })}>{m.summary({ visible: pagination === undefined ? taskIds.length : pagination.total, total: allTaskIds.length })}</span>
      </div>
      {allTaskIds.length === 0 ? (
        <div className="state-box"><h3>{m.empty}</h3><p>{m.emptyDetail}</p></div>
      ) : taskIds.length === 0 ? (
        <div className="state-box"><h3>{assignment.noMatches}</h3></div>
      ) : (
        <ul className="standalone-list">{taskIds.map((id) => <StandaloneRow key={id} projectId={projectId} task={index.nodes.get(id)!} onSelectTask={onSelectTask} />)}</ul>
      )}
      {pagination !== undefined && <ListPagination label={m.list} {...pagination} />}
    </section>
  );
};
