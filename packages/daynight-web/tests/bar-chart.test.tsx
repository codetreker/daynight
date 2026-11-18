import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarChart, type BarChartPoint } from '../src/ui/bar-chart';

const points: BarChartPoint[] = [
  { key: 'a', label: 'Alpha', value: 0n },
  { key: 'b', label: 'Beta', value: 500000000000000000000n, axisLabel: 'B' },
  { key: 'c', label: 'Gamma', value: 1000000000000000000000n },
];
const formatValue = (value: bigint) => `${value} units`;
const chart = (data = points, domainMax = 1000000000000000000000n) => <BarChart label="Example" points={data} domainMax={domainMax} formatValue={formatValue} />;

describe('BarChart', () => {
  it('uses exact integer ratios and exposes complete readings with a single tab stop', () => {
    const { container } = render(chart());
    const group = screen.getByRole('listbox', { name: 'Example' });
    expect(group).toHaveAttribute('tabindex', '0');
    expect(container.querySelectorAll('[tabindex]')).toHaveLength(1);
    expect(container.querySelectorAll('.bar-chart__point')[1]).toHaveStyle('--bar-chart-height: 50%');
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName('Gamma: 1000000000000000000000 units');
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName('Beta: 500000000000000000000 units');
    fireEvent.keyDown(group, { key: 'Home' });
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName('Alpha: 0 units');
  });
  it('keeps keyed selection across reordering and falls back when removed', () => {
    const { rerender } = render(chart());
    const group = screen.getByRole('listbox');
    fireEvent.keyDown(group, { key: 'ArrowDown' });
    rerender(chart([points[2]!, points[1]!, points[0]!]));
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName(/Beta/);
    rerender(chart([points[2]!, points[0]!]));
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName(/Gamma/);
    rerender(chart([points[2]!, points[1]!, points[0]!]));
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName(/Gamma/);
  });
  it('draws an all-zero domain without division by zero', () => {
    const { container } = render(chart([{ key: 'z', label: 'Zero', value: 0n }], 0n));
    expect(container.querySelector('.bar-chart__point')).toHaveStyle('--bar-chart-height: 0%');
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName('Zero: 0 units');
  });
  it('rejects invalid series', () => {
    for (const [data, max] of [[[], 0n], [[points[0], points[0]], 1n], [[{ key: 'x', label: 'X', value: -1n }], 1n], [[points[2]], 1n], [[points[0]], -1n]] as [BarChartPoint[], bigint][]) {
      expect(() => render(chart(data, max))).toThrow('BarChart requires');
    }
  });
});
