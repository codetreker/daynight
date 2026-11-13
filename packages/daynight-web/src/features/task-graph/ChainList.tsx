import { completionProgress } from './completion-progress';
import { latestScopedCompletion, completedAtFor } from "../task-completion/model";
import { useCompletionTime } from "../task-completion/useCompletionTime";
import { CompletionTimeLabel } from "../task-completion/CompletionTimeLabel";
import { useCompletionHint } from "../task-completion/useCompletionHint";
import { ChainCompletionTime } from "../task-completion/ChainCompletionTime";
import { SessionStatus } from "../task-session-summary/SessionStatus";
import { useChainSessionSummary, useSessionChainVisibility } from "../task-session-summary/TaskSessionSummaryProvider";
import { TaskPausedBadge, TaskPauseCount, usePausedTaskIds } from "../task-pause/TaskPause";
import { pausedSummaryTaskIds } from "../task-pause/paused-summary";
import { ListPagination } from "../projects/ListPagination";
import type { PaginationState } from "../projects/usePagination";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { TaskSummary, WorkerClaim } from '../../api/types';
import { compareTaskMembers } from '../projects/task-order';
import { useI18n } from '../../i18n/LocaleProvider';
import type { GraphIndex } from './model';
import { ProjectListGraphHost } from './ProjectListGraphHost';
import type { ProjectGraphTarget } from '../projects/project-graph-target';
import { TaskMemberRow } from './TaskMemberRow';
import { ActiveWorkerIndicator } from './ActiveWorkerIndicator';
import { ScopedTaskChainRow } from './ScopedTaskChainRow';
import { scopedChainProgress } from './scoped-chain-progress';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import '../../styles/graph.css';
import '../../styles/task-status-rows.css';

type ChainListProps = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, "state" | "machine">>;
  readonly representativeIds: readonly string[];
  readonly allRepresentativeIds: readonly string[];
  readonly scopedMembers?: ReadonlyMap<string, readonly string[]>;
  readonly revealTaskId?: string | null;
  readonly onRevealed?: (id: string) => void;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly onGraphRootChange?: (element: HTMLElement | null) => void;
  readonly summaries?: ReadonlyMap<string, TaskSummary>;
  readonly openGraphTarget: ProjectGraphTarget | null;
  readonly onOpenChain: (id: string, trigger: HTMLElement) => void;
  readonly onCloseChain: () => void;
  readonly onRestoreGraphFocus?: () => void;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
  readonly pagination?: PaginationState;
};

type ChainRowProps = Pick<ChainListProps, 'projectId' | 'index' | 'workerMachines' | 'onOpenChain' | 'onOpenTask' | 'onOpenSession'> & {
  readonly rootId: string;
  readonly open: boolean;
  readonly revealTaskId?: string | null;
  readonly onRevealed?: (id: string) => void;
};

const RepresentativeDetail = ({ task, rootId, title, onOpenTask }: { readonly task: import('../../api/types').GraphTask; readonly rootId: string; readonly title: string; readonly onOpenTask: (id: string, trigger: HTMLElement) => void }) => {
  const { messages: { graph: m } } = useI18n();
  const completion = useCompletionTime(completedAtFor(task));
  const hint = useCompletionHint(completion);
  return <><button className="goal-detail-link" id={`chain-task-${rootId}-${rootId}`} type="button" aria-haspopup="dialog" aria-label={m.goalDetailsLabel({ title })} aria-describedby={completion === null ? undefined : hint.descriptionId} ref={hint.triggerRef} {...hint.triggerEvents} onClick={(event) => { hint.triggerEvents.onClick(); onOpenTask(rootId, event.currentTarget); }}>{m.goalDetails}{completion !== null && <CompletionTimeLabel value={completion} {...hint.labelEvents} />}</button>{hint.hint}</>;
};

