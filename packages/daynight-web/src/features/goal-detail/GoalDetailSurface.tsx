import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { TaskDetail, TaskStatus } from '../../api/types';
import { ApiError, attachmentPreviewRoot, authRequestsPaused } from '../../api/client';
import { browserNavigation } from '../../app/navigation';
import { isTopOverlay, OverlayOwnerContext } from '../../app/overlay';
import type { TaskDetailNavigation } from '../../app/router';
import type { GoalChildren } from '../../app/page-history';
import { useI18n } from '../../i18n/LocaleProvider';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { TaskAssigneeSelect } from '../task-assignment/TaskAssigneeSelect';
import { TaskAssignmentFeedback } from '../task-assignment/TaskAssignmentFeedback';
import { TaskConfirmation } from '../task-detail/TaskConfirmation';
import { TaskStatusFeedback, TaskStatusMenu } from '../task-detail/TaskStatus';
import { TaskDeletionFeedback } from '../task-detail/TaskDeletion';
import { taskReviewKey } from '../task-detail/freshness';
import { useDirtyTaskDraft } from '../task-detail/TaskDraftNavigation';
import type { useTaskDetail } from '../task-detail/useTaskDetail';
import { DetailFrame, KeptMountedSlot, useDetailFullscreen, useDetailOverlay, type DetailFullscreen } from '../task-detail/DetailFrame';
import { TaskDetailPageBar } from '../task-detail/TaskDetailSurface';
import { DraftNavigationConfirmation, TaskDraftBoundary, useRetireTaskDraft } from '../task-detail/TaskDraftNavigation';
import { MarkdownContent } from '../task-detail/MarkdownContent';
import { TaskAttachmentsPanel, type AttachmentNavigation, type AttachmentTreeReveal, type AttachmentUrls } from '../task-detail/attachments/TaskAttachments';
import type { AttachmentKeyboardOwner } from '../task-detail/attachments/AttachmentPreview';
import { resolveAttachmentReference, resolveMarkdownAttachmentUrl } from '../task-detail/attachments/model';
import { useAttachments, type AttachmentApi } from '../task-detail/attachments/useAttachments';
import { TaskDiscussion } from '../task-thread/TaskDiscussion';
import { isThreadScopeLoss } from '../task-thread/api';
import { TaskChainDialog } from '../task-graph/TaskChainDialog';
import { projectTaskScope } from '../task-graph/scope';
import { TaskPauseProvider } from '../task-pause/TaskPause';
import { completedAtFor } from '../task-completion/model';
import { GoalMutationError } from './GoalMutationError';
import { currentTaskTags } from '../task-tags/TaskTagList';
import { TaskTagsEditor } from '../task-tags/TaskTagsEditor';
import { GoalInformation } from './GoalInformation';
import { TaskDetailNotifications } from '../task-detail/TaskDetailNotice';
import '../../styles/task-detail.css';
import './goal-detail.css';

export type GoalDetailSurfaceProps = {
  readonly projectId: string;
  readonly taskId: string;
  readonly detail: TaskDetail;
  readonly resourceState: ReturnType<typeof useTaskDetail>;
  readonly snapshot: GraphSnapshot | null;
  readonly presentation: 'dialog' | 'page';
  readonly fullscreen: DetailFullscreen;
  readonly navigation?: TaskDetailNavigation;
  readonly onNavigate?: (navigation: TaskDetailNavigation) => void;
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onNavigateExternalChain?: (id: string, trigger: HTMLElement) => void;
  readonly onClose?: () => void;
  readonly onRestoreFocus?: () => void;
  readonly onRefreshGraph: () => void;
  readonly graphError?: unknown;
  readonly attachmentApi?: AttachmentApi;
  readonly attachmentUrls?: AttachmentUrls;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly goalChildren?: GoalChildren;
  readonly onGoalChildrenChange?: (next: GoalChildren, options?: { readonly replace?: boolean }) => void;
  readonly detailError?: unknown;
  readonly detailRefreshing?: boolean;
  readonly resourceUnavailable?: boolean;
  readonly onRetryDetail?: () => void;
};

