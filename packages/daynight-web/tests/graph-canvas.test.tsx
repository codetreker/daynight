import { useContext, useEffect, useRef, useState, type RefObject } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { createLocaleRender } from './helpers/renderWithLocale';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskGraph as TaskGraphData, TaskSummary } from '../src/api/types';
import { ChainList } from '../src/features/task-graph/ChainList';
import { TaskGraph } from '../src/features/task-graph/TaskGraph';
import { TaskGraphCanvas } from '../src/features/task-graph/TaskGraphCanvas';
import type { TaskFlowNode } from '../src/features/task-graph/TaskNode';
import { getInitialTaskViewport } from '../src/features/task-graph/chain-viewport';
import { TaskChainDialog } from '../src/features/task-graph/TaskChainDialog';
import { buildGraphIndex, projectChain } from '../src/features/task-graph/model';
import * as layoutModule from '../src/features/task-graph/layout';
import { progressiveGraph } from './helpers/graphData';
import { compileDependencyRoute } from '../src/features/task-graph/routes';
import { installGraphMeasurements } from './graph-measurements';
import { OverlayOwnerContext } from '../src/app/overlay';

const render = createLocaleRender('zh-CN', { taskCache: true });

const taskRenders = vi.hoisted(() => vi.fn<(id: string) => void>());
vi.mock('../src/features/task-graph/TaskNode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/task-graph/TaskNode')>();
  const { createElement, memo } = await import('react');
  return {
    ...actual,
    TaskNode: memo((props: Parameters<typeof actual.TaskNode>[0]) => {
      taskRenders(props.id);
      return createElement(actual.TaskNode, props);
    }),
  };
});

