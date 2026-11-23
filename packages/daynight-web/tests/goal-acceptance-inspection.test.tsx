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
  it('uses current synchronized local relationships and metadata while preserving external and terminal inspection contexts', async () => {
    const data = fixture();
    data.set('terminal', { ...data.get('done')!, id: 'terminal', title: 'Terminal downstream', titlePreview: 'Terminal downstream', dependsOn: ['root'] });
    const local = (id: string) => ({ goalId: id, projectId: 'project', projectName: 'Project', title: `Stale ${id}`, status: 'todo' as const, kind: 'internal' as const });
    const external = (id: string) => ({ ...local(id), projectId: 'other', projectName: 'Other Project', title: id, status: 'done' as const, kind: 'external' as const });
    const source: GoalRelationSource = { mode: 'root', goalId: 'root', projectId: 'project', title: 'root', phase: 'ready', hiddenCount: 0, error: null,
      contribution: { sourceId: 'root', sourceProjectId: 'project', prerequisites: [{ target: local('done') }, { target: external('External prerequisite') }],
        successors: [local('next'), external('External terminal downstream')] } };
    const snapshot: GoalRelationSnapshot = { sources: new Map([['root', source]]), deniedIds: new Set() }, onOpenGoal = vi.fn();
    const view = render(<GoalAcceptanceGraph projectId="project" summaries={data} relationSnapshot={snapshot} onOpenGoal={onOpenGoal} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(5));
    fireEvent.click(body(view.container, 'root'));
    const inspector = view.container.querySelector('.goal-acceptance-inspection')!;
    expect(inspector).toHaveTextContent('next');
    expect(inspector).toHaveTextContent('Terminal downstream');
    expect(view.container.querySelector('.react-flow__node[data-id="terminal"]')).toBeNull();
    const changed = new Map(data);
    changed.set('next', { ...changed.get('next')!, dependsOn: [], version: 2n });
    changed.set('isolated', { ...changed.get('isolated')!, dependsOn: ['root'], titlePreview: 'New local successor', version: 2n });
    changed.set('done', { ...changed.get('done')!, titlePreview: 'Updated local prerequisite', version: 2n });
    view.rerender(<GoalAcceptanceGraph projectId="project" summaries={changed} relationSnapshot={snapshot} onOpenGoal={onOpenGoal} />);
    expect(changed.get('root')!.version).toBe(data.get('root')!.version);
    expect(inspector).not.toHaveTextContent('Stale next');
    expect([...inspector.querySelectorAll('.goal-acceptance-relation')].map(node => node.textContent)).not.toContain('next');
    expect(inspector).toHaveTextContent('New local successor');
    expect(inspector).toHaveTextContent('Updated local prerequisite');
    expect(inspector).toHaveTextContent('External prerequisite');
    expect(inspector).toHaveTextContent('External terminal downstream');
    changed.set('root', { ...changed.get('root')!, dependsOn: [], version: 2n });
    view.rerender(<GoalAcceptanceGraph projectId="project" summaries={new Map(changed)} relationSnapshot={snapshot} onOpenGoal={onOpenGoal} />);
    expect(inspector).not.toHaveTextContent('Updated local prerequisite');
    expect(inspector).toHaveTextContent('External prerequisite');
  });
  it('filters disconnected sources immediately against new committed summaries before session reconciliation', async () => {
    const data = fixture(), inspect = vi.fn();
    const related = (id: string) => ({ goalId: id, projectId: 'other', projectName: 'Other Project', title: id, status: 'todo' as const, kind: 'external' as const });
    const root: GoalRelationSource = { mode: 'root', goalId: 'isolated', projectId: 'project', title: 'isolated', phase: 'ready', hiddenCount: 0, error: null,
      contribution: { sourceId: 'isolated', sourceProjectId: 'project', prerequisites: [{ target: related('external') }], successors: [] } };
    const branch: GoalRelationSource = { ...root, mode: 'expanded', goalId: 'external', projectId: 'other', title: 'external',
      contribution: { sourceId: 'external', sourceProjectId: 'other', prerequisites: [{ target: related('second-hop') }], successors: [] } };
    const snapshot: GoalRelationSnapshot = { sources: new Map([['isolated', root], ['external', branch]]), deniedIds: new Set() };
    const props = { projectId: 'project', onOpenGoal: vi.fn(), onInspectRelations: inspect, onRetryRelations: vi.fn() };
    const view = render(<GoalAcceptanceGraph {...props} summaries={data} relationSnapshot={snapshot} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(6));
    fireEvent.click(body(view.container, 'external'));
    const committed = new Map(data); committed.set('isolated', { ...committed.get('isolated')!, status: 'done' });
    view.rerender(<GoalAcceptanceGraph {...props} summaries={committed} relationSnapshot={snapshot} />);
    expect(view.container.querySelector('.react-flow__node[data-id="external"]')).toBeNull();
    expect(view.container.querySelector('.react-flow__node[data-id="second-hop"]')).toBeNull();
    expect(view.container.querySelectorAll('.goal-relation-source')).toHaveLength(0);
    expect(view.container.querySelector('.goal-acceptance-inspection h3')).toBeNull();
  });
  it('keeps uncovered inspection off the canvas and preserves selection and viewport when explicitly expanded', async () => {
    const data = fixture(), inspect = vi.fn(), expand = vi.fn();
    const related = (id: string) => ({ goalId: id, projectId: 'other', projectName: 'Other Project', title: id, status: 'todo' as const, kind: 'internal' as const });
    const root: GoalRelationSource = { mode: 'root', goalId: 'root', projectId: 'project', title: 'root', phase: 'ready', hiddenCount: 0, error: null,
      contribution: { sourceId: 'root', sourceProjectId: 'project', prerequisites: [{ target: related('external') }], successors: [] } };
    const external: GoalRelationSource = { ...root, mode: 'inspection', goalId: 'external', projectId: 'other', title: 'external',
      contribution: { sourceId: 'external', sourceProjectId: 'other', prerequisites: [{ target: related('second-hop') }], successors: [] } };
    const snapshot: GoalRelationSnapshot = { sources: new Map([['root', root], ['external', external]]), deniedIds: new Set() };
    const props = { projectId: 'project', summaries: data, onOpenGoal: vi.fn(), onInspectRelations: inspect, onExpandRelations: expand };
    const view = render(<GoalAcceptanceGraph {...props} relationSnapshot={snapshot} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(5));
    fireEvent.click(body(view.container, 'external'));
    expect(inspect).toHaveBeenCalledWith('external');
    expect(view.container.querySelector('.goal-acceptance-inspection')).toHaveTextContent('second-hop');
    expect(view.container.querySelector('.react-flow__node[data-id="second-hop"]')).toBeNull();
    const viewport = view.container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform;
    fireEvent.click(screen.getByRole('button', { name: 'Expand relationships: external' }));
    expect(expand).toHaveBeenCalledWith('external');
    view.rerender(<GoalAcceptanceGraph {...props} relationSnapshot={{ ...snapshot, sources: new Map([['root', root], ['external', { ...external, mode: 'expanded' }]]) }} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(6));
    expect(body(view.container, 'external')).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform).toBe(viewport);
    expect(screen.getByRole('button', { name: 'Expand relationships: external' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('removes denied peers from both raw inspection directions without losing the readable graph', async () => {
    const data = fixture();
    const deniedPeer = { goalId: 'next', projectId: 'project', projectName: 'Project', title: 'next', status: 'todo' as const, kind: 'internal' as const };
    const source: GoalRelationSource = { mode: 'root', goalId: 'root', projectId: 'project', title: 'root', phase: 'ready', hiddenCount: 0, error: null,
      contribution: { sourceId: 'root', sourceProjectId: 'project', prerequisites: [{ target: deniedPeer }], successors: [deniedPeer] } };
    const readable: GoalRelationSnapshot = { sources: new Map([['root', source]]), deniedIds: new Set() };
    const props = { projectId: 'project', summaries: data, onOpenGoal: vi.fn(), onRetryRelations: vi.fn() };
    const view = render(<GoalAcceptanceGraph {...props} relationSnapshot={readable} />);
    await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(4));
    fireEvent.click(body(view.container, 'root'));
    view.rerender(<GoalAcceptanceGraph {...props} relationSnapshot={{ ...readable, deniedIds: new Set(['next']) }} />);
    expect(body(view.container, 'root')).toHaveAttribute('aria-pressed', 'true');
    expect(view.container.querySelector('.react-flow__node[data-id="next"]')).toBeNull();
    expect(view.container.querySelectorAll('.goal-acceptance-inspection .goal-acceptance-relation')).toHaveLength(1);
    expect(view.container.querySelector('.goal-acceptance-inspection .goal-acceptance-relation')).toHaveTextContent('done');
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
