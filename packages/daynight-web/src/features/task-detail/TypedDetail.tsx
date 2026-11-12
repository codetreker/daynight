import { AccountRefreshNotice } from '../auth/AccountRefreshNotice';
import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { ApiError } from '../../api/client';
import type { TaskDetail } from '../../api/types';
import { useI18n } from '../../i18n/LocaleProvider';
import { OverlayOwnerContext } from '../../app/overlay';
import type { GoalChildren, ResourceReading } from '../../app/page-history';
import { useProjectHistoryGeneration } from '../../app/use-page-history';
import { isThreadScopeLoss } from '../task-thread/api';
import { GoalDetailSurface } from '../goal-detail/GoalDetailSurface';
import { projectTaskScope } from '../task-graph/scope';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { DetailFrame, useDetailOverlay } from './DetailFrame';
import { TaskDetailPageBar, TaskDetailSurface, type TaskDetailSurfaceProps } from './TaskDetailSurface';
import { useTaskDetail } from './useTaskDetail';
import { TaskDetailDialog } from './TaskDetailDialog';
import type { TaskObservationInput } from './TaskDetailSession';
import { ResourceChildDraftHost } from './TaskDraftNavigation';

type Props = TaskDetailSurfaceProps & {
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly initialWitness?: string;
  readonly goalChildren?: GoalChildren;
  readonly onGoalChildrenChange?: (next: GoalChildren, options?: { readonly replace?: boolean }) => void;
  readonly requireParentMatch?: boolean;
};

