import '../../styles/task-status-rows.css';
import { TaskPausedBadge, useTaskPaused } from "../task-pause/TaskPause";
import { memo, useCallback, useId, useLayoutEffect, useRef, type FocusEvent, type MouseEvent } from 'react';
import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useTaskExecution } from '../task-execution/TaskExecutionClock';
import { TaskExecutionDescription, TaskExecutionDuration, TaskExecutionWarning, type TaskExecution } from '../task-execution/TaskExecutionPresentation';
import { TaskPlatformBadge } from '../task-detail/TaskPlatform';
import { TaskAgentPermissionBadge } from '../task-detail/TaskAgentPermissionBadge';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskInspectionState } from './inspection';
import type { GraphTask } from '../../api/types';
import type { TaskExpansion, TaskExpansionDirection, TaskExpansions } from './visibility';
import type { CanvasNode, CanvasPoint } from './layout';

export type TaskNodeData = {
  task: GraphTask;
  ownerLabel?: string | null;
  kind: 'main' | 'external';
  center: CanvasPoint;
  size: Pick<CanvasNode, 'width' | 'height'>;
  actions: { readonly kind: 'goal'; readonly onOpenTask: (id: string, trigger: HTMLElement) => void } | {
    readonly kind: 'chain';
    readonly onInspectTask: (id: string) => void;
    readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
    readonly onNavigateExternalTask: (id: string, trigger: HTMLElement) => void;
    readonly onExpandTask: (id: string, direction: TaskExpansionDirection) => void;
    readonly expansions: TaskExpansions;
    readonly revealRequest: number | null;
  };
};

export type TaskFlowNode = Node<TaskNodeData, 'task'>;

const TaskNodeContent = memo(({ task, kind, ownerLabel, execution }: Pick<TaskNodeData, 'task' | 'kind' | 'ownerLabel'> & { readonly execution: TaskExecution | null }) => {
  const { messages: { graph: m, common } } = useI18n();
  const paused = useTaskPaused(task.id);
  const title = `${task.titlePreview}${task.titleTruncated ? '…' : ''}`;
  return <>
    <span className="task-node-meta">
      <span className="task-node-id">{task.id.slice(0, 8)}</span>
      {ownerLabel != null && <span className="task-node-owner" title={ownerLabel}>{ownerLabel}</span>}
      <span className="task-node-meta-labels">{paused && <TaskPausedBadge compact />}<TaskAgentPermissionBadge allowAgents={task.allowAgents} compact /><TaskPlatformBadge requiredPlatform={task.requiredPlatform} compact />{execution?.overdue && <TaskExecutionWarning />}</span>
    </span>
    <span className="task-node-title">{title}</span>
    <span className="task-node-bottom">
      <span className={`graph-status graph-status-${task.status}`}><i aria-hidden="true" />{common.status[task.status]}</span>
      {execution !== null ? <TaskExecutionDuration execution={execution} /> : task.blockedBy.length > 0 && <span className="graph-blocked-badge">{m.blocked}</span>}
    </span>
    {kind === 'external' && <span className="task-external-label">{m.external}</span>}
  </>;
});

const ExpansionControl = ({ direction, expansion, onExpand, onFocus }: { direction: TaskExpansionDirection; expansion: TaskExpansion; onExpand: () => void; onFocus: (event: FocusEvent<HTMLButtonElement>) => void }) => {
  const { messages: { graph: m } } = useI18n();
  if (expansion.ids.length === 0) return <span aria-hidden="true" />;
  const remaining = expansion.totalHidden - expansion.ids.length;
  return <button type="button" className="task-node-expand nodrag nopan" data-direction={direction}
    data-added-tasks={expansion.ids.length} data-added-edges={expansion.addedEdges} data-remaining={remaining}
    aria-label={m.expandLabel({ direction, tasks: expansion.ids.length, edges: expansion.addedEdges, remaining })} onClick={onExpand} onFocus={onFocus}>
    <span>{m.expandTitle({ direction, tasks: expansion.ids.length })}</span>
    <small>{m.expandSummary({ edges: expansion.addedEdges, remaining })}</small>
  </button>;
};

