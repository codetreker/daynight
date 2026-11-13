import { useId, useMemo, type ReactNode, type RefObject } from 'react';
import type { TaskSummary } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { ProjectGraphErrorDetail } from '../projects/ProjectGraphError';
import { useGraphDirection } from '../projects/useProjectViewPreferences';
import { TaskPauseCount, usePausedTaskIds } from '../task-pause/TaskPause';
import { pausedSummaryTaskIds } from '../task-pause/paused-summary';
import { projectTaskScope } from './scope';
import { completionProgress } from './completion-progress';
import type { GraphIndex } from './model';
import { GoalTaskGraph } from './GoalTaskGraph';
import { TaskGraphDialogShell } from './TaskGraphDialogShell';

export const GoalGraphDialog = ({ projectId, index, summaries, goalId, onOpenTask, onClose, onRestoreFocus, renderNested, onRootChange, graphError, onRefreshGraph }: {
  readonly projectId: string;
  readonly index: GraphIndex;
  readonly summaries: ReadonlyMap<string, TaskSummary>;
  readonly goalId: string;
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly onRootChange?: (element: HTMLElement | null) => void;
  readonly graphError?: unknown;
  readonly onRefreshGraph?: () => void;
}) => {
  const { messages: { graph: m, common, workspace: { project } } } = useI18n();
  const { direction, onDirectionChange, issue } = useGraphDirection(projectId, goalId);
  const goal = summaries.get(goalId)!;
  const scope = useMemo(() => projectTaskScope(index, goalId), [index, goalId]);
  const displayProgress = completionProgress(scope.progress);
  const paused = usePausedTaskIds();
  const pausedCount = pausedSummaryTaskIds(scope.taskIds.map((id) => index.nodes.get(id)!), paused).size;
  const titleId = useId();
  return <TaskGraphDialogShell dialogId={`task-graph-${goalId}`} labelId={titleId} focusRevision={index} onClose={onClose} onRestoreFocus={onRestoreFocus}
    {...(renderNested === undefined ? {} : { renderNested })} {...(onRootChange === undefined ? {} : { onRootChange })}
    header={(close) => <header className="task-chain-header">
      <span className="task-chain-icon" aria-hidden="true">◎</span>
      <div className="task-chain-heading"><p className="task-chain-eyebrow">{m.goalTitle}</p>
        <h2 id={titleId}>{goal.titlePreview}{goal.titleTruncated ? '…' : ''}</h2>
        <p className="task-chain-meta"><span>{m.rootSummary({ total: scope.progress.total, remaining: scope.progress.unfinished })}</span>
          <span>{m.progress({ done: displayProgress.displayDone, total: displayProgress.displayTotal })}</span><TaskPauseCount count={pausedCount} /><span className={`graph-status graph-status-${goal.status}`}>{common.status[goal.status]}</span></p>
      </div>
      <AccountRefreshNotice /><button className="task-chain-close" type="button" ref={close} aria-label={m.closeDialog} title={m.closeDialog} onClick={onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>}>
    {(fullscreen) => <><GoalTaskGraph projectId={projectId} index={index} summaries={summaries} goalId={goalId} direction={direction} onDirectionChange={onDirectionChange} directionIssue={issue?.kind} onOpenTask={onOpenTask} fullscreen={fullscreen} />
      {graphError != null && <div className="task-detail-graph-error" role="alert"><h2>{project.refreshFailed}</h2><p>{project.showingSnapshot}</p><ProjectGraphErrorDetail error={graphError} />{onRefreshGraph !== undefined && <button className="button" type="button" onClick={onRefreshGraph}>{project.retryRefresh}</button>}</div>}</>}
  </TaskGraphDialogShell>;
};
