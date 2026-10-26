import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { TestTaskCacheBoundary } from '../helpers/taskCache';
import { ProjectPage } from '../../src/features/projects/ProjectPage';
import { LocaleProvider, useI18n } from '../../src/i18n/LocaleProvider';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { resolveInitialLocale } from '../../src/i18n/locale';
import { browsingProjects, browsingScenarioLabels, installBrowsingFixture, isStatusScenario, readBrowsingDetailScenario, readBrowsingScenario, type BrowsingDetailScenario, type BrowsingFixture, type BrowsingScenario } from './browsing-fixture';
import '../../src/styles/app.css';

const BrowsingMockup = ({ fixture }: { readonly fixture: BrowsingFixture }) => {
  const { locale, messages } = useI18n();
  const m = messages.workspace.app;
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = m.documentTitle.project;
  }, [locale, m]);
  const [scenario, setScenario] = useState(readBrowsingScenario);
  const [detailScenario, setDetailScenario] = useState(readBrowsingDetailScenario);
  useSyncExternalStore(fixture.subscribe, fixture.getRevision);
  const controls = fixture.controls(scenario);
  const scenarioSelect = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const updateScenario = () => setScenario(readBrowsingScenario());
    window.addEventListener('hashchange', updateScenario);
    return () => window.removeEventListener('hashchange', updateScenario);
  }, []);

  const keepPreviewLocation = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!(event.target instanceof Element) || event.target.closest('a[href="/"]') === null) return;
    event.preventDefault();
    event.stopPropagation();
    scenarioSelect.current?.focus();
  };

  return (
    <div className="shell" onClickCapture={keepPreviewLocation}>
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault();
        document.getElementById('main-content')?.focus();
      }}>{m.skipToContent}</a>
      <aside className="sidebar" aria-label={m.workspaceNavigation}>
        <a className="brand" href="/" aria-label={m.projectHome}>
          <span className="brand-mark" aria-hidden="true" />daynight
        </a>
        <nav aria-label={m.mainNavigation}>
          <p className="nav-label">{m.workspace}</p>
          <a className="nav-button" href="/" aria-current="page">
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
            <a href="/">{m.workspace}</a><span aria-hidden="true">/</span>
            <span className="crumb-current" aria-current="page">{m.projectTasks}</span>
          </nav>
          <div className="topbar-tools"><span className="local-label">{m.localLabel}</span><LanguageSelector /></div>
        </header>
        <main className="content" id="main-content" tabIndex={-1}>
          <section className="snapshot-notice" aria-label="预览场景" style={{ margin: '0 0 24px', overflowWrap: 'anywhere' }}>
            <label htmlFor="browsing-scenario">任务链浏览交互预览 · 项目场景 </label>
            <select
              id="browsing-scenario" ref={scenarioSelect} value={scenario} style={{ maxWidth: '100%' }}
              onChange={(event) => { location.hash = event.currentTarget.value; }}
            >
              {(Object.keys(browsingScenarioLabels) as BrowsingScenario[]).map((key) => <option key={key} value={key}>{browsingScenarioLabels[key]}</option>)}
            </select>
            <label htmlFor="browsing-detail-scenario"> 详情内容 </label>
            <select id="browsing-detail-scenario" value={detailScenario} style={{ maxWidth: '100%' }} onChange={(event) => {
              const next = event.currentTarget.value as BrowsingDetailScenario;
              const url = new URL(location.href);
              url.searchParams.set('detail', next);
              history.replaceState(null, '', url);
              setDetailScenario(next);
            }}>
              <option value="normal">任务内容与关系</option>
              <option value="long">长描述</option>
              <option value="empty">空描述</option>
              <option value="loading">详情加载中</option>
              <option value="error">详情加载失败</option>
            </select>
            <p>两个页签旁的数字均表示未完成任务数，任务链中的共享任务跨链只计一次，显示已完成项不改变数字。任务链状态汇总根及全部后续任务：全部完成才显示已完成，有任务开始或完成后显示进行中，其余显示待处理。未完成前置仍完整显示并阻止开始或直接完成。图的完整投影包含全部上游前置，外部前置保留自身状态，不计入链内进度，也不引入其无关后续。超过 50 个任务或 100 条依赖时先显示根锚定概览，卡片底部控件每次最多展开 20 个直接前置或后续并显示新增任务、依赖和剩余数量；收起到概览恢复初始范围。卡片主体追踪全部前置，隐藏上游去重计数；独立详情入口阅读任务，展开控件分开操作，刷新保留当前实际可见任务。依赖选择及详情不会展开或移动画布。任务链按创建时间倒序排列，分类与已完成项浏览设置按项目保存。点击顶层 Goal 展开子任务列表，每行显示自身状态并直接打开详情；展开区保留 Goal 自身详情入口。列表按完整快照顺序列出其余普通分量成员，包含合流起点并排除链外前置。列表展开与“查看依赖关系”按钮独立，后者打开现有居中依赖图浮层，桌面宽高各占视口 80%，窄屏保留两侧各 12px 安全边距。浮层默认关闭，支持缩放、平移、全屏与任务详情；关闭按钮、遮罩与 Escape 可关闭并恢复原依赖图按钮焦点，保留列表展开状态。Escape 依次处理详情子层、详情全屏、详情、图全屏和图浮层；切换全屏或返回详情保留画布位置。</p>
            {isStatusScenario(scenario) && <p>任务详情的标题行右侧显示当前状态，点击后打开待处理、进行中和已完成三项菜单，概览和附件页均可操作。选择目标后审阅完整任务名、当前状态、目标状态与计时后果，取消或 Escape 不提交。状态可以任意切换；开始和直接完成仍要求前置全部完成，已完成任务有进行中或已完成后继时不可重开。同状态也核对精确版本且不修改时间。状态和自动执行许可共用写入会话，未知结果仅核对读取。当前场景使用超过 JavaScript 安全整数范围的精确版本号。切换场景不会改变其他项目的任务；重新加载页面可重置全部场景。</p>}
            {(scenario === 'pending' || scenario === 'task-switch') && <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="button" type="button" disabled={controls.pending === 0} onClick={() => fixture.settlePending(scenario)}>完成待处理状态响应</button>
              <span>待处理响应：{controls.pending}。可关闭并重开详情检查提交防重；关闭详情后使用此预览控件完成响应。</span>
            </div>}
            {scenario === 'unknown-reconcile-error' && <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="button" type="button" disabled={!controls.taskReadFailure} onClick={() => fixture.recoverReads(scenario)}>恢复任务状态读取</button>
              <span>核查失败后，关闭详情并恢复读取，再重开详情点击“核查任务状态”。</span>
            </div>}
            {scenario === 'graph-refresh-error' && <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="button" type="button" disabled={!controls.graphReadFailure} onClick={() => fixture.recoverReads(scenario)}>恢复任务图读取</button>
              <span>已确认的状态操作结果保持；关闭详情并恢复读取后，使用项目或详情中的刷新按钮更新任务图。</span>
            </div>}
          </section>
          <ProjectPage key={scenario} projectId={browsingProjects[scenario].project.id} />
        </main>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container === null) throw new Error('The browsing mockup root is required.');
const fixture = installBrowsingFixture();
const initial = resolveInitialLocale();
const root = createRoot(container);
root.render(<LocaleProvider initial={initial}><TestTaskCacheBoundary><BrowsingMockup fixture={fixture} /></TestTaskCacheBoundary></LocaleProvider>);
import.meta.hot?.dispose(() => { root.unmount(); fixture(); });
