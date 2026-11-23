import { memo, type FocusEvent } from 'react';
import { useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import type { GoalAcceptanceGoal } from './model';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskInspectionState } from '../task-graph/inspection';
import { goalAcceptanceMessages } from './messages';

export type GoalAcceptanceFlowNode = Node<{
  goal: GoalAcceptanceGoal;
  progress: { readonly done: number; readonly total: number } | undefined;
  onInspect: (id: string) => void;
  onOpen: (id: string, trigger: HTMLElement) => void;
}, 'goalAcceptance'>;

export const GoalAcceptanceNode = memo(({ data, positionAbsoluteX, positionAbsoluteY, width, height }: NodeProps<GoalAcceptanceFlowNode>) => {
  const { locale, messages: { common } } = useI18n();
  const m = goalAcceptanceMessages(locale);
  const inspection = useTaskInspectionState(data.goal.id);
  const { getViewport, setCenter } = useReactFlow();
  const title = `${data.goal.titlePreview}${data.goal.titleTruncated ? '…' : ''}`;
  const focus = (event: FocusEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.matches(':focus-visible') || width === undefined || height === undefined) return;
    const bounds = event.currentTarget.closest('.task-graph-canvas')!.getBoundingClientRect();
    const { x, y, zoom } = getViewport();
    const left = x + positionAbsoluteX * zoom, top = y + positionAbsoluteY * zoom;
    if (left < 0 || top < 0 || left + width * zoom > bounds.width || top + height * zoom > bounds.height)
      void setCenter(positionAbsoluteX + width / 2, positionAbsoluteY + height / 2, { zoom, duration: 0 });
  };
  return <div className={`task-node task-node-goal goal-acceptance-node task-node-${data.goal.status} task-node-${inspection}${data.goal.project === undefined ? '' : ' task-node-external'} nodrag nopan`} data-inspection={inspection} data-goal-status={data.goal.status}>
    <button type="button" className="task-node-body nodrag nopan" aria-label={`${title}, ${common.status[data.goal.status]}`} aria-pressed={inspection === 'selected'} onClick={() => data.onInspect(data.goal.id)} onFocus={focus}>
      <span className="task-node-meta"><span className="task-node-id">{data.goal.id.slice(0, 8)}</span><span>{data.goal.project?.name ?? 'Goal'}</span></span>
      <span className="task-node-title" title={title}>{title}</span>
      {data.progress !== undefined && <span className="goal-acceptance-progress">{m.progress(data.progress.done, data.progress.total)}</span>}
      <span className="task-node-bottom"><span className={`graph-status graph-status-${data.goal.status}`}><i aria-hidden="true" />{common.status[data.goal.status]}</span></span>
    </button>
    <button type="button" className="task-node-details nodrag nopan" aria-label={`${m.details}: ${title}`} aria-haspopup="dialog" onClick={event => data.onOpen(data.goal.id, event.currentTarget)} onFocus={focus}>{m.details}</button>
  </div>;
});
