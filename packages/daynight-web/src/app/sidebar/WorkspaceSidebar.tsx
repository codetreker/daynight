import { useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { tabbable } from "tabbable";
import { useI18n } from "../../i18n/LocaleProvider";
import { navigate, type AuthRoute } from "../router";
import { useBodyScrollLock } from "../useBodyScrollLock";
import "../../styles/sidebar.css";
import { WorkspaceNavigation, type SidebarTeamContext } from "./WorkspaceNavigation";

// Keep the media query identical to sidebar.css so layout and modal ownership change together.
export const SIDEBAR_NARROW_QUERY = "(max-width: 740px)";

type WorkspaceSidebarProps = {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly routeKey: string;
  readonly route: AuthRoute;
  readonly team: SidebarTeamContext;
  readonly webhooksAvailable: boolean;
  readonly blocked: boolean;
  readonly workspaceRef: RefObject<HTMLDivElement | null>;
  readonly onNavigate: () => void;
  readonly onCreateTeam?: () => void;
};

export const WorkspaceSidebar = ({ collapsed, onToggle, routeKey, route, team, webhooksAvailable, blocked, workspaceRef, onNavigate, onCreateTeam }: WorkspaceSidebarProps) => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
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
    navigate(event.currentTarget.pathname + event.currentTarget.search);
    onNavigate();
  };
  return <>
    {active && <button className="sidebar-backdrop" type="button" tabIndex={-1} aria-label={m.sidebar.close} onClick={closeDrawer} />}
    <aside ref={sidebar} id="workspace-sidebar" className={`sidebar${active ? " sidebar-drawer-open" : ""}`} aria-label={app.workspaceNavigation} role={active ? "dialog" : undefined} aria-modal={active ? true : undefined} tabIndex={-1}>
      <div className="sidebar-main">
        <a className="brand" href="/projects" onClick={follow} aria-label={app.projectHome} title={app.projectHome}><span className="brand-mark" aria-hidden="true" /><span className="brand-name">daynight</span></a>
        <WorkspaceNavigation route={route} team={team} expanded={expanded} webhooksAvailable={webhooksAvailable} follow={follow} onNavigate={onNavigate} {...(onCreateTeam ? { onCreateTeam: () => { if (narrow) toggle.current?.focus(); setDrawer(null); onCreateTeam(); } } : {})} />
      </div>
      <div className="sidebar-bottom">
        <button ref={toggle} className="sidebar-toggle" type="button" aria-controls="workspace-sidebar" aria-expanded={expanded} aria-label={toggleLabel} title={toggleLabel} onClick={() => {
          if (!narrow) onToggle();
          else if (active) closeDrawer();
          else if (!blocked) setDrawer({ route: routeKey });
        }}><span aria-hidden="true">{expanded ? "‹" : "›"}</span><span className="collapse-label">{toggleLabel}</span></button>
      </div>
    </aside>
  </>;
};
