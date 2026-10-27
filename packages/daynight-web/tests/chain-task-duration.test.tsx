import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphTask, TaskGraph } from '../src/api/types';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskExecutionClockProvider } from '../src/features/task-execution/TaskExecutionClock';
import { ChainList } from '../src/features/task-graph/ChainList';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { renderWithLocale } from './helpers/renderWithLocale';

const start = '2026-10-20T10:00:00Z';
const epoch = Date.parse(start);
const at = (milliseconds: number) => new Date(epoch + milliseconds).toISOString();
const task = (id: string, changes: Partial<GraphTask> = {}): GraphTask => ({
  id, titlePreview: id, titleTruncated: false, status: 'done', dependsOn: ['Goal'], externalDependsOn: [],
  blockedBy: [], ready: false, requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null,
  createdAt: start, updatedAt: start, ...changes,
});
const snapshot = (tasks: readonly GraphTask[], elapsed = 59_000): GraphSnapshot => {
  const graph: TaskGraph = {
    project: { id: 'project', name: 'Project', repoUrl: 'https://example.com/repo', createdAt: start, updatedAt: start,
      settings: { version: 1n, executionWarningMinutes: 1 } },
    observedAt: at(elapsed), tasks: [task('Goal', { dependsOn: [] }), ...tasks],
    summary: { total: tasks.length + 1, todo: tasks.filter((item) => item.status === 'todo').length,
      inProgress: tasks.filter((item) => item.status === 'in_progress').length,
      done: tasks.filter((item) => item.status === 'done').length + 1,
      ready: tasks.filter((item) => item.ready).length, blocked: 0 },
  };
  return { graph, index: buildGraphIndex(graph), observedAt: graph.observedAt, receivedAt: 0, receivedMonotonic: 0, revision: 1 };
};
const noop = () => {};
const content = (value: GraphSnapshot, onOpenTask = noop) => <TaskExecutionClockProvider projectId="project" snapshot={value}>
  <ChainList index={value.index} representativeIds={['Goal']} allRepresentativeIds={['Goal']} openChainId={null}
    onOpenChain={noop} onCloseChain={noop} onOpenTask={onOpenTask} showCompleted onShowCompletedChange={noop} />
</TaskExecutionClockProvider>;
const row = (id: string) => document.getElementById(`chain-task-Goal-${id}`)!;
const duration = (id: string) => row(id).querySelector('time');
const expand = () => fireEvent.click(document.getElementById('task-root-Goal')!);
let monotonic = 0;

beforeEach(() => {
  monotonic = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
});

