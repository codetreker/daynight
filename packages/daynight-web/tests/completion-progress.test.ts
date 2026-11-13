import { describe, expect, it } from 'vitest';
import { completionProgress } from '../src/features/task-graph/completion-progress';

describe('completion progress projection', () => {
  it.each([
    [{ done: 9, cancelled: 3, total: 12 }, { displayDone: 9, displayTotal: 9, percent: 100, widthPercent: 100 }],
    [{ done: 0, cancelled: 3, total: 3 }, { displayDone: 0, displayTotal: 0, percent: 0, widthPercent: 0 }],
    [{ done: 0, cancelled: 0, total: 0 }, { displayDone: 0, displayTotal: 0, percent: 0, widthPercent: 0 }],
    [{ done: 0, cancelled: 2, total: 5 }, { displayDone: 0, displayTotal: 3, percent: 0, widthPercent: 0 }],
  ])('projects %o', (input, expected) => {
    expect(completionProgress(input)).toEqual(expected);
  });

  it('floors the overview percent while retaining the exact track proportion', () => {
    const result = completionProgress({ done: 4, cancelled: 3, total: 9 });
    expect(result).toMatchObject({ displayDone: 4, displayTotal: 6, percent: 66 });
    expect(result.widthPercent).toBeCloseTo(66.6666667);
  });
});
