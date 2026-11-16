import type { MouseEvent } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { TeamSelector } from "../../features/teams/TeamSelector";
import { useTeamMessages } from "../../features/teams/messages";
import { useBotMessages } from "../../features/bots/messages";
import { useTestSessionListMessages } from "../../features/task-agent-session/test-session-list-messages";
import type { AuthRoute } from "../router";
import { SidebarProjectList } from "./SidebarProjectList";

export type SidebarTeamContext = {
  readonly personalId: string;
  readonly readyTeamId: string | null;
  readonly visibilityTeamId: string | null;
};

export const WorkspaceNavigation = ({ route, team, expanded, webhooksAvailable, follow, onNavigate, onCreateTeam }: {
  readonly route: AuthRoute;
  readonly team: SidebarTeamContext;
  readonly expanded: boolean;
  readonly webhooksAvailable: boolean;
  readonly follow: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly onNavigate: () => void;
  readonly onCreateTeam?: () => void;
}) => {
  const { locale, messages: { auth: { shell: m }, workspace: { app } } } = useI18n();
  const teamMessages = useTeamMessages();
  const testMessages = useTestSessionListMessages();
  const botMessages = useBotMessages();
  const teamLink = (target: (teamId: string) => string) => team.readyTeamId === null
    ? { role: "link", "aria-disabled": true as const }
    : { href: target(team.readyTeamId), onClick: follow };
  const activeProjectId = route.kind === "project" || route.kind === "settings" ? route.projectId : null;
  return <nav aria-label={app.mainNavigation}>
    <div className="sidebar-group">
      <TeamSelector personalId={team.personalId} selectedId={team.readyTeamId} visibilityTeamId={team.visibilityTeamId} onNavigate={onNavigate} {...(onCreateTeam ? { onCreate: onCreateTeam } : {})} />
      <a className="nav-button" {...teamLink((id) => id === team.personalId ? "/projects" : `/teams/${id}`)} aria-label={app.projects} title={app.projects} aria-current={route.kind === "projects" || route.kind === "team" ? "page" : undefined}><span className="nav-icon" aria-hidden="true">▦</span><span className="nav-text">{app.projects}</span></a>
      <SidebarProjectList hidden={!expanded} activeProjectId={activeProjectId} follow={follow} />
      {team.visibilityTeamId !== team.personalId && <a className="nav-button" {...teamLink((id) => `/teams/${id}/settings`)} aria-label={teamMessages.settings} title={teamMessages.settings} aria-current={route.kind === "teamSettings" || route.kind === "teamMembers" ? "page" : undefined}><span className="nav-icon" aria-hidden="true">⚙</span><span className="nav-text">{teamMessages.settings}</span></a>}
    </div>
    <div className="sidebar-group">
      <p className="nav-label">{app.my}</p>
      <a className="nav-button" href="/my-tasks" onClick={follow} aria-label={locale === "zh-CN" ? "进行中的任务" : "In-progress tasks"} title={locale === "zh-CN" ? "进行中的任务" : "In-progress tasks"} aria-current={route.kind === "myTasks" ? "page" : undefined}><span className="nav-icon" aria-hidden="true">◷</span><span className="nav-text">{locale === "zh-CN" ? "进行中的任务" : "In-progress tasks"}</span></a>
      <a className="nav-button" href="/shared-projects" onClick={follow} aria-label={teamMessages.shared} title={teamMessages.shared} aria-current={route.kind === "sharedProjects" ? "page" : undefined}><span className="nav-icon" aria-hidden="true">◇</span><span className="nav-text">{teamMessages.shared}</span></a>
      <a className="nav-button" href="/workers" onClick={follow} aria-label={m.workers} title={m.workers} aria-current={route.kind === "workers" || route.kind === "worker" ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 8h10M7 12h6" /></svg></span><span className="nav-text">{m.workers}</span></a>
      <a className="nav-button" href="/bots" onClick={follow} aria-label={botMessages.title} title={botMessages.title} aria-current={route.kind === "bots" || route.kind === "bot" || route.kind === "assistantTask" ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" /></svg></span><span className="nav-text">{botMessages.title}</span></a>
    </div>
    <div className="sidebar-group">
      <p className="nav-label">{app.tools}</p>
      {webhooksAvailable && <a className="nav-button" href="/webhooks?owner=personal" onClick={follow} aria-label="Webhooks" title="Webhooks" aria-current={route.kind === "webhooks" ? "page" : undefined}><span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 9a4 4 0 1 1 5-6M17 9a4 4 0 1 1-4 7M7 17a4 4 0 1 1-4-5M7 9l-3 6h12M12 5l5 8" /></svg></span><span className="nav-text">Webhooks</span></a>}
      <a className="nav-button" href="/test-sessions" onClick={follow} aria-label={testMessages.title} title={testMessages.title} aria-current={route.kind === "testSessions" || route.kind === "testSession" ? "page" : undefined}><span className="nav-icon" aria-hidden="true">▷</span><span className="nav-text">{testMessages.title}</span></a>
    </div>
  </nav>;
};
