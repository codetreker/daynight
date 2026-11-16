import { readFileSync } from 'node:fs';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionV2Archive, TerminalFrame } from '../../daynight/src/session/v2/types';
import { advanceTerminalPlayback, buildTerminalPlayback, formatTerminalTime, nextTerminalFrame, seekTerminalPlayback } from '../src/features/task-agent-session/terminal-playback';
import { TerminalRecordingView } from '../src/features/task-agent-session/TerminalRecordingView';
import { TerminalText } from '../src/features/task-agent-session/TerminalText';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');

const sample = (): SessionV2Archive => JSON.parse(readFileSync('../daynight/test/session/fixtures/v2/valid-archive.json', 'utf8'));
function recording(): SessionV2Archive {
  const archive = sample(), segment = archive.segments[0]!, file = archive.files[0]!;
  const frame: TerminalFrame = JSON.parse(file.data);
  const second = { ...segment, segmentId: '00000000-0000-4000-8000-000000000099', segmentOrdinal: '2', durationMs: '500' };
  const entries = [{ segmentId: segment.segmentId, time: '0', text: 'First frame' }, { segmentId: segment.segmentId, time: '800', text: 'After interruption' }, { segmentId: second.segmentId, time: '0', text: 'Second segment' }];
  return { ...archive, completeness: 'partial', segments: [{ ...segment, durationMs: '1000' }, second],
    runs: archive.runs.map(run => ({ ...run, segmentIds: [segment.segmentId, second.segmentId] })),
    files: entries.map((entry, i) => ({ ...file, fileId: `${file.fileId}-${i}`, segmentId: entry.segmentId, frameSeq: String(i + 1), data: JSON.stringify({ ...frame, frameSeq: String(i + 1), elapsedMs: entry.time, rows: [[{ ...frame.rows[0]![0]!, text: entry.text }]] }) })),
    index: entries.map((entry, i) => ({ fileId: `${file.fileId}-${i}`, segmentId: entry.segmentId, frameSeq: String(i + 1), firstElapsedMs: entry.time, lastElapsedMs: entry.time })),
    gaps: [{ segmentId: segment.segmentId, reason: 'read_interrupted', startElapsedMs: '400', endElapsedMs: '799' }, { kind: 'boundary', reason: 'restart', from: { executionGeneration: '1', segmentId: segment.segmentId }, to: { executionGeneration: '1', segmentId: second.segmentId } }],
  };
}

describe('terminal recording time and gaps', () => {
  it('orders independent frames by segment time and keeps zero-duration boundaries visible', () => {
    const model = buildTerminalPlayback(recording());
    expect(model.duration).toBe(1500n);
    expect(model.items.map(item => [item.kind, item.time])).toEqual([['frame', 0n], ['gap', 400n], ['frame', 800n], ['gap', 1000n], ['frame', 1000n]]);
    expect(seekTerminalPlayback(model, 600n)).toBe(1);
    expect(seekTerminalPlayback(model, 1000n)).toBe(3);
    expect(seekTerminalPlayback(model, 1400n)).toBe(4);
  });
  it('stops at the first gap even when a delayed playback tick crosses several frames', () => {
    const model = buildTerminalPlayback(recording());
    expect(advanceTerminalPlayback(model, 0, 1300n)).toEqual({ index: 1, time: 400n, stopped: true });
    expect(nextTerminalFrame(model, 1, 1)).toBe(2);
    expect(advanceTerminalPlayback(model, 2, 1300n)).toEqual({ index: 3, time: 1000n, stopped: true });
    expect(nextTerminalFrame(model, 3, 1)).toBe(4);
    expect(advanceTerminalPlayback(model, 4, 1600n)).toEqual({ index: 4, time: 1500n, stopped: true });
    expect(nextTerminalFrame(model, 4, 1)).toBeNull();
    expect(nextTerminalFrame(model, 3, -1)).toBe(2);
    expect(nextTerminalFrame(model, 0, -1)).toBeNull();
  });
  it('keeps elapsed time exact beyond the JavaScript safe integer range', () => {
    const archive = recording(); archive.segments[0]!.durationMs = '9007199254740993';
    const model = buildTerminalPlayback(archive);
    expect(model.duration).toBe(9007199254741493n);
    expect(model.items[4]!.time).toBe(9007199254740993n);
    expect(formatTerminalTime(3661234n)).toBe('1:01:01.234');
  });
  it('retains a boundary through an empty run and never borrows a neighboring screen for its gap', () => {
    const archive = recording(), first = archive.runs[0]!;
    archive.runs.push({ ...first, executionGeneration: '2', segmentIds: [] });
    archive.gaps.push({ kind: 'boundary', reason: 'restart', from: { executionGeneration: '1', segmentId: archive.segments[1]!.segmentId }, to: { executionGeneration: '2', segmentId: null } });
    const model = buildTerminalPlayback(archive);
    expect(advanceTerminalPlayback(model, 4, 1500n)).toEqual({ index: 5, time: 1500n, stopped: true });
    expect(model.items[5]!.kind).toBe('gap');
    expect(nextTerminalFrame(model, 5, 1)).toBeNull();
    expect(seekTerminalPlayback(model, -1n)).toBe(0);
    expect(formatTerminalTime(1234n)).toBe('00:01.234');
  });
  it('reveals the boundary when zero-duration segments share a timestamp with frames', () => {
    const archive = recording();
    archive.segments[0]!.durationMs = '0'; archive.index.splice(1, 1); archive.files.splice(1, 1); archive.gaps.splice(0, 1);
    const model = buildTerminalPlayback(archive);
    expect(seekTerminalPlayback(model, 0n)).toBe(1);
  });
});

