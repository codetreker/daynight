import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskGraph as GraphData } from '../src/api/types';
import { TaskGraph } from '../src/features/task-graph/TaskGraph';
import { buildGraphIndex } from '../src/features/task-graph/model';
import * as layoutModule from '../src/features/task-graph/layout';
import * as routes from '../src/features/task-graph/routes';
import { useTaskInspection } from '../src/features/task-graph/inspection';
import { createLocaleRender } from './helpers/renderWithLocale';
import { installGraphMeasurements } from './graph-measurements';
import { browsingProjects } from './mockups/browsing-fixture';

const flowNodes = vi.hoisted(() => vi.fn<(nodes: readonly unknown[] | undefined) => void>());
vi.mock('@xyflow/react', async (original) => {
  const actual = await original<typeof import('@xyflow/react')>();
  const { createElement } = await import('react');
  return { ...actual, ReactFlow: (props: Parameters<typeof actual.ReactFlow>[0]) => {
    flowNodes(props.nodes);
    return createElement(actual.ReactFlow, props);
  } };
});

const render = createLocaleRender('zh-CN');
const time = '2026-10-22T00:00:00Z';
const graph: GraphData = { observedAt: "2026-10-20T12:00:00Z",
  project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: 'project', name: 'Project', repoUrl: '', createdAt: time, updatedAt: time },
  summary: { total: 5, todo: 2, inProgress: 0, done: 3, ready: 2, blocked: 0 },
  tasks: [
    { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'A', titlePreview: 'A', titleTruncated: false, status: 'done', dependsOn: [], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'B', titlePreview: 'B', titleTruncated: false, status: 'done', dependsOn: [], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'C', titlePreview: 'C', titleTruncated: false, status: 'done', dependsOn: ['B'], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: ['C'], startedAt: null, completedAt: null, id: 'D', titlePreview: 'D', titleTruncated: false, status: 'todo', dependsOn: ['A', 'C'], blockedBy: [], ready: true, createdAt: time, updatedAt: time },
    { requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, id: 'X', titlePreview: 'X', titleTruncated: false, status: 'todo', dependsOn: ['C'], blockedBy: [], ready: true, createdAt: time, updatedAt: time },
  ],
};
const index = buildGraphIndex(graph);
const noop = () => {};
const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .task-node`)!;
const body = (container: HTMLElement, id: string) => card(container, id).querySelector<HTMLButtonElement>('.task-node-body')!;
const details = (container: HTMLElement, id: string) => card(container, id).querySelector<HTMLButtonElement>('.task-node-details')!;
const ready = async (container: HTMLElement, count = 4) => {
  await waitFor(() => { expect(container.querySelectorAll('.react-flow__node')).toHaveLength(count); });
  await waitFor(() => { expect(container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform).not.toBe('translate(0px,0px) scale(1)'); });
};
const geometry = (container: HTMLElement) => ({
  nodes: [...container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => [node.dataset.id, node.style.transform, node.style.width, node.style.height]),
  shapes: [...container.querySelectorAll<SVGElement>('.react-flow__edge-path,.task-dependency-paint-piece')].map((shape) => [shape.tagName,
    ...['d', 'transform', 'x1', 'y1', 'x2', 'y2'].map((name) => shape.getAttribute(name)), shape.style.strokeDashoffset]),
  view: container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform,
});

beforeEach(installGraphMeasurements);

describe('graph-local prerequisite inspection', () => {
  it('highlights the exact complete path including external-to-external edges and preserves task statuses', async () => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    expect(card(view.container, 'X')).toBeNull();
    fireEvent.click(body(view.container, 'D'));
    expect(card(view.container, 'D')).toHaveAttribute('data-inspection', 'selected');
    expect(card(view.container, 'D')).toHaveClass('task-node-todo');
    for (const id of ['A', 'B', 'C']) {
      expect(card(view.container, id)).toHaveAttribute('data-inspection', 'prerequisite');
      expect(card(view.container, id)).toHaveClass('task-node-done');
    }
    expect(card(view.container, 'B')).toHaveClass('task-node-external');
    expect(card(view.container, 'C')).toHaveClass('task-node-external');
    const states = () => [...view.container.querySelectorAll<HTMLElement>('.task-dependency-edge')].map((edge) => [edge.dataset.id, edge.dataset.inspection]);
    expect(states()).toEqual([['A->D', 'highlighted'], ['B->C', 'highlighted'], ['C->D', 'highlighted']]);
    fireEvent.click(body(view.container, 'C'));
    expect(states()).toEqual([['A->D', 'unrelated'], ['B->C', 'highlighted'], ['C->D', 'unrelated']]);
    expect(card(view.container, 'A')).toHaveAttribute('data-inspection', 'unrelated');
    expect(card(view.container, 'B')).toHaveAttribute('data-inspection', 'prerequisite');
    fireEvent.click(body(view.container, 'C'));
    expect(view.container.querySelectorAll('.task-node-normal')).toHaveLength(4);
    fireEvent.click(body(view.container, 'A'));
    expect(view.container.querySelectorAll('.task-dependency-edge[data-inspection="highlighted"]')).toHaveLength(0);
    fireEvent.click(view.container.querySelector('.react-flow__pane')!);
    expect(body(view.container, 'A')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps body and Details as independent native keyboard actions and preserves inspection while opening details', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={open} />);
    await ready(view.container);
    const inspect = body(view.container, 'D');
    const read = details(view.container, 'D');
    expect(inspect.parentElement).toBe(read.parentElement);
    expect(inspect).not.toHaveAttribute('aria-haspopup');
    expect(read).toHaveAttribute('aria-haspopup', 'dialog');
    expect(read).not.toHaveAttribute('aria-pressed');
    expect(within(card(view.container, 'D')).getByRole('button', { name: 'D，详情' })).toBe(read);
    inspect.focus();
    await user.keyboard('{Enter}');
    expect(inspect).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard(' ');
    expect(inspect).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard(' ');
    expect(open).not.toHaveBeenCalled();
    read.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(read);
    expect(open).toHaveBeenCalledTimes(3);
    for (const call of open.mock.calls) expect(call).toEqual(['D', read]);
    expect(inspect).toHaveAttribute('aria-pressed', 'true');
  });

  it('changes only presentation while retaining controlled node data, compiled geometry, paint pieces and viewport', async () => {
    const layout = vi.spyOn(layoutModule, 'layoutGraph');
    const compile = vi.spyOn(routes, 'compileDependencyRoute');
    const open = vi.fn();
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={open} />);
    await ready(view.container);
    const before = geometry(view.container);
    const nodes = flowNodes.mock.calls.at(-1)![0];
    const shapes = [...view.container.querySelectorAll('.react-flow__edge-path,.task-dependency-paint-piece')];
    flowNodes.mockClear();
    fireEvent.click(body(view.container, 'D'));
    fireEvent.click(details(view.container, 'D'));
    view.rerender(<TaskGraph index={index} rootId="A" onOpenTask={open} />);
    expect(flowNodes).not.toHaveBeenCalled();
    expect(nodes).toHaveLength(4);
    expect(layout).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledTimes(3);
    expect(geometry(view.container)).toEqual(before);
    expect([...view.container.querySelectorAll('.react-flow__edge-path,.task-dependency-paint-piece')]).toEqual(shapes);
    expect(view.container.querySelectorAll('marker')).toHaveLength(3);
    for (const edge of view.container.querySelectorAll('.task-dependency-edge')) {
      expect(edge.querySelector('.task-dependency-body')).toHaveAttribute('stroke', '#6762ce');
      const marker = edge.querySelector('.react-flow__edge-path')!.getAttribute('marker-end')!.slice(5, -1);
      expect(view.container.querySelector(`[id="${marker}"] polyline`)).toHaveAttribute('fill', '#6762ce');
    }
  });

  it('recomputes a retained inspection from a new snapshot and clears a removed task before it can reappear', async () => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    fireEvent.click(body(view.container, 'D'));
    const changed = buildGraphIndex({ ...graph, tasks: graph.tasks.map((task) => task.id === 'D' ? { ...task, dependsOn: ['A'], externalDependsOn: [] } : task) });
    view.rerender(<TaskGraph index={changed} rootId="A" onOpenTask={noop} />);
    await ready(view.container, 2);
    expect(body(view.container, 'D')).toHaveAttribute('aria-pressed', 'true');
    expect(card(view.container, 'A')).toHaveAttribute('data-inspection', 'prerequisite');
    body(view.container, 'D').focus();
    const removed = buildGraphIndex({ ...graph, tasks: graph.tasks.filter((task) => task.id !== 'D'), summary: { ...graph.summary, total: 4, todo: 1, ready: 1 } });
    view.rerender(<TaskGraph index={removed} rootId="A" onOpenTask={noop} />);
    await ready(view.container, 1);
    expect(screen.getByRole('button', { name: '收起到概览' })).toHaveFocus();
    view.rerender(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    expect(body(view.container, 'A')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: '收起到概览' }));
    await ready(view.container);
    expect(body(view.container, 'D')).toHaveAttribute('aria-pressed', 'false');
  });

  it('counts hidden ancestors once, keeps inspection through expansion, and clears a selected task hidden by reset', async () => {
    const fixture = browsingProjects.progressive;
    const index = buildGraphIndex(fixture);
    const root = fixture.tasks.find((task) => task.titlePreview === '渐进展开 · 主链交付起点')!.id;
    const join = fixture.tasks.find((task) => task.titlePreview === '合流任务 · 40 个外部前置')!.id;
    const view = render(<TaskGraph index={index} rootId={root} onOpenTask={noop} />);
    await ready(view.container, 50);
    const before = geometry(view.container);
    const status = view.container.querySelector('.graph-hidden-prerequisites')!;
    expect(status).toHaveAttribute('role', 'status');
    fireEvent.click(body(view.container, join));
    expect(status).toHaveTextContent(/^另有40个上游未展开$/);
    expect(geometry(view.container)).toEqual(before);
    fireEvent.click(card(view.container, join).querySelector('.task-node-expand[data-direction="prerequisites"]')!);
    await ready(view.container, 70);
    expect(status).toHaveTextContent(/^另有20个上游未展开$/);
    expect(body(view.container, join)).toHaveAttribute('aria-pressed', 'true');
    const external = fixture.tasks[0]!.id;
    fireEvent.click(body(view.container, external));
    fireEvent.click(screen.getByRole('button', { name: '收起到概览' }));
    await ready(view.container, 50);
    expect(view.container.querySelectorAll('.task-node-selected')).toHaveLength(0);
    expect(status).toBeEmptyDOMElement();
  });

  it.each([false, true])('recovers a removed footer at the task DOM commit without stealing dialog focus (dialog=%s)', async (dialogFocused) => {
    const fixture = browsingProjects.progressive;
    const root = fixture.tasks.find((task) => task.titlePreview === '渐进展开 · 主链交付起点')!.id;
    const ui = (data: GraphData) => <><div role="dialog" aria-label="详情测试窗口"><button type="button">详情关闭控件</button></div><TaskGraph index={buildGraphIndex(data)} rootId={root} onOpenTask={noop} /></>;
    const view = render(ui(fixture));
    await ready(view.container, 50);
    const footer = card(view.container, root).querySelector<HTMLButtonElement>('.task-node-expand[data-direction="successors"]')!;
    footer.focus();
    const dialogButton = screen.getByRole('button', { name: '详情关闭控件' });
    if (dialogFocused) dialogButton.focus();
    const before = geometry(view.container).view;
    const removed = new Set(fixture.tasks.filter((task) => task.dependsOn.includes(root)).slice(49).map((task) => task.id));
    const refreshed = { ...fixture, tasks: fixture.tasks.filter((task) => !removed.has(task.id)), summary: { ...fixture.summary, total: 90, todo: 50, blocked: 49 } };
    view.rerender(ui(refreshed));
    await ready(view.container, 50);
    await waitFor(() => { expect(footer.isConnected).toBe(false); });
    expect(dialogFocused ? dialogButton : body(view.container, root)).toHaveFocus();
    expect(geometry(view.container).view).toBe(before);
  });

  it('releases inspection on root changes and unmount without persisting it', async () => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    fireEvent.click(body(view.container, 'D'));
    view.rerender(<TaskGraph index={index} rootId="B" onOpenTask={noop} />);
    await ready(view.container, 3);
    expect(card(view.container, 'D')).toBeNull();
    expect(body(view.container, 'C')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(body(view.container, 'C'));
    view.rerender(<div />);
    view.rerender(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    expect(body(view.container, 'D')).toHaveAttribute('aria-pressed', 'false');
  });

  it('requires a graph-local inspection provider', () => {
    const Consumer = () => { useTaskInspection(); return null; };
    expect(() => render(<Consumer />)).toThrow('Task inspection requires its graph provider.');
  });
});
