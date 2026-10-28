import type { MouseEvent } from 'react';
import { ApiError } from '../../api/client';
import { navigate } from '../../app/router';
import { useProjectList } from './ProjectsProvider';
import { useI18n } from '../../i18n/LocaleProvider';

const FolderIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    <path d="M3 9h18" />
  </svg>
);

const ArrowIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M5 12h14m-5-5 5 5-5 5" />
  </svg>
);

const openProject = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.pathname);
};

const ErrorDetail = ({ error }: { error: unknown }) => {
  const { messages: { workspace: { projects: m }, common } } = useI18n();
  return (
  <>
    <p>{error instanceof ApiError && error.kind === 'network'
      ? m.networkError
      : m.readError}</p>
    {error instanceof ApiError && error.requestId !== null && (
      <p className="request-id">{common.requestId}<code>{error.requestId}</code></p>
    )}
  </>
  );
};

export const ProjectsPage = ({ onCreate }: { readonly onCreate?: () => void }) => {
  const projects = useProjectList();
  const { messages: { workspace: { projects: m, app }, auth: { createProject } }, format } = useI18n();

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{app.workspace}</p>
          <h1 id="page-title" tabIndex={-1}>{app.projects}</h1>
          <p className="subtitle">{m.subtitle}</p>
        </div>
        <div className="heading-actions">{onCreate !== undefined && <button className="button primary" type="button" onClick={onCreate}>{createProject.open}</button>}<button className="button" type="button" onClick={projects.refresh}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" />
          </svg>
          {m.refresh}
        </button></div>
      </div>

      {projects.status === 'loading' && (
        <section className="state-box" role="status" aria-label={m.loading}>
          <span className="spinner" aria-hidden="true" />
          <h2>{m.loading}</h2>
          <p>{m.loadingDetail}</p>
        </section>
      )}

      {projects.status === 'error' && (
        <section className="state-box" role="alert">
          <div className="state-icon"><FolderIcon /></div>
          <h2>{m.loadingFailed}</h2>
          <ErrorDetail error={projects.error} />
          <button className="button primary" type="button" onClick={projects.refresh}>{m.retry}</button>
        </section>
      )}

      {projects.status === 'ready' && projects.items.length === 0 && (
        <section className="state-box">
          <div className="state-icon"><FolderIcon /></div>
          <h2>{m.empty}</h2>
          <p>{onCreate === undefined ? m.emptyDetail : createProject.emptyDetail}</p>{onCreate !== undefined && <button className="button primary" type="button" onClick={onCreate}>{createProject.createFirst}</button>}
        </section>
      )}

      {projects.status === 'ready' && projects.items.length > 0 && (
        <ul className="project-grid" aria-label={m.list}>
          {projects.items.map((project) => (
            <li key={project.id}>
              <a className="project-card" href={`/projects/${project.id}`} onClick={openProject}>
                <span className="project-icon"><FolderIcon /></span>
                <h2 className="project-name">{project.name}</h2>
                <p className="repo">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                    <path d="M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1 0-4h13M8 7h7M8 10h5" />
                  </svg>
                  <span>{project.repoUrl}</span>
                </p>
                <div className="project-footer">
                  <time dateTime={project.createdAt}>{m.createdOn({ date: format.date(project.createdAt) })}</time>
                  <span className="project-open">{m.viewTasks} <ArrowIcon /></span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}

      {projects.status === 'ready' && projects.nextCursor !== null && (
        <div className="list-footer">
          {projects.moreError !== null && (
            <div className="continuation-error" role="alert">
              <p className="error-title">{m.moreFailed}</p>
              <ErrorDetail error={projects.moreError} />
            </div>
          )}
          <button className="button" type="button" onClick={projects.loadMore} disabled={projects.loadingMore}>
            {projects.loadingMore ? m.loadingMore : projects.moreError !== null ? m.retryMore : m.loadMore}
          </button>
        </div>
      )}
      {projects.status === 'ready' && projects.items.length > 0 && projects.nextCursor === null && (
        <p className="list-footer">{m.allLoaded}</p>
      )}
    </>
  );
};
