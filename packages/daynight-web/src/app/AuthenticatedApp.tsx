import { flushSync } from "react-dom";
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
import { LoginPage } from "../features/auth/LoginPage";
import { DeviceAuthorizationPage } from "../features/auth/DeviceAuthorizationPage";
import { captureInvitation, clearInvitation } from "../features/auth/invitation";
import { TaskDetailSessionProvider } from "../features/task-detail/TaskDetailSession";
import { ProjectPage } from "../features/projects/ProjectPage";
import { ProjectMembersProvider, useProjectMembers } from "../features/projects/ProjectMembers";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { ProjectsProvider, useProjectList } from "../features/projects/ProjectsProvider";
import { TaskDetailPage } from "../features/task-detail/TaskDetailPage";
import { invitationLocation, isLoginReturnPath, loginUrl, navigate, parseAuthRoute, replaceRoute, type AuthRoute } from "./router";
import { useI18n } from "../i18n/LocaleProvider";
import { LanguageSelector } from "../i18n/LanguageSelector";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { useSidebarPreference } from "./useSidebarPreference";
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
  const membership = useProjectMembers(projectId);
  const current = membership.members.find((member) => member.userId === user.id);
  const unavailable = membership.status === "ready" && current === undefined || membership.error instanceof ApiError && membership.error.status === 404;
  if (unavailable) return <AccessUnavailable />;
  return <>{membership.status === "error" && <div className="notice error" role="alert"><p>{m.permissionsError}</p><button className="button" type="button" onClick={() => membership.retry()}>{m.retryPermissions}</button></div>}<ProjectPage projectId={projectId} renderActions={(project) => membership.status === "ready" ? <><ProjectRoleBadge role={current!.role} labels={roles} /><a className="button" href={`/projects/${projectId}/members`} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenMembers(project); }}>{m.members}</a><a className="button" href={`/projects/${projectId}/settings`} onClick={followLink}>{m.projectSettings}</a></> : <span className="project-title-actions-placeholder" aria-hidden="true"><ProjectRoleBadge role={null} labels={roles} /><span className="button">{m.members}</span><span className="button">{m.projectSettings}</span></span>} /></>;
};

const ProjectManagementNav = ({ projectId, current }: { readonly projectId: string; readonly current: "settings" | "members" }) => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  return <nav className="project-management-nav" aria-label={m.projectSettings}><a className="button" href={`/projects/${projectId}`} onClick={followLink}>{app.projectTasks}</a><a className="button" href={`/projects/${projectId}/members`} onClick={followLink} aria-current={current === "members" ? "page" : undefined}>{m.members}</a><a className="button" href={`/projects/${projectId}/settings`} onClick={followLink} aria-current={current === "settings" ? "page" : undefined}>{m.projectSettings}</a></nav>;
};

