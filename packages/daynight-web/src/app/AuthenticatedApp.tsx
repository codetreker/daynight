import { CurrentAccountProvider } from './CurrentAccountContext';
import { clearSessionDrafts } from '../features/task-agent-session/client';
import { TestSessionPage } from '../features/task-agent-session/TestSessionPage';
import { TestSessionListPage } from '../features/task-agent-session/TestSessionListPage';
import { useTestSessionListMessages } from '../features/task-agent-session/test-session-list-messages';
import { createPortal, flushSync } from "react-dom";
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from "../features/task-cache/TaskCacheProvider";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { logout, me } from "../api/auth";
import type { AuthProvider, CurrentUser, ProjectRole } from "../api/auth-types";
import { ApiError, invalidateAuthRequests, isAbortError, pauseAuthRequests, subscribeUnauthorized } from "../api/client";
import type { Project } from "../api/types";
import { AccountPage } from "../features/management/AccountPage";
import { ProjectSettingsPanel } from "../features/management/ProjectSettingsPanel";
import { MembersPanel } from "../features/management/MembersPanel";
import { CreateProjectDialog } from "../features/auth/CreateProjectDialog";
import { InvitationPage } from "../features/auth/InvitationPage";
import { TeamInvitationPage } from "../features/auth/TeamInvitationPage";
import { LoginPage } from "../features/auth/LoginPage";
import { DeviceAuthorizationPage } from "../features/auth/DeviceAuthorizationPage";
import { captureInvitation, clearInvitation, persistInvitation } from "../features/auth/invitation";
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
import { CreateTeamDialog, TeamSettingsPanel } from "../features/teams/TeamManagement";
import { TeamMembersPanel } from "../features/teams/TeamMembersPanel";
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

