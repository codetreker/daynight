import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { taskDetailUrl, type TaskDetailNavigation } from '../../app/router';
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
import { TaskStatusFeedback, TaskStatusMenu } from './TaskStatus';
import { matchesAgentPermissionReview, TaskAgentPermissionConfirmation, TaskAgentPermissionFeedback, TaskAgentPermissionSwitch, type AgentPermissionConfirmation } from './TaskAgentPermission';
import { matchesStatusReview, TaskStatusConfirmation, type StatusConfirmation } from './TaskStatusConfirmation';
import { useSessionMessages } from '../task-agent-session/messages';
import { TaskAgentSession } from '../task-agent-session/TaskAgentSession';
import { TaskDetailReading } from './TaskDetailReading';
import { TaskDetailActions } from './TaskDetailActions';
import { matchesPlatformReview, TaskPlatformConfirmation, TaskPlatformFeedback, TaskPlatformSelect, type PlatformConfirmation } from './TaskPlatform';
import { TaskId } from './TaskId';
import { TaskCopyButton } from './TaskCopyButton';
import { matchesDeletionReview, TaskDeletionConfirmation, TaskDeletionFeedback, type DeletionConfirmation } from './TaskDeletion';
import { TaskPullRequests } from './TaskPullRequests';
import { TaskDetailNotice, TaskDetailNotifications } from './TaskDetailNotice';
import { ProjectGraphErrorDetail } from '../projects/ProjectGraphError';
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
  readonly snapshot: GraphSnapshot;
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
  return <div className="task-detail-page-topbar"><a className="task-detail-page-back" href={`/projects/${encodeURIComponent(projectId)}`}>{messages.inspection.detail.returnToProject}</a><LanguageSelector renderNotice={(notice, issue) => <TaskDetailNotice event={issue} tone="warning" recoverable>{notice}</TaskDetailNotice>} /></div>;
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