const Workspace = ({ user, children, route, onSignOut, blocked, identityChecking }: { readonly user: CurrentUser; readonly children: ReactNode; readonly route: AuthRoute; readonly onSignOut: () => void; readonly blocked: boolean; readonly identityChecking: boolean }) => {
  const { messages: { auth: { shell: m }, workspace: { app }, setup } } = useI18n();
  const content = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const sidebar = useSidebarPreference();
  const label = route.kind === "projects" ? m.myProjects : route.kind === "account" ? m.accountSettings : route.kind === "members" ? m.members : route.kind === "settings" ? m.projectSettings : route.kind === "project" ? app.projectTasks : app.notFound;
  useLayoutEffect(() => { content.current?.focus(); }, [route.kind, "projectId" in route ? route.projectId : null]);
  return (
    <div className={`shell auth-shell${sidebar.collapsed ? " sidebar-collapsed" : ""}`} aria-hidden={blocked} inert={blocked}>
      <WorkspaceSidebar collapsed={sidebar.collapsed} onToggle={sidebar.toggle} routeKey={route.kind + ("projectId" in route ? `:${route.projectId}` : "")} projectsActive={route.kind === "projects"} activeProjectId={"projectId" in route ? route.projectId : null} accountActive={route.kind === "account"} identityChecking={identityChecking} workspaceRef={workspace} onNavigate={() => queueMicrotask(() => content.current?.focus())} />
      <div className="workspace" ref={workspace}>
        <a className="skip-link" href="#main-content">{app.skipToContent}</a>
        <header className="topbar">
          <nav className="crumb" aria-label={app.breadcrumb}><a href="/projects" onClick={followLink}>{app.workspace}</a><span aria-hidden="true">/</span><span className="crumb-current" aria-current="page">{label}</span></nav>
          <div className="account-actions">
            <a className="setup-guide-link" href="/setup" target="_blank" rel="noopener noreferrer"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v15M3 4h5a5 5 0 0 1 4 2 5 5 0 0 1 4-2h5v15h-5a5 5 0 0 0-4 2 5 5 0 0 0-4-2H3z" /></svg>{setup.navigation}</a>
            <LanguageSelector />
            <a className="account-button" href="/account" onClick={followLink} aria-label={m.accountLink({ name: accountLabel(user, m.currentAccount) })}><span className="avatar" aria-hidden="true">{accountLabel(user, m.currentAccount).slice(0, 1).toUpperCase()}</span><span className="account-name">{accountLabel(user, m.currentAccount)}</span></a>
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

const WorkspaceRoutes = ({ user, route, onSignOut, onIdentityMismatch, blocked, identityChecking, children }: { readonly user: CurrentUser; readonly route: AuthRoute; readonly onSignOut: () => void; readonly onIdentityMismatch: () => void; readonly blocked: boolean; readonly identityChecking: boolean; readonly children: ReactNode }) => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  const projects = useProjectList();
  const [creating, setCreating] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  return <Workspace user={user} route={route} onSignOut={onSignOut} blocked={blocked} identityChecking={identityChecking}>
    {children}{route.kind === "projects" ? <ProjectsPage onCreate={() => setCreating(true)} /> : route.kind === "project" ? <ProjectMembersProvider key={route.projectId} projectId={route.projectId}><AuthorizedProject projectId={route.projectId} user={user} onOpenMembers={(project) => { setProjectName(project.name); navigate(`/projects/${project.id}/members`); }} /></ProjectMembersProvider> : route.kind === "settings" ? <><ProjectManagementNav projectId={route.projectId} current="settings" /><ProjectSettingsPanel key={route.projectId} projectId={route.projectId} user={user} /></> : route.kind === "members" ? <><ProjectManagementNav projectId={route.projectId} current="members" /><MembersPanel key={route.projectId} projectId={route.projectId} projectName={projectName ?? m.genericProject} user={user} onRemoved={() => { projects.refresh(); navigate("/projects"); }} onUnavailable={projects.refresh} /></> : route.kind === "account" ? <AccountPage user={user} onSignOut={onSignOut} onIdentityMismatch={onIdentityMismatch} /> : <section className="state-box"><h1>{app.notFound}</h1><a className="button primary" href="/projects" onClick={followLink}>{app.returnToProjects}</a></section>}
    {creating && <CreateProjectDialog onClose={() => setCreating(false)} onCreated={(project) => { setCreating(false); projects.refresh(); navigate(`/projects/${project.id}`); }} />}
  </Workspace>;
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
  const [invitation, setInvitation] = useState(captureInvitation);
  const [location, setLocation] = useState(() => ({ pathname: window.location.pathname, search: window.location.search }));
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
  const route = parseAuthRoute(pathname, search);
  const navigation = new URLSearchParams(search);
  navigation.delete("authError");
  const requestedPath = route.kind === "login" ? route.returnPath : route.kind === "notFound" ? null : route.kind === "invitations" ? "/invitations" : pathname + (navigation.size === 0 ? "" : `?${navigation}`);
  const returnPath = requestedPath !== null && isLoginReturnPath(requestedPath) ? requestedPath : null;
  const target = returnPath === null ? null : new URL(returnPath, window.location.origin);
  const destination = target === null ? route : parseAuthRoute(target.pathname, target.search);
  const invitationFlow = invitationLocation(pathname, search);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    const page = session.status === "authenticated" ? route.kind : session.status === "anonymous" ? "login" : session.status;
    document.title = (page === "attachment" || page === "task") ? app.documentTitle.task : m.documentTitle[page];
  }, [locale, m.documentTitle, app.documentTitle.task, route.kind, session.status]);
  const [loginError] = useState(() => {
    const parameters = new URLSearchParams(window.location.search);
    const failed = parameters.get("authError") === "login_failed";
    if (parameters.has("authError")) { parameters.delete("authError"); window.history.replaceState(window.history.state, "", window.location.pathname + (parameters.size === 0 ? "" : `?${parameters}`)); }
    return failed;
  });
  const clearSession = useCallback((notice?: SessionNotice) => {
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
    const onNavigate = () => {
      if (window.location.pathname === "/invitations" && window.location.hash !== "") {
        const incoming = captureInvitation();
        invitationLifetime.current.abort();
        invitationLifetime.current = new AbortController();
        setInvitation(incoming); setInvitationRevision((value) => value + 1);
      }
      setLocation({ pathname: window.location.pathname, search: window.location.search });
    };
    window.addEventListener("popstate", onNavigate);
    window.addEventListener("hashchange", onNavigate);
    return () => { window.removeEventListener("popstate", onNavigate); window.removeEventListener("hashchange", onNavigate); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    const current = ++generation.current;
    const resume = resumeAuthRequests.current;
    if (sessionRef.current.status !== "authenticated") setSession({ status: "loading" });
    void me(controller.signal).then((user) => {
      if (controller.signal.aborted || current !== generation.current) return;
      const previous = sessionRef.current;
      if (previous.status === "authenticated" && previous.user.id === user.id && !cacheScope.current?.isInvalidated) {
        setSession({ ...previous, user });
      } else {
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
  }, [attempt, clearSession]);
  const discardInvitation = useCallback(() => { invitationLifetime.current.abort(); setCleanupFailed(!clearInvitation()); setInvitation({ token: null, storageUnavailable: false }); }, []);
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
    void cacheScope.current?.invalidateScope(); cacheScope.current = null;
    invalidateAuthRequests();
    pauseIdentity();
    // A proven principal change revokes the rendered identity before another private response can publish.
    flushSync(() => {
      setRevalidation("idle"); setSession({ status: "loading" });
    });
    setAttempt((value) => value + 1);
  }, [pauseIdentity]);
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
  const cleanupWarning = cleanupFailed ? <div className="notice warning" role="alert">{m.invitationCleanupError}</div> : null;
  if (returnPath === null && (route.kind === "login" || route.kind !== "notFound" && session.status === "anonymous")) return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="alert"><h1>{m.invalidLoginTarget}</h1><p>{m.invalidLoginTargetDetail}</p><LanguageSelector /><a className="button primary" href="/login">{m.startFreshLogin}</a></section></main></>;
  if (route.kind === "notFound") return <>{cleanupWarning}<main className="auth-main"><section className="state-box"><h1>{app.notFound}</h1><LanguageSelector /><a className="button primary" href="/projects" onClick={followLink}>{app.returnToProjects}</a></section></main></>;
  if (logoutPending) return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{m.signingOut}</h1><LanguageSelector /></section></main></>;
  if (session.status === "loading" || session.status === "authenticated" && route.kind === "login") return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{m.identityLoading}</h1><LanguageSelector /></section></main></>;
  if (session.status === "error") return <>{cleanupWarning}<main className="auth-main"><section className="state-box" role="alert"><h1>{m.identityError}</h1><p>{m.networkRetry}</p><LanguageSelector /><button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button></section></main></>;
  if (session.status === "anonymous") return <>{cleanupWarning}{invitationFlow && invitation.storageUnavailable && <div className="notice warning" role="alert">{m.invitationStorageError}</div>}<LoginPage invitation={destination.kind === "invitations"} device={destination.kind === "device"} {...(session.notice !== undefined ? { notice: m.notice[session.notice] } : loginError ? { notice: m.notice.loginFailed } : {})} onLogin={startLogin} />{logoutFailed && <button className="button" type="button" onClick={() => signOut(logoutContinuation.current)}>{m.retryLogout}</button>}</>;
  const identity = `${session.user.id}:${session.generation}`;
  const revalidationOverlay = blocked ? <RevalidationOverlay failed={revalidation === "error"} onRetry={recheckIdentity} /> : null;
  if (route.kind === "attachment" || route.kind === "task") return <TaskCacheProvider key={identity} scope={cacheScope.current!}><TaskDetailSessionProvider>{revalidationOverlay}{cleanupWarning}<div className="auth-shell" key={identity} aria-hidden={blocked} inert={blocked}>
    <TaskDetailPage key={route.projectId} projectId={route.projectId} taskId={route.taskId} navigation={{ tab: route.tab, path: route.path }} />
  </div></TaskDetailSessionProvider></TaskCacheProvider>;
  if (route.kind === "invitations") return <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><InvitationPage key={`${identity}:${invitationRevision}`} lifetime={invitationLifetime.current.signal} invitation={invitation} user={session.user} onComplete={completeInvitation} onCancel={cancelInvitation} onSwitchAccount={() => signOut(returnPath)} onUnavailable={unavailableInvitation} /></div></>;
  if (route.kind === "device") return <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><DeviceAuthorizationPage key={`${identity}:${route.userCode}`} user={session.user} initialCode={route.userCode} onSwitchAccount={() => signOut(returnPath)} onIdentityMismatch={invalidateIdentity} /></div></>;
  return <TaskCacheProvider key={identity} scope={cacheScope.current!}><TaskDetailSessionProvider>{revalidationOverlay}<ProjectsProvider key={identity}><WorkspaceRoutes user={session.user} route={route} onSignOut={() => signOut()} onIdentityMismatch={invalidateIdentity} blocked={blocked} identityChecking={revalidation !== "idle"}>{cleanupWarning}</WorkspaceRoutes></ProjectsProvider></TaskDetailSessionProvider></TaskCacheProvider>;
};
