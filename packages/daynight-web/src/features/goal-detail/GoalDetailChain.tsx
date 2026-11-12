import { useI18n } from '../../i18n/LocaleProvider';
import { ChainCompletionTime } from '../task-completion/ChainCompletionTime';
import { latestScopedCompletion } from '../task-completion/model';
import { useCompletionTime } from '../task-completion/useCompletionTime';
import type { GraphIndex } from '../task-graph/model';
import { GoalDetailTaskRow } from './GoalDetailTaskRow';

export const GoalDetailChain = ({ projectId, index, representativeId, memberIds, pausedTaskIds, expanded, onToggle, onOpenChain, onSelectTask }: {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly representativeId: string;
  readonly memberIds: readonly string[];
  readonly pausedTaskIds: ReadonlySet<string>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenChain: (trigger: HTMLElement) => void;
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
}) => {
  const { locale, messages, format } = useI18n();
  const task = index.nodes.get(representativeId)!;
  const title = `${task.titlePreview}${task.titleTruncated ? '…' : ''}`;
  const completion = useCompletionTime(latestScopedCompletion(index, memberIds));
  return <section className="goal-detail-chain"><div className="goal-detail-chain-header"><button type="button" className="goal-detail-disclosure" aria-expanded={expanded} onClick={onToggle}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span><span>{title}<small>{locale === 'zh-CN' ? `当前范围 ${format.number(memberIds.length)} 个 Task` : `${format.number(memberIds.length)} tasks in this goal`}</small></span></button><ChainCompletionTime value={completion} title={title} /><button type="button" className="button" onClick={(event) => onOpenChain(event.currentTarget)}>{messages.graph.viewDependencies}</button></div><div hidden={!expanded}><ul className="goal-detail-tasks">{memberIds.map(id => <GoalDetailTaskRow key={id} projectId={projectId} task={index.nodes.get(id)!} paused={pausedTaskIds.has(id)} onSelectTask={onSelectTask} />)}</ul></div></section>;
};
