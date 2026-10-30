import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { tabbable } from "tabbable";
import { useI18n } from "../i18n/LocaleProvider";
import { useProjectList } from "../features/projects/ProjectsProvider";
import { navigate } from "./router";
import { useBodyScrollLock } from "./useBodyScrollLock";
import "../styles/sidebar.css";
import { useTestSessionListMessages } from "../features/task-agent-session/test-session-list-messages";

// Keep the media query identical to sidebar.css so layout and modal ownership change together.
export const SIDEBAR_NARROW_QUERY = "(max-width: 740px)";

type WorkspaceSidebarProps = {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly routeKey: string;
  readonly projectsActive: boolean;
  readonly workersActive?: boolean;
  readonly accountActive: boolean;
  readonly activeProjectId: string | null;
  readonly testSessionsActive?: boolean;
  readonly identityChecking: boolean;
  readonly workspaceRef: RefObject<HTMLDivElement | null>;
  readonly onNavigate: () => void;
};

export const WorkspaceSidebar = ({ collapsed, onToggle, routeKey, projectsActive, workersActive = false, accountActive, activeProjectId, testSessionsActive = false, identityChecking, workspaceRef, onNavigate }: WorkspaceSidebarProps) => {
  const { messages: { auth: { shell: m }, workspace: { app, projects: p } } } = useI18n();
  const projects = useProjectList();
  const testMessages = useTestSessionListMessages();
  const [media] = useState(() => window.matchMedia(SIDEBAR_NARROW_QUERY));
  const [narrow, setNarrow] = useState(media.matches);
  const [drawer, setDrawer] = useState<{ readonly route: string } | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const active = narrow && drawer !== null && drawer.route === routeKey && !identityChecking;
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
    if (drawer !== null && (!narrow || identityChecking || drawer.route !== routeKey)) setDrawer(null);
  }, [drawer, narrow, identityChecking, routeKey]);

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
  return <>
    {active && <button className="sidebar-backdrop" type="button" tabIndex={-1} aria-label={m.sidebar.close} onClick={closeDrawer} />}
    <aside ref={sidebar} id="workspace-sidebar" className={`sidebar${active ? " sidebar-drawer-open" : ""}`} aria-label={app.workspaceNavigation} role={active ? "dialog" : undefined} aria-modal={active ? true : undefined} tabIndex={-1}>
      <div className="sidebar-main">
        <a className="brand" href="/projects" onClick={follow} aria-label={app.projectHome} title={app.projectHome}><span className="brand-mark" aria-hidden="true" /><span className="brand-name">daynight</span></a>
        <nav aria-label={app.mainNavigation}>
          <p className="nav-label">{app.workspace}</p>
          <a className="nav-button" href="/projects" onClick={follow} aria-label={m.myProjects} title={m.myProjects} aria-current={projectsActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true">▦</span><span className="nav-text">{m.myProjects}</span></a>
          <div className="sidebar-projects" hidden={!expanded}>
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
          <a className="nav-button" href="/workers" onClick={follow} aria-label={m.workers} title={m.workers} aria-current={workersActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 8h10M7 12h6" /></svg></span><span className="nav-text">{m.workers}</span></a>
          <a className="nav-button" href="/test-sessions" onClick={follow} aria-label={testMessages.title} title={testMessages.title} aria-current={testSessionsActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true">▷</span><span className="nav-text">{testMessages.title}</span></a>
        </nav>
      </div>
      <div className="sidebar-bottom">
        <a className="nav-button account-nav" href="/account" onClick={follow} aria-label={m.accountSettings} title={m.accountSettings} aria-current={accountActive ? "page" : undefined}><span className="nav-icon" aria-hidden="true">◎</span><span className="nav-text">{m.accountSettings}</span></a>
        <div className="sidebar-workspace">{m.teamWorkspace}<small>{app.localWorkspaceDetail}</small></div>
        <button ref={toggle} className="sidebar-toggle" type="button" aria-controls="workspace-sidebar" aria-expanded={expanded} aria-label={toggleLabel} title={toggleLabel} onClick={() => {
          if (!narrow) onToggle();
          else if (active) closeDrawer();
          else if (!identityChecking) setDrawer({ route: routeKey });
        }}><span aria-hidden="true">{expanded ? "‹" : "›"}</span><span className="collapse-label">{toggleLabel}</span></button>
      </div>
    </aside>
  </>;
};
