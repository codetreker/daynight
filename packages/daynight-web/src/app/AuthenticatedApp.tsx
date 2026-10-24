import { flushSync } from "react-dom";
import { createTaskCacheScope, TaskCacheProvider, type TaskCacheScope } from "../features/task-cache/TaskCacheProvider";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { listMembers, logout, me } from "../api/auth";
import type { AuthProvider, CurrentUser, ProjectRole } from "../api/auth-types";
import { ApiError, invalidateAuthRequests, isAbortError, pauseAuthRequests, subscribeUnauthorized } from "../api/client";
import type { Project } from "../api/types";
import { AccountPage } from "../features/management/AccountPage";
import { ProjectSettingsPanel } from "../features/management/ProjectSettingsPanel";
import { MembersPanel } from "../features/management/MembersPanel";
import { CreateProjectDialog } from "../features/auth/CreateProjectDialog";
import { InvitationPage } from "../features/auth/InvitationPage";
import { LoginPage } from "../features/auth/LoginPage";
import { captureInvitation, clearInvitation } from "../features/auth/invitation";
import { TaskDetailSessionProvider } from "../features/task-detail/TaskDetailSession";
import { ProjectPage } from "../features/projects/ProjectPage";
import { ProjectsPage } from "../features/projects/ProjectsPage";
import { TaskDetailPage } from "../features/task-detail/TaskDetailPage";
import { navigate, parseRoute, type Route } from "./router";
import { useI18n } from "../i18n/LocaleProvider";
import { LanguageSelector } from "../i18n/LanguageSelector";
import "../styles/auth.css";

type AuthRoute = Route | { readonly kind: "account" | "invitations" } | { readonly kind: "members" | "settings"; readonly projectId: string };
export const parseAuthRoute = (pathname: string, search = ""): AuthRoute => {
  if (pathname === "/account") return { kind: "account" };
  if (pathname === "/invitations") return { kind: "invitations" };
  const members = /^(\/projects\/[^/]+)\/(members|settings)$/.exec(pathname);
  if (members !== null) {
    const project = parseRoute(members[1]!);
    return project.kind === "project" ? { kind: members[2] as "members" | "settings", projectId: project.projectId } : { kind: "notFound" };
  }
  return parseRoute(pathname, search);
};

const followLink = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(event.currentTarget.pathname);
};
const accountLabel = (user: CurrentUser, currentAccount: string) => user.name ?? user.email ?? currentAccount;
const AccessUnavailable = () => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  return <section className="state-box" role="alert"><h1>{m.accessUnavailable}</h1><p>{m.accessUnavailableDetail}</p><a className="button primary" href="/" onClick={followLink}>{app.returnToProjects}</a></section>;
};

const ProjectRoleBadge = ({ role, labels }: { readonly role: ProjectRole | null; readonly labels: Readonly<Record<ProjectRole, string>> }) => (
  <span className="project-title-role">
    {role !== null && <span className={`badge ${role}`}>{labels[role]}</span>}
    {role !== "admin" && <span className="project-title-role-measure" aria-hidden="true">{labels.admin}</span>}
  </span>
);

const AuthorizedProject = ({ projectId, user, onOpenMembers }: { readonly projectId: string; readonly user: CurrentUser; readonly onOpenMembers: (project: Project) => void }) => {
  const { messages: { auth: { shell: m, roles } } } = useI18n();
  const [membership, setMembership] = useState<{ status: "loading" | "ready" | "error" | "unavailable"; role: ProjectRole | null }>({ status: "loading", role: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setMembership({ status: "loading", role: null });
    void listMembers(projectId, controller.signal).then((members) => {
      if (controller.signal.aborted) return;
      const current = members.find((member) => member.userId === user.id);
      setMembership(current === undefined ? { status: "unavailable", role: null } : { status: "ready", role: current.role });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbortError(error)) setMembership({ status: error instanceof ApiError && error.status === 404 ? "unavailable" : "error", role: null });
    });
    return () => controller.abort();
  }, [projectId, user.id, attempt]);
  if (membership.status === "unavailable") return <AccessUnavailable />;
  return <>{membership.status === "error" && <div className="notice error" role="alert"><p>{m.permissionsError}</p><button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>{m.retryPermissions}</button></div>}<ProjectPage projectId={projectId} renderActions={(project) => membership.status === "ready" ? <><ProjectRoleBadge role={membership.role!} labels={roles} /><a className="button" href={`/projects/${projectId}/members`} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenMembers(project); }}>{m.members}</a><a className="button" href={`/projects/${projectId}/settings`} onClick={followLink}>{m.projectSettings}</a></> : <span className="project-title-actions-placeholder" aria-hidden="true"><ProjectRoleBadge role={null} labels={roles} /><span className="button">{m.members}</span><span className="button">{m.projectSettings}</span></span>} /></>;
};