type Tab = 'description' | 'attachments' | 'discussion';
const emptyPausedTaskIds: ReadonlySet<string> = new Set();
const goalStatuses: readonly TaskStatus[] = ['todo', 'in_progress', 'done', 'cancelled'];
const normalize = (navigation: TaskDetailNavigation): TaskDetailNavigation & { readonly tab: Tab } => ({ ...navigation, tab: navigation.tab === 'attachments' || navigation.tab === 'discussion' ? navigation.tab : 'description' });

const GoalContent = ({ projectId, taskId, detail, resourceState: task, snapshot, presentation, fullscreen, navigation, onNavigate, onSelectTask, onNavigateExternalTask, onNavigateExternalChain, onClose, onRestoreFocus, onRefreshGraph, graphError, attachmentApi, attachmentUrls, renderNested, goalChildren, onGoalChildrenChange, detailError, detailRefreshing = false, resourceUnavailable = false, onRetryDetail }: GoalDetailSurfaceProps) => {
  const { locale, messages, format } = useI18n();
  const zh = locale === 'zh-CN';
  const modal = presentation === 'dialog';
  const scopeLost = resourceUnavailable || isThreadScopeLoss(detailError);
  useRetireTaskDraft(scopeLost);
  const root = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const [edit, setEdit] = useState<{ title: string; description: string; version: bigint; originalTitle: string; originalDescription: string } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editSubmitted, setEditSubmitted] = useState(false);
  const editRevision = useRef(0);
  const submittedEdit = useRef<{ title: string; description: string; version: bigint; revision: number } | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: 'status'; detail: TaskDetail; status: TaskStatus } | { kind: 'delete'; detail: TaskDetail } | null>(null);
  const editUnsettled = task.mutation.operation?.action === 'editGoal' && (task.mutation.phase === 'pending' || task.mutation.phase === 'unknown' || task.mutation.phase === 'conflict' || task.mutation.reconciling || task.mutation.reconciliationError !== null);
  const outcomeUnknown = task.mutation.phase === 'unknown' || task.mutation.reconciledFrom === 'unknown';
  const action = task.mutation.operation?.action;
  const controlUnknown = outcomeUnknown && (action === 'status' || action === 'assignedTo' || action === 'delete');
  useDirtyTaskDraft({ isDirty: () => edit !== null && (edit.title !== edit.originalTitle || edit.description !== edit.originalDescription), discard: () => { editRevision.current++; submittedEdit.current = null; setEdit(null); setEditOpen(false); } });
  useEffect(() => { if (scopeLost) { setEdit(null); setEditOpen(false); setConfirmation(null); } }, [scopeLost]);
  useEffect(() => {
    const saved = submittedEdit.current;
    const operation = task.mutation.operation;
    if (saved === null || operation?.action !== 'editGoal' || operation.title !== saved.title || operation.description !== saved.description || operation.version !== saved.version) return;
    if (task.mutation.publicationPending) { if (editSubmitted && task.mutation.phase !== 'pending') setEditSubmitted(false); return; }
    if (task.mutation.phase === 'confirmed') {
      submittedEdit.current = null;
      if (editRevision.current === saved.revision) { setEdit(null); setEditOpen(false); }
      setEditSubmitted(false);
    } else if (task.mutation.phase === 'refused' || task.mutation.phase === 'conflict' || task.mutation.phase === 'reconciled') setEditSubmitted(false);
  }, [editSubmitted, task.mutation]);
  const headingId = useId(), tabPrefix = useId();
  const [local, setLocal] = useState<TaskDetailNavigation>({ tab: 'description', path: null });
  const selection = normalize(navigation ?? local);
  const setSelection = (next: TaskDetailNavigation) => { setLocal(next); onNavigate?.(next); };
  const openChain = goalChildren?.graphRootId ?? null;
  const closeGraph = () => { if (goalChildren !== undefined) onGoalChildrenChange?.({ ...goalChildren, graphRootId: null }, { replace: true }); };
  const [chainRoot, setChainRoot] = useState<HTMLElement | null>(null);
  const nestedOwner = useMemo<RefObject<HTMLElement | null>>(() => chainRoot === null ? root : { current: chainRoot }, [chainRoot]);
  const threadDetails = useRef(false);
  const changeFullscreen = useDetailFullscreen(root, toggle, fullscreen);
  const requestClose = () => { if (onClose !== undefined) browserNavigation().requestAction(onClose); };
  const escape = () => { if (fullscreen.active) changeFullscreen(false); else requestClose(); };
  const actions = useRef({ escape }); actions.current = { escape };
  const keyboardOwner = useMemo<AttachmentKeyboardOwner>(() => ({ root, isActive: () => root.current !== null && isTopOverlay(root.current), onEscape: () => actions.current.escape() }), []);
  useDetailOverlay({ root, initialFocus: close, modal, fullscreen: fullscreen.active, scope: `${projectId}/${taskId}`, blocked: () => threadDetails.current, onEscape: () => actions.current.escape(), ...(onRestoreFocus === undefined ? {} : { onRestoreFocus }) });
  const [overlayReady, setOverlayReady] = useState(false);
  // Nested portals require the Goal frame and its overlay lease before registration.
  useLayoutEffect(() => { setOverlayReady(true); }, []);
  const attachments = useAttachments(projectId, taskId, attachmentApi, { requireCompleteInventory: !modal, enabled: !scopeLost });
  const [reveal, setReveal] = useState<AttachmentTreeReveal>(() => ({ path: selection.path }));
  const [reference, setReference] = useState<(AttachmentNavigation & { readonly path: string | null }) | null>(null);
  const observedPath = useRef(selection.path);
  useLayoutEffect(() => {
    attachments.select(selection.path);
    if (observedPath.current !== selection.path) { observedPath.current = selection.path; setReveal({ path: selection.path }); }
  }, [attachments.select, selection.path]);
  const base = { kind: 'root' } as const;
  const previewRoot = attachmentUrls?.previewRoot ?? attachmentPreviewRoot(projectId, taskId);
  const scope = snapshot === null ? null : projectTaskScope(snapshot.index, taskId);
  const admittedChain = useRef<string | null>(null);
  if (openChain === null) admittedChain.current = null;
  else if (admittedChain.current !== openChain) admittedChain.current = scope?.chains.some(chain => chain.representativeId === openChain) ? openChain : null;
  const openTask = (id: string, trigger: HTMLElement) => {
    if (snapshot?.index.nodes.get(id)?.parentId === taskId || onNavigateExternalTask === undefined) onSelectTask(id, trigger);
    else browserNavigation().requestAction(() => onNavigateExternalTask(id, trigger));
  };
  const tabs: readonly Tab[] = ['description', 'attachments', 'discussion'];
  const labels: Record<Tab, string> = { description: messages.inspection.detail.description, attachments: messages.inspection.attachments.title, discussion: messages.inspection.discussion.title };
  useLayoutEffect(() => { document.getElementById(`${tabPrefix}-${selection.tab}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [tabPrefix, selection.tab, messages]);
  const activate = (tab: Tab) => { if (tab !== selection.tab) setSelection({ ...selection, tab }); document.getElementById(`${tabPrefix}-${tab}`)?.focus(); };
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>, tab: Tab) => {
    let next: Tab;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
    else if (event.key === 'Home') next = tabs[0]!;
    else if (event.key === 'End') next = tabs[tabs.length - 1]!;
    else return;
    event.preventDefault(); activate(next);
  };
  const content = <TaskPauseProvider taskIds={snapshot?.pausedTaskIds ?? emptyPausedTaskIds}><OverlayOwnerContext value={root}>
    <DetailFrame root={root} modal={modal} headingId={headingId} className={`${modal ? 'task-detail-dialog' : 'task-detail-page'} goal-detail-surface${fullscreen.active ? ' task-detail-fullscreen' : ''}`}>
      <TaskDetailNotifications fallbackFocus={heading}>
      {!modal && !fullscreen.active && <TaskDetailPageBar projectId={projectId} />}
      <header className="task-detail-header"><div className="task-detail-title-row"><h2 id={headingId} className="task-detail-title" ref={heading} tabIndex={0}>{scopeLost ? messages.inspection.detail.failed : detail.title}</h2></div><div className="task-detail-header-actions"><button className="button" type="button" disabled={scopeLost || edit === null && !task.canEditGoal} onClick={() => { editRevision.current++; if (edit === null) setEdit({ title: detail.title, description: detail.description, version: detail.version, originalTitle: detail.title, originalDescription: detail.description }); setEditOpen(true); }}>{zh ? '编辑' : 'Edit'}</button><button className="button task-detail-fullscreen-toggle" type="button" ref={toggle} aria-label={fullscreen.active ? messages.inspection.detail.exitFullscreen : messages.inspection.detail.enterFullscreen} title={fullscreen.active ? messages.inspection.detail.exitFullscreen : messages.inspection.detail.enterFullscreen} aria-pressed={fullscreen.active} onClick={() => changeFullscreen(!fullscreen.active)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={fullscreen.active ? 'M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} /></svg></button>{modal && <button className="button task-detail-close" type="button" ref={close} aria-label={messages.inspection.detail.close} onClick={requestClose}>×</button>}</div></header>
      <div className="task-detail-body">{detailError != null && <div className="task-detail-state task-detail-error" role="alert"><p>{messages.inspection.detail.refreshFailed}</p><button className="button" type="button" onClick={onRetryDetail} disabled={detailRefreshing}>{messages.inspection.detail.retry}</button></div>}<div className="goal-detail-content" hidden={scopeLost} inert={scopeLost}><div className="goal-detail-meta"><div className="task-detail-status-assignee"><TaskStatusMenu status={detail.status} disabled={!task.canDisplayStatus} cancelBlocked={false} statuses={goalStatuses} allowCancelledReopen menuLabel={zh ? 'Goal 状态' : 'Goal status'} onSelect={(status) => { if (status === detail.status || !task.canSetStatus || authRequestsPaused()) return; if (status === 'done' || status === 'cancelled') setConfirmation({ kind: 'status', detail, status }); else task.setStatus(status, detail.version); }} /><TaskAssigneeSelect projectId={projectId} detail={detail} disabled={!task.canDisplayAssignee} selectionBlocked={!task.canSetAssignedTo || authRequestsPaused()} direct owner={root} resetKey={String(task.historyGeneration)} onSelect={(assignedTo) => task.setAssignedTo(assignedTo, detail.version)} /></div>{completedAtFor(detail) !== null && <span className="goal-detail-completion">{messages.completion.field}: <time dateTime={detail.completedAt!}>{format.dateTime(detail.completedAt!)}</time></span>}</div>{controlUnknown ? <div className="goal-edit-recovery"><p role="alert">{zh ? '操作结果尚未确认。核对当前状态不会重新提交请求。' : 'The operation outcome is unknown. Checking the current state will not resend the request.'}</p>{task.mutation.error instanceof ApiError && <GoalMutationError error={task.mutation.error} action={action as 'status' | 'assignedTo' | 'delete'} outcomeUnknown />}{task.mutation.reconciliationError instanceof ApiError && <GoalMutationError error={task.mutation.reconciliationError} action={action as 'status' | 'assignedTo' | 'delete'} outcomeUnknown />}{(task.mutation.phase === 'unknown' || task.mutation.reconciliationError !== null) && <button className="button" type="button" disabled={task.mutation.reconciling} onClick={task.reconcile}>{task.mutation.reconciling ? (zh ? '正在核对…' : 'Checking…') : (zh ? '核对状态' : 'Check state')}</button>}</div> : <><TaskStatusFeedback detail={detail} mutation={task.mutation} onReconcile={task.reconcile} /><TaskAssignmentFeedback mutation={task.mutation} uncertain={task.assignmentUncertain} onReconcile={task.reconcile} /><TaskDeletionFeedback mutation={task.mutation} onReconcile={task.reconcile} />{task.mutation.error instanceof ApiError && ['status', 'assignedTo', 'delete'].includes(action ?? '') && <GoalMutationError error={task.mutation.error} action={action as 'status' | 'assignedTo' | 'delete'} />}</>}
        {edit !== null && !editOpen && task.mutation.operation?.action === 'editGoal' && (editUnsettled || task.mutation.error !== null || task.mutation.phase === 'reconciled' && task.mutation.reconciledFrom === 'unknown') && <div className="goal-edit-recovery"><p role="alert">{task.mutation.phase === 'pending' ? (zh ? '正在保存，草稿已保留。' : 'Saving; your draft is retained.') : task.mutation.phase === 'unknown' || task.mutation.reconciliationError !== null ? (zh ? '保存结果尚未确认。草稿已保留；核对状态不会重新提交。' : 'The save outcome is unknown. Your draft is retained; checking state will not resend the request.') : task.mutation.phase === 'reconciled' && task.mutation.reconciledFrom === 'unknown' ? (zh ? '已核对当前状态，原保存结果仍未确认；草稿已保留。' : 'The current state was checked, but the original save outcome remains unknown. Your draft is retained.') : (zh ? '保存未完成，草稿已保留。' : 'The save did not complete; your draft is retained.')}</p>{task.mutation.error instanceof ApiError && <GoalMutationError error={task.mutation.error} action="editGoal" outcomeUnknown={outcomeUnknown} />}{task.mutation.reconciliationError instanceof ApiError && <GoalMutationError error={task.mutation.reconciliationError} action="editGoal" outcomeUnknown={outcomeUnknown} />}{(task.mutation.phase === 'unknown' || task.mutation.reconciliationError !== null) && <button className="button" type="button" disabled={task.mutation.reconciling} onClick={task.reconcile}>{task.mutation.reconciling ? (zh ? '正在核对…' : 'Checking…') : (zh ? '核对状态' : 'Check state')}</button>}</div>}
        <div className="task-detail-panels"><div className="task-detail-tabs" role="tablist" aria-label={zh ? 'Goal 内容' : 'Goal content'}>{tabs.map(tab => <button key={tab} type="button" role="tab" className="task-detail-tab" id={`${tabPrefix}-${tab}`} aria-controls={`${tabPrefix}-panel-${tab}`} aria-selected={selection.tab === tab} tabIndex={selection.tab === tab ? 0 : -1} onClick={() => activate(tab)} onKeyDown={(event) => keyTab(event, tab)}>{labels[tab]}</button>)}</div>
          <KeptMountedSlot className="task-detail-panel goal-detail-description" id={`${tabPrefix}-panel-description`} role="tabpanel" aria-labelledby={`${tabPrefix}-description`} active={selection.tab === 'description'}>
            <div className="goal-detail-description-layout"><div className="goal-detail-description-body">
            {detail.description !== '' ? <div className="description-card"><MarkdownContent className="task-description" text={detail.description} resolveUrl={(url) => resolveMarkdownAttachmentUrl(url, base, previewRoot)} onLinkClick={(url, event) => { if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.currentTarget.hasAttribute('download') || event.currentTarget.target !== '' || /[?#]/.test(url)) return; const result = resolveAttachmentReference(url, base); if (result.kind === 'native') return; event.preventDefault(); const path = result.kind === 'relative' ? result.path : null; attachments.select(path); setSelection({ tab: 'attachments', path }); setReveal({ path }); setReference({ invalid: result.kind !== 'relative', path }); }} /></div> : <div className="state-box">{messages.inspection.detail.noDescription}</div>}
            </div>{!scopeLost && <GoalInformation detail={detail} tagsEditor={<TaskTagsEditor key={`${projectId}/${taskId}/${task.historyGeneration}`} projectId={projectId} detail={detail} tags={currentTaskTags(detail, snapshot?.summaries.get(taskId))} canMutate={task.canSetTags} mutation={task.mutation} setTags={task.setTags} reconcile={task.reconcile} />} scope={scope} graphError={graphError} onRefreshGraph={onRefreshGraph} />}</div>
          </KeptMountedSlot>
          <KeptMountedSlot className="task-detail-panel task-detail-panel-attachments" id={`${tabPrefix}-panel-attachments`} role="tabpanel" aria-labelledby={`${tabPrefix}-attachments`} active={selection.tab === 'attachments'}>{!scopeLost && <TaskAttachmentsPanel projectId={projectId} taskId={taskId} active={selection.tab === 'attachments'} attachments={attachments} reveal={reveal} navigation={reference !== null && reference.path === selection.path ? reference : null} onInteract={() => setReference(null)} onSelect={(path) => setSelection({ tab: 'attachments', path })} onRemove={(path) => { if (selection.path === path) setSelection({ ...selection, path: null }); }} {...(modal || fullscreen.active ? { keyboardOwner } : {})} {...(attachmentUrls === undefined ? {} : { urls: attachmentUrls })} />}</KeptMountedSlot>
          <KeptMountedSlot className="task-detail-panel task-detail-panel-discussion" id={`${tabPrefix}-panel-discussion`} role="tabpanel" aria-labelledby={`${tabPrefix}-discussion`} active={selection.tab === 'discussion'}><TaskDiscussion key={scopeLost ? 'retired' : 'active'} projectId={projectId} taskId={taskId} active={selection.tab === 'discussion'} parentUnavailable={scopeLost} trackDraft owner={root} onDetailsOpenChange={(open) => { threadDetails.current = open; }} /></KeptMountedSlot>
        </div><footer className="goal-detail-footer"><button className="button danger" type="button" disabled={!task.canDisplayDelete} onClick={() => { if (task.canDelete && !authRequestsPaused()) setConfirmation({ kind: 'delete', detail }); }}>{zh ? '删除 Goal' : 'Delete Goal'}</button></footer></div>
      </div>
      </TaskDetailNotifications>
    </DetailFrame>
    <DraftNavigationConfirmation owner={nestedOwner} fallbackFocus={heading} taskTitle={detail.title} />
    {!scopeLost && edit !== null && editOpen && <TaskConfirmation owner={root} fallbackFocus={heading} title={zh ? '编辑 Goal' : 'Edit Goal'} question={zh ? '修改名称和目标描述' : 'Edit the name and description'} explanation="" taskTitle="" cancelLabel={zh ? '取消' : 'Cancel'} closeLabel={zh ? '关闭编辑' : 'Close editor'} confirmLabel={zh ? '保存' : 'Save'} confirmDisabled={!task.canEditGoal || edit.title.trim() === '' || edit.version !== detail.version || editSubmitted} onCancel={() => { editRevision.current++; setEditOpen(false); if (!editUnsettled) { setEdit(null); setEditSubmitted(false); submittedEdit.current = null; } }} onConfirm={() => { if (!task.canEditGoal || authRequestsPaused() || edit.version !== detail.version || edit.title.trim() === '') return; submittedEdit.current = { title: edit.title, description: edit.description, version: edit.version, revision: editRevision.current }; setEditSubmitted(true); task.editGoal(edit.title, edit.description, edit.version); }} content={<div className="goal-edit-form"><label>{zh ? '名称' : 'Name'}<input value={edit.title} required disabled={editSubmitted} onChange={(event) => { editRevision.current++; setEdit({ ...edit, title: event.currentTarget.value }); }} /></label><label>{zh ? '目标描述' : 'Description'}<textarea rows={6} value={edit.description} disabled={editSubmitted} onChange={(event) => { editRevision.current++; setEdit({ ...edit, description: event.currentTarget.value }); }} /></label>{edit.version !== detail.version && <div role="alert"><p>{zh ? 'Goal 已更改。核对当前内容后可用最新版本保存草稿。' : 'The Goal changed. Review its current content before saving this draft against the latest version.'}</p><button className="button" type="button" onClick={() => { editRevision.current++; setEdit({ ...edit, version: detail.version }); }}>{zh ? '使用最新版本' : 'Use latest version'}</button></div>}{task.mutation.operation?.action === 'editGoal' && (task.mutation.phase === 'unknown' || task.mutation.reconciliationError !== null) && <div role="alert"><p>{zh ? '保存结果尚未确认，请核对当前状态；不会自动重新提交。' : 'The save outcome is unknown. Check the current state; the request will not be replayed.'}</p><button className="button" type="button" disabled={task.mutation.reconciling} onClick={task.reconcile}>{zh ? '核对状态' : 'Check state'}</button></div>}{task.mutation.operation?.action === 'editGoal' && task.mutation.error != null && (task.mutation.error instanceof ApiError ? <GoalMutationError error={task.mutation.error} action="editGoal" outcomeUnknown={outcomeUnknown} /> : <p role="alert">{task.mutation.phase === 'unknown' || task.mutation.reconciledFrom === 'unknown' ? (zh ? '原保存结果尚未确认。' : 'The original save outcome remains unknown.') : (zh ? '保存失败' : 'Save failed')}</p>)}</div>} />}
    {!scopeLost && confirmation !== null && <TaskConfirmation owner={root} fallbackFocus={heading} title={confirmation.kind === 'delete' ? (zh ? '删除这个 Goal？' : 'Delete this Goal?') : confirmation.status === 'done' ? (zh ? '完成这个 Goal？' : 'Complete this Goal?') : (zh ? '取消这个 Goal？' : 'Cancel this Goal?')} question={confirmation.kind === 'delete' ? (zh ? 'Goal 及其下的所有 Task 将不可见，Task 的 Parent 保留。正在执行的任务将在后续 Worker 观察中开始停止。' : 'The Goal and its tasks will become unavailable. Their Parent remains. Running tasks will begin stopping on a later Worker observation.') : (zh ? 'Task 的状态将保留；新的自动领取会跳过此 Goal，已领取的任务继续执行。' : 'Task statuses remain unchanged. New automatic claims skip this Goal; claimed tasks continue.')} explanation="" taskTitle={confirmation.detail.title} cancelLabel={zh ? '返回' : 'Back'} closeLabel={zh ? '关闭确认' : 'Close confirmation'} confirmLabel={confirmation.kind === 'delete' ? (zh ? '删除 Goal' : 'Delete Goal') : (zh ? '确认' : 'Confirm')} destructive={confirmation.kind === 'delete'} confirmDisabled={taskReviewKey(detail) !== taskReviewKey(confirmation.detail) || (confirmation.kind === 'delete' ? !task.canDelete : !task.canSetStatus)} onCancel={() => setConfirmation(null)} onConfirm={() => { if (authRequestsPaused() || taskReviewKey(detail) !== taskReviewKey(confirmation.detail)) return; if (confirmation.kind === 'delete') { if (!task.canDelete) return; task.deleteTask(confirmation.detail.version, false); } else { if (!task.canSetStatus) return; task.setStatus(confirmation.status, confirmation.detail.version); } setConfirmation(null); }} />}
    {overlayReady && !scopeLost && openChain !== null && admittedChain.current === openChain && snapshot !== null && snapshot.index.components.has(openChain) && <TaskChainDialog projectId={projectId} index={snapshot.index} summaries={snapshot.summaries} rootId={openChain} onOpenTask={openTask} {...(onNavigateExternalChain === undefined ? {} : { onNavigateExternalTask: (id: string, trigger: HTMLElement) => browserNavigation().requestAction(() => onNavigateExternalChain(id, trigger)) })} onClose={closeGraph} onRootChange={setChainRoot} onRestoreFocus={() => { if (root.current === null || isTopOverlay(root.current)) heading.current?.focus({ preventScroll: true }); }} />}
    {overlayReady && !scopeLost && <OverlayOwnerContext value={nestedOwner}>{renderNested?.(nestedOwner)}</OverlayOwnerContext>}
  </OverlayOwnerContext></TaskPauseProvider>;
  return modal ? <div className="task-detail-backdrop" onClick={(event) => { if (event.target === event.currentTarget && root.current !== null && isTopOverlay(root.current) && !threadDetails.current) requestClose(); }}>{content}</div> : content;
};

export const GoalDetailSurface = (props: GoalDetailSurfaceProps) => <TaskDraftBoundary projectId={props.projectId} taskId={props.taskId} page={props.presentation === 'page'} projectSourceSensitive={false}><GoalContent {...props} /></TaskDraftBoundary>;
