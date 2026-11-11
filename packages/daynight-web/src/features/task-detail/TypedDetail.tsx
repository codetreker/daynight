import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { ApiError } from '../../api/client';
import type { TaskDetail } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { OverlayOwnerContext } from '../../app/overlay';
import { isThreadScopeLoss } from '../task-thread/api';
import { GoalDetailSurface } from '../goal-detail/GoalDetailSurface';
import { DetailFrame, useDetailOverlay } from './DetailFrame';
import { TaskDetailPageBar, TaskDetailSurface, type TaskDetailSurfaceProps } from './TaskDetailSurface';
import { useTaskDetail } from './useTaskDetail';
import { TaskDetailDialog } from './TaskDetailDialog';

type Props = TaskDetailSurfaceProps & {
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly initialWitness?: string;
};

// Resolve the resource before mounting either type's business controllers. The
// detail session's read fence also retires a delayed response across epochs.
export const TypedDetail = (props: Props) => {
  const summary = props.snapshot?.summaries.get(props.taskId);
  const summaryInput = props.snapshot != null && props.observation?.kind !== 'direct' && summary?.type !== 'goal';
  const waitingForSummary = summaryInput && summary === undefined;
  const task = useTaskDetail(props.projectId, props.taskId, summaryInput
    ? { kind: 'project-summary', revision: props.snapshot!.revision, task: props.snapshot!.index.nodes.get(props.taskId) } : { kind: 'direct' });
  const restoreLoading = useRef(true);
  const activeGoal = useRef<string | null>(null);
  const detail = waitingForSummary ? null : task.detail;
  if (detail === null) {
    activeGoal.current = null; restoreLoading.current = true;
    return <TypedDetailLoading {...props} task={task} restoreOnUnmount={() => restoreLoading.current} />;
  }
  restoreLoading.current = false;
  if (detail.type === 'task') { activeGoal.current = null; return <TaskDetailSurface {...props} resourceState={task} />; }
  const goalKey = `${props.projectId}/${props.taskId}/${task.historyGeneration}`;
  activeGoal.current = goalKey;
  return props.presentation === 'dialog'
    ? <QualifiedGoal key={goalKey} {...props} resourceState={task} detail={detail} detailError={task.error} detailRefreshing={task.refreshing} detailFresh={!task.requiresFreshRead} onRetryDetail={task.retry} onRestoreFocus={() => { if (activeGoal.current === goalKey) props.onRestoreFocus(); }} />
    : <QualifiedGoal key={goalKey} {...props} resourceState={task} detail={detail} detailError={task.error} detailRefreshing={task.refreshing} detailFresh={!task.requiresFreshRead} onRetryDetail={task.retry} />;
};

