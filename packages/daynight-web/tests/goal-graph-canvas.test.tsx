import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocaleRender } from './helpers/renderWithLocale';
import { graph } from './graph-model-fixture';
import { installGraphMeasurements } from './graph-measurements';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { GoalTaskGraph } from '../src/features/task-graph/GoalTaskGraph';
import * as layout from '../src/features/task-graph/layout';

const render = createLocaleRender('en', { taskCache: true });
const noop = () => {};
const index = (count: number) => {
  const data = graph(Array.from({ length: count }, (_, i) => ({ id: `task-${i}` })));
  return buildGraphIndex({ ...data, tasks: data.tasks.map((task) => ({ ...task, parentId: 'goal', titlePreview: task.id })) });
};

beforeEach(installGraphMeasurements);

describe('Goal graph canvas', () => {
  it('renders all 51 nodes and opens a card directly without chain actions', async () => {
    const open = vi.fn();
    const view = render(<GoalTaskGraph projectId="project" index={index(51)} goalId="goal" direction="horizontal" onDirectionChange={noop} onOpenTask={open} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(51));
    expect(view.container.querySelectorAll('.task-node-details, .task-node-expand')).toHaveLength(0);
    for (const node of view.container.querySelectorAll<HTMLElement>('.react-flow__node')) {
      expect(node.style.width).toBe('220px');
      expect(node.style.height).toBe('96px');
    }
    const card = screen.getByRole('button', { name: /^task-0, / });
    expect(card).toHaveAttribute('aria-haspopup', 'dialog');
    expect(card).not.toHaveAttribute('aria-pressed');
    fireEvent.click(card);
    expect(open).toHaveBeenCalledWith('task-0', card);
  });

  it('preserves viewport when the same topology is refreshed and handles empty Goals', async () => {
    const first = index(2);
    const props = { projectId: 'project', goalId: 'goal', direction: 'horizontal' as const, onDirectionChange: noop, onOpenTask: noop };
    const view = render(<GoalTaskGraph {...props} index={first} />);
    const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')!;
    await waitFor(() => expect(viewport.style.transform).not.toBe('translate(0px,0px) scale(1)'));
    const initialZoom = Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)![1]);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await waitFor(() => expect(Number(/scale\(([^)]+)\)/.exec(viewport.style.transform)![1])).toBeLessThan(initialZoom));
    const before = viewport.style.transform;
    view.rerender(<GoalTaskGraph {...props} index={index(2)} />);
    expect(viewport.style.transform).toBe(before);
    view.rerender(<GoalTaskGraph {...props} index={index(0)} />);
    expect(screen.getByText('This Goal has no tasks.')).toBeVisible();
    expect(view.container.querySelector('.react-flow')).toBeNull();
  });

  it('presents a recoverable layout failure', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spy = vi.spyOn(layout, 'layoutGraph').mockImplementationOnce(() => { throw new Error('private data'); });
    const view = render(<GoalTaskGraph projectId="project" index={index(1)} goalId="goal" direction="horizontal" onDirectionChange={noop} onOpenTask={noop} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Task graph layout failed');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private data');
    expect(warning).toHaveBeenCalledWith('Goal graph layout failed', { projectId: 'project', scopeKind: 'goal', resourceId: 'goal', stage: 'layout', errorName: 'Error', reason: 'layout_error' });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private data');
    fireEvent.click(screen.getByRole('alert').querySelector('button')!);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(1));
    spy.mockRestore();
    warning.mockRestore();
  });
});
