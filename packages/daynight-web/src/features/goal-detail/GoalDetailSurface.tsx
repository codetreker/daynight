import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { TaskDetail } from '../../api/types';
import { attachmentPreviewRoot } from '../../api/client';
import { browserNavigation } from '../../app/navigation';
import { isTopOverlay, OverlayOwnerContext } from '../../app/overlay';
import type { TaskDetailNavigation } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { TaskAssigneeIdentity } from '../task-assignment/TaskAssigneeIdentity';
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
import '../../styles/task-detail.css';
import './goal-detail.css';

export type GoalDetailSurfaceProps = {
  readonly projectId: string;
  readonly taskId: string;
  readonly detail: TaskDetail;
  readonly snapshot: GraphSnapshot | null;
  readonly presentation: 'dialog' | 'page';
  readonly fullscreen: DetailFullscreen;
  readonly navigation?: TaskDetailNavigation;
  readonly onNavigate?: (navigation: TaskDetailNavigation) => void;
  readonly onSelectTask: (id: string, trigger: HTMLElement) => void;
  readonly onNavigateExternalTask?: (id: string, trigger: HTMLElement) => void;
  readonly onClose?: () => void;
  readonly onRestoreFocus?: () => void;
  readonly onRefreshGraph: () => void;
  readonly graphError?: unknown;
  readonly attachmentApi?: AttachmentApi;
  readonly attachmentUrls?: AttachmentUrls;
  readonly renderNested?: (owner: RefObject<HTMLElement | null>) => ReactNode;
  readonly initialWitness?: string;
  readonly closeChain?: RefObject<(() => void) | null>;
  readonly detailError?: unknown;
  readonly detailRefreshing?: boolean;
  readonly resourceUnavailable?: boolean;
  readonly onRetryDetail?: () => void;
};

type Tab = 'overview' | 'attachments' | 'discussion';
const normalize = (navigation: TaskDetailNavigation): TaskDetailNavigation & { readonly tab: Tab } => ({ ...navigation, tab: navigation.tab === 'attachments' || navigation.tab === 'discussion' ? navigation.tab : 'overview' });

