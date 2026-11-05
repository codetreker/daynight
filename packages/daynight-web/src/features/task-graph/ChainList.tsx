import { SessionStatus } from "../task-session-summary/SessionStatus";
import { useTaskSessionSummary, useChainSessionSummary, useSessionChainVisibility } from "../task-session-summary/TaskSessionSummaryProvider";
import { TaskPausedBadge, TaskPauseCount, usePausedTaskIds, useTaskPaused } from "../task-pause/TaskPause";
import { ListPagination } from "../projects/ListPagination";
import type { PaginationState } from "../projects/usePagination";
import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphTask, WorkerClaim } from '../../api/types';
import { compareTaskStatus } from '../projects/task-order';
import { timestampNanoseconds } from '../projects/task-visibility';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskExecution } from '../task-execution/TaskExecutionClock';
import { TaskExecutionDuration } from '../task-execution/TaskExecutionPresentation';
import type { GraphIndex } from './model';
import { TaskChainDialog } from './TaskChainDialog';
import { TaskAgentPermissionBadge } from '../task-detail/TaskAgentPermissionBadge';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
import '../../styles/graph.css';
import '../../styles/task-status-rows.css';

type ChainListProps = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, "state" | "machine">>;
  readonly representativeIds: readonly string[];
  readonly allRepresentativeIds: readonly string[];
  readonly openChainId: string | null;
  readonly onOpenChain: (id: string, trigger: HTMLElement) => void;
  readonly onCloseChain: () => void;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
  readonly pagination?: PaginationState;
};

type ChainRowProps = Pick<ChainListProps, 'projectId' | 'index' | 'workerMachines' | 'onOpenChain' | 'onOpenTask' | 'onOpenSession'> & {
  readonly rootId: string;
  readonly open: boolean;
};

type GoalTaskRowProps = {
  readonly projectId: string;
  readonly task: GraphTask;
  readonly rootId: string;
  readonly workerMachine: Pick<WorkerClaim, "state" | "machine"> | undefined;
  readonly onOpenTask: ChainListProps['onOpenTask'];
  readonly onOpenSession?: ChainListProps['onOpenSession'];
};

const GoalTaskRow = memo(({ projectId, task, rootId, workerMachine, onOpenTask, onOpenSession }: GoalTaskRowProps) => {
  const { messages: { graph, workspace: { project } } } = useI18n();
  const execution = useTaskExecution(task);
  const paused = useTaskPaused(task.id);
  const labelId = useId();
  const summary = useTaskSessionSummary(task.id);
  const session = task.status === 'in_progress' ? summary : null;
  const title = `${task.titlePreview}${task.titleTruncated ? '…' : ''}`;
  return <li>
    <div className="goal-task-row task-status-surface" data-task-status={task.status}>
      <button className="goal-task-main" data-task-status={task.status} id={`chain-task-${rootId}-${task.id}`} aria-labelledby={`${labelId}-title ${labelId}-assignee ${labelId}-permission ${labelId}-machine${paused ? ` ${labelId}-paused` : ''} ${labelId}-status${task.ready ? ` ${labelId}-ready` : ''}${task.blockedBy.length > 0 ? ` ${labelId}-blocked` : ''}`} type="button" onClick={(event) => onOpenTask(task.id, event.currentTarget)} aria-haspopup="dialog">
        <span className={`goal-task-dot graph-status-${task.status}`} aria-hidden="true" />
        <span className="root-heading"><span className="root-title" id={`${labelId}-title`}>{task.titlePreview}{task.titleTruncated ? '…' : ''}</span>{execution !== null && <span className="goal-task-execution" aria-hidden="true"><TaskExecutionDuration execution={execution} tooltip="duration" /></span>}<span className="task-assignee-row-meta"><span id={`${labelId}-assignee`} className="goal-task-assignee"><TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} /></span><span id={`${labelId}-permission`}><TaskAgentPermissionBadge allowAgents={task.allowAgents} /></span><span id={`${labelId}-machine`} className="goal-task-machine">{workerMachine === undefined ? graph.noMachineRecord : workerMachine.state === "active" ? graph.claimMachine({ name: workerMachine.machine.name }) : graph.recordedMachine({ name: workerMachine.machine.name })}</span></span></span>
      </button>
      <span className="goal-task-status">{paused && <span id={`${labelId}-paused`}><TaskPausedBadge /></span>}<SessionStatus statusId={`${labelId}-status`} title={title} status={task.status} indicator={session?.indicator ?? null}
        {...(session !== null && onOpenSession !== undefined ? { onActivate: (event) => onOpenSession(task.id, event.currentTarget) } : {})} />{task.ready && <span id={`${labelId}-ready`} className="task-ready">{project.ready}</span>}{task.blockedBy.length > 0 && <span id={`${labelId}-blocked`} className="graph-blocked-badge">{project.blocked}</span>}</span>
      <svg className="goal-task-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
    </div>
  </li>;
});

