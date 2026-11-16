import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { graph } from './graph-model-fixture';
import { installGraphMeasurements } from './graph-measurements';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { GoalTaskGraph } from '../src/features/task-graph/GoalTaskGraph';
import * as layout from '../src/features/task-graph/goal-layout';

const render = createLocaleRender('en', { taskCache: true });
const noop = () => {};
const index = (count: number) => {
  const data = graph(Array.from({ length: count }, (_, i) => ({ id: `task-${i}` })));
  return buildGraphIndex({ ...data, tasks: data.tasks.map((task) => ({ ...task, parentId: 'goal', titlePreview: task.id })) });
};

beforeEach(installGraphMeasurements);

describe('Goal graph canvas', () => {
  it('renders all 51 compact cards with separate inspection and Details without chain actions', async () => {
    const open = vi.fn();
    const view = render(<GoalTaskGraph projectId="project" index={index(51)} goalId="goal" direction="horizontal" onDirectionChange={noop} onOpenTask={open} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(51));
    expect(view.container.querySelectorAll('.task-node-details')).toHaveLength(51);
    expect(view.container.querySelectorAll('.task-node-expand')).toHaveLength(0);
    for (const node of view.container.querySelectorAll<HTMLElement>('.react-flow__node')) {
      expect(node.style.width).toBe('220px');
      expect(node.style.height).toBe('96px');
    }
    const card = screen.getByRole('button', { name: 'task-0, To do' });
    expect(card).not.toHaveAttribute('aria-haspopup');
    expect(card).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(open).not.toHaveBeenCalled();
    const details = screen.getByRole('button', { name: 'task-0, Details' });
    expect(details).toHaveAttribute('aria-haspopup', 'dialog');
    fireEvent.click(details);
    expect(open).toHaveBeenCalledWith('task-0', details);
  });

  it('preserves the canvas and viewport through topology changes and an empty Goal', async () => {
    const first = index(2);
    const props = { projectId: 'project', goalId: 'goal', direction: 'horizontal' as const, onDirectionChange: noop, onOpenTask: noop };
    const view = render(<GoalTaskGraph {...props} index={first} />);
    const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')!;
    await waitFor(() => expect(viewport.style.transform).not.toBe('translate(0px,0px) scale(1)'));
    const initialZoom = Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)![1]);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)![1])).toBeLessThan(initialZoom));
    const before = viewport.style.transform;
    const canvas = view.container.querySelector('.react-flow');
    fireEvent.click(screen.getByRole('button', { name: 'task-0, To do' }));
    view.rerender(<GoalTaskGraph {...props} index={index(2)} />);
    expect(viewport.style.transform).toBe(before);
    view.rerender(<GoalTaskGraph {...props} index={index(1)} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'task-0, To do, selected' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector('.react-flow')).toBe(canvas);
    expect(view.container.querySelector('.react-flow__viewport')).toBe(viewport);
    expect(viewport.style.transform).toBe(before);
    view.rerender(<GoalTaskGraph {...props} index={index(0)} />);
    expect(screen.getByText('This Goal has no tasks.')).toBeVisible();
    expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(0);
    expect(view.container.querySelector('.react-flow')).toBe(canvas);
    expect(view.container.querySelector('.react-flow__viewport')).toBe(viewport);
    expect(viewport.style.transform).toBe(before);
    view.rerender(<GoalTaskGraph {...props} index={index(2)} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'task-0, To do' })).toHaveAttribute('aria-pressed', 'false');
    expect(view.container.querySelector('.react-flow__viewport')).toBe(viewport);
    expect(viewport.style.transform).toBe(before);
  });

  it('mounts an empty canvas and frames its first tasks when they arrive', async () => {
    const props = { projectId: 'project', goalId: 'goal', direction: 'horizontal' as const, onDirectionChange: noop, onOpenTask: noop };
    const view = render(<GoalTaskGraph {...props} index={index(0)} />);
    expect(screen.getByText('This Goal has no tasks.')).toBeVisible();
    const canvas = view.container.querySelector('.react-flow');
    const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')!;
    expect(canvas).not.toBeNull();
    view.rerender(<GoalTaskGraph {...props} index={index(2)} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(2));
    await waitFor(() => expect(viewport.style.transform).not.toBe('translate(0px,0px) scale(1)'));
    expect(view.container.querySelector('.react-flow')).toBe(canvas);
    expect(view.container.querySelector('.react-flow__viewport')).toBe(viewport);
  });

  it('presents a recoverable layout failure', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(layout, 'layoutGoalGraph').mockImplementationOnce(() => { throw new Error('private data'); });
    const view = render(<GoalTaskGraph projectId="project" index={index(1)} goalId="goal" direction="horizontal" onDirectionChange={noop} onOpenTask={noop} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Task graph layout failed'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('private data');
    expect(warning).toHaveBeenCalledWith('Goal graph layout failed', { projectId: 'project', scopeKind: 'goal', resourceId: 'goal', stage: 'layout', errorName: 'Error', reason: 'layout_error' });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private data');
    fireEvent.click(screen.getByRole('alert').querySelector('button')!);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(1));
    spy.mockRestore();
    warning.mockRestore();
  });

  it('uses the first canvas size for readable framing and both fit controls request a new overview', async () => {
    const spy = vi.spyOn(layout, 'layoutGoalGraph');
    const props = { projectId: 'project', goalId: 'goal', direction: 'horizontal' as const, onDirectionChange: noop, onOpenTask: noop };
    const view = render(<GoalTaskGraph {...props} index={index(30)} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(30));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.anything(), { width: 800, height: 445 }, 'horizontal'));
    const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')!;
    await waitFor(() => expect(Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)![1])).toBeGreaterThanOrEqual(0.8));
    const calls = spy.mock.calls.length;
    const toolbar = screen.getByRole('button', { name: 'Fit all tasks' });
    toolbar.focus();
    fireEvent.click(toolbar);
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(calls));
    expect(toolbar).toHaveFocus();
    const overview = viewport.style.transform;
    expect(Number(/scale\(([^)]+)\)/.exec(overview)![1])).toBeLessThan(0.8);
    const afterToolbar = spy.mock.calls.length;
    const control = screen.getByRole('button', { name: 'Fit to canvas' });
    control.focus();
    fireEvent.click(control);
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(afterToolbar));
    expect(control).toHaveFocus();
    expect(viewport.style.transform).toBe(overview);
    const afterFit = spy.mock.calls.length;
    view.rerender(<GoalTaskGraph {...props} index={index(30)} />);
    expect(spy.mock.calls.length).toBe(afterFit);
    expect(viewport.style.transform).toBe(overview);
    view.rerender(<GoalTaskGraph {...props} index={index(31)} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(31));
    expect(spy.mock.calls.length).toBeGreaterThan(afterFit);
    expect(viewport.style.transform).toBe(overview);
    spy.mockRestore();
  });

  it('waits for a real nonzero size and keeps geometry and viewport on passive resize', async () => {
    let width = 0;
    let height = 0;
    const observers = new Set<{ notify: () => void }>();
    vi.stubGlobal('ResizeObserver', class {
      private readonly observed = new Set<Element>();
      constructor(private readonly callback: ResizeObserverCallback) { observers.add(this); }
      observe(target: Element) { this.observed.add(target); queueMicrotask(() => this.notify()); }
      unobserve(target: Element) { this.observed.delete(target); }
      disconnect() { this.observed.clear(); observers.delete(this); }
      notify() { if (this.observed.size > 0) this.callback([...this.observed].map((target) => ({ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry)), this as unknown as ResizeObserver); }
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('react-flow') || this.classList.contains('react-flow__renderer') ? width : this.classList.contains('react-flow__handle') ? 6 : 220;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('react-flow') || this.classList.contains('react-flow__renderer') ? height : this.classList.contains('react-flow__handle') ? 6 : 96;
    });
    const spy = vi.spyOn(layout, 'layoutGoalGraph');
    const view = render(<GoalTaskGraph projectId="project" index={index(30)} goalId="goal" direction="horizontal" onDirectionChange={noop} onOpenTask={noop} />);
    expect(view.container.querySelector('.react-flow')).not.toBeNull();
    expect(screen.queryByText('This Goal has no tasks.')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    width = 800; height = 445;
    act(() => { for (const observer of observers) observer.notify(); });
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(30));
    const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')!;
    await waitFor(() => expect(viewport.style.transform).not.toBe('translate(0px,0px) scale(1)'));
    const before = viewport.style.transform;
    const positions = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.style.transform);
    const calls = spy.mock.calls.length;
    width = 390; height = 600;
    act(() => { for (const observer of observers) observer.notify(); });
    expect(viewport.style.transform).toBe(before);
    expect([...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => node.style.transform)).toEqual(positions);
    expect(spy.mock.calls.length).toBe(calls);
    fireEvent.click(screen.getByRole('button', { name: 'Fit all tasks' }));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.anything(), { width: 390, height: 600 }, 'horizontal'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    spy.mockImplementationOnce(() => { throw new Error('test'); });
    fireEvent.click(screen.getByRole('button', { name: 'Fit all tasks' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible());
    width = 700; height = 500;
    act(() => { for (const observer of observers) observer.notify(); });
    fireEvent.click(screen.getByRole('alert').querySelector('button')!);
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith(expect.anything(), { width: 700, height: 500 }, 'horizontal'));
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(30));
    warning.mockRestore();
    spy.mockRestore();
  });
});
