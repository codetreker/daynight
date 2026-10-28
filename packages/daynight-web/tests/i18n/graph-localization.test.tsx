import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskGraph as GraphData } from '../../src/api/types';
import { ChainList } from '../../src/features/task-graph/ChainList';
import { TaskGraph } from '../../src/features/task-graph/TaskGraph';
import { TaskChainDialog } from '../../src/features/task-graph/TaskChainDialog';
import { buildGraphIndex } from '../../src/features/task-graph/model';
import * as layoutModule from '../../src/features/task-graph/layout';
import { LanguageSelector } from '../../src/i18n/LanguageSelector';
import { messagesByLocale } from '../../src/i18n/messages';
import { renderWithLocale } from '../helpers/renderWithLocale';
import { browsingProjects } from '../mockups/browsing-fixture';
import { installGraphMeasurements } from '../graph-measurements';

const time = '2026-10-20T00:00:00Z';
const graph: GraphData = { observedAt: "2026-10-20T12:00:00Z",
  project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: 'project', name: '项目', repoUrl: 'https://github.com/example/repo', createdAt: time, updatedAt: time },
  summary: { total: 5, todo: 2, inProgress: 1, done: 2, ready: 1, blocked: 1 },
  tasks: [
    { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'A', titlePreview: '基础 API', titleTruncated: false, status: 'done', dependsOn: [], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'B', titlePreview: '设计方案', titleTruncated: false, status: 'done', dependsOn: [], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: ['B'], startedAt: null, completedAt: null, id: 'C', titlePreview: '合流实现', titleTruncated: true, status: 'in_progress', dependsOn: ['A', 'B'], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: ['F'], startedAt: null, completedAt: null, id: 'D', titlePreview: '最终验收', titleTruncated: false, status: 'todo', dependsOn: ['C', 'F'], blockedBy: ['C', 'F'], ready: false, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'F', titlePreview: '发布检查', titleTruncated: false, status: 'todo', dependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time },
  ],
};
const index = buildGraphIndex(graph);
const representativeIds = ['A', 'B', 'F'];
const noop = () => {};
const viewport = (container: HTMLElement) => container.querySelector<HTMLElement>('.react-flow__viewport')!;
const ready = async (container: HTMLElement) => {
  await waitFor(() => expect(container.querySelectorAll('.react-flow__edge-path')).toHaveLength(4));
  await waitFor(() => expect(viewport(container).style.transform).not.toBe('translate(0px,0px) scale(1)'));
};

beforeEach(installGraphMeasurements);