export const TaskNode = memo(({ data }: NodeProps<TaskFlowNode>) => {
  const { messages: { graph: m, common, inspection: { pause } } } = useI18n();
  const { setCenter, getViewport } = useReactFlow();
  const inspection = useTaskInspectionState(data.task.id);
  const paused = useTaskPaused(data.task.id);
  const execution = useTaskExecution(data.task);
  const descriptionId = useId();
  const focusedControl = useRef<HTMLButtonElement | null>(null);
  const recoveringFocus = useRef(false);
  const body = useRef<HTMLButtonElement>(null);
  const revealed = useRef<number | null>(null);
  const actions = data.actions;
  const revealRequest = actions.kind === 'chain' ? actions.revealRequest : null;
  useLayoutEffect(() => {
    if (revealRequest === null || revealRequest === revealed.current) return;
    revealed.current = revealRequest;
    void setCenter(data.center.x, data.center.y, { zoom: getViewport().zoom, duration: 0 });
    body.current!.focus({ preventScroll: true });
  }, [revealRequest, data.center, getViewport, setCenter]);
  useLayoutEffect(() => {
    // Controlled node data commits after the graph owner; restore a removed
    // footer at the task's DOM boundary without changing the viewport.
    if (focusedControl.current !== null && !focusedControl.current.isConnected && document.activeElement === document.body) {
      recoveringFocus.current = true;
      body.current!.focus({ preventScroll: true });
      recoveringFocus.current = false;
    }
  }, [actions]);
  const title = `${data.task.titlePreview}${data.task.titleTruncated ? '…' : ''}`;
  const revealOnFocus = useCallback((event: FocusEvent<HTMLButtonElement>) => {
    focusedControl.current = event.currentTarget;
    if (recoveringFocus.current || !event.currentTarget.matches(':focus-visible')) return;
    const bounds = event.currentTarget.closest('.task-graph-canvas')!.getBoundingClientRect();
    const { x, y, zoom } = getViewport();
    // Native focus can temporarily scroll React Flow's overflow container before
    // its scroll handler resets it. Layout coordinates retain the intended view.
    const left = x + (data.center.x - data.size.width / 2) * zoom;
    const top = y + (data.center.y - data.size.height / 2) * zoom;
    if (left < 0 || top < 0 || left + data.size.width * zoom > bounds.width || top + data.size.height * zoom > bounds.height) {
      void setCenter(data.center.x, data.center.y, { zoom, duration: 0 });
    }
  }, [data.center, data.size, getViewport, setCenter]);
  const open = useCallback((event: MouseEvent<HTMLButtonElement>) => { actions.onOpenTask(data.task.id, event.currentTarget); }, [actions, data.task.id]);
  const navigate = useCallback((event: MouseEvent<HTMLButtonElement>) => { if (actions.kind === 'chain') actions.onNavigateExternalTask(data.task.id, event.currentTarget); }, [actions, data.task.id]);
  const inspect = useCallback(() => { if (actions.kind === 'chain') actions.onInspectTask(data.task.id); }, [actions, data.task.id]);
  const expandable = actions.kind === 'chain' && (actions.expansions.prerequisites.ids.length > 0 || actions.expansions.successors.ids.length > 0);
  return (
    <div className={`task-node${actions.kind === 'goal' ? ' task-node-goal' : ''} task-node-${data.task.status} task-node-${inspection}${data.kind === 'external' ? ' task-node-external' : ''}${execution?.overdue ? ' task-node-stuck' : ''}${paused ? ' task-node-paused' : ''} nodrag nopan`} data-task-status={data.task.status} data-inspection={inspection} style={{ pointerEvents: 'auto' }}>
      <button type="button" ref={body} className="task-node-body nodrag nopan"
        aria-label={`${m.nodeLabel({ title, status: common.status[data.task.status], blocked: data.task.blockedBy.length > 0, external: data.kind === 'external' })}${data.ownerLabel == null ? '' : `, ${data.ownerLabel}`}${paused ? `, ${pause.label}` : ''}${actions.kind === 'chain' ? m.inspectionSuffix[inspection] : ''}`}
        aria-describedby={execution === null ? undefined : descriptionId}
        aria-pressed={actions.kind === 'chain' ? inspection === 'selected' : undefined} aria-haspopup={actions.kind === 'goal' ? 'dialog' : undefined} onClick={actions.kind === 'goal' ? open : inspect} onFocus={revealOnFocus}>
        <TaskNodeContent task={data.task} kind={data.kind} ownerLabel={data.ownerLabel ?? null} execution={execution} />
      </button>
      {execution !== null && <TaskExecutionDescription execution={execution} id={descriptionId} />}
      {actions.kind === 'chain' && <><button type="button" className="task-node-details nodrag nopan" aria-haspopup="dialog" aria-label={m.detailsLabel({ title })} onClick={open} onFocus={revealOnFocus}>{m.details}</button>
      {data.kind === 'external' ? <div className="task-node-expansions task-node-navigation">
        <button type="button" className="task-node-expand task-node-navigate nodrag nopan" aria-label={m.expandExternalLabel({ title })} onClick={navigate} onFocus={revealOnFocus}>
          <span>{m.expandExternal}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
        </button>
      </div> : expandable && <div className="task-node-expansions">
        <ExpansionControl direction="prerequisites" expansion={actions.expansions.prerequisites} onFocus={revealOnFocus} onExpand={() => { actions.onExpandTask(data.task.id, 'prerequisites'); }} />
        <ExpansionControl direction="successors" expansion={actions.expansions.successors} onFocus={revealOnFocus} onExpand={() => { actions.onExpandTask(data.task.id, 'successors'); }} />
      </div>}</>}
    </div>
  );
});
