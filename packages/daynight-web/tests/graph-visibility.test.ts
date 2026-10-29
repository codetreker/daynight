import { describe, expect, it } from 'vitest';
import type { GraphTask, TaskGraph, TaskStatus } from '../src/api/types';
import { buildGraphIndex, GraphDataError, projectChain, type ChainProjection } from '../src/features/task-graph/model';
import {
  createGraphOverview, getTaskExpansion, projectVisibleTasks, reconcileVisibleTasks,
  GRAPH_EXPANSION_BATCH_SIZE, GRAPH_OVERVIEW_EDGE_LIMIT, GRAPH_OVERVIEW_TASK_LIMIT,
} from '../src/features/task-graph/visibility';

type Seed = { id: string; externalDependsOn?: readonly string[]; dependsOn?: readonly string[]; status?: TaskStatus };
const indexOf = (seeds: readonly Seed[], defaultStatus: TaskStatus = 'todo') => {
  const statuses = new Map(seeds.map((seed) => [seed.id, seed.status ?? defaultStatus]));
  const tasks: GraphTask[] = seeds.map(({ id, dependsOn = [], externalDependsOn = [] }) => {
    const status = statuses.get(id)!;
    const blockedBy = dependsOn.filter((source) => statuses.get(source) !== 'done');
    return { requiredPlatform: null, workerNeedsAttention: false, allowAgents: false, externalDependsOn, startedAt: null, completedAt: null,
      id, dependsOn, blockedBy, ready: status === 'todo' && blockedBy.length === 0, status,
      titlePreview: id, titleTruncated: false, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z',
    };
  });
  const count = (status: TaskStatus) => tasks.filter((task) => task.status === status).length;
  const graph: TaskGraph = { observedAt: "2026-10-20T12:00:00Z",
    project: { settings: { version: 1n, executionWarningMinutes: 60 }, id: 'project', name: 'Project', repoUrl: '', createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' }, tasks,
    summary: { total: tasks.length, todo: count('todo'), inProgress: count('in_progress'), done: count('done'),
      ready: tasks.filter((task) => task.ready).length, blocked: tasks.filter((task) => task.status === 'todo' && task.blockedBy.length > 0).length },
  };
  return buildGraphIndex(graph);
};
const chain = (count: number): Seed[] => Array.from({ length: count }, (_, index) => ({ id: `n${index}`, dependsOn: index === 0 ? [] : [`n${index - 1}`] }));
const induced = (projection: ChainProjection, ids: ReadonlySet<string>) => projection.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
const addExpansion = (visible: ReadonlySet<string>, ids: readonly string[]) => new Set([...visible, ...ids]);
const allIds = (projection: ChainProjection) => new Set([...projection.mainIds, ...projection.externalIds]);
const edgeBoundary = (extra: boolean) => chain(50).map((seed, index) => ({
  ...seed,
  dependsOn: [...new Set([...(seed.dependsOn ?? []), ...(index >= 2 ? ['n0'] : []), ...([3, 4, 5].includes(index) ? ['n1'] : []), ...(extra && index === 4 ? ['n2'] : [])])],
}));

describe('progressive task graph visibility', () => {
  it('defines the initial overview budgets independently from manual expansion size', () => {
    expect([GRAPH_OVERVIEW_TASK_LIMIT, GRAPH_OVERVIEW_EDGE_LIMIT, GRAPH_EXPANSION_BATCH_SIZE]).toEqual([50, 100, 20]);
  });

  it('shows the complete 50-task projection and folds a 51-task chain at the exact node boundary', () => {
    for (const count of [50, 51]) {
      const index = indexOf(chain(count)); const projection = projectChain(index, 'n0'); const visible = createGraphOverview(index, projection);
      expect(visible).toEqual(new Set(Array.from({ length: 50 }, (_, position) => `n${position}`)));
      expect(projectVisibleTasks(projection, visible).edges).toHaveLength(49);
      expect(visible.size === allIds(projection).size).toBe(count === 50);
    }
  });

  it('shows all 100 induced edges but folds a 101-edge projection even when it has only 50 tasks', () => {
    const index100 = indexOf(edgeBoundary(false)); const p100 = projectChain(index100, 'n0');
    const index101 = indexOf(edgeBoundary(true)); const p101 = projectChain(index101, 'n0');
    expect(p100.edges).toHaveLength(100); expect(p101.edges).toHaveLength(101);
    expect(createGraphOverview(index100, p100)).toEqual(allIds(p100));
    const visible = createGraphOverview(index101, p101);
    expect(visible.size).toBe(49); expect(induced(p101, visible)).toHaveLength(99); expect(visible.has('n49')).toBe(false);
  });

  it('traverses a deep chain through accepted nodes only and offers only the next direct successor', () => {
    const index = indexOf(chain(1000)); const projection = projectChain(index, 'n0'); const visible = createGraphOverview(index, projection);
    expect([...visible]).toEqual(Array.from({ length: 50 }, (_, position) => `n${position}`));
    expect(getTaskExpansion(index, projection, visible, 'n49', 'successors')).toEqual({ ids: ['n50'], totalHidden: 1, addedEdges: 1 });
    expect(getTaskExpansion(index, projection, visible, 'n0', 'successors')).toEqual({ ids: [], totalHidden: 0, addedEdges: 0 });
  });

  it('admits all induced edges with a node and never traverses descendants of a rejected candidate', () => {
    const seeds: Seed[] = [{ id: 'root' }, ...Array.from({ length: 14 }, (_, index) => ({
      id: `dense${index}`, dependsOn: ['root', ...Array.from({ length: index }, (_, before) => `dense${before}`)],
    })), { id: 'behind-rejected', dependsOn: ['dense13'] }];
    const index = indexOf(seeds); const projection = projectChain(index, 'root'); const visible = createGraphOverview(index, projection);
    expect(induced(projection, visible).length).toBeLessThanOrEqual(100);
    expect(visible.has('dense13')).toBe(false); expect(visible.has('behind-rejected')).toBe(false);
    expect(projectVisibleTasks(projection, visible).edges).toEqual(induced(projection, visible));
  });

  it('uses one FIFO traversal with successors before prerequisites at each accepted node', () => {
    const external = Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, dependsOn: index === 0 ? [] : [`e${index - 1}`] }));
    const main = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, dependsOn: index === 0 ? ['root', 'e4'] : [`m${index - 1}`], externalDependsOn: index === 0 ? ['e4'] : [] }));
    const index = indexOf([...external, { id: 'root' }, ...main]); const projection = projectChain(index, 'root');
    const visible = createGraphOverview(index, projection);
    expect([...visible].slice(0, 6)).toEqual(['root', 'm0', 'm1', 'e4', 'm2', 'e3']);
    expect(visible.size).toBe(50); expect([...projection.externalIds].every((id) => visible.has(id))).toBe(true);
  });

  it('keeps directional order in the snapshot rather than sorting task IDs or dependency arrays', () => {
    const names = Array.from({ length: 70 }, (_, index) => `task-${70 - index}`);
    const index = indexOf([{ id: 'root' }, ...names.map((id) => ({ id, dependsOn: ['root'] }))]); const projection = projectChain(index, 'root');
    const visible = createGraphOverview(index, projection);
    expect([...visible]).toEqual(['root', ...names.slice(0, 49)]);
    expect(getTaskExpansion(index, projection, visible, 'root', 'successors').ids).toEqual(names.slice(49, 69));
    const shuffled: ChainProjection = { ...projection, mainIds: new Set([...projection.mainIds].reverse()), edges: [...projection.edges].reverse() };
    expect(createGraphOverview(index, shuffled)).toEqual(visible);
    expect([...createGraphOverview(index, shuffled)]).toEqual([...visible]);
  });

  it('expands a large fanout in exact direct-neighbor batches beyond the initial task budget', () => {
    const index = indexOf([{ id: 'root' }, ...Array.from({ length: 100 }, (_, position) => ({ id: `child${position}`, dependsOn: ['root'] }))]);
    const projection = projectChain(index, 'root'); const visible = createGraphOverview(index, projection);
    const first = getTaskExpansion(index, projection, visible, 'root', 'successors');
    expect(first).toEqual({ ids: Array.from({ length: 20 }, (_, position) => `child${position + 49}`), totalHidden: 51, addedEdges: 20 });
    const expanded = addExpansion(visible, first.ids); expect(expanded.size).toBe(70);
    expect(getTaskExpansion(index, projection, expanded, 'root', 'successors').totalHidden).toBe(31);
    expect(createGraphOverview(index, projection)).toEqual(visible);
  });

  it('counts new induced edges between new neighbors and existing tasks without a manual edge cap', () => {
    const index = indexOf([{ id: 'root' }, { id: 'existing', dependsOn: ['root'] }, ...Array.from({ length: 25 }, (_, position) => ({
      id: `child${position}`, dependsOn: ['root', 'existing', ...Array.from({ length: position }, (_, before) => `child${before}`)],
    }))]);
    const projection = projectChain(index, 'root'); const visible = new Set(['root', 'existing']);
    const first = getTaskExpansion(index, projection, visible, 'root', 'successors');
    expect(first.ids).toHaveLength(20); expect(first.totalHidden).toBe(25); expect(first.addedEdges).toBe(230);
    const expanded = addExpansion(visible, first.ids);
    expect(induced(projection, expanded).length - induced(projection, visible).length).toBe(first.addedEdges);
    expect(getTaskExpansion(index, projection, expanded, 'root', 'successors').addedEdges).toBe(120);
  });

  it('reveals prerequisites directly, leaves their ancestors folded and reports exact counts', () => {
    const seeds: Seed[] = [{ id: 'root' }];
    for (let index = 0; index < 25; index++) seeds.push({ id: `ancestor${index}` }, { id: `external${index}`, dependsOn: [`ancestor${index}`] });
    seeds.push({ id: 'target', dependsOn: ['root', ...Array.from({ length: 25 }, (_, index) => `external${index}`).reverse()], externalDependsOn: Array.from({ length: 25 }, (_, index) => `external${index}`) });
    const index = indexOf(seeds); const projection = projectChain(index, 'root'); const visible = new Set(['root', 'target']);
    expect(getTaskExpansion(index, projection, visible, 'target')).toEqual({ ids: Array.from({ length: 20 }, (_, position) => `external${position}`), totalHidden: 25, addedEdges: 20 });
    expect(getTaskExpansion(index, projection, visible, 'target').ids.some((id) => id.startsWith('ancestor'))).toBe(false);
  });

  it('folds main and external tasks, deduplicates shared context and never expands outside the full projection', () => {
    const index = indexOf([{ id: 'external' }, { id: 'outside', dependsOn: ['external'] }, { id: 'root' },
      ...Array.from({ length: 60 }, (_, position) => ({ id: `main${position}`, dependsOn: ['root'] })), { id: 'join', dependsOn: ['root', 'external'], externalDependsOn: ['external'] }]);
    const projection = projectChain(index, 'root'); const overview = createGraphOverview(index, projection);
    expect(overview.has('join')).toBe(false); expect(overview.has('external')).toBe(false); expect(allIds(projection).has('outside')).toBe(false);
    const expanded = addExpansion(overview, getTaskExpansion(index, projection, overview, 'root', 'successors').ids);
    expect(getTaskExpansion(index, projection, expanded, 'join')).toEqual({ ids: ['external'], totalHidden: 1, addedEdges: 1 });
    expanded.add('external');
    expect(getTaskExpansion(index, projection, expanded, 'external', 'successors')).toEqual({ ids: [], totalHidden: 0, addedEdges: 0 });
    const view = projectVisibleTasks(projection, expanded);
    expect(view.externalIds).toEqual(new Set(['external'])); expect(view.edges).toEqual(induced(projection, expanded));
    expect(view.edges.find((edge) => edge.source === 'external' && edge.target === 'join')?.external).toBe(true);
  });

  it('keeps complete-chain completion and progress independent from rendered membership', () => {
    const index = indexOf(chain(80), 'done'); const projection = projectChain(index, 'n0'); const visible = createGraphOverview(index, projection);
    const view = projectVisibleTasks(projection, visible);
    expect(projection.mainIds.size).toBe(80); expect(view.mainIds.size).toBe(50);
    expect(view.completed).toBe(80); expect(index.components.get('n0')!.progress).toEqual({ total: 80, done: 80, status: 'done' });
  });

  it('retains waiting ancestors and hidden todo members in the full-chain progress', () => {
    const seeds: Seed[] = [{ id: 'external', status: 'todo' }, ...chain(80).map((seed, index): Seed => ({
      ...seed, status: 'todo', dependsOn: index === 79 ? ['n78', 'external'] : seed.dependsOn!, externalDependsOn: index === 79 ? ['external'] : [],
    }))];
    const index = indexOf(seeds); const projection = projectChain(index, 'n0'); const visible = createGraphOverview(index, projection);
    expect([...visible].every((id) => index.nodes.get(id)!.status === 'todo')).toBe(true);
    expect(visible.has('external')).toBe(false); expect(visible.has('n79')).toBe(false);
    expect(projection.externalIds).toEqual(new Set(['external'])); expect(projection.mainIds.size).toBe(80);
    expect(getTaskExpansion(index, projection, visible, 'n49', 'successors')).toEqual({ ids: ['n50'], totalHidden: 1, addedEdges: 1 });
    expect(projectVisibleTasks(projection, visible).completed).toBe(0);
    expect(index.components.get('n0')!.progress).toEqual({ total: 80, done: 0, status: 'todo' });
  });

  it('prunes disconnected retained nodes after refresh without adding a new connecting path or new neighbors', () => {
    const beforeIndex = indexOf([{ id: 'root' }, { id: 'a', dependsOn: ['root'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['root'] }]);
    const before = projectChain(beforeIndex, 'root'); const visible = createGraphOverview(beforeIndex, before);
    const afterIndex = indexOf([{ id: 'root' }, { id: 'new-path', dependsOn: ['root'] }, { id: 'b', dependsOn: ['new-path'] }, { id: 'c', dependsOn: ['root'] }, { id: 'new-leaf', dependsOn: ['root'] }]);
    const after = projectChain(afterIndex, 'root'); const reconciled = reconcileVisibleTasks(after, visible);
    expect(reconciled).toEqual(new Set(['root', 'c']));
    expect(reconciled.has('new-path')).toBe(false); expect(reconciled.has('new-leaf')).toBe(false);
    expect(createGraphOverview(afterIndex, after)).toEqual(allIds(after));
    expect(reconcileVisibleTasks(after, new Set(['missing']))).toEqual(new Set(['root']));
  });

  it('retains external connections through the induced visible graph and requires explicit global reset', () => {
    const index = indexOf([{ id: 'external' }, { id: 'root' }, { id: 'join', dependsOn: ['root', 'external'], externalDependsOn: ['external'] }]); const projection = projectChain(index, 'root');
    expect(reconcileVisibleTasks(projection, new Set(['root', 'join', 'external']))).toEqual(new Set(['root', 'join', 'external']));
    expect(reconcileVisibleTasks(projection, new Set(['root', 'external']))).toEqual(new Set(['root']));
    const largeIndex = indexOf(chain(100)); const largeProjection = projectChain(largeIndex, 'n0'); const overview = createGraphOverview(largeIndex, largeProjection);
    const expanded = addExpansion(overview, getTaskExpansion(largeIndex, largeProjection, overview, 'n49', 'successors').ids);
    expect(reconcileVisibleTasks(largeProjection, expanded)).toEqual(expanded);
    expect(createGraphOverview(largeIndex, largeProjection)).toEqual(overview);
  });

  it('reaches every ordinary starting branch through existing prerequisite expansion', () => {
    const roots: Seed[] = Array.from({ length: 60 }, (_, position) => ({ id: `root-${position}` }));
    const index = indexOf([...roots, { id: 'join', dependsOn: roots.map((task) => task.id) }]);
    expect(index.representativeIds).toEqual(['root-0']);
    const projection = projectChain(index, 'root-0');
    const overview = createGraphOverview(index, projection);
    expect(overview.size).toBe(50);
    expect(induced(projection, overview)).toHaveLength(49);
    expect([...overview].slice(0, 3)).toEqual(['root-0', 'join', 'root-1']);
    const expansion = getTaskExpansion(index, projection, overview, 'join', 'prerequisites');
    expect(expansion).toEqual({ ids: roots.slice(49).map((task) => task.id), totalHidden: 11, addedEdges: 11 });
    const expanded = addExpansion(overview, expansion.ids);
    expect(expanded).toEqual(allIds(projection));
    expect(projectVisibleTasks(projection, expanded).edges).toHaveLength(60);
    expect(index.components.get('root-0')!.progress.total).toBe(61);
  });

  it('preserves inputs and rejects expansion of an unavailable control', () => {
    const index = indexOf(chain(60)); const projection = projectChain(index, 'n0'); const visible = createGraphOverview(index, projection);
    const snapshot = { projection: structuredClone(projection), visible: [...visible], successors: [...index.successors].map(([id, ids]) => [id, [...ids]]), nodes: [...index.nodes] };
    createGraphOverview(index, projection); projectVisibleTasks(projection, visible); getTaskExpansion(index, projection, visible, 'n49', 'successors'); reconcileVisibleTasks(projection, visible);
    expect(projection).toEqual(snapshot.projection); expect([...visible]).toEqual(snapshot.visible); expect([...index.successors]).toEqual(snapshot.successors); expect([...index.nodes]).toEqual(snapshot.nodes);
    expect(() => getTaskExpansion(index, projection, visible, 'missing')).toThrow(GraphDataError);
    expect(() => getTaskExpansion(index, projection, visible, 'n59')).toThrow(GraphDataError);
  });
});
