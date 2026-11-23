import { BrandMark } from "../../ui/BrandMark";
import { useLayoutEffect, useRef, type MouseEvent, type RefObject } from "react";
import { tabbable } from "tabbable";
import { useI18n } from "../../i18n/LocaleProvider";
import { navigate, type AuthRoute } from "../router";
import { useBodyScrollLock } from "../useBodyScrollLock";
import "../../styles/sidebar.css";
import { WorkspaceNavigation, type SidebarTeamContext } from "./WorkspaceNavigation";
import type { WorkspaceDrawer } from "./useWorkspaceDrawer";
export { SIDEBAR_NARROW_QUERY } from "./useWorkspaceDrawer";

type WorkspaceSidebarProps = {
  readonly drawer: WorkspaceDrawer;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly route: AuthRoute;
  readonly team: SidebarTeamContext;
  readonly webhooksAvailable: boolean;
  readonly blocked: boolean;
  readonly workspaceRef: RefObject<HTMLDivElement | null>;
  readonly onNavigate: () => void;
  readonly onCreateTeam?: () => void;
};

export const WorkspaceSidebar = ({ drawer, collapsed, onToggle, route, team, webhooksAvailable, blocked, workspaceRef, onNavigate, onCreateTeam }: WorkspaceSidebarProps) => {
  const { messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  const { narrow, active, openerRef, closeReason, routeChanged } = drawer;
  const sidebar = useRef<HTMLElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const callbacks = useRef({ onNavigate, onCreateTeam });
  callbacks.current = { onNavigate, onCreateTeam };
  const expanded = narrow ? active : !collapsed;
  const toggleLabel = expanded ? m.sidebar.collapse : m.sidebar.expand;
  useBodyScrollLock(active);

  useLayoutEffect(() => {
    if (!active) {
      const reason = closeReason.current;
      closeReason.current = null;
      if (blocked) return;
      if (reason === "breakpoint" && sidebar.current?.contains(document.activeElement)) {
        const target = narrow ? openerRef.current : sidebar.current.querySelector<HTMLButtonElement>(".sidebar-toggle");
        if (target?.isConnected && target.closest("[inert], [hidden]") === null) target.focus({ preventScroll: true });
      }
      if (!narrow) return;
      // The active effect's cleanup has released background inert before focus returns.
      if (reason === "dismiss" || reason === "create-team") {
        const opener = openerRef.current;
        if (opener?.isConnected && opener.closest("[inert], [hidden]") === null) opener.focus({ preventScroll: true });
      }
      if (reason === "navigate" || routeChanged) callbacks.current.onNavigate();
      if (reason === "create-team") callbacks.current.onCreateTeam?.();
      return;
    }
    const background = workspaceRef.current!;
    const wasInert = background.hasAttribute("inert");
    if (!wasInert) background.setAttribute("inert", "");
    const element = sidebar.current!;
    const focusFirst = () => (tabbable(element)[0] ?? element).focus({ preventScroll: true });
    element.querySelector<HTMLButtonElement>(".sidebar-close")!.focus({ preventScroll: true });
    const close = () => drawer.close("dismiss");
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
  }, [active, blocked, narrow, routeChanged, workspaceRef, closeReason, openerRef]);

  const closeDrawer = () => drawer.close("dismiss");
  const completeNavigation = () => { if (active) drawer.close("navigate"); else onNavigate(); };
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.currentTarget.target !== "" && event.currentTarget.target !== "_self") return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    completeNavigation();
    navigate(event.currentTarget.pathname + event.currentTarget.search + event.currentTarget.hash);
  };
  return <>
    {active && <button className="sidebar-backdrop" type="button" tabIndex={-1} aria-label={m.sidebar.close} onClick={closeDrawer} />}
    <aside ref={sidebar} id="workspace-sidebar" className={`sidebar${active ? " sidebar-drawer-open" : ""}`} hidden={narrow && !active} inert={narrow && !active} aria-label={app.workspaceNavigation} role={active ? "dialog" : undefined} aria-modal={active ? true : undefined} tabIndex={-1}>
      <div className="sidebar-main">
        <div className="sidebar-header">
        <button className="sidebar-close" hidden={!narrow} type="button" aria-label={m.sidebar.close} title={m.sidebar.close} onClick={closeDrawer}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
        <a className="brand" href="/projects" onClick={follow} aria-label={app.projectHome} title={app.projectHome}><BrandMark className="brand-mark" surface="dark" /><span className="brand-name">daynight</span></a>
        </div>
        <WorkspaceNavigation route={route} team={team} expanded={expanded} webhooksAvailable={webhooksAvailable} follow={follow} onNavigate={completeNavigation} {...(onCreateTeam ? { onCreateTeam: () => { if (active) drawer.close("create-team"); else onCreateTeam(); } } : {})} />
      </div>
      {!narrow && <div className="sidebar-bottom">
        <button className="sidebar-toggle" type="button" aria-controls="workspace-sidebar" aria-expanded={expanded} aria-label={toggleLabel} title={toggleLabel} onClick={onToggle}><span aria-hidden="true">{expanded ? "‹" : "›"}</span><span className="collapse-label">{toggleLabel}</span></button>
      </div>}
    </aside>
  </>;
};
