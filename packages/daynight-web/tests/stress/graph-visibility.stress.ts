import './local-only';
import { describe, expect, it } from 'vitest';
import { projectChain } from '../../src/features/task-graph/model';
import { createGraphOverview, getTaskExpansion } from '../../src/features/task-graph/visibility';
import { chain, indexOf } from '../graph-visibility-fixture';

describe('complete graph-visibility capacity', () => {
  it('traverses a deep chain through accepted nodes only and offers only the next direct successor', () => {
    const index = indexOf(chain(1000)); const projection = projectChain(index, 'n0'); const visible = createGraphOverview(index, projection);
    expect([...visible]).toEqual(Array.from({ length: 50 }, (_, position) => `n${position}`));
    expect(getTaskExpansion(index, projection, visible, 'n49', 'successors')).toEqual({ ids: ['n50'], totalHidden: 1, addedEdges: 1 });
    expect(getTaskExpansion(index, projection, visible, 'n0', 'successors')).toEqual({ ids: [], totalHidden: 0, addedEdges: 0 });
  });

});
