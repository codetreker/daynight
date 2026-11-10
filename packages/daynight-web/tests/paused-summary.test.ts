import { describe, expect, it } from 'vitest';
import { pausedSummaryTaskIds } from '../src/features/task-pause/paused-summary';

describe('paused summary eligibility', () => {
  it('counts unique paused IDs in scope except done, retaining cancelled', () => {
    const nodes = [
      { id: 'done', status: 'done' },
      { id: 'todo', status: 'todo' },
      { id: 'todo', status: 'todo' },
      { id: 'running', status: 'in_progress' },
      { id: 'cancelled', status: 'cancelled' },
      { id: 'unpaused', status: 'todo' },
    ] as const;
    const raw = new Set(['done', 'todo', 'running', 'cancelled', 'outside']);
    expect(pausedSummaryTaskIds(nodes, raw)).toEqual(new Set(['todo', 'running', 'cancelled']));
    expect(raw).toEqual(new Set(['done', 'todo', 'running', 'cancelled', 'outside']));
    expect(pausedSummaryTaskIds(nodes, new Set())).toEqual(new Set());
  });
});
