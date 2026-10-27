import { useState } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { GraphTask, TaskGraph } from '../src/api/types';
import { ChainList } from '../src/features/task-graph/ChainList';
import { buildGraphIndex, type GraphIndex } from '../src/features/task-graph/model';
import { createLocaleRender } from './helpers/renderWithLocale';

vi.mock('../src/features/task-graph/TaskGraph', () => ({
  TaskGraph: () => <div>Dependency graph canvas</div>,
}));

const render = createLocaleRender('zh-CN');
const time = '2026-10-20T12:00:00Z';
const task = (id: string, status: GraphTask['status'], dependsOn: readonly string[] = [], externalDependsOn: readonly string[] = []): GraphTask => ({
  id, titlePreview: id, titleTruncated: false, status, dependsOn, externalDependsOn, blockedBy: [], ready: false,
  requiredPlatform: null, allowAgents: false, startedAt: null, completedAt: null, createdAt: time, updatedAt: time,
});
const seeds = [
  task('Goal', 'done'), task('Other root', 'done'), task('Implementation', 'in_progress', ['Goal', 'Other root']),
  task('Acceptance', 'todo', ['Implementation', 'External'], ['External']), task('External', 'done'), task('Standalone', 'todo'),
];
const indexOf = (items = seeds): GraphIndex => {
  const tasks = items.map((item) => {
    const blockedBy = item.dependsOn.filter((id) => items.find((candidate) => candidate.id === id)!.status !== 'done');
    return { ...item, blockedBy, ready: item.status === 'todo' && blockedBy.length === 0 };
  });
  const graph: TaskGraph = {
    observedAt: time,
    project: { id: 'project', name: 'Project', repoUrl: 'https://github.com/example/repo', settings: { version: 1n, executionWarningMinutes: 60 }, createdAt: time, updatedAt: time },
    tasks,
    summary: {
      total: tasks.length, todo: tasks.filter((item) => item.status === 'todo').length,
      inProgress: tasks.filter((item) => item.status === 'in_progress').length, done: tasks.filter((item) => item.status === 'done').length,
      ready: tasks.filter((item) => item.ready).length, blocked: tasks.filter((item) => item.status === 'todo' && !item.ready).length,
    },
  };
  return buildGraphIndex(graph);
};
const noop = () => {};
const list = (index: GraphIndex, onOpenTask = noop) => <ChainList index={index} representativeIds={['Goal']} allRepresentativeIds={['Goal']}
  openChainId={null} onOpenChain={noop} onCloseChain={noop} onOpenTask={onOpenTask} showAll={true} onShowAllChange={noop} />;
const disclosure = () => document.getElementById('task-root-Goal')!;
const children = () => document.getElementById('goal-children-Goal')!;

