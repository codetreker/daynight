import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectPage } from '../../src/features/projects/ProjectPage';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { LocaleProvider, useI18n } from '../../src/i18n/LocaleProvider';
import { resolveInitialLocale } from '../../src/i18n/locale';
import { TestTaskCacheBoundary } from '../helpers/taskCache';
import { createRecentFixture, readRecentScenario, recentScenarios, type RecentFixture, type RecentScenario } from './recent-tasks-fixture';
import '../../src/styles/app.css';

const RecentTasksMockup = ({ fixture }: { readonly fixture: RecentFixture }) => {
  const { locale, messages: { workspace: { app } } } = useI18n();
  const [scenario, setScenario] = useState(readRecentScenario);
  const [recovered, setRecovered] = useState<ReadonlySet<RecentScenario>>(new Set());
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    const change = () => setScenario(readRecentScenario());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const keepPreviewLocation = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    if (event.target.closest('a[href="/"],a[href="/projects"]') === null) return;
    event.preventDefault(); event.stopPropagation(); select.current?.focus();
  };
  return <div className="shell" onClickCapture={keepPreviewLocation}>
    <aside className="sidebar" aria-label={app.workspaceNavigation}>
      <a className="brand" href="/" aria-label={app.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a>
      <nav aria-label={app.mainNavigation}><p className="nav-label">{app.workspace}</p><a className="nav-button" href="/projects" aria-current="page">{app.projects}</a></nav>
      <div className="sidebar-bottom">{app.localWorkspace}<small>{app.localWorkspaceDetail}</small></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><nav className="crumb" aria-label={app.breadcrumb}><a href="/projects">{app.workspace}</a><span aria-hidden="true">/</span><span className="crumb-current">{app.projectTasks}</span></nav><div className="topbar-tools"><LanguageSelector /></div></header>
      <main className="content" id="main-content" tabIndex={-1}>
        <section className="snapshot-notice" aria-label="Preview scenario" style={{ margin: '0 0 24px', overflowWrap: 'anywhere' }}>
          <label htmlFor="recent-scenario">Preview scenario </label>
          <select ref={select} id="recent-scenario" value={scenario} style={{ maxWidth: '100%' }} onChange={(event) => { location.hash = event.currentTarget.value; }}>
            {(Object.keys(recentScenarios) as RecentScenario[]).map((key) => <option key={key} value={key}>{recentScenarios[key]}</option>)}
          </select>
          {(scenario === 'failure' || scenario === 'loading') && <button className="button" type="button" disabled={recovered.has(scenario)} style={{ margin: '8px 0 0 8px' }} onClick={() => { fixture.recover(scenario); setRecovered((value) => new Set([...value, scenario])); }}>{scenario === 'loading' ? 'Release response' : 'Recover service, then retry'}</button>}
        </section>
        <TestTaskCacheBoundary key={scenario}><ProjectPage projectId={fixture.projectId(scenario)} /></TestTaskCacheBoundary>
      </main>
    </div>
  </div>;
};

const container = document.getElementById('root');
if (container === null) throw new Error('The recent-task mockup root is required.');
const fixture = createRecentFixture();
const root = createRoot(container);
root.render(<LocaleProvider initial={resolveInitialLocale()}><RecentTasksMockup fixture={fixture} /></LocaleProvider>);
import.meta.hot?.dispose(() => { root.unmount(); fixture.dispose(); });