describe('localized task graph presentation', () => {
  it('retranslates waiting chain roots and nodes while preserving external context, node identity and layout', async () => {
    const user = userEvent.setup();
    const layout = vi.spyOn(layoutModule, 'layoutGraph');
    const waitingGraph: GraphData = {
      ...graph,
      summary: { total: 3, todo: 3, inProgress: 0, done: 0, ready: 2, blocked: 1 },
      tasks: [
        { ...graph.tasks[0]!, status: 'todo', ready: true },
        { ...graph.tasks[3]!, status: 'todo', dependsOn: ['A', 'F'], blockedBy: ['A', 'F'] },
        graph.tasks[4]!,
      ],
    };
    const waitingIndex = buildGraphIndex(waitingGraph);
    const view = renderWithLocale(<ChainList index={waitingIndex} representativeIds={['A', 'F']} allRepresentativeIds={['A', 'F']}
      openChainId="A" onOpenChain={noop} onOpenTask={noop} onCloseChain={noop} showAll={false} onShowAllChange={noop} />, { locale: 'en' });
    const selected = await screen.findByRole('button', { name: '最终验收, To do, blocked' });
    expect(view.container.querySelector('#task-root-A .root-status')).toHaveTextContent('To do');
    expect(view.container.querySelector('#task-root-A .root-progress-label')).toHaveTextContent('0/2 completed');
    expect(screen.getByRole('button', { name: '发布检查, To do, external prerequisite' })).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox'), 'zh-CN');
    expect(view.container.querySelector('#task-root-A .root-status')).toHaveTextContent('待处理');
    expect(screen.getByRole('button', { name: '最终验收，待处理，被阻塞' })).toBe(selected);
    expect(screen.getByRole('button', { name: '发布检查，待处理，外部前置' })).toBeVisible();
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it('retranslates mounted memoized rows, nodes, dependencies and controls while retaining layout, selection and viewport', async () => {
    const user = userEvent.setup();
    const layout = vi.spyOn(layoutModule, 'layoutGraph');
    const select = vi.fn();
    const view = renderWithLocale(<ChainList index={index} representativeIds={representativeIds} allRepresentativeIds={representativeIds}
      openChainId="A" onOpenChain={noop} onOpenTask={select} onCloseChain={noop} showAll={false} onShowAllChange={noop} />, { locale: 'en' });
    await ready(view.container);
    expect(screen.getByRole('dialog')).toHaveClass('task-chain-dialog');
    expect(screen.getAllByText('3 tasks · 2 unfinished')).toHaveLength(1);
    expect(view.container.querySelector('#task-root-A .goal-in-progress')).toHaveTextContent('1 in progress');
    expect(screen.getByRole('checkbox', { name: 'Show all' })).not.toBeChecked();
    expect(screen.getByText('Chain 3 · External 2 · Tasks 5/5 · Dependencies 4/4')).toBeTruthy();
    const selected = screen.getByRole('button', { name: '合流实现…, In progress' });
    fireEvent.click(selected);
    expect(selected.closest('.task-node')).toHaveClass('task-node-selected');
    expect(screen.getByRole('button', { name: '最终验收, To do, blocked, outside the selected dependency path' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '设计方案, Done, external prerequisite, prerequisite of the selected task' })).toBeTruthy();
    const initialTransform = viewport(view.container).style.transform;
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => expect(viewport(view.container).style.transform).not.toBe(initialTransform));
    const transform = viewport(view.container).style.transform;
    const nodes = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')];
    const positions = nodes.map((node) => node.style.transform);
    const paths = [...view.container.querySelectorAll('.react-flow__edge-path')];
    const routes = paths.map((path) => path.getAttribute('d'));
    const rootToggle = view.container.querySelector('#task-root-A');
    const relation = screen.getByRole('img', { name: 'Ordinary dependency: prerequisite task A → subsequent task C, selected dependency path' });
    const canvas = view.container.querySelector('.task-graph-canvas');
    await user.selectOptions(screen.getByRole('combobox'), 'zh-CN');
    expect(screen.getByRole('combobox')).toHaveFocus();
    expect(screen.getByRole('dialog')).toHaveClass('task-chain-dialog');
    expect(screen.getAllByText('3 个任务 · 2 个未完成')).toHaveLength(1);
    expect(view.container.querySelector('#task-root-A .goal-in-progress')).toHaveTextContent('1 进行中');
    expect(screen.getByRole('checkbox', { name: '显示所有' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '合流实现…，进行中，已选中' })).toBe(selected);
    expect(selected.closest('.task-node')).toHaveClass('task-node-selected');
    expect(screen.getByRole('button', { name: '最终验收，待处理，被阻塞，不在所选依赖路径中' })).toBeTruthy();
    expect(screen.getByRole('img', { name: '普通依赖：前置任务 A → 后续任务 C，所选依赖路径' })).toBe(relation);
    expect(screen.getByRole('group', { name: '任务依赖关系' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '放大' })).toHaveAttribute('title', '放大'));
    expect(screen.getByRole('button', { name: '缩小' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '适应画布' })).toBeTruthy();
    expect(view.container.querySelector('#task-root-A')).toBe(rootToggle);
    expect(view.container.querySelector('.task-graph-canvas')).toBe(canvas);
    [...view.container.querySelectorAll('.react-flow__node')].forEach((node, position) => expect(node).toBe(nodes[position]));
    [...view.container.querySelectorAll('.react-flow__edge-path')].forEach((path, position) => expect(path).toBe(paths[position]));
    expect(nodes.map((node) => node.style.transform)).toEqual(positions);
    expect(paths.map((path) => path.getAttribute('d'))).toEqual(routes);
    expect(viewport(view.container).style.transform).toBe(transform);
    expect(layout).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    const details = screen.getByRole('button', { name: '合流实现…，详情' });
    fireEvent.click(details);
    expect(select).toHaveBeenCalledExactlyOnceWith('C', details);
    expect(selected).toHaveAttribute('aria-pressed', 'true');
  });

  it('retranslates expanded visibility controls without changing the actual visible graph, detail selection or viewport', async () => {
    const user = userEvent.setup();
    const fixture = browsingProjects.progressive;
    const index = buildGraphIndex(fixture);
    const rootId = fixture.tasks.find((task) => task.titlePreview === '渐进展开 · 主链交付起点')!.id;
    const joinId = fixture.tasks.find((task) => task.titlePreview === '合流任务 · 40 个外部前置')!.id;
    const open = vi.fn();
    const layout = vi.spyOn(layoutModule, 'layoutGraph');
    const view = renderWithLocale(<><LanguageSelector /><TaskGraph index={index} rootId={rootId} onOpenTask={open} /></>, { locale: 'en' });
    await waitFor(() => { expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(50); });
    const body = screen.getByRole('button', { name: '合流任务 · 40 个外部前置, To do, blocked' });
    fireEvent.click(body);
    expect(view.container.querySelector('.graph-hidden-prerequisites')).toHaveTextContent('40 additional upstream tasks are hidden');
    const expand = screen.getByRole('button', { name: 'Expand 20 prerequisite tasks and 20 dependencies, 20 prerequisites still hidden' });
    await user.click(expand);
    await waitFor(() => { expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(70); });
    await waitFor(() => { expect(body).toHaveFocus(); });
    expect(open).not.toHaveBeenCalled();
    const nodes = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')];
    const positions = nodes.map((node) => node.style.transform);
    const paths = [...view.container.querySelectorAll('.react-flow__edge-path')];
    const routes = paths.map((path) => path.getAttribute('d'));
    const transform = viewport(view.container).style.transform;
    expect(screen.getByRole('button', { name: 'Reset overview' })).toBeTruthy();
    expect(screen.getByText('Chain 61 · External 40 · Tasks 70/101 · Dependencies 69/100')).toBeTruthy();
    await user.selectOptions(screen.getByRole('combobox'), 'zh-CN');
    expect(screen.getByRole('button', { name: '合流任务 · 40 个外部前置，待处理，被阻塞，已选中' })).toBe(body);
    expect(body.closest('.task-node')).toHaveClass('task-node-selected');
    expect(view.container.querySelector('.graph-hidden-prerequisites')).toHaveTextContent('另有20个上游未展开');
    expect(screen.getByRole('button', { name: '展开前置 20 个任务、20 条依赖' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '收起到概览' })).toBeTruthy();
    expect(screen.getByText('链内 61 · 外部 40 · 任务 70/101 · 依赖 69/100')).toBeTruthy();
    expect([...view.container.querySelectorAll('.react-flow__node')]).toEqual(nodes);
    expect(nodes.map((node) => node.style.transform)).toEqual(positions);
    expect([...view.container.querySelectorAll('.react-flow__edge-path')]).toEqual(paths);
    expect(paths.map((path) => path.getAttribute('d'))).toEqual(routes);
    expect(viewport(view.container).style.transform).toBe(transform);
    expect(layout).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it('announces exact singular expansion counts in both languages', () => {
    expect(messagesByLocale.en.graph.expandLabel({ direction: 'prerequisites', tasks: 1, edges: 1, remaining: 1 }))
      .toBe('Expand 1 prerequisite task and 1 dependency, 1 prerequisite still hidden');
    expect(messagesByLocale['zh-CN'].graph.expandLabel({ direction: 'successors', tasks: 1, edges: 1, remaining: 1 }))
      .toBe('展开后续 1 个任务、1 条依赖，剩余 1 个后续未展开');
  });

  it('switches language inside the fullscreen modal while retaining focus, graph identity and its default size', async () => {
    const user = userEvent.setup();
    const layout = vi.spyOn(layoutModule, 'layoutGraph');
    const onClose = vi.fn();
    const view = renderWithLocale(<><button type="button">Background</button><TaskChainDialog index={index} rootId="A" onOpenTask={noop} onClose={onClose} onRestoreFocus={noop} /></>, { locale: 'en' });
    await ready(view.container);
    const dialog = screen.getByRole('dialog');
    const toggle = screen.getByRole('button', { name: 'View fullscreen' });
    const canvas = view.container.querySelector('.task-graph-canvas');
    const transform = viewport(view.container).style.transform;
    expect(screen.getByRole('button', { name: 'Background', hidden: true })).toHaveAttribute('inert');
    fireEvent.click(toggle);
    expect(toggle).toHaveFocus();
    expect(dialog).toHaveClass('task-chain-dialog-fullscreen');
    const selector = within(dialog).getByRole('combobox', { name: '语言 / Language' });
    await user.selectOptions(selector, 'zh-CN');
    expect(selector).toHaveFocus();
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: '退出全屏' })).toBe(toggle);
    expect(view.container.querySelector('.task-graph-canvas')).toBe(canvas);
    expect(viewport(view.container).style.transform).toBe(transform);
    for (let step = 0; step < 18; step++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    fireEvent.keyDown(toggle, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(dialog).not.toHaveClass('task-chain-dialog-fullscreen');
    expect(within(dialog).getByRole('combobox')).toBe(selector);
    expect(toggle).toHaveAccessibleName('全屏查看');
    expect(toggle).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Background', hidden: true })).toHaveAttribute('inert');
    expect(viewport(view.container).style.transform).toBe(transform);
    expect(layout).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(toggle, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('retranslates an existing layout failure without repeating the failed layout', async () => {
    const user = userEvent.setup();
    const layout = vi.spyOn(layoutModule, 'layoutGraph').mockImplementation(() => { throw new Error('layout failed'); });
    renderWithLocale(<><LanguageSelector /><TaskGraph index={index} rootId="A" onOpenTask={noop} /></>, { locale: 'en' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Task graph layout failed');
    await user.selectOptions(screen.getByRole('combobox'), 'zh-CN');
    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert).toHaveTextContent('任务图布局失败');
    expect(alert).toHaveTextContent('无法绘制此任务链，请刷新项目后重试。');
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it('renders empty and hidden-completed chain states in the chosen language', () => {
    const props = { index, allRepresentativeIds: [], representativeIds: [], openChainId: null,
      onOpenChain: noop, onCloseChain: noop, onOpenTask: noop, showAll: false, onShowAllChange: noop };
    const view = renderWithLocale(<ChainList {...props} />, { locale: 'en' });
    expect(screen.getByRole('heading', { name: 'No task chains' })).toBeTruthy();
    expect(screen.getByLabelText('Showing 0 of 0 task chains')).toHaveTextContent('Newest first · 0 / 0 task chains');
    const completeIndex = buildGraphIndex({ ...graph, summary: { total: 5, todo: 0, inProgress: 0, done: 5, ready: 0, blocked: 0 }, tasks: graph.tasks.map((task) => ({ ...task, status: 'done', blockedBy: [], ready: false })) });
    view.rerender(<ChainList {...props} index={completeIndex} allRepresentativeIds={representativeIds} />);
    expect(screen.getByRole('heading', { name: 'No recent task chains' })).toBeTruthy();
    expect(screen.getByText('3 completed task chains are outside the current filter. Select “Show all” to view them.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy();
  });

  it.each([0, 1, 2, 1000])('formats complete English and Chinese graph counts for %i', (value) => {
    const en = messagesByLocale.en.graph;
    const zh = messagesByLocale['zh-CN'].graph;
    const formatted = new Intl.NumberFormat('en').format(value);
    expect(en.counts({ main: value, external: value, visible: value, total: 1000, edges: value, dependencies: 1000 })).toBe(`Chain ${formatted} · External ${formatted} · Tasks ${formatted}/1,000 · Dependencies ${formatted}/1,000`);
    expect(en.completedDescription({ count: value })).toBe(`${formatted} completed task ${value === 1 ? 'chain is' : 'chains are'} outside the current filter. Select “Show all” to view them.`);
    expect(zh.counts({ main: value, external: value, visible: value, total: 1000, edges: value, dependencies: 1000 })).toBe(`链内 ${formatted} · 外部 ${formatted} · 任务 ${formatted}/1,000 · 依赖 ${formatted}/1,000`);
    expect(en.progress({ done: value, total: 1000 })).toBe(`${formatted}/1,000 completed`);
  });
});