const Workspace = ({ user, children, route, selectedTeamId, onSignOut, blocked, identityChecking, onCreateTeam }: { readonly onCreateTeam: () => void; readonly selectedTeamId: string; readonly user: CurrentUser; readonly children: ReactNode; readonly route: AuthRoute; readonly onSignOut: () => void; readonly blocked: boolean; readonly identityChecking: boolean }) => {
  const { messages: { auth: { shell: m }, workspace: { app }, setup } } = useI18n();
  const testMessages = useTestSessionListMessages();
  const teamMessages = useTeamMessages();
  const teams = useTeams();
  const content = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarPreference();
  const resourceId = "projectId" in route ? route.projectId : "workerId" in route ? route.workerId : "teamId" in route ? route.teamId : null;
  const label = route.kind === "workers" ? m.workers : route.kind === "worker" ? m.worker : route.kind === "testSessions" ? testMessages.title : route.kind === "testSession" ? testMessages.session : (route.kind === "projects" || route.kind === "team") ? teams.detail.team?.kind === "personal" ? teamMessages.personal : teams.detail.team?.name ?? teamMessages.teamProjects : route.kind === "teamSettings" ? teamMessages.settings : route.kind === "teamMembers" ? teamMessages.members : route.kind === "sharedProjects" ? teamMessages.shared : route.kind === "account" ? m.accountSettings : route.kind === "members" ? m.members : route.kind === "settings" ? m.projectSettings : route.kind === "project" ? app.projectTasks : app.notFound;
  useLayoutEffect(() => { if (!blocked) content.current?.focus(); }, [route.kind, resourceId, blocked]);
  return (
    <div className={`shell auth-shell${sidebar.collapsed ? " sidebar-collapsed" : ""}${route.kind === "testSession" ? " test-session-shell" : ""}`} aria-hidden={blocked} inert={blocked}>
      <WorkspaceSidebar collapsed={sidebar.collapsed} onToggle={sidebar.toggle} routeKey={route.kind + (resourceId === null ? "" : `:${resourceId}`)} projectsActive={route.kind === "projects" || route.kind === "team"} sharedActive={route.kind === "sharedProjects"} teamSettingsActive={route.kind === "teamSettings"} teamMembersActive={route.kind === "teamMembers"} personalId={user.personalTeam.id} selectedTeamId={selectedTeamId} workersActive={route.kind === "workers" || route.kind === "worker"} activeProjectId={"projectId" in route ? route.projectId : null} testSessionsActive={route.kind === "testSessions" || route.kind === "testSession"} identityChecking={identityChecking} workspaceRef={workspace} onNavigate={() => queueMicrotask(() => content.current?.focus())} onCreateTeam={onCreateTeam} />
      <div className="workspace" ref={workspace}>
        <a className="skip-link" href="#main-content">{app.skipToContent}</a>
        <header className="topbar">
          <nav className="crumb" aria-label={app.breadcrumb}><a href="/projects" onClick={followLink}>{app.workspace}</a><span aria-hidden="true">/</span>{route.kind === "worker" && <><a href="/workers" onClick={followLink}>{m.workers}</a><span aria-hidden="true">/</span></>}<span className="crumb-current" aria-current="page">{label}</span></nav>
          <div className="account-actions">
            <a className="setup-guide-link" href="/setup" target="_blank" rel="noopener noreferrer"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v15M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3z" /></svg>{setup.navigation}</a>
            <LanguageSelector />
            <AccountMenu name={accountLabel(user, m.currentAccount)} />
            <button className="inline-link" type="button" onClick={onSignOut}>{m.signOut}</button>
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

const WorkspaceRoutes = ({ user, route, selectedTeamId, admission, onSignOut, onIdentityMismatch, blocked, identityChecking, workspaceVisible, guardedTeam, setTeamGuard, children }: { readonly workspaceVisible: boolean; readonly admission: TaskCacheScope; readonly selectedTeamId: string; readonly user: CurrentUser; readonly route: AuthRoute; readonly onSignOut: () => void; readonly onIdentityMismatch: () => void; readonly blocked: boolean; readonly identityChecking: boolean; readonly guardedTeam: (id: string) => boolean; readonly setTeamGuard: (id: string, guarded: boolean) => void; readonly children: ReactNode }) => {
  const { messages: { auth: { shell: m }, workspace: { app }, common } } = useI18n();
  const projects = useProjectList();
  const teams = useTeams();
  const teamMessages = useTeamMessages();
  const [creating, setCreating] = useState<{ readonly id: string; readonly name: string; readonly personal: boolean } | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [memberResults, setMemberResults] = useState<ReadonlyMap<string, "changed" | "left">>(() => new Map());
  const clearMemberResult = (teamId: string) => setMemberResults((previous) => {
    if (!previous.has(teamId)) return previous;
    const next = new Map(previous); next.delete(teamId); return next;
  });
  const saveMemberResult = (teamId: string, kind: "changed" | "left") => setMemberResults((previous) => new Map(previous).set(teamId, kind));
  const mountedSettings = useRef<string | null>(null), mountedMembers = useRef<{ id: string; host: HTMLDivElement }[]>([]);
  const memberSlot = useRef<HTMLDivElement>(null);
  // Keep each portal's host stable across standalone routes so dispatched writes retain their owner.
  const attachMemberSlot = useCallback((slot: HTMLDivElement | null) => { memberSlot.current = slot; if (slot) for (const member of mountedMembers.current) if (member.host.parentNode !== slot) slot.appendChild(member.host); }, []);
  useLayoutEffect(() => { const slot = memberSlot.current; if (slot) for (const member of mountedMembers.current) if (member.host.parentNode !== slot) slot.appendChild(member.host); });
  if (route.kind !== "teamSettings" || mountedSettings.current !== route.teamId) mountedSettings.current = null;
  const settingsReady = route.kind === "teamSettings" && teams.detail.status === "ready" && teams.detail.id === route.teamId && !identityChecking && !blocked;
  if (settingsReady && route.kind === "teamSettings") mountedSettings.current = route.teamId;
  const membersReady = route.kind === "teamMembers" && teams.detail.id === route.teamId && (teams.detail.status === "ready" || teams.detail.status === "error" && guardedTeam(route.teamId)) && !identityChecking && !blocked;
  if (membersReady && route.kind === "teamMembers" && !mountedMembers.current.some((member) => member.id === route.teamId)) mountedMembers.current.push({ id: route.teamId, host: document.createElement("div") });
  return <>{workspaceVisible && <Workspace user={user} route={route} selectedTeamId={selectedTeamId} onSignOut={onSignOut} blocked={blocked} identityChecking={identityChecking} onCreateTeam={() => setCreatingTeam(true)}>
    {children}{[...memberResults].map(([teamId, kind]) => <div key={teamId} className="notice" role="status">{kind === "left" ? teamMessages.left : teamMessages.memberChanged} <code>{teamId}</code> <button type="button" className="button quiet" onClick={() => clearMemberResult(teamId)}>{teamMessages.dismiss}</button></div>)}{route.kind === "workers" ? <WorkersPage readEnabled={!identityChecking && !blocked} /> : route.kind === "worker" ? <WorkerDetailPage key={route.workerId} workerId={route.workerId} readEnabled={!identityChecking && !blocked} /> : route.kind === "testSessions" ? <TestSessionListPage /> : route.kind === "testSession" ? <TestSessionPage key={route.sessionId} sessionId={route.sessionId} /> : route.kind === "sharedProjects" ? <ProjectsPage title={teamMessages.sharedProjects} subtitle={teamMessages.sharedSubtitle} emptyDetail={teamMessages.sharedEmpty} /> : route.kind === "projects" || route.kind === "team" || route.kind === "teamSettings" || route.kind === "teamMembers" ? teams.detail.status === "loading" ? <section className="state-box" role="status">{teamMessages.loading}</section> : teams.detail.status === "error" ? <section className="state-box" role="alert"><h1>{teamMessages.failed}</h1><p>{teams.detail.storageError ? teamMessages.storageRead : teams.detail.error instanceof ApiError && teams.detail.error.kind === "server" && ((teams.detail.error.status === 403 && teams.detail.error.code === "forbidden") || (teams.detail.error.status === 404 && teams.detail.error.code === "not_found")) ? teamMessages.unavailable : teams.detail.error instanceof ApiError && teams.detail.error.kind === "network" ? teamMessages.network : teamMessages.readError}</p>{teams.detail.error instanceof ApiError && teams.detail.error.requestId !== null && <p>{common.requestId}<code>{teams.detail.error.requestId}</code></p>}<button className="button" type="button" onClick={teams.refreshDetail}>{teamMessages.retry}</button></section> : (route.kind === "teamSettings" || route.kind === "teamMembers") ? null : <ProjectsPage title={teams.detail.team!.kind === "personal" ? teamMessages.personal : teams.detail.team!.name!} subtitle={teams.detail.team!.kind === "personal" ? teamMessages.personalSubtitle : teamMessages.teamSubtitle} onCreate={() => setCreating({ id: selectedTeamId, name: teams.detail.team!.kind === "personal" ? teamMessages.personal : teams.detail.team!.name!, personal: teams.detail.team!.kind === "personal" })} /> : route.kind === "project" ? <ProjectAccessBoundary key={route.projectId} projectId={route.projectId}><AuthorizedProject projectId={route.projectId} user={user} onOpenMembers={(project) => { setProjectName(project.name); navigate(`/projects/${project.id}/members`); }} /></ProjectAccessBoundary> : route.kind === "settings" ? <><ProjectManagementNav projectId={route.projectId} current="settings" /><ProjectSettingsPanel key={route.projectId} projectId={route.projectId} user={user} /></> : route.kind === "members" ? <><ProjectManagementNav projectId={route.projectId} current="members" /><MembersPanel key={route.projectId} projectId={route.projectId} projectName={projectName ?? m.genericProject} user={user} onRemoved={() => { projects.refresh(); navigate("/projects"); }} onUnavailable={projects.refresh} /></> : route.kind === "account" ? <AccountPage user={user} onSignOut={onSignOut} onIdentityMismatch={onIdentityMismatch} /> : <section className="state-box"><h1>{app.notFound}</h1><a className="button primary" href="/projects" onClick={followLink}>{app.returnToProjects}</a></section>}
    {route.kind === "teamSettings" && mountedSettings.current === route.teamId && <div hidden={!settingsReady} inert={!settingsReady}><TeamSettingsPanel key={route.teamId} teamId={route.teamId} active={settingsReady} admission={admission} onIdentityMismatch={onIdentityMismatch} onDeleted={() => { teams.refreshList(); navigate(`/teams/${user.personalTeam.id}`); }} onUnavailable={() => { const result = teams.forgetUnavailable(route.teamId); if (result === "forgotten") navigate("/projects"); return result; }} onUpdated={(team) => { teams.acceptTeam(team); teams.refreshList(); }} /></div>}
    <div ref={attachMemberSlot} />
    {creatingTeam && <CreateTeamDialog admission={admission} active={!identityChecking && !blocked} onIdentityMismatch={onIdentityMismatch} onClose={() => setCreatingTeam(false)} onCreated={(team) => { setCreatingTeam(false); teams.refreshList(); navigate(`/teams/${team.id}`); }} />}
    {creating !== null && <CreateProjectDialog admission={admission} teamId={creating.id} teamName={creating.name} teamPersonal={creating.personal} userId={user.id} onIdentityMismatch={onIdentityMismatch} onClose={() => setCreating(null)} onCreated={(project) => { setCreating(null); projects.refresh(); navigate(`/projects/${project.id}`); }} />}
  </Workspace>}
    {mountedMembers.current.map(({ id: teamId, host }) => { const active = route.kind === "teamMembers" && route.teamId === teamId && membersReady; return createPortal(<div hidden={!active} inert={!active}><TeamMembersPanel teamId={teamId} active={active} onRoute={route.kind === "teamMembers" && route.teamId === teamId} admission={admission} onIdentityMismatch={onIdentityMismatch} onGuardChange={(guarded) => setTeamGuard(teamId, guarded)} onUnavailable={() => { if (!active) return "changed"; const result = teams.forgetUnavailable(teamId); if (result === "forgotten") navigate("/projects"); return result; }} onStart={() => clearMemberResult(teamId)} onChanged={(confirmed) => { if (confirmed) saveMemberResult(teamId, "changed"); if (route.kind === "teamMembers" && route.teamId === teamId) teams.refreshDetail(); teams.refreshList(); }} onLeft={() => { saveMemberResult(teamId, "left"); teams.leaveTeam(teamId); teams.refreshList(); const current = parseAuthRoute(window.location.pathname, window.location.search); if (route.kind === "teamMembers" && route.teamId === teamId && current.kind === "teamMembers" && current.teamId === teamId) navigate(`/teams/${user.personalTeam.id}`); }} /></div>, host, teamId); })}
  </>;
};

const TeamWorkspace = ({ user, route, admission, admissionBlocked, onSignOut, onIdentityMismatch, blocked, identityChecking, workspaceVisible, guardedTeam, setTeamGuard, children }: { readonly workspaceVisible: boolean; readonly user: CurrentUser; readonly route: AuthRoute; readonly admission: TaskCacheScope; readonly admissionBlocked: boolean; readonly onSignOut: () => void; readonly onIdentityMismatch: () => void; readonly blocked: boolean; readonly identityChecking: boolean; readonly guardedTeam: (id: string) => boolean; readonly setTeamGuard: (id: string, guarded: boolean) => void; readonly children: ReactNode }) => {
  const preference = useCurrentTeamPreference();
  const selectedTeamId = preference.detail.id;
  const scope = route.kind === "sharedProjects" ? { kind: "shared" as const } : { kind: "team" as const, teamId: selectedTeamId };
  return <TeamsProvider preference={preference} admission={admission} admissionBlocked={admissionBlocked}><ProjectsProvider scope={scope} admission={admission} admissionBlocked={admissionBlocked || ((route.kind === "projects" || route.kind === "team" || route.kind === "teamSettings" || route.kind === "teamMembers") && preference.detail.status !== "ready")}><WorkspaceRoutes user={user} route={route} selectedTeamId={selectedTeamId} admission={admission} onSignOut={onSignOut} onIdentityMismatch={onIdentityMismatch} blocked={blocked} identityChecking={identityChecking} workspaceVisible={workspaceVisible} guardedTeam={guardedTeam} setTeamGuard={setTeamGuard}>{children}{preference.saveError && <TeamSaveError onRetry={preference.retrySave} />}</WorkspaceRoutes></ProjectsProvider></TeamsProvider>;
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
    dialog.current!.showModal();
    return () => queueMicrotask(() => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); });
  }, []);
  return <dialog ref={dialog} className="auth-revalidation-overlay" aria-label={m.revalidationLabel} onCancel={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}>
    <LanguageSelector />
    {failed ? <div role="alert"><h1>{m.revalidationError}</h1><p>{m.revalidationRetained}</p><button className="button primary" type="button" onClick={onRetry}>{m.revalidationRetry}</button></div> : <div role="status"><span className="spinner" aria-hidden="true" /><p>{m.revalidationLoading}</p></div>}
  </dialog>;
};

