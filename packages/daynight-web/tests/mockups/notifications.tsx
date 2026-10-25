import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ApiError } from '../../src/api/client';
import type { TaskDetailNavigation } from '../../src/app/router';
import { TaskDetailSurface } from '../../src/features/task-detail/TaskDetailSurface';
import { TaskDetailFixtureBoundary } from './TaskDetailFixtureBoundary';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { createAttachmentFixture } from './fixture';
import { createTaskDetailFixture, detailProjectId, detailTaskId } from './task-detail-fixture';
import '../../src/styles/app.css';

const query = new URLSearchParams(window.location.search);
const scenario = query.get('notice') ?? 'normal';
const page = query.get('mode') === 'page';
const fixture = createTaskDetailFixture({ initialStatus: scenario === 'locked' ? 'in_progress' : 'todo' });
await fixture.ready;
const attachments = createAttachmentFixture('files');
if (scenario === 'unknown') fixture.failNextMutation();
if (scenario === 'stale') fixture.holdGraph();

const NotificationsMockup = () => {
  const snapshot = useSyncExternalStore(fixture.subscribe, fixture.snapshot);
  const [open, setOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [taskId, setTaskId] = useState(query.get('task') ?? detailTaskId);
  const [graphError, setGraphError] = useState<unknown>(null);
  const [selection, setSelection] = useState<TaskDetailNavigation>({ tab: query.get('tab') === 'attachments' || query.has('file') ? 'attachments' : 'overview', path: query.get('file') });
  useEffect(() => {
    if (scenario !== 'read-error' && scenario !== 'graph-error') return;
    const timer = window.setTimeout(() => { if (scenario === 'read-error') fixture.failRefresh(); else setGraphError(new ApiError('network', null, 'network', 'fixture-graph-refresh')); }, 1000);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => () => { fixture.dispose(); attachments.dispose(); }, []);
  const detailUrl = (id: string, navigation: TaskDetailNavigation) => {
    const parameters = new URLSearchParams({ notice: scenario, mode: 'page', task: id, tab: navigation.tab });
    if (navigation.path !== null) parameters.set('file', navigation.path);
    return `${window.location.pathname}?${parameters}`;
  };
  const shared = { fullscreen: { active: fullscreen, onChange: setFullscreen },
    projectId: detailProjectId, taskId, snapshot, detailUrl,
    navigation: selection, onNavigate: setSelection,
    onSelectTask: (id: string) => { setTaskId(id); setSelection({ tab: 'overview', path: null }); }, graphError, onRefreshGraph: () => { setGraphError(null); fixture.refreshGraph(); },
    attachmentApi: attachments.api, attachmentUrls: { ...attachments.urls, page: (path: string) => detailUrl(taskId, { tab: 'attachments', path }) },
  };
  return <TaskDetailFixtureBoundary fixture={fixture}>{page
    ? <TaskDetailSurface {...shared} presentation="page" />
    : <>
      <main className="content">
        <LanguageSelector />
        <p className="eyebrow">DAYNIGHT</p><h1>任务详情提示交互预览</h1>
        <p className="subtitle">使用生产组件。锁定说明通过控件 tip 阅读，其余反馈在浮动气泡中显示。</p>
        <p>选择场景后打开详情；未知结果与快照过期场景可通过修改状态触发，刷新失败会自动触发。</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '24px 0' }}>
          {(['normal', 'locked', 'unknown', 'read-error', 'graph-error', 'stale'] as const).map((value) => <a className="button" key={value} href={`?notice=${value}`}>{({ normal: '正常 / 操作成功', locked: '运行中锁定', unknown: '写入结果未知', 'read-error': '详情刷新失败', 'graph-error': '任务图刷新失败', stale: '快照过期' })[value]}</a>)}
          <a className="button" href={`?notice=${scenario}&mode=page`}>独立详情页</a>
        </div>
        <button id="open-detail" className="button primary" type="button" onClick={() => setOpen(true)}>打开任务详情</button>
      </main>
      {open && createPortal(<TaskDetailSurface {...shared} presentation="dialog" onClose={() => { setFullscreen(false); setOpen(false); }} onRestoreFocus={() => document.getElementById('open-detail')?.focus()} />, document.body)}
    </>}
  </TaskDetailFixtureBoundary>;
};

const root = document.getElementById('root');
if (root === null) throw new Error('The notification mockup root is required.');
createRoot(root).render(<LocaleProvider initial={{ locale: 'zh-CN', issue: null }}><NotificationsMockup /></LocaleProvider>);