const ProjectManagementNav = ({ projectId, current }: { readonly projectId: string; readonly current: "settings" | "members" }) => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  return <nav className="project-management-nav" aria-label={m.projectSettings}><a className="button" href={`/projects/${projectId}`} onClick={followLink}>{app.projectTasks}</a><a className="button" href={`/projects/${projectId}/members`} onClick={followLink} aria-current={current === "members" ? "page" : undefined}>{m.members}</a><a className="button" href={`/projects/${projectId}/settings`} onClick={followLink} aria-current={current === "settings" ? "page" : undefined}>{m.projectSettings}</a></nav>;
};

const Workspace = ({ user, children, route, onSignOut, blocked }: { readonly user: CurrentUser; readonly children: ReactNode; readonly route: AuthRoute; readonly onSignOut: () => void; readonly blocked: boolean }) => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  const content = useRef<HTMLElement>(null);
  const label = route.kind === "projects" ? m.myProjects : route.kind === "account" ? m.accountSettings : route.kind === "members" ? m.members : route.kind === "settings" ? m.projectSettings : route.kind === "project" ? app.projectTasks : app.notFound;
  useLayoutEffect(() => { content.current?.focus(); }, [route.kind, "projectId" in route ? route.projectId : null]);
  return <div className="shell auth-shell" aria-hidden={blocked} inert={blocked}><a className="skip-link" href="#main-content">{app.skipToContent}</a><aside className="sidebar" aria-label={app.workspaceNavigation}><a className="brand" href="/" onClick={followLink} aria-label={app.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a><nav aria-label={app.mainNavigation}><p className="nav-label">{app.workspace}</p><a className="nav-button" href="/" onClick={followLink} aria-current={route.kind === "projects" || route.kind === "project" || route.kind === "members" || route.kind === "settings" ? "page" : undefined}>▦　{m.myProjects}</a><a className="nav-button account-nav" href="/account" onClick={followLink} aria-current={route.kind === "account" ? "page" : undefined}>◎　{m.accountSettings}</a></nav><div className="sidebar-bottom">{m.teamWorkspace}<small>{app.localWorkspaceDetail}</small></div></aside><div className="workspace"><header className="topbar"><nav className="crumb" aria-label={app.breadcrumb}><a href="/" onClick={followLink}>{app.workspace}</a><span aria-hidden="true">/</span><span className="crumb-current" aria-current="page">{label}</span></nav><div className="account-actions"><LanguageSelector /><a className="account-button" href="/account" onClick={followLink} aria-label={m.accountLink({ name: accountLabel(user, m.currentAccount) })}><span className="avatar" aria-hidden="true">{accountLabel(user, m.currentAccount).slice(0, 1).toUpperCase()}</span><span className="account-name">{accountLabel(user, m.currentAccount)}</span></a><button className="inline-link" type="button" onClick={onSignOut}>{m.signOut}</button></div></header><main className="content" id="main-content" ref={content} tabIndex={-1}>{children}</main></div></div>;
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
  const [creating, setCreating] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const [cleanupFailed, setCleanupFailed] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  const generation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const resumeAuthRequests = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  const cacheScope = useRef<TaskCacheScope | null>(null);
  const identityRecheck = useRef<() => void>(() => {});
  const route = parseAuthRoute(pathname, search);
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
    setCreating(false); setProjectName(null); setRevalidation("idle"); setSession({ status: "anonymous", ...(notice === undefined ? {} : { notice }) });
  }, []);
  useEffect(() => subscribeUnauthorized(() => clearSession(sessionRef.current.status === "authenticated" ? "expired" : undefined)), [clearSession]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); cacheScope.current?.dispose(); invalidateAuthRequests(); };
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
        invalidateAuthRequests(); setCreating(false); setProjectName(null);
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
  const cancelInvitation = useCallback(() => { discardInvitation(); navigate("/"); }, [discardInvitation]);
  const unavailableInvitation = discardInvitation;
  useEffect(() => { if (route.kind !== "invitations" && invitation.token !== null) discardInvitation(); }, [route.kind, invitation.token, discardInvitation]);
  const signOut = useCallback(() => {
    setLogoutFailed(false);
    const controller = new AbortController();
    const request = logout(controller.signal);
    clearSession("signedOut");
    void request.catch((error: unknown) => {
      if (mounted.current && !isAbortError(error) && !(error instanceof ApiError && error.status === 401)) { setLogoutFailed(true); setSession({ status: "anonymous", notice: "logoutFailed" }); }
    });
  }, [clearSession]);
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
      setCreating(false); setProjectName(null); setRevalidation("idle"); setSession({ status: "loading" });
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
    const navigation = new URLSearchParams(search);
    navigation.delete("authError");
    const returnPath = route.kind === "invitations" ? "/invitations" : pathname + (navigation.size === 0 ? "" : `?${navigation}`);
    const parameters = new URLSearchParams({ provider, returnPath });
    navigateToLogin(`/api/v1/auth/login?${parameters}`);
  };
  const cleanupWarning = cleanupFailed ? <div className="notice warning" role="alert">{m.invitationCleanupError}</div> : null;
  if (session.status === "loading") return <main className="auth-main"><section className="state-box" role="status"><span className="spinner" aria-hidden="true" /><h1>{m.identityLoading}</h1><LanguageSelector /></section></main>;
  if (session.status === "error") return <main className="auth-main"><section className="state-box" role="alert"><h1>{m.identityError}</h1><p>{m.networkRetry}</p><LanguageSelector /><button className="button primary" type="button" onClick={() => setAttempt((value) => value + 1)}>{projects.retry}</button></section></main>;
  if (session.status === "anonymous") return <>{cleanupWarning}{route.kind === "invitations" && invitation.storageUnavailable && <div className="notice warning" role="alert">{m.invitationStorageError}</div>}<LoginPage invitation={route.kind === "invitations"} {...(session.notice !== undefined ? { notice: m.notice[session.notice] } : loginError ? { notice: m.notice.loginFailed } : {})} onLogin={startLogin} />{logoutFailed && <button className="button" type="button" onClick={signOut}>{m.retryLogout}</button>}</>;
  const identity = `${session.user.id}:${session.generation}`;
  const revalidationOverlay = blocked ? <RevalidationOverlay failed={revalidation === "error"} onRetry={recheckIdentity} /> : null;
  if (route.kind === "attachment" || route.kind === "task") return <TaskCacheProvider key={identity} scope={cacheScope.current!}><TaskDetailSessionProvider>{revalidationOverlay}{cleanupWarning}<div className="auth-shell" key={identity} aria-hidden={blocked} inert={blocked}>
    <TaskDetailPage key={route.projectId} projectId={route.projectId} taskId={route.taskId} navigation={{ tab: route.tab, path: route.path }} />
  </div></TaskDetailSessionProvider></TaskCacheProvider>;
  if (route.kind === "invitations") return <>{revalidationOverlay}{cleanupWarning}<div aria-hidden={blocked} inert={blocked}><InvitationPage key={`${identity}:${invitationRevision}`} lifetime={invitationLifetime.current.signal} invitation={invitation} user={session.user} onComplete={completeInvitation} onCancel={cancelInvitation} onSwitchAccount={signOut} onUnavailable={unavailableInvitation} /></div></>;
  return <TaskCacheProvider key={identity} scope={cacheScope.current!}><TaskDetailSessionProvider>{revalidationOverlay}<Workspace key={identity} user={session.user} route={route} onSignOut={signOut} blocked={blocked}>
    {cleanupWarning}{route.kind === "projects" ? <ProjectsPage onCreate={() => setCreating(true)} /> : route.kind === "project" ? <AuthorizedProject key={route.projectId} projectId={route.projectId} user={session.user} onOpenMembers={(project) => { setProjectName(project.name); navigate(`/projects/${project.id}/members`); }} /> : route.kind === "settings" ? <><ProjectManagementNav projectId={route.projectId} current="settings" /><ProjectSettingsPanel key={route.projectId} projectId={route.projectId} user={session.user} /></> : route.kind === "members" ? <><ProjectManagementNav projectId={route.projectId} current="members" /><MembersPanel key={route.projectId} projectId={route.projectId} projectName={projectName ?? m.genericProject} user={session.user} onRemoved={() => navigate("/")} /></> : route.kind === "account" ? <AccountPage user={session.user} onSignOut={signOut} /> : <section className="state-box"><h1>{app.notFound}</h1><a className="button primary" href="/" onClick={followLink}>{app.returnToProjects}</a></section>}
    {creating && <CreateProjectDialog onClose={() => setCreating(false)} onCreated={(project) => { setCreating(false); navigate(`/projects/${project.id}`); }} />}
  </Workspace></TaskDetailSessionProvider></TaskCacheProvider>;
};
