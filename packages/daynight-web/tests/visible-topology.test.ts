import { describe, expect, it } from 'vitest';
import { expectedBatch, expectedChainMembers, expectedDependencyTopology, expectedNodeHeights, expectedOverview, inducedTopology } from './helpers/visible-topology';
import type { DependencyTopology } from './helpers/visible-topology';
const graph = (count: number): DependencyTopology => ({ nodes: Array.from({ length: count }, (_, index) => ({ id: String(index) })), edges: Array.from({ length: count - 1 }, (_, index) => ({ id: `0->${index + 1}`, source: '0', target: String(index + 1), external: false })) });
describe('independent visible API topology expectations', () => {
  it('derives ordinary members and complete ancestors without adding external sibling branches', () => {
    const full = expectedDependencyTopology([
      { id: 'root', dependsOn: [], externalDependsOn: [] }, { id: 'child', dependsOn: ['root', 'external'], externalDependsOn: ['external'] },
      { id: 'external', dependsOn: ['ancestor'], externalDependsOn: [] }, { id: 'ancestor', dependsOn: [], externalDependsOn: [] },
      { id: 'sibling', dependsOn: ['external'], externalDependsOn: [] }, { id: 'unrelated', dependsOn: [], externalDependsOn: [] },
    ], 'root');
    expect(full.nodes.map(({ id }) => id)).toEqual(['root', 'child', 'external', 'ancestor']);
    expect(full.edges).toEqual([
      { id: 'root->child', source: 'root', target: 'child', external: false },
      { id: 'external->child', source: 'external', target: 'child', external: true },
      { id: 'ancestor->external', source: 'ancestor', target: 'external', external: false },
    ]);
  });
  it('merges two ordinary roots exactly once and retains an external shortcut within that component', () => {
    const tasks = [
      { id: 'a', dependsOn: [], externalDependsOn: [] },
      { id: 'b', dependsOn: [], externalDependsOn: [] },
      { id: 'merge', dependsOn: ['a', 'b'], externalDependsOn: [] },
      { id: 'sink', dependsOn: ['a', 'merge'], externalDependsOn: ['a'] },
    ];
    expect(expectedChainMembers(tasks, 'a')).toEqual(['a', 'b', 'merge', 'sink']);
    expect(expectedChainMembers(tasks, 'b')).toEqual(expectedChainMembers(tasks, 'a'));
    expect(expectedDependencyTopology(tasks, 'a').edges).toEqual([
      { id: 'a->merge', source: 'a', target: 'merge', external: false },
      { id: 'b->merge', source: 'b', target: 'merge', external: false },
      { id: 'a->sink', source: 'a', target: 'sink', external: true },
      { id: 'merge->sink', source: 'merge', target: 'sink', external: false },
    ]);
  });
  it('keeps external-only tasks singleton while still projecting all prerequisites', () => {
    const tasks = [
      { id: 'source', dependsOn: [], externalDependsOn: [] },
      { id: 'consumer', dependsOn: ['source'], externalDependsOn: ['source'] },
    ];
    expect(expectedChainMembers(tasks, 'consumer')).toEqual(['consumer']);
    expect(expectedChainMembers(tasks, 'source')).toEqual(['source']);
    expect(expectedDependencyTopology(tasks, 'consumer')).toEqual({ memberIds: ['consumer'], nodes: [{ id: 'source' }, { id: 'consumer' }], edges: [
      { id: 'source->consumer', source: 'source', target: 'consumer', external: true },
    ] });
  });
  it('derives card heights from hidden direct neighbors within the root projection only', () => {
    const full = expectedDependencyTopology([
      { id: 'root', dependsOn: [], externalDependsOn: [] }, { id: 'child', dependsOn: ['root', 'external'], externalDependsOn: ['external'] },
      { id: 'external', dependsOn: [], externalDependsOn: [] }, { id: 'unrelated', dependsOn: ['external'], externalDependsOn: [] },
    ], 'root');
    expect(expectedNodeHeights(full, ['root', 'child'])).toEqual([{ id: 'root', height: 96 }, { id: 'child', height: 136 }]);
    expect(expectedNodeHeights(full, ['root', 'child', 'external'])).toEqual([
      { id: 'root', height: 96 }, { id: 'child', height: 96 }, { id: 'external', height: 96 },
    ]);
    expect(expectedNodeHeights(full, ['external'])).toEqual([{ id: 'external', height: 136 }]);
  });
  it('retains exact small graphs and bounds the deterministic root-anchored overview', () => {
    const fifty = graph(50); expect(expectedOverview(fifty, '0', fifty.nodes.map(({ id }) => id))).toEqual(fifty);
    const fiftyOne = graph(51); const overview = expectedOverview(fiftyOne, '0', fiftyOne.nodes.map(({ id }) => id));
    expect(overview.nodes.map(({ id }) => id)).toEqual(fiftyOne.nodes.slice(0, 50).map(({ id }) => id));
    expect(overview.edges).toHaveLength(49);
  });
  it('shows exactly one hundred edges in full and bounds a one-hundred-and-one-edge projection', () => {
    const nodes = Array.from({ length: 15 }, (_, index) => ({ id: String(index) }));
    const edges = nodes.flatMap((target, index) => nodes.slice(0, index).map((source) => ({ id: `${source.id}->${target.id}`, source: source.id, target: target.id, external: false })));
    const hundred = { nodes, edges: edges.slice(0, 100) }; const hundredOne = { nodes, edges: edges.slice(0, 101) }; const order = nodes.map(({ id }) => id);
    expect(expectedOverview(hundred, '0', order)).toEqual(hundred);
    const overview = expectedOverview(hundredOne, '0', order);
    expect(overview.edges.length).toBeLessThanOrEqual(100); expect(overview.nodes.length).toBeLessThan(15);
  });
  it('includes every induced edge and rejects duplicate or unknown visible identities', () => {
    const full = graph(4); expect(inducedTopology(full, ['0', '2', '3']).edges.map(({ id }) => id)).toEqual(['0->2', '0->3']);
    expect(() => inducedTopology(full, ['0', '0'])).toThrow(); expect(() => inducedTopology(full, ['missing'])).toThrow();
  });
  it('expands at most twenty hidden direct neighbors without a manual edge limit', () => {
    const full = graph(80); const order = full.nodes.map(({ id }) => id);
    expect(expectedBatch(full, ['0'], '0', 'downstream', order).nodes).toHaveLength(21);
    const dense: DependencyTopology = { nodes: full.nodes, edges: full.nodes.flatMap((node, index) => index === 0 ? [] : [
      { id: `0->${node.id}`, source: '0', target: node.id, external: false },
      ...full.nodes.slice(1, index).map((previous) => ({ id: `${previous.id}->${node.id}`, source: previous.id, target: node.id, external: false })),
    ]) };
    expect(expectedBatch(dense, ['0', '1', '2', '3', '4'], '0', 'downstream', order).edges.length).toBeGreaterThan(100);
  });
});