const ChainRow = memo(({ projectId, index, workerMachines, rootId, revealTaskId, onRevealed, open, onOpenChain, onOpenTask, onOpenSession }: ChainRowProps) => {
  const { messages: { graph: m } } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const task = index.nodes.get(rootId)!;
  const component = index.components.get(rootId)!;
  const progress = component.progress;
  const displayProgress = completionProgress(progress);
  const completion = useCompletionTime(latestScopedCompletion(index, [...component.memberIds]));
  const sessionIndicator = useChainSessionSummary(component.memberIds);
  const observeVisibility = useSessionChainVisibility(rootId, component.memberIds);
  const pausedTaskIds = usePausedTaskIds();
  const pausedCount = pausedSummaryTaskIds([...component.memberIds].map((id) => index.nodes.get(id)!), pausedTaskIds).size;
  const inProgressCount = [...component.memberIds].filter((id) => index.nodes.get(id)!.status === 'in_progress').length;
  const title = `${task.titlePreview}${task.titleTruncated ? '…' : ''}`;
  const revealed = useRef<string | null>(null);
  const container = useRef<HTMLLIElement>(null);
  const setContainer = useCallback((element: HTMLLIElement | null) => { container.current = element; observeVisibility(element); }, [observeVisibility]);
  useLayoutEffect(() => {
    if (revealTaskId == null) { revealed.current = null; return; }
    if (revealed.current === revealTaskId || !component.memberIds.has(revealTaskId)) return;
    if (!expanded) { setExpanded(true); return; }
    const row = container.current?.querySelector<HTMLElement>(`[id="chain-task-${rootId}-${revealTaskId}"]`);
    if (row != null) { row.focus({ preventScroll: true }); revealed.current = revealTaskId; onRevealed?.(revealTaskId); }
  }, [expanded, component, revealTaskId, rootId, onRevealed]);
  const members = useMemo(() => {
    const memberIds = index.components.get(rootId)!.memberIds;
    return [...index.nodes.values()].filter((node) => node.id !== rootId && memberIds.has(node.id))
      .toSorted(compareTaskMembers);
  }, [index, rootId]);
  return <li ref={setContainer} className="root-row goal-row" data-chain-id={rootId} data-task-status={progress.status}>
    <div className="goal-header task-status-surface" data-task-status={progress.status}>
      <div className="chain-summary">
        <button className="root-toggle goal-toggle" type="button" id={`task-root-${rootId}`} aria-expanded={expanded}
          aria-controls={`goal-children-${rootId}`} aria-labelledby={`chain-title-${rootId} chain-meta-${rootId} chain-progress-${rootId}`} onClick={() => setExpanded((value) => !value)}>
          <svg className={`goal-disclosure${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          <span className="goal-title-line" id={`chain-title-${rootId}`}><span className="root-title">{title}</span><span className="goal-in-progress">{m.inProgressCount({ count: inProgressCount })}</span><TaskPauseCount count={pausedCount} />{pausedTaskIds.has(rootId) && <TaskPausedBadge />}</span>
        </button>
        <div className="task-assignee-row-meta chain-summary-meta"><span className="chain-summary-context" id={`chain-meta-${rootId}`}><TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} /><ActiveWorkerIndicator memberIds={component.memberIds} workerMachines={workerMachines} /></span><ChainCompletionTime value={completion} title={title} /></div>
      </div>
      <span className="root-progress" id={`chain-progress-${rootId}`}><span className="root-progress-label">{m.progress({ done: displayProgress.displayDone, total: displayProgress.displayTotal })}</span><span className="root-progress-track" aria-hidden="true"><i style={{ width: `${displayProgress.widthPercent}%` }} /></span></span>
      <SessionStatus title={title} status={progress.status} indicator={sessionIndicator} chain expanded={expanded} controls={`goal-children-${rootId}`}
        {...(sessionIndicator === null ? {} : { onActivate: () => setExpanded(true) })} />
      <button className="button goal-graph-button" type="button" id={`task-chain-graph-${rootId}`} aria-label={m.viewDependenciesLabel({ title })} aria-haspopup="dialog" aria-controls={open ? `task-graph-${rootId}` : undefined}
        onClick={(event) => onOpenChain(rootId, event.currentTarget)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="15" y="15" width="6" height="6" rx="1.4" /><path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" /></svg>
        {m.viewDependencies}
      </button>
    </div>
    <div id={`goal-children-${rootId}`} hidden={!expanded} className="goal-children">
      <div className="goal-children-heading"><span>{m.childTasks({ count: members.length })}</span>
        <RepresentativeDetail task={task} rootId={rootId} title={title} onOpenTask={onOpenTask} />
      </div>
      <ul className="goal-task-list">{members.map((member) => <TaskMemberRow key={member.id} projectId={projectId} task={member} instanceId={rootId} workerMachine={workerMachines.get(member.id)} onOpenTask={onOpenTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />)}</ul>
    </div>
  </li>;
});

const ScopedChainRow = memo(({ projectId, index, workerMachines, rootId, members, revealTaskId, onRevealed, open, onOpenChain, onOpenTask, onOpenSession }: ChainRowProps & { readonly members: readonly string[] }) => {
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLLIElement>(null);
  const revealed = useRef<string | null>(null);
  const progress = useMemo(() => scopedChainProgress(index, members), [index, members]);
  useLayoutEffect(() => {
    if (revealTaskId == null) { revealed.current = null; return; }
    if (revealed.current === revealTaskId || !members.includes(revealTaskId)) return;
    if (!expanded) { setExpanded(true); return; }
    const row = container.current?.querySelector<HTMLElement>(`[id="chain-task-${rootId}-${revealTaskId}"]`);
    if (row != null) { row.focus({ preventScroll: true }); revealed.current = revealTaskId; onRevealed?.(revealTaskId); }
  }, [expanded, members, revealTaskId, rootId, onRevealed]);
  return <ScopedTaskChainRow ref={container} projectId={projectId} index={index} workerMachines={workerMachines} rootId={rootId} memberIds={members} progress={progress} instanceId={rootId} expanded={expanded} onExpandedChange={setExpanded} open={open} onOpenChain={onOpenChain} onOpenTask={onOpenTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />;
});

const noop = () => {};

const focusAvailable = (element: HTMLElement | null | undefined) => {
  if (element == null || !element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  element.focus({ preventScroll: true });
  return true;
};

export const ChainList = ({ projectId, index, summaries, workerMachines, representativeIds, allRepresentativeIds, scopedMembers, revealTaskId, onRevealed, renderNested, onGraphRootChange, openGraphTarget, onOpenChain, onCloseChain, onRestoreGraphFocus, onOpenTask, onNavigateExternalTask, onOpenSession, pagination }: ChainListProps) => {
  const openChainId = openGraphTarget?.kind === 'chain' ? openGraphTarget.rootId : null;
  const { messages: { graph: m, assignment } } = useI18n();
  const container = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const focusedChain = useRef<string | null>(null);
  const state = useRef({ index, representativeIds });
  state.current = { index, representativeIds };
  const restoreListFocus = useCallback((witness: string | null) => {
    const { index, representativeIds } = state.current;
    const representative = witness === null ? undefined : index.componentByTask.get(witness);
    const target = representative !== undefined && representativeIds.includes(representative) ? representative : representativeIds[0];
    if (target !== undefined && focusAvailable(container.current?.querySelector<HTMLElement>(`#task-root-${target}`))) return;
    if (focusAvailable(container.current)) return;
    const panel = container.current?.closest<HTMLElement>('[role="tabpanel"]');
    const tabId = panel?.getAttribute('aria-labelledby');
    if (tabId !== undefined && tabId !== null) focusAvailable(document.getElementById(tabId));
  }, []);
  useLayoutEffect(() => {
    if (openChainId !== null || focusedControl.current === null || focusedControl.current.isConnected || document.activeElement !== document.body) return;
    restoreListFocus(focusedChain.current);
  }, [index, openChainId, representativeIds, restoreListFocus]);
  return <section id="project-chain-list" data-list-empty={allRepresentativeIds.length === 0} aria-label={m.chainList} ref={container} tabIndex={-1} onFocusCapture={(event) => {
    if (event.currentTarget.contains(event.target)) {
      focusedControl.current = event.target;
      const chainId = event.target.closest<HTMLElement>('[data-chain-id]')?.dataset.chainId;
      if (chainId !== undefined) focusedChain.current = chainId;
    }
  }}>
    <div className="task-view-toolbar">
      <span className="task-view-summary" aria-label={m.chainSummaryLabel({ shown: pagination === undefined ? representativeIds.length : pagination.total, total: allRepresentativeIds.length })}>{m.chainSummary({ shown: pagination === undefined ? representativeIds.length : pagination.total, total: allRepresentativeIds.length })}</span>
    </div>
    {allRepresentativeIds.length === 0 ? <div className="state-box"><h3>{m.emptyTitle}</h3><p>{m.emptyDescription}</p></div>
      : representativeIds.length === 0 ? <div className="state-box"><h3>{assignment.noMatches}</h3></div>
        : <ul className="root-list">{representativeIds.map((rootId) => scopedMembers === undefined || scopedMembers.get(rootId)?.length === index.components.get(rootId)!.memberIds.size
          ? <ChainRow key={rootId} projectId={projectId} index={index} workerMachines={workerMachines} rootId={rootId} {...(revealTaskId === undefined ? {} : { revealTaskId })} {...(onRevealed === undefined ? {} : { onRevealed })} open={openChainId === rootId} onOpenChain={onOpenChain} onOpenTask={onOpenTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />
          : <ScopedChainRow key={rootId} projectId={projectId} index={index} workerMachines={workerMachines} rootId={rootId} members={scopedMembers.get(rootId)!} {...(revealTaskId === undefined ? {} : { revealTaskId })} {...(onRevealed === undefined ? {} : { onRevealed })} open={openChainId === rootId} onOpenChain={onOpenChain} onOpenTask={onOpenTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />)}</ul>}
    {pagination !== undefined && <ListPagination label={m.chainList} {...pagination} />}
    {openGraphTarget !== null && <ProjectListGraphHost projectId={projectId} index={index} {...(summaries === undefined ? {} : { summaries })} target={openGraphTarget} onOpenTask={onOpenTask} {...(onNavigateExternalTask === undefined ? {} : { onNavigateExternalTask })} onOpenChain={onOpenChain} onClose={onCloseChain} onRestoreFocus={onRestoreGraphFocus ?? noop} {...(renderNested === undefined ? {} : { renderNested })} {...(onGraphRootChange === undefined ? {} : { onRootChange: onGraphRootChange })} />}
  </section>;
};
