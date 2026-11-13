import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import type { PersonalTaskItem } from '../../api/personal-tasks';
import { taskDetailUrl } from '../../app/router';
import type { MyTasksReading } from '../../app/page-history';
import { useMyTasksHistory } from '../../app/use-page-history';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { MyTasksDetailHost } from './MyTasksDetailHost';
import { useI18n } from '../../i18n/LocaleProvider';
import { ListPagination } from '../projects/ListPagination';
import { usePagination } from '../projects/usePagination';
import { ClockInputProvider, useTaskExecution, useTaskExecutionClock } from '../task-execution/TaskExecutionClock';
import { TaskExecutionDuration, TaskExecutionWarning } from '../task-execution/TaskExecutionPresentation';
import { TaskPausedBadge } from '../task-pause/TaskPause';
import { useMyTasks } from './useMyTasks';
import './my-tasks.css';

const messages = {
  en: {
    eyebrow: 'MINE', title: 'In-progress tasks', subtitle: 'Tasks assigned to you across all your projects.', refresh: 'Refresh',
    loading: 'Loading tasks…', empty: 'No in-progress tasks', emptyDetail: 'Tasks assigned to you will appear here when they are in progress.',
    failed: 'Tasks could not be updated.', retained: 'Showing the last available results.', incomplete: 'The task list is incomplete; counts cannot be confirmed.',
    retry: 'Retry', personal: 'Personal', goal: (title: string) => `View Goal: ${title}`, unknownDuration: 'Execution time unknown',
    sessionPartial: 'Some Session observations are unavailable.', noSession: 'No Session', notRegistered: 'Session not registered',
    unavailable: 'Session status unavailable', expired: 'Session observation expired', working: 'Session is working',
    notice: 'Session needs a response', warning: 'Session needs checking', attention: 'Needs attention',
    count: (count: string) => `${count} in progress`, loadedCount: (count: string) => `${count} loaded`,
    total: (tasks: string, projects: string) => `Tasks: ${tasks} · Projects: ${projects}`,
  },
  'zh-CN': {
    eyebrow: '我的', title: '进行中的任务', subtitle: '查看分配给你的所有项目中的任务。', refresh: '刷新',
    loading: '正在加载任务…', empty: '没有进行中的任务', emptyDetail: '分配给你的任务进入进行中后会显示在这里。',
    failed: '无法更新任务。', retained: '显示上次可用的结果。', incomplete: '任务列表不完整，无法确认数量。',
    retry: '重试', personal: '个人空间', goal: (title: string) => `查看 Goal：${title}`, unknownDuration: '执行耗时未知',
    sessionPartial: '部分 Session 观测暂不可用。', noSession: '没有 Session', notRegistered: 'Session 尚未注册',
    unavailable: 'Session 状态暂不可用', expired: 'Session 观测已过期', working: '会话工作中',
    notice: '会话需要响应', warning: '会话需要检查', attention: '需要关注',
    count: (count: string) => `${count} 个进行中`, loadedCount: (count: string) => `已加载 ${count} 个`,
    total: (tasks: string, projects: string) => `${tasks} 个任务 · ${projects} 个项目`,
  },
} as const;

const inactive = () => () => {};
const noSnapshot = () => null;

const Session = ({ item }: { readonly item: PersonalTaskItem }) => {
  const { locale } = useI18n();
  const m = messages[locale];
  const clock = useTaskExecutionClock();
  // Subscribe even when the task has no start time: Session observations still expire.
  useSyncExternalStore(clock?.subscribeRunning ?? inactive, clock?.getSnapshot ?? noSnapshot, clock?.getSnapshot ?? noSnapshot);
  const s = item.session;
  const now = Date.parse(item.observedAt) + (performance.now() - item.receivedMonotonic);
  const expired = s.freshUntil === null || now >= Date.parse(s.freshUntil);
  const state = s.observation !== 'observed' || s.error !== null ? 'unavailable'
    : expired ? 'expired'
      : s.registration === 'not_applicable' && s.reason === 'no_execution' ? 'noSession'
        : s.registration === 'not_registered' ? 'notRegistered'
          : s.registration !== 'registered' ? 'unavailable'
            : s.indicator ?? (s.connectionState === 'disconnected' || s.lifecycle === 'archived' ? 'warning' : 'unavailable');
  return <span className={`my-task-session my-task-session-${state}`}><span className="my-task-session-dot" aria-hidden="true" />{m[state]}{s.needsAttention === true && state !== 'expired' && state !== 'unavailable' && <> · {m.attention}</>}</span>;
};

