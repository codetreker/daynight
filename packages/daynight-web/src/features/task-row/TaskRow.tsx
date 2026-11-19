import { usageCompactMetric, UsageSummaryView, usageWords } from '../usage/UsageSummaryView';
import { useTaskUsage } from '../usage/useTaskUsage';
import { navigate, taskDetailUrl } from '../../app/router';
import { memo, useCallback, useId, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { completedAtFor } from '../task-completion/model';
import { useCompletionTime } from '../task-completion/useCompletionTime';
import { useCompletionHint } from '../task-completion/useCompletionHint';
import { CompletionTimeLabel } from '../task-completion/CompletionTimeLabel';
import { TaskAgentPermissionBadge } from './TaskAgentPermissionBadge';
import { TaskPlatformBadge } from './TaskPlatformBadge';
import { useTaskExecution } from '../task-execution/TaskExecutionClock';
import { TaskExecutionDescription, TaskExecutionDuration, TaskExecutionWarning } from '../task-execution/TaskExecutionPresentation';
import { TaskPausedBadge } from '../task-pause/TaskPause';
import { TaskSessionStatus } from './TaskSessionStatus';
import { TaskTagList } from '../task-tags/TaskTagList';
import { TagColorFeedback } from '../task-tags/TagColor';
import { ValueCopyButton } from '../../ui/copy-button/ValueCopyButton';
import type { TaskRowModel } from './model';
import '../../styles/graph.css';
import '../../styles/task-status-rows.css';
import './task-row.css';

export type { TaskRowModel } from './model';

type TaskRowProps = {
  readonly model: TaskRowModel;
  readonly projectId: string;
  readonly tagsActive?: boolean;
  readonly href: string;
  readonly instanceId: string;
  readonly assignee: ReactNode;
  readonly goal?: { readonly title: string; readonly href: string; readonly onOpen: (trigger: HTMLElement) => void };
  readonly onOpenTask: (id: string, trigger: HTMLElement) => void;
  readonly onOpenSession?: (id: string, trigger: HTMLElement) => void;
};

export const TaskRow = memo(({ model, projectId, tagsActive = true, href, instanceId, assignee, goal, onOpenTask, onOpenSession }: TaskRowProps) => {
  const { locale, messages: { workspace: { standalone, project }, common, graph, inspection: { detail } }, format } = useI18n();
  const usage = useTaskUsage(projectId, model.id, tagsActive);
  const usageSummary = usage.summary !== null && usageCompactMetric(usage.summary) !== null ? usage.summary : null;
  const usageHref = taskDetailUrl(projectId, model.id, { tab: 'usage', path: null });
  const execution = useTaskExecution(model);
  const completion = useCompletionTime(completedAtFor(model));
  const hint = useCompletionHint(completion);
  const labelId = useId();
  const titleRef = useRef<HTMLAnchorElement | null>(null);
  const setTitleRef = useCallback((element: HTMLAnchorElement | null) => { titleRef.current = element; hint.triggerRef(element); }, [hint.triggerRef]);
  const rowRef = useRef<HTMLLIElement | null>(null);
  const focusIdentity = JSON.stringify([projectId, model.id, instanceId]);
  const currentIdentity = useRef(focusIdentity);
  currentIdentity.current = focusIdentity;
  const focusedControl = useRef<{ element: HTMLElement; identity: string } | null>(null);
  const pointer = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
  const restoreFocus = useCallback(() => {
    const control = focusedControl.current;
    if (control === null) return;
    if (control.identity !== currentIdentity.current) { focusedControl.current = null; return; }
    if (control.element.isConnected) return;
    focusedControl.current = null;
    if (document.activeElement === document.body && titleRef.current?.isConnected && titleRef.current.closest('[hidden], [inert]') === null)
      titleRef.current.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(restoreFocus);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    // Feedback owns its own subscription, so its Retry button can disappear
    // without rendering this row again.
    const observer = new MutationObserver(restoreFocus);
    observer.observe(row, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [restoreFocus]);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
    const selection = window.getSelection();
    if (event.detail > 0 && (pointer.current?.dragged || selection !== null && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(event.currentTarget.closest('.task-row')!))) { event.preventDefault(); return; }
    hint.triggerEvents.onClick();
    event.preventDefault();
    onOpenTask(model.id, event.currentTarget);
  };
  const openBlank = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented || pointer.current?.dragged) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest('a, button, input, select, textarea, [data-task-row-selectable]') !== null) return;
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(event.currentTarget)) return;
    if (titleRef.current !== null) onOpenTask(model.id, titleRef.current);
  };
  const worker = (model.worker.kind === 'active' || model.worker.kind === 'historical') && model.worker.currentName !== undefined && model.worker.currentName !== model.worker.name ? graph.currentWorkerName({ name: model.worker.currentName })
    : model.worker.kind === 'active' ? graph.claimMachine({ name: model.worker.name })
    : model.worker.kind === 'historical' ? graph.recordedMachine({ name: model.worker.name })
      : model.worker.kind === 'none' ? graph.noMachineRecord
        : model.worker.kind === 'unknown' ? locale === 'zh-CN' ? 'Worker 记录未知' : 'Worker record unknown'
          : locale === 'zh-CN' ? 'Worker 记录读取失败' : 'Worker record unavailable';
  const tagMessage = model.tags === 'unknown' ? locale === 'zh-CN' ? '标签未知' : 'Tags unknown'
    : model.tags === 'error' ? locale === 'zh-CN' ? '标签读取失败' : 'Tags unavailable' : null;
  const descriptionIds = [execution === null ? null : `${labelId}-execution`, completion === null ? null : hint.descriptionId].filter(Boolean).join(' ') || undefined;
  return <li ref={rowRef} className="task-row-item" onFocusCapture={(event) => {
    const target = event.target;
    focusedControl.current = target instanceof HTMLElement && (target.classList.contains('session-status-action') || target.matches('.task-tag-color-feedback button'))
      ? { element: target, identity: focusIdentity } : null;
  }} onBlurCapture={(event) => { if (event.relatedTarget !== null && event.relatedTarget !== document.body) focusedControl.current = null; }}>
    <div className={`task-row task-status-surface${execution?.overdue ? ' standalone-row-stuck' : ''}`} data-task-status={model.status}
      onPointerDown={(event) => { if (event.button === 0) pointer.current = { x: event.clientX, y: event.clientY, dragged: false }; }}
      onPointerMove={(event) => { if (pointer.current !== null && (Math.abs(event.clientX - pointer.current.x) > 3 || Math.abs(event.clientY - pointer.current.y) > 3)) pointer.current.dragged = true; }}
      onClick={openBlank}>
      <div className="task-row-content">
        <div className="task-row-heading">
          <a className="task-row-title" href={href} id={instanceId} ref={setTitleRef} {...hint.triggerEvents} aria-haspopup="dialog" aria-describedby={descriptionIds} onClick={open}>{model.title}</a>
          <span className="task-row-id-group"><span className="task-row-id" data-task-row-selectable>{model.id}</span><ValueCopyButton key={model.id} value={model.id} label={detail.copyTaskId} feedback={(state) => state === 'copied' ? <span className="task-row-copy-feedback" role="status">{detail.copied}</span> : state === 'failed' ? <span className="task-row-copy-feedback task-row-copy-error" role="alert">{detail.copyFailed}</span> : null} /></span>
        </div>
        <div className="task-row-meta">
          <time dateTime={model.createdAt}>{standalone.createdOn({ date: format.date(model.createdAt) })}</time>
          {assignee}<TaskPlatformBadge requiredPlatform={model.requiredPlatform} /><TaskAgentPermissionBadge allowAgents={model.allowAgents} />
          <span className="task-row-machine">{worker}</span>
          {execution !== null ? <span className="task-row-execution"><TaskExecutionDuration execution={execution} />{execution.overdue && <TaskExecutionWarning />}</span>
            : model.status === 'in_progress' && <span>{locale === 'zh-CN' ? '耗时未知' : 'Duration unknown'}</span>}
          {completion !== null && <CompletionTimeLabel value={completion} {...hint.labelEvents} />}
          {goal !== undefined && <a className="task-row-goal" href={goal.href} aria-label={locale === 'zh-CN' ? `查看 Goal：${goal.title}` : `View Goal: ${goal.title}`} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.defaultPrevented) return;
            event.preventDefault(); goal.onOpen(event.currentTarget);
          }}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3" /><circle cx="8" cy="8" r=".6" /></svg><span>{goal.title}</span><span aria-hidden="true">↗</span></a>}
        </div>
        {usageSummary !== null && <section className="task-usage-summary" aria-label={usageWords(locale === 'zh-CN').title} data-task-row-selectable>
          <a className="usage-summary-link" href={usageHref} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault(); navigate(usageHref);
          }}><UsageSummaryView summary={usageSummary} compact /></a>
        </section>}
        {typeof model.tags === 'string' ? <span className="task-row-meta task-row-tag-state">{tagMessage}</span> : <TaskTagList projectId={projectId} tags={model.tags} active={tagsActive} feedback={false} />}
      </div>
      <div className="task-row-status">
        {model.paused && <TaskPausedBadge />}
        <TaskSessionStatus title={model.title} status={model.status} observation={model.session} allowAgents={model.allowAgents} showTaskStatus={false}
          {...(onOpenSession === undefined ? {} : { onActivate: (event: MouseEvent<HTMLButtonElement>) => onOpenSession(model.id, event.currentTarget) })} />
        <span className={`root-status graph-status-${model.status}`}>{common.status[model.status]}</span>
        {model.ready && <span className="task-ready">{project.ready}</span>}
        {model.blocked && <span className="graph-blocked-badge">{project.blocked}</span>}
      </div>
      {execution !== null && <TaskExecutionDescription execution={execution} id={`${labelId}-execution`} />}
      {hint.hint}
    </div>
    {tagsActive && typeof model.tags !== 'string' && model.tags.length > 0 && <TagColorFeedback projectId={projectId} ids={model.tags.map(tag => tag.id)} />}
  </li>;
});
