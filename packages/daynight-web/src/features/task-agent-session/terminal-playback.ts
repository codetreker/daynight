import type { SessionV2Archive, SessionV2FrameFile, SessionV2Gap } from '../../../../daynight/src/session/v2/types';

export type TerminalPlaybackItem = { readonly kind: 'frame'; readonly time: bigint; readonly file: SessionV2FrameFile }
  | { readonly kind: 'gap'; readonly time: bigint; readonly end: bigint; readonly reason: SessionV2Gap['reason'] };
export type TerminalPlayback = { readonly items: readonly TerminalPlaybackItem[]; readonly duration: bigint };

/** Segment ordinals and monotonic durations remain authoritative across clock changes. */
export function buildTerminalPlayback(archive: SessionV2Archive): TerminalPlayback {
  const files = new Map(archive.files.map(file => [file.fileId, file]));
  const segments = new Map(archive.segments.map(segment => [segment.segmentId, segment]));
  const entries = new Map<string, TerminalPlaybackItem[]>();
  for (const entry of archive.index) {
    const list = entries.get(entry.segmentId) ?? [];
    list.push({ kind: 'frame', time: BigInt(entry.firstElapsedMs), file: files.get(entry.fileId)! });
    entries.set(entry.segmentId, list);
  }
  const boundaries = new Map<string, SessionV2Gap>();
  for (const gap of archive.gaps) {
    if ('kind' in gap) boundaries.set(`${gap.to.executionGeneration}/${gap.to.segmentId ?? ''}`, gap);
    else {
      const list = entries.get(gap.segmentId) ?? [];
      list.push({ kind: 'gap', time: BigInt(gap.startElapsedMs), end: BigInt(gap.endElapsedMs ?? segments.get(gap.segmentId)!.durationMs), reason: gap.reason });
      entries.set(gap.segmentId, list);
    }
  }
  const items: TerminalPlaybackItem[] = [];
  let offset = 0n;
  const addBoundary = (generation: string, segmentId: string | null) => {
    const gap = boundaries.get(`${generation}/${segmentId ?? ''}`);
    if (gap) items.push({ kind: 'gap', time: offset, end: offset, reason: gap.reason });
  };
  for (const run of archive.runs) {
    if (run.segmentIds.length === 0) addBoundary(run.executionGeneration, null);
    for (const segmentId of run.segmentIds) {
      addBoundary(run.executionGeneration, segmentId);
      const list = entries.get(segmentId) ?? [];
      list.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.kind === 'gap' ? -1 : 1);
      for (const item of list) items.push(item.kind === 'frame' ? { ...item, time: offset + item.time } : { ...item, time: offset + item.time, end: offset + item.end });
      offset += BigInt(segments.get(segmentId)!.durationMs);
    }
  }
  return { items, duration: offset };
}

/** Seeking exactly to a boundary exposes its gap instead of silently crossing it. */
export function seekTerminalPlayback(model: TerminalPlayback, time: bigint): number {
  let low = 0, high = model.items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (model.items[middle]!.time <= time) low = middle + 1;
    else high = middle;
  }
  let index = Math.max(0, low - 1);
  while (index > 0 && model.items[index - 1]!.time === time) index--;
  for (let candidate = index; candidate < low && model.items[candidate]!.time === time; candidate++) if (model.items[candidate]!.kind === 'gap') return candidate;
  return index;
}

export function advanceTerminalPlayback(model: TerminalPlayback, index: number, target: bigint): { index: number; time: bigint; stopped: boolean } {
  const time = target > model.duration ? model.duration : target;
  for (let next = index + 1; next < model.items.length && model.items[next]!.time <= time; next++) {
    index = next;
    const item = model.items[index]!;
    if (item.kind === 'gap') return { index, time: item.time, stopped: true };
  }
  return { index, time, stopped: time >= model.duration };
}

export function nextTerminalFrame(model: TerminalPlayback, index: number, direction: 1 | -1): number | null {
  for (let next = index + direction; next >= 0 && next < model.items.length; next += direction) if (model.items[next]!.kind === 'frame') return next;
  return null;
}

export function formatTerminalTime(time: bigint): string {
  const seconds = time / 1000n, minutes = seconds / 60n, hours = minutes / 60n;
  return `${hours > 0n ? `${hours}:${String(minutes % 60n).padStart(2, '0')}` : String(minutes).padStart(2, '0')}:${String(seconds % 60n).padStart(2, '0')}.${String(time % 1000n).padStart(3, '0')}`;
}
