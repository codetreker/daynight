import { wireResponse } from "../helpers/wireJson";
import { useEffect, useState, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { stringifyApiJson } from '../../src/api/json';
import type { Attachment, GraphTask, TaskDetail, TaskGraph, TaskStatus } from '../../src/api/types';
import { ProjectPage } from '../../src/features/projects/ProjectPage';
import { LocaleProvider, useI18n } from '../../src/i18n/LocaleProvider';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { resolveInitialLocale } from '../../src/i18n/locale';
import { browsingProjects } from './browsing-fixture';
import '../../src/styles/app.css';

type ResponseMode = 'ready' | 'loading' | 'error';
type ContentMode = 'mixed' | 'empty' | 'long';
const base = browsingProjects.mixed;
const fixture = {
  response: 'ready' as ResponseMode,
  content: 'mixed' as ContentMode,
  revision: 1,
  graphReads: 0,
  detailReads: 0,
  status: 'in_progress' as TaskStatus,
};
const notify = () => window.dispatchEvent(new Event('auto-refresh-fixture'));
const fullTitle = (task: GraphTask) => fixture.content === 'long' ? `${task.titlePreview}：完整验证任务状态、依赖关系、键盘操作及 320px 视口下的自然换行与内容访问能力` : task.titlePreview;
const updatedAt = () => new Date(Date.UTC(2026, 9, 22, 10, fixture.revision)).toISOString();
const graph = (): TaskGraph => {
  const seeds = fixture.content === 'empty' ? [] : base.tasks.map((task, index) => ({
    ...task,
    status: index === 7 ? fixture.status : task.status,
    titlePreview: Array.from(fullTitle(task)).slice(0, 160).join(''),
    titleTruncated: Array.from(fullTitle(task)).length > 160,
    updatedAt: index === 7 ? updatedAt() : task.updatedAt,
  }));
  const statuses = new Map(seeds.map((task) => [task.id, task.status]));
  const tasks: readonly GraphTask[] = seeds.map((task) => {
    const blockedBy = task.dependsOn.filter((id) => statuses.get(id) !== 'done');
    return { ...task, blockedBy, ready: task.status === 'todo' && blockedBy.length === 0 };
  });
  return { observedAt: "2026-10-20T12:00:00Z",
    project: { ...base.project, name: 'Daynight · 自动更新任务状态', updatedAt: updatedAt() },
    tasks,
    summary: {
      total: tasks.length,
      todo: tasks.filter((task) => task.status === 'todo').length,
      inProgress: tasks.filter((task) => task.status === 'in_progress').length,
      done: tasks.filter((task) => task.status === 'done').length,
      ready: tasks.filter((task) => task.ready).length,
      blocked: tasks.filter((task) => task.status === 'todo' && !task.ready).length,
    },
  };
};
const detail = (task: GraphTask): TaskDetail => ({
  ...task,
  version: BigInt(fixture.revision),
  projectId: base.project.id,
  title: fullTitle(base.tasks.find((candidate) => candidate.id === task.id)!),
  description: fixture.content === 'long'
    ? Array.from({ length: 24 }, (_, index) => `验收记录 ${index + 1}：任务状态与服务器快照同步，当前服务器版本 ${fixture.revision}。浏览中的任务链、缩放、滚动位置和详情焦点继续保留。附件页签内可以选择文件、编辑上传路径并预览内容。`).join('\n\n')
    : `当前服务器版本 ${fixture.revision}。\n\n页面每 5 秒获取完整任务快照。切换到其他浏览器页签后暂停，返回页面时立即检查最新状态。\n\n使用上方“推进服务端状态”修改模拟服务端数据，然后观察统计、任务链和已打开详情自动更新。附件表单和预览保持可操作。`,
  properties: { worker: null, pullRequests: [] },
});
const attachmentFiles = new Map<string, { readonly body: string; readonly contentType: string }>([
  ['acceptance/status.md', { body: '# 自动更新验收\n\n- 每 5 秒拉取完整任务状态\n- 隐藏页面暂停，返回立即刷新\n- 保留任务浏览和附件表单\n\n本文件仅保存在预览页面内存中。', contentType: 'text/markdown' }],
]);
const attachment = (path: string, file: { readonly body: string; readonly contentType: string }): Attachment => ({
  path, contentType: file.contentType, sizeBytes: new TextEncoder().encode(file.body).length,
  createdAt: '2026-10-22T09:00:00Z', updatedAt: updatedAt(),
});
const delay = (ms: number, signal: AbortSignal | null | undefined) => new Promise<void>((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { window.clearTimeout(timer); reject(signal!.reason); };
  const timer = window.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
const installFixture = () => {
  const original = window.fetch;
  const replacement: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const method = init?.method ?? request?.method ?? 'GET';
    const signal = init?.signal ?? request?.signal;
    signal?.throwIfAborted();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const prefix = `/api/v1/projects/${base.project.id}`;
    if (url.origin !== location.origin || !url.pathname.startsWith(prefix)) throw new Error(`Unknown auto-refresh preview request: ${url.pathname}`);
    const graphRequest = url.pathname === `${prefix}/task-graph`;
    const taskRequest = new RegExp(`^${prefix}/tasks/([^/]+)(?:/attachments(?:/(.*))?)?$`).exec(url.pathname);
    if (method === 'GET' && (graphRequest || taskRequest !== null && taskRequest[2] === undefined && !url.pathname.endsWith('/attachments'))) {
      if (graphRequest) fixture.graphReads++;
      else fixture.detailReads++;
      notify();
      await delay(400, signal);
      while (fixture.response === 'loading') await delay(100, signal);
      if (fixture.response === 'error') return Response.json({ error: { code: 'internal_error', message: 'Preview service is temporarily unavailable.', requestId: 'preview-auto-refresh' } }, { status: 500 });
      const snapshot = graph();
      if (graphRequest) return wireResponse(snapshot);
      const task = snapshot.tasks.find((candidate) => candidate.id === taskRequest![1]);
      return task === undefined ? Response.json({ error: { code: 'not_found', message: 'Task no longer exists.', requestId: 'preview-task-missing' } }, { status: 404 }) : new Response(stringifyApiJson(detail(task)), { headers: { 'Content-Type': 'application/json' } });
    }
    if (taskRequest !== null && url.pathname.endsWith('/attachments') && method === 'GET') {
      return Response.json({ items: Array.from(attachmentFiles, ([path, file]) => attachment(path, file)), nextCursor: null });
    }
    if (taskRequest !== null && taskRequest[2] !== undefined) {
      const path = taskRequest[2].replace(/^files\//, '').split('/').map(decodeURIComponent).join('/');
      if (method === 'PUT') {
        const body = init?.body;
        if (!(body instanceof Blob)) throw new Error('The preview requires a file upload body.');
        const file = { body: await body.text(), contentType: body.type || 'application/octet-stream' };
        attachmentFiles.set(path, file);
        return Response.json(attachment(path, file));
      }
      if (method === 'DELETE') { attachmentFiles.delete(path); return new Response(null, { status: 204 }); }
      const file = attachmentFiles.get(path);
      if (file !== undefined && (method === 'GET' || method === 'HEAD')) return new Response(method === 'HEAD' ? null : file.body, { headers: { 'Content-Type': file.contentType } });
    }
    throw new Error(`Unsupported auto-refresh preview request: ${method} ${url.pathname}`);
  };
  window.fetch = replacement;
  return () => { if (window.fetch === replacement) window.fetch = original; };
};

const AutoRefreshMockup = () => {
  const { locale, messages } = useI18n();
  const m = messages.workspace.app;
  const [, setTick] = useState(0);
  const [pageKey, setPageKey] = useState(0);
  const [advanceAutomatically, setAdvanceAutomatically] = useState(false);
  useEffect(() => {
    if (!advanceAutomatically) return;
    const timer = window.setInterval(() => {
      fixture.status = fixture.status === 'in_progress' ? 'done' : fixture.status === 'done' ? 'todo' : 'in_progress';
      fixture.revision++;
      notify();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [advanceAutomatically]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = '任务状态自动更新交互预览 · Daynight';
  }, [locale]);
  useEffect(() => {
    const update = () => setTick((value) => value + 1);
    window.addEventListener('auto-refresh-fixture', update);
    update();
    return () => window.removeEventListener('auto-refresh-fixture', update);
  }, []);
  const change = (apply: () => void) => { apply(); notify(); };
  const keepPreviewLocation = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element) || event.target.closest('a[href="/"]') === null) return;
    event.preventDefault(); event.stopPropagation();
    document.getElementById('mock-response')?.focus();
  };
  return <div className="shell" onClickCapture={keepPreviewLocation}>
    <a className="skip-link" href="#main-content">{m.skipToContent}</a>
    <aside className="sidebar" aria-label={m.workspaceNavigation}>
      <a className="brand" href="/" aria-label={m.projectHome}><span className="brand-mark" aria-hidden="true" />daynight</a>
      <nav aria-label={m.mainNavigation}><p className="nav-label">{m.workspace}</p><a className="nav-button" href="/" aria-current="page"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>{m.projects}</a></nav>
      <div className="sidebar-bottom">{m.localWorkspace}<small>{m.localWorkspaceDetail}</small></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><nav className="crumb" aria-label={m.breadcrumb}><a href="/">{m.workspace}</a><span aria-hidden="true">/</span><span className="crumb-current" aria-current="page">{m.projectTasks}</span></nav><div className="topbar-tools"><span className="local-label">{m.localLabel}</span><LanguageSelector /></div></header>
      <main className="content" id="main-content" tabIndex={-1}>
        <section className="snapshot-notice" aria-label="自动更新预览控制" style={{ margin: '0 0 24px' }}>
          <p><strong>任务状态自动更新 · 交互预览</strong></p>
          <p>服务端变更会在下一次自动请求后出现。每 5 秒读取任务快照；切换到其他页签再返回，可检查立即刷新。展开任务链、打开详情或附件后，也可以继续观察同步效果。</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <button className="button" type="button" onClick={() => change(() => {
              fixture.status = fixture.status === 'in_progress' ? 'done' : fixture.status === 'done' ? 'todo' : 'in_progress';
              fixture.revision++;
            })}>推进服务端状态</button>
            <label><input type="checkbox" checked={advanceAutomatically} onChange={(event) => setAdvanceAutomatically(event.currentTarget.checked)} /> 每 8 秒推进服务端状态</label>
            <label htmlFor="mock-response">服务响应 <select id="mock-response" value={fixture.response} onChange={(event) => change(() => { fixture.response = event.currentTarget.value as ResponseMode; })}>
              <option value="ready">正常 / 恢复</option><option value="loading">持续加载</option><option value="error">请求失败</option>
            </select></label>
            <label htmlFor="mock-content">服务端内容 <select id="mock-content" value={fixture.content} onChange={(event) => change(() => { fixture.content = event.currentTarget.value as ContentMode; fixture.revision++; })}>
              <option value="mixed">混合任务与依赖</option><option value="empty">空项目</option><option value="long">长标题与长描述</option>
            </select></label>
            <button className="button" type="button" onClick={() => setPageKey((value) => value + 1)}>重新进入项目</button>
          </div>
          <p aria-live="polite">服务端版本 {fixture.revision} · 生命周期任务：{messages.common.status[fixture.status]} · 图请求 {fixture.graphReads} 次 · 详情请求 {fixture.detailReads} 次</p>
          <p>“持续加载”或“请求失败”后点击“重新进入项目”，可查看初始加载和错误状态；切回“正常 / 恢复”可观察恢复。将浏览器宽度设为 320px 查看窄屏。附件支持内存中的上传、预览与删除，刷新整个预览会还原。</p>
        </section>
        <ProjectPage key={pageKey} projectId={base.project.id} />
      </main>
    </div>
  </div>;
};

const container = document.getElementById('root');
if (container === null) throw new Error('The auto-refresh mockup root is required.');
const disposeFixture = installFixture();
const root = createRoot(container);
root.render(<LocaleProvider initial={resolveInitialLocale()}><AutoRefreshMockup /></LocaleProvider>);
import.meta.hot?.dispose(() => { root.unmount(); disposeFixture(); });