describe('read-only recording controls', () => {
  it('pauses at an interval and a segment boundary until the reader explicitly continues', async () => {
    vi.useFakeTimers(); render(<TerminalRecordingView archive={recording()} active />);
    expect(screen.getByText('First frame')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByText('First frame')).toBeNull();
    expect(screen.getByText('Recording interrupted')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to next recorded section' }));
    expect(screen.getByText('After interruption')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByText('Recording restarted')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to next recorded section' }));
    expect(screen.getByText('Second segment')).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('seeks without earlier frames and pauses when hidden, without resuming on return', async () => {
    vi.useFakeTimers(); const archive = recording();
    const view = render(<TerminalRecordingView archive={archive} active />);
    fireEvent.change(screen.getByRole('slider', { name: 'Recording time' }), { target: { value: '9000' } });
    expect(screen.getByText('Second segment')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Previous frame' }));
    expect(screen.getByText('After interruption')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    view.rerender(<TerminalRecordingView archive={archive} active={false} />);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    view.rerender(<TerminalRecordingView archive={archive} active />);
    expect(screen.getByText('After interruption')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
    const zoom = screen.getByRole('combobox', { name: 'Text size' });
    expect(zoom.parentElement).toHaveAttribute('data-density', 'filter');
    expect(zoom.parentElement).toHaveAttribute('data-layout', 'content');
    fireEvent.change(zoom, { target: { value: '125' } });
    expect(view.container.querySelector('.terminal-recording')).toHaveStyle('--terminal-text-scale: 1.25');
    view.rerender(<TerminalRecordingView archive={archive} active />);
    expect(screen.getByRole('combobox', { name: 'Text size' })).toBe(zoom);
    expect(zoom).toHaveValue('125');
  });
  it('renders markup as literal text and applies only terminal text styling', () => {
    const frame: TerminalFrame = JSON.parse(sample().files[0]!.data);
    frame.rows = [[{ text: '<img src="https://invalid.example/x" onerror="alert(1)">', foreground: '#112233', background: '#aabbcc', bold: true, italic: true, underline: true, inverse: true }], []]; frame.height = 2;
    const view = render(<TerminalText frame={frame} />);
    expect(view.container.querySelectorAll('img,script,iframe,a')).toHaveLength(0);
    expect(screen.getByText(/<img/)).toHaveStyle({ color: '#aabbcc', backgroundColor: '#112233', fontWeight: '700', fontStyle: 'italic', textDecoration: 'underline' });
  });
  it('preserves empty screen rows rather than collapsing a blank terminal to zero height', () => {
    const frame: TerminalFrame = JSON.parse(sample().files[0]!.data);
    frame.rows = [[], []]; frame.height = 2;
    const view = render(<TerminalText frame={frame} />);
    expect(view.container.querySelector('pre')).toHaveStyle({ minHeight: '3.5em' });
  });
  it('shows a trailing gap honestly and has no continue action when no later frame exists', async () => {
    vi.useFakeTimers(); const archive: SessionV2Archive = JSON.parse(readFileSync('../daynight/test/session/fixtures/v2/valid-partial-archive.json', 'utf8'));
    const view = render(<TerminalRecordingView archive={archive} active />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '8000' } });
    expect(screen.getByText('Recording limit reached')).toBeVisible();
    expect(screen.getByText('No later recorded frames.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Continue to next recorded section' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeDisabled();
    view.setLocale('zh-CN');
    expect(screen.getByText('部分录制')).toBeVisible();
    expect(screen.getByText('已达录制上限')).toBeVisible();
  });
  it('pauses both explicitly and when the browser document becomes hidden', async () => {
    vi.useFakeTimers(); render(<TerminalRecordingView archive={recording()} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByText('First frame')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByText('First frame')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Play' })).toBeEnabled();
  });
});
