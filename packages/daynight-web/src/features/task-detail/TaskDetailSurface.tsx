import { TaskPauseControl, TaskPauseFeedback } from "../task-pause/TaskPauseControl";
import { ProjectAccessBoundary, useProjectAccess } from "../projects/ProjectAccess";
import { isThreadScopeLoss } from '../task-thread/api';
import { TaskDiscussion } from '../task-thread/TaskDiscussion';
import { readPullRequests, readTaskPaused, readWorkerClaim } from "../../api/task-properties";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, authRequestsPaused } from '../../api/client';
import { navigate, taskDetailUrl, type TaskDetailNavigation } from '../../app/router';
import { browserNavigation } from '../../app/navigation';
import { DraftNavigationConfirmation, TaskDraftBoundary, useDraftNavigationDecision, useRetireTaskDraft } from './TaskDraftNavigation';
import { LanguageSelector } from '../../i18n/LanguageSelector';
import type { AttachmentKeyboardOwner } from './attachments/AttachmentPreview';
import type { AttachmentApi } from './attachments/useAttachments';
import type { AttachmentUrls } from './attachments/TaskAttachments';
import { useI18n } from '../../i18n/LocaleProvider';
import { useBodyScrollLock } from '../../app/useBodyScrollLock';
import type { GraphSnapshot } from '../projects/useTaskGraph';
import { isTaskStale } from './freshness';
import { dialogFocusables } from './focus';
import { useTaskDetail } from './useTaskDetail';
import { useTaskRelations } from './useTaskRelations';
import type { TaskObservationInput } from './TaskDetailSession';
import { TaskStatusFeedback, TaskStatusMenu } from './TaskStatus';
import { matchesAgentPermissionReview, TaskAgentPermissionConfirmation, TaskAgentPermissionFeedback, TaskAgentPermissionSwitch, type AgentPermissionConfirmation } from './TaskAgentPermission';
import { matchesStatusReview, TaskStatusConfirmation, type StatusConfirmation } from './TaskStatusConfirmation';
import { useSessionMessages } from '../task-agent-session/messages';
import { SessionFullscreenContext, type SessionFullscreenRegistration } from '../task-agent-session/useSessionFullscreen';
import { TaskSessionHost, ManagedSessionRecords, useTaskSessionRecords } from '../task-agent-session/TaskSessionHost';
import { TaskStepsPanel } from './steps/TaskStepsPanel';
import { TaskDetailReading } from './TaskDetailReading';
import { TaskDetailActions } from './TaskDetailActions';
import { matchesPlatformReview, TaskPlatformConfirmation, TaskPlatformFeedback, TaskPlatformSelect, type PlatformConfirmation } from './TaskPlatform';
import { TaskId } from './TaskId';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { useProjectMembers } from '../projects/ProjectMembers';
import { mayWithdrawClaim, matchesWithdrawalReview, TaskClaimSummary, TaskWithdrawalConfirmation, TaskWithdrawalFeedback, type WithdrawalConfirmation } from './TaskClaim';
import { TaskCopyButton } from './TaskCopyButton';
import { matchesDeletionReview, TaskDeletionConfirmation, TaskDeletionFeedback, type DeletionConfirmation } from './TaskDeletion';
import { TaskPullRequests } from './TaskPullRequests';
import { TaskDetailNotice, TaskDetailNotifications } from './TaskDetailNotice';
import { ProjectGraphErrorDetail } from '../projects/ProjectGraphError';
import { TaskAssigneeSelect } from '../task-assignment/TaskAssigneeSelect';
import { TaskAssignmentFeedback } from '../task-assignment/TaskAssignmentFeedback';
import '../../styles/task-detail.css';

export type DetailFullscreen = {
  readonly active: boolean;
  readonly onChange: (active: boolean) => void;
};

