import { completionProgress } from './completion-progress';
import { latestScopedCompletion } from '../task-completion/model';
import { useCompletionTime } from '../task-completion/useCompletionTime';
import { ChainCompletionTime } from '../task-completion/ChainCompletionTime';
import { forwardRef, memo, useCallback, useMemo } from 'react';
import type { TaskSummary, WorkerClaim } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { compareTaskMembers } from '../projects/task-order';
import { SessionStatus } from '../task-session-summary/SessionStatus';
import { useChainSessionSummary, useSessionChainVisibility } from '../task-session-summary/TaskSessionSummaryProvider';
import { ActiveWorkerIndicator } from './ActiveWorkerIndicator';
import { TaskMemberRow } from './TaskMemberRow';
import type { GraphIndex } from './model';
import type { ScopedChainProgress } from './scoped-chain-progress';

export type ScopedTaskChainRowProps = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly summaries?: ReadonlyMap<string, TaskSummary>;
  readonly rootId: string;
  readonly memberIds: readonly string[];
  readonly progress: ScopedChainProgress;
  readonly workerMachines: ReadonlyMap<string, Pick<WorkerClaim, 'state' | 'machine'>>;
  readonly instanceId: string;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly open: boolean;
  readonly onOpenChain: (witness: string, trigger: HTMLElement) => void;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
};

export const ScopedTaskChainRow = memo(forwardRef<HTMLLIElement, ScopedTaskChainRowProps>(function ScopedTaskChainRow({ projectId, index, summaries, rootId, memberIds, progress, workerMachines, instanceId, expanded, onExpandedChange, open, onOpenChain, onOpenTask, onOpenSession }, ref) {
  const { messages: { graph: m } } = useI18n();
  const displayProgress = completionProgress(progress);
  const label = index.nodes.get(rootId)!;
  const completion = useCompletionTime(latestScopedCompletion(index, memberIds));
  const title = `${label.titlePreview}${label.titleTruncated ? '…' : ''}`;
  const tasks = useMemo(() => memberIds.map((id) => index.nodes.get(id)!).toSorted(compareTaskMembers), [index, memberIds]);
  const memberSet = useMemo(() => new Set(memberIds), [memberIds]);
  const sessionIndicator = useChainSessionSummary(memberSet);
  const observeVisibility = useSessionChainVisibility(instanceId, memberSet);
  const setRef = useCallback((element: HTMLLIElement | null) => {
    observeVisibility(element);
    if (typeof ref === 'function') ref(element);
    else if (ref !== null) ref.current = element;
  }, [observeVisibility, ref]);
  const childrenId = `goal-children-${instanceId}`;
  return <li ref={setRef} className="root-row goal-row" data-chain-id={rootId} data-task-status={progress.status}>
    <div className="goal-header task-status-surface" data-task-status={progress.status}>
      <div className="chain-summary">
        <button className="root-toggle goal-toggle" type="button" id={`task-root-${instanceId}`} aria-expanded={expanded} aria-controls={childrenId} aria-labelledby={`chain-title-${instanceId} chain-meta-${instanceId} chain-progress-${instanceId}`} onClick={() => onExpandedChange(!expanded)}>
          <svg className={`goal-disclosure${expanded ? ' expanded' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
          <span className="goal-title-line" id={`chain-title-${instanceId}`}><span className="root-title">{title}</span><span className="goal-in-progress">{m.inProgressCount({ count: progress.inProgress })}</span></span>
        </button>
        <div className="task-assignee-row-meta chain-summary-meta"><span className="chain-summary-context" id={`chain-meta-${instanceId}`}><span className="root-meta">{m.childTasks({ count: memberIds.length })}</span><ActiveWorkerIndicator memberIds={index.components.get(rootId)!.memberIds} workerMachines={workerMachines} /></span><ChainCompletionTime value={completion} title={title} /></div>
      </div>
      <span className="root-progress" id={`chain-progress-${instanceId}`}><span className="root-progress-label">{m.progress({ done: displayProgress.displayDone, total: displayProgress.displayTotal })}</span><span className="root-progress-track" aria-hidden="true"><i style={{ width: `${displayProgress.widthPercent}%` }} /></span></span>
      <SessionStatus title={title} status={progress.status} indicator={sessionIndicator} chain expanded={expanded} controls={childrenId} {...(sessionIndicator === null ? {} : { onActivate: () => onExpandedChange(true) })} />
      <button className="button goal-graph-button" type="button" id={`task-chain-graph-${instanceId}`} aria-label={m.viewDependenciesLabel({ title })} aria-haspopup="dialog" aria-controls={open ? `task-graph-${rootId}` : undefined} onClick={(event) => onOpenChain(memberIds[0]!, event.currentTarget)}>{m.viewDependencies}</button>
    </div>
    <div id={childrenId} hidden={!expanded} className="goal-children"><ul className="goal-task-list">{tasks.map((task) => <TaskMemberRow key={task.id} projectId={projectId} task={task} {...(summaries?.get(task.id) === undefined ? {} : { tags: summaries.get(task.id)!.tags })} instanceId={instanceId} workerMachine={workerMachines.get(task.id)} onOpenTask={onOpenTask} {...(onOpenSession === undefined ? {} : { onOpenSession })} />)}</ul></div>
  </li>;
}));