const time = '2026-10-20T00:00:00Z';
const graph: TaskGraphData = { observedAt: "2026-10-20T12:00:00Z",
  project: { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id: 'project', name: '项目', repoUrl: 'https://github.com/example/repo', createdAt: time, updatedAt: time },
  summary: { proposed: 0, total: 6, todo: 3, inProgress: 1, done: 2, cancelled: 0, ready: 2, blocked: 1 },
  tasks: [
    { type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null, id: 'A', titlePreview: '基础 API', titleTruncated: false, status: 'done', dependsOn: [], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null, id: 'B', titlePreview: '设计方案', titleTruncated: false, status: 'done', dependsOn: [], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: ['B'], startedAt: null, completedAt: null, cancelledAt: null, id: 'C', titlePreview: '合流实现', titleTruncated: true, status: 'in_progress', dependsOn: ['A', 'B'], blockedBy: [], ready: false, createdAt: time, updatedAt: time },
    { type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: ['F'], startedAt: null, completedAt: null, cancelledAt: null, id: 'D', titlePreview: '最终验收', titleTruncated: false, status: 'todo', dependsOn: ['C', 'F'], blockedBy: ['C', 'F'], ready: false, createdAt: time, updatedAt: time },
    { type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null, id: 'E', titlePreview: '独立任务', titleTruncated: false, status: 'todo', dependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time },
    { type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null, id: 'F', titlePreview: '发布检查', titleTruncated: false, status: 'todo', dependsOn: [], blockedBy: [], ready: true, createdAt: time, updatedAt: time },
  ],
};
const index = buildGraphIndex(graph);
const noop = () => {};
const nodeButton = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}，(?:已完成|待处理|进行中)`) });
const detailsButton = (name: string) => screen.getByRole('button', { name: `${name}，详情` });
const nodeShell = (name: string) => nodeButton(name).closest<HTMLElement>('.task-node')!;
const toolbarActions = (container: HTMLElement) => within(container.querySelector<HTMLElement>('.graph-toolbar-actions')!);
const viewportActions = (container: HTMLElement) => within(container.querySelector<HTMLElement>('.react-flow__controls')!);
const viewport = (container: HTMLElement) => container.querySelector<HTMLElement>('.react-flow__viewport')!;
const zoom = (container: HTMLElement) => Number(/scale\(([^)]+)\)/.exec(viewport(container).style.transform)![1]);
const ready = async (container: HTMLElement) => {
  await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(4); });
  await waitFor(() => { expect(viewport(container).style.transform).not.toBe('translate(0px,0px) scale(1)'); });
};

beforeEach(installGraphMeasurements);

describe('task dependency canvas', () => {
  it('uses caller framing and fit policy without a chain root', async () => {
    const geometry = layoutModule.layoutGraph({ mainIds: new Set(['A']), externalIds: new Set(), edges: [] });
    const node = geometry.nodes[0]!;
    const emptyExpansion = { ids: [], totalHidden: 0, addedEdges: 0 };
    const nodes: TaskFlowNode[] = [{ id: node.id, position: node.position, type: 'task', width: node.width, height: node.height,
      data: { task: graph.tasks[0]!, kind: node.kind, center: { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 },
        size: { width: node.width, height: node.height }, actions: { kind: 'chain', onInspectTask: noop, onOpenTask: noop, onNavigateExternalTask: noop, onExpandTask: noop,
        expansions: { prerequisites: emptyExpansion, successors: emptyExpansion }, revealRequest: null } } }];
    const dimensions = vi.fn();
    const reset = vi.fn();
    const inspection = { selectedTaskId: null, highlightedIds: new Set<string>() };
    const canvas = (zoom: number, revision: number | null, framingReady = true) => <TaskGraphCanvas canvasId="independent"
      nodes={nodes} geometry={geometry} inspection={inspection} onClearInspection={noop} viewportFactory={() => ({ x: 10, y: 20, zoom })}
      framingKey="independent" framingRevision={revision} onFramingReset={reset} minZoom={0.05} maxZoom={1.8}
      fitViewOptions={{ minZoom: 0.05, maxZoom: 0.4, padding: 0.15 }} framingReady={framingReady} onSizeChange={dimensions} />;
    const view = render(canvas(0.1, null, false));
    await waitFor(() => expect(dimensions).toHaveBeenCalledWith(800, 445));
    expect(zoom(view.container)).toBe(1);
    view.rerender(canvas(0.1, null));
    await waitFor(() => expect(zoom(view.container)).toBeCloseTo(0.1));
    view.rerender(canvas(0.15, null));
    expect(zoom(view.container)).toBeCloseTo(0.1);
    view.rerender(canvas(0.15, 1));
    await waitFor(() => expect(zoom(view.container)).toBeCloseTo(0.15));
    expect(reset).toHaveBeenCalledOnce();
    fireEvent.click(viewportActions(view.container).getByRole('button', { name: '适应画布' }));
    await waitFor(() => expect(zoom(view.container)).toBeCloseTo(0.4));
  });

  it('exposes the actual dialog root to nested content and clears it on unmount', async () => {
    const rootChange = vi.fn();
    const nestedContext = vi.fn();
    let nestedOwner: RefObject<HTMLElement | null> | undefined;
    const Nested = () => {
      const owner = useContext(OverlayOwnerContext);
      useEffect(() => { nestedContext(owner); }, [owner]);
      return null;
    };
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={noop} onRestoreFocus={noop}
      onRootChange={rootChange} renderNested={(owner) => { nestedOwner = owner; return <Nested />; }} />);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('id', 'task-graph-A');
    expect(dialog).toHaveAccessibleName('基础 API');
    expect(rootChange).toHaveBeenLastCalledWith(dialog);
    expect(nestedOwner?.current).toBe(dialog);
    expect(nestedContext).toHaveBeenLastCalledWith(nestedOwner);
    view.unmount();
    expect(rootChange).toHaveBeenLastCalledWith(null);
    expect(nestedOwner?.current).toBeNull();
  });

  it('labels each ordinary and external card with its actual Goal scope', async () => {
    const data: TaskGraphData = { ...graph, tasks: graph.tasks.map((task) => ({ ...task, parentId: task.id === 'C' ? 'g1' : task.id === 'B' ? 'g2' : null })) };
    const goal = (id: string, title: string): TaskSummary => {
      const { blockedBy: _blockedBy, ready: _ready, ...rest } = data.tasks[0]!;
      return { ...rest, tags: [], id, type: 'goal', titlePreview: title, properties: {}, version: 1n };
    };
    const summaries = new Map([['g1', goal('g1', '目标一')], ['g2', goal('g2', '目标二')]]);
    const view = render(<TaskGraph index={buildGraphIndex(data)} summaries={summaries} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    expect(nodeButton('基础 API')).toHaveAccessibleName(/未归属 Goal/);
    expect(nodeButton('合流实现…')).toHaveAccessibleName(/Goal：目标一/);
    expect(nodeButton('设计方案')).toHaveAccessibleName(/Goal：目标二/);
    expect(within(nodeButton('设计方案')).getByText('Goal：目标二')).toBeVisible();
  });
  it('sizes visible ordinary cards to their bodies and external cards to their navigation footers', async () => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    expect(view.container.querySelectorAll('.task-node-expansions')).toHaveLength(2);
    expect(view.container.querySelector('.task-node-expand[data-direction]')).toBeNull();
    for (const node of view.container.querySelectorAll<HTMLElement>('.react-flow__node')) {
      expect(node.style.width).toBe('220px');
      expect(node.style.height).toBe(node.querySelector('.task-node-external') === null ? '96px' : '136px');
    }
  });

  it('renders platform badges on main and external nodes without changing task status', async () => {
    const platforms: TaskGraphData = { ...graph, tasks: graph.tasks.map((task) => ({ ...task, requiredPlatform: task.id === 'C' ? 'linux' : task.id === 'F' ? 'windows' : null })) };
    const view = render(<TaskGraph index={buildGraphIndex(platforms)} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    expect(within(nodeButton('合流实现…')).getByText('Linux')).toHaveClass('task-platform-compact');
    expect(within(nodeButton('发布检查')).getByText('Windows')).toHaveClass('task-platform-compact');
    expect(within(nodeButton('基础 API')).getByText('不限平台')).toBeVisible();
    expect(nodeShell('合流实现…')).toHaveClass('task-node-in_progress');
  });

  it('exposes waiting main and external nodes with their own status and unfinished prerequisites', async () => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    const main = screen.getByRole('button', { name: '最终验收，待处理，被阻塞' });
    expect(main.closest('.task-node')).toHaveClass('task-node-todo');
    expect(within(main).getByText('待处理')).toHaveClass('graph-status-todo');
    const external = screen.getByRole('button', { name: '发布检查，待处理，外部前置' });
    expect(external.closest('.task-node')).toHaveClass('task-node-todo', 'task-node-external');
    expect(within(external).queryByText('被阻塞')).toBeNull();
  });

  it('changes direction with keyboard, retains inspection, and restores a saved choice after reopening', async () => {
    const user = userEvent.setup();
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={noop} onRestoreFocus={noop} />);
    await ready(view.baseElement);
    const horizontal = toolbarActions(view.baseElement).getByRole('radio', { name: '水平' });
    const vertical = toolbarActions(view.baseElement).getByRole('radio', { name: '垂直' });
    expect(horizontal).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(nodeButton('合流实现…'));
    const canvas = view.baseElement.querySelector('.react-flow');
    horizontal.focus();
    await user.keyboard('{ArrowRight}');
    expect(vertical).toHaveFocus();
    expect(vertical).toHaveAttribute('aria-checked', 'true');
    expect(nodeShell('合流实现…')).toHaveClass('task-node-selected');
    expect(view.baseElement.querySelector('.react-flow')).toBe(canvas);
    view.unmount();
    const reopened = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={noop} onRestoreFocus={noop} />);
    expect(toolbarActions(reopened.baseElement).getByRole('radio', { name: '垂直' })).toHaveAttribute('aria-checked', 'true');
  });

  it('switches the same modal canvas to fullscreen and back without changing its viewport or layout', async () => {
    const layout = vi.spyOn(layoutModule, 'layoutGraph');
    const onClose = vi.fn();
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={onClose} onRestoreFocus={noop} />);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('task-chain-dialog');
    expect(dialog).not.toHaveClass('task-chain-dialog-fullscreen');
    const initialZoom = zoom(view.baseElement);
    fireEvent.click(viewportActions(view.baseElement).getByRole('button', { name: '放大' }));
    await waitFor(() => { expect(zoom(view.baseElement)).toBeGreaterThan(initialZoom); });
    const canvas = view.baseElement.querySelector('.task-graph-canvas');
    const nodes = [...view.baseElement.querySelectorAll('.react-flow__node')];
    const paths = [...view.baseElement.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'));
    const positions = nodes.map((node) => (node as HTMLElement).style.transform);
    const transform = viewport(view.baseElement).style.transform;
    const enter = toolbarActions(view.baseElement).getByRole('button', { name: '全屏查看' });
    fireEvent.click(enter);
    expect(dialog).toHaveClass('task-chain-dialog-fullscreen');
    expect(toolbarActions(view.baseElement).getByRole('button', { name: '退出全屏' })).toBe(enter);
    expect(enter).toHaveFocus();
    expect(view.baseElement.querySelector('.task-graph-canvas')).toBe(canvas);
    [...view.baseElement.querySelectorAll('.react-flow__node')].forEach((node, position) => { expect(node).toBe(nodes[position]); });
    expect(nodes.map((node) => (node as HTMLElement).style.transform)).toEqual(positions);
    expect([...view.baseElement.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'))).toEqual(paths);
    expect(viewport(view.baseElement).style.transform).toBe(transform);
    nodeButton('基础 API').focus();
    fireEvent.keyDown(nodeButton('基础 API'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(dialog).not.toHaveClass('task-chain-dialog-fullscreen');
    expect(enter).toHaveAccessibleName('全屏查看');
    expect(enter).toHaveFocus();
    expect(view.baseElement.querySelector('.task-graph-canvas')).toBe(canvas);
    expect(viewport(view.baseElement).style.transform).toBe(transform);
    expect(layout).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(enter);
    fireEvent.click(toolbarActions(view.baseElement).getByRole('button', { name: '退出全屏' }));
    expect(dialog).not.toHaveClass('task-chain-dialog-fullscreen');
    expect(viewport(view.baseElement).style.transform).toBe(transform);
    fireEvent.keyDown(enter, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledExactlyOnceWith();
  });

  it('contains keyboard focus in the modal and handles only local Escape one layer at a time', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<><button type="button">图外按钮</button><TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={onClose} onRestoreFocus={noop} /></>);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    expect(view.baseElement.querySelector('.task-chain-close')).toHaveFocus();
    for (let step = 0; step < 20; step++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let step = 0; step < 20; step++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    fireEvent.click(toolbarActions(view.baseElement).getByRole('button', { name: '全屏查看' }));
    const exit = toolbarActions(view.baseElement).getByRole('button', { name: '退出全屏' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(dialog).toHaveClass('task-chain-dialog-fullscreen');
    fireEvent.keyDown(exit, { key: 'Escape' });
    expect(dialog).not.toHaveClass('task-chain-dialog-fullscreen');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(exit, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each(['.task-chain-heading h2', '.graph-toolbar-summary', '.task-graph-canvas'])('closes with Escape after clicking noninteractive content at %s', async (target) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={onClose} onRestoreFocus={noop} />);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    await user.click(view.baseElement.querySelector<HTMLElement>(target)!);
    expect(dialog).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('leaves fullscreen before closing after clicking blank canvas content', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={onClose} onRestoreFocus={noop} />);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    const canvas = view.baseElement.querySelector('.task-graph-canvas');
    const transform = viewport(view.baseElement).style.transform;
    const fullscreen = toolbarActions(view.baseElement).getByRole('button', { name: '全屏查看' });
    await user.click(fullscreen);
    await user.click(view.baseElement.querySelector<HTMLElement>('.task-graph-canvas')!);
    expect(dialog).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(dialog).not.toHaveClass('task-chain-dialog-fullscreen');
    expect(fullscreen).toHaveFocus();
    expect(view.baseElement.querySelector('.task-graph-canvas')).toBe(canvas);
    expect(viewport(view.baseElement).style.transform).toBe(transform);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(view.baseElement.querySelector<HTMLElement>('.task-graph-canvas')!);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([false, true])('keeps Tab navigation inside the modal after clicking its canvas (shift: %s)', async (shift) => {
    const user = userEvent.setup();
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={noop} onRestoreFocus={noop} />);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    await user.click(view.baseElement.querySelector<HTMLElement>('.task-graph-canvas')!);
    expect(dialog).toHaveFocus();
    await user.tab({ shift });
    expect(shift ? within(dialog).getByRole('link', { name: 'React Flow attribution' }) : within(dialog.querySelector<HTMLElement>('.task-chain-header')!).getByRole('button', { name: '关闭依赖图' })).toHaveFocus();
  });

  it('inerts background ancestors for the whole modal and restores their original state without touching body portals', async () => {
    document.body.style.overflow = 'scroll';
    const portal = document.createElement('div');
    portal.textContent = 'body portal';
    document.body.append(portal);
    const Wrapper = () => {
      const [opened, setOpened] = useState(false);
      return <><button type="button" data-testid="outer-background" onClick={() => setOpened(true)}>项目导航</button><section><div data-testid="preexisting-inert" inert={true} />{opened && <TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={() => setOpened(false)} onRestoreFocus={noop} />}<button type="button" data-testid="inner-background">任务链</button></section></>;
    };
    const view = render(<Wrapper />);
    view.container.id = 'root';
    const background = [screen.getByTestId('outer-background'), screen.getByTestId('inner-background')];
    const existing = screen.getByTestId('preexisting-inert');
    existing.setAttribute('inert', 'preserve-this-value');
    fireEvent.click(background[0]!);
    await ready(view.baseElement);
    expect(view.container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    expect(portal).not.toHaveAttribute('inert');
    fireEvent.click(toolbarActions(view.baseElement).getByRole('button', { name: '全屏查看' }));
    fireEvent.click(toolbarActions(view.baseElement).getByRole('button', { name: '退出全屏' }));
    expect(view.container).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(view.baseElement.querySelector('.task-chain-close')!);
    expect(view.container).not.toHaveAttribute('inert');
    expect(existing).toHaveAttribute('inert', 'preserve-this-value');
    expect(document.body.style.overflow).toBe('scroll');
    fireEvent.click(background[0]!);
    await ready(view.baseElement);
    view.unmount();
    expect(view.container).not.toHaveAttribute('inert');
    expect(existing).toHaveAttribute('inert', 'preserve-this-value');
    expect(document.body.style.overflow).toBe('scroll');
    portal.remove();
    document.body.style.overflow = '';
  });

  it('closes from the backdrop and close button while preserving graph clicks and handled child Escape', async () => {
    const onClose = vi.fn();
    const originalRestore = vi.fn();
    const latestRestore = vi.fn();
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={onClose} onRestoreFocus={originalRestore} />);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    fireEvent.click(view.baseElement.querySelector('.task-graph-canvas')!);
    const handledEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handledEscape.preventDefault();
    fireEvent(nodeButton('基础 API'), handledEscape);
    expect(onClose).not.toHaveBeenCalled();
    const backdrop = view.baseElement.querySelector('.task-chain-backdrop')!;
    fireEvent.pointerDown(view.baseElement.querySelector('.task-graph-canvas')!);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(view.baseElement.querySelector('.task-chain-close')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={onClose} onRestoreFocus={latestRestore} />);
    view.unmount();
    expect(originalRestore).not.toHaveBeenCalled();
    expect(latestRestore).toHaveBeenCalledOnce();
  });

  it('wraps both keyboard boundaries and recovers focus entering from outside the modal', async () => {
    const user = userEvent.setup();
    const view = render(<TaskChainDialog projectId="project" index={index} rootId="A" onOpenTask={noop} onClose={noop} onRestoreFocus={noop} />);
    await ready(view.baseElement);
    const dialog = screen.getByRole('dialog');
    const first = within(dialog.querySelector<HTMLElement>('.task-chain-header')!).getByRole('button', { name: '关闭依赖图' });
    first.focus();
    await user.tab({ shift: true });
    const last = document.activeElement as HTMLElement;
    expect(last).not.toBe(first);
    expect(dialog).toContainElement(last);
    await user.tab();
    expect(first).toHaveFocus();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();
    outside.remove();
  });

  it('renders all dependency paths without endpoint measurements and still observes the task nodes', () => {
    const observed = new Set<Element>();
    vi.stubGlobal('ResizeObserver', class {
      observe(target: Element) { observed.add(target); }
      unobserve(target: Element) { observed.delete(target); }
      disconnect() {}
    });
    const { container } = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    const nodes = [...container.querySelectorAll('.react-flow__node')];
    const edges = [...container.querySelectorAll('.react-flow__edge-path')];
    expect(nodes).toHaveLength(5);
    expect(edges).toHaveLength(4);
    expect(nodes.every((node) => observed.has(node))).toBe(true);
    expect(edges.every((edge) => edge.getAttribute('marker-end')?.startsWith('url('))).toBe(true);
    expect(container.querySelectorAll('.react-flow__handle')).toHaveLength(0);
    expect(container.querySelectorAll('svg.task-dependency-edges')).toHaveLength(1);
  });

  it('renders complete projected nodes and arrows, preserving status and explicit external predecessors', async () => {
    const { container } = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(4); });
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(5);
    expect(screen.getByText('链内 3 · 外部 2 · 任务 5/5 · 依赖 4/4')).toBeTruthy();
    expect(nodeShell('基础 API').classList.contains('task-node-done')).toBe(true);
    expect(nodeShell('合流实现…').classList.contains('task-node-in_progress')).toBe(true);
    fireEvent.click(nodeButton('合流实现…'));
    expect(nodeShell('合流实现…').classList.contains('task-node-selected')).toBe(true);
    expect(nodeShell('最终验收').classList.contains('task-node-todo')).toBe(true);
    expect(within(nodeButton('最终验收')).getByText('被阻塞')).toBeTruthy();
    expect(within(nodeButton('合流实现…')).queryByText('共享')).toBeNull();
    expect(within(nodeButton('设计方案')).getByText('外部前置')).toBeTruthy();
    expect(nodeShell('设计方案').classList.contains('task-node-done')).toBe(true);
    expect(nodeShell('发布检查').classList.contains('task-node-external')).toBe(true);
    const paths = [...container.querySelectorAll<SVGPathElement>('.react-flow__edge-path')];
    expect(paths.every((path) => path.getAttribute('marker-end')?.startsWith('url('))).toBe(true);
    expect(paths.filter((path) => path.getAttribute('data-external') === 'true')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^独立任务，/ })).toBeNull();
  });

  it('renders direct external context and keeps its details separate from navigation', async () => {
    const completed = graph.tasks[1]!;
    const externalGraph: TaskGraphData = {
      ...graph, summary: { proposed: 0, total: 6, todo: 3, inProgress: 0, done: 3, cancelled: 0, ready: 2, blocked: 1 },
      tasks: [
        graph.tasks[0]!,
        { ...completed, id: 'P', titlePreview: '已完成外部祖先', dependsOn: [] },
        { ...completed, id: 'B', titlePreview: '已完成外部前置', dependsOn: ['P'] },
        { ...graph.tasks[3]!, dependsOn: ['A', 'B'], externalDependsOn: ['B'], blockedBy: [], ready: true },
        { ...graph.tasks[4]!, id: 'X', titlePreview: '外部前置的无关后续', dependsOn: ['B'], blockedBy: [], ready: true },
        { ...graph.tasks[5]!, id: 'Y', dependsOn: ['D'], blockedBy: ['D'], ready: false },
      ],
    };
    const onOpenTask = vi.fn();
    const { container } = render(<TaskGraph index={buildGraphIndex(externalGraph)} rootId="A" onOpenTask={onOpenTask} />);
    await waitFor(() => { expect(container.querySelectorAll('.react-flow__node')).toHaveLength(4); });
    expect(screen.getByText('链内 3 · 外部 1 · 任务 4/4 · 依赖 3/3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /已完成外部祖先/ })).toBeNull();
    expect(nodeButton('已完成外部前置')).toHaveAccessibleName('已完成外部前置，已完成，外部前置');
    expect(screen.queryByRole('button', { name: /外部前置的无关后续/ })).toBeNull();
    const externalRoute = container.querySelector('[data-id="P->B"] .react-flow__edge-path');
    expect(externalRoute).toBeNull();
    expect(container.querySelector('[data-id="P->B"] .task-dependency-paint-piece')).toBeNull();
    fireEvent.click(detailsButton('已完成外部前置'));
    expect(onOpenTask).toHaveBeenCalledWith('B', detailsButton('已完成外部前置'));
    expect(screen.getByText('实线：普通依赖 · 虚线：外部依赖 · 虚线卡片：链外前置')).toBeTruthy();
  });

  it('draws explicit external shortcuts and solid context edges without moving a retained inspection on marker-only refresh', async () => {
    const tasks = [
      { ...graph.tasks[0]!, id: 'A', titlePreview: 'A' },
      { ...graph.tasks[0]!, id: 'X', titlePreview: 'X' },
      { ...graph.tasks[0]!, id: 'Y', titlePreview: 'Y', dependsOn: ['X'] },
      { ...graph.tasks[0]!, id: 'B', titlePreview: 'B', dependsOn: ['A', 'X', 'Y'], externalDependsOn: ['X', 'Y'] },
      { ...graph.tasks[5]!, id: 'C', titlePreview: 'C', dependsOn: ['A', 'B'], externalDependsOn: ['A'] },
    ];
    const snapshot = { ...graph, tasks, summary: { proposed: 0, total: 5, todo: 1, inProgress: 0, done: 4, cancelled: 0, ready: 1, blocked: 0 } };
    const view = render(<TaskGraph index={buildGraphIndex(snapshot)} rootId="A" onOpenTask={noop} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__edge-path')).toHaveLength(6));
    await waitFor(() => expect(viewport(view.container).style.transform).not.toBe('translate(0px,0px) scale(1)'));
    const edge = (id: string) => view.container.querySelector<SVGPathElement>(`[data-id="${id}"] .react-flow__edge-path`)!;
    expect(edge('A->C')).toHaveAttribute('data-external', 'true');
    expect(edge('Y->B')).toHaveAttribute('data-external', 'true');
    expect(edge('X->Y')).toHaveAttribute('data-external', 'false');
    expect(view.container.querySelector('[data-id="A->C"] .task-dependency-paint-piece')).toHaveStyle({ strokeDasharray: '5 4' });
    expect(view.container.querySelector('[data-id="X->Y"] .task-dependency-paint-piece')).toBeNull();
    expect(nodeShell('X')).toHaveClass('task-node-external');
    expect(nodeShell('Y')).toHaveClass('task-node-external');
    expect(nodeShell('C')).not.toHaveClass('task-node-external');
    fireEvent.click(nodeButton('C'));
    expect(nodeButton('C')).toHaveAttribute('aria-pressed', 'true');
    const nodes = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')];
    const geometry = () => ({
      positions: nodes.map((node) => [node.dataset.id, node.style.transform, node.style.width, node.style.height]),
      routes: [...view.container.querySelectorAll<SVGPathElement>('.react-flow__edge-path')].map((path) => [path.closest('[data-id]')!.getAttribute('data-id'), path.getAttribute('d')]),
      viewport: viewport(view.container).style.transform,
    });
    const before = geometry();
    const refreshed = { ...snapshot, tasks: tasks.map((task) => task.id === 'C' ? { ...task, externalDependsOn: [] } : task) };
    view.rerender(<TaskGraph index={buildGraphIndex(refreshed)} rootId="A" onOpenTask={noop} />);
    await waitFor(() => expect(edge('A->C')).toHaveAttribute('data-external', 'false'));
    expect(edge('Y->B')).toHaveAttribute('data-external', 'true');
    expect(edge('X->Y')).toHaveAttribute('data-external', 'false');
    expect([...view.container.querySelectorAll('.react-flow__node')]).toEqual(nodes);
    expect(geometry()).toEqual(before);
    expect(nodeButton('C')).toHaveAttribute('aria-pressed', 'true');
  });

  it('compiles every routed edge in an accessible noninteractive dependency layer', async () => {
    const expected = layoutModule.layoutGraph({ mainIds: new Set(['A', 'C', 'D']), externalIds: new Set(['B', 'F']), edges: [
      { source: 'A', target: 'C', external: false }, { source: 'B', target: 'C', external: true },
      { source: 'C', target: 'D', external: false }, { source: 'F', target: 'D', external: true },
    ] }, new Map([['A', 96], ['B', 136], ['C', 96], ['D', 96], ['F', 136]]));
    const { container } = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge-path')).toHaveLength(expected.edges.length); });
    const actualPaths = [...container.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'));
    expect(actualPaths).toEqual(expected.edges.map((edge) => compileDependencyRoute(edge.points, edge.external).d));
    const svg = container.querySelector('svg.task-dependency-edges')!;
    expect(svg.parentElement).toHaveClass('react-flow__viewport-portal');
    expect(svg.closest('.react-flow__viewport')).toBe(viewport(container));
    expect(svg).toHaveAttribute('width', '100%');
    expect(svg).toHaveAttribute('height', '100%');
    expect(svg).not.toHaveAttribute('viewBox');
    expect(svg).toHaveAttribute('focusable', 'false');
    expect(svg).toHaveAttribute('role', 'group');
    expect(svg).toHaveAttribute('aria-label', '任务依赖关系');
    expect(svg.querySelectorAll('marker')).toHaveLength(3);
    const marker = svg.querySelector('marker')!;
    expect(marker).toHaveAttribute('markerWidth', '16');
    expect(marker).toHaveAttribute('markerHeight', '16');
    expect(marker).toHaveAttribute('viewBox', '-10 -10 20 20');
    expect(marker).toHaveAttribute('orient', 'auto-start-reverse');
    expect(marker).toHaveAttribute('markerUnits', 'strokeWidth');
    const relations = [...svg.querySelectorAll('g.task-dependency-edge')];
    expect(relations).toHaveLength(expected.edges.length);
    relations.forEach((relation, position) => {
      const edge = expected.edges[position]!;
      expect(relation).toHaveAttribute('data-id', edge.id);
      expect(relation).toHaveAttribute('role', 'img');
      expect(relation).toHaveAttribute('aria-label', `${edge.external ? '外部依赖' : '普通依赖'}：前置任务 ${edge.source} → 后续任务 ${edge.target}`);
      expect(relation).toHaveAttribute('focusable', 'false');
      expect(relation).not.toHaveAttribute('tabindex');
      expect(relation.querySelectorAll('a,button,[tabindex]')).toHaveLength(0);
      const path = relation.querySelector('path.react-flow__edge-path')!;
      expect(path).toHaveAttribute('data-source', edge.source);
      expect(path).toHaveAttribute('data-target', edge.target);
      expect(path).toHaveAttribute('aria-hidden', 'true');
      expect(path).toHaveAttribute('marker-end', `url(#${marker.id})`);
    });
  });

  it('paints complete dashed bodies before their canonical native arrow paths without changing solid edges', () => {
    const geometry = layoutModule.layoutGraph(projectChain(index, 'A'));
    const original = geometry.edges.map((edge) => ({
      ...edge, points: [{ x: 10, y: 20 }, { x: 1010, y: 20 }, { x: 1074, y: 1020 }, { x: 2074, y: 1020 }],
    }));
    vi.spyOn(layoutModule, 'layoutGraph').mockReturnValue({ ...geometry, edges: original });
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    const svg = view.container.querySelector('svg.task-dependency-edges')!;
    const allPieces = [...svg.querySelectorAll<SVGElement>('.task-dependency-paint-piece')];
    expect(Number(svg.getAttribute('data-paint-piece-count'))).toBe(allPieces.length);
    expect(allPieces.length).toBeGreaterThan(0);
    for (const edge of original) {
      const relation = svg.querySelector(`[data-id="${edge.id}"]`)!;
      const canonical = relation.querySelector<SVGPathElement>('.react-flow__edge-path')!;
      const pieces = [...relation.querySelectorAll<SVGElement>('.task-dependency-paint-piece')];
      expect(relation.querySelector('.task-dependency-body')!.lastElementChild).toBe(canonical);
      expect(canonical.getAttribute('d')).toBe(compileDependencyRoute(edge.points, edge.external).d);
      expect(canonical.getAttribute('d')).toContain('C');
      expect(canonical.style.strokeWidth).toBe('1.5');
      expect(canonical.style.stroke).toBe(edge.external ? 'none' : 'inherit');
      expect(canonical.getAttribute('marker-end')).toBe(`url(#${svg.querySelector('marker')!.id})`);
      if (!edge.external) {
        expect(pieces).toHaveLength(0);
        expect(canonical.style.strokeDasharray).toBe('');
        continue;
      }
      expect(relation.querySelector('.task-dependency-body')).toHaveAttribute('stroke', '#abb2c7');
      expect(pieces.some((piece) => piece.tagName === 'line')).toBe(true);
      expect(pieces.some((piece) => piece.tagName === 'path')).toBe(true);
      for (const piece of pieces) {
        expect(piece).toHaveAttribute('data-piece-kind', piece.tagName);
        expect(piece).toHaveAttribute('aria-hidden', 'true');
        expect(piece).toHaveAttribute('focusable', 'false');
        expect(piece.style.pointerEvents).toBe('none');
        expect(piece.style.stroke).toBe('inherit');
        expect(piece.style.strokeWidth).toBe('1.5');
        expect(piece.style.strokeDasharray).toBe('5 4');
        expect(piece.style.strokeLinecap).toBe('butt');
        expect(piece.style.strokeLinejoin).toBe('miter');
        expect(piece.style.fill).toBe('none');
        expect(piece).not.toHaveAttribute('marker-end');
        expect(piece).not.toHaveAttribute('tabindex');
        if (piece.tagName === 'line') {
          expect(piece).toHaveAttribute('x1', '0');
          expect(piece).toHaveAttribute('y1', '0');
          expect(piece).toHaveAttribute('y2', '0');
          expect(Number(piece.getAttribute('x2'))).toBeGreaterThan(0);
          expect(piece.getAttribute('transform')).toMatch(/^matrix\([^)]*\)$/);
        } else expect(piece.getAttribute('d')).toMatch(/^M/);
      }
    }
    const children = [...svg.querySelectorAll('g.task-dependency-edge > *')];
    fireEvent.click(nodeButton('合流实现…'));
    expect(view.container.querySelector('svg.task-dependency-edges')).toBe(svg);
    expect([...svg.querySelectorAll('g.task-dependency-edge > *')]).toEqual(children);
    children.forEach((child, position) => { expect(svg.querySelectorAll('g.task-dependency-edge > *')[position]).toBe(child); });
  });

  it('keeps dependency paths in the node viewport during zoom and updates them from new snapshots', async () => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    const svg = view.container.querySelector('svg.task-dependency-edges')!;
    const paths = [...svg.querySelectorAll('path.react-flow__edge-path')];
    const initialPaths = paths.map((path) => path.getAttribute('d'));
    const beforeZoom = viewport(view.container).style.transform;
    fireEvent.click(viewportActions(view.container).getByRole('button', { name: '放大' }));
    await waitFor(() => { expect(viewport(view.container).style.transform).not.toBe(beforeZoom); });
    expect(view.container.querySelector('svg.task-dependency-edges')).toBe(svg);
    paths.forEach((path, position) => { expect(svg.querySelectorAll('path.react-flow__edge-path')[position]).toBe(path); });
    expect(paths.map((path) => path.getAttribute('d'))).toEqual(initialPaths);
    expect(svg.closest('.react-flow__viewport')).toBe(viewport(view.container));
    expect(view.container.querySelector('.react-flow__nodes')!.parentElement).toBe(viewport(view.container));

    const updated = buildGraphIndex({
      ...graph,
      tasks: graph.tasks.map((task) => task.id === 'D' ? { ...task, dependsOn: ['C'], externalDependsOn: [], blockedBy: ['C'] } : task),
    });
    const expected = layoutModule.layoutGraph(projectChain(updated, 'A'), new Map([['A', 96], ['B', 136], ['C', 96], ['D', 96]]));
    const retainedPath = svg.querySelector('[data-id="A->C"] path');
    view.rerender(<TaskGraph index={updated} rootId="A" onOpenTask={noop} />);
    await waitFor(() => { expect(svg.querySelectorAll('.react-flow__edge-path')).toHaveLength(3); });
    expect(view.container.querySelector('svg.task-dependency-edges')).toBe(svg);
    expect(svg.querySelector('[data-id="A->C"] path')).toBe(retainedPath);
    expect([...svg.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'))).toEqual(
      expected.edges.map((edge) => compileDependencyRoute(edge.points, edge.external).d),
    );
    expected.nodes.forEach((node) => {
      expect(view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${node.id}"]`)!.style.transform).toBe(`translate(${node.position.x}px,${node.position.y}px)`);
    });
  });

  it('opens independent Details once using mouse, Enter, or Space and returns the actual native trigger', async () => {
    const user = userEvent.setup();
    const onOpenTask = vi.fn();
    render(<TaskGraph index={index} rootId="A" onOpenTask={onOpenTask} />);
    const button = detailsButton('合流实现…');
    await user.click(button);
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('C', button);
    onOpenTask.mockClear();
    button.focus();
    await user.keyboard('{Enter}');
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('C', button);
    onOpenTask.mockClear();
    await user.keyboard(' ');
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith('C', button);
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('keeps wrapper nodes and edges out of the tab order and exposes only read-only viewport controls', async () => {
    const { container } = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(4); });
    for (const node of container.querySelectorAll('.react-flow__node')) {
      expect(node.getAttribute('tabindex')).toBeNull();
      expect(node.classList.contains('draggable')).toBe(false);
      expect(node.classList.contains('selectable')).toBe(false);
      expect(node.querySelectorAll('button')).toHaveLength(node.querySelector('.task-node-external') === null ? 2 : 3);
    }
    for (const edge of container.querySelectorAll('.react-flow__edge')) {
      expect(edge.getAttribute('tabindex')).toBeNull();
      expect(edge.classList.contains('selectable')).toBe(false);
    }
    expect(container.querySelector('.react-flow__controls-interactive')).toBeNull();
    expect(container.querySelectorAll('.react-flow__handle.connectable')).toHaveLength(0);
    expect(viewportActions(container).getByRole('button', { name: '放大' })).toBeTruthy();
    expect(viewportActions(container).getByRole('button', { name: '缩小' })).toBeTruthy();
    expect(viewportActions(container).getByRole('button', { name: '适应画布' })).toBeTruthy();
    expect(within(container.querySelector<HTMLElement>('.react-flow__attribution')!).getByRole('link', { name: 'React Flow attribution' }).getAttribute('href')).toContain('reactflow.dev');
  });

  it('zooms and fits without recomputing layout, and applies selected styling without moving nodes', async () => {
    const spy = vi.spyOn(layoutModule, 'layoutGraph');
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    const timings = performance.getEntriesByName('daynight:task-layout') as PerformanceMeasure[];
    expect(timings).toHaveLength(1);
    expect(timings[0]!.detail).toEqual({ rootId: 'A' });
    expect(timings[0]!.duration).toBeGreaterThanOrEqual(0);
    const initialZoom = zoom(view.container);
    const positions = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.style.transform);
    fireEvent.click(viewportActions(view.container).getByRole('button', { name: '放大' }));
    await waitFor(() => { expect(zoom(view.container)).toBeGreaterThan(initialZoom); });
    fireEvent.click(viewportActions(view.container).getByRole('button', { name: '缩小' }));
    await waitFor(() => { expect(zoom(view.container)).toBeLessThan(1.2 * initialZoom); });
    fireEvent.click(viewportActions(view.container).getByRole('button', { name: '适应画布' }));
    await waitFor(() => { expect(zoom(view.container)).toBeLessThanOrEqual(1); });
    expect(zoom(view.container)).toBeGreaterThanOrEqual(0.2);
    const userViewport = viewport(view.container).style.transform;
    fireEvent.click(nodeButton('最终验收'));
    expect(nodeShell('最终验收').classList.contains('task-node-selected')).toBe(true);
    expect([...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.style.transform)).toEqual(positions);
    expect(viewport(view.container).style.transform).toBe(userViewport);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(performance.getEntriesByName('daynight:task-layout')).toEqual(timings);
  });

  it('updates inspection through context while retaining controlled nodes and geometry', async () => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    const originalButtons = [...view.container.querySelectorAll('.task-node')];
    const originalPaths = [...view.container.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'));
    const expectStableTasks = () => {
      expect(taskRenders).not.toHaveBeenCalled();
      const buttons = [...view.container.querySelectorAll('.task-node')];
      const paths = [...view.container.querySelectorAll('.react-flow__edge-path')];
      expect(buttons).toHaveLength(originalButtons.length);
      expect(paths).toHaveLength(originalPaths.length);
      buttons.forEach((button, position) => { expect(button).toBe(originalButtons[position]); });
      expect(paths.map((path) => path.getAttribute('d'))).toEqual(originalPaths);
    };

    taskRenders.mockClear();
    fireEvent.click(nodeButton('合流实现…'));
    await waitFor(() => { expect(nodeShell('合流实现…')).toHaveClass('task-node-selected'); });
    expectStableTasks();

    taskRenders.mockClear();
    fireEvent.click(nodeButton('最终验收'));
    await waitFor(() => { expect(nodeShell('最终验收')).toHaveClass('task-node-selected'); });
    expect(nodeShell('合流实现…')).not.toHaveClass('task-node-selected');
    expectStableTasks();

    taskRenders.mockClear();
    fireEvent.click(nodeButton('最终验收'));
    await waitFor(() => { expect(nodeShell('最终验收')).not.toHaveClass('task-node-selected'); });
    expectStableTasks();
  });

  it('starts a long chain at readable zoom and lets the fit control reveal more of it', async () => {
    const tasks = Array.from({ length: 10 }, (_, position) => ({
      ...graph.tasks[0]!, id: `N${position}`, titlePreview: `任务 ${position}`, status: 'todo' as const,
      dependsOn: position === 0 ? [] : [`N${position - 1}`],
      blockedBy: position === 0 ? [] : [`N${position - 1}`], ready: position === 0,
    }));
    const longChain = buildGraphIndex({ ...graph, tasks, summary: { proposed: 0, total: 10, todo: 10, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 9 } });
    const { container } = render(<TaskGraph index={longChain} rootId="N0" onOpenTask={noop} />);
    await waitFor(() => { expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(9); });
    await waitFor(() => { expect(zoom(container)).toBe(0.8); });
    const transform = /translate\(([^,]+)px,\s*([^)]+)px\)/.exec(viewport(container).style.transform)!;
    const source = container.querySelector<HTMLElement>('.react-flow__node[data-id="N0"]')!;
    const sourcePosition = /translate\(([^,]+)px,\s*([^)]+)px\)/.exec(source.style.transform)!;
    const sourceLeft = Number(sourcePosition[1]) * zoom(container) + Number(transform[1]);
    const sourceTop = Number(sourcePosition[2]) * zoom(container) + Number(transform[2]);
    expect(sourceLeft).toBeGreaterThanOrEqual(0);
    expect(sourceLeft + layoutModule.TASK_NODE_WIDTH * zoom(container)).toBeLessThanOrEqual(800);
    expect(sourceTop).toBeGreaterThanOrEqual(0);
    expect(sourceTop + layoutModule.TASK_NODE_COMPACT_HEIGHT * zoom(container)).toBeLessThanOrEqual(445);
    fireEvent.click(viewportActions(container).getByRole('button', { name: '适应画布' }));
    await waitFor(() => { expect(zoom(container)).toBeLessThan(0.8); });
    expect(zoom(container)).toBeGreaterThanOrEqual(0.2);
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(10);
  });

  it.each(['body', 'details'])('reveals an offscreen keyboard-focused %s despite temporary native focus scrolling', async (control) => {
    const tasks = Array.from({ length: 10 }, (_, position) => ({
      ...graph.tasks[0]!, id: `N${position}`, titlePreview: `任务 ${position}`, status: 'todo' as const,
      dependsOn: position === 0 ? [] : [`N${position - 1}`],
      blockedBy: position === 0 ? [] : [`N${position - 1}`], ready: position === 0,
    }));
    const longChain = buildGraphIndex({ ...graph, tasks, summary: { proposed: 0, total: 10, todo: 10, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 9 } });
    const view = render(<TaskGraph index={longChain} rootId="N0" onOpenTask={noop} />);
    await waitFor(() => { expect(zoom(view.container)).toBe(0.8); });
    const button = control === 'body' ? nodeButton('任务 9') : detailsButton('任务 9');
    const focused = vi.spyOn(button, 'matches').mockReturnValue(false);
    const before = viewport(view.container).style.transform;
    fireEvent.focus(button);
    expect(viewport(view.container).style.transform).toBe(before);
    const flow = view.container.querySelector<HTMLElement>('.react-flow')!;
    flow.scrollLeft = 2000;
    Object.defineProperty(flow, 'scrollTo', { value: (options: ScrollToOptions) => { flow.scrollLeft = options.left!; flow.scrollTop = options.top!; }, configurable: true });
    Object.defineProperty(button.closest('.task-node')!, 'getBoundingClientRect', { value: () => new DOMRect(20, 20, layoutModule.TASK_NODE_WIDTH, layoutModule.TASK_NODE_COMPACT_HEIGHT), configurable: true });
    const beforeZoom = zoom(view.container);
    focused.mockImplementation((selector) => selector === ':focus-visible');
    fireEvent.focus(button);
    fireEvent.scroll(flow);
    await waitFor(() => { expect(viewport(view.container).style.transform).not.toBe(before); });
    expect(flow.scrollLeft).toBe(0);
    expect(zoom(view.container)).toBe(beforeZoom);
    const nodePosition = /translate\(([^,]+)px,\s*([^)]+)px\)/.exec(button.closest<HTMLElement>('.react-flow__node')!.style.transform)!;
    const currentViewport = /translate\(([^,]+)px,\s*([^)]+)px\)/.exec(viewport(view.container).style.transform)!;
    expect(Number(currentViewport[1]) + (Number(nodePosition[1]) + 110) * beforeZoom).toBeCloseTo(400);
    expect(Number(currentViewport[2]) + (Number(nodePosition[2]) + 48) * beforeZoom).toBeCloseTo(222.5);
  });

  it.each(['body', 'details'])('keeps the intended viewport stable for an already visible keyboard-focused %s', async (control) => {
    const view = render(<TaskGraph index={index} rootId="A" onOpenTask={noop} />);
    await ready(view.container);
    const button = control === 'body' ? nodeButton('基础 API') : detailsButton('基础 API');
    vi.spyOn(button, 'matches').mockImplementation((selector) => selector === ':focus-visible');
    const before = viewport(view.container).style.transform;
    fireEvent.focus(button);
    expect(viewport(view.container).style.transform).toBe(before);
  });

  it('shows layout failures explicitly without pretending there are zero tasks', () => {
    render(<TaskGraph index={index} rootId="missing-root" onOpenTask={noop} />);
    expect(screen.getByRole('alert').textContent).toContain('任务图布局失败');
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.queryByText(/0 个节点/)).toBeNull();
  });
});

