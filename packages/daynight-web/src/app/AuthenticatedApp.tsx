import { clearPendingBotDeletions } from '../features/bots/deletion-coordinator';
import { clearBotDisplaySnapshots, retryBotDisplaySnapshotCleanup } from '../features/bots/display-snapshot-coordinator';
import { clearPendingBotCreation } from '../features/bots/pending-creation';
import { BotsPage } from '../features/bots/BotsPage';
import '../styles/assistant-workspace.css';
import { useBotMessages } from '../features/bots/messages';
import { CurrentAccountProvider } from './CurrentAccountContext';
import { WebhookCatalogProvider, WebhookCatalogStatus, useWebhookCatalog } from './WebhookCatalog';
import { WebhooksPage } from '../features/webhooks/WebhooksPage';
import { clearWebhookPending } from '../features/webhook-intents/controller';
import { clearSessionDrafts } from '../features/task-agent-session/client';
import { clearBotSessionStorage } from '../features/bots/session-storage';
import { clearSessionDisplayPreference } from '../features/task-agent-session/useSessionDisplayPreference';

async function clearPrivateSessionState(userId: string): Promise<Error | null> {
  const snapshotsCleared = clearBotDisplaySnapshots(userId);
  const webhookCleanupError = clearWebhookPending(window.location.origin, userId);
  clearSessionDrafts(userId);
  clearPendingBotCreation(userId);
  clearPendingBotDeletions(userId);
  for (const sessionId of clearBotSessionStorage(userId)) clearSessionDisplayPreference({ userId, sessionId });
  return await snapshotsCleared ? webhookCleanupError : new Error('Assistant display snapshots could not be cleared.');
}
import { TestSessionPage } from '../features/task-agent-session/TestSessionPage';
import { TestSessionListPage } from '../features/task-agent-session/TestSessionListPage';
import { useTestSessionListMessages } from '../features/task-agent-session/test-session-list-messages';
import { createPortal, flushSync } from "react-dom";
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from "../features/task-cache/TaskCacheProvider";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { logout, me } from "../api/auth";
import type { AuthProvider, CurrentUser, ProjectRole } from "../api/auth-types";
import { ApiError, invalidateAuthRequests, isAbortError, pauseAuthRequests, subscribeUnauthorized } from "../api/client";
import { suspendSessionImagePreviews } from '../features/task-agent-session/images/image-preview';
import type { Project } from "../api/types";
import { AccountPage } from "../features/management/AccountPage";
import { ProjectSettingsPanel } from "../features/management/ProjectSettingsPanel";
import { TransferResultNotice, useTransferNavigation } from "../features/management/transfer-navigation";
import { DeletionResultNotices, useDeletionNavigation } from "../features/management/deletion-navigation";
import { MembersPanel } from "../features/management/MembersPanel";
import { CreateProjectDialog } from "../features/auth/CreateProjectDialog";
import { InvitationPage } from "../features/auth/InvitationPage";
import { TeamInvitationPage } from "../features/auth/TeamInvitationPage";
import { LoginPage } from "../features/auth/LoginPage";
import { DeviceAuthorizationPage } from "../features/auth/DeviceAuthorizationPage";
import { OAuthConsentPage } from "../features/auth/OAuthConsentPage";
import { captureInvitation, clearInvitation, persistInvitation } from "../features/auth/invitation";
import type { PendingInvitation } from "../features/auth/invitation";
import { TaskDetailSessionProvider } from "../features/task-detail/TaskDetailSession";
import { TaskAssigneesProvider } from "../features/task-assignees/TaskAssignees";
import { ProjectPage } from "../features/projects/ProjectPage";
import { ProjectAccessBoundary, useProjectAccess } from "../features/projects/ProjectAccess";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { ProjectsProvider, useProjectList } from "../features/projects/ProjectsProvider";
import { TaskDetailPage } from "../features/task-detail/TaskDetailPage";
import { invitationLocation, isLoginReturnPath, loginUrl, navigate, parseAuthRoute, replaceRoute, type AuthRoute } from "./router";
import { useI18n } from "../i18n/LocaleProvider";
import { LanguageSelector } from "../i18n/LanguageSelector";
import { WorkersPage } from "../features/workers/WorkersPage";
import { WorkerDetailPage } from "../features/workers/WorkerDetailPage";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { AccountMenu } from "./AccountMenu";
import { TeamsProvider, useTeams } from "../features/teams/TeamsProvider";
import { TeamPreferenceProvider, useCurrentTeamPreference } from "../features/teams/useTeamPreference";
import { useTeamMessages } from "../features/teams/messages";
import { CreateTeamDialog } from "../features/teams/TeamManagement";
import { TeamSettingsWorkspace, isTeamSettingsRoute } from "../features/teams/TeamSettingsWorkspace";
import { useSidebarPreference } from "./useSidebarPreference";
import { useBrowserLocation } from './browser-location';
import "../styles/auth.css";

export { parseAuthRoute } from "./router";

const followLink = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(event.currentTarget.pathname + event.currentTarget.search + event.currentTarget.hash);
};
const accountLabel = (user: CurrentUser, currentAccount: string) => user.name ?? user.email ?? currentAccount;
const AccessUnavailable = () => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  return <section className="state-box" role="alert"><h1>{m.accessUnavailable}</h1><p>{m.accessUnavailableDetail}</p><a className="button primary" href="/projects" onClick={followLink}>{app.returnToProjects}</a></section>;
};

const ProjectRoleBadge = ({ role, labels }: { readonly role: ProjectRole | null; readonly labels: Readonly<Record<ProjectRole, string>> }) => (
  <span className="project-title-role">
    {role !== null && <span className={`badge ${role}`}>{labels[role]}</span>}
    {role !== "admin" && <span className="project-title-role-measure" aria-hidden="true">{labels.admin}</span>}
  </span>
);

const AuthorizedProject = ({ projectId, user, onOpenMembers }: { readonly projectId: string; readonly user: CurrentUser; readonly onOpenMembers: (project: Project) => void }) => {
  const { messages: { auth: { shell: m, roles } } } = useI18n();
  const access = useProjectAccess(projectId);
  const admitted = useRef(false);
  if (access.status === "ready") admitted.current = true;
  if (access.status === "unavailable" && !admitted.current) return <AccessUnavailable />;
  return <>{access.status === "error" && <div className="notice error" role="alert"><p>{m.permissionsError}</p><button className="button" type="button" onClick={() => access.session.revalidate()}>{m.retryPermissions}</button></div>}<ProjectPage projectId={projectId} renderActions={(project) => access.ready ? <><ProjectRoleBadge role={access.access!.effectiveRole} labels={roles} /><a className="button" href={`/projects/${projectId}/members`} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenMembers(project); }}>{m.members}</a><a className="button" href={`/projects/${projectId}/settings`} onClick={followLink}>{m.projectSettings}</a></> : <span className="project-title-actions-placeholder" aria-hidden="true"><ProjectRoleBadge role={null} labels={roles} /><span className="button">{m.members}</span><span className="button">{m.projectSettings}</span></span>} /></>;
};

