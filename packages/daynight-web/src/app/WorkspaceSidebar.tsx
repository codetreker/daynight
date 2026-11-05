import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { tabbable } from "tabbable";
import { useI18n } from "../i18n/LocaleProvider";
import { useProjectList } from "../features/projects/ProjectsProvider";
import { navigate } from "./router";
import { useBodyScrollLock } from "./useBodyScrollLock";
import "../styles/sidebar.css";
import { TeamSelector } from "../features/teams/TeamSelector";
import { useTeamMessages } from "../features/teams/messages";
import { useBotMessages } from "../features/bots/messages";
import { useTestSessionListMessages } from "../features/task-agent-session/test-session-list-messages";

// Keep the media query identical to sidebar.css so layout and modal ownership change together.
export const SIDEBAR_NARROW_QUERY = "(max-width: 740px)";

type WorkspaceSidebarProps = {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly routeKey: string;
  readonly projectsActive: boolean;
  readonly sharedActive: boolean;
  readonly teamSettingsActive?: boolean;
  readonly teamMembersActive?: boolean;
  readonly personalId: string;
  readonly selectedTeamId: string | null;
  readonly workersActive?: boolean;
  readonly botsActive?: boolean;
  readonly activeProjectId: string | null;
  readonly testSessionsActive?: boolean;
  readonly blocked: boolean;
  readonly workspaceRef: RefObject<HTMLDivElement | null>;
  readonly onNavigate: () => void;
  readonly onCreateTeam?: () => void;
};