type OpenDetail = (event: MouseEvent<HTMLAnchorElement>, projectId: string, id: string) => void;

const TaskRow = ({ item, open }: { readonly item: PersonalTaskItem; readonly open: OpenDetail }) => {
  const { locale, messages: { common } } = useI18n();
  const m = messages[locale];
  const { task, project } = item;
  const execution = useTaskExecution({ status: task.status, allowAgents: task.allowAgents, startedAt: task.startedAt, completedAt: null, cancelledAt: null });
  const href = (id: string) => taskDetailUrl(project.id, id, { tab: 'overview', path: null });
  return <li className="my-task-row">
    <div className="my-task-main"><a className="my-task-title" href={href(task.id)} onClick={event => open(event, project.id, task.id)}>{task.title}</a>
      <div className="my-task-meta"><span className="my-task-id">{task.id.slice(0, 8)}</span>
        {execution === null ? <span>{m.unknownDuration}</span> : <><TaskExecutionDuration execution={execution} />{execution.overdue && <TaskExecutionWarning />}</>}
        {task.goal !== null && <a className="my-task-goal" href={href(task.goal.id)} onClick={event => open(event, project.id, task.goal!.id)} aria-label={m.goal(task.goal.title)}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r=".6" /></svg><span>{task.goal.title}</span><span aria-hidden="true">↗</span></a>}
      </div>
    </div>
    <div className="my-task-state"><span className="root-status graph-status-in_progress">{common.status.in_progress}</span>{task.paused && <TaskPausedBadge />}<Session item={item} /></div>
  </li>;
};

const ProjectGroup = ({ items, complete, ambiguous, savedPage, savePage, open }: { readonly open: OpenDetail; readonly items: readonly PersonalTaskItem[]; readonly complete: boolean; readonly ambiguous: boolean; readonly savedPage: number; readonly savePage: (page: number) => void }) => {
  const { locale, format } = useI18n();
  const m = messages[locale];
  const first = items[0]!;
  const pagination = usePagination(items.length, 15);
  const selectedPage = Math.min(savedPage, pagination.pageCount);
  useLayoutEffect(() => {
    if (selectedPage !== pagination.page) pagination.onPageChange(selectedPage);
    if (complete && selectedPage !== savedPage) savePage(selectedPage);
  }, [complete, selectedPage, savedPage, pagination.page, pagination.onPageChange, savePage]);
  const input = useMemo(() => ({ observedAt: first.observedAt, receivedMonotonic: first.receivedMonotonic, warningMinutes: first.project.executionWarningMinutes }), [first.observedAt, first.receivedMonotonic, first.project.executionWarningMinutes]);
  const scope = first.project.ownerTeam.kind === 'personal' ? m.personal : first.project.ownerTeam.name!;
  const label = `${first.project.name} · ${scope} · ${first.project.id}`;
  return <section className="my-task-group" aria-label={label}>
    <header className="my-task-group-heading"><h2 id={`my-task-group-${first.project.id}`} tabIndex={-1}>{first.project.name}</h2><span className="my-task-scope">{scope}</span>{ambiguous && <span className="my-task-project-id" title={first.project.id}>{first.project.id}</span>}<span className="my-task-count">{complete ? m.count(format.number(first.project.matchedTaskCount)) : m.loadedCount(format.number(items.length))}</span></header>
    <ClockInputProvider input={input}><ul className="my-task-list">{items.slice(pagination.start - 1, pagination.end).map(item => <TaskRow key={item.task.id} item={item} open={open} />)}</ul></ClockInputProvider>
    <ListPagination label={label} {...pagination} onPageChange={savePage} />
  </section>;
};