const ProjectManagementNav = ({ projectId, current }: { readonly projectId: string; readonly current: "settings" | "members" }) => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  return <nav className="project-management-nav" aria-label={m.projectSettings}><a className="button" href={`/projects/${projectId}`} onClick={followLink}>{app.projectTasks}</a><a className="button" href={`/projects/${projectId}/members`} onClick={followLink} aria-current={current === "members" ? "page" : undefined}>{m.members}</a><a className="button" href={`/projects/${projectId}/settings`} onClick={followLink} aria-current={current === "settings" ? "page" : undefined}>{m.projectSettings}</a></nav>;
};

const Workspace = ({ user, children, route, selectedTeamId, onSignOut, blocked, onCreateTeam }: { readonly onCreateTeam: () => void; readonly selectedTeamId: string; readonly user: CurrentUser; readonly children: ReactNode; readonly route: AuthRoute; readonly onSignOut: () => void; readonly blocked: boolean }) => {
  const { messages: { auth: { shell: m }, workspace: { app }, setup } } = useI18n();
  const botMessages = useBotMessages();
  const testMessages = useTestSessionListMessages();
  const teamMessages = useTeamMessages();
  const teams = useTeams();
  const content = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarPreference();
  const webhookCatalog = useWebhookCatalog();
  const resourceId = "projectId" in route ? route.projectId : "workerId" in route ? route.workerId : "teamId" in route ? route.teamId : null;
  const label = route.kind === "webhooks" ? "Webhooks" : route.kind === "bots" || route.kind === "bot" ? botMessages.title : route.kind === "workers" ? m.workers : route.kind === "worker" ? m.worker : route.kind === "testSessions" ? testMessages.title : route.kind === "testSession" ? testMessages.session : (route.kind === "projects" || route.kind === "team") ? teams.detail.team?.kind === "personal" ? teamMessages.personal : teams.detail.team?.name ?? teamMessages.teamProjects : isTeamSettingsRoute(route) ? teamMessages.settings : route.kind === "sharedProjects" ? teamMessages.shared : route.kind === "account" ? m.accountSettings : route.kind === "members" ? m.members : route.kind === "settings" ? m.projectSettings : route.kind === "project" ? app.projectTasks : app.notFound;
  useLayoutEffect(() => { if (!blocked) content.current?.focus(); }, [route.kind, resourceId, blocked]);
  return (
    <div className={`shell auth-shell${sidebar.collapsed ? " sidebar-collapsed" : ""}${route.kind === "testSession" || route.kind === "bots" || route.kind === "bot" ? " test-session-shell" : ""}${route.kind === "testSession" ? " test-session-detail-shell" : ""}${route.kind === "bots" || route.kind === "bot" ? " assistant-workspace-shell" : ""}`} aria-hidden={blocked} inert={blocked}>
      <WorkspaceSidebar collapsed={sidebar.collapsed} onToggle={sidebar.toggle} routeKey={route.kind + (resourceId === null ? "" : `:${resourceId}`)} projectsActive={route.kind === "projects" || route.kind === "team"} sharedActive={route.kind === "sharedProjects"} teamSettingsActive={isTeamSettingsRoute(route)} personalId={user.personalTeam.id} selectedTeamId={teams.detail.status === "ready" ? selectedTeamId : null} visibilityTeamId={teams.visibilityTeamId} workersActive={route.kind === "workers" || route.kind === "worker"} botsActive={route.kind === "bots" || route.kind === "bot"} webhooksActive={route.kind === "webhooks"} webhooksAvailable={webhookCatalog.catalog !== null} activeProjectId={"projectId" in route ? route.projectId : null} testSessionsActive={route.kind === "testSessions" || route.kind === "testSession"} blocked={blocked} workspaceRef={workspace} onNavigate={() => queueMicrotask(() => content.current?.focus())} onCreateTeam={onCreateTeam} />
      <div className="workspace" ref={workspace}>
        <a className="skip-link" href="#main-content">{app.skipToContent}</a>
        <header className="topbar">
          <nav className="crumb" aria-label={app.breadcrumb}><a href="/projects" onClick={followLink}>{app.workspace}</a><span aria-hidden="true">/</span>{route.kind === "worker" && <><a href="/workers" onClick={followLink}>{m.workers}</a><span aria-hidden="true">/</span></>}<span className="crumb-current" aria-current="page">{label}</span></nav>
          <div className="account-actions">
            <a className="setup-guide-link" href="/setup" target="_blank" rel="noopener noreferrer"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v15M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3z" /></svg>{setup.navigation}</a>
            <LanguageSelector />
            <AccountMenu name={accountLabel(user, m.currentAccount)} onSignOut={onSignOut} />
          </div>
        </header>
        <main className="content" id="main-content" ref={content} tabIndex={-1}>
          {sidebar.issue !== null && <div className="sidebar-preference-notice notice warning" role="alert"><p>{m.sidebar[`${sidebar.issue.kind}Error`]}</p><button className="button" type="button" onClick={sidebar.retrySave}>{m.sidebar.retrySave}</button></div>}
          {children}
        </main>
      </div>
    </div>
  );
};

const TeamPreferenceError = ({ inline = false }: { readonly inline?: boolean }) => {
  const teams = useTeams(), m = useTeamMessages();
  const { messages: { common } } = useI18n();
  const { error, storageError } = teams.detail;
  const Heading = inline ? "h2" : "h1";
  return <section className={inline ? "notice error" : "state-box"} role="alert"><Heading>{m.failed}</Heading><p>{storageError ? m.storageRead : error instanceof ApiError && error.kind === "server" && ((error.status === 403 && error.code === "forbidden") || (error.status === 404 && error.code === "not_found")) ? m.unavailable : error instanceof ApiError && error.kind === "network" ? m.network : m.readError}</p>{error instanceof ApiError && error.requestId !== null && <p>{common.requestId}<code>{error.requestId}</code></p>}<button className="button" type="button" onClick={teams.refreshDetail}>{m.retry}</button></section>;
};

