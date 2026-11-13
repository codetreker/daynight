import { completionProgress } from './completion-progress';
import { useId, type ReactNode, type RefObject } from 'react';
import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { TaskPauseCount, usePausedTaskIds } from '../task-pause/TaskPause';
import { pausedSummaryTaskIds } from '../task-pause/paused-summary';
import { useI18n } from '../../i18n/LocaleProvider';
import type { GraphIndex } from './model';
import type { TaskSummary } from '../../api/types';
import { TaskGraph } from './TaskGraph';
import { TaskGraphDialogShell } from './TaskGraphDialogShell';
import { useGraphDirection } from '../projects/useProjectViewPreferences';

type TaskChainDialogProps = {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly rootId: string;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly onRootChange?: (element: HTMLElement | null) => void;
  readonly summaries?: ReadonlyMap<string, TaskSummary>;
};

export const TaskChainDialog = ({ projectId, index, summaries, rootId, onOpenTask, onNavigateExternalTask, onClose, onRestoreFocus, renderNested, onRootChange }: TaskChainDialogProps) => {
  const { messages: { graph: m, common } } = useI18n();
  const { direction, onDirectionChange, issue } = useGraphDirection(projectId, rootId);
  const task = index.nodes.get(rootId)!;
  const component = index.components.get(rootId)!;
  const progress = component.progress;
  const displayProgress = completionProgress(progress);
  const pausedTaskIds = usePausedTaskIds();
  const pausedCount = pausedSummaryTaskIds([...component.memberIds].map((id) => index.nodes.get(id)!), pausedTaskIds).size;
  const titleId = useId();

  return <TaskGraphDialogShell dialogId={`task-graph-${rootId}`} labelId={titleId} focusRevision={index} onClose={onClose} onRestoreFocus={onRestoreFocus}
    {...(renderNested === undefined ? {} : { renderNested })} {...(onRootChange === undefined ? {} : { onRootChange })}
    header={(close) => <header className="task-chain-header">
      <span className="task-chain-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="6" height="6" rx="1.4" /><rect x="15" y="15" width="6" height="6" rx="1.4" /><path d="M9 6h5a4 4 0 0 1 4 4v5M6 9v5a4 4 0 0 0 4 4h5" /></svg></span>
      <div className="task-chain-heading">
        <p className="task-chain-eyebrow">{m.chainTitle}</p>
        <h2 id={titleId}>{task.titlePreview}{task.titleTruncated ? '…' : ''}</h2>
        <p className="task-chain-meta"><span>{m.rootSummary({ total: progress.total, remaining: progress.total - progress.ended })}</span><span>{m.progress({ done: displayProgress.displayDone, total: displayProgress.displayTotal })}</span><TaskPauseCount count={pausedCount} /><span className={`graph-status graph-status-${progress.status}`}>{common.status[progress.status]}</span></p>
      </div>
      <AccountRefreshNotice /><button className="task-chain-close" type="button" ref={close} aria-label={m.closeDialog} title={m.closeDialog} onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>}>
    {(fullscreen) => <TaskGraph direction={direction} onDirectionChange={onDirectionChange} directionIssue={issue?.kind} index={index} {...(summaries === undefined ? {} : { summaries })} rootId={rootId} onOpenTask={onOpenTask} {...(onNavigateExternalTask === undefined ? {} : { onNavigateExternalTask })} fullscreen={fullscreen} />}
  </TaskGraphDialogShell>;
};
