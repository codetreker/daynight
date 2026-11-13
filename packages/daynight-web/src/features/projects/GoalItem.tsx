import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TaskSummary, WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import type { GraphIndex } from '../task-graph/model';
import { completionProgress } from '../task-graph/completion-progress';
import { projectTaskScope } from '../task-graph/scope';
import { ScopedTaskChainRow } from '../task-graph/ScopedTaskChainRow';
import { goalListContents } from './goal-list-model';
import { StandaloneTaskRow } from './StandaloneTaskRow';
import { completedAtFor } from '../task-completion/model';
import { useCompletionTime } from '../task-completion/useCompletionTime';
import { useCompletionHint } from '../task-completion/useCompletionHint';
import { CompletionTimeLabel } from '../task-completion/CompletionTimeLabel';
import '../../styles/task-status-rows.css';

export const GoalItem = ({ projectId, index, goal, workerMachines, openChainId, onOpenGoal, onOpenGoalGraph, onOpenListTask, onOpenListChain, onOpenSession }: {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly goal: TaskSummary;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, 'state' | 'machine'>>;
  readonly openChainId: string | null;
  readonly onOpenGoal: (id: string, trigger: HTMLElement) => void;
  readonly onOpenGoalGraph: (id: string, trigger: HTMLElement) => void;
  readonly onOpenListTask: (id: string, trigger: HTMLElement, sourceGoalId: string | null) => void;
  readonly onOpenListChain: (id: string, trigger: HTMLElement, sourceGoalId: string | null) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
}) => {
  const { messages: { workspace: { goals: m }, graph, common } } = useI18n();
  const completion = useCompletionTime(completedAtFor(goal));
  const hint = useCompletionHint(completion);
  const scope = useMemo(() => projectTaskScope(index, goal.id), [index, goal.id]);
  const contents = useMemo(() => goalListContents(scope, index), [scope, index]);
  const [expanded, setExpanded] = useState(false);
  const [expandedChainIds, setExpandedChainIds] = useState<ReadonlySet<string>>(() => new Set());
  const content = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const valid = new Set(contents.chains.map((chain) => chain.representativeId));
    setExpandedChainIds((current) => {
      if ([...current].every((id) => valid.has(id))) return current;
      return new Set([...current].filter((id) => valid.has(id)));
    });
  }, [contents.chains]);
  const title = `${goal.titlePreview}${goal.titleTruncated ? '…' : ''}`;
  const childrenId = `project-goal-children-${goal.id}`;
  const { total: count } = scope.progress;
  const progress = completionProgress(scope.progress);
  return <li className="goal-list-card" data-goal-id={goal.id} data-task-status={goal.status} ref={root}>
    <div className="goal-list-row task-status-surface" data-task-status={goal.status}>
      <button ref={toggle} className="goal-list-toggle" type="button" aria-label={m.toggle({ title, expanded })} aria-expanded={expanded} aria-controls={childrenId} aria-describedby={`project-goal-assignee-${goal.id} project-goal-composition-${goal.id} project-goal-progress-${goal.id} project-goal-status-${goal.id}`} onClick={() => {
        if (expanded && content.current?.contains(document.activeElement)) toggle.current?.focus({ preventScroll: true });
        setExpanded(!expanded);
      }}><svg className={`goal-disclosure${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      <span className="goal-list-icon" aria-hidden="true">◎</span>
      <span className="goal-list-main"><span className="goal-list-title" id={`project-goal-${goal.id}`}>{title}</span>
        <span className="goal-list-meta"><TaskAssigneeIdentity id={`project-goal-assignee-${goal.id}`} projectId={projectId} assignedTo={goal.assignedTo} /><span id={`project-goal-composition-${goal.id}`}>{m.composition({ chains: scope.chains.length, standalone: scope.standaloneIds.length })}</span><CompletionTimeLabel value={completion} {...hint.labelEvents} /></span></span>
      <span className="goal-list-progress" id={`project-goal-progress-${goal.id}`}><span>{graph.progress({ done: progress.displayDone, total: progress.displayTotal })}</span><span className="goal-list-track" aria-hidden="true"><i style={{ width: `${progress.widthPercent}%` }} /></span></span>
      <span className={`root-status graph-status-${goal.status}`} id={`project-goal-status-${goal.id}`}>{common.status[goal.status]}</span>
      </button>
      <button className="goal-list-detail" id={`project-goal-detail-${goal.id}`} type="button" aria-haspopup="dialog" aria-label={m.detailsLabel({ title })} title={m.details} ref={hint.triggerRef} {...hint.triggerEvents} aria-describedby={hint.descriptionId} onClick={(event) => { hint.triggerEvents.onClick(); onOpenGoal(goal.id, event.currentTarget); }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></svg></button>
      {hint.hint}
      <button className="goal-list-graph" type="button" id={`project-goal-graph-${goal.id}`} aria-haspopup="dialog" aria-label={graph.goalGraphLabel({ title })} title={graph.goalGraph} onClick={(event) => onOpenGoalGraph(goal.id, event.currentTarget)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="15" y="15" width="6" height="6" rx="1.4" /><path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" /></svg></button>
    </div>
    <div id={childrenId} ref={content} hidden={!expanded} className="goal-list-contents">{expanded && <>
      {count === 0 && <p className="goal-list-empty">{m.emptyTasks}</p>}
      {contents.standaloneIds.length > 0 && <section aria-label={m.standalone}><h3>{m.standalone} <span>{contents.standaloneIds.length}</span></h3><ul className="standalone-list">{contents.standaloneIds.map((id) => <StandaloneTaskRow key={id} projectId={projectId} task={index.nodes.get(id)!} instanceId={`goal-${goal.id}-task-${id}`} onSelectTask={(taskId, trigger) => onOpenListTask(taskId, trigger, goal.id)} />)}</ul></section>}
      {contents.chains.length > 0 && <section aria-label={m.chains}><h3>{m.chains} <span>{contents.chains.length}</span></h3><ul className="root-list">{contents.chains.map((chain) => {
        const instanceId = `goal-${goal.id}-chain-${chain.representativeId}`;
        return <ScopedTaskChainRow key={chain.representativeId} projectId={projectId} index={index} rootId={chain.representativeId} memberIds={chain.memberIds} progress={chain.progress} workerMachines={workerMachines} instanceId={instanceId} expanded={expandedChainIds.has(chain.representativeId)} onExpandedChange={(value) => {
          if (!value) {
            const children = root.current?.querySelector<HTMLElement>(`[id="goal-children-${instanceId}"]`);
            if (children?.contains(document.activeElement)) root.current?.querySelector<HTMLElement>(`[id="task-root-${instanceId}"]`)?.focus({ preventScroll: true });
          }
          setExpandedChainIds((current) => { const next = new Set(current); if (value) next.add(chain.representativeId); else next.delete(chain.representativeId); return next; });
        }} open={openChainId === chain.representativeId} onOpenChain={(id, trigger) => onOpenListChain(id, trigger, goal.id)} onOpenTask={(id, trigger) => onOpenListTask(id, trigger, goal.id)} {...(onOpenSession === undefined ? {} : { onOpenSession })} />;
      })}</ul></section>}
    </>}</div>
  </li>;
};