const WorkspaceRoutes = ({ user, route, selectedTeamId, admission, onSignOut, onIdentityMismatch, blocked, identityBlocked, identityChecking, workspaceVisible, standaloneSlot, guardedTeam, setTeamGuard, children }: { readonly workspaceVisible: boolean; readonly standaloneSlot: HTMLDivElement | null; readonly admission: TaskCacheScope; readonly selectedTeamId: string; readonly user: CurrentUser; readonly route: AuthRoute; readonly onSignOut: () => void; readonly onIdentityMismatch: () => void; readonly blocked: boolean; readonly identityBlocked: boolean; readonly identityChecking: boolean; readonly guardedTeam: (id: string) => boolean; readonly setTeamGuard: (id: string, source: "settings" | "members", guarded: boolean) => void; readonly children: ReactNode }) => {
  const { locale, messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  const projects = useProjectList();
  const teams = useTeams();
  const webhookCatalog = useWebhookCatalog();
  const teamMessages = useTeamMessages();
  const transfer = useTransferNavigation(admission, user, projects.refresh);
  const deletion = useDeletionNavigation(admission, projects.refresh);
  const [deletionExpanded, setDeletionExpanded] = useState(true);
  const deletionPanelId = useId();
  const deletionKeys = [...deletion.outcomes.map((item) => `${item.id}:${item.kind}`), ...deletion.results.map((item) => `${item.id}:confirmed`)].join("|");
  useEffect(() => { if (deletionKeys !== "") setDeletionExpanded(true); }, [deletionKeys]);
  const [creating, setCreating] = useState<{ readonly id: string; readonly name: string; readonly personal: boolean } | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [savedTeamResult, setSavedTeamResult] = useState<string | null>(null);
  const [memberResults, setMemberResults] = useState<ReadonlyMap<string, "changed" | "left">>(() => new Map());
  const clearMemberResult = (teamId: string) => setMemberResults((previous) => {
    if (!previous.has(teamId)) return previous;
    const next = new Map(previous); next.delete(teamId); return next;
  });
  const saveMemberResult = (teamId: string, kind: "changed" | "left") => setMemberResults((previous) => new Map(previous).set(teamId, kind));
  const [teamSettingsSlot, setTeamSettingsSlot] = useState<HTMLDivElement | null>(null);
  const mountedProjectMembers = useRef<{ id: string; host: HTMLDivElement }[]>([]);
  const projectMemberSlot = useRef<HTMLDivElement>(null);
  const attachProjectMemberSlot = useCallback((slot: HTMLDivElement | null) => { projectMemberSlot.current = slot; if (slot) for (const member of mountedProjectMembers.current) if (member.host.parentNode !== slot) slot.appendChild(member.host); }, []);
  useLayoutEffect(() => { const slot = projectMemberSlot.current; if (slot) for (const member of mountedProjectMembers.current) if (member.host.parentNode !== slot) slot.appendChild(member.host); });
  if (route.kind === "members" && !mountedProjectMembers.current.some((member) => member.id === route.projectId)) mountedProjectMembers.current.push({ id: route.projectId, host: document.createElement("div") });
  const mountedProjectSettings = useRef<{ id: string; host: HTMLDivElement; retained: { settings: boolean; transfer: boolean; delete: boolean; prompt: boolean } }[]>([]);
  const [, updateProjectSettings] = useState(0);
  const retainProjectSettings = useCallback((projectId: string, owner: "settings" | "transfer" | "delete" | "prompt", retained: boolean) => {
    const settings = mountedProjectSettings.current.find((entry) => entry.id === projectId);
    if (settings === undefined || settings.retained[owner] === retained) return;
    settings.retained[owner] = retained;
    updateProjectSettings((value) => value + 1);
  }, []);
  const projectSettingsSlot = useRef<HTMLDivElement>(null);
  const attachProjectSettingsSlot = useCallback((slot: HTMLDivElement | null) => { projectSettingsSlot.current = slot; if (slot) for (const settings of mountedProjectSettings.current) if (settings.host.parentNode !== slot) slot.appendChild(settings.host); }, []);
  const mountedAccount = useRef<{ host: HTMLDivElement; retained: boolean } | null>(null);
  const mountedWorkers = useRef<{ id: string; host: HTMLDivElement; retained: boolean }[]>([]);
  const [, updatePromptOwners] = useState(0);
  const accountSlot = useRef<HTMLDivElement>(null), workerSlot = useRef<HTMLDivElement>(null);
  const attachAccountSlot = useCallback((slot: HTMLDivElement | null) => { accountSlot.current = slot; if (slot && mountedAccount.current && mountedAccount.current.host.parentNode !== slot) slot.appendChild(mountedAccount.current.host); }, []);
  const attachWorkerSlot = useCallback((slot: HTMLDivElement | null) => { workerSlot.current = slot; if (slot) for (const worker of mountedWorkers.current) if (worker.host.parentNode !== slot) slot.appendChild(worker.host); }, []);
  const retainAccount = useCallback((retained: boolean) => { if (mountedAccount.current && mountedAccount.current.retained !== retained) { mountedAccount.current.retained = retained; updatePromptOwners(value => value + 1); } }, []);
  const retainWorker = useCallback((id: string, retained: boolean) => { const worker = mountedWorkers.current.find(value => value.id === id); if (worker && worker.retained !== retained) { worker.retained = retained; updatePromptOwners(value => value + 1); } }, []);
  useLayoutEffect(() => { const slot = projectSettingsSlot.current; if (slot) for (const settings of mountedProjectSettings.current) if (settings.host.parentNode !== slot) slot.appendChild(settings.host); });
  useLayoutEffect(() => { const slot = accountSlot.current; if (slot && mountedAccount.current && mountedAccount.current.host.parentNode !== slot) slot.appendChild(mountedAccount.current.host); });
  useLayoutEffect(() => { const slot = workerSlot.current; if (slot) for (const worker of mountedWorkers.current) if (worker.host.parentNode !== slot) slot.appendChild(worker.host); });
  mountedProjectSettings.current = mountedProjectSettings.current.filter((settings) => settings.retained.settings || settings.retained.transfer || settings.retained.delete || settings.retained.prompt || route.kind === "settings" && settings.id === route.projectId);
  if (route.kind === "settings" && !mountedProjectSettings.current.some((settings) => settings.id === route.projectId)) mountedProjectSettings.current.push({ id: route.projectId, host: document.createElement("div"), retained: { settings: false, transfer: false, delete: false, prompt: false } });
  if (route.kind !== "account" && !mountedAccount.current?.retained) mountedAccount.current = null;
  if (route.kind === "account" && mountedAccount.current === null) mountedAccount.current = { host: document.createElement("div"), retained: false };
  mountedWorkers.current = mountedWorkers.current.filter(worker => worker.retained || route.kind === "worker" && worker.id === route.workerId);
  if (route.kind === "worker" && !mountedWorkers.current.some(worker => worker.id === route.workerId)) mountedWorkers.current.push({ id: route.workerId, host: document.createElement("div"), retained: false });
  const teamPage = route.kind === "projects" || route.kind === "team" || isTeamSettingsRoute(route);
  return <>{workspaceVisible && <Workspace user={user} route={route} selectedTeamId={selectedTeamId} onSignOut={onSignOut} blocked={blocked} onCreateTeam={() => setCreatingTeam(true)}>
    {children}{savedTeamResult !== null && !(route.kind === "teamSettings" && route.teamId === savedTeamResult && teams.detail.status === "ready" && !blocked) && <div className="notice" role="status"><span>{teamMessages.savedName}</span> <code>{savedTeamResult}</code> <button type="button" className="button quiet" onClick={() => setSavedTeamResult(null)}>{teamMessages.dismiss}</button></div>}{!teamPage && teams.detail.status === "error" && <TeamPreferenceError inline />}<TransferResultNotice result={transfer.result} retry={transfer.retry} dismiss={transfer.dismiss} /><DeletionResultNotices state={deletion} />{[...memberResults].map(([teamId, kind]) => <div key={teamId} className="notice" role="status">{kind === "left" ? teamMessages.left : teamMessages.memberChanged} <code>{teamId}</code> <button type="button" className="button quiet" onClick={() => clearMemberResult(teamId)}>{teamMessages.dismiss}</button></div>)}{route.kind === "webhooks" ? <><WebhookCatalogStatus />{webhookCatalog.catalog !== null && <WebhooksPage user={user} admission={admission} active={webhookCatalog.admitted && !identityChecking && !blocked} route={route} catalog={webhookCatalog.catalog} />}</> : route.kind === "bots" || route.kind === "bot" ? <BotsPage botId={route.kind === "bot" ? route.botId : null} readEnabled={!identityChecking && !blocked} /> : route.kind === "workers" ? <WorkersPage readEnabled={!identityChecking && !blocked} /> : route.kind === "worker" ? <div ref={attachWorkerSlot} /> : route.kind === "testSessions" ? <TestSessionListPage /> : route.kind === "testSession" ? <TestSessionPage key={route.sessionId} sessionId={route.sessionId} /> : route.kind === "sharedProjects" ? <ProjectsPage title={teamMessages.sharedProjects} subtitle={teamMessages.sharedSubtitle} emptyDetail={teamMessages.sharedEmpty} /> : route.kind === "projects" || route.kind === "team" || route.kind === "teamSettings" || route.kind === "teamMembers" ? teams.detail.status === "loading" ? <section className="state-box" role="status">{teamMessages.loading}</section> : teams.detail.status === "error" ? <TeamPreferenceError /> : (route.kind === "teamSettings" || route.kind === "teamMembers") ? null : <ProjectsPage title={teams.detail.team!.kind === "personal" ? teamMessages.personal : teams.detail.team!.name!} subtitle={teams.detail.team!.kind === "personal" ? teamMessages.personalSubtitle : teamMessages.teamSubtitle} {...(teams.detail.team!.kind === "personal" ? {} : { emptyDetail: teamMessages.teamEmpty })} onCreate={() => setCreating({ id: selectedTeamId, name: teams.detail.team!.kind === "personal" ? teamMessages.personal : teams.detail.team!.name!, personal: teams.detail.team!.kind === "personal" })} /> : route.kind === "project" ? <ProjectAccessBoundary key={route.projectId} projectId={route.projectId}><AuthorizedProject projectId={route.projectId} user={user} onOpenMembers={(project) => navigate(`/projects/${project.id}/members`)} /></ProjectAccessBoundary> : route.kind === "settings" ? null : route.kind === "members" ? <><ProjectManagementNav projectId={route.projectId} current="members" /><div ref={attachProjectMemberSlot} /></> : route.kind === "account" ? <div ref={attachAccountSlot} /> : <section className="state-box"><h1>{app.notFound}</h1><a className="button primary" href="/projects" onClick={followLink}>{app.returnToProjects}</a></section>}
    <div ref={setTeamSettingsSlot} />
    <div ref={attachProjectSettingsSlot} />
    {creatingTeam && <CreateTeamDialog admission={admission} active={!blocked} onIdentityMismatch={onIdentityMismatch} onClose={() => setCreatingTeam(false)} onCreated={(team) => { setCreatingTeam(false); teams.refreshList(); navigate(`/teams/${team.id}`); }} />}
    {creating !== null && <CreateProjectDialog admission={admission} teamId={creating.id} teamName={creating.name} teamPersonal={creating.personal} userId={user.id} onIdentityMismatch={onIdentityMismatch} onClose={() => setCreating(null)} onPublished={() => projects.refresh()} onCreated={(project) => { setCreating(null); navigate(`/projects/${project.id}`); }} />}
  </Workspace>}
    {mountedAccount.current !== null && createPortal(<div hidden={route.kind !== "account" || !workspaceVisible || blocked} inert={route.kind !== "account" || !workspaceVisible || blocked}><AccountPage user={user} onSignOut={onSignOut} onIdentityMismatch={onIdentityMismatch} active={route.kind === "account" && workspaceVisible && !blocked} onRetentionChange={retainAccount} /></div>, mountedAccount.current.host, "account")}
    {mountedWorkers.current.map(({ id: workerId, host }) => { const active = route.kind === "worker" && route.workerId === workerId && workspaceVisible && !blocked; return createPortal(<div hidden={!active} inert={!active}><WorkerDetailPage workerId={workerId} userId={user.id} active={active} readEnabled={active && !identityChecking} onRetentionChange={(retained) => retainWorker(workerId, retained)} /></div>, host, `worker:${workerId}`); })}
    {!workspaceVisible && standaloneSlot !== null && deletionKeys !== "" && createPortal(<div className="standalone-deletion-results auth-shell" aria-hidden={identityBlocked} inert={identityBlocked}>
      <button className="button standalone-deletion-toggle" type="button" aria-expanded={deletionExpanded} aria-controls={deletionPanelId} onClick={() => setDeletionExpanded((value) => !value)}>{deletionExpanded ? (locale === "zh-CN" ? "收起删除结果" : "Collapse deletion results") : (locale === "zh-CN" ? "显示删除结果" : "Show deletion results")}</button>
      <div id={deletionPanelId} className="standalone-deletion-panel" hidden={!deletionExpanded}><DeletionResultNotices state={deletion} /></div>
    </div>, standaloneSlot)}
    {mountedProjectMembers.current.map(({ id: projectId, host }) => { const onRoute = route.kind === "members" && route.projectId === projectId; const active = onRoute && workspaceVisible && !blocked; return createPortal(<div hidden={!active} inert={!active}><MembersPanel projectId={projectId} user={user} active={active} onRoute={onRoute} onRemoved={() => { projects.refresh(); if (onRoute) navigate("/projects"); }} onUnavailable={projects.refresh} /></div>, host, `project:${projectId}`); })}
    {mountedProjectSettings.current.map(({ id: projectId, host }) => { const onRoute = route.kind === "settings" && route.projectId === projectId; const active = workspaceVisible && onRoute && !blocked; return createPortal(<div hidden={!active} inert={!active}><ProjectSettingsPanel projectId={projectId} user={user} navigation={<ProjectManagementNav projectId={projectId} current="settings" />} unavailableView={<AccessUnavailable />} active={active} onRoute={onRoute} onRetentionChange={(retained) => retainProjectSettings(projectId, "transfer", retained)} onSettingsRetentionChange={(retained) => retainProjectSettings(projectId, "settings", retained)} onDeletionRetentionChange={(retained) => retainProjectSettings(projectId, "delete", retained)} onPromptRetentionChange={(retained) => retainProjectSettings(projectId, "prompt", retained)} onTransferred={transfer.complete} onDeleted={(receipt, finish) => deletion.complete(receipt, finish)} onDeletionOutcome={(kind, error, check) => deletion.outcome(projectId, kind, error, check)} /></div>, host, projectId); })}
    <TeamSettingsWorkspace route={route} user={user} admission={admission} blocked={blocked} identityChecking={identityChecking} workspaceVisible={workspaceVisible} slot={teamSettingsSlot} guardedTeam={guardedTeam} setTeamGuard={setTeamGuard} onIdentityMismatch={onIdentityMismatch} onNameSaved={setSavedTeamResult} onMemberResult={saveMemberResult} onMemberStart={clearMemberResult} />
  </>;
};

const TeamWorkspace = ({ user, route, admission, admissionBlocked, onSignOut, onIdentityMismatch, blocked, identityBlocked, identityChecking, workspaceVisible, standaloneSlot, guardedTeam, setTeamGuard, children }: { readonly workspaceVisible: boolean; readonly standaloneSlot: HTMLDivElement | null; readonly user: CurrentUser; readonly route: AuthRoute; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly onSignOut: () => void; readonly onIdentityMismatch: () => void; readonly blocked: boolean; readonly identityBlocked: boolean; readonly identityChecking: boolean; readonly guardedTeam: (id: string) => boolean; readonly setTeamGuard: (id: string, source: "settings" | "members", guarded: boolean) => void; readonly children: ReactNode }) => {
  const preference = useCurrentTeamPreference();
  const selectedTeamId = preference.detail.id;
  const scope = route.kind === "sharedProjects" ? { kind: "shared" as const } : { kind: "team" as const, teamId: selectedTeamId };
  return <TeamsProvider preference={preference} admission={admission} admissionBlocked={admissionBlocked}><ProjectsProvider scope={scope} admission={admission} admissionBlocked={admissionBlocked || (scope.kind === "team" && preference.detail.status !== "ready")}><WorkspaceRoutes user={user} route={route} selectedTeamId={selectedTeamId} admission={admission} onSignOut={onSignOut} onIdentityMismatch={onIdentityMismatch} blocked={blocked} identityBlocked={identityBlocked} identityChecking={identityChecking} workspaceVisible={workspaceVisible} standaloneSlot={standaloneSlot} guardedTeam={guardedTeam} setTeamGuard={setTeamGuard}>{children}{preference.saveError && <TeamSaveError onRetry={preference.retrySave} />}</WorkspaceRoutes></ProjectsProvider></TeamsProvider>;
};

const TeamSaveError = ({ onRetry }: { readonly onRetry: () => void }) => {
  const m = useTeamMessages();
  return <div className="notice warning" role="alert"><p>{m.storageWrite}</p><button className="button" type="button" onClick={onRetry}>{m.retry}</button></div>;
};

const RevalidationOverlay = ({ failed, onRetry }: { readonly failed: boolean; readonly onRetry: () => void }) => {
  const { messages: { auth: { shell: m } } } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const resumeImages = suspendSessionImagePreviews();
    dialog.current!.showModal();
    return () => queueMicrotask(() => { if (opener instanceof HTMLElement && opener.isConnected && !opener.closest('dialog:not([open])')) opener.focus(); resumeImages(); });
  }, []);
  return <dialog ref={dialog} className="auth-revalidation-overlay" aria-label={m.revalidationLabel} onCancel={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}>
    {failed ? <div role="alert"><h1>{m.revalidationError}</h1><p>{m.revalidationRetained}</p><button className="button primary" type="button" onClick={onRetry}>{m.revalidationRetry}</button></div> : <div role="status"><span className="spinner" aria-hidden="true" /><p>{m.revalidationLoading}</p></div>}
  </dialog>;
};

