import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useDateWindow } from '../src/features/project-statistics/useDateWindow';

const sample = vi.hoisted(() => ({ value: { endDate: '2026-03-08', dates: ['2026-03-08'], segments: [{ dateIndex: null, startMillis: 10_000_000 }], encoded: '-@10000000' } }));
vi.mock('../src/features/project-statistics/date-window', () => ({ createDateWindow: () => sample.value }));
afterEach(() => vi.useRealTimers());
it('rechecks the local window while visible even without a focus or visibility event', () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const { result } = renderHook(() => useDateWindow(true));
  expect(result.current.endDate).toBe('2026-03-08');
  sample.value = { ...sample.value, endDate: '2026-03-09', encoded: '-@10000001' };
  act(() => vi.advanceTimersByTime(60_000));
  expect(result.current.endDate).toBe('2026-03-09');
});