// Resolve the resource before mounting either type's business controllers. The
// detail session's read fence also retires a delayed response across epochs.
export const TypedDetail = (props: Props) => {
  const identity = `${props.projectId}/${props.taskId}`;
  const scope = useTaskCacheScope();
  const generation = useProjectHistoryGeneration(scope, props.projectId);
  type KnownType = { identity: string; scope: typeof scope; generation: number; type: 'task' | 'goal' | undefined;
    snapshot: typeof props.snapshot; blockedSnapshot: typeof props.snapshot };
  const known = useRef<KnownType>({ identity, scope, generation, type: undefined, snapshot: props.snapshot, blockedSnapshot: null });
  if (known.current.identity !== identity || known.current.scope !== scope || known.current.generation !== generation) {
    const blockedSnapshot = known.current.identity === identity && known.current.scope === scope && known.current.snapshot === props.snapshot ? props.snapshot : null;
    known.current = { identity, scope, generation, type: undefined, snapshot: props.snapshot, blockedSnapshot };
  }
  known.current.snapshot = props.snapshot;
  const blocked = props.snapshot != null && known.current.blockedSnapshot === props.snapshot;
  const summary = blocked ? undefined : props.snapshot?.summaries.get(props.taskId);
  if (props.observation?.kind === 'direct' && known.current.type === 'task') known.current.type = undefined;
  if (summary !== undefined && props.observation?.kind !== 'direct') known.current.type = summary.type;
  const type = props.snapshot == null ? known.current.type : summary?.type;
  const summaryInput = props.observation?.kind !== 'direct' && (props.snapshot != null || props.observation?.kind === 'project-summary') && type !== 'goal';
  const waitingForSummary = summaryInput && type === undefined;
  const task = useTaskDetail(props.projectId, props.taskId, summaryInput
    ? blocked ? { kind: 'project-summary', revision: 0, task: undefined }
      : props.snapshot == null && props.observation?.kind === 'project-summary' ? props.observation
        : { kind: 'project-summary', revision: props.snapshot?.revision ?? 0, task: props.snapshot?.index.nodes.get(props.taskId) }
    : { kind: 'direct' });
  // An admitted direct Goal uses the same typed owner as a summary Goal.
  if (props.observation?.kind === 'direct' && task.detail?.type === 'goal' && task.status === 'ready' && !task.requiresFreshRead) known.current.type = 'goal';
  const restoreLoading = useRef(true);
  const activeGoal = useRef<string | null>(null);
  const parentAdmitted = useRef(false);
  const detail = waitingForSummary ? null : task.detail;
  if (detail === null) {
    activeGoal.current = null; restoreLoading.current = true;
    return <TypedDetailLoading {...props} task={task} restoreOnUnmount={() => restoreLoading.current} />;
  }
  if (props.requireParentMatch && !parentAdmitted.current) {
    if (detail.parentId !== props.parentGoalId) return null;
    parentAdmitted.current = true;
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
  const [localNested, setLocalNested] = useState<ResourceReading | null>(null);
  const nested = props.goalChildren === undefined ? localNested : props.goalChildren.task;
  const admittedNested = useRef<string | null>(null);
  const graphId = props.goalChildren?.graphRootId;
  const graphEligible = graphId == null || props.snapshot != null && projectTaskScope(props.snapshot.index, props.taskId).chains.some(chain => chain.representativeId === graphId);
  if (nested === null) admittedNested.current = null;
  else if (admittedNested.current !== nested.id) {
    const node = props.snapshot?.index.nodes.get(nested.id);
    admittedNested.current = props.goalChildren === undefined || graphEligible && props.snapshot != null && (node === undefined || node.parentId === props.taskId) ? nested.id : null;
  }
  const childObservation = useRef<{ id: string; input: TaskObservationInput } | null>(null);
  if (nested === null || admittedNested.current !== nested.id) childObservation.current = null;
  else if (childObservation.current?.id !== nested.id) {
    const node = props.snapshot?.index.nodes.get(nested.id);
    childObservation.current = { id: nested.id, input: node === undefined ? { kind: 'direct' } : { kind: 'project-summary', revision: props.snapshot!.revision, task: node } };
  } else if (childObservation.current.input.kind === 'project-summary' && props.snapshot != null) {
    childObservation.current.input = { kind: 'project-summary', revision: props.snapshot.revision, task: props.snapshot.index.nodes.get(nested.id) };
  }
  const nestedTrigger = useRef<HTMLElement | null>(null);
  const setNested = (next: ResourceReading | null, replace = false) => {
    if (props.goalChildren === undefined) setLocalNested(next);
    else props.onGoalChildrenChange?.({ ...props.goalChildren, task: next }, { replace });
  };
  useLayoutEffect(() => { if (props.fullscreen.active) props.fullscreen.onChange(false); }, []);
  const closeChain = useRef<(() => void) | null>(null);
  const [retired, setRetired] = useState(false);
  const refusal = useRef<unknown>(null);
  if (isThreadScopeLoss(props.detailError)) refusal.current = props.detailError;
  const scopeLost = retired || isThreadScopeLoss(props.detailError);
  useLayoutEffect(() => {
    if (isThreadScopeLoss(props.detailError)) { setRetired(true); setLocalNested(null); closeChain.current?.(); }
    else if (retired && props.detailError === null && !props.detailRefreshing && props.detailFresh) { refusal.current = null; setRetired(false); }
  }, [props.detailError, props.detailRefreshing, props.detailFresh, retired]);
  return <GoalDetailSurface {...props} closeChain={closeChain} resourceUnavailable={scopeLost} detailError={props.detailError ?? (scopeLost ? refusal.current : null)} detail={props.detail} snapshot={props.snapshot ?? null}
    onSelectTask={(id, trigger) => { nestedTrigger.current = trigger; setNested({ id, navigation: { tab: 'overview', path: null } }); }}
    renderNested={(owner: RefObject<HTMLElement | null>) => nested === null || admittedNested.current !== nested.id ? null : <ResourceChildDraftHost><TaskDetailDialog projectId={props.projectId} taskId={nested.id} parentGoalId={props.taskId} snapshot={props.snapshot ?? null}
      observation={childObservation.current!.input}
      {...(props.goalChildren !== undefined && !props.snapshot?.index.nodes.has(nested.id) ? { requireParentMatch: true } : {})}
      {...(props.goalChildren === undefined ? {} : { navigation: nested.navigation, onNavigate: (navigation: ResourceReading['navigation']) => setNested({ ...nested, navigation }) })}
      {...(props.onNavigateParent === undefined ? {} : { onNavigateParent: props.onNavigateParent })}
      onClose={() => setNested(null, true)} onRestoreFocus={() => { const trigger = nestedTrigger.current; if (trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus({ preventScroll: true }); else { const fallback = owner.current?.querySelector<HTMLElement>('.task-chain-close, .task-detail-title') ?? document.querySelector<HTMLElement>('.goal-detail-surface .task-detail-title'); if (fallback !== null && fallback !== undefined && !fallback.closest('[hidden], [inert]')) fallback.focus({ preventScroll: true }); } }}
      onSelectTask={(id) => { const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : nestedTrigger.current ?? owner.current ?? document.body; if (props.onNavigateExternalTask !== undefined && props.snapshot?.index.nodes.get(id)?.parentId !== props.taskId) { flushSync(() => { if (props.goalChildren === undefined) setLocalNested(null); closeChain.current?.(); }); props.onNavigateExternalTask(id, trigger); } else { nestedTrigger.current = trigger; setNested({ id, navigation: { tab: 'overview', path: null } }); } }} onRefreshGraph={props.onRefreshGraph}
      {...(props.onNavigateExternalTask === undefined ? {} : { onNavigateExternalTask: props.onNavigateExternalTask })} /></ResourceChildDraftHost>}
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
    <header className="task-detail-header"><h2 id={heading} className="task-detail-title">{title}</h2><AccountRefreshNotice />
      {modal && <button className="button task-detail-close" type="button" ref={close} aria-label={m.close} onClick={props.onClose}>×</button>}
    </header>
    {props.task.status === 'loading' && <div className="task-detail-state" role="status" aria-label={m.loading}><span className="spinner" aria-hidden="true" /></div>}
    {props.task.status === 'error' && <div className="task-detail-state task-detail-error" role="alert"><p>{error instanceof ApiError && error.kind === 'network' ? m.networkError : error instanceof ApiError && error.code === 'not_found' ? m.notFoundError : m.loadError}</p><button className="button primary" type="button" onClick={props.task.retry}>{m.retry}</button></div>}
    {props.task.status === 'deleted' && <div className="task-detail-state task-detail-deleted" role="status">{messages.inspection.deletion.deletedExplanation}</div>}
  </DetailFrame></OverlayOwnerContext>;
  return modal ? <div className="task-detail-backdrop">{content}</div> : content;
};
