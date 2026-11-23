import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSummary } from '../src/api/types';
import { GoalAcceptanceGraph } from '../src/features/goal-acceptance-graph/GoalAcceptanceGraph';
import { graph } from './graph-model-fixture';
import { installGraphMeasurements } from './graph-measurements';
import { createLocaleRender } from './helpers/renderWithLocale';
import type { GoalRelationSnapshot, GoalRelationSource } from '../src/features/goal-acceptance-graph/relation-session';

const render = createLocaleRender('en');
const fixture = () => new Map(graph([{ id: 'done', status: 'done' }, { id: 'root', dependsOn: ['done'] }, { id: 'next', dependsOn: ['root'] }, { id: 'isolated' }]).tasks.map(({ blockedBy: _blocked, ready: _ready, ...task }) =>
  [task.id, { ...task, title: task.id, titlePreview: task.id, version: 1n, properties: {}, tags: [], type: 'goal' as const } satisfies TaskSummary]));
const body = (container: HTMLElement, id: string) => container.querySelector<HTMLButtonElement>(`.react-flow__node[data-id="${id}"] .task-node-body`)!;
const card = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .goal-acceptance-node`)!;
beforeEach(installGraphMeasurements);

describe('Goal acceptance graph inspection', () => {
  it('removes denied peers from both raw inspection directions without losing the readable graph', async () => {
    const data = fixture();
    const deniedPeer = { goalId: 'next', projectId: 'project', projectName: 'Project', title: 'next', status: 'todo' as const, kind: 'internal' as const };
    const source: GoalRelationSource = { goalId: 'root', projectId: 'project', title: 'root', phase: 'ready', hiddenCount: 0, error: null,
      contribution: { sourceId: 'root', sourceProjectId: 'project', prerequisites: [{ target: deniedPeer }], successors: [deniedPeer] } };
    const readable: GoalRelationSnapshot = { sources: new Map([['root', source]]), deniedIds: new Set() };
    const props = { projectId: 'project', summaries: data, onOpenGoal: vi.fn(), onRetryRelations: vi.fn() };
    const view = render(<GoalAcceptanceGraph {...props} relationSnapshot={readable} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(4));
    fireEvent.click(body(view.container, 'root'));
    view.rerender(<GoalAcceptanceGraph {...props} relationSnapshot={{ ...readable, deniedIds: new Set(['next']) }} />);
    expect(body(view.container, 'root')).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector('.react-flow__node[data-id="next"]')).toBeNull();
    expect(view.container.querySelectorAll('.goal-acceptance-inspection .goal-acceptance-relation')).toHaveLength(0);
  });
  it('starts unselected, inspects prerequisites and successors locally without requests, and preserves geometry on status updates', async () => {
    const requests = vi.fn(() => { throw new Error('Graph inspection must not fetch'); });
    vi.stubGlobal('fetch', requests);
    const data = fixture(), onOpenGoal = vi.fn();
    const view = render(<GoalAcceptanceGraph projectId="project" summaries={data} onOpenGoal={onOpenGoal} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(4));
    expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    fireEvent.click(body(view.container, 'root'));
    expect(card(view.container, 'done')).toHaveAttribute('data-inspection', 'prerequisite');
    expect(card(view.container, 'next')).toHaveAttribute('data-inspection', 'successor');
    expect(card(view.container, 'isolated')).toHaveAttribute('data-inspection', 'unrelated');
    expect(screen.getByText(/Global acceptance is unverified/)).toBeVisible();
    const before = [...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => node.style.transform);
    const changed = new Map(data); changed.set('root', { ...data.get('root')!, titlePreview: 'Renamed', status: 'in_progress' });
    view.rerender(<GoalAcceptanceGraph projectId="project" summaries={changed} onOpenGoal={onOpenGoal} />);
    expect(body(view.container, 'root')).toHaveAttribute('aria-pressed', 'true');
    expect([...view.container.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => node.style.transform)).toEqual(before);
    fireEvent.click(screen.getByRole('button', { name: 'Details: Renamed' }));
    expect(onOpenGoal).toHaveBeenCalledWith('root', expect.any(HTMLElement));
    expect(requests).not.toHaveBeenCalled();
  });

  it('retains a surviving selection after an edge update and clears a removed terminal prerequisite', async () => {
    const data = fixture(), onOpenGoal = vi.fn();
    const view = render(<GoalAcceptanceGraph projectId="project" summaries={data} onOpenGoal={onOpenGoal} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(4));
    fireEvent.click(body(view.container, 'done'));
    const changed = new Map(data); changed.set('root', { ...data.get('root')!, dependsOn: [] });
    view.rerender(<GoalAcceptanceGraph projectId="project" summaries={changed} onOpenGoal={onOpenGoal} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(3));
    expect(view.container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    fireEvent.click(body(view.container, 'root'));
    changed.set('next', { ...changed.get('next')!, dependsOn: [] });
    view.rerender(<GoalAcceptanceGraph projectId="project" summaries={new Map(changed)} onOpenGoal={onOpenGoal} />);
    expect(body(view.container, 'root')).toHaveAttribute('aria-pressed', 'true');
    expect(card(view.container, 'next')).toHaveAttribute('data-inspection', 'unrelated');
  });
});
