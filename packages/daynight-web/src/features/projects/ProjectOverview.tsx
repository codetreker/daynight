import { completionProgress } from '../task-graph/completion-progress';
import { TaskPauseCount } from "../task-pause/TaskPause";
import { pausedSummaryTaskIds } from "../task-pause/paused-summary";
import { useId } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import type { OverviewProgress, OverviewProgressCount, OverviewTaskTarget } from "./overview-progress";
import { ListPagination } from "./ListPagination";
import type { PaginationState } from "./usePagination";
import type { GraphSnapshot } from "./useTaskGraph";
import "../../styles/task-status-rows.css";
import { compareTaskStatus } from "./task-order";

export const ProjectOverview = ({ snapshot, progress, pagination, onNavigate, onOpenTask }: {
  readonly snapshot: GraphSnapshot;
  readonly progress: OverviewProgress;
  readonly pagination: PaginationState;
  readonly onNavigate: (target: OverviewTaskTarget) => void;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
}) => {
  const { messages: { workspace: { project: m, sections, overview }, inspection: { pause }, common }, format } = useI18n();
  const summary = snapshot.graph.summary;
  const pausedSummaryIds = pausedSummaryTaskIds(snapshot.graph.tasks, snapshot.pausedTaskIds);
  const pausedTask = snapshot.graph.tasks.find((task) => pausedSummaryIds.has(task.id));
  const headingId = useId();
  const completion = summary.total === 0 ? 0 : Math.round((summary.done + summary.cancelled) * 100 / summary.total);
  const row = (title: string, value: OverviewProgressCount, target: OverviewTaskTarget, scope?: string) => {
    const display = completionProgress(value);
    return <button className="overview-progress-row task-status-surface" data-task-status={value.status} type="button"
    aria-label={overview.rowLabel({ title, done: display.displayDone, total: display.displayTotal, percent: display.percent })} onClick={() => onNavigate(target)}>
    <span className="overview-progress-title">{title}{scope !== undefined && <span className="overview-progress-scope">{scope}</span>}</span>
    <span className="overview-progress-metric"><span>{format.number(display.displayDone)} / {format.number(display.displayTotal)}</span>
      <span className="root-progress-track" aria-hidden="true"><i style={{ width: `${value.percent}%` }} /></span></span>
    <span className="overview-progress-percent">{format.number(value.percent)}%</span>
    <svg className="overview-progress-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
  </button>;
  };
  const rows = progress.chains.map((chain) => ({ status: chain.status,
    element: <li key={chain.taskId}>{row(`${chain.title}${chain.titleTruncated ? "…" : ""}`, chain, { kind: "chain", taskId: chain.taskId })}</li> }));
  if (progress.standalone !== null) rows.push({ status: progress.standalone.status,
    element: <li key="standalone">{row(overview.standalone, progress.standalone, { kind: "standalone" }, overview.standaloneScope)}</li> });
  const orderedRows = rows.toSorted((left, right) => compareTaskStatus(left.status, right.status));
  return <>
    <div className="project-section-heading"><h2>{sections.overview}</h2><p title={sections.overviewDescription}>{sections.overviewDescription}</p>{pausedTask !== undefined && <TaskPauseCount count={pausedSummaryIds.size} label={pause.openTask(pausedTask.titlePreview)} onClick={(event) => onOpenTask(pausedTask.id, event.currentTarget)} />}</div>
    <section className="stats" aria-label={m.statistics}>
      <div className="stat"><p className="stat-label">{m.totalTasks}</p><p className="stat-number">{format.number(summary.total)}</p><p className="stat-foot">{m.uniqueTasks}</p></div>
      <div className="stat done"><p className="stat-label">{summary.cancelled === 0 ? common.status.done : common.status.ended}</p><p className="stat-number">{format.number(summary.done + summary.cancelled)}</p><p className="stat-foot">{summary.cancelled === 0 ? m.completion({ percent: completion }) : m.endedBreakdown({ done: summary.done, cancelled: summary.cancelled, percent: completion })}</p></div>
      <div className="stat proposed"><p className="stat-label">{common.status.proposed}</p><p className="stat-number">{format.number(summary.proposed)}</p></div>
      <div className="stat"><p className="stat-label">{common.status.todo}</p><p className="stat-number">{format.number(summary.todo)}</p><p className="stat-foot">{m.waiting}</p></div>
      <div className="stat active"><p className="stat-label">{common.status.in_progress}</p><p className="stat-number">{format.number(summary.inProgress)}</p><p className="stat-foot">{m.advancing}</p></div>
      <div className="stat ready"><p className="stat-label">{m.ready}</p><p className="stat-number">{format.number(summary.ready)}</p><p className="stat-foot">{m.todoSubset}</p></div>
      <div className="stat blocked"><p className="stat-label">{m.blocked}</p><p className="stat-number">{format.number(summary.blocked)}</p><p className="stat-foot">{m.todoSubset}</p></div>
    </section>
    <section className="overview-progress" id="project-overview-progress" tabIndex={-1} aria-labelledby={headingId}>
      <h2 id={headingId}>{overview.heading}</h2>
      {rows.length > 0 ? <ul className="overview-progress-list">{orderedRows.slice(pagination.start - 1, pagination.end).map(({ element }) => element)}</ul> : <div className="state-box overview-progress-empty"><h3>{summary.total === 0 ? m.empty : overview.allCompleted}</h3><p>{summary.total === 0 ? m.emptyDetail : overview.allCompletedDetail}</p></div>}
      <ListPagination label={overview.heading} {...pagination} />
    </section>
  </>;
};
