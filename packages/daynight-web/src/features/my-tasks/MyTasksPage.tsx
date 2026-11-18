import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { PersonalTaskItem } from '../../api/personal-tasks';
import type { MyTasksReading } from '../../app/page-history';
import { useMyTasksHistory } from '../../app/use-page-history';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import { MyTasksDetailHost } from './MyTasksDetailHost';
import { useI18n } from '../../i18n/LocaleProvider';
import { ListPagination } from '../projects/ListPagination';
import { usePagination } from '../projects/usePagination';
import { PersonalTaskRow, type OpenPersonalDetail } from './PersonalTaskRow';
import { PersonalTaskObservations } from './PersonalTaskObservations';
import { useMyTasks } from './useMyTasks';
import './my-tasks.css';

const messages = {
  en: {
    title: 'In-progress tasks', subtitle: 'Tasks assigned to you across all your projects.', refresh: 'Refresh',
    loading: 'Loading tasks…', empty: 'No in-progress tasks', emptyDetail: 'Tasks assigned to you will appear here when they are in progress.',
    failed: 'Tasks could not be updated.', retained: 'Showing the last available results.', incomplete: 'The task list is incomplete; counts cannot be confirmed.',
    retry: 'Retry', personal: 'Personal', sessionPartial: 'Some Session observations are unavailable.',
    count: (count: string) => `${count} in progress`, loadedCount: (count: string) => `${count} loaded`,
    total: (tasks: string, projects: string) => `Tasks: ${tasks} · Projects: ${projects}`,
  },
  'zh-CN': {
    title: '进行中的任务', subtitle: '查看分配给你的所有项目中的任务。', refresh: '刷新',
    loading: '正在加载任务…', empty: '没有进行中的任务', emptyDetail: '分配给你的任务进入进行中后会显示在这里。',
    failed: '无法更新任务。', retained: '显示上次可用的结果。', incomplete: '任务列表不完整，无法确认数量。',
    retry: '重试', personal: '个人空间', sessionPartial: '部分 Session 观测暂不可用。',
    count: (count: string) => `${count} 个进行中`, loadedCount: (count: string) => `已加载 ${count} 个`,
    total: (tasks: string, projects: string) => `${tasks} 个任务 · ${projects} 个项目`,
  },
} as const;

const ProjectGroup = ({ items, complete, ambiguous, savedPage, savePage, open, active }: { readonly open: OpenPersonalDetail; readonly active: boolean; readonly items: readonly PersonalTaskItem[]; readonly complete: boolean; readonly ambiguous: boolean; readonly savedPage: number; readonly savePage: (page: number) => void }) => {
  const { locale, format } = useI18n();
  const m = messages[locale];
  const first = items[0]!;
  const pagination = usePagination(items.length, 15);
  const selectedPage = Math.min(savedPage, pagination.pageCount);
  useLayoutEffect(() => {
    if (selectedPage !== pagination.page) pagination.onPageChange(selectedPage);
    if (complete && selectedPage !== savedPage) savePage(selectedPage);
  }, [complete, selectedPage, savedPage, pagination.page, pagination.onPageChange, savePage]);
  const scope = first.project.ownerTeam.kind === 'personal' ? m.personal : first.project.ownerTeam.name!;
  const label = `${first.project.name} · ${scope} · ${first.project.id}`;
  return <section className="my-task-group" aria-label={label}>
    <header className="my-task-group-heading"><h2 id={`my-task-group-${first.project.id}`} tabIndex={-1}>{first.project.name}</h2><span className="my-task-scope">{scope}</span>{ambiguous && <span className="my-task-project-id" title={first.project.id}>{first.project.id}</span>}<span className="my-task-count">{complete ? m.count(format.number(first.project.matchedTaskCount)) : m.loadedCount(format.number(items.length))}</span></header>
    <ul className="my-task-list">{items.slice(pagination.start - 1, pagination.end).map(item => <PersonalTaskRow key={item.task.id} item={item} open={open} active={active} />)}</ul>
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
  const open: OpenPersonalDetail = (projectId, id, source, tab) => {
    trigger.current = source;
    triggerProject.current = projectId;
    history.select({ ...selection, detail: { projectId, id, navigation: { tab, path: null }, goalChildren: null } });
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
    <div className="page-heading"><div><h1 ref={heading} tabIndex={-1}>{m.title}</h1><p className="subtitle">{m.subtitle}</p>{complete && <p className="my-task-total">{m.total(format.number(state.totalTaskCount!), format.number(state.totalProjectCount!))}</p>}</div><button className="button" type="button" disabled={!readEnabled} onClick={state.refresh}>{m.refresh}</button></div>
    {history.error && <div className="notice error" role="alert">{locale === 'zh-CN' ? '页面导航状态无效。' : 'Invalid page navigation state.'}</div>}
    {state.error !== null && <div className="notice error" role="alert"><p>{m.failed} {state.items.length > 0 && m.retained}</p><button className="button" type="button" disabled={!readEnabled} onClick={state.refresh}>{m.retry}</button></div>}
    {!complete && (state.items.length > 0 || !state.loading && state.error === null) && <div className="notice warning" role="status">{m.incomplete}</div>}
    {state.sessionPartial && <div className="notice warning" role="status">{m.sessionPartial}</div>}
    {groups.length > 0 ? <PersonalTaskObservations items={state.items}><div className="my-task-groups">{groups.map(items => {
      const id = items[0]!.project.id;
      return <ProjectGroup key={id} items={items} complete={complete} ambiguous={isAmbiguous(items[0]!)} savedPage={selection.projectPages[id] ?? 1} savePage={page => { if (selection.projectPages[id] !== page) history.select({ ...selection, projectPages: { ...selection.projectPages, [id]: page } }, true); }} open={open} active={readEnabled} />;
    })}</div></PersonalTaskObservations>
      : state.loading ? <div className="state-box" role="status"><div className="spinner" aria-hidden="true" /><p>{m.loading}</p></div>
        : complete ? <div className="state-box"><h2>{m.empty}</h2><p>{m.emptyDetail}</p></div> : null}
    {!history.error && selection.detail !== null && <MyTasksDetailHost key={selection.detail.projectId} detail={selection.detail} select={selectDetail} refreshList={state.refresh} restoreFocus={restoreFocus} />}
  </div>;
};