type TaskDetailCommonProps = {
  readonly fullscreen: DetailFullscreen;
  readonly attachmentApi?: AttachmentApi;
  readonly attachmentUrls?: AttachmentUrls;
  readonly detailUrl?: (taskId: string, navigation: TaskDetailNavigation) => string;
  readonly projectId: string;
  readonly taskId: string;
  readonly snapshot?: GraphSnapshot | null;
  readonly observation?: TaskObservationInput;
  readonly graphError?: unknown;
  readonly onSelectTask: (id: string) => void;
  readonly onRefreshGraph: () => void;
};
export type TaskDetailSurfaceProps = TaskDetailCommonProps & ({
  readonly presentation: 'dialog';
  readonly navigation?: TaskDetailNavigation;
  readonly onNavigate?: (navigation: TaskDetailNavigation) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus: () => void;
} | {
  readonly presentation: 'page';
  readonly navigation: TaskDetailNavigation;
  readonly onNavigate: (navigation: TaskDetailNavigation) => void;
  readonly onClose?: never;
  readonly onRestoreFocus?: never;
});

export const TaskDetailPageBar = ({ projectId }: { readonly projectId: string }) => {
  const { messages } = useI18n();
  return <div className="task-detail-page-topbar"><a className="task-detail-page-back" href={`/projects/${encodeURIComponent(projectId)}`} onClick={followProjectLink}>{messages.inspection.detail.returnToProject}</a><LanguageSelector renderNotice={(notice, issue) => <TaskDetailNotice event={issue} tone="warning" recoverable>{notice}</TaskDetailNotice>} /></div>;
};

const followProjectLink: import('react').MouseEventHandler<HTMLAnchorElement> = (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(event.currentTarget.href);
};

const TaskDetailError = ({ error }: { readonly error: unknown }) => {
  const { messages } = useI18n();
  const m = messages.inspection.detail;
  return <>
    <p>{error instanceof ApiError && error.kind === 'network'
      ? m.networkError
      : error instanceof ApiError && error.code === 'not_found' ? m.notFoundError : m.loadError}</p>
    {error instanceof ApiError && error.requestId !== null && (
      <p className="request-id">{messages.common.requestId}{' '}<code>{error.requestId}</code></p>
    )}
  </>;
};

