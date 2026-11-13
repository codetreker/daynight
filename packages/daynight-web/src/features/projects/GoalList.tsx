import { useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import type { TaskSummary, WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import type { GraphIndex } from '../task-graph/model';
import { ProjectListGraphHost } from '../task-graph/ProjectListGraphHost';
import type { ChainList } from '../task-graph/ChainList';
import { ListPagination } from './ListPagination';
import type { PaginationState } from './usePagination';
import '../../styles/goal-list.css';
import { GoalCreate } from '../goal-detail/GoalCreate';
import { GoalItem } from './GoalItem';

type GraphProps = Pick<ComponentProps<typeof ChainList>, 'summaries' | 'openGraphTarget' | 'onCloseChain' | 'onRestoreGraphFocus' | 'onOpenTask' | 'onNavigateExternalTask' | 'renderNested' | 'onGraphRootChange' | 'onOpenSession'>;

export const GoalList = ({ projectId, index, goals, total, onOpenGoal, onOpenGoalGraph, onOpenGoalGraphTask, graphError, onRefreshGraph, pagination, workerMachines, onOpenListTask, onOpenListChain, summaries, openGraphTarget, onCloseChain, onRestoreGraphFocus, onOpenTask, onNavigateExternalTask, renderNested, onGraphRootChange, onOpenSession }: {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly goals: readonly TaskSummary[];
  readonly total: number;
  readonly onOpenGoal: (id: string, trigger: HTMLElement) => void;
  readonly onOpenGoalGraph: (id: string, trigger: HTMLElement) => void;
  readonly onOpenGoalGraphTask: (id: string, trigger: HTMLElement) => void;
  readonly graphError?: unknown;
  readonly onRefreshGraph?: () => void;
  readonly pagination?: PaginationState;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, 'state' | 'machine'>>;
  readonly onOpenListTask: (id: string, trigger: HTMLElement, sourceGoalId: string | null) => void;
  readonly onOpenListChain: (id: string, trigger: HTMLElement, sourceGoalId: string | null) => void;
} & GraphProps) => {
  const { locale, messages: { workspace: { goals: m }, assignment } } = useI18n();
  const container = useRef<HTMLElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  const focusedGoal = useRef<string | null>(null);
  const [creating, setCreating] = useState(false);
  useLayoutEffect(() => {
    if (focused.current !== null && !focused.current.isConnected && document.activeElement === document.body)
      (Array.from(container.current?.querySelectorAll<HTMLElement>('[data-goal-id]') ?? []).find((item) => item.dataset.goalId === focusedGoal.current)?.querySelector<HTMLElement>('.goal-list-toggle') ?? container.current?.querySelector<HTMLElement>('.goal-list-toggle') ?? container.current)?.focus({ preventScroll: true });
  }, [goals, index]);
  return <section id="project-goal-list" data-list-empty={total === 0} ref={container} tabIndex={-1} aria-label={m.list} onFocusCapture={(event) => { focused.current = event.target; focusedGoal.current = event.target.closest<HTMLElement>('[data-goal-id]')?.dataset.goalId ?? null; }}>
    <div className="task-view-toolbar"><span className="task-view-summary">{m.summary({ shown: pagination?.total ?? goals.length, total })}</span><button className="button primary" type="button" onClick={() => setCreating(true)}>{locale === 'zh-CN' ? '新建 Goal' : 'New Goal'}</button></div>
    {total === 0 ? <div className="state-box"><h3>{m.empty}</h3><p>{m.emptyDetail}</p></div>
      : goals.length === 0 ? <div className="state-box"><h3>{assignment.noMatches}</h3></div>
        : <ul className="goal-list">{goals.map((goal) => <GoalItem key={goal.id} projectId={projectId} index={index} goal={goal} {...(summaries === undefined ? {} : { summaries })} workerMachines={workerMachines} onOpenGoal={onOpenGoal} onOpenGoalGraph={onOpenGoalGraph} onOpenListTask={onOpenListTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />)}</ul>}
    {pagination !== undefined && <ListPagination label={m.list} {...pagination} />}
    {creating && <GoalCreate projectId={projectId} onClose={() => setCreating(false)} onRefreshGraph={onRefreshGraph ?? (() => {})} />}
    {openGraphTarget !== null && <ProjectListGraphHost projectId={projectId} index={index} {...(summaries === undefined ? {} : { summaries })} target={openGraphTarget} onOpenTask={onOpenTask} onOpenGoalTask={onOpenGoalGraphTask} graphError={graphError} {...(onRefreshGraph === undefined ? {} : { onRefreshGraph })} {...(onNavigateExternalTask === undefined ? {} : { onNavigateExternalTask })} onOpenChain={(id, trigger) => onOpenListChain(id, trigger, null)} onClose={onCloseChain} onRestoreFocus={onRestoreGraphFocus ?? (() => {})} {...(renderNested === undefined ? {} : { renderNested })} {...(onGraphRootChange === undefined ? {} : { onRootChange: onGraphRootChange })} />}
  </section>;
};
