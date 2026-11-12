import type { MouseEvent } from "react";
import { useProjectList } from "../../features/projects/ProjectsProvider";
import { useI18n } from "../../i18n/LocaleProvider";

export const SidebarProjectList = ({ hidden, activeProjectId, follow }: {
  readonly hidden: boolean;
  readonly activeProjectId: string | null;
  readonly follow: (event: MouseEvent<HTMLAnchorElement>) => void;
}) => {
  const projects = useProjectList();
  const { messages: { workspace: { projects: p } } } = useI18n();
  return <div className="sidebar-projects" hidden={hidden}>
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
  </div>;
};