type SessionNotice = "expired" | "signedOut" | "logoutFailed";
type Session = { readonly status: "loading" } | { readonly status: "error" } | { readonly status: "anonymous"; readonly notice?: SessionNotice } | { readonly status: "authenticated"; readonly user: CurrentUser; readonly generation: number };
type Revalidation = "idle" | "checking" | "error" | "retrying";
const assignLogin = (url: string) => window.location.assign(url);

export const AuthenticatedApp = ({ navigateToLogin = assignLogin }: { readonly navigateToLogin?: (url: string) => void }) => {
  const { locale, messages: { auth: { shell: m }, workspace: { app, projects } } } = useI18n();
  const testMessages = useTestSessionListMessages();
  const [invitation, setInvitation] = useState(captureInvitation);
  const location = useBrowserLocation();
  const invitationLocationSeen = useRef(location);
  const { pathname, search } = location;
  const [invitationRevision, setInvitationRevision] = useState(0);
  const invitationLifetime = useRef(new AbortController());
  const [session, setSession] = useState<Session>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [revalidation, setRevalidation] = useState<Revalidation>("idle");
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const logoutContinuation = useRef<string | null>(null);
  const [cleanupFailed, setCleanupFailed] = useState(() => !invitationLocation(window.location.pathname, window.location.search) && !clearInvitation());
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const resumeAuthRequests = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const cacheScope = useRef<TaskCacheScope | null>(null);
  const identityRecheck = useRef<() => void>(() => {});
  const memberGuards = useRef<{ identity: string; teams: Set<string> }>({ identity: "", teams: new Set() });
  const [, updateMemberGuards] = useState(0);
  const guardedTeam = useCallback((id: string) => memberGuards.current.teams.has(id), []);
  const setTeamGuard = useCallback((id: string, guarded: boolean) => {
    const teams = memberGuards.current.teams;
    if (teams.has(id) === guarded) return;
    if (guarded) teams.add(id); else teams.delete(id);
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
    document.title = (page === "team" || page === "teamSettings" || page === "teamMembers") ? `${page === "teamSettings" ? teamMessages.settings : page === "teamMembers" ? teamMessages.members : teamMessages.teamProjects} · Daynight` : page === "sharedProjects" ? `${teamMessages.shared} · Daynight` : page === "testSessions" ? `${testMessages.title} · Daynight` : page === "testSession" ? `${testMessages.session} · Daynight` : (page === "attachment" || page === "task") ? app.documentTitle.task : m.documentTitle[page];
  }, [locale, m.documentTitle, app.documentTitle.task, route.kind, session.status, testMessages.title, testMessages.session, teamMessages.teamProjects, teamMessages.settings, teamMessages.members, teamMessages.shared]);
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
    if (sessionRef.current.status === "authenticated") clearSessionDrafts(sessionRef.current.user.id);
    void cacheScope.current?.invalidateScope(); cacheScope.current = null;
    invalidateAuthRequests(); ++generation.current; active.current?.abort(); active.current = null;
    setRevalidation("idle"); setSession({ status: "anonymous", ...(notice === undefined ? {} : { notice }) });
  }, []);
  useEffect(() => subscribeUnauthorized(() => clearSession(sessionRef.current.status === "authenticated" ? "expired" : undefined)), [clearSession]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); invitationLifetime.current.abort(); cacheScope.current?.dispose(); invalidateAuthRequests(); };
  }, []);
  useEffect(() => {
    // The initial state already consumed the first secret, even when storage is unavailable.
    if (invitationLocationSeen.current === location) return;
    const previous = invitationLocationSeen.current;
    invitationLocationSeen.current = location;
    if ((location.pathname === "/invitations" || location.pathname === "/team-invitations") && (location.hash !== "" || previous.pathname !== location.pathname && (previous.pathname !== "/login" || new URLSearchParams(previous.search).get("returnPath") !== location.pathname))) {
      const incoming = captureInvitation();
      if (sessionRef.current.status === "authenticated") setCleanupFailed(!clearInvitation());
      invitationLifetime.current.abort();
      invitationLifetime.current = new AbortController();
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
        if (previous.status === "authenticated") clearSessionDrafts(previous.user.id);
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
    if (sessionRef.current.status === "authenticated") clearSessionDrafts(sessionRef.current.user.id);
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
  const cleanupWarning = cleanupFailed || invitation.cleanupFailed ? <div className="notice warning" role="alert">{m.invitationCleanupError}</div> : null;
  const invalidTarget = <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="alert"><h1>{m.invalidLoginTarget}</h1><p>{m.invalidLoginTargetDetail}</p><LanguageSelector /><a className="button primary" href="/login">{m.startFreshLogin}</a></section></main></>;
  const notFound = <>{cleanupWarning}<main className="auth-main"><section className="state-box"><h1>{app.notFound}</h1><LanguageSelector /><a className="button primary" href="/projects" onClick={followLink}>{app.returnToProjects}</a></section></main></>;
  const identityLoading = <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{m.identityLoading}</h1><LanguageSelector /></section></main></>;
  if (session.status !== "authenticated" && returnPath === null && (route.kind === "login" || route.kind !== "notFound" && session.status === "anonymous")) return invalidTarget;
  if (session.status !== "authenticated" && route.kind === "notFound") return notFound;
  if (logoutPending) return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{m.signingOut}</h1><LanguageSelector /></section></main></>;
  if (session.status === "loading") return identityLoading;
  if (session.status === "error") return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="alert"><h1>{m.identityError}</h1><p>{m.networkRetry}</p><LanguageSelector /><button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button></section></main></>;
  if (session.status === "anonymous") return <>{cleanupWarning}{invitationFlow && invitation.storageUnavailable && <div className="notice warning" role="alert">{m.invitationStorageError}</div>}<LoginPage invitation={destination.kind === "invitations" || destination.kind === "teamInvitations"} device={destination.kind === "device"} {...(session.notice !== undefined ? { notice: m.notice[session.notice] } : loginError ? { notice: m.notice.loginFailed } : {})} onLogin={startLogin} />{logoutFailed && <button className="button" type="button" onClick={() => signOut(logoutContinuation.current)}>{m.retryLogout}</button>}</>;
  const identity = `${session.user.id}:${session.generation}`;
  if (memberGuards.current.identity !== identity) memberGuards.current = { identity, teams: new Set() };
  const revalidationOverlay = blocked ? <RevalidationOverlay failed={revalidation === "error"} onRetry={recheckIdentity} /> : null;
  const preferenceRoute = route.kind === "projects" ? "default" : (route.kind === "team" || route.kind === "teamSettings" || route.kind === "teamMembers") ? route.teamId : null;
  const workspaceRoute = !["login", "notFound", "attachment", "task", "teamInvitations", "invitations", "device"].includes(route.kind);
  const content = route.kind === "login" ? returnPath === null ? invalidTarget : identityLoading : route.kind === "notFound" ? notFound : route.kind === "attachment" || route.kind === "task" ? <>{revalidationOverlay}{cleanupWarning}<div className="auth-shell" key={identity} aria-hidden={blocked} inert={blocked}>
    <TaskDetailPage key={route.projectId} projectId={route.projectId} taskId={route.taskId} navigation={{ tab: route.tab, path: route.path }} />
  </div></> : route.kind === "teamInvitations" ? <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><TeamInvitationPage key={`${identity}:${invitationRevision}`} lifetime={invitationLifetime.current.signal} invitation={invitation.scope === "project" ? { token: null, scope: null, storageUnavailable: false, cleanupFailed: false } : invitation} user={session.user} onAccepted={discardInvitation} onCancel={cancelInvitation} onSwitchAccount={() => signOut(returnPath)} onUnavailable={unavailableInvitation} onIdentityMismatch={invalidateIdentity} /></div></> : route.kind === "invitations" ? <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><InvitationPage key={`${identity}:${invitationRevision}`} lifetime={invitationLifetime.current.signal} invitation={invitation.scope === "team" ? { token: null, scope: null, storageUnavailable: false, cleanupFailed: false } : invitation} user={session.user} onComplete={completeInvitation} onCancel={cancelInvitation} onSwitchAccount={() => signOut(returnPath)} onUnavailable={unavailableInvitation} onIdentityMismatch={invalidateIdentity} /></div></> : route.kind === "device" ? <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><DeviceAuthorizationPage key={`${identity}:${route.userCode}`} user={session.user} initialCode={route.userCode} onSwitchAccount={() => signOut(returnPath)} onIdentityMismatch={invalidateIdentity} /></div></> : null;
  return <CurrentAccountProvider user={session.user} admissionBlocked={revalidation !== "idle"}><TaskCacheProvider key={identity} scope={cacheScope.current!}><TeamPreferenceProvider personal={session.user.personalTeam} routeKey={preferenceRoute} admission={cacheScope.current!} blocked={revalidation !== "idle"} preserveOnRevalidation={route.kind === "teamSettings" || route.kind === "teamMembers"} guardUnavailable={guardedTeam}><TaskAssigneesProvider><TaskDetailSessionProvider>{content}{workspaceRoute && revalidationOverlay}<TeamWorkspace user={session.user} route={route} admission={cacheScope.current!} admissionBlocked={revalidation !== "idle" || !workspaceRoute} onSignOut={() => signOut()} onIdentityMismatch={invalidateIdentity} blocked={blocked || !workspaceRoute} identityChecking={revalidation !== "idle"} workspaceVisible={workspaceRoute} guardedTeam={guardedTeam} setTeamGuard={setTeamGuard}>{cleanupWarning}</TeamWorkspace></TaskDetailSessionProvider></TaskAssigneesProvider></TeamPreferenceProvider></TaskCacheProvider></CurrentAccountProvider>;
};
