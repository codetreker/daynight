import { ListPagination } from "../projects/ListPagination";
import type { PaginationState } from "../projects/usePagination";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GraphTask, TaskStatus } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskExecution } from '../task-execution/TaskExecutionClock';
import { TaskExecutionDuration } from '../task-execution/TaskExecutionPresentation';
import type { GraphIndex } from './model';
import { TaskChainDialog } from './TaskChainDialog';
import '../../styles/graph.css';

const statusOrder: Readonly<Record<TaskStatus, number>> = { in_progress: 0, todo: 1, done: 2 };

type ChainListProps = {
  readonly index: GraphIndex;
  readonly representativeIds: readonly string[];
  readonly allRepresentativeIds: readonly string[];
  readonly openChainId: string | null;
  readonly onOpenChain: (id: string, trigger: HTMLElement) => void;
  readonly onCloseChain: () => void;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly pagination?: PaginationState;
  readonly showAll: boolean;
  readonly onShowAllChange: (show: boolean) => void;
};

type ChainRowProps = Pick<ChainListProps, 'index' | 'onOpenChain' | 'onOpenTask'> & {
  readonly rootId: string;
  readonly open: boolean;
};

type GoalTaskRowProps = {
  readonly task: GraphTask;
  readonly rootId: string;
  readonly onOpenTask: ChainListProps['onOpenTask'];
};

const GoalTaskRow = memo(({ task, rootId, onOpenTask }: GoalTaskRowProps) => {
  const { messages: { common, workspace: { project } } } = useI18n();
  const execution = useTaskExecution(task);
  return <li>
    <button className="goal-task-row" id={`chain-task-${rootId}-${task.id}`} type="button" onClick={(event) => onOpenTask(task.id, event.currentTarget)} aria-haspopup="dialog">
      <span className={`goal-task-dot graph-status-${task.status}`} aria-hidden="true" />
      <span className="root-heading"><span className="root-title">{task.titlePreview}{task.titleTruncated ? '…' : ''}</span>{execution !== null && <span className="goal-task-execution" aria-hidden="true"><TaskExecutionDuration execution={execution} tooltip="duration" /></span>}</span>
      <span className="goal-task-status"><span className={`root-status graph-status-${task.status}`}>{common.status[task.status]}</span>{task.ready && <span className="task-ready">{project.ready}</span>}{task.blockedBy.length > 0 && <span className="graph-blocked-badge">{project.blocked}</span>}</span>
      <svg className="goal-task-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
    </button>
  </li>;
});

const ChainRow = memo(({ index, rootId, open, onOpenChain, onOpenTask }: ChainRowProps) => {
  const { messages: { graph: m, common } } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const task = index.nodes.get(rootId)!;
  const component = index.components.get(rootId)!;
  const progress = component.progress;
  const title = `${task.titlePreview}${task.titleTruncated ? '…' : ''}`;
  const members = useMemo(() => {
    const memberIds = index.components.get(rootId)!.memberIds;
    return [...index.nodes.values()].filter((node) => node.id !== rootId && memberIds.has(node.id))
      .toSorted((left, right) => statusOrder[left.status] - statusOrder[right.status]);
  }, [index, rootId]);
  return <li className="root-row goal-row" data-chain-id={rootId}>
    <div className="goal-header">
      <button className="root-toggle goal-toggle" type="button" id={`task-root-${rootId}`} aria-expanded={expanded}
        aria-controls={`goal-children-${rootId}`} onClick={() => setExpanded((value) => !value)}>
        <svg className={`goal-disclosure${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        <span className="root-heading">
          <span className="goal-eyebrow">{m.goalTitle}</span>
          <span className="root-title">{title}</span>
          <span className="root-meta">{m.rootSummary({ total: progress.total, remaining: progress.total - progress.done })}</span>
        </span>
        <span className="root-progress"><span className="root-progress-label">{m.progress({ done: progress.done, total: progress.total })}</span><span className="root-progress-track" aria-hidden="true"><i style={{ width: `${progress.done / progress.total * 100}%` }} /></span></span>
        <span className={`root-status graph-status-${progress.status}`}>{common.status[progress.status]}</span>
      </button>
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
      <ul className="goal-task-list">{members.map((member) => <GoalTaskRow key={member.id} task={member} rootId={rootId} onOpenTask={onOpenTask} />)}</ul>
    </div>
  </li>;
});

const focusAvailable = (element: HTMLElement | null | undefined) => {
  if (element == null || !element.isConnected || element.closest('[hidden], [inert]') !== null) return false;
  element.focus({ preventScroll: true });
  return true;
};

export const ChainList = ({ index, representativeIds, allRepresentativeIds, openChainId, onOpenChain, onCloseChain, onOpenTask, showAll, onShowAllChange, pagination }: ChainListProps) => {
  const { messages: { graph: m } } = useI18n();
  const checkbox = useRef<HTMLInputElement>(null);
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
    if (focusAvailable(checkbox.current) || focusAvailable(container.current)) return;
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
  const completedCount = useMemo(() => allRepresentativeIds.filter((id) => index.components.get(id)!.progress.status === 'done').length, [index, allRepresentativeIds]);
  return <section id="project-chain-list" aria-label={m.chainList} ref={container} tabIndex={-1} onFocusCapture={(event) => {
    if (event.currentTarget.contains(event.target)) {
      focusedControl.current = event.target;
      const chainId = event.target.closest<HTMLElement>('[data-chain-id]')?.dataset.chainId;
      if (chainId !== undefined) focusedChain.current = chainId;
    }
  }}>
    <div className="task-view-toolbar">
      {allRepresentativeIds.length > 0 && <label className="completed-chain-control"><input ref={checkbox} type="checkbox" checked={showAll} onChange={(event) => { onShowAllChange(event.currentTarget.checked); }} />{m.showAll}</label>}
      <span className="task-view-summary" aria-label={m.chainSummaryLabel({ shown: pagination === undefined ? representativeIds.length : pagination.total, total: allRepresentativeIds.length })}>{m.chainSummary({ shown: pagination === undefined ? representativeIds.length : pagination.total, total: allRepresentativeIds.length })}</span>
    </div>
    <p className="graph-note">{m.chainNote}</p>
    {allRepresentativeIds.length === 0 ? <div className="state-box"><h3>{m.emptyTitle}</h3><p>{m.emptyDescription}</p></div>
      : representativeIds.length === 0 ? <div className="state-box completed-chains-empty"><h3>{m.completedTitle}</h3><p>{m.completedDescription({ count: completedCount })}</p><button className="button" type="button" onClick={() => { checkbox.current!.focus(); onShowAllChange(true); }}>{m.showAll}</button></div>
        : <ul className="root-list">{representativeIds.map((rootId) => <ChainRow key={rootId} index={index} rootId={rootId} open={openChainId === rootId} onOpenChain={openChain} onOpenTask={onOpenTask} />)}</ul>}
    {pagination !== undefined && <ListPagination label={m.chainList} {...pagination} />}
    {openChainId !== null && <TaskChainDialog index={index} rootId={openChainId} onOpenTask={onOpenTask} onClose={onCloseChain} onRestoreFocus={restoreFocus} />}
  </section>;
};
