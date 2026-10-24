import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { navigate, type TaskDetailNavigation } from '../../src/app/router';
import { TaskDetailSurface } from '../../src/features/task-detail/TaskDetailSurface';
import { TaskDetailFixtureBoundary } from './TaskDetailFixtureBoundary';
import { LocaleProvider, useI18n } from '../../src/i18n/LocaleProvider';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { resolveInitialLocale } from '../../src/i18n/locale';
import { createAttachmentFixture, type MockupScenario } from './fixture';
import { createTaskDetailFixture, detailProjectId, detailTaskId } from './task-detail-fixture';
import '../../src/styles/app.css';
import '../../src/styles/task-detail.css';

const readLocation = () => {
  const query = new URLSearchParams(window.location.search);
  const file = query.get('file');
  return {
    taskId: query.get('task') ?? detailTaskId,
    page: query.get('mode') === 'page' || file !== null,
    navigation: { tab: query.get('tab') === 'attachments' ? 'attachments' : query.get('tab') === 'overview' ? 'overview' : file === null ? 'overview' : 'attachments', path: file } as TaskDetailNavigation,
  };
};
const fixture = createTaskDetailFixture();
await fixture.ready;
const query = new URLSearchParams(window.location.search);
const scenario = (query.get('scenario') ?? 'files') as MockupScenario;
const pageUrl = (taskId: string, selection: TaskDetailNavigation) => {
  const parameters = new URLSearchParams({ mode: 'page', task: taskId, tab: selection.tab, scenario });
  if (selection.path !== null) parameters.set('file', selection.path);
  return `${window.location.pathname}?${parameters}`;
};

const DetailMockup = () => {
  const { locale, messages } = useI18n();
  const [location, setLocation] = useState(readLocation);
  const [open, setOpen] = useState(true);
  const snapshot = useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  const inventories = useMemo(() => new Map<string, ReturnType<typeof createAttachmentFixture>>(), []);
  if (!inventories.has(location.taskId)) inventories.set(location.taskId, createAttachmentFixture(scenario, { files: new URL('./files/', window.location.href).pathname, page: window.location.pathname }));
  const attachments = inventories.get(location.taskId)!;
  useEffect(() => () => inventories.forEach((inventory) => inventory.dispose()), [inventories]);
  useEffect(() => {
    const changed = () => setLocation(readLocation());
    window.addEventListener('popstate', changed);
    return () => window.removeEventListener('popstate', changed);
  }, []);
  useEffect(() => { document.documentElement.lang = locale; document.title = messages.workspace.app.documentTitle.task; }, [locale, messages]);
  const select = (taskId: string, selection: TaskDetailNavigation) => {
    if (location.page) {
      const current = readLocation();
      if (current.taskId !== taskId || current.navigation.tab !== selection.tab || current.navigation.path !== selection.path) navigate(pageUrl(taskId, selection));
    } else setLocation({ ...location, taskId, navigation: selection });
  };
  const shared = { projectId: detailProjectId, taskId: location.taskId, snapshot,
    navigation: location.navigation, onNavigate: (selection: TaskDetailNavigation) => select(location.taskId, selection), onSelectTask: (id: string) => select(id, { tab: 'overview', path: null }),
    onRefreshGraph: fixture.refresh, attachmentApi: attachments.api, attachmentUrls: { ...attachments.urls, page: (path: string) => pageUrl(location.taskId, { tab: 'attachments', path }) }, detailUrl: pageUrl };
  const surface = location.page ? <TaskDetailSurface {...shared} presentation="page" /> : <TaskDetailSurface {...shared} presentation="dialog" onClose={() => setOpen(false)} onRestoreFocus={() => document.getElementById('open-detail')?.focus()} />;
  return <TaskDetailFixtureBoundary fixture={fixture}>{location.page ? surface : <>
    <main className="content"><LanguageSelector /><p className="eyebrow">DAYNIGHT</p><h1>完整任务详情交互预览</h1><p className="subtitle">生产详情组件与前端内存数据。</p><button id="open-detail" className="button primary" type="button" onClick={() => setOpen(true)}>打开任务详情</button></main>
    {open && createPortal(surface, document.body)}
  </>}</TaskDetailFixtureBoundary>;
};

const root = document.getElementById('root');
if (root === null) throw new Error('The mockup root is required.');
const reactRoot = createRoot(root);
reactRoot.render(<LocaleProvider initial={resolveInitialLocale()}><DetailMockup /></LocaleProvider>);
import.meta.hot?.dispose(() => { reactRoot.unmount(); fixture.dispose(); });