// The owner, including its child selection, expires with the resource history.
const QualifiedGoal = (props: Props & { readonly resourceState: ReturnType<typeof useTaskDetail>; readonly detail: TaskDetail; readonly detailError: unknown; readonly detailRefreshing: boolean; readonly detailFresh: boolean; readonly onRetryDetail: () => void }) => {
  const [nested, setNested] = useState<{ readonly id: string; readonly trigger: HTMLElement } | null>(null);
  useLayoutEffect(() => { if (props.fullscreen.active) props.fullscreen.onChange(false); }, []);
  const closeChain = useRef<(() => void) | null>(null);
  const [retired, setRetired] = useState(false);
  const refusal = useRef<unknown>(null);
  if (isThreadScopeLoss(props.detailError)) refusal.current = props.detailError;
  const scopeLost = retired || isThreadScopeLoss(props.detailError);
  useLayoutEffect(() => {
    if (isThreadScopeLoss(props.detailError)) { setRetired(true); setNested(null); closeChain.current?.(); }
    else if (retired && props.detailError === null && !props.detailRefreshing && props.detailFresh) { refusal.current = null; setRetired(false); }
  }, [props.detailError, props.detailRefreshing, props.detailFresh, retired]);
  return <GoalDetailSurface {...props} closeChain={closeChain} resourceUnavailable={scopeLost} detailError={props.detailError ?? (scopeLost ? refusal.current : null)} detail={props.detail} snapshot={props.snapshot ?? null}
    onSelectTask={(id, trigger) => setNested({ id, trigger })}
    renderNested={(owner: RefObject<HTMLElement | null>) => nested === null ? null : <TaskDetailDialog projectId={props.projectId} taskId={nested.id} parentGoalId={props.taskId} snapshot={props.snapshot ?? null}
      observation={props.snapshot?.index.nodes.has(nested.id) ? { kind: 'project-summary', revision: props.snapshot.revision, task: props.snapshot.index.nodes.get(nested.id) } : { kind: 'direct' }}
      onClose={() => setNested(null)} onRestoreFocus={() => { if (nested.trigger.isConnected && !nested.trigger.closest('[hidden], [inert]')) nested.trigger.focus({ preventScroll: true }); else { const fallback = owner.current?.querySelector<HTMLElement>('.task-chain-close, .task-detail-title') ?? document.querySelector<HTMLElement>('.goal-detail-surface .task-detail-title'); if (fallback !== null && fallback !== undefined && !fallback.closest('[hidden], [inert]')) fallback.focus({ preventScroll: true }); } }}
      onSelectTask={(id) => { const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : nested.trigger; if (props.onNavigateExternalTask !== undefined && props.snapshot?.index.nodes.get(id)?.parentId !== props.taskId) { flushSync(() => { setNested(null); closeChain.current?.(); }); props.onNavigateExternalTask(id, trigger); } else setNested({ id, trigger }); }} onRefreshGraph={props.onRefreshGraph}
      {...(props.onNavigateExternalTask === undefined ? {} : { onNavigateExternalTask: props.onNavigateExternalTask })} />}
    {...(props.onNavigateExternalTask === undefined ? {} : { onNavigateExternalTask: props.onNavigateExternalTask })} />;
};

const TypedDetailLoading = (props: Props & { readonly task: ReturnType<typeof useTaskDetail>; readonly restoreOnUnmount: () => boolean }) => {
  const { messages } = useI18n();
  const m = messages.inspection.detail;
  const root = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const modal = props.presentation === 'dialog';
  useDetailOverlay({ root, initialFocus: close, modal, fullscreen: false, scope: props.projectId, blocked: () => false,
    onEscape: () => props.onClose?.(), onRestoreFocus: () => { if (props.restoreOnUnmount()) props.onRestoreFocus?.(); } });
  const error = props.task.error;
  const title = props.task.status === 'deleted' ? messages.inspection.deletion.deleted : props.task.status === 'error' ? m.failed : m.loading;
  const content = <OverlayOwnerContext value={root}><DetailFrame modal={modal} root={root} headingId={heading} className={modal ? 'task-detail-dialog' : 'task-detail-page'}>
    {!modal && <TaskDetailPageBar projectId={props.projectId} />}
    <header className="task-detail-header"><h2 id={heading} className="task-detail-title">{title}</h2>
      {modal && <button className="button task-detail-close" type="button" ref={close} aria-label={m.close} onClick={props.onClose}>×</button>}
    </header>
    {props.task.status === 'loading' && <div className="task-detail-state" role="status" aria-label={m.loading}><span className="spinner" aria-hidden="true" /></div>}
    {props.task.status === 'error' && <div className="task-detail-state task-detail-error" role="alert"><p>{error instanceof ApiError && error.kind === 'network' ? m.networkError : error instanceof ApiError && error.code === 'not_found' ? m.notFoundError : m.loadError}</p><button className="button primary" type="button" onClick={props.task.retry}>{m.retry}</button></div>}
    {props.task.status === 'deleted' && <div className="task-detail-state task-detail-deleted" role="status">{messages.inspection.deletion.deletedExplanation}</div>}
  </DetailFrame></OverlayOwnerContext>;
  return modal ? <div className="task-detail-backdrop">{content}</div> : content;
};