export const TaskDetailSurface = ({ projectId, taskId, snapshot, onSelectTask, onClose, onRestoreFocus, onRefreshGraph, presentation, navigation, onNavigate, attachmentApi, attachmentUrls, detailUrl, graphError = null, fullscreen }: TaskDetailSurfaceProps) => {
  const sessionMessages = useSessionMessages();
  const modal = presentation === 'dialog';
  const scope = `${projectId}/${taskId}`;
  const [localNavigation, setLocalNavigation] = useState<{ readonly scope: string; readonly value: TaskDetailNavigation }>({ scope, value: { tab: 'overview', path: null } });
  const selection = navigation === undefined ? localNavigation.scope === scope ? localNavigation.value : { tab: 'overview', path: null } as const : navigation;
  const changeSelection = (next: TaskDetailNavigation) => { setLocalNavigation({ scope, value: next }); onNavigate?.(next); };
  const popout = detailUrl === undefined ? taskDetailUrl(projectId, taskId, selection) : detailUrl(taskId, selection);
  const Surface = modal ? 'section' : 'main';
  const { messages, format } = useI18n();
  const m = messages.inspection.detail;
  const task = useTaskDetail(projectId, taskId, snapshot.revision, snapshot.index.nodes.get(taskId));
  const { detail, status, error, retry } = task;
  type TaskConfirmationState = DeletionConfirmation | StatusConfirmation | (AgentPermissionConfirmation & { readonly kind: 'allowAgents' }) |
    (PlatformConfirmation & { readonly kind: 'requiredPlatform' });
  const [confirmation, setConfirmation] = useState<TaskConfirmationState | null>(null);
  const requestConfirmation = (review: TaskConfirmationState): void => setConfirmation((current) => current === null ? review : current);
  const confirmationValid = confirmation !== null && (confirmation.kind === 'delete'
    ? matchesDeletionReview(confirmation, detail) && task.canDelete
    : confirmation.kind === 'status'
    ? matchesStatusReview(confirmation, detail) && task.canSetStatus
    : confirmation.kind === 'allowAgents' ? matchesAgentPermissionReview(confirmation, detail) && task.canSetAgentPermission
      : matchesPlatformReview(confirmation, detail) && task.canSetRequiredPlatform);
  const confirmationOpen = confirmation !== null && confirmationValid;
  useLayoutEffect(() => { if (confirmation !== null && !confirmationValid) setConfirmation(null); }, [confirmation, confirmationValid]);
  const confirm = (): void => {
    if (confirmation === null || !confirmationValid) return;
    setConfirmation(null);
    if (confirmation.kind === 'delete') task.deleteTask(confirmation.detail.version, confirmation.removeDepends);
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
    if (confirmationOpen) return;
    if (fullscreen.active) changeFullscreen(false);
    else onClose?.();
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
      if (callbacks.current.confirmationOpen || event.defaultPrevented) return;
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
    if (modal && !confirmationOpen && !dialogRef.current!.contains(document.activeElement)) closeRef.current!.focus();
  }, [taskId, status, error, snapshot.revision, confirmationOpen]);

  const snapshotNode = snapshot.index.nodes.get(taskId);
  const retainedDetail = detail !== null && (error !== null || task.requiresFreshRead);
  const stale = task.graphMismatch || detail !== null && !task.refreshing && !retainedDetail && isTaskStale(snapshotNode, detail);
  const readNoticeEvent = useMemo(() => ({}), [error, retainedDetail]);
  const staleNoticeEvent = useMemo(() => ({}), [stale]);
  const successors = snapshot.index.successors.get(taskId);
  const relation = (id: string, external: boolean) => {
    const node = snapshot.index.nodes.get(id);
    const title = node === undefined ? id : `${node.titlePreview}${node.titleTruncated ? '…' : ''}`;
    const kind = external ? m.externalDependency : m.ordinaryDependency;
    return (
      <li key={id}>
        <button className="task-detail-relation" type="button" aria-label={m.relationLabel({ title, kind })} onClick={() => onSelectTask(id)}>
          <span className={`task-detail-relation-dot${node === undefined ? '' : ` task-detail-dot-${node.status}`}`} aria-hidden="true" />
          <span>{title}</span>
          <span className={`task-detail-relation-kind${external ? ' task-detail-relation-external' : ''}`}>{kind}</span>
          <span className="task-detail-relation-arrow" aria-hidden="true">↗</span>
        </button>
      </li>
    );
  };

  const content = <>
      <Surface className={`${modal ? 'task-detail-dialog' : 'task-detail-page'}${fullscreen.active ? ' task-detail-fullscreen' : ''}`} ref={dialogRef} role={modal ? 'dialog' : undefined} aria-modal={modal ? true : undefined} aria-labelledby={headingId} tabIndex={modal ? undefined : -1}>
        <TaskDetailNotifications fallbackFocus={titleRef}>
        {!modal && <div hidden={fullscreen.active}><TaskDetailPageBar projectId={projectId} /></div>}
        <header className="task-detail-header">
          <div className="task-detail-title-row">
            <h2 id={headingId} className="task-detail-title" ref={titleRef} tabIndex={detail === null ? -1 : 0} title={detail?.title}>{detail === null ? status === 'deleted' ? messages.inspection.deletion.deleted : status === 'error' ? m.failed : m.loading : detail.title}</h2>
            {detail !== null && <TaskCopyButton key={`${scope}/${detail.title}`} value={detail.title} label={m.copyTaskTitle} failure={m.copyTitleFailed} />}
          </div>
          <div className="task-detail-header-actions">
            {!modal && fullscreen.active && <a className="button task-detail-project-return" href={`/projects/${encodeURIComponent(projectId)}`}>{m.returnToProject}</a>}
            <button className="button task-detail-fullscreen-toggle" type="button" ref={fullscreenRef} aria-label={fullscreen.active ? m.exitFullscreen : m.enterFullscreen} title={fullscreen.active ? m.exitFullscreen : m.enterFullscreen} aria-pressed={fullscreen.active} onClick={() => changeFullscreen(!fullscreen.active)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d={fullscreen.active ? 'M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} /></svg>
            </button>
            {(modal || detail !== null) && <TaskDetailActions key={scope} {...(modal ? { popout } : {})} canDelete={task.canDelete} {...(detail === null ? {} : { onDelete: () => requestConfirmation({ kind: 'delete', detail, removeDepends: true }) })} />}
            {modal ? <button className="button task-detail-close" type="button" ref={closeRef} aria-label={m.close} onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button> : null}
          </div>
        </header>
        <div className="task-detail-body">
          {status === 'loading' && (
            <div className="task-detail-state" role="status" aria-label={m.loading}><span className="spinner" aria-hidden="true" /></div>
          )}
          {status === 'deleted' && <div className="task-detail-state task-detail-deleted" role="status"><p>{messages.inspection.deletion.deletedExplanation}</p><a className="button" href={`/projects/${encodeURIComponent(projectId)}`}>{m.returnToProject}</a></div>}
          {status === 'error' && (
            <div className="task-detail-state task-detail-error" role="alert" aria-labelledby={headingId}>
              <TaskDetailError error={error} />
              <button className="button primary" type="button" onClick={retry}>{m.retry}</button>
            </div>
          )}
          {detail !== null && (
            <>
              <div className="task-detail-heading">
                <div className="task-detail-status-row">
                  <div className="task-detail-badges">
                    <div className="task-detail-state-controls">
                      <TaskStatusMenu status={detail.status} disabled={!task.canSetStatus} onSelect={(status) => requestConfirmation({ kind: 'status', status, detail })} />
                      <TaskPlatformSelect detail={detail} disabled={!task.canSetRequiredPlatform} describedBy={platformFeedbackId}
                        onReview={(requiredPlatform) => requestConfirmation({ kind: 'requiredPlatform', detail, requiredPlatform })} />
                    </div>
                    {detail.properties.worker !== null && <span className="task-detail-execution-mode">{detail.properties.worker.agentControlMode === 'web' ? sessionMessages.web : sessionMessages.herdr}</span>}
                    {detail.status === 'todo' && <span className={detail.ready ? 'task-detail-ready' : 'task-detail-blocked'}>{detail.ready ? m.ready : m.blocked}</span>}
                  </div>
                  <TaskAgentPermissionSwitch detail={detail} disabled={!task.canSetAgentPermission} describedBy={automationFeedbackId}
                    onClick={() => requestConfirmation({ kind: 'allowAgents', detail, allowAgents: !detail.allowAgents })} />
                </div>
              </div>
              <TaskDetailReading key={`${projectId}/${taskId}`} projectId={projectId} taskId={taskId} description={detail.description} {...(detail.properties.worker?.agentControlMode === 'web' ? { session: (active: boolean) => <TaskAgentSession key={detail.properties.worker!.claimId} projectId={projectId} taskId={taskId} claimId={detail.properties.worker!.claimId} active={active} current={!task.requiresFreshRead && task.status === 'ready' && task.error === null} /> } : {})} selection={selection} onSelectionChange={changeSelection} requireCompleteInventory={!modal} {...(modal || fullscreen.active ? { keyboardOwner } : {})} {...(attachmentApi === undefined ? {} : { api: attachmentApi })} {...(attachmentUrls === undefined ? {} : { urls: attachmentUrls })} overview={(description) => <>
                <div className="task-detail-columns">
                  <div className="task-detail-main">
                    <section className="task-detail-section" aria-label={m.description}>
                      <h4>{m.description}</h4>
                      {description}
                    </section>
                    <TaskPullRequests pullRequests={detail.properties.pullRequests} />
                  </div>
                  <aside className="task-detail-aside" aria-label={m.relationsMetadata}>
                    <section className="task-detail-section" aria-label={m.dependencies}>
                      <h4>{m.countedHeading({ label: m.dependencies, count: format.number(detail.dependsOn.length) })}</h4>
                      {detail.dependsOn.length === 0 ? <p className="task-detail-description">{m.noDependencies}</p> : <ul className="task-detail-relations">{detail.dependsOn.map((id) => relation(id, detail.externalDependsOn.includes(id)))}</ul>}
                    </section>
                    <section className="task-detail-section" aria-label={m.blockers}>
                      <h4>{m.countedHeading({ label: m.blockers, count: format.number(detail.blockedBy.length) })}</h4>
                      {detail.blockedBy.length === 0 ? <p className="task-detail-description">{m.noBlockers}</p> : <ul className="task-detail-relations">{detail.blockedBy.map((id) => relation(id, detail.externalDependsOn.includes(id)))}</ul>}
                    </section>
                    <section className="task-detail-section" aria-label={m.successors}>
                      <h4>{successors === undefined ? m.successors : m.countedHeading({ label: m.successors, count: format.number(successors.length) })}</h4>
                      {successors === undefined
                        ? <p className="task-detail-description">{m.successorsMissing}</p>
                        : successors.length === 0 ? <p className="task-detail-description">{m.noSuccessors}</p> : <ul className="task-detail-relations">{successors.map((id) => relation(id, snapshot.index.nodes.get(id)!.externalDependsOn.includes(taskId)))}</ul>}
                    </section>
                    <dl className="task-detail-section task-detail-metadata">
                      <div><dt>{m.created}</dt><dd><time dateTime={detail.createdAt}>{format.dateTime(detail.createdAt)}</time></dd></div>
                      <div><dt>{m.updated}</dt><dd><time dateTime={detail.updatedAt}>{format.dateTime(detail.updatedAt)}</time></dd></div>
                      <div><dt>{m.taskId}</dt><dd className="task-detail-full-id"><TaskId key={`${projectId}/${taskId}`} value={detail.id} /></dd></div>
                    </dl>
                  </aside>
                </div></>} />
            </>
          )}
        </div>
        <footer className="task-detail-footer">{m.footer}</footer>
        {status !== 'deleted' && <TaskDeletionFeedback key={`${scope}/deletion`} mutation={task.mutation} onReconcile={task.reconcile} />}
        <TaskStatusFeedback key={`${scope}/status`} detail={detail} mutation={task.mutation} onReconcile={task.reconcile} />
        <TaskAgentPermissionFeedback key={`${scope}/permission`} id={automationFeedbackId} detail={detail} mutation={task.mutation} onReconcile={task.reconcile} />
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
        <TaskDetailNotice key={`${scope}/graph`} active={graphError !== null} event={graphError} tone="error" recoverable>
          <div className="task-detail-graph-error" role="alert"><h2>{messages.workspace.project.refreshFailed}</h2><p>{messages.workspace.project.showingSnapshot}</p><ProjectGraphErrorDetail error={graphError} /><button className="button" type="button" onClick={onRefreshGraph}>{messages.workspace.project.retryRefresh}</button></div>
        </TaskDetailNotice>
        </TaskDetailNotifications>
      </Surface>
      {confirmation !== null && confirmationValid && (confirmation.kind === 'delete'
        ? <TaskDeletionConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
        : confirmation.kind === 'status'
        ? <TaskStatusConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
        : confirmation.kind === 'allowAgents'
          ? <TaskAgentPermissionConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} onCancel={() => setConfirmation(null)} onConfirm={confirm} />
          : <TaskPlatformConfirmation confirmation={confirmation} owner={dialogRef} fallbackFocus={titleRef} onCancel={() => setConfirmation(null)} onConfirm={confirm} />)}
    </>;
  return modal ? <div className="task-detail-backdrop" onClick={(event) => { if (event.target === event.currentTarget && !confirmationOpen) onClose!(); }}>{content}</div> : content;
};
