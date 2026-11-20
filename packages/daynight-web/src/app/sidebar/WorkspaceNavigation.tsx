import type { MouseEvent } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { TeamSelector } from "../../features/teams/TeamSelector";
import { useTeamMessages } from "../../features/teams/messages";
import { useBotMessages } from "../../features/bots/messages";
import { useTestSessionListMessages } from "../../features/task-agent-session/test-session-list-messages";
import type { AuthRoute } from "../router";
import { SidebarProjectList } from "./SidebarProjectList";
import { SidebarIcon } from "./SidebarIcon";

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
  const githubAppsLabel = locale === "zh-CN" ? "GitHub Apps" : "My GitHub Apps";
  const activeProjectId = route.kind === "project" || route.kind === "settings" ? route.projectId : null;
  return <nav aria-label={app.mainNavigation}>
    <div className="sidebar-group">
      <TeamSelector personalId={team.personalId} selectedId={team.readyTeamId} visibilityTeamId={team.visibilityTeamId} onNavigate={onNavigate} {...(onCreateTeam ? { onCreate: onCreateTeam } : {})} />
      <a className="nav-button" href="/my-tasks" onClick={follow} aria-label={locale === "zh-CN" ? "进行中的任务" : "In-progress tasks"} title={locale === "zh-CN" ? "进行中的任务" : "In-progress tasks"} aria-current={route.kind === "myTasks" ? "page" : undefined}><SidebarIcon name="tasks" /><span className="nav-text">{locale === "zh-CN" ? "进行中的任务" : "In-progress tasks"}</span></a>
      <a className="nav-button" {...teamLink((id) => id === team.personalId ? "/projects" : `/teams/${id}`)} aria-label={app.projects} title={app.projects} aria-current={route.kind === "projects" || route.kind === "team" ? "page" : undefined}><SidebarIcon name="projects" /><span className="nav-text">{app.projects}</span></a>
      <SidebarProjectList hidden={!expanded} activeProjectId={activeProjectId} follow={follow} />
      {team.visibilityTeamId !== team.personalId && <a className="nav-button" {...teamLink((id) => `/teams/${id}/settings`)} aria-label={teamMessages.settings} title={teamMessages.settings} aria-current={route.kind === "teamSettings" || route.kind === "teamMembers" || route.kind === "teamGitHubApps" ? "page" : undefined}><SidebarIcon name="settings" /><span className="nav-text">{teamMessages.settings}</span></a>}
      {team.visibilityTeamId === team.personalId && <a className="nav-button" {...teamLink((id) => `/teams/${id}/github-apps`)} aria-label="GitHub Apps" title="GitHub Apps" aria-current={route.kind === "teamGitHubApps" ? "page" : undefined}><SidebarIcon name="settings" /><span className="nav-text">GitHub Apps</span></a>}
    </div>
    <div className="sidebar-group">
      <p className="nav-label">{app.my}</p>
      <a className="nav-button" href="/github-apps" onClick={follow} aria-label={githubAppsLabel} title={githubAppsLabel} aria-current={(route.kind === "githubApps" || (route.kind === "githubAppAdmins" || route.kind === "githubAppTeams")) ? "page" : undefined}><SidebarIcon name="githubApps" /><span className="nav-text">{githubAppsLabel}</span></a>
      <a className="nav-button" href="/shared-projects" onClick={follow} aria-label={teamMessages.shared} title={teamMessages.shared} aria-current={route.kind === "sharedProjects" ? "page" : undefined}><SidebarIcon name="shared" /><span className="nav-text">{teamMessages.shared}</span></a>
      <a className="nav-button" href="/workers" onClick={follow} aria-label={m.workers} title={m.workers} aria-current={route.kind === "workers" || route.kind === "worker" ? "page" : undefined}><SidebarIcon name="workers" /><span className="nav-text">{m.workers}</span></a>
      <a className="nav-button" href="/bots" onClick={follow} aria-label={botMessages.title} title={botMessages.title} aria-current={route.kind === "bots" || route.kind === "bot" || route.kind === "assistantTask" ? "page" : undefined}><SidebarIcon name="bots" /><span className="nav-text">{botMessages.title}</span></a>
    </div>
    <div className="sidebar-group">
      <p className="nav-label">{app.tools}</p>
      {webhooksAvailable && <a className="nav-button" href="/webhooks?owner=personal" onClick={follow} aria-label="Webhooks" title="Webhooks" aria-current={route.kind === "webhooks" ? "page" : undefined}><SidebarIcon name="webhooks" /><span className="nav-text">Webhooks</span></a>}
      <a className="nav-button" href="/test-sessions" onClick={follow} aria-label={testMessages.title} title={testMessages.title} aria-current={route.kind === "testSessions" || route.kind === "testSession" ? "page" : undefined}><SidebarIcon name="sessions" /><span className="nav-text">{testMessages.title}</span></a>
    </div>
  </nav>;
};