const TaskDetailContent = ({ projectId, taskId, snapshot = null, observation, onSelectTask, onClose, onRestoreFocus, onRefreshGraph, presentation, navigation, onNavigate, attachmentApi, attachmentUrls, detailUrl, graphError = null, fullscreen }: TaskDetailSurfaceProps) => {
  const sessionMessages = useSessionMessages();
  const modal = presentation === 'dialog';
  const requestClose = () => { if (onClose !== undefined) browserNavigation().requestAction(onClose); };
  const scope = `${projectId}/${taskId}`;
  const [localNavigation, setLocalNavigation] = useState<{ readonly scope: string; readonly value: TaskDetailNavigation }>({ scope, value: { tab: 'overview', path: null } });
  const selection = navigation === undefined ? localNavigation.scope === scope ? localNavigation.value : { tab: 'overview', path: null } as const : navigation;
  const changeSelection = (next: TaskDetailNavigation) => { setLocalNavigation({ scope, value: next }); onNavigate?.(next); };
  const popout = detailUrl === undefined ? taskDetailUrl(projectId, taskId, selection) : detailUrl(taskId, selection);
  const Surface = modal ? 'section' : 'main';
  const { messages, format } = useI18n();
  const m = messages.inspection.detail;
  const input: TaskObservationInput = observation ?? (snapshot === null ? { kind: 'direct' } : { kind: 'project-summary', revision: snapshot.revision, task: snapshot.index.nodes.get(taskId) });
  const task = useTaskDetail(projectId, taskId, input);
  const direct = input.kind === 'direct';
  const relations = useTaskRelations(projectId, taskId, task.historyGeneration, direct && task.detail !== null && !task.displayRequiresFreshRead && task.mutation.phase !== 'pending');
  const nodes = direct ? relations.relations?.nodes : snapshot?.index.nodes;
  const refreshRelations = direct ? relations.refresh : onRefreshGraph;
  const { detail, status, error, retry } = task;
  const readingScope = useRef<string | null>(null);
  const readingIdentity = `${scope}/${task.historyGeneration}`;
  if (readingScope.current !== null && readingScope.current !== readingIdentity) readingScope.current = null;
  if (detail !== null) readingScope.current = readingIdentity;
  if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'task_deleted')) readingScope.current = null;
  const worker = detail === null ? undefined : readWorkerClaim(detail.properties);
  const sessionRecords = useTaskSessionRecords(projectId, taskId, detail !== null && (worker === undefined || direct && selection.tab === 'attachments'), direct, worker === undefined);
  const hasSession = useRef(false);
  const sessionScope = useRef(readingIdentity);
  if (sessionScope.current !== readingIdentity) { sessionScope.current = readingIdentity; hasSession.current = false; }
  if (detail !== null) hasSession.current = worker !== undefined || !sessionRecords.confirmedEmpty || sessionRecords.error !== null || sessionRecords.denied;
  const currentClaim = worker !== undefined && worker.state !== 'completed' ? worker : null;
  const membership = useProjectMembers(projectId, currentClaim !== null);
  const viewer = useTaskCacheScope();
  const access = useProjectAccess(projectId);
  useRetireTaskDraft(task.status === 'deleted' || access.status === 'unavailable');
  useEffect(() => { if (currentClaim !== null && access.status === 'loading') void access.session.revalidate(); }, [currentClaim !== null, access.status, access.session]);
  const mayWithdraw = currentClaim !== null && access.ready && mayWithdrawClaim(currentClaim, viewer.userId, access.access!.effectiveRole);
  const mayDisplayWithdraw = currentClaim !== null && access.status === 'ready' && access.access !== null && mayWithdrawClaim(currentClaim, viewer.userId, access.access.effectiveRole);
  type TaskConfirmationState = DeletionConfirmation | StatusConfirmation | WithdrawalConfirmation | (AgentPermissionConfirmation & { readonly kind: 'allowAgents' }) |
    (PlatformConfirmation & { readonly kind: 'requiredPlatform' });
  const [confirmation, setConfirmation] = useState<TaskConfirmationState | null>(null);
  const requestConfirmation = (review: TaskConfirmationState): void => setConfirmation((current) => current === null ? review : current);
  const confirmationValid = confirmation !== null && (confirmation.kind === 'delete'
    ? matchesDeletionReview(confirmation, detail) && task.canDisplayDelete
    : confirmation.kind === 'withdraw'
    ? matchesWithdrawalReview(confirmation, detail) && task.canDisplayWithdrawClaim && mayDisplayWithdraw
    : confirmation.kind === 'status'
    ? matchesStatusReview(confirmation, detail) && task.canDisplayStatus
    : confirmation.kind === 'allowAgents' ? matchesAgentPermissionReview(confirmation, detail) && task.canDisplayAgentPermission
      : matchesPlatformReview(confirmation, detail) && task.canDisplayRequiredPlatform);
  const confirmationAdmitted = confirmation !== null && (confirmation.kind === 'delete' ? task.canDelete
    : confirmation.kind === 'withdraw' ? task.canWithdrawClaim && mayWithdraw
    : confirmation.kind === 'status' ? task.canSetStatus
    : confirmation.kind === 'allowAgents' ? task.canSetAgentPermission : task.canSetRequiredPlatform);
  const draftDecision = useDraftNavigationDecision();
  const [stepConfirmationOpen, setStepConfirmationOpen] = useState(false);
  const confirmationOpen = draftDecision !== null || stepConfirmationOpen || confirmation !== null && confirmationValid;
  useLayoutEffect(() => { if (draftDecision !== null) setConfirmation(null); }, [draftDecision]);
  const threadDetailsOccupied = useRef(false);
  const [sessionLayoutChanged, setSessionLayoutChanged] = useState(false);
  const [sessionFullscreen, setSessionFullscreen] = useState<SessionFullscreenRegistration | null>(null);
  const sessionFullscreenRef = useRef(sessionFullscreen); sessionFullscreenRef.current = sessionFullscreen;
  const registerSessionFullscreen = useCallback((registration: SessionFullscreenRegistration) => {
    setSessionLayoutChanged(true);
    setSessionFullscreen(registration);
    return () => setSessionFullscreen(current => current?.owner === registration.owner ? null : current);
  }, []);
  useLayoutEffect(() => { if (confirmation !== null && !confirmationValid) setConfirmation(null); }, [confirmation, confirmationValid]);
  const confirm = (): void => {
    if (confirmation === null || !confirmationValid || !confirmationAdmitted || authRequestsPaused()) return;
    if (confirmation.kind === 'withdraw') {
      const admitted = access.session.snapshot();
      if (admitted.status !== 'ready' || admitted.refreshing || currentClaim === null || !mayWithdrawClaim(currentClaim, viewer.userId, admitted.access!.effectiveRole)) return;
    }
    setConfirmation(null);
    if (confirmation.kind === 'delete') task.deleteTask(confirmation.detail.version, confirmation.removeDepends);
    else if (confirmation.kind === 'withdraw') task.withdrawClaim(confirmation.claimId, confirmation.detail.version);
    else if (confirmation.kind === 'status') task.setStatus(confirmation.status, confirmation.detail.version);
    else if (confirmation.kind === 'allowAgents') task.setAgentPermission(confirmation.allowAgents, confirmation.detail.version);
    else task.setRequiredPlatform(confirmation.requiredPlatform, confirmation.detail.version);
  };
  const headingId = useId();
  const automationFeedbackId = useId();
  const platformFeedbackId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const fullscreenRef = useRef<HTMLButtonElement>(null);
  const pendingLayout = useRef<readonly { readonly element: HTMLElement; readonly top: number; readonly left: number }[] | null>(null);
  const changeFullscreen = (active: boolean) => {
    // Capture before the browser clamps offsets to the new viewport's scroll range.
    pendingLayout.current = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>('*'))
      .filter((element) => element instanceof HTMLElement && (element.scrollTop !== 0 || element.scrollLeft !== 0 || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth))
      .map((element) => ({ element, top: element.scrollTop, left: element.scrollLeft }));
    fullscreen.onChange(active);
  };
  useLayoutEffect(() => {
    if (pendingLayout.current === null) return;
    for (const { element, top, left } of pendingLayout.current) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    pendingLayout.current = null;
    if (!fullscreen.active) fullscreenRef.current!.focus({ preventScroll: true });
  }, [fullscreen.active]);
  const onEscape = () => {
    if (confirmationOpen || threadDetailsOccupied.current) return;
    if (sessionFullscreenRef.current !== null) { sessionFullscreenRef.current.exit(); return; }
    if (fullscreen.active) changeFullscreen(false);
    else requestClose();
  };
  const callbacks = useRef({ onEscape, onRestoreFocus, confirmationOpen });
  callbacks.current = { onEscape, onRestoreFocus, confirmationOpen };
  const keyboardOwner = useMemo<AttachmentKeyboardOwner>(() => ({ root: dialogRef, onEscape: () => callbacks.current.onEscape() }), []);
  useBodyScrollLock(modal);

  useLayoutEffect(() => {
    if (!modal) { dialogRef.current!.focus(); return; }
    const root = document.getElementById('root');
    if (root === null) throw new Error('The application root is required for the task detail dialog.');
    const wasInert = root.hasAttribute('inert');
    root.setAttribute('inert', '');
    closeRef.current!.focus();

    return () => { if (!wasInert) root.removeAttribute('inert'); };
  }, [projectId, modal]);

  useLayoutEffect(() => {
    if (!modal && !fullscreen.active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (callbacks.current.confirmationOpen || threadDetailsOccupied.current || sessionFullscreenRef.current !== null || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        callbacks.current.onEscape();
      } else if (event.key === 'Tab' && modal) {
        const dialog = dialogRef.current!;
        const buttons = dialogFocusables(dialog);
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        const active = document.activeElement;
        if (!dialog.contains(active) || (!event.shiftKey && active === last)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [projectId, modal, fullscreen.active]);

  useEffect(() => () => {
    // Restore after sibling DOM removals so a disappearing trigger cannot capture focus.
    if (modal) callbacks.current.onRestoreFocus!();
  }, []);

  useLayoutEffect(() => {
    if (modal && !confirmationOpen && !threadDetailsOccupied.current && sessionFullscreenRef.current === null && !dialogRef.current!.contains(document.activeElement)) closeRef.current!.focus();
  }, [taskId, status, error, snapshot?.revision, confirmationOpen]);

  const snapshotNode = snapshot?.index.nodes.get(taskId);
  const retainedDetail = detail !== null && (error !== null || task.displayRequiresFreshRead);
  const stale = !direct && (task.graphMismatch || detail !== null && !task.refreshing && !retainedDetail && isTaskStale(snapshotNode, detail));
  const readNoticeEvent = useMemo(() => ({}), [error, retainedDetail]);
  const staleNoticeEvent = useMemo(() => ({}), [stale]);
  const successors = direct ? relations.relations?.successors : snapshot?.index.successors.get(taskId);
  const relation = (id: string, external: boolean) => {
    const node = nodes?.get(id);
    const title = node === undefined ? id : `${node.titlePreview}${node.titleTruncated ? '…' : ''}`;
    const kind = external ? m.externalDependency : m.ordinaryDependency;
    return (
      <li key={id}>
        <button className="task-detail-relation" type="button" aria-label={m.relationLabel({ title, kind })} onClick={() => browserNavigation().requestAction(() => onSelectTask(id))}>
          <span className={`task-detail-relation-dot${node === undefined ? '' : ` task-detail-dot-${node.status}`}`} aria-hidden="true" />
          <span>{title}</span>
          <span className={`task-detail-relation-kind${external ? ' task-detail-relation-external' : ''}`}>{kind}</span>
          <span className="task-detail-relation-arrow" aria-hidden="true">↗</span>
        </button>
      </li>
    );
  };

  const content = <SessionFullscreenContext value={registerSessionFullscreen}>
      <Surface className={`${modal ? 'task-detail-dialog' : 'task-detail-page'}${fullscreen.active ? ' task-detail-fullscreen' : ''}${sessionFullscreen === null ? '' : ' task-detail-session-fullscreen'}${sessionLayoutChanged ? ' task-detail-session-layout' : ''}${currentClaim === null ? '' : ' task-detail-has-claim'}`} ref={dialogRef} role={modal ? 'dialog' : undefined} aria-modal={modal ? true : undefined} aria-labelledby={headingId} tabIndex={modal ? undefined : -1}>
        <TaskDetailNotifications fallbackFocus={titleRef}>
        {!modal && <div hidden={fullscreen.active}><TaskDetailPageBar projectId={projectId} /></div>}
        <header className="task-detail-header">
          <div className="task-detail-title-row">
            <h2 id={headingId} className="task-detail-title" ref={titleRef} tabIndex={detail === null ? -1 : 0} title={detail?.title}>{detail === null ? status === 'deleted' ? messages.inspection.deletion.deleted : status === 'error' ? m.failed : m.loading : detail.title}</h2>
            {detail !== null && <TaskCopyButton key={`${scope}/${detail.title}`} value={detail.title} label={m.copyTaskTitle} failure={m.copyTitleFailed} />}
          </div>
          <div className="task-detail-header-actions">
            {!modal && fullscreen.active && <a className="button task-detail-project-return" href={`/projects/${encodeURIComponent(projectId)}`} onClick={followProjectLink}>{m.returnToProject}</a>}
            <button className="button task-detail-fullscreen-toggle" type="button" ref={fullscreenRef} aria-label={fullscreen.active ? m.exitFullscreen : m.enterFullscreen} title={fullscreen.active ? m.exitFullscreen : m.enterFullscreen} aria-pressed={fullscreen.active} onClick={() => changeFullscreen(!fullscreen.active)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={fullscreen.active ? 'M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} /></svg>
            </button>
            {(modal || detail !== null) && <TaskDetailActions key={scope} {...(modal ? { popout } : {})} canDelete={task.canDisplayDelete} {...(detail === null ? {} : { onDelete: () => requestConfirmation({ kind: 'delete', detail, removeDepends: true }) })} />}
            {modal ? <button className="button task-detail-close" type="button" ref={closeRef} aria-label={m.close} onClick={requestClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button> : null}
          </div>
        </header>
        <div className="task-detail-body">
          {status === 'loading' && (
            <div className="task-detail-state" role="status" aria-label={m.loading}><span className="spinner" aria-hidden="true" /></div>
          )}
          {status === 'deleted' && <div className="task-detail-state task-detail-deleted" role="status"><p>{messages.inspection.deletion.deletedExplanation}</p><a className="button" href={`/projects/${encodeURIComponent(projectId)}`} onClick={followProjectLink}>{m.returnToProject}</a></div>}
          {status === 'error' && (
            <div className="task-detail-state task-detail-error" role="alert" aria-labelledby={headingId}>
              <TaskDetailError error={error} />
              <button className="button primary" type="button" onClick={retry}>{m.retry}</button>
            </div>
          )}
          {detail !== null && (
            <>
              <div className={`task-detail-heading${currentClaim === null ? '' : ' task-detail-heading-claimed'}`} {...(currentClaim === null ? {} : { tabIndex: 0, role: 'region', 'aria-label': messages.inspection.claim.controls })}>
                <div className="task-detail-status-row">
                  <div className="task-detail-badges">
                    <div className="task-detail-state-controls">
                      <div className="task-detail-status-assignee">
                        <TaskStatusMenu status={detail.status} disabled={!task.canDisplayStatus} onSelect={(status) => requestConfirmation({ kind: 'status', status, detail })} />
                        <TaskAssigneeSelect direct={direct} projectId={projectId} detail={detail} disabled={!task.canDisplayAssignee} selectionBlocked={direct && authRequestsPaused()} owner={dialogRef} resetKey={`${taskId}/${task.historyGeneration}/${fullscreen.active}`} onSelect={(assignedTo) => task.setAssignedTo(assignedTo, detail.version)} />
                      </div>
                      <TaskPlatformSelect detail={detail} disabled={!task.canDisplayRequiredPlatform} describedBy={platformFeedbackId}
                        onReview={(requiredPlatform) => requestConfirmation({ kind: 'requiredPlatform', detail, requiredPlatform })} />
                    </div>
                    {worker !== undefined && <span className="task-detail-execution-mode">{worker.agentControlMode === 'web' ? sessionMessages.web : sessionMessages.herdr}</span>}
                    {detail.status === 'todo' && <span className={detail.ready ? 'task-detail-ready' : 'task-detail-blocked'}>{detail.ready ? m.ready : m.blocked}</span>}
                  </div>
                  {task.assignmentUncertain ? <span className="task-assignment-uncertain" role="status">{messages.assignment.uncertain}</span> : <TaskAgentPermissionSwitch detail={detail} disabled={!task.canDisplayAgentPermission} describedBy={automationFeedbackId}
                    onClick={() => requestConfirmation({ kind: 'allowAgents', detail, allowAgents: !detail.allowAgents })} />}
                </div>
                <TaskPauseControl paused={readTaskPaused(detail.properties) === true} disabled={!task.canUnpause} mutation={task.mutation} onUnpause={() => task.unpause(detail.version)} fallbackFocus={titleRef} />
                {currentClaim !== null && access.error !== null && <div role="alert"><TaskDetailError error={access.error} /><button className="button" type="button" onClick={() => { void access.session.revalidate(); }}>{messages.workspace.projects.retry}</button></div>}
                {currentClaim !== null && <TaskClaimSummary worker={currentClaim} members={membership.members} membershipStatus={membership.status} membershipError={membership.error} onRetryMembers={membership.retry} profileRecoveryUrl={popout}
                  canWithdraw={task.canWithdrawClaim && mayWithdraw} {...(mayWithdraw ? { onWithdraw: () => { if (authRequestsPaused()) return; const review = { kind: 'withdraw' as const, detail, claimId: currentClaim.claimId }; void access.session.revalidate().then((fresh) => { if (fresh !== null && dialogRef.current?.isConnected && mayWithdrawClaim(currentClaim, viewer.userId, fresh.effectiveRole)) requestConfirmation(review); }); } } : {})} />}
              </div>
            </>
          )}
          {readingScope.current === readingIdentity && status !== 'deleted' && access.status !== 'unavailable' && !viewer.isInvalidated && <TaskDetailReading key={`${readingIdentity}`} projectId={projectId} taskId={taskId} available={detail !== null} description={detail?.description ?? ''} steps={(active, renderMarkdown) => <TaskStepsPanel projectId={projectId} taskId={taskId} active={active} available={detail !== null} renderMarkdown={renderMarkdown} confirmationOwner={dialogRef} confirmationFallback={titleRef} onConfirmationChange={setStepConfirmationOpen} />} discussion={(active: boolean) => <TaskDiscussion projectId={projectId} taskId={taskId} active={active} parentUnavailable={isThreadScopeLoss(error)} owner={dialogRef} onDetailsOpenChange={(open) => { threadDetailsOccupied.current = open; }} />} {...(hasSession.current ? { session: (active: boolean) => <TaskSessionHost direct={direct} {...(worker === undefined ? {} : { mode: worker.agentControlMode, claimId: worker.claimId })} projectId={projectId} taskId={taskId} records={sessionRecords} completed={detail?.status === 'done' || worker !== undefined && worker.state !== 'active'} active={active} current={direct ? task.sessionCurrent : !task.requiresFreshRead && task.status === 'ready' && task.error === null} /> } : {})} sessionRecords={(active, render, resetSelection) => <ManagedSessionRecords direct={direct} projectId={projectId} taskId={taskId} active={active} resetSelection={resetSelection} {...(direct ? { records: sessionRecords } : {})}>{render}</ManagedSessionRecords>} selection={selection} onSelectionChange={changeSelection} requireCompleteInventory={!modal} {...(modal || fullscreen.active ? { keyboardOwner } : {})} {...(attachmentApi === undefined ? {} : { api: attachmentApi })} {...(attachmentUrls === undefined ? {} : { urls: attachmentUrls })} overview={(description) => detail === null ? null : <>
                <div className="task-detail-columns">
                  <div className="task-detail-main">
                    <section className="task-detail-section" aria-label={m.description}>
                      <h4>{m.description}</h4>
                      {description}
                    </section>
                    <TaskPullRequests pullRequests={readPullRequests(detail.properties)} />
                  </div>
                  <aside className="task-detail-aside" aria-label={m.relationsMetadata}>
                    {direct && relations.error !== null && <div role="alert"><ProjectGraphErrorDetail error={relations.error} /><button className="button" type="button" onClick={refreshRelations}>{m.retry}</button></div>}
                    <section className="task-detail-section" aria-label={m.dependencies}>
                      <h4>{m.countedHeading({ label: m.dependencies, count: format.number(detail.dependsOn.length) })}</h4>
                      {detail.dependsOn.length === 0 ? <p className="task-detail-description">{m.noDependencies}</p> : <ul className="task-detail-relations">{detail.dependsOn.map((id) => relation(id, detail.externalDependsOn.includes(id)))}</ul>}
                    </section>
                    <section className="task-detail-section" aria-label={m.blockers}>
                      <h4>{m.countedHeading({ label: m.blockers, count: format.number(detail.blockedBy.length) })}</h4>
                      {detail.blockedBy.length === 0 ? <p className="task-detail-description">{m.noBlockers}</p> : <ul className="task-detail-relations">{detail.blockedBy.map((id) => relation(id, detail.externalDependsOn.includes(id)))}</ul>}
                    </section>
                    <section className="task-detail-section" aria-label={m.successors}>
                      <h4>{direct || successors === undefined ? m.successors : m.countedHeading({ label: m.successors, count: format.number(successors.length) })}</h4>
                      {direct && successors !== undefined && <p className="task-detail-description">{m.successorsPartial}</p>}
                      {successors === undefined
                        ? <p className="task-detail-description">{m.successorsMissing}</p>
                        : successors.length === 0 ? direct ? null : <p className="task-detail-description">{m.noSuccessors}</p> : <ul className="task-detail-relations">{successors.map((id) => relation(id, nodes?.get(id)?.externalDependsOn.includes(taskId) ?? false))}</ul>}
                    </section>
                    <dl className="task-detail-section task-detail-metadata">
                      <div><dt>{m.created}</dt><dd><time dateTime={detail.createdAt}>{format.dateTime(detail.createdAt)}</time></dd></div>
                      <div><dt>{m.updated}</dt><dd><time dateTime={detail.updatedAt}>{format.dateTime(detail.updatedAt)}</time></dd></div>
                      <div><dt>{m.taskId}</dt><dd className="task-detail-full-id"><TaskId key={`${projectId}/${taskId}`} value={detail.id} /></dd></div>
                    </dl>
                  </aside>
                </div></>} />}
        </div>
        {status !== 'deleted' && <TaskDeletionFeedback key={`${scope}/deletion`} mutation={task.mutation} onReconcile={task.reconcile} />}
        <TaskWithdrawalFeedback key={`${scope}/withdrawal`} mutation={task.mutation} onReconcile={task.reconcile} />
        <TaskPauseFeedback key={`${scope}/pause`} mutation={task.mutation} onReconcile={task.reconcile} />
        <TaskStatusFeedback key={`${scope}/status`} detail={detail} mutation={task.mutation} onReconcile={task.reconcile} />
        <TaskAgentPermissionFeedback key={`${scope}/permission`} id={automationFeedbackId} detail={detail} mutation={task.mutation} onReconcile={task.reconcile} />
        <TaskAssignmentFeedback mutation={task.mutation} uncertain={task.assignmentUncertain} onReconcile={task.reconcile} />
        <TaskPlatformFeedback key={`${scope}/platform`} id={platformFeedbackId} detail={detail} mutation={task.mutation} onReconcile={task.reconcile} />
        <TaskDetailNotice key={`${scope}/read`} active={retainedDetail} event={readNoticeEvent} tone={error === null ? 'info' : 'error'} recoverable>
          <div className="task-detail-read-error" role={error === null ? 'status' : 'alert'}>
            {error !== null && <><h3>{m.refreshFailed}</h3><TaskDetailError error={error} /><p>{m.retainedData}</p></>}
            <p className="task-detail-retained">{m.retainedDetail}</p>
            <button className="button" type="button" onClick={retry}>{m.retry}</button>
          </div>
        </TaskDetailNotice>
        <TaskDetailNotice key={`${scope}/stale`} active={stale} event={staleNoticeEvent} tone="warning" recoverable>
          <div className="task-detail-stale" role="status">
            <p>{task.mutation.phase === 'confirmed' && task.mutation.operation?.action === 'status' ? messages.inspection.status.confirmedSnapshot : m.stale}</p>
            <button className="button" type="button" onClick={onRefreshGraph}>{m.refreshGraph}</button>
          </div>
        </TaskDetailNotice>
        <TaskDetailNotice key={`${scope}/graph`} active={!direct && graphError !== null} event={graphError} tone="error" recoverable>
          <div className="task-detail-graph-error" role="alert"><h2>{messages.workspace.project.refreshFailed}</h2><p>{messages.workspace.project.showingSnapshot}</p><ProjectGraphErrorDetail error={graphError} /><button className="button" type="button" onClick={onRefreshGraph}>{messages.workspace.project.retryRefresh}</button></div>
        </TaskDetailNotice>
        </TaskDetailNotifications>
      </Surface>
      <DraftNavigationConfirmation owner={dialogRef} fallbackFocus={titleRef} taskTitle={detail?.title ?? taskId} />
      {draftDecision === null && confirmation !== null && confirmationValid && (confirmation.kind === 'withdraw'
        ? <TaskWithdrawalConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} confirmDisabled={!confirmationAdmitted || authRequestsPaused()} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
        : confirmation.kind === 'delete'
        ? <TaskDeletionConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} confirmDisabled={!confirmationAdmitted || authRequestsPaused()} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
        : confirmation.kind === 'status'
        ? <TaskStatusConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} confirmDisabled={!confirmationAdmitted || authRequestsPaused()} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
        : confirmation.kind === 'allowAgents'
          ? <TaskAgentPermissionConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} confirmDisabled={!confirmationAdmitted || authRequestsPaused()} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
          : <TaskPlatformConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} confirmDisabled={!confirmationAdmitted || authRequestsPaused()} onCancel={() => setConfirmation(null)} onConfirm={confirm} />)}
    </SessionFullscreenContext>;
  return modal ? <div className="task-detail-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !confirmationOpen && !threadDetailsOccupied.current && sessionFullscreenRef.current === null) requestClose(); }}>{content}</div> : content;
};

export const TaskDetailSurface = (props: TaskDetailSurfaceProps) => <ProjectAccessBoundary projectId={props.projectId}><TaskDraftBoundary projectId={props.projectId} taskId={props.taskId} page={props.presentation === 'page'}><TaskDetailContent {...props} /></TaskDraftBoundary></ProjectAccessBoundary>;