export const MyTasksPage = ({ readEnabled = true }: { readonly readEnabled?: boolean }) => {
  const { locale, format } = useI18n();
  const m = messages[locale];
  const state = useMyTasks(readEnabled);
  const scope = useTaskCacheScope();
  const history = useMyTasksHistory(scope.userId, true, scope);
  const { selection } = history;
  const trigger = useRef<HTMLElement | null>(null);
  const triggerProject = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const open: OpenDetail = (event, projectId, id) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
    event.preventDefault();
    trigger.current = event.currentTarget;
    triggerProject.current = projectId;
    history.select({ ...selection, detail: { projectId, id, navigation: { tab: 'overview', path: null }, goalChildren: null } });
  };
  const restoreFocus = useCallback(() => {
    const source = trigger.current;
    if (source?.isConnected && !source.closest('[hidden], [inert]')) source.focus({ preventScroll: true });
    else {
      const group = triggerProject.current === null ? null : document.getElementById(`my-task-group-${triggerProject.current}`);
      (group ?? heading.current)?.focus({ preventScroll: true });
    }
  }, []);
  const selectDetail = (detail: MyTasksReading['detail'], replace = false) => history.select({ ...selection, detail }, replace);
  const groups = useMemo(() => {
    const result = new Map<string, PersonalTaskItem[]>();
    for (const item of state.items) {
      const group = result.get(item.project.id);
      if (group === undefined) result.set(item.project.id, [item]); else group.push(item);
    }
    return [...result.values()];
  }, [state.items]);
  const isAmbiguous = (item: PersonalTaskItem) => groups.some(group => group[0]!.project.id !== item.project.id && group[0]!.project.name === item.project.name && group[0]!.project.ownerTeam.kind === item.project.ownerTeam.kind && group[0]!.project.ownerTeam.name === item.project.ownerTeam.name);
  const complete = state.totalTaskCount !== null && state.totalProjectCount !== null;
  return <div className="my-tasks-page">
    <div className="page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 ref={heading} tabIndex={-1}>{m.title}</h1><p className="subtitle">{m.subtitle}</p>{complete && <p className="my-task-total">{m.total(format.number(state.totalTaskCount!), format.number(state.totalProjectCount!))}</p>}</div><button className="button" type="button" disabled={!readEnabled} onClick={state.refresh}>{m.refresh}</button></div>
    {history.error && <div className="notice error" role="alert">{locale === 'zh-CN' ? '页面导航状态无效。' : 'Invalid page navigation state.'}</div>}
    {state.error !== null && <div className="notice error" role="alert"><p>{m.failed} {state.items.length > 0 && m.retained}</p><button className="button" type="button" disabled={!readEnabled} onClick={state.refresh}>{m.retry}</button></div>}
    {!complete && (state.items.length > 0 || !state.loading && state.error === null) && <div className="notice warning" role="status">{m.incomplete}</div>}
    {state.sessionPartial && <div className="notice warning" role="status">{m.sessionPartial}</div>}
    {groups.length > 0 ? <div className="my-task-groups">{groups.map(items => {
      const id = items[0]!.project.id;
      return <ProjectGroup key={id} items={items} complete={complete} ambiguous={isAmbiguous(items[0]!)} savedPage={selection.projectPages[id] ?? 1} savePage={page => { if (selection.projectPages[id] !== page) history.select({ ...selection, projectPages: { ...selection.projectPages, [id]: page } }, true); }} open={open} />;
    })}</div>
      : state.loading ? <div className="state-box" role="status"><div className="spinner" aria-hidden="true" /><p>{m.loading}</p></div>
        : complete ? <div className="state-box"><h2>{m.empty}</h2><p>{m.emptyDetail}</p></div> : null}
    {!history.error && selection.detail !== null && <MyTasksDetailHost key={selection.detail.projectId} detail={selection.detail} select={selectDetail} refreshList={state.refresh} restoreFocus={restoreFocus} />}
  </div>;
};