export const WorkspaceSidebar = ({ collapsed, onToggle, routeKey, projectsActive, sharedActive, teamSettingsActive = false, teamMembersActive = false, personalId, selectedTeamId, workersActive = false, botsActive = false, activeProjectId, testSessionsActive = false, blocked, workspaceRef, onNavigate, onCreateTeam }: WorkspaceSidebarProps) => {
  const { messages: { auth: { shell: m }, workspace: { app, projects: p } } } = useI18n();
  const projects = useProjectList();
  const teamMessages = useTeamMessages();
  const testMessages = useTestSessionListMessages();
  const botMessages = useBotMessages();
  const [media] = useState(() => window.matchMedia(SIDEBAR_NARROW_QUERY));
  const [narrow, setNarrow] = useState(media.matches);
  const [drawer, setDrawer] = useState<{ readonly route: string } | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const active = narrow && drawer !== null && drawer.route === routeKey && !blocked;
  const activeRef = useRef(active);
  activeRef.current = active;
  const expanded = narrow ? active : !collapsed;
  const toggleLabel = expanded ? m.sidebar.collapse : m.sidebar.expand;
  useBodyScrollLock(active);

  useLayoutEffect(() => {
    const changed = () => {
      setNarrow(media.matches);
      setDrawer(null);
    };
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, [media]);

  useLayoutEffect(() => {
    if (drawer !== null && (!narrow || blocked || drawer.route !== routeKey)) setDrawer(null);
  }, [drawer, narrow, blocked, routeKey]);

  useLayoutEffect(() => {
    if (!active) {
      // Restore after DOM mutations so React focus preservation cannot overwrite the destination.
      if (restoreFocus.current) {
        restoreFocus.current = false;
        const opener = toggle.current;
        if (opener?.isConnected && opener.closest("[inert]") === null) opener.focus({ preventScroll: true });
      }
      return;
    }
    const background = workspaceRef.current!;
    const wasInert = background.hasAttribute("inert");
    if (!wasInert) background.setAttribute("inert", "");
    const element = sidebar.current!;
    const focusFirst = () => (tabbable(element)[0] ?? element).focus({ preventScroll: true });
    focusFirst();
    const close = () => { restoreFocus.current = true; setDrawer(null); };
    const keydown = (event: KeyboardEvent) => {
      if (!activeRef.current || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab") {
        const controls = tabbable(element);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (first === undefined || last === undefined) { event.preventDefault(); element.focus(); }
        else if (!element.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (activeRef.current && !element.contains(event.target as Node)) focusFirst();
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
      if (!wasInert) background.removeAttribute("inert");

    };
  }, [active, workspaceRef]);

  const closeDrawer = () => { restoreFocus.current = true; setDrawer(null); };
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setDrawer(null);
    navigate(event.currentTarget.pathname);
    onNavigate();
  };
  const teamLink = (target: (teamId: string) => string) => selectedTeamId === null
    ? { role: "link", "aria-disabled": true as const }
    : { href: target(selectedTeamId), onClick: follow };
  return <>
    {active && <button className="sidebar-backdrop" type="button" tabIndex={-1} aria-label={m.sidebar.close} onClick={closeDrawer} />}
    <aside ref={sidebar} id="workspace-sidebar" className={`sidebar${active ? " sidebar-drawer-open" : ""}`} aria-label={app.workspaceNavigation} role={active ? "dialog" : undefined} aria-modal={active ? true : undefined} tabIndex={-1}>
      <div className="sidebar-main">
        <a className="brand" href="/projects" onClick={follow} aria-label={app.projectHome} title={app.projectHome}><span className="brand-mark" aria-hidden="true" /><span className="brand-name">daynight</span></a>
        <TeamSelector personalId={personalId} selectedId={selectedTeamId} expanded={expanded} onExpand={() => { if (narrow) setDrawer({ route: routeKey }); else onToggle(); }} onNavigate={onNavigate} {...(onCreateTeam ? { onCreate: () => { if (narrow) toggle.current?.focus(); setDrawer(null); onCreateTeam(); } } : {})} />
        <nav aria-label={app.mainNavigation}>
          <p className="nav-label">{app.workspace}</p>
          <a className="nav-button" {...teamLink((id) => id === personalId ? "/projects" : `/teams/${id}`)} aria-label={m.myProjects} title={m.myProjects} aria-current={projectsActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true">▦</span><span className="nav-text">{m.myProjects}</span></a>
          <div className="sidebar-projects" hidden={!expanded || sharedActive}>
            {projects.status === "loading" && <p className="sidebar-project-state" role="status">{p.loading}</p>}
            {projects.status === "error" && <div className="sidebar-project-state" role="alert"><p>{p.loadingFailed}</p><button className="sidebar-project-action" type="button" onClick={projects.refresh}>{p.retry}</button></div>}
            {projects.status === "ready" && projects.items.length === 0 && <p className="sidebar-project-state">{p.empty}</p>}
            {projects.items.length > 0 && <ul className="sidebar-project-list" aria-label={p.list}>
              {projects.items.map((project) => <li key={project.id}><a className="sidebar-project-link" href={`/projects/${project.id}`} title={project.name} onClick={follow} aria-current={activeProjectId === project.id ? "true" : undefined}><span className="sidebar-project-marker" aria-hidden="true" /><span className="sidebar-project-name">{project.name}</span></a></li>)}
            </ul>}
            {projects.status === "ready" && projects.nextCursor !== null && <div className="sidebar-project-state">
              {projects.moreError !== null && <p role="alert">{p.moreFailed}</p>}
              <button className="sidebar-project-action" type="button" onClick={projects.loadMore} disabled={projects.loadingMore}>{projects.loadingMore ? p.loadingMore : projects.moreError !== null ? p.retryMore : p.loadMore}</button>
            </div>}
          </div>
          <a className="nav-button" {...teamLink((id) => `/teams/${id}/members`)} aria-label={teamMessages.members} title={teamMessages.members} aria-current={teamMembersActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3" /><path d="M3 19v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v1" /></svg></span><span className="nav-text">{teamMessages.members}</span></a>
          <a className="nav-button" {...teamLink((id) => `/teams/${id}/settings`)} aria-label={teamMessages.settings} title={teamMessages.settings} aria-current={teamSettingsActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true">⚙</span><span className="nav-text">{teamMessages.settings}</span></a>
          <a className="nav-button" href="/shared-projects" onClick={follow} aria-label={teamMessages.shared} title={teamMessages.shared} aria-current={sharedActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true">◇</span><span className="nav-text">{teamMessages.shared}</span></a>
          <a className="nav-button" href="/workers" onClick={follow} aria-label={m.workers} title={m.workers} aria-current={workersActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 8h10M7 12h6" /></svg></span><span className="nav-text">{m.workers}</span></a>
          <a className="nav-button" href="/bots" onClick={follow} aria-label={botMessages.title} title={botMessages.title} aria-current={botsActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" /></svg></span><span className="nav-text">{botMessages.title}</span></a>
          <a className="nav-button" href="/test-sessions" onClick={follow} aria-label={testMessages.title} title={testMessages.title} aria-current={testSessionsActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true">▷</span><span className="nav-text">{testMessages.title}</span></a>
        </nav>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-workspace">{m.teamWorkspace}<small>{app.localWorkspaceDetail}</small></div>
        <button ref={toggle} className="sidebar-toggle" type="button" aria-controls="workspace-sidebar" aria-expanded={expanded} aria-label={toggleLabel} title={toggleLabel} onClick={() => {
          if (!narrow) onToggle();
          else if (active) closeDrawer();
          else if (!blocked) setDrawer({ route: routeKey });
        }}><span aria-hidden="true">{expanded ? "‹" : "›"}</span><span className="collapse-label">{toggleLabel}</span></button>
      </div>
    </aside>
  </>;
};