const GoalContent = ({ projectId, taskId, detail, snapshot, presentation, fullscreen, navigation, onNavigate, onSelectTask, onNavigateExternalTask, onClose, onRestoreFocus, onRefreshGraph, graphError, attachmentApi, attachmentUrls, renderNested, initialWitness, closeChain, detailError, detailRefreshing = false, resourceUnavailable = false, onRetryDetail }: GoalDetailSurfaceProps) => {
  const { locale, messages, format } = useI18n();
  const zh = locale === 'zh-CN';
  const modal = presentation === 'dialog';
  const scopeLost = resourceUnavailable || isThreadScopeLoss(detailError);
  useRetireTaskDraft(scopeLost);
  const root = useRef<HTMLElement>(null), close = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), toggle = useRef<HTMLButtonElement>(null);
  const headingId = useId(), tabPrefix = useId();
  const [local, setLocal] = useState<TaskDetailNavigation>({ tab: 'overview', path: null });
  const selection = normalize(navigation ?? local);
  const setSelection = (next: TaskDetailNavigation) => { setLocal(next); onNavigate?.(next); };
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [openChain, setOpenChain] = useState<string | null>(null);
  const [chainRoot, setChainRoot] = useState<HTMLElement | null>(null);
  const nestedOwner = useMemo<RefObject<HTMLElement | null>>(() => chainRoot === null ? root : { current: chainRoot }, [chainRoot]);
  if (closeChain !== undefined) closeChain.current = () => setOpenChain(null);
  const chainOpener = useRef<HTMLElement | null>(null);
  const threadDetails = useRef(false);
  const changeFullscreen = useDetailFullscreen(root, toggle, fullscreen);
  const requestClose = () => { if (onClose !== undefined) browserNavigation().requestAction(onClose); };
  const escape = () => { if (fullscreen.active) changeFullscreen(false); else requestClose(); };
  const actions = useRef({ escape }); actions.current = { escape };
  const keyboardOwner = useMemo<AttachmentKeyboardOwner>(() => ({ root, isActive: () => root.current !== null && isTopOverlay(root.current), onEscape: () => actions.current.escape() }), []);
  useDetailOverlay({ root, initialFocus: close, modal, fullscreen: fullscreen.active, scope: `${projectId}/${taskId}`, blocked: () => threadDetails.current, onEscape: () => actions.current.escape(), ...(onRestoreFocus === undefined ? {} : { onRestoreFocus }) });
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
  const pendingWitness = useRef<string | null>(null);
  const seenWitness = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (initialWitness === undefined || seenWitness.current === initialWitness || scope === null || !scope.taskIds.includes(initialWitness)) return;
    seenWitness.current = initialWitness;
    pendingWitness.current = initialWitness;
    const chain = scope.chains.find((candidate) => candidate.memberIds.includes(initialWitness));
    if (chain !== undefined) setExpanded(current => new Set([...current, chain.representativeId]));
    if (selection.tab !== 'overview') setSelection({ ...selection, tab: 'overview' });
  }, [initialWitness, snapshot]);
  useLayoutEffect(() => {
    const id = pendingWitness.current;
    if (id === null || selection.tab !== 'overview') return;
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[data-goal-task-id]') ?? [])].find(element => element.dataset.goalTaskId === id);
    if (target === undefined || target.closest('[hidden], [inert]') !== null) return;
    pendingWitness.current = null;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest' });
  });
  const openTask = (id: string, trigger: HTMLElement) => {
    if (snapshot?.index.nodes.get(id)?.parentId === taskId || onNavigateExternalTask === undefined) onSelectTask(id, trigger);
    else browserNavigation().requestAction(() => { setOpenChain(null); onNavigateExternalTask(id, trigger); });
  };
  const tabs: readonly Tab[] = ['overview', 'attachments', 'discussion'];
  const labels: Record<Tab, string> = { overview: zh ? 'Task' : 'Tasks', attachments: messages.inspection.attachments.title, discussion: messages.inspection.discussion.title };
  const activate = (tab: Tab) => { setSelection({ ...selection, tab }); document.getElementById(`${tabPrefix}-${tab}`)?.focus(); };
  const keyTab = (event: KeyboardEvent<HTMLButtonElement>, tab: Tab) => {
    let next: Tab;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]!;
    else if (event.key === 'Home') next = tabs[0]!;
    else if (event.key === 'End') next = tabs[tabs.length - 1]!;
    else return;
    event.preventDefault(); activate(next);
  };
  const rows = (ids: readonly string[]) => <ul className="goal-detail-tasks">{ids.map((id) => {
    const task = snapshot!.index.nodes.get(id)!;
    return <li key={id}><button type="button" className="goal-detail-task" data-goal-task-id={id} onClick={(event) => onSelectTask(id, event.currentTarget)}><span className={`goal-detail-dot graph-status-${task.status}`} aria-hidden="true" /><span className="goal-detail-task-title">{task.titlePreview}{task.titleTruncated ? '…' : ''}</span><TaskAssigneeIdentity projectId={projectId} assignedTo={task.assignedTo} compact /><span>{messages.common.status[task.status]}</span></button></li>;
  })}</ul>;
  const content = <OverlayOwnerContext value={root}>
    <DetailFrame root={root} modal={modal} headingId={headingId} className={`${modal ? 'task-detail-dialog' : 'task-detail-page'} goal-detail-surface${fullscreen.active ? ' task-detail-fullscreen' : ''}`}>
      {!modal && !fullscreen.active && <TaskDetailPageBar projectId={projectId} />}
      <header className="task-detail-header"><div className="task-detail-title-row"><h2 id={headingId} className="task-detail-title" ref={heading} tabIndex={0}>{scopeLost ? messages.inspection.detail.failed : detail.title}</h2></div><div className="task-detail-header-actions"><button className="button task-detail-fullscreen-toggle" type="button" ref={toggle} aria-label={fullscreen.active ? messages.inspection.detail.exitFullscreen : messages.inspection.detail.enterFullscreen} title={fullscreen.active ? messages.inspection.detail.exitFullscreen : messages.inspection.detail.enterFullscreen} aria-pressed={fullscreen.active} onClick={() => changeFullscreen(!fullscreen.active)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={fullscreen.active ? 'M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} /></svg></button>{modal && <button className="button task-detail-close" type="button" ref={close} aria-label={messages.inspection.detail.close} onClick={requestClose}>×</button>}</div></header>
      <div className="task-detail-body">{detailError != null && <div className="task-detail-state task-detail-error" role="alert"><p>{messages.inspection.detail.refreshFailed}</p><button className="button" type="button" onClick={onRetryDetail} disabled={detailRefreshing}>{messages.inspection.detail.retry}</button></div>}<div className="goal-detail-content" hidden={scopeLost} inert={scopeLost}><div className="goal-detail-meta"><span className={`graph-status graph-status-${detail.status}`}>{messages.common.status[detail.status]}</span><TaskAssigneeIdentity projectId={projectId} assignedTo={detail.assignedTo} />{scope !== null && <span>{messages.graph.progress(scope.progress)} · {zh ? `${format.number(scope.progress.unfinished)} 未结束` : `${format.number(scope.progress.unfinished)} unfinished`}</span>}</div>
        <div className="task-detail-panels"><div className="task-detail-tabs" role="tablist" aria-label={zh ? 'Goal 内容' : 'Goal content'}>{tabs.map(tab => <button key={tab} type="button" role="tab" className="task-detail-tab" id={`${tabPrefix}-${tab}`} aria-controls={`${tabPrefix}-panel-${tab}`} aria-selected={selection.tab === tab} tabIndex={selection.tab === tab ? 0 : -1} onClick={() => activate(tab)} onKeyDown={(event) => keyTab(event, tab)}>{labels[tab]}</button>)}</div>
          <KeptMountedSlot className="task-detail-panel goal-detail-overview" id={`${tabPrefix}-panel-overview`} role="tabpanel" aria-labelledby={`${tabPrefix}-overview`} active={selection.tab === 'overview'}>
            {detail.description !== '' && <MarkdownContent className="task-description" text={detail.description} resolveUrl={(url) => resolveMarkdownAttachmentUrl(url, base, previewRoot)} onLinkClick={(url, event) => { if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.currentTarget.hasAttribute('download') || event.currentTarget.target !== '' || /[?#]/.test(url)) return; const result = resolveAttachmentReference(url, base); if (result.kind === 'native') return; event.preventDefault(); const path = result.kind === 'relative' ? result.path : null; attachments.select(path); setSelection({ tab: 'attachments', path }); setReveal({ path }); setReference({ invalid: result.kind !== 'relative', path }); }} />}
            {graphError != null && <div role="alert"><p>{messages.workspace.project.refreshFailed}</p><button className="button" type="button" onClick={onRefreshGraph}>{messages.workspace.project.retryRefresh}</button></div>}
            {scope === null ? <div className="task-detail-state" role="status">{messages.inspection.detail.loading}</div> : scope.taskIds.length === 0 ? <div className="state-box">{zh ? '暂无 Task' : 'No tasks yet'}</div> : <>
              {scope.chains.map(({ representativeId, memberIds }) => { const task = snapshot!.index.nodes.get(representativeId)!; const isOpen = expanded.has(representativeId); return <section className="goal-detail-chain" key={representativeId}><div className="goal-detail-chain-header"><button type="button" className="goal-detail-disclosure" aria-expanded={isOpen} onClick={() => setExpanded(current => { const next = new Set(current); if (next.has(representativeId)) next.delete(representativeId); else next.add(representativeId); return next; })}><span aria-hidden="true">{isOpen ? '▾' : '▸'}</span><span>{task.titlePreview}{task.titleTruncated ? '…' : ''}<small>{zh ? `当前范围 ${format.number(memberIds.length)} 个 Task` : `${format.number(memberIds.length)} tasks in this goal`}</small></span></button><button type="button" className="button" onClick={(event) => { chainOpener.current = event.currentTarget; setOpenChain(representativeId); }}>{messages.graph.viewDependencies}</button></div><div hidden={!isOpen}>{rows(memberIds)}</div></section>; })}
              {scope.standaloneIds.length > 0 && <><h3>{zh ? '独立 Task' : 'Standalone tasks'}</h3>{rows(scope.standaloneIds)}</>}
            </>}
          </KeptMountedSlot>
          <KeptMountedSlot className="task-detail-panel task-detail-panel-attachments" id={`${tabPrefix}-panel-attachments`} role="tabpanel" aria-labelledby={`${tabPrefix}-attachments`} active={selection.tab === 'attachments'}><TaskAttachmentsPanel projectId={projectId} taskId={taskId} active={selection.tab === 'attachments'} attachments={attachments} reveal={reveal} navigation={reference !== null && reference.path === selection.path ? reference : null} onInteract={() => setReference(null)} onSelect={(path) => setSelection({ tab: 'attachments', path })} onRemove={(path) => { if (selection.path === path) setSelection({ ...selection, path: null }); }} {...(modal || fullscreen.active ? { keyboardOwner } : {})} {...(attachmentUrls === undefined ? {} : { urls: attachmentUrls })} /></KeptMountedSlot>
          <KeptMountedSlot className="task-detail-panel task-detail-panel-discussion" id={`${tabPrefix}-panel-discussion`} role="tabpanel" aria-labelledby={`${tabPrefix}-discussion`} active={selection.tab === 'discussion'}><TaskDiscussion key={scopeLost ? 'retired' : 'active'} projectId={projectId} taskId={taskId} active={selection.tab === 'discussion'} parentUnavailable={scopeLost} trackDraft owner={root} onDetailsOpenChange={(open) => { threadDetails.current = open; }} /></KeptMountedSlot>
        </div></div>
      </div>
    </DetailFrame>
    <DraftNavigationConfirmation owner={nestedOwner} fallbackFocus={heading} taskTitle={detail.title} />
    {!scopeLost && openChain !== null && snapshot !== null && snapshot.index.components.has(openChain) && <TaskChainDialog projectId={projectId} index={snapshot.index} summaries={snapshot.summaries} rootId={openChain} onOpenTask={openTask} onNavigateExternalTask={openTask} onClose={() => setOpenChain(null)} onRootChange={setChainRoot} onRestoreFocus={() => { if (root.current !== null && !isTopOverlay(root.current)) return; const opener = chainOpener.current; if (opener?.isConnected && !opener.closest('[inert], [hidden]')) opener.focus({ preventScroll: true }); else heading.current?.focus({ preventScroll: true }); }} />}
    {!scopeLost && <OverlayOwnerContext value={nestedOwner}>{renderNested?.(nestedOwner)}</OverlayOwnerContext>}
  </OverlayOwnerContext>;
  return modal ? <div className="task-detail-backdrop" onClick={(event) => { if (event.target === event.currentTarget && root.current !== null && isTopOverlay(root.current) && !threadDetails.current) requestClose(); }}>{content}</div> : content;
};

export const GoalDetailSurface = (props: GoalDetailSurfaceProps) => <TaskDraftBoundary projectId={props.projectId} taskId={props.taskId} page={props.presentation === 'page'}><GoalContent {...props} /></TaskDraftBoundary>;