describe('Goal task lists', () => {
  it('lists every member once across merged roots, with task statuses and no external or standalone context', () => {
    render(list(indexOf()));
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(children()).not.toBeVisible();
    fireEvent.click(disclosure());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure()).toHaveAttribute('aria-controls', children().id);
    const rows = within(children()).getAllByRole('button', { name: /已完成|进行中|待处理/ });
    expect(rows.map((row) => row.querySelector('.root-title')!.textContent)).toEqual(['Implementation', 'Acceptance', 'Other root']);
    expect(rows.map((row) => row.querySelector('.root-status')!.textContent)).toEqual(['进行中', '待处理', '已完成']);
    expect(rows[1]).toHaveTextContent('被阻塞');
    expect(within(children()).queryByText('External')).toBeNull();
    expect(within(children()).queryByText('Standalone')).toBeNull();
    expect(disclosure().querySelector('.root-progress-label')).toHaveTextContent('2/4 已完成');
    expect(children()).toHaveTextContent('子任务 · 3');
    expect(document.querySelector('button button')).toBeNull();
  });

  it('orders children by status while retaining snapshot order within each status', () => {
    const index = indexOf([
      task('Goal', 'done'), task('Done first', 'done', ['Goal']), task('Todo first', 'todo', ['Goal']),
      task('Active first', 'in_progress', ['Goal']), task('Done second', 'done', ['Goal']),
      task('Active second', 'in_progress', ['Goal']), task('Todo second', 'todo', ['Goal']),
    ]);
    const snapshotOrder = [...index.nodes.keys()];
    render(list(index));
    fireEvent.click(disclosure());
    expect([...children().querySelectorAll('.goal-task-row .root-title')].map((title) => title.textContent)).toEqual([
      'Active first', 'Active second', 'Todo first', 'Todo second', 'Done first', 'Done second',
    ]);
    expect([...index.nodes.keys()]).toEqual(snapshotOrder);
  });

  it('opens graphs independently from keyboard disclosure and passes the correct task and trigger to details', async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    const index = indexOf();
    const Wrapper = () => {
      const [openChainId, setOpenChainId] = useState<string | null>(null);
      return <ChainList index={index} representativeIds={['Goal']} allRepresentativeIds={['Goal']}
        openChainId={openChainId} onOpenChain={setOpenChainId} onCloseChain={() => setOpenChainId(null)}
        onOpenTask={onOpenTask} showAll={true} onShowAllChange={noop} />;
    };
    render(<Wrapper />);
    const graph = screen.getByRole('button', { name: 'Goal，查看依赖关系' });
    await user.click(graph);
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(graph).toHaveFocus();
    disclosure().focus();
    await user.keyboard('{Enter}');
    const child = screen.getByRole('button', { name: /Implementation\s*进行中/ });
    await user.click(child);
    expect(onOpenTask).toHaveBeenLastCalledWith('Implementation', child);
    const goalDetails = screen.getByRole('button', { name: 'Goal，查看 Goal 详情' });
    await user.click(goalDetails);
    expect(onOpenTask).toHaveBeenLastCalledWith('Goal', goalDetails);
    await user.click(graph);
    await user.keyboard('{Escape}');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(children()).toBeVisible();
    expect(graph).toHaveFocus();
    disclosure().focus();
    await user.keyboard(' ');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(children()).not.toBeVisible();
  });

  it('refreshes visible members and status while preserving disclosure and restoring focus after removal', () => {
    const view = render(list(indexOf()));
    fireEvent.click(disclosure());
    const removed = screen.getByRole('button', { name: /Acceptance\s*待处理\s*被阻塞/ });
    removed.focus();
    const after = seeds.filter((item) => item.id !== 'Acceptance').map((item) => item.id === 'Implementation' ? { ...item, status: 'done' as const } : item);
    view.rerender(list(indexOf(after)));
    expect(removed.isConnected).toBe(false);
    expect(disclosure()).toHaveFocus();
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(within(children()).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Implementation\s*已完成/ })).toBeVisible();
    expect([...children().querySelectorAll('.goal-task-row .root-title')].map((title) => title.textContent)).toEqual(['Other root', 'Implementation']);
    expect(disclosure().querySelector('.root-progress-label')).toHaveTextContent('3/3 已完成');
  });

  it('retranslates expanded controls and renders long titles as text without changing disclosure', () => {
    const titlePreview = '<img src=x onerror=alert(1)>'.repeat(8);
    const items = seeds.map((item) => item.id === 'Implementation' ? { ...item, titlePreview, titleTruncated: true } : item);
    const view = render(list(indexOf(items)));
    fireEvent.click(disclosure());
    expect(within(children()).getByText(`${titlePreview}…`)).toBeVisible();
    expect(view.container.querySelector('img')).toBeNull();
    view.setLocale('en');
    expect(disclosure()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Goal, View dependencies' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Goal, View Goal details' })).toBeVisible();
    expect(children()).toHaveTextContent('Tasks · 3');
    expect(within(children()).getAllByText('Done')).toHaveLength(1);
  });
});
