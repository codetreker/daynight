const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAYS = 30;

export interface DateWindowSegment {
  readonly dateIndex: number | null;
  readonly startMillis: number;
}

export interface DateWindow {
  readonly dates: readonly string[];
  readonly endDate: string;
  // Each segment ends at the next start. The final null segment is the exclusive end.
  readonly segments: readonly DateWindowSegment[];
  readonly encoded: string;
}

/** Recover the browser's local offset, including historical sub-minute offsets. */
export const localOffsetAt = (millis: number): number => {
  const local = new Date(millis);
  const wall = new Date(0);
  wall.setUTCFullYear(local.getFullYear(), local.getMonth(), local.getDate());
  wall.setUTCHours(local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds());
  return wall.getTime() - millis;
};

const dateLabel = (millis: number): string => {
  const date = new Date(millis);
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) throw new RangeError('Statistics dates must be in years 0001–9999');
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
};

/** Build the date intervals shared by Task and PR statistics. */
export const createDateWindow = (now = Date.now(), offsetAt: (millis: number) => number = localOffsetAt): DateWindow => {
  if (!Number.isSafeInteger(now)) throw new RangeError('Invalid statistics time');
  const checkedOffset = (millis: number): number => {
    const offset = offsetAt(millis);
    if (!Number.isSafeInteger(offset) || Math.abs(offset) > DAY) throw new RangeError('Invalid local offset');
    return offset;
  };
  const wallNow = now + checkedOffset(now);
  const today = Math.floor(wallNow / DAY) * DAY;
  const first = today - (DAYS - 1) * DAY;
  const dates = Array.from({ length: DAYS }, (_, i) => dateLabel(first + i * DAY));
  const searchStart = first - DAY;
  const searchEnd = today + 2 * DAY;

  // IANA 2026f has no two transitions within one hour. Hourly probes find
  // each offset change, and bisection locates its first millisecond.
  const transitions: { start: number; end: number; offset: number }[] = [];
  let segmentStart = searchStart;
  let previousOffset = checkedOffset(searchStart);
  for (let probe = searchStart + HOUR; probe <= searchEnd; probe += HOUR) {
    const nextOffset = checkedOffset(probe);
    if (nextOffset !== previousOffset) {
      let low = probe - HOUR;
      let high = probe;
      while (high - low > 1) {
        const middle = low + Math.floor((high - low) / 2);
        if (checkedOffset(middle) === previousOffset) low = middle;
        else high = middle;
      }
      transitions.push({ start: segmentStart, end: high, offset: previousOffset });
      segmentStart = high;
      previousOffset = nextOffset;
    }
  }
  transitions.push({ start: segmentStart, end: searchEnd, offset: previousOffset });

  const intervals: { dateIndex: number; start: number; end: number }[] = [];
  for (const transition of transitions) {
    for (let i = 0; i < DAYS; i++) {
      const start = Math.max(transition.start, first + i * DAY - transition.offset);
      const end = Math.min(transition.end, first + (i + 1) * DAY - transition.offset);
      if (start < end) intervals.push({ dateIndex: i, start, end });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  const segments: DateWindowSegment[] = [];
  let end: number | null = null;
  for (const interval of intervals) {
    if (end !== null && interval.start < end) throw new RangeError('Overlapping statistics intervals');
    if (end !== null && interval.start > end) segments.push({ dateIndex: null, startMillis: end });
    if (end === null || interval.start !== end || segments[segments.length - 1]?.dateIndex !== interval.dateIndex) {
      segments.push({ dateIndex: interval.dateIndex, startMillis: interval.start });
    }
    end = interval.end;
  }
  if (end === null) throw new RangeError('Empty statistics window');
  segments.push({ dateIndex: null, startMillis: end });
  if (segments.length < 2 || segments.length > 64) throw new RangeError('Invalid statistics window size');
  const encoded = segments.map(segment => `${segment.dateIndex ?? '-'}@${segment.startMillis}`).join(',');
  return { dates, endDate: dates[DAYS - 1]!, segments, encoded };
};

/** Return the window date containing an instant, or null outside its named intervals. */
export const dateIndexAt = (window: DateWindow, millis: number): number | null => {
  if (!Number.isFinite(millis)) return null;
  let low = 0;
  let high = window.segments.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (window.segments[middle]!.startMillis <= millis) low = middle + 1;
    else high = middle;
  }
  return low === 0 ? null : window.segments[low - 1]!.dateIndex;
};
