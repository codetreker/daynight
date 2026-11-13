import { useMemo, useRef, useState } from 'react';
import type { TaskSummary, WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import type { GraphIndex } from '../task-graph/model';
import { completionProgress } from '../task-graph/completion-progress';
import { projectTaskScope } from '../task-graph/scope';
import { TaskMemberRow } from '../task-graph/TaskMemberRow';
import { useSessionChainVisibility } from '../task-session-summary/TaskSessionSummaryProvider';
import { compareTaskMembers } from './task-order';
import { ActiveWorkerIndicator } from '../task-graph/ActiveWorkerIndicator';
import { TaskTagList } from '../task-tags/TaskTagList';
import { completedAtFor } from '../task-completion/model';
import { useCompletionTime } from '../task-completion/useCompletionTime';
import { useCompletionHint } from '../task-completion/useCompletionHint';
import { CompletionTimeLabel } from '../task-completion/CompletionTimeLabel';
import '../../styles/task-status-rows.css';

export const GoalItem = ({ projectId, index, goal, summaries, workerMachines, onOpenGoal, onOpenGoalGraph, onOpenListTask, onOpenSession }: {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly goal: TaskSummary;
  readonly summaries?: ReadonlyMap<string, TaskSummary>;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, 'state' | 'machine'>>;
  readonly onOpenGoal: (id: string, trigger: HTMLElement) => void;
  readonly onOpenGoalGraph: (id: string, trigger: HTMLElement) => void;
  readonly onOpenListTask: (id: string, trigger: HTMLElement, sourceGoalId: string | null) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
}) => {
  const { messages: { workspace: { goals: m }, graph, common } } = useI18n();
  const completion = useCompletionTime(completedAtFor(goal));
  const hint = useCompletionHint(completion);
  const scope = useMemo(() => projectTaskScope(index, goal.id), [index, goal.id]);
  const memberIds = useMemo(() => new Set(scope.taskIds), [scope]);
  const inProgressCount = scope.taskIds.filter((id) => index.nodes.get(id)!.status === 'in_progress').length;
  const tasks = useMemo(() => scope.taskIds.map((id) => index.nodes.get(id)!).toSorted(compareTaskMembers), [scope, index]);
  const visibilityRef = useSessionChainVisibility(`goal-members-${goal.id}`, scope.taskIds);
  const [expanded, setExpanded] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const title = `${goal.titlePreview}${goal.titleTruncated ? '…' : ''}`;
  const childrenId = `project-goal-children-${goal.id}`;
  const { total: count } = scope.progress;
  const progress = completionProgress(scope.progress);
  return <li className="goal-list-card" data-goal-id={goal.id} data-task-status={goal.status}>
    <div className="goal-list-row task-status-surface" data-task-status={goal.status}>
      <button ref={toggle} className="goal-list-toggle" type="button" aria-label={m.toggle({ title, expanded })} aria-expanded={expanded} aria-controls={childrenId} aria-describedby={`project-goal-in-progress-${goal.id} project-goal-assignee-${goal.id} project-goal-worker-${goal.id} project-goal-composition-${goal.id} project-goal-progress-${goal.id} project-goal-status-${goal.id} project-goal-tags-${goal.id}`} onClick={() => {
        if (expanded && content.current?.contains(document.activeElement)) toggle.current?.focus({ preventScroll: true });
        setExpanded(!expanded);
      }}><svg className={`goal-disclosure${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      <span className="goal-list-icon" aria-hidden="true">◎</span>
      <span className="goal-list-main"><span className="goal-title-line"><span className="goal-list-title" id={`project-goal-${goal.id}`}>{title}</span><span className="goal-in-progress" id={`project-goal-in-progress-${goal.id}`}>{graph.inProgressCount({ count: inProgressCount })}</span></span>
        <TaskTagList id={`project-goal-tags-${goal.id}`} tags={goal.tags} /><span className="goal-list-meta"><TaskAssigneeIdentity id={`project-goal-assignee-${goal.id}`} projectId={projectId} assignedTo={goal.assignedTo} /><span id={`project-goal-worker-${goal.id}`}><ActiveWorkerIndicator memberIds={memberIds} workerMachines={workerMachines} /></span><span id={`project-goal-composition-${goal.id}`}>{m.composition({ count })}</span><CompletionTimeLabel value={completion} {...hint.labelEvents} /></span></span>
      <span className="goal-list-progress" id={`project-goal-progress-${goal.id}`}><span>{graph.progress({ done: progress.displayDone, total: progress.displayTotal })}</span><span className="goal-list-track" aria-hidden="true"><i style={{ width: `${progress.widthPercent}%` }} /></span></span>
      <span className={`root-status graph-status-${goal.status}`} id={`project-goal-status-${goal.id}`}>{common.status[goal.status]}</span>
      </button>
      <button className="goal-list-detail" id={`project-goal-detail-${goal.id}`} type="button" aria-haspopup="dialog" aria-label={m.detailsLabel({ title })} title={m.details} ref={hint.triggerRef} {...hint.triggerEvents} aria-describedby={hint.descriptionId} onClick={(event) => { hint.triggerEvents.onClick(); onOpenGoal(goal.id, event.currentTarget); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></svg></button>
      {hint.hint}
      <button className="goal-list-graph" type="button" id={`project-goal-graph-${goal.id}`} aria-haspopup="dialog" aria-label={graph.goalGraphLabel({ title })} title={graph.goalGraph} onClick={(event) => onOpenGoalGraph(goal.id, event.currentTarget)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="15" y="15" width="6" height="6" rx="1.4" /><path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" /></svg></button>
    </div>
    <div id={childrenId} ref={content} hidden={!expanded} className="goal-list-contents">{expanded && <>
      {count === 0 && <p className="goal-list-empty">{m.emptyTasks}</p>}
      {count > 0 && <ul className="goal-task-list" ref={visibilityRef}>{tasks.map((task) => <TaskMemberRow key={task.id} projectId={projectId} task={task} {...(summaries?.get(task.id) === undefined ? {} : { tags: summaries.get(task.id)!.tags })} instanceId={`goal-${goal.id}`} workerMachine={workerMachines.get(task.id)} onOpenTask={(id, trigger) => onOpenListTask(id, trigger, goal.id)} {...(onOpenSession === undefined ? {} : { onOpenSession })} />)}</ul>}
    </>}</div>
  </li>;
};
