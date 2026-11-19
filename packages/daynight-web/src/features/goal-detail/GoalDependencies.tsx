import { useId, useLayoutEffect, useRef, type MouseEvent, type RefObject } from 'react';
import type { RelatedGoal } from '../../api/goal-dependencies';
import { ApiError } from '../../api/client';
import { browserNavigation } from '../../app/navigation';
import { emptyResourceReading, resourceHistory } from '../../app/page-history';
import { parseRoute, taskDetailUrl } from '../../app/router';
import { useI18n } from '../../i18n/LocaleProvider';
import { useTaskCacheScope } from '../task-cache/TaskCacheProvider';
import type { useGoalDependencies } from './useGoalDependencies';
import { finishGoalDependencyReturn, goalDependencyReturn, markGoalDependencyDeparture, rememberGoalDependencyReading } from './goal-dependency-reading';
import './goal-dependencies.css';

const hrefFor = (goal: RelatedGoal) => taskDetailUrl(goal.projectId, goal.goalId, { tab: 'description', path: null });

export const GoalDependencies = ({ dependencies, canComplete, refusal, fallbackFocus }: {
  readonly dependencies: ReturnType<typeof useGoalDependencies>; readonly canComplete: boolean; readonly refusal: unknown;
  readonly fallbackFocus: RefObject<HTMLElement | null>;
}) => {
  const { locale, messages } = useI18n(), scope = useTaskCacheScope();
  const zh = locale === 'zh-CN';
  const root = useRef<HTMLElement>(null), headingId = useId();
  const { page, pending, error, unavailable } = dependencies;
  const navigation = browserNavigation(), entryId = navigation.snapshot().entryId;
  useLayoutEffect(() => navigation.subscribe(() => {
    const destination = navigation.snapshot();
    if (entryId !== null && destination.entryId !== entryId) {
      markGoalDependencyDeparture(scope, entryId, `${destination.pathname}${destination.search}${destination.hash}`);
    }
  }), [scope, navigation, entryId]);
  useLayoutEffect(() => {
    if (entryId === null || page === null && !unavailable) return;
    const reading = goalDependencyReturn(scope, entryId, dependencies.position);
    if (reading === null || dependencies.position.cursor !== reading.position.cursor) return;
    queueMicrotask(() => {
      if (scope.signal.aborted || scope.hasIdentityMismatch || navigation.snapshot().entryId !== entryId || document.visibilityState === 'hidden') return;
      if (!finishGoalDependencyReturn(scope, entryId, reading)) return;
      const link = [...root.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []].find(item => item.getAttribute('href') === reading.href);
      (link ?? fallbackFocus.current)?.focus();
    });
  }, [scope, entryId, navigation, page, unavailable, fallbackFocus, dependencies.position]);
  const follow = (event: MouseEvent<HTMLAnchorElement>, target: RelatedGoal) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (entryId !== null) {
      rememberGoalDependencyReading(scope, entryId, dependencies.position, event.currentTarget.getAttribute('href')!);
    }
    const location = navigation.snapshot(), current = parseRoute(location.pathname, location.search);
    const href = event.currentTarget.getAttribute('href')!;
    if ((current.kind === 'task' || current.kind === 'attachment') && current.projectId === target.projectId && current.taskId === target.goalId) {
      navigation.setView(resourceHistory(scope.userId, target.projectId, target.goalId, emptyResourceReading()), { to: href });
    } else navigation.navigate(href);
  };
  const relation = (goal: RelatedGoal, key: string) => <li key={key}>
    <div><a href={hrefFor(goal)} onClick={event => follow(event, goal)}>{goal.title}</a><span className="goal-dependency-context">{goal.kind === 'internal' ? (zh ? '项目内' : 'Same project') : `${zh ? '外部' : 'External'} · ${goal.projectName}`}</span></div>
    <span className={`goal-dependency-status goal-dependency-status-${goal.status}`}>{messages.common.status[goal.status]}</span>
  </li>;
  const refused = refusal instanceof ApiError && refusal.code === 'goal_dependency_unsatisfied';
  const empty = zh ? '无关联 Goal' : 'No related Goals';
  return <section ref={root} className="goal-information-section goal-dependencies" aria-labelledby={headingId}>
    <h3 id={headingId}>{zh ? 'Goal 验收依赖' : 'Goal acceptance dependencies'}</h3>
    {refused ? <p className="goal-dependency-notice goal-dependency-error" role="alert">{zh ? '无法完成。仍有前置 Goal 未完成。' : 'Cannot complete this Goal. A prerequisite Goal is unfinished.'}</p>
      : canComplete && page?.completionBlocked === true && <p className="goal-dependency-notice goal-dependency-blocked">{zh ? '完成受阻。仍有前置 Goal 未完成。' : 'Completion blocked. A prerequisite Goal is unfinished.'}</p>}
    {unavailable && <p>{zh ? '服务器暂不支持 Goal 依赖查看。' : 'This server does not support Goal dependencies yet.'}</p>}
    {error != null && <div className="goal-dependency-notice goal-dependency-error" role="alert"><p>{page === null
      ? (zh ? '无法读取 Goal 依赖。' : 'Could not load Goal dependencies.')
      : (zh ? '无法刷新 Goal 依赖，正在显示上次读取的关系。' : 'Could not refresh Goal dependencies. Showing the last loaded relationships.')}</p>
      <button className="button" type="button" onClick={dependencies.refresh} disabled={pending}>{zh ? '重试' : 'Retry'}</button></div>}
    {page === null && error === null && !unavailable && <p role="status">{zh ? '正在读取 Goal 依赖…' : 'Loading Goal dependencies…'}</p>}
    {page !== null && <>
      <section><h4>{zh ? '前置 Goal' : 'Prerequisite Goals'}</h4>{page.prerequisites.length === 0 ? <p className="goal-dependency-empty">{empty}</p>
        : <ul>{page.prerequisites.map((item, index) => item.target === null
          ? <li key={item.edgeId ?? `hidden-${index}`}><span>{zh ? '无法访问此 Goal' : 'You cannot access this Goal'}</span></li>
          : relation(item.target, item.edgeId ?? item.target.goalId))}</ul>}</section>
      <section><h4>{zh ? '下游 Goal' : 'Dependent Goals'}</h4>{page.successors.length === 0 ? <p className="goal-dependency-empty">{empty}</p>
        : <ul>{page.successors.map(item => relation(item, item.goalId))}</ul>}
        {(dependencies.hasPrevious || page.nextCursor !== null) && <nav className="goal-dependency-pagination" aria-label={zh ? '下游 Goal 分页' : 'Dependent Goal pages'}>
          <button type="button" className="button" disabled={!dependencies.hasPrevious || pending} onClick={dependencies.previous}>{zh ? '上一页' : 'Previous'}</button>
          <button type="button" className="button" disabled={page.nextCursor === null || pending} onClick={dependencies.next}>{zh ? '下一页' : 'Next'}</button>
        </nav>}
      </section>
    </>}
  </section>;
};
