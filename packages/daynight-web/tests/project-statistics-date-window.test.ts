import { afterEach, describe, expect, it } from 'vitest';
import { createDateWindow, dateIndexAt, localOffsetAt, type DateWindow } from '../src/features/project-statistics/date-window';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const instant = (value: string) => Date.parse(value);
const originalTZ = process.env.TZ;
afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

const expectIntervalsMatchWallDates = (window: DateWindow, offset: (millis: number) => number) => {
  expect(window.dates).toHaveLength(30);
  expect(window.segments.length).toBeGreaterThanOrEqual(2);
  expect(window.segments.length).toBeLessThanOrEqual(64);
  expect(window.segments.at(-1)?.dateIndex).toBeNull();
  expect(window.encoded).toBe(window.segments.map(item => `${item.dateIndex ?? '-'}@${item.startMillis}`).join(','));
  for (let i = 0; i < window.segments.length; i++) {
    const segment = window.segments[i]!;
    if (i > 0) {
      expect(segment.startMillis).toBeGreaterThan(window.segments[i - 1]!.startMillis);
      expect(segment.dateIndex).not.toBe(window.segments[i - 1]!.dateIndex);
    }
    for (const ms of [segment.startMillis - 1, segment.startMillis, segment.startMillis + 1]) {
      const label = new Date(ms + offset(ms)).toISOString().slice(0, 10);
      const index = window.dates.indexOf(label);
      expect(dateIndexAt(window, ms)).toBe(index < 0 ? null : index);
    }
  }
};

describe('local statistics date window', () => {
  it('uses 30 ordered civil dates and half-open boundaries, including zero-record days', () => {
    const window = createDateWindow(instant('2026-03-08T12:00:00Z'), () => 0);
    expect(window.dates[0]).toBe('2026-02-07');
    expect(window.endDate).toBe('2026-03-08');
    expect(window.segments).toHaveLength(31);
    expect(dateIndexAt(window, instant('2026-02-07T00:00:00Z') - 1)).toBeNull();
    expect(dateIndexAt(window, instant('2026-02-07T00:00:00Z'))).toBe(0);
    expect(dateIndexAt(window, instant('2026-03-08T23:59:59.999Z'))).toBe(29);
    expect(dateIndexAt(window, instant('2026-03-09T00:00:00Z'))).toBeNull();
    expect(dateIndexAt(window, NaN)).toBeNull();
    expectIntervalsMatchWallDates(window, () => 0);
  });

  it('locates both changes when the offset changes twice and returns to its prior value', () => {
    const start = instant('2026-03-08T02:15:00.123Z');
    const end = instant('2026-03-15T00:45:00.456Z');
    const offset = (ms: number) => ms >= start && ms < end ? 3 * HOUR : 2 * HOUR;
    const window = createDateWindow(instant('2026-03-20T12:00:00Z'), offset);
    expectIntervalsMatchWallDates(window, offset);
    expect(dateIndexAt(window, start - 1)).toBe(window.dates.indexOf('2026-03-08'));
    expect(dateIndexAt(window, start)).toBe(window.dates.indexOf('2026-03-08'));
    expect(dateIndexAt(window, end - 1)).toBe(window.dates.indexOf('2026-03-15'));
    expect(dateIndexAt(window, end)).toBe(window.dates.indexOf('2026-03-15'));
  });

  it('retains the skipped date and handles a backward shift across midnight', () => {
    const jump = instant('2011-12-30T10:00:00Z');
    const skipOffset = (ms: number) => ms < jump ? -10 * HOUR : 14 * HOUR;
    const skipped = createDateWindow(instant('2012-01-03T12:00:00Z'), skipOffset);
    expect(skipped.dates).toContain('2011-12-30');
    expect(skipped.segments.some(segment => segment.dateIndex === skipped.dates.indexOf('2011-12-30'))).toBe(false);
    expectIntervalsMatchWallDates(skipped, skipOffset);

    const rewind = instant('2026-03-10T00:30:00Z');
    const rewindOffset = (ms: number) => ms < rewind ? 2 * HOUR : -2 * HOUR;
    const repeated = createDateWindow(instant('2026-03-20T12:00:00Z'), rewindOffset);
    expect(dateIndexAt(repeated, rewind - 1)).toBe(repeated.dates.indexOf('2026-03-10'));
    expect(dateIndexAt(repeated, rewind)).toBe(repeated.dates.indexOf('2026-03-09'));
    expect(repeated.segments.filter(segment => segment.dateIndex === repeated.dates.indexOf('2026-03-10'))).toHaveLength(2);
    expectIntervalsMatchWallDates(repeated, rewindOffset);
  });

  it('uses browser local time and recognizes time-zone changes', () => {
    const now = instant('2026-03-08T07:30:00Z');
    process.env.TZ = 'America/New_York';
    const eastern = createDateWindow(now);
    expect(eastern.endDate).toBe('2026-03-08');
    expect(dateIndexAt(eastern, instant('2026-03-08T04:59:59.999Z'))).toBe(28);
    expect(dateIndexAt(eastern, instant('2026-03-08T05:00:00Z'))).toBe(29);
    expectIntervalsMatchWallDates(eastern, localOffsetAt);
    process.env.TZ = 'Pacific/Honolulu';
    const hawaii = createDateWindow(now);
    expect(hawaii.endDate).toBe('2026-03-07');
    expect(hawaii.encoded).not.toBe(eastern.encoded);
    expectIntervalsMatchWallDates(hawaii, localOffsetAt);
    process.env.TZ = 'Africa/Monrovia';
    expect(localOffsetAt(instant('1900-01-01T00:00:00Z'))).toBe(-2_588_000);
  });

  it('rejects invalid times, offsets and windows outside the server date range', () => {
    expect(() => createDateWindow(NaN)).toThrow(RangeError);
    expect(() => createDateWindow(instant('2026-03-08T00:00:00Z'), () => DAY + 1)).toThrow(RangeError);
    expect(() => createDateWindow(instant('0001-01-01T00:00:00Z'), () => 0)).toThrow(RangeError);
  });
});
