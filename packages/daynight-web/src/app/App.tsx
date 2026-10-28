import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { TaskDetailPage } from '../features/task-detail/TaskDetailPage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { ProjectsProvider } from '../features/projects/ProjectsProvider';
import { ProjectPage } from '../features/projects/ProjectPage';
import { navigate, parseRoute } from './router';
import { useI18n } from '../i18n/LocaleProvider';
import { TaskDetailSessionBoundary } from '../features/task-detail/TaskDetailSession';
import { LanguageSelector } from '../i18n/LanguageSelector';

const goToProjects = (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate('/projects');
};

const AppView = () => {
  const { locale, messages: { workspace: { app: m } } } = useI18n();
  const [location, setLocation] = useState(() => ({ pathname: window.location.pathname, search: window.location.search }));
  const { pathname, search } = location;
  const content = useRef<HTMLElement>(null);
  const route = parseRoute(pathname, search);

  useEffect(() => {
    const onNavigate = () => {
      setLocation({ pathname: window.location.pathname, search: window.location.search });
    };
    window.addEventListener('popstate', onNavigate);
    return () => { window.removeEventListener('popstate', onNavigate); };
  }, []);

  useLayoutEffect(() => { content.current?.focus(); }, [pathname]);

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = m.documentTitle[route.kind];
  }, [locale, m, route.kind]);

  if (route.kind === 'attachment' || route.kind === 'task') return <TaskDetailPage key={route.projectId} projectId={route.projectId} taskId={route.taskId} navigation={{ tab: route.tab, path: route.path }} />;

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">{m.skipToContent}</a>
      <aside className="sidebar" aria-label={m.workspaceNavigation}>
        <a className="brand" href="/projects" onClick={goToProjects} aria-label={m.projectHome}>
          <span className="brand-mark" aria-hidden="true" />daynight
        </a>
        <nav aria-label={m.mainNavigation}>
          <p className="nav-label">{m.workspace}</p>
          <a className="nav-button" href="/projects" onClick={goToProjects} aria-current={route.kind === 'notFound' ? undefined : 'page'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            {m.projects}
          </a>
        </nav>
        <div className="sidebar-bottom">{m.localWorkspace}<small>{m.localWorkspaceDetail}</small></div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <nav className="crumb" aria-label={m.breadcrumb}>
            <a href="/projects" onClick={goToProjects}>{m.workspace}</a>
            <span aria-hidden="true">/</span>
            <span className="crumb-current" aria-current="page">{route.kind === 'projects' ? m.projects : route.kind === 'project' ? m.projectTasks : m.notFound}</span>
          </nav>
          <div className="topbar-tools"><span className="local-label">{m.localLabel}</span><LanguageSelector /></div>
        </header>
        <main className="content" id="main-content" ref={content} tabIndex={-1}>
          {route.kind === 'projects' ? <ProjectsProvider><ProjectsPage /></ProjectsProvider> : route.kind === 'project' ? <ProjectPage key={route.projectId} projectId={route.projectId} /> : (
            <section className="state-box">
              <p className="eyebrow">404</p>
              <h1>{m.notFound}</h1>
              <p>{m.notFoundDetail}</p>
              <a className="button primary" href="/projects" onClick={goToProjects}>{m.returnToProjects}</a>
            </section>
          )}
        </main>
      </div>
    </div>
  );
};

export const App = () => <TaskDetailSessionBoundary><AppView /></TaskDetailSessionBoundary>;