describe('progressive task visibility', () => {
  const fixture = progressiveGraph;
  const progressiveIndex = buildGraphIndex(fixture);
  const rootId = fixture.tasks.find((task) => task.titlePreview === '渐进展开 · 主链交付起点')!.id;
  const joinId = fixture.tasks.find((task) => task.titlePreview === '合流任务 · 40 个外部前置')!.id;
  const visibleIds = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.dataset.id!);
  const taskIds = new Map(fixture.tasks.map((task) => [task.titlePreview, task.id]));
  const controls = (container: HTMLElement) => {
    const scope = within(container);
    const taskShell = (title: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${taskIds.get(title)!}"] .task-node`)!;
    const taskBody = (title: string) => within(taskShell(title)).getByRole('button', { name: new RegExp(`^${title}，(?!详情$)`) });
    const taskDetails = (title: string) => within(taskShell(title)).getByRole('button', { name: `${title}，详情` });
    const expansion = (title: string, direction: string) => taskShell(title).querySelector<HTMLButtonElement>(`.task-node-expand[data-direction="${direction}"]`)!;
    const resetControl = () => toolbarActions(container).getByRole('button', { name: '收起到概览' });
    return { scope, taskShell, taskBody, taskDetails, expansion, resetControl };
  };
  const rendered = async (container: HTMLElement, nodes: number, edges: number) => {
    await waitFor(() => {
      expect(container.querySelectorAll('.react-flow__node').length).toBe(nodes);
      expect(container.querySelectorAll('.react-flow__edge-path').length).toBe(edges);
    });
  };

  it('shows a bounded root overview with full counts and independent inspection and Details without changing visibility', async () => {
    const open = vi.fn();
    const layout = vi.spyOn(layoutModule, 'layoutGraph');
    const view = render(<TaskGraph index={progressiveIndex} rootId={rootId} onOpenTask={open} />);
    const { scope, taskShell, taskBody, taskDetails } = controls(view.container);
    await rendered(view.container, 50, 49);
    const initialIds = visibleIds(view.container);
    const positions = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.style.transform);
    const routes = [...view.container.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'));
    const transform = viewport(view.container).style.transform;
    expect(scope.getByText('链内 61 · 外部 40 · 任务 50/101 · 依赖 49/100')).toBeTruthy();
    expect(view.container.querySelector('.task-graph')).toHaveAttribute('data-visible-task-count', '50');
    expect(view.container.querySelector('.task-graph')).toHaveAttribute('data-total-task-count', '101');
    const body = taskBody('合流任务 · 40 个外部前置');
    expect(body.parentElement).toBe(taskShell('合流任务 · 40 个外部前置'));
    expect(body).not.toHaveAttribute('aria-haspopup');
    expect(body).toHaveAttribute('aria-pressed', 'false');
    expect(body.querySelector('button')).toBeNull();
    fireEvent.click(body);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(taskDetails('合流任务 · 40 个外部前置'));
    expect(open).toHaveBeenCalledExactlyOnceWith(joinId, taskDetails('合流任务 · 40 个外部前置'));
    expect(taskShell('合流任务 · 40 个外部前置')).toHaveClass('task-node-selected');
    expect(visibleIds(view.container)).toEqual(initialIds);
    expect([...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.style.transform)).toEqual(positions);
    expect([...view.container.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'))).toEqual(routes);
    expect(viewport(view.container).style.transform).toBe(transform);
    expect(layout).toHaveBeenCalledTimes(1);
  });

  it('keeps expanded tasks and inspection when the direction changes', async () => {
    const Example = () => {
      const [direction, setDirection] = useState<'horizontal' | 'vertical'>('horizontal');
      return <TaskGraph index={progressiveIndex} rootId={rootId} onOpenTask={noop} direction={direction} onDirectionChange={setDirection} />;
    };
    const view = render(<Example />);
    const { taskBody, expansion } = controls(view.container);
    await rendered(view.container, 50, 49);
    fireEvent.click(expansion('合流任务 · 40 个外部前置', 'prerequisites'));
    await rendered(view.container, 70, 69);
    fireEvent.click(taskBody('合流任务 · 40 个外部前置'));
    const ids = visibleIds(view.container);
    const canvas = view.container.querySelector('.react-flow');
    const vertical = toolbarActions(view.container).getByRole('radio', { name: '垂直' });
    const horizontal = toolbarActions(view.container).getByRole('radio', { name: '水平' });
    fireEvent.click(vertical);
    expect(vertical).toHaveAttribute('aria-checked', 'true');
    expect(visibleIds(view.container)).toEqual(ids);
    expect(taskBody('合流任务 · 40 个外部前置')).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector('.react-flow')).toBe(canvas);
    fireEvent.click(horizontal);
    expect(visibleIds(view.container)).toEqual(ids);
  });

  it('expands direct neighbors with exact task, induced-edge and remaining counts, retains keyboard anchor focus, and resets deterministically', async ({ signal }) => {
    const user = userEvent.setup();
    const open = vi.fn();
    const view = render(<TaskGraph index={progressiveIndex} rootId={rootId} onOpenTask={open} />);
    const { taskShell, taskBody, expansion, resetControl } = controls(view.container);
    await rendered(view.container, 50, 49);
    await waitFor(() => { expect(zoom(view.container)).toBe(0.8); });
    const joinBody = taskBody('合流任务 · 40 个外部前置');
    const rootBody = taskBody('渐进展开 · 主链交付起点');
    const joinCard = taskShell('合流任务 · 40 个外部前置');
    const rootCard = taskShell('渐进展开 · 主链交付起点');
    const reset = resetControl();
    const initialIds = visibleIds(view.container);
    const initialRoutes = [...view.container.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'));
    const initialViewport = viewport(view.container).style.transform;
    const upstream = expansion('合流任务 · 40 个外部前置', 'prerequisites');
    expect(upstream.closest<HTMLElement>('.react-flow__node')!.style.height).toBe('136px');
    expect(joinCard.querySelector('.task-node-expansions')?.children).toHaveLength(2);
    expect(joinCard.querySelectorAll('.task-node-expand')).toHaveLength(1);
    expect(upstream).toHaveAttribute('data-added-tasks', '20');
    expect(upstream).toHaveAttribute('data-added-edges', '20');
    expect(upstream).toHaveAttribute('data-remaining', '20');
    expect(upstream).toHaveAccessibleName('展开前置 20 个任务、20 条依赖，剩余 20 个前置未展开');
    signal.throwIfAborted();
    upstream.focus();
    await user.keyboard('{Enter}');
    await rendered(view.container, 70, 69);
    await waitFor(() => { expect(joinBody).toHaveFocus(); });
    expect(zoom(view.container)).toBe(0.8);
    expect(open).not.toHaveBeenCalled();
    const downstream = expansion('渐进展开 · 主链交付起点', 'successors');
    expect(downstream).toHaveAttribute('data-added-tasks', '11');
    expect(downstream).toHaveAttribute('data-added-edges', '11');
    expect(downstream).toHaveAttribute('data-remaining', '0');
    fireEvent.click(downstream);
    await rendered(view.container, 81, 80);
    await waitFor(() => { expect(rootBody).toHaveFocus(); });
    expect(rootCard.querySelector('.task-node-expansions')).toBeNull();
    expect(rootBody.closest<HTMLElement>('.react-flow__node')!.style.height).toBe('96px');
    fireEvent.click(expansion('合流任务 · 40 个外部前置', 'prerequisites'));
    await rendered(view.container, 101, 100);
    expect(view.container.querySelectorAll('.task-node-expand[data-direction]')).toHaveLength(0);
    expect(view.container.querySelectorAll('.task-node-navigate')).toHaveLength(40);
    expect(view.container.querySelectorAll('.task-node-expansions')).toHaveLength(40);
    await waitFor(() => { expect(joinBody).toHaveFocus(); });
    for (const node of view.container.querySelectorAll<HTMLElement>('.react-flow__node')) expect(node.style.height).toBe(node.querySelector('.task-node-external') === null ? '96px' : '136px');
    expect(progressiveIndex.components.get(rootId)!.progress).toEqual({ total: 61, done: 0, cancelled: 0, ended: 0, status: 'todo' });
    signal.throwIfAborted();
    await user.click(reset);
    await rendered(view.container, 50, 49);
    expect(reset).toHaveFocus();
    expect(expansion('合流任务 · 40 个外部前置', 'prerequisites').closest<HTMLElement>('.react-flow__node')!.style.height).toBe('136px');
    expect(visibleIds(view.container)).toEqual(initialIds);
    expect([...view.container.querySelectorAll('.react-flow__edge-path')].map((path) => path.getAttribute('d'))).toEqual(initialRoutes);
    expect(viewport(view.container).style.transform).toBe(initialViewport);
    expect(open).not.toHaveBeenCalled();
  });

  it('retains actual visible IDs through content refresh without filling a new overview or stealing focus from details', async () => {
    const view = render(<><button type="button">详情关闭控件</button><TaskGraph index={progressiveIndex} rootId={rootId} onOpenTask={noop} /></>);
    const { scope, taskShell, taskBody, expansion, resetControl } = controls(view.container);
    await rendered(view.container, 50, 49);
    fireEvent.click(taskBody('合流任务 · 40 个外部前置'));
    fireEvent.click(expansion('合流任务 · 40 个外部前置', 'prerequisites'));
    await rendered(view.container, 70, 69);
    const retainedIds = visibleIds(view.container);
    const sourcePosition = fixture.tasks.findIndex((task) => task.id === rootId);
    const revised = { ...fixture.tasks[sourcePosition + 2]!, titlePreview: '更新后的直接后续' };
    const refreshed = buildGraphIndex({ ...fixture, tasks: fixture.tasks.map((task) => task.id === revised.id ? revised : task) });
    const outside = scope.getByRole('button', { name: '详情关闭控件' });
    outside.focus();
    const transform = viewport(view.container).style.transform;
    view.rerender(<><button type="button">详情关闭控件</button><TaskGraph index={refreshed} rootId={rootId} onOpenTask={noop} /></>);
    await rendered(view.container, 70, 69);
    expect(visibleIds(view.container)).toEqual(retainedIds);
    expect(within(view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${revised.id}"]`)!).getByRole('button', { name: '更新后的直接后续，待处理，被阻塞，不在所选依赖路径中' })).toBeTruthy();
    expect(outside).toHaveFocus();
    expect(viewport(view.container).style.transform).toBe(transform);
    expect(taskShell('合流任务 · 40 个外部前置')).toHaveClass('task-node-selected');
    const reset = resetControl();
    fireEvent.click(reset);
    await rendered(view.container, 50, 49);
    expect(within(view.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${revised.id}"]`)!).getByRole('button', { name: '更新后的直接后续，待处理，被阻塞，不在所选依赖路径中' })).toBeTruthy();
    expect(reset).toHaveFocus();
  });

  it('rebuilds the bounded overview when chain membership changes while keeping focus in an open detail', async () => {
    const view = render(<><button type="button">详情关闭控件</button><TaskGraph index={progressiveIndex} rootId={rootId} onOpenTask={noop} /></>);
    const { scope, taskBody, expansion } = controls(view.container);
    await rendered(view.container, 50, 49);
    fireEvent.click(taskBody('合流任务 · 40 个外部前置'));
    fireEvent.click(expansion('合流任务 · 40 个外部前置', 'prerequisites'));
    await rendered(view.container, 70, 69);
    const previousCanvas = view.container.querySelector('.task-graph-canvas');
    const sourcePosition = fixture.tasks.findIndex((task) => task.id === rootId);
    const addition = { ...fixture.tasks[sourcePosition + 2]!, id: 'new-main', titlePreview: '新增直接后续' };
    const refreshed = buildGraphIndex({ ...fixture, tasks: [...fixture.tasks.slice(0, sourcePosition + 1), addition, ...fixture.tasks.slice(sourcePosition + 1)], summary: { ...fixture.summary, total: 102, todo: 62, blocked: 61 } });
    const outside = scope.getByRole('button', { name: '详情关闭控件' });
    outside.focus();
    view.rerender(<><button type="button">详情关闭控件</button><TaskGraph index={refreshed} rootId={rootId} onOpenTask={noop} /></>);
    await rendered(view.container, 50, 49);
    expect(view.container.querySelector('.task-graph-canvas')).toBe(previousCanvas);
    expect(view.container.querySelectorAll('.task-node-selected')).toHaveLength(0);
    expect(within(view.container.querySelector<HTMLElement>('.react-flow__node[data-id="new-main"]')!).getByRole('button', { name: '新增直接后续，待处理，被阻塞' })).toBeTruthy();
    expect(outside).toHaveFocus();
  });

  it('recovers graph focus when refresh removes a focused visible card', async () => {
    const view = render(<TaskGraph index={progressiveIndex} rootId={rootId} onOpenTask={noop} />);
    const { taskBody, expansion, resetControl } = controls(view.container);
    await rendered(view.container, 50, 49);
    fireEvent.click(expansion('合流任务 · 40 个外部前置', 'prerequisites'));
    await rendered(view.container, 70, 69);
    const removedId = fixture.tasks.find((task) => task.titlePreview === '外部前置 1 · 已完成共享协议')!.id;
    taskBody('外部前置 1 · 已完成共享协议').focus();
    const tasks = fixture.tasks.filter((task) => task.id !== removedId).map((task) => ({ ...task, dependsOn: task.dependsOn.filter((id) => id !== removedId), externalDependsOn: task.externalDependsOn.filter((id) => id !== removedId) }));
    const refreshed = buildGraphIndex({ ...fixture, tasks, summary: { ...fixture.summary, total: 100, done: 39 } });
    view.rerender(<TaskGraph index={refreshed} rootId={rootId} onOpenTask={noop} />);
    await rendered(view.container, 69, 68);
    expect(resetControl()).toHaveFocus();
  });

  it('reveals an offscreen expansion control using intended viewport coordinates before native scroll resets', async () => {
    const view = render(<TaskGraph index={progressiveIndex} rootId={rootId} onOpenTask={noop} />);
    const { expansion } = controls(view.container);
    await rendered(view.container, 50, 49);
    await waitFor(() => { expect(zoom(view.container)).toBe(0.8); });
    const button = expansion('合流任务 · 40 个外部前置', 'prerequisites');
    vi.spyOn(button, 'matches').mockImplementation((selector) => selector === ':focus-visible');
    const flow = view.container.querySelector<HTMLElement>('.react-flow')!;
    flow.scrollLeft = 2000;
    Object.defineProperty(flow, 'scrollTo', { value: (options: ScrollToOptions) => { flow.scrollLeft = options.left!; flow.scrollTop = options.top!; }, configurable: true });
    Object.defineProperty(button, 'getBoundingClientRect', { value: () => new DOMRect(20, 20, layoutModule.TASK_NODE_WIDTH, layoutModule.TASK_NODE_COMPACT_HEIGHT), configurable: true });
    const before = viewport(view.container).style.transform;
    fireEvent.focus(button);
    fireEvent.scroll(flow);
    await waitFor(() => { expect(viewport(view.container).style.transform).not.toBe(before); });
    expect(flow.scrollLeft).toBe(0);
    expect(zoom(view.container)).toBe(0.8);
  });
});

describe('initial task viewport policy', () => {
  it('frames the first vertical rank using its centers even with mixed card heights', () => {
    const geometry: layoutModule.CanvasLayout = {
      direction: 'vertical',
      nodes: [
        { id: 'root', kind: 'main', width: 220, height: 96, position: { x: 300, y: 52 } },
        { id: 'peer', kind: 'external', width: 220, height: 136, position: { x: 32, y: 32 } },
        { id: 'tail', kind: 'main', width: 220, height: 96, position: { x: 300, y: 5000 } },
      ], edges: [], width: 552, height: 5128,
    };
    const actual = getInitialTaskViewport(geometry, 'root', 800, 445);
    expect(actual.zoom).toBe(0.8);
    expect((300 + 110) * actual.zoom + actual.x).toBeCloseTo(400);
    expect(32 * actual.zoom + actual.y).toBe(32);
    const folded = getInitialTaskViewport(geometry, 'root', 800, 445, true);
    expect(52 * folded.zoom + folded.y).toBe(32);
    expect((300 + 110) * folded.zoom + folded.x).toBeCloseTo(400);
  });

  it('frames upstream vertical context before a later root', () => {
    const geometry: layoutModule.CanvasLayout = {
      direction: 'vertical',
      nodes: [
        { id: 'root', kind: 'main', width: 220, height: 96, position: { x: 800, y: 5000 } },
        { id: 'external', kind: 'external', width: 220, height: 96, position: { x: 32, y: 32 } },
      ], edges: [], width: 1052, height: 5128,
    };
    const actual = getInitialTaskViewport(geometry, 'root', 320, 445);
    expect(32 * actual.zoom + actual.x).toBe(32);
    expect(32 * actual.zoom + actual.y).toBe(32);
  });

  it('fits and centers the actual mixed-height card bounds', () => {
    const geometry: layoutModule.CanvasLayout = {
      nodes: [
        { id: 'root', kind: 'main', width: 220, height: 96, position: { x: 32, y: 32 } },
        { id: 'expandable', kind: 'main', width: 220, height: 136, position: { x: 316, y: 180 } },
      ], edges: [], width: 568, height: 348,
    };
    const actual = getInitialTaskViewport(geometry, 'root', 800, 445);
    const top = 32 * actual.zoom + actual.y;
    const bottom = (180 + 136) * actual.zoom + actual.y;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(445);
    expect((top + bottom) / 2).toBeCloseTo(222.5);
  });

  it('centers a fitting graph normally rather than anchoring every root to the left', () => {
    const geometry = layoutModule.layoutGraph({ mainIds: new Set(['root']), externalIds: new Set(), edges: [] });
    const actual = getInitialTaskViewport(geometry, 'root', 800, 445);
    const root = geometry.nodes[0]!;
    expect(actual.zoom).toBeGreaterThanOrEqual(0.8);
    expect(actual.zoom).toBeLessThanOrEqual(1);
    expect(root.position.x * actual.zoom + actual.x).toBeGreaterThan(32);
    expect((root.position.x + layoutModule.TASK_NODE_WIDTH / 2) * actual.zoom + actual.x).toBeCloseTo(400);
    expect((root.position.y + layoutModule.TASK_NODE_COMPACT_HEIGHT / 2) * actual.zoom + actual.y).toBeCloseTo(222.5);
  });

  it.each([320, 800])('starts with the complete leftmost upstream region when it lies before the root at width %s', (width) => {
    const geometry: layoutModule.CanvasLayout = {
      nodes: [
        { id: 'root', kind: 'main', width: 220, height: 96, position: { x: 20000, y: 12000 } },
        { id: 'later-upstream', kind: 'external', width: 220, height: 136, position: { x: 32, y: 9000 } },
        { id: 'first-upstream', kind: 'external', width: 220, height: 136, position: { x: 32, y: 2000 } },
        { id: 'tail', kind: 'main', width: 220, height: 96, position: { x: 20284, y: 12000 } },
      ], edges: [], width: 20536, height: 13000,
    };
    const actual = getInitialTaskViewport(geometry, 'root', width, 445);
    expect(actual.zoom).toBe(0.8);
    expect(32 * actual.zoom + actual.x).toBe(32);
    expect(2000 * actual.zoom + actual.y).toBe(32);
    expect((32 + layoutModule.TASK_NODE_WIDTH) * actual.zoom + actual.x).toBeLessThan(width);
    expect((2000 + geometry.nodes.find((node) => node.id === 'first-upstream')!.height) * actual.zoom + actual.y).toBeLessThan(445);
  });

  it.each([
    ['wide', 20000, 6000],
    ['tall', 32, 20000],
  ])('keeps the source root visible when readable zoom cannot contain the %s bounds', (_kind, tailX, tailY) => {
    const geometry: layoutModule.CanvasLayout = {
      nodes: [
        { id: 'root', kind: 'main', width: 220, height: 96, position: { x: 32, y: 6000 } },
        { id: 'tail', kind: 'main', width: 220, height: 96, position: { x: tailX, y: tailY } },
      ], edges: [], width: tailX + 252, height: tailY + 6128,
    };
    const actual = getInitialTaskViewport(geometry, 'root', 800, 445);
    expect(actual.zoom).toBe(0.8);
    expect(32 * actual.zoom + actual.x).toBe(32);
    expect((6000 + layoutModule.TASK_NODE_COMPACT_HEIGHT / 2) * actual.zoom + actual.y).toBeCloseTo(222.5);
  });
  it('anchors a folded overview to its root even when visible prerequisites are far to the left', () => {
    const geometry: layoutModule.CanvasLayout = {
      nodes: [
        { id: 'upstream', kind: 'external', width: 220, height: 136, position: { x: 32, y: 32 } },
        { id: 'root', kind: 'main', width: 220, height: 136, position: { x: 20000, y: 4000 } },
      ],
      edges: [], width: 20252, height: 4168,
    };
    for (const width of [320, 800]) {
      const actual = getInitialTaskViewport(geometry, 'root', width, 445, true);
      expect(actual.zoom).toBe(0.8);
      expect(actual.x + 20000 * actual.zoom).toBe(32);
      expect(actual.y + (4000 + layoutModule.TASK_NODE_EXPANDABLE_HEIGHT / 2) * actual.zoom).toBe(445 / 2);
      expect(32 + layoutModule.TASK_NODE_WIDTH * actual.zoom).toBeLessThan(width);
    }
  });
});

describe('task chain dialog entries', () => {
  const mergingGraphs = () => {
    const tasks: TaskGraphData['tasks'] = ['A', 'B', 'C', 'D', ...Array.from({ length: 55 }, (_, position) => `leaf-${position}`)].map((id) => {
      const dependsOn = id === 'C' ? ['A'] : id === 'D' ? ['B'] : id.startsWith('leaf-') ? ['D'] : [];
      return { ...graph.tasks[0]!, id, titlePreview: id, status: 'todo', ready: dependsOn.length === 0, dependsOn, blockedBy: dependsOn };
    });
    const before = { ...graph, tasks, summary: { proposed: 0, total: tasks.length, todo: tasks.length, inProgress: 0, done: 0, cancelled: 0, ready: 2, blocked: tasks.length - 2 } };
    const after = { ...before, tasks: tasks.map((task) => task.id === 'D' ? { ...task, dependsOn: ['B', 'C'], blockedBy: ['B', 'C'] } : task) };
    return { before: buildGraphIndex(before), after: buildGraphIndex(after) };
  };

  it.each(['body', 'footer', 'fullscreen'] as const)('keeps %s focus inside the modal when a merge changes the representative', async (control) => {
    const { before, after } = mergingGraphs();
    const list = (index: typeof before, openChainId: string) => <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index}
      allRepresentativeIds={index.representativeIds} representativeIds={index.representativeIds} openGraphTarget={openChainId === null ? null : { kind: 'chain', witnessTaskId: openChainId, rootId: openChainId }} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />;
    const view = render(list(before, 'B'));
    await waitFor(() => expect(view.baseElement.querySelectorAll('.react-flow__node')).toHaveLength(50));
    const card = view.baseElement.querySelector<HTMLElement>('.react-flow__node[data-id="D"]')!;
    if (control === 'fullscreen') fireEvent.click(toolbarActions(view.baseElement).getByRole('button', { name: '全屏查看' }));
    const focused = control === 'fullscreen' ? toolbarActions(view.baseElement).getByRole('button', { name: '退出全屏' })
      : card.querySelector<HTMLButtonElement>(control === 'footer' ? '.task-node-expand[data-direction="successors"]' : '.task-node-body')!;
    focused.focus();
    expect(focused).toHaveFocus();
    view.rerender(list(after, 'A'));
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement));
    if (control !== 'fullscreen') expect(focused.isConnected).toBe(false);
    expect(view.baseElement.querySelector('#task-root-B')).toBeNull();
    expect(view.baseElement.querySelectorAll('.react-flow__node')).toHaveLength(50);
    expect(screen.getByRole('dialog')).toHaveClass('task-chain-dialog');
  });

  it('recovers focus to the labeled empty list when the final ordinary edge becomes external', async () => {
    const tasks: TaskGraphData['tasks'] = ['A', 'B'].map((id) => ({ ...graph.tasks[0]!, id, titlePreview: id, status: 'todo',
      dependsOn: id === 'B' ? ['A'] : [], blockedBy: id === 'B' ? ['A'] : [], ready: id === 'A' }));
    const before = buildGraphIndex({ ...graph, tasks, summary: { proposed: 0, total: 2, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 1 } });
    const after = buildGraphIndex({ ...graph, tasks: tasks.map((task) => task.id === 'B' ? { ...task, externalDependsOn: ['A'] } : task),
      summary: { proposed: 0, total: 2, todo: 2, inProgress: 0, done: 0, cancelled: 0, ready: 1, blocked: 1 } });
    const restoreGraphFocus = () => document.getElementById('project-chain-list')?.focus({ preventScroll: true });
    const view = render(<ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={before} allRepresentativeIds={['A']}
      representativeIds={['A']} openGraphTarget={{ kind: 'chain', witnessTaskId: 'A', rootId: 'A' }} onOpenChain={noop} onCloseChain={noop} onRestoreGraphFocus={restoreGraphFocus} onOpenTask={noop} />);
    await waitFor(() => expect(view.baseElement.querySelectorAll('.react-flow__node')).toHaveLength(2));
    const focused = view.baseElement.querySelector<HTMLButtonElement>('.react-flow__node[data-id="B"] .task-node-body')!;
    focused.focus();
    view.rerender(<ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={after} allRepresentativeIds={[]}
      representativeIds={[]} openGraphTarget={null} onOpenChain={noop} onCloseChain={noop} onRestoreGraphFocus={restoreGraphFocus} onOpenTask={noop} />);
    expect(screen.getByRole('heading', { name: '暂无任务链' })).toBeVisible();
    expect(view.baseElement.querySelector('.completed-chain-control')).toBeNull();
    expect(focused.isConnected).toBe(false);
    await waitFor(() => expect(screen.getByRole('region', { name: '任务链列表' })).toHaveFocus());
  });

  it('preserves focus in a body-portaled detail when a merge replaces the open representative', async () => {
    const { before, after } = mergingGraphs();
    const outside = document.createElement('button');
    outside.textContent = '详情关闭控件';
    document.body.append(outside);
    const list = (index: typeof before, openChainId: string) => <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index}
      allRepresentativeIds={index.representativeIds} representativeIds={index.representativeIds} openGraphTarget={openChainId === null ? null : { kind: 'chain', witnessTaskId: openChainId, rootId: openChainId }} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />;
    const view = render(list(before, 'B'));
    await waitFor(() => expect(view.baseElement.querySelectorAll('.react-flow__node')).toHaveLength(50));
    view.baseElement.querySelector<HTMLButtonElement>('.react-flow__node[data-id="D"] .task-node-body')!.focus();
    outside.focus();
    view.rerender(list(after, 'A'));
    await waitFor(() => expect(view.baseElement.querySelector('#task-root-B')).toBeNull());
    expect(outside).toHaveFocus();
    view.unmount();
    outside.remove();
  });

  it('renders the presented root order without changing the complete graph index', () => {
    const representativeIds = index.representativeIds.toReversed();
    const view = render(<ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index} allRepresentativeIds={index.representativeIds} representativeIds={representativeIds} openGraphTarget={null} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />);
    expect([...view.baseElement.querySelectorAll('.root-toggle')].map((root) => root.id)).toEqual(['task-root-F', 'task-root-E', 'task-root-B', 'task-root-A']);
    expect(index.representativeIds).toEqual(['A', 'B', 'E', 'F']);
    expect(index.successors.get('A')).toEqual(['C']);
    expect(index.components.get('A')!.progress).toEqual({ total: 3, done: 1, cancelled: 0, ended: 1, status: 'in_progress' });
    expect(screen.getByLabelText('显示 4 条，共 4 条任务链')).toHaveTextContent('4 / 4');
  });

  it('retains collapsed root renders during selection and still applies their new snapshot progress', async () => {
    const progressReads = vi.spyOn(index.components, 'get');
    const view = render(<ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index} allRepresentativeIds={index.representativeIds} representativeIds={index.representativeIds} openGraphTarget={{ kind: 'chain', witnessTaskId: 'A', rootId: 'A' }} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />);
    await ready(view.baseElement);
    const originalRoots = [...view.baseElement.querySelectorAll('.root-toggle')];
    const originalCanvas = view.baseElement.querySelector('.task-graph-canvas');
    expect(originalRoots[0]!.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('进行中');
    expect(originalRoots[0]!.closest('.goal-header')!.querySelector('.root-status')).toHaveClass('graph-status-in_progress');
    expect(originalRoots[2]!.closest('.goal-header')!.querySelector('.root-status')).toHaveClass('graph-status-todo');
    expect(originalRoots[3]!.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('待处理');

    for (const selectedTaskId of ['C', 'D', null]) {
      progressReads.mockClear();
      fireEvent.click(nodeButton(selectedTaskId === 'C' ? '合流实现…' : '最终验收'));
      await waitFor(() => {
        const selectedNodes = view.baseElement.querySelectorAll('.task-node-selected');
        expect(selectedNodes).toHaveLength(selectedTaskId === null ? 0 : 1);
        if (selectedTaskId !== null) expect(selectedNodes[0]!.closest('.react-flow__node')).toHaveAttribute('data-id', selectedTaskId);
      });
      expect(progressReads).not.toHaveBeenCalled();
      const roots = [...view.baseElement.querySelectorAll('.root-toggle')];
      expect(roots).toHaveLength(originalRoots.length);
      roots.forEach((root, position) => { expect(root).toBe(originalRoots[position]); });
      expect(view.baseElement.querySelector('.task-graph-canvas')).toBe(originalCanvas);
    }

    const refreshed = buildGraphIndex({
      ...graph,
      tasks: graph.tasks.map((task) => ({ ...task, status: 'done', blockedBy: [], ready: false })),
      summary: { proposed: 0, total: 6, todo: 0, inProgress: 0, done: 6, cancelled: 0, ready: 0, blocked: 0 },
    });
    view.rerender(<ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={refreshed} allRepresentativeIds={refreshed.representativeIds} representativeIds={refreshed.representativeIds} openGraphTarget={{ kind: 'chain', witnessTaskId: 'A', rootId: 'A' }} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />);
    expect(originalRoots[2]!.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('1/1 已完成');
    expect(originalRoots[2]!.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('已完成');
    expect(originalRoots[0]!.closest('.goal-header')!.querySelector('.root-progress-label')).toHaveTextContent('3/3 已完成');
    expect(originalRoots[0]!.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('已完成');
    expect(originalRoots[0]!.closest('.goal-header')!.querySelector('.root-status')).toHaveClass('graph-status-done');
    expect(view.baseElement.querySelectorAll('.root-toggle')[2]).toBe(originalRoots[2]);
  });

  it('opens one graph through its explicit action while preserving the task disclosure and list identity', async () => {
    const Wrapper = () => {
      const [openChainId, setOpenChainId] = useState<string | null>(null);
      const opener = useRef<HTMLElement | null>(null);
      return <ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={index} allRepresentativeIds={index.representativeIds} representativeIds={index.representativeIds} openGraphTarget={openChainId === null ? null : { kind: 'chain', witnessTaskId: openChainId, rootId: openChainId }} onOpenChain={(id, trigger) => { opener.current = trigger; setOpenChainId(id); }} onCloseChain={() => setOpenChainId(null)} onRestoreGraphFocus={() => opener.current?.focus({ preventScroll: true })} onOpenTask={noop} />;
    };
    const { baseElement: container } = render(<Wrapper />);
    const roots = container.querySelectorAll<HTMLButtonElement>('.root-toggle');
    const graphButtons = container.querySelectorAll<HTMLButtonElement>('.goal-graph-button');
    expect(roots).toHaveLength(4);
    expect(roots[0]!.id).toBe('task-root-A');
    expect(roots[0]!).toHaveAccessibleName(/1\/3 已完成/);
    expect(roots[0]!.closest('.goal-header')!.querySelector('.root-status')).toHaveTextContent('进行中');
    for (const root of roots) {
      expect(root).not.toHaveAttribute('aria-haspopup');
      expect(root).toHaveAttribute('aria-expanded', 'false');
    }
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.task-graph-canvas')).toBeNull();
    fireEvent.click(roots[0]!);
    expect(roots[0]!).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('#chain-task-A-C')).toBeVisible();
    fireEvent.click(graphButtons[0]!);
    await ready(container);
    expect(nodeShell('基础 API')).toHaveClass('task-node-done');
    expect(graphButtons[0]!).toHaveAttribute('aria-controls', 'task-graph-A');
    const firstCanvas = container.querySelector('.task-graph-canvas');
    fireEvent.click(container.querySelector('.task-chain-close')!);
    expect(container.querySelector('.task-graph-canvas')).toBeNull();
    expect(graphButtons[0]!).toHaveFocus();
    expect(roots[0]!).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(graphButtons[1]!);
    expect((performance.getEntriesByName('daynight:task-layout') as PerformanceMeasure[]).map((entry) => entry.detail)).toEqual([{ rootId: 'B' }]);
    expect(graphButtons[0]!).not.toHaveAttribute('aria-controls');
    expect(graphButtons[1]!).toHaveAttribute('aria-controls', 'task-graph-B');
    expect(roots[1]!).toHaveAttribute('aria-expanded', 'false');
    expect(firstCanvas?.isConnected).toBe(false);
    expect(container.querySelectorAll('.task-graph-canvas')).toHaveLength(1);
    fireEvent.keyDown(container.querySelector('.task-chain-close')!, { key: 'Escape' });
    expect(container.querySelectorAll('.task-graph-canvas')).toHaveLength(0);
    expect(graphButtons[1]!).toHaveFocus();
    expect(roots[0]!).toHaveAttribute('aria-expanded', 'true');
    expect([...container.querySelectorAll('.root-toggle')]).toEqual([...roots]);
  });

  it('renders task previews as plain text in the list, modal title and graph nodes', () => {
    const untrusted = '<img src=x onerror=alert(1)>'.repeat(6);
    const snapshot = { ...graph, tasks: graph.tasks.map((task) => task.id === 'A' ? { ...task, titlePreview: untrusted, titleTruncated: true } : task) };
    const { container } = render(<ChainList workerMachines={new Map()} projectId="00000000-0000-4000-8000-000000000101" index={buildGraphIndex(snapshot)} allRepresentativeIds={index.representativeIds} representativeIds={index.representativeIds} openGraphTarget={{ kind: 'chain', witnessTaskId: 'A', rootId: 'A' }} onOpenChain={noop} onCloseChain={noop} onOpenTask={noop} />);
    expect(screen.getAllByText(`${untrusted}…`)).toHaveLength(3);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
});
