import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskGraph as GraphData } from '../src/api/types';
import { GoalTaskGraph } from '../src/features/task-graph/GoalTaskGraph';
import { buildGraphIndex } from '../src/features/task-graph/model';
import * as layout from '../src/features/task-graph/goal-layout';
import * as routes from '../src/features/task-graph/routes';
import { graph } from './graph-model-fixture';
import { installGraphMeasurements } from './graph-measurements';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en', { taskCache: true });
const noop = () => {};
const fixture = graph([
  { id: 'hidden-root', status: 'done' },
  { id: 'hidden-join', status: 'done', dependsOn: ['hidden-root'] },
  { id: 'external', status: 'done', dependsOn: ['hidden-join'] },
  { id: 'left', status: 'done', dependsOn: ['external'], externalDependsOn: ['external'] },
  { id: 'right', status: 'cancelled', dependsOn: ['external'], externalDependsOn: ['external'] },
  { id: 'join', dependsOn: ['left', 'right'] },
  { id: 'unrelated' },
]);
const data: GraphData = { ...fixture, tasks: fixture.tasks.map(task => ({ ...task, titlePreview: task.id,
  parentId: ['left', 'right', 'join', 'unrelated'].includes(task.id) ? 'goal' : null })) };
const baseProps = { projectId: 'project', goalId: 'goal', direction: 'horizontal' as const, onDirectionChange: noop, onOpenTask: noop };
const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .task-node`)!;
const body = (container: HTMLElement, id: string) => card(container, id).querySelector<HTMLButtonElement>('.task-node-body')!;
const details = (container: HTMLElement, id: string) => card(container, id).querySelector<HTMLButtonElement>('.task-node-details')!;
const ready = async (container: HTMLElement, count = 5) => {
  await waitFor(() => expect(container.querySelectorAll('.react-flow__node')).toHaveLength(count));
  await waitFor(() => expect(container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform).not.toBe('translate(0px,0px) scale(1)'));
};
const geometry = (container: HTMLElement) => ({
  nodes: [...container.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => [node.dataset.id, node.style.transform, node.style.width, node.style.height]),
  edges: [...container.querySelectorAll('.react-flow__edge-path,.task-dependency-paint-piece')].map(shape => [shape.tagName, ...['d', 'transform', 'x1', 'y1', 'x2', 'y2'].map(name => shape.getAttribute(name))]),
  viewport: container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform,
});

beforeEach(installGraphMeasurements);

describe('Goal graph prerequisite inspection', () => {
  it('recomputes successors for a retained selection and clears them when that selection disappears', async () => {
    const view = render(<GoalTaskGraph {...baseProps} index={buildGraphIndex(data)} />);
    await ready(view.container);
    fireEvent.click(body(view.container, 'left'));
    expect(card(view.container, 'join')).toHaveAttribute('data-inspection', 'successor');
    const changed = { ...data, tasks: data.tasks.map(task => task.id === 'join' ? { ...task, dependsOn: ['right'] } : task) };
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(changed)} />);
    await ready(view.container);
    expect(body(view.container, 'left')).toHaveAttribute('aria-pressed', 'true');
    expect(card(view.container, 'join')).toHaveAttribute('data-inspection', 'unrelated');
    expect(view.container.querySelectorAll('.task-dependency-edge[data-inspection="successor"]')).toHaveLength(0);
    fireEvent.click(body(view.container, 'external'));
    for (const id of ['left', 'right', 'join']) expect(card(view.container, id)).toHaveAttribute('data-inspection', 'successor');
    const removed = { ...changed, tasks: changed.tasks.map(task => ['left', 'right'].includes(task.id) ? { ...task, dependsOn: [], externalDependsOn: [] } : task) };
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(removed)} />);
    await ready(view.container, 4);
    expect(card(view.container, 'external')).toBeNull();
    expect(view.container.querySelectorAll('.task-node-normal')).toHaveLength(4);
    expect(view.container.querySelectorAll('.task-dependency-edge[data-inspection="successor"]')).toHaveLength(0);
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(data)} />);
    await ready(view.container);
    expect(view.container.querySelectorAll('.task-node-normal')).toHaveLength(5);
  });

  it('keeps bypass edges and sibling tasks unrelated while highlighting a successor join', async () => {
    const source = graph([
      { id: 'a', status: 'done' }, { id: 'b', status: 'done', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a', 'b'], externalDependsOn: ['b'] },
      { id: 'd', dependsOn: ['b'] }, { id: 'join', dependsOn: ['c', 'd'] },
      { id: 'sibling', dependsOn: ['a'] },
    ]);
    const index = buildGraphIndex({ ...source, tasks: source.tasks.map(task => ({ ...task, parentId: 'goal' })) });
    const view = render(<GoalTaskGraph {...baseProps} index={index} />);
    await ready(view.container, 6);
    const before = geometry(view.container);
    fireEvent.click(body(view.container, 'b'));
    expect(card(view.container, 'a')).toHaveAttribute('data-inspection', 'prerequisite');
    for (const id of ['c', 'd', 'join']) expect(card(view.container, id)).toHaveAttribute('data-inspection', 'successor');
    expect(card(view.container, 'sibling')).toHaveAttribute('data-inspection', 'unrelated');
    expect(view.container.querySelector('.task-dependency-edge[data-source="a"][data-target="c"]')).toHaveAttribute('data-inspection', 'unrelated');
    expect(view.container.querySelector('.task-dependency-edge[data-source="b"][data-target="c"]')).toHaveAttribute('data-inspection', 'successor');
    expect(view.container.querySelectorAll('.task-dependency-edge[data-inspection="successor"]')).toHaveLength(4);
    expect(geometry(view.container)).toEqual(before);
    fireEvent.click(view.container.querySelector('.react-flow__pane')!);
    expect(view.container.querySelectorAll('.task-node-successor')).toHaveLength(0);
  });

  it('traces fork/join ancestors through the full index while painting only real projected edges and arrows', async () => {
    const view = render(<GoalTaskGraph {...baseProps} index={buildGraphIndex(data)} />);
    await ready(view.container);
    expect(card(view.container, 'hidden-root')).toBeNull();
    expect(card(view.container, 'hidden-join')).toBeNull();
    fireEvent.click(body(view.container, 'join'));
    expect(body(view.container, 'join')).toHaveAttribute('aria-pressed', 'true');
    for (const id of ['left', 'right', 'external']) expect(card(view.container, id)).toHaveAttribute('data-inspection', 'prerequisite');
    expect(card(view.container, 'right')).toHaveAttribute('data-task-status', 'cancelled');
    expect(card(view.container, 'unrelated')).toHaveAttribute('data-inspection', 'unrelated');
    expect(card(view.container, 'external')).toHaveClass('task-node-external');
    expect(view.container.querySelector('.task-graph')).toHaveAttribute('data-hidden-upstream-count', '2');
    expect(view.container.querySelector('.graph-hidden-prerequisites')).toHaveTextContent('2');
    expect(view.container.querySelectorAll('.task-dependency-edge')).toHaveLength(4);
    expect(view.container.querySelectorAll('.task-dependency-edge[data-external="true"]')).toHaveLength(2);
    for (const edge of view.container.querySelectorAll('.task-dependency-edge')) {
      expect(edge).toHaveAttribute('data-inspection', 'highlighted');
      expect(edge.querySelector('.task-dependency-body')).toHaveAttribute('stroke', '#6762ce');
      const marker = edge.querySelector('.react-flow__edge-path')!.getAttribute('marker-end')!.slice(5, -1);
      expect(view.container.querySelector(`[id="${marker}"] polyline`)).toHaveAttribute('fill', '#6762ce');
    }
    fireEvent.click(body(view.container, 'external'));
    expect(card(view.container, 'external')).toHaveAttribute('data-inspection', 'selected');
    expect(view.container.querySelectorAll('.task-dependency-edge[data-inspection="successor"]')).toHaveLength(4);
    for (const id of ['left', 'right', 'join']) expect(card(view.container, id)).toHaveAttribute('data-inspection', 'successor');
    expect(view.container.querySelector('.task-graph')).toHaveAttribute('data-hidden-upstream-count', '2');
    fireEvent.click(body(view.container, 'external'));
    expect(view.container.querySelectorAll('.task-node-normal')).toHaveLength(5);
    expect(view.container.querySelector('.graph-hidden-prerequisites')).toBeEmptyDOMElement();
    fireEvent.click(body(view.container, 'unrelated'));
    expect(view.container.querySelector('.task-graph')).toHaveAttribute('data-hidden-upstream-count', '0');
    expect(view.container.querySelector('.graph-hidden-prerequisites')).toBeEmptyDOMElement();
    fireEvent.click(view.container.querySelector('.react-flow__pane')!);
    expect(body(view.container, 'unrelated')).toHaveAttribute('aria-pressed', 'false');
  });

  it.each(['join', 'external'])('keeps %s body and Details independent for mouse and native keyboard activation', async id => {
    const user = userEvent.setup();
    const open = vi.fn();
    const view = render(<GoalTaskGraph {...baseProps} index={buildGraphIndex(data)} onOpenTask={open} />);
    await ready(view.container);
    const inspect = body(view.container, id), read = details(view.container, id);
    expect(inspect.parentElement).toBe(read.parentElement);
    expect(inspect).not.toHaveAttribute('aria-haspopup');
    expect(read).toHaveAttribute('aria-haspopup', 'dialog');
    expect(read).not.toHaveAttribute('aria-pressed');
    expect(within(card(view.container, id)).getByRole('button', { name: `${id}, Details` })).toBe(read);
    inspect.focus();
    await user.keyboard('{Enter}');
    expect(inspect).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard(' ');
    expect(inspect).toHaveAttribute('aria-pressed', 'false');
    await user.click(inspect);
    expect(open).not.toHaveBeenCalled();
    read.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.click(read);
    expect(open.mock.calls).toEqual([[id, read], [id, read], [id, read]]);
    expect(inspect).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector('.task-node-expand')).toBeNull();
  });

  it('recomputes hidden ancestry without layout, routes or viewport changes and retains selection through fit and direction changes', async () => {
    const measure = vi.spyOn(layout, 'layoutGoalGraph');
    const compile = vi.spyOn(routes, 'compileDependencyRoute');
    const open = vi.fn();
    const view = render(<GoalTaskGraph {...baseProps} index={buildGraphIndex(data)} onOpenTask={open} />);
    await ready(view.container);
    const before = geometry(view.container);
    const initialLayouts = measure.mock.calls.length, initialRoutes = compile.mock.calls.length;
    const shapes = [...view.container.querySelectorAll('.react-flow__edge-path,.task-dependency-paint-piece')];
    fireEvent.click(body(view.container, 'join'));
    fireEvent.click(details(view.container, 'join'));
    const updated = { ...data, tasks: data.tasks.map(task => task.id === 'external' ? { ...task, dependsOn: [] } : task) };
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(updated)} onOpenTask={open} />);
    expect(body(view.container, 'join')).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector('.task-graph')).toHaveAttribute('data-hidden-upstream-count', '0');
    expect(geometry(view.container)).toEqual(before);
    expect([...view.container.querySelectorAll('.react-flow__edge-path,.task-dependency-paint-piece')]).toEqual(shapes);
    expect(measure).toHaveBeenCalledTimes(initialLayouts);
    expect(compile).toHaveBeenCalledTimes(initialRoutes);
    fireEvent.click(screen.getByRole('button', { name: 'Fit all tasks' }));
    expect(body(view.container, 'join')).toHaveAttribute('aria-pressed', 'true');
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(updated)} direction="vertical" onOpenTask={open} />);
    await waitFor(() => expect(measure).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'vertical', expect.any(Map)));
    expect(body(view.container, 'join')).toHaveAttribute('aria-pressed', 'true');
    measure.mockRestore(); compile.mockRestore();
  });

  it('clears a task that leaves the projection and clears the inspection when the Goal changes', async () => {
    const view = render(<GoalTaskGraph {...baseProps} index={buildGraphIndex(data)} />);
    await ready(view.container);
    fireEvent.click(body(view.container, 'join'));
    const moved = { ...data, tasks: data.tasks.map(task => task.id === 'join' ? { ...task, parentId: 'other-goal' } : task) };
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(moved)} />);
    await ready(view.container, 4);
    expect(view.container.querySelector('.task-node-selected')).toBeNull();
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(data)} />);
    await ready(view.container);
    expect(body(view.container, 'join')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(body(view.container, 'external'));
    const bothGoals = { ...data, tasks: data.tasks.map(task => task.id === 'unrelated' ? { ...task, parentId: 'other-goal', dependsOn: ['external'] } : task) };
    view.rerender(<GoalTaskGraph {...baseProps} index={buildGraphIndex(bothGoals)} goalId="other-goal" />);
    await ready(view.container, 2);
    expect(body(view.container, 'external')).toHaveAttribute('aria-pressed', 'false');
    expect(view.container.querySelectorAll('.task-node-normal')).toHaveLength(2);
  });
});
