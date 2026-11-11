import { useLayoutEffect, useRef, useState } from 'react';
import type { TaskSummary } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import type { GraphIndex } from '../task-graph/model';
import { projectTaskScope } from '../task-graph/scope';
import { ListPagination } from './ListPagination';
import type { PaginationState } from './usePagination';
import '../../styles/goal-list.css';
import { GoalCreate } from '../goal-detail/GoalCreate';

export const GoalList = ({ projectId, index, goals, total, onOpenGoal, onRefreshGraph, pagination }: {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly goals: readonly TaskSummary[];
  readonly total: number;
  readonly onOpenGoal: (id: string, trigger: HTMLElement) => void;
  readonly onRefreshGraph?: () => void;
  readonly pagination?: PaginationState;
}) => {
  const { locale, messages: { workspace: { goals: m }, graph, common, assignment } } = useI18n();
  const container = useRef<HTMLElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  useLayoutEffect(() => {
    if (focused.current !== null && !focused.current.isConnected && document.activeElement === document.body)
      (container.current?.querySelector<HTMLElement>('.goal-list-row') ?? container.current)?.focus({ preventScroll: true });
  }, [goals]);
  return <section id="project-goal-list" ref={container} tabIndex={-1} aria-label={m.list} onFocusCapture={(event) => { focused.current = event.target; }}>
    <div className="task-view-toolbar"><span className="task-view-summary">{m.summary({ shown: pagination?.total ?? goals.length, total })}</span><button className="button primary" type="button" onClick={() => setCreating(true)}>{locale === 'zh-CN' ? '新建 Goal' : 'New Goal'}</button></div>
    {total === 0 ? <div className="state-box"><h3>{m.empty}</h3><p>{m.emptyDetail}</p></div>
      : goals.length === 0 ? <div className="state-box"><h3>{assignment.noMatches}</h3></div>
        : <ul className="goal-list">{goals.map((goal) => {
          const scope = projectTaskScope(index, goal.id);
          const { total: count, done, cancelled } = scope.progress;
          return <li key={goal.id}><button className="goal-list-row" id={`project-goal-${goal.id}`} type="button" aria-haspopup="dialog" onClick={(event) => onOpenGoal(goal.id, event.currentTarget)}>
            <span className="goal-list-icon" aria-hidden="true">◎</span>
            <span className="goal-list-main"><span className="goal-list-title">{goal.titlePreview}{goal.titleTruncated ? '…' : ''}</span>
              <span className="goal-list-meta"><TaskAssigneeIdentity projectId={projectId} assignedTo={goal.assignedTo} /><span>{m.composition({ chains: scope.chains.length, standalone: scope.standaloneIds.length })}</span></span></span>
            <span className="goal-list-progress"><span>{graph.progress({ done, cancelled, total: count })}</span><span className="goal-list-track" aria-hidden="true"><i style={{ width: `${count === 0 ? 0 : done / count * 100}%` }} /><i className="goal-list-cancelled" style={{ width: `${count === 0 ? 0 : cancelled / count * 100}%` }} /></span></span>
            <span className={`root-status graph-status-${goal.status}`}>{common.status[goal.status]}</span><span aria-hidden="true">›</span>
          </button></li>;
        })}</ul>}
    {pagination !== undefined && <ListPagination label={m.list} {...pagination} />}
    {creating && <GoalCreate projectId={projectId} onClose={() => setCreating(false)} onRefreshGraph={onRefreshGraph ?? (() => {})} />}
  </section>;
};