const ChainRow = memo(({ projectId, index, workerMachines, rootId, open, onOpenChain, onOpenTask, onOpenSession }: ChainRowProps) => {
  const { messages: { graph: m } } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const task = index.nodes.get(rootId)!;
  const component = index.components.get(rootId)!;
  const progress = component.progress;
  const sessionIndicator = useChainSessionSummary(component.memberIds);
  const observeVisibility = useSessionChainVisibility(rootId, component.memberIds);
  const pausedTaskIds = usePausedTaskIds();
  const pausedCount = [...component.memberIds].filter((id) => pausedTaskIds.has(id)).length;
  const inProgressCount = [...component.memberIds].filter((id) => index.nodes.get(id)!.status === 'in_progress').length;
  const title = `${task.titlePreview}${task.titleTruncated ? '…' : ''}`;
  const members = useMemo(() => {
    const memberIds = index.components.get(rootId)!.memberIds;
    return [...index.nodes.values()].filter((node) => node.id !== rootId && memberIds.has(node.id))
      .toSorted((left, right) => {
        const status = compareTaskStatus(left.status, right.status);
        if (status !== 0 || left.status !== 'done') return status;
        if (left.completedAt === null) return right.completedAt === null ? 0 : 1;
        if (right.completedAt === null) return -1;
        const leftTime = timestampNanoseconds(left.completedAt);
        const rightTime = timestampNanoseconds(right.completedAt);
        return leftTime > rightTime ? -1 : leftTime < rightTime ? 1 : 0;
      });
  }, [index, rootId]);
  return <li ref={observeVisibility} className="root-row goal-row" data-chain-id={rootId} data-task-status={progress.status}>
    <div className="goal-header task-status-surface" data-task-status={progress.status}>
      <button className="root-toggle goal-toggle" type="button" id={`task-root-${rootId}`} aria-expanded={expanded}
        aria-controls={`goal-children-${rootId}`} onClick={() => setExpanded((value) => !value)}>
        <svg className={`goal-disclosure${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        <span className="root-heading">
          <span className="goal-title-line"><span className="root-title">{title}</span><span className="goal-in-progress">{m.inProgressCount({ count: inProgressCount })}</span><TaskPauseCount count={pausedCount} />{pausedTaskIds.has(rootId) && <TaskPausedBadge />}</span>
          <span className="task-assignee-row-meta"><TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} /></span>
        </span>
        <span className="root-progress"><span className="root-progress-label">{m.progress({ done: progress.done, total: progress.total })}</span><span className="root-progress-track" aria-hidden="true"><i style={{ width: `${progress.done / progress.total * 100}%` }} /></span></span>
      </button>
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
        <button className="goal-detail-link" type="button" aria-haspopup="dialog" aria-label={m.goalDetailsLabel({ title })} onClick={(event) => onOpenTask(rootId, event.currentTarget)}>{m.goalDetails}</button>
      </div>
      <ul className="goal-task-list">{members.map((member) => <GoalTaskRow key={member.id} projectId={projectId} task={member} rootId={rootId} workerMachine={workerMachines.get(member.id)} onOpenTask={onOpenTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />)}</ul>
    </div>
  </li>;
});

const focusAvailable = (element: HTMLElement | null | undefined) => {
  if (element == null || !element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  element.focus({ preventScroll: true });
  return true;
};

export const ChainList = ({ projectId, index, workerMachines, representativeIds, allRepresentativeIds, openChainId, onOpenChain, onCloseChain, onOpenTask, onOpenSession, pagination }: ChainListProps) => {
  const { messages: { graph: m, assignment } } = useI18n();
  const container = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  const focusedChain = useRef<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const openedTask = useRef<string | null>(null);
  const state = useRef({ index, representativeIds });
  state.current = { index, representativeIds };
  const openChain = useCallback((id: string, trigger: HTMLElement) => {
    opener.current = trigger;
    openedTask.current = id;
    onOpenChain(id, trigger);
  }, [onOpenChain]);
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
  const restoreFocus = useCallback(() => {
    if (!focusAvailable(opener.current)) restoreListFocus(openedTask.current);
  }, [restoreListFocus]);
  useLayoutEffect(() => {
    if (openChainId !== null || focusedControl.current === null || focusedControl.current.isConnected || document.activeElement !== document.body) return;
    restoreListFocus(focusedChain.current);
  }, [index, openChainId, representativeIds, restoreListFocus]);
  return <section id="project-chain-list" aria-label={m.chainList} ref={container} tabIndex={-1} onFocusCapture={(event) => {
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
        : <ul className="root-list">{representativeIds.map((rootId) => <ChainRow key={rootId} projectId={projectId} index={index} workerMachines={workerMachines} rootId={rootId} open={openChainId === rootId} onOpenChain={openChain} onOpenTask={onOpenTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />)}</ul>}
    {pagination !== undefined && <ListPagination label={m.chainList} {...pagination} />}
    {openChainId !== null && <TaskChainDialog index={index} rootId={openChainId} onOpenTask={onOpenTask} onClose={onCloseChain} onRestoreFocus={restoreFocus} />}
  </section>;
};