type SessionNotice = "expired" | "signedOut" | "logoutFailed";
type Session = { readonly status: "loading" } | { readonly status: "error" } | { readonly status: "anonymous"; readonly notice?: SessionNotice } | { readonly status: "authenticated"; readonly user: CurrentUser; readonly generation: number };
type Revalidation = "idle" | "checking" | "error" | "retrying";
const assignLogin = (url: string) => window.location.assign(url);

export const AuthenticatedApp = ({ navigateToLogin = assignLogin }: { readonly navigateToLogin?: (url: string) => void }) => {
  const { locale, messages: { auth: { shell: m }, workspace: { app, projects } } } = useI18n();
  const botMessages = useBotMessages();
  const testMessages = useTestSessionListMessages();
  const [invitation, setInvitation] = useState<PendingInvitation>({ token: null, scope: null, storageUnavailable: false, cleanupFailed: false });
  const location = useBrowserLocation();
  const invitationLocationSeen = useRef<typeof location | null>(null);
  const { pathname, search } = location;
  const [invitationRevision, setInvitationRevision] = useState(0);
  const invitationLifetime = useRef(new AbortController());
  const [session, setSession] = useState<Session>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [revalidation, setRevalidation] = useState<Revalidation>("idle");
  const [standaloneSlot, setStandaloneSlot] = useState<HTMLDivElement | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [privateCleanup, setPrivateCleanup] = useState<ReadonlyMap<string, Error>>(new Map());
  const discardPrivateSession = useCallback((userId: string) => {
    void clearPrivateSessionState(userId).then(error => {
      if (!mounted.current) return;
      setPrivateCleanup((previous) => {
        const next = new Map(previous);
        if (error === null) next.delete(userId);
        else next.set(userId, error);
        return next;
      });
    });
  }, []);
  const retryPrivateCleanup = () => {
    for (const userId of privateCleanup.keys()) {
      const webhookError = clearWebhookPending(window.location.origin, userId);
      void retryBotDisplaySnapshotCleanup(userId).then(cleared => {
        if (!mounted.current) return;
        const error = cleared ? webhookError : new Error('Assistant display snapshots could not be cleared.');
        setPrivateCleanup(previous => {
          const next = new Map(previous);
          if (error === null) next.delete(userId); else next.set(userId, error);
          return next;
        });
      });
    }
  };
  const logoutContinuation = useRef<string | null>(null);
  const [cleanupFailed, setCleanupFailed] = useState(() => !invitationLocation(window.location.pathname, window.location.search) && !clearInvitation());
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const resumeAuthRequests = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const cacheScope = useRef<TaskCacheScope | null>(null);
  const identityRecheck = useRef<() => void>(() => {});
  const memberGuards = useRef<{ identity: string; teams: Map<string, Set<"settings" | "members">> }>({ identity: "", teams: new Map() });
  const [, updateMemberGuards] = useState(0);
  const guardedTeam = useCallback((id: string) => memberGuards.current.teams.has(id), []);
  const setTeamGuard = useCallback((id: string, source: "settings" | "members", guarded: boolean) => {
    const teams = memberGuards.current.teams;
    const sources = teams.get(id) ?? new Set<"settings" | "members">();
    if (sources.has(source) === guarded) return;
    if (guarded) { sources.add(source); teams.set(id, sources); }
    else { sources.delete(source); if (sources.size === 0) teams.delete(id); }
    updateMemberGuards((value) => value + 1);
  }, []);
  const route = parseAuthRoute(pathname, search);
  const navigation = new URLSearchParams(search);
  navigation.delete("authError");
  const requestedPath = route.kind === "login" ? route.returnPath : route.kind === "notFound" ? null : route.kind === "invitations" ? "/invitations" : route.kind === "teamInvitations" ? "/team-invitations" : pathname + (navigation.size === 0 ? "" : `?${navigation}`);
  const returnPath = requestedPath !== null && isLoginReturnPath(requestedPath) ? requestedPath : null;
  const target = returnPath === null ? null : new URL(returnPath, window.location.origin);
  const destination = target === null ? route : parseAuthRoute(target.pathname, target.search);
  const invitationFlow = invitationLocation(pathname, search);
  const teamMessages = useTeamMessages();
  const invitationRef = useRef(invitation); invitationRef.current = invitation;
  const invitationFlowRef = useRef(invitationFlow); invitationFlowRef.current = invitationFlow;
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    const page = session.status === "authenticated" ? route.kind : session.status === "anonymous" ? "login" : session.status;
    document.title = page === "webhooks" ? "Webhooks · Daynight" : (page === "bots" || page === "bot") ? `${botMessages.title} · Daynight` : (page === "team" || page === "teamSettings" || page === "teamMembers") ? `${page === "team" ? teamMessages.teamProjects : teamMessages.settings} · Daynight` : page === "sharedProjects" ? `${teamMessages.shared} · Daynight` : page === "testSessions" ? `${testMessages.title} · Daynight` : page === "testSession" ? `${testMessages.session} · Daynight` : (page === "attachment" || page === "task") ? app.documentTitle.task : page === "oauthConsent" ? m.documentTitle.device : m.documentTitle[page];
  }, [locale, botMessages.title, m.documentTitle, app.documentTitle.task, route.kind, session.status, testMessages.title, testMessages.session, teamMessages.teamProjects, teamMessages.settings, teamMessages.shared]);
  const [loginError] = useState(() => {
    const parameters = new URLSearchParams(window.location.search);
    const failed = parameters.get("authError") === "login_failed";
    if (parameters.has("authError")) { parameters.delete("authError"); window.history.replaceState(window.history.state, "", window.location.pathname + (parameters.size === 0 ? "" : `?${parameters}`)); }
    return failed;
  });
  const discardInvitation = useCallback(() => {
    invitationLifetime.current.abort(); setCleanupFailed(!clearInvitation());
    const empty = { token: null, scope: null, storageUnavailable: false, cleanupFailed: false } as const;
    invitationRef.current = empty; setInvitation(empty);
  }, []);
  const clearSession = useCallback((notice?: SessionNotice) => {
    if (invitationFlowRef.current && invitationRef.current.token !== null) {
      const pending = persistInvitation(invitationRef.current);
      invitationRef.current = pending;
      setInvitation(pending);
    }
    if (sessionRef.current.status === "authenticated") discardPrivateSession(sessionRef.current.user.id);
    void cacheScope.current?.invalidateScope(); cacheScope.current = null;
    invalidateAuthRequests(); ++generation.current; active.current?.abort(); active.current = null;
    setRevalidation("idle"); setSession({ status: "anonymous", ...(notice === undefined ? {} : { notice }) });
  }, []);
  useEffect(() => subscribeUnauthorized(() => clearSession(sessionRef.current.status === "authenticated" ? "expired" : undefined)), [clearSession]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); invitationLifetime.current.abort(); cacheScope.current?.dispose(); invalidateAuthRequests(); };
  }, []);
  useLayoutEffect(() => {
    const initial = invitationLocationSeen.current === null;
    if (invitationLocationSeen.current === location) return;
    const previous = invitationLocationSeen.current;
    invitationLocationSeen.current = location;
    // Capture before API effects; the scrubbed snapshot must not recapture a memory-only invitation.
    const invitationPath = location.pathname === "/invitations" || location.pathname === "/team-invitations";
    const enteredInvitation = previous !== null && previous.pathname !== location.pathname &&
      (previous.pathname !== "/login" || new URLSearchParams(previous.search).get("returnPath") !== location.pathname);
    if (initial || invitationPath && (location.hash !== "" || enteredInvitation)) {
      const incoming = captureInvitation();
      if (sessionRef.current.status === "authenticated") setCleanupFailed(!clearInvitation());
      invitationLifetime.current.abort();
      invitationLifetime.current = new AbortController();
      invitationRef.current = incoming;
      setInvitation(incoming); setInvitationRevision((value) => value + 1);
    }
  }, [location]);
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    const current = ++generation.current;
    const resume = resumeAuthRequests.current;
    if (sessionRef.current.status !== "authenticated") setSession({ status: "loading" });
    void me(controller.signal).then((user) => {
      if (controller.signal.aborted || current !== generation.current) return;
      if (invitationFlowRef.current) setCleanupFailed(!clearInvitation());
      const previous = sessionRef.current;
      if (previous.status === "authenticated" && previous.user.id !== user.id && invitationFlowRef.current) discardInvitation();
      if (previous.status === "authenticated" && previous.user.id === user.id && !cacheScope.current?.isInvalidated) {
        setSession({ ...previous, user });
      } else {
        if (previous.status === "authenticated") discardPrivateSession(previous.user.id);
        void cacheScope.current?.invalidateScope();
        cacheScope.current = createTaskCacheScope({ userId: user.id, onIdentityMismatch: () => identityRecheck.current() });
        invalidateAuthRequests();
        setSession({ status: "authenticated", user, generation: current });
      }
      setRevalidation("idle");
      resume?.(); resumeAuthRequests.current = null;
    }).catch((error: unknown) => {
      if (controller.signal.aborted || current !== generation.current || isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 401) clearSession(sessionRef.current.status === "authenticated" ? "expired" : undefined);
      else if (sessionRef.current.status === "authenticated") setRevalidation("error");
      else setSession({ status: "error" });
    });
    return () => controller.abort();
  }, [attempt, clearSession, discardInvitation]);
  const completeInvitation = useCallback((projectId: string) => { discardInvitation(); navigate(`/projects/${projectId}`); }, [discardInvitation]);
  const cancelInvitation = useCallback(() => { discardInvitation(); navigate("/projects"); }, [discardInvitation]);
  const unavailableInvitation = discardInvitation;
  useEffect(() => { if (!invitationFlow && invitation.token !== null) discardInvitation(); }, [invitationFlow, invitation.token, discardInvitation]);
  const signOut = useCallback((continuation: string | null = null) => {
    logoutContinuation.current = continuation;
    setLogoutFailed(false); setLogoutPending(true);
    const controller = new AbortController();
    const request = logout(controller.signal);
    clearSession("signedOut");
    const complete = () => {
      if (!mounted.current) return;
      setLogoutPending(false);
      if (continuation === null) navigate("/");
      else replaceRoute(loginUrl(continuation));
    };
    void request.then(complete).catch((error: unknown) => {
      if (!mounted.current || isAbortError(error)) return;
      if (error instanceof ApiError && error.status === 401) { complete(); return; }
      setLogoutPending(false); setLogoutFailed(true); setSession({ status: "anonymous", notice: "logoutFailed" });
    });
  }, [clearSession]);
  useLayoutEffect(() => {
    if (returnPath === null || logoutPending) return;
    if (session.status === "authenticated" && route.kind === "login") replaceRoute(returnPath);
    else if (session.status === "anonymous" && route.kind !== "login" && route.kind !== "notFound") replaceRoute(loginUrl(returnPath));
  }, [session.status, route.kind, returnPath, logoutPending]);
  const pauseIdentity = useCallback(() => {
    active.current?.abort(); active.current = null; ++generation.current;
    resumeAuthRequests.current = pauseAuthRequests();
  }, []);
  const recheckIdentity = useCallback(() => {
    pauseIdentity();
    setRevalidation((previous) => previous === "error" || previous === "retrying" ? "retrying" : "checking");
    setAttempt((value) => value + 1);
  }, [pauseIdentity]);
  const invalidateIdentity = useCallback(() => {
    if (invitationFlowRef.current) discardInvitation();
    if (sessionRef.current.status === "authenticated") discardPrivateSession(sessionRef.current.user.id);
    void cacheScope.current?.invalidateScope(); cacheScope.current = null;
    invalidateAuthRequests();
    pauseIdentity();
    // A proven principal change revokes the rendered identity before another private response can publish.
    flushSync(() => {
      setRevalidation("idle"); setSession({ status: "loading" });
    });
    setAttempt((value) => value + 1);
  }, [pauseIdentity, discardInvitation]);
  identityRecheck.current = invalidateIdentity;
  const blocked = revalidation === "error" || revalidation === "retrying";
  useLayoutEffect(() => {
    document.body.classList.toggle("auth-session-checking", blocked);
    return () => document.body.classList.remove("auth-session-checking");
  }, [blocked]);
  // Departure gates foreground reads regardless of visibility/focus listener order.
  // Layout setup also guards child request effects when the workspace mounts away.
  useLayoutEffect(() => {
    if (session.status !== "authenticated") return;
    let topLevelAway = false;
    const departed = () => {
      if (topLevelAway) return;
      topLevelAway = true;
      pauseIdentity();
    };
    const lostFocus = () => { if (!document.hasFocus()) departed(); };
    const returned = () => {
      // Iframe-to-parent focus changes keep the top-level document focused.
      if (!topLevelAway || document.visibilityState === "hidden" || !document.hasFocus()) return;
      topLevelAway = false;
      recheckIdentity();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") departed();
      else returned();
    };
    window.addEventListener("blur", lostFocus);
    window.addEventListener("focus", returned);
    document.addEventListener("visibilitychange", visibilityChanged);
    if (document.visibilityState === "hidden" || !document.hasFocus()) departed();
    return () => {
      window.removeEventListener("blur", lostFocus);
      window.removeEventListener("focus", returned);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [session.status, pauseIdentity, recheckIdentity]);
  const startLogin = (provider: AuthProvider) => {
    if (returnPath === null) throw new Error("The login destination has not been validated.");
    const parameters = new URLSearchParams({ provider, returnPath });
    navigateToLogin(`/api/v1/auth/login?${parameters}`);
  };
  const cleanupWarning = <>{(cleanupFailed || invitation.cleanupFailed) && <div className="notice warning" role="alert">{m.invitationCleanupError}</div>}{privateCleanup.size > 0 && <div className="notice warning" role="alert"><p>{locale === "zh-CN" ? "无法清理本地恢复记录。" : "Local recovery records could not be cleared."}</p><button className="button" type="button" onClick={retryPrivateCleanup}>{locale === "zh-CN" ? "重试清理" : "Retry cleanup"}</button></div>}</>;
  const invalidTarget = <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="alert"><h1>{m.invalidLoginTarget}</h1><p>{m.invalidLoginTargetDetail}</p><LanguageSelector /><a className="button primary" href="/login">{m.startFreshLogin}</a></section></main></>;
  const notFound = <>{cleanupWarning}<main className="auth-main"><section className="state-box"><h1>{app.notFound}</h1><LanguageSelector /><a className="button primary" href="/projects" onClick={followLink}>{app.returnToProjects}</a></section></main></>;
  const identityLoading = <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{m.identityLoading}</h1><LanguageSelector /></section></main></>;
  if (session.status !== "authenticated" && returnPath === null && (route.kind === "login" || route.kind !== "notFound" && session.status === "anonymous")) return invalidTarget;
  if (session.status !== "authenticated" && route.kind === "notFound") return notFound;
  if (logoutPending) return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{m.signingOut}</h1><LanguageSelector /></section></main></>;
  if (session.status === "loading") return identityLoading;
  if (session.status === "error") return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="alert"><h1>{m.identityError}</h1><p>{m.networkRetry}</p><LanguageSelector /><button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button></section></main></>;
  if (session.status === "anonymous") return <>{cleanupWarning}{invitationFlow && invitation.storageUnavailable && <div className="notice warning" role="alert">{m.invitationStorageError}</div>}<LoginPage invitation={destination.kind === "invitations" || destination.kind === "teamInvitations"} device={destination.kind === "device"} oauth={destination.kind === "oauthConsent"} {...(session.notice !== undefined ? { notice: m.notice[session.notice] } : loginError ? { notice: m.notice.loginFailed } : {})} onLogin={startLogin} />{logoutFailed && <button className="button" type="button" onClick={() => signOut(logoutContinuation.current)}>{m.retryLogout}</button>}</>;
  const identity = `${session.user.id}:${session.generation}`;
  if (memberGuards.current.identity !== identity) memberGuards.current = { identity, teams: new Map() };
  const revalidationOverlay = blocked ? <RevalidationOverlay failed={revalidation === "error"} onRetry={recheckIdentity} /> : null;
  const preferenceRoute = route.kind === "projects" ? "default" : (route.kind === "team" || route.kind === "teamSettings" || route.kind === "teamMembers") ? route.teamId : null;
  const workspaceRoute = !["login", "notFound", "attachment", "task", "teamInvitations", "invitations", "device", "oauthConsent"].includes(route.kind);
  const taskRoute = route.kind === "attachment" || route.kind === "task";
  const content = route.kind === "login" ? returnPath === null ? invalidTarget : identityLoading : route.kind === "notFound" ? <>{revalidationOverlay}{notFound}</> : route.kind === "attachment" || route.kind === "task" ? <>{revalidationOverlay}{cleanupWarning}<div className="auth-shell" key={identity} aria-hidden={blocked} inert={blocked}>
    <TaskDetailPage key={route.projectId} projectId={route.projectId} taskId={route.taskId} navigation={{ tab: route.tab, path: route.path }} />
  </div></> : route.kind === "teamInvitations" ? <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><TeamInvitationPage key={`${identity}:${invitationRevision}`} lifetime={invitationLifetime.current.signal} invitation={invitation.scope === "project" ? { token: null, scope: null, storageUnavailable: false, cleanupFailed: false } : invitation} user={session.user} onAccepted={discardInvitation} onOpenTeam={(teamId) => navigate(`/teams/${teamId}`)} onCancel={cancelInvitation} onSwitchAccount={() => signOut(returnPath)} onUnavailable={unavailableInvitation} onIdentityMismatch={invalidateIdentity} /></div></> : route.kind === "invitations" ? <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><InvitationPage key={`${identity}:${invitationRevision}`} lifetime={invitationLifetime.current.signal} invitation={invitation.scope === "team" ? { token: null, scope: null, storageUnavailable: false, cleanupFailed: false } : invitation} user={session.user} onComplete={completeInvitation} onCancel={cancelInvitation} onSwitchAccount={() => signOut(returnPath)} onUnavailable={unavailableInvitation} onIdentityMismatch={invalidateIdentity} /></div></> : route.kind === "oauthConsent" ? <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><OAuthConsentPage key={`${identity}:${route.requestId}`} user={session.user} requestId={route.requestId} onSwitchAccount={() => signOut(returnPath)} onIdentityMismatch={invalidateIdentity} /></div></> : route.kind === "device" ? <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><DeviceAuthorizationPage key={`${identity}:${route.userCode}`} user={session.user} initialCode={route.userCode} onSwitchAccount={() => signOut(returnPath)} onIdentityMismatch={invalidateIdentity} /></div></> : null;
  return <CurrentAccountProvider user={session.user} admissionBlocked={revalidation !== "idle"}><TaskCacheProvider key={identity} scope={cacheScope.current!}><WebhookCatalogProvider active={workspaceRoute}><TeamPreferenceProvider personal={session.user.personalTeam} routeKey={preferenceRoute} restoreOnEntry={workspaceRoute} admission={cacheScope.current!} blocked={revalidation !== "idle"} guardUnavailable={guardedTeam}><TaskAssigneesProvider><TaskDetailSessionProvider>{workspaceRoute ? content : <div className={taskRoute ? "standalone-task-route" : "standalone-other-route"}>{content}<div className="standalone-deletion-slot" ref={setStandaloneSlot} /></div>}{workspaceRoute && revalidationOverlay}<TeamWorkspace user={session.user} route={route} admission={cacheScope.current!} admissionBlocked={revalidation !== "idle" || !workspaceRoute} onSignOut={() => signOut()} onIdentityMismatch={invalidateIdentity} blocked={blocked || !workspaceRoute} identityBlocked={blocked} identityChecking={revalidation !== "idle"} workspaceVisible={workspaceRoute} standaloneSlot={standaloneSlot} guardedTeam={guardedTeam} setTeamGuard={setTeamGuard}>{cleanupWarning}</TeamWorkspace></TaskDetailSessionProvider></TaskAssigneesProvider></TeamPreferenceProvider></WebhookCatalogProvider></TaskCacheProvider></CurrentAccountProvider>;
};