describe('Goal child execution duration', () => {
  it.each(['en', 'zh-CN'] as const)('shares one running clock and freezes completed rows without changing names, focus or reminder ownership in %s', (locale) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const schedule = vi.spyOn(globalThis, 'setInterval');
    const tasks = [task('manual', { status: 'in_progress', startedAt: start }),
      task('automatic', { status: 'in_progress', allowAgents: true, startedAt: start }),
      task('completed', { startedAt: start, completedAt: at(2_700_000) })];
    const onOpenTask = vi.fn();
    const view = renderWithLocale(content(snapshot(tasks), onOpenTask), { locale });
    expand();
    const running = [row('manual'), row('automatic')];
    const names = locale === 'en' ? ['manualIn progress', 'automaticIn progress'] : ['manual进行中', 'automatic进行中'];
    for (const [index, element] of running.entries()) {
      expect(element).toHaveAccessibleName(names[index]!);
      expect(element.querySelector('time')).toHaveTextContent(locale === 'en' ? '< 1 min' : '不足 1 分钟');
      expect(element.querySelector('time svg')).toHaveAttribute('aria-hidden', 'true');
      expect(element.querySelector('time')!.closest('[aria-hidden="true"]')).not.toBeNull();
    }
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(duration('completed')).toHaveAttribute('datetime', 'PT2700.000S');
    expect(duration('completed')).toHaveTextContent(locale === 'en' ? '45min' : '45 分钟');
    const finalTime = duration('completed');
    running[0]!.focus();
    monotonic = 2_000;
    act(() => { vi.advanceTimersByTime(1_000); });
    for (const [index, element] of running.entries()) {
      expect(element.querySelector('time')).toHaveTextContent(locale === 'en' ? '1min' : '1 分钟');
      expect(element.querySelector('time')).toHaveAttribute('datetime', 'PT61.000S');
      expect(element.querySelector('time')).toHaveAttribute('title', locale === 'en' ? '1min' : '1 分钟');
      expect(element).toHaveAccessibleName(names[index]!);
      expect(element).not.toHaveAttribute('aria-describedby');
      expect(element.querySelector('.task-stuck-label')).toBeNull();
    }
    expect(row('manual')).toBe(running[0]);
    expect(running[0]).toHaveFocus();
    fireEvent.click(running[0]!);
    expect(onOpenTask).toHaveBeenLastCalledWith('manual', running[0]);
    expect(duration('completed')).toBe(finalTime);
    expect(finalTime).toHaveAttribute('datetime', 'PT2700.000S');
    expect(view.container.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
    expect(document.getElementById('task-root-Goal')!.querySelector('time')).toBeNull();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('hides todo and every incomplete interval without inferring timestamps from metadata', () => {
    const value = snapshot([
      task('pending', { status: 'todo', ready: true, startedAt: start }),
      task('unknown-running', { status: 'in_progress' }),
      task('unknown-start', { completedAt: at(2_700_000) }),
      task('unknown-end', { startedAt: start }),
    ]);
    const view = renderWithLocale(content(value), { locale: 'zh-CN' });
    expand();
    expect(view.container.querySelector('time')).toBeNull();
    expect(view.container.querySelectorAll('.goal-task-row')).toHaveLength(4);
  });

  it('reconciles hidden-page elapsed immediately while keeping the completed endpoint and shared ticker', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const view = renderWithLocale(content(snapshot([
      task('running', { status: 'in_progress', startedAt: start }),
      task('completed', { startedAt: start, completedAt: at(2_700_000) }),
    ])), { locale: 'en' });
    expand();
    visibility.mockReturnValue('hidden');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(vi.getTimerCount()).toBe(0);
    monotonic = 122_000;
    expect(duration('running')).toHaveAttribute('datetime', 'PT59.000S');
    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(duration('running')).toHaveAttribute('datetime', 'PT181.000S');
    expect(duration('completed')).toHaveAttribute('datetime', 'PT2700.000S');
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retranslates long durations and follows completion, reset and restart without replacing the task trigger', () => {
    const active = task('active', { status: 'in_progress', startedAt: start, titlePreview: 'A long title '.repeat(20), titleTruncated: true });
    const view = renderWithLocale(content(snapshot([active], 183_840_000)), { locale: 'zh-CN' });
    expand();
    const trigger = row('active');
    trigger.focus();
    expect(trigger.querySelector('.root-title')).toHaveTextContent(`${active.titlePreview}…`);
    expect(duration('active')).toHaveTextContent('2 天 3 小时 4 分钟');
    view.setLocale('en');
    expect(duration('active')).toHaveTextContent('2d 3h 4min');
    view.rerender(content(snapshot([{ ...active, status: 'done', completedAt: at(2_700_000) }], 183_900_000)));
    expect(duration('active')).toHaveAttribute('datetime', 'PT2700.000S');
    view.rerender(content(snapshot([{ ...active, status: 'todo', ready: true, startedAt: null }], 184_000_000)));
    expect(duration('active')).toBeNull();
    view.rerender(content(snapshot([{ ...active, startedAt: at(184_000_000) }], 184_030_000)));
    expect(duration('active')).toHaveAttribute('datetime', 'PT30.000S');
    expect(duration('active')).toHaveTextContent('< 1 min');
    expect(row('active')).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(document.getElementById('task-root-Goal')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /A long title.*In progress/ })).toBe(trigger);
  });
});
