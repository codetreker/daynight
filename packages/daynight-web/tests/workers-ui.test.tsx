import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { WorkerDetail, WorkerSummary } from '../src/api/workers';
import { taskDetailUrl } from '../src/app/router';
import { WorkersPage } from '../src/features/workers/WorkersPage';
import { WorkerDetailPage } from '../src/features/workers/WorkerDetailPage';
import { WorkerStatusBadge } from '../src/features/workers/WorkerStatusBadge';
import { formatWorkerBytes, formatWorkerRelative } from '../src/features/workers/presentation';
import { useWorkers } from '../src/features/workers/useWorkers';
import { useWorker } from '../src/features/workers/useWorker';
import { getFormats } from '../src/i18n/formats';
import { renderWithLocale } from './helpers/renderWithLocale';
import { toolPathActual, toolPathObservation, toolPathTelemetry } from './helpers/worker-tool-paths';

vi.mock('../src/features/workers/useWorkers', () => ({ useWorkers: vi.fn() }));
vi.mock('../src/features/workers/useWorker', () => ({ useWorker: vi.fn() }));
vi.mock('../src/features/workers/useWorkerMonitoring', () => { const state = { snapshot: null, status: 'loading', refreshing: false, error: null, stale: false, serverMilliseconds: null, refresh: () => {} }; return { useWorkerMonitoring: () => state, useWorkerMonitoringSummaries: () => state }; });
const id = (n: number) => `0000000${n}-1111-4111-8111-111111111111`;
const observedAt = '2026-10-29T12:00:00Z';
const now = Date.parse(observedAt);
const report = new Date(now - 20_000).toISOString();
const summary = (n = 1) => ({ workerId: id(n), machine: { id: id(n + 4), name: `worker-${n}` }, platform: 'linux' as const,
  lastReportedAt: report, taskObservationState: 'observed' as const, taskObservedAt: report, activeTaskCount: n === 1 ? 1 : 0 });
const detail = () => ({ ...summary(), inventoryObservedAt: '2026-10-29T11:59:30Z', tasks: [{ projectId: id(2), taskId: id(3), claimId: id(4), title: 'Build reliable workers', projectName: 'Runtime project', status: 'in_progress' as const, phase: 'verifying' as const, agent: 'claude' as const }],
  telemetry: { machine: summary().machine, platform: 'linux' as const, workingDirectory: '/srv/workspaces/runtime', sampledAt: report,
    os: { state: 'ok' as const, checkedAt: report, value: { type: 'Linux', release: '6.12.0', version: '#1 SMP PREEMPT', arch: 'x86_64' } },
    cpu: { state: 'ok' as const, checkedAt: report, value: { model: 'Actual CPU model', logicalProcessors: 32, usagePercent: 34.25 } },
    memory: { state: 'ok' as const, checkedAt: report, value: { usedBytes: 16 * 1024 ** 3, totalBytes: 64 * 1024 ** 3 } },
    disk: { state: 'ok' as const, checkedAt: report, value: { availableBytes: 32 * 1024 ** 3, totalBytes: 1024 ** 4 } },
    versions: { daynight: '0.27.1', herdr: { state: 'ok' as const, checkedAt: report, value: '0.9.9-private' }, codex: { state: 'ok' as const, checkedAt: report, value: '0.164.0' }, copilot: { state: 'not_installed' as const, checkedAt: report } },
  },
} satisfies WorkerDetail);
const refresh = vi.fn();
let listState: ReturnType<typeof useWorkers>;
let detailState: ReturnType<typeof useWorker>;
const listed = (items: readonly WorkerSummary[] = [summary()]): ReturnType<typeof useWorkers> => ({ snapshot: { observedAt, items }, status: 'ready', refreshing: false, error: null, stale: false, serverMilliseconds: now, refresh });
const shown = (worker: WorkerDetail = detail()): ReturnType<typeof useWorker> => ({ snapshot: { observedAt, worker }, status: 'ready', refreshing: false, error: null, stale: false, serverMilliseconds: now, refresh });
const showList = () => renderWithLocale(<WorkersPage readEnabled />, { locale: 'en' });
const showDetail = () => renderWithLocale(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />, { locale: 'en' });
const withTools = (entries: Parameters<typeof toolPathTelemetry>[0]) => {
  const worker = detail();
  return { ...worker, telemetry: { ...worker.telemetry, toolPaths: toolPathTelemetry(entries) } };
};

beforeEach(() => {
  refresh.mockReset(); listState = listed(); detailState = shown();
  vi.mocked(useWorkers).mockImplementation(() => listState);
  vi.mocked(useWorker).mockImplementation(() => detailState);
});

describe('Worker software summary', () => {
  const empty = (tool: 'codex' | 'copilot' | 'herdr', context: 'web' | 'herdr') => toolPathObservation(tool, context, { state: 'not_checked', actual: null });
  const row = (tool: string) => document.querySelector(`.worker-software-tool-paths[data-tool="${tool}"]`)!;
  const lines = (tool: string) => Array.from(row(tool).querySelectorAll('.worker-tool-version'), element => element.textContent);

  it('omits empty contexts in either direction, retains both real versions and keeps full details', () => {
    detailState = shown(withTools([toolPathObservation(), empty('codex', 'herdr'), empty('copilot', 'web'), toolPathObservation('copilot', 'herdr', { actual: toolPathActual('copilot', { version: '2.0' }) }), empty('herdr', 'herdr')]));
    const view = showDetail();
    expect(lines('codex')).toEqual(['Web · 1.2.3']); expect(lines('copilot')).toEqual(['Herdr · 2.0']);
    expect(lines('herdr')).toEqual([]); expect(row('herdr')).toHaveTextContent('Not checked');
    fireEvent.click(within(row('codex') as HTMLElement).getByText('View actual paths'));
    expect(row('codex').querySelector('[data-context="herdr"]')).not.toBeNull();
    detailState = shown(withTools([toolPathObservation(), toolPathObservation('codex', 'herdr', { actual: toolPathActual('codex', { version: '2.0' }) })]));
    view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />);
    expect(lines('codex')).toEqual(['Web · 1.2.3', 'Herdr · 2.0']);
    expect(lines('copilot')).toEqual([]); expect(row('copilot')).toHaveTextContent('Not checked');
  });

  it.each(['checking', 'pending', 'error'] as const)('shows %s with or without an actual version in both languages', state => {
    const failure = state === 'error' ? { code: 'not_found' as const, occurredAt: report } : null;
    detailState = shown(withTools([toolPathObservation('codex', 'web', { state, error: failure }), toolPathObservation('codex', 'herdr', { state, actual: null, error: failure, candidate: toolPathActual('codex', { version: 'candidate' }) })]));
    const view = showDetail();
    const labels = { checking: ['Checking', '正在检查'], pending: ['Awaiting application', '等待应用'], error: ['Application failed', '应用失败'] }[state];
    expect(lines('codex')).toEqual([`Web · 1.2.3 ${labels[0]}`, `Herdr · ${labels[0]}`]);
    expect(row('codex').querySelectorAll(`.worker-tool-state.${state}`)).toHaveLength(2);
    view.setLocale('zh-CN'); expect(lines('codex')).toEqual([`Web · 1.2.3 ${labels[1]}`, `Herdr · ${labels[1]}`]);
  });

  it('retains uncertain inventory and active-only contexts without claiming an actual version', () => {
    const active = toolPathActual('codex', { version: 'active-only' });
    detailState = shown(withTools([empty('codex', 'web'), { ...empty('codex', 'herdr'), activeSelectionCount: null, activeSelectionsComplete: false, activeObservationError: 'inventory_unavailable', activeSelections: [{ actual: active, executionCount: 1, instanceCount: 0, unconfirmedCount: 0 }] }]));
    showDetail(); expect(lines('codex')).toEqual(['Herdr · Not checked']);
    fireEvent.click(within(row('codex') as HTMLElement).getByText('View actual paths'));
    expect(row('codex')).toHaveTextContent('active-only'); expect(row('codex')).toHaveTextContent('inventory');
  });
});

describe('Worker list presentation', () => {
  it('shows account observations, distinct unknown and idle tasks, offline snapshots and real detail links', () => {
    listState = listed([summary(), summary(2), { ...summary(3), lastReportedAt: new Date(now - 6 * 3600_000).toISOString(), activeTaskCount: 2 }, { ...summary(4), taskObservationState: 'unavailable', taskObservedAt: null, activeTaskCount: null }]);
    showList();
    expect(screen.getByText('4 Workers')).toBeInTheDocument(); expect(screen.getByText('3 online')).toBeInTheDocument(); expect(screen.getByText('1 offline')).toBeInTheDocument();
    expect(screen.getByText('1 task in progress')).toBeInTheDocument(); expect(screen.getByText('No tasks currently in progress')).toBeInTheDocument();
    expect(screen.getByText('2 tasks · last observed snapshot')).toBeInTheDocument(); expect(screen.getByText('Task information awaiting synchronization')).toBeInTheDocument();
    expect(screen.getAllByText('Linux')).toHaveLength(4); expect(screen.queryByText('Actual CPU model')).toBeNull();
    const link = screen.getByRole('link', { name: 'View worker-1' }); expect(link).toHaveAttribute('href', `/workers/${id(1)}`);
    expect(within(link).getByText(getFormats('en').dateTime(report))).toHaveAttribute('datetime', report);
    fireEvent.click(link); expect(window.location.pathname).toBe(`/workers/${id(1)}`);
  });

  it.each(['en', 'zh-CN'] as const)('keeps the %s report time fixed across ticks and updates it with a new report', locale => {
    const oldReport = new Date(now - 6 * 3600_000).toISOString();
    listState = listed([summary(), { ...summary(2), lastReportedAt: oldReport }]);
    const view = renderWithLocale(<WorkersPage readEnabled />, { locale });
    const cards = screen.getAllByRole('link');
    const onlineTime = within(cards[0]!).getByText(getFormats(locale).dateTime(report));
    const offlineTime = within(cards[1]!).getByText(getFormats(locale).dateTime(oldReport));
    expect(onlineTime).toHaveAttribute('datetime', report); expect(offlineTime).toHaveAttribute('datetime', oldReport);
    listState = { ...listState, serverMilliseconds: Date.parse(report) + 120_000 };
    view.rerender(<WorkersPage readEnabled />);
    expect(onlineTime).toHaveTextContent(getFormats(locale).dateTime(report)); expect(offlineTime).toHaveTextContent(getFormats(locale).dateTime(oldReport));
    expect(within(cards[0]!).getByText(locale === 'zh-CN' ? '离线' : 'offline')).toBeInTheDocument();
    const newReport = new Date(now + 60_000).toISOString();
    listState = { ...listed([{ ...summary(), lastReportedAt: newReport }, { ...summary(2), lastReportedAt: oldReport }]), serverMilliseconds: now + 60_000 };
    view.rerender(<WorkersPage readEnabled />);
    expect(within(cards[0]!).getByText(getFormats(locale).dateTime(newReport))).toHaveAttribute('datetime', newReport);
    expect(within(cards[0]!).getByText(locale === 'zh-CN' ? '在线' : 'online')).toBeInTheDocument();
  });

  it('updates 119/120-second and 72-hour boundaries without replacing the focused card', () => {
    listState = { ...listed([summary()]), serverMilliseconds: Date.parse(report) + 119_000 };
    const view = showList(); const link = screen.getByRole('link', { name: 'View worker-1' }); link.focus(); expect(screen.getByText('online')).toBeInTheDocument();
    listState = { ...listState, serverMilliseconds: Date.parse(report) + 120_000 };
    view.rerender(<WorkersPage readEnabled />); expect(screen.getByText('offline')).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'View worker-1' })).toBe(link); expect(link).toHaveFocus();
    listState = { ...listState, serverMilliseconds: Date.parse(report) + 72 * 3600_000 };
    view.rerender(<WorkersPage readEnabled />); expect(link).toBeInTheDocument();
    listState = { ...listState, serverMilliseconds: Date.parse(report) + 72 * 3600_000 + 1 };
    view.rerender(<WorkersPage readEnabled />); expect(screen.queryByRole('link', { name: 'View worker-1' })).toBeNull(); expect(screen.getByText('No active Workers in the last 72 hours')).toBeInTheDocument();
  });

  it('labels retained badges and counts as the last confirmation on refresh failure and retries', () => {
    listState = { ...listed(), stale: true, error: new ApiError('network', null, 'network', 'request-42') };
    showList();
    const alert = screen.getByRole('alert'); expect(alert).toHaveTextContent('last confirmed observation'); expect(alert).toHaveTextContent('request-42');
    expect(screen.getByText('online · last confirmed').closest('.worker-status-badge')).toHaveClass('online'); expect(screen.getByText('1 task · last observed snapshot')).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })); expect(refresh).toHaveBeenCalledOnce();
  });

  it('retains the empty observation quietly during visibility/authentication recalibration', () => {
    listState = { ...listed([]), stale: true, refreshing: true };
    const view = showList(); expect(document.querySelector('.worker-sync-notice')).toBeNull(); expect(screen.getByText('No active Workers in the last 72 hours')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    view.rerender(<WorkersPage readEnabled={false} />); expect(vi.mocked(useWorkers)).toHaveBeenLastCalledWith({ readEnabled: false });
  });

  it('describes an earlier empty task inventory as a snapshot even while the machine is online', () => {
    listState = listed([{ ...summary(2), taskObservationState: 'stale' }]); showList();
    expect(screen.getByText('online')).toBeInTheDocument(); expect(screen.getByText('No tasks in the last observed snapshot')).toBeInTheDocument();
    expect(screen.queryByText('No tasks currently in progress')).toBeNull();
  });

  it.each([new ApiError('server', 500), new Error('private-error-body')])('renders a bounded read failure for an unconfirmed response', error => {
    listState = { ...listed(), snapshot: null, serverMilliseconds: null, status: 'error', error }; showList();
    expect(screen.getByRole('alert')).toHaveTextContent('The service could not provide a confirmed Worker observation.');
    expect(screen.queryByText('private-error-body')).toBeNull();
  });

  it('localizes a ready list without replacing its focused Worker or requesting refresh', () => {
    const view = showList(); const link = screen.getByRole('link', { name: 'View worker-1' }); link.focus(); view.setLocale('zh-CN');
    expect(screen.getByRole('heading', { name: '我的 Worker' })).toBeInTheDocument(); expect(screen.getByRole('link', { name: '查看 worker-1' })).toBe(link); expect(link).toHaveFocus();
    expect(screen.getByText('1 个进行中的任务')).toBeInTheDocument(); expect(screen.getByText('在线')).toBeInTheDocument(); expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['loading', 'error'] as const)('shows initial %s with no invented Worker information', status => {
    listState = { ...listed(), snapshot: null, serverMilliseconds: null, status, error: status === 'error' ? new ApiError('protocol') : null };
    showList(); expect(screen.queryByRole('link')).toBeNull();
    if (status === 'loading') expect(screen.getByText('Loading Workers')).toBeInTheDocument();
    else { expect(screen.getByRole('alert')).toHaveTextContent('invalid Worker response'); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(refresh).toHaveBeenCalledOnce(); }
  });
});

describe('Worker detail presentation', () => {
  it('retains data and focus through repeated quiet rechecks while keeping last-confirmed labels', () => {
    const view = showDetail(), task = screen.getByRole('link', { name: 'Build reliable workers' }), cpu = screen.getByRole('meter', { name: 'CPU usage' });
    const caption = screen.getByText('State at the last observation'), currentHeading = screen.getByRole('heading', { name: 'Tasks in progress 1' });
    expect(caption).toHaveAttribute('aria-hidden', 'true'); expect(currentHeading).not.toHaveAccessibleName(/State at the last observation/);
    task.focus();
    for (let attempt = 0; attempt < 2; attempt++) {
      detailState = { ...detailState, stale: true, refreshing: true };
      view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />);
      expect(document.querySelector('.worker-sync-notice')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('online · last confirmed')).toBeInTheDocument(); expect(screen.getByRole('heading', { name: /Task snapshot/ })).toBeInTheDocument();
      expect(screen.getByText('State at the last observation')).toBe(caption); expect(caption).toHaveAttribute('aria-hidden', 'false');
      expect(screen.getByRole('meter', { name: 'CPU usage' })).toBe(cpu); expect(cpu).toHaveAttribute('aria-valuenow', '34.25'); expect(task).toHaveFocus();
      detailState = shown(); view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />);
      expect(document.querySelector('.worker-sync-notice')).toBeNull(); expect(screen.getByText('online')).toBeInTheDocument(); expect(task).toHaveFocus();
      expect(screen.getByRole('heading', { name: 'Tasks in progress 1' })).toBe(currentHeading); expect(caption).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('keeps refresh failures visible during retries and clears them only after a successful observation', () => {
    detailState = { ...shown(), stale: true, error: new ApiError('network') };
    const view = showDetail(), alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Worker updates could not be synchronized.'); expect(alert).toHaveTextContent('last confirmed observation');
    expect(screen.getByText('online · last confirmed')).toBeInTheDocument(); expect(screen.queryByText('offline')).toBeNull();
    for (let attempt = 0; attempt < 2; attempt++) {
      detailState = { ...detailState, refreshing: true }; view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />);
      expect(screen.getByRole('alert')).toBe(alert); expect(within(alert).getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
      detailState = { ...detailState, refreshing: false }; view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />);
      expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
    }
    detailState = shown(); view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />);
    expect(screen.queryByRole('alert')).toBeNull(); expect(screen.getByText('online')).toBeInTheDocument();
  });

  it.each(['loading', 'error'] as const)('shows a detail-specific initial %s without a retained machine', status => {
    detailState = { ...shown(), snapshot: null, serverMilliseconds: null, status, error: status === 'error' ? new ApiError('network') : null };
    showDetail(); expect(screen.queryByText('worker-1')).toBeNull();
    expect(screen.getByText(status === 'loading' ? 'Loading Worker' : 'Worker details could not be loaded')).toBeInTheDocument();
    if (status === 'error') { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(refresh).toHaveBeenCalledOnce(); }
  });

  it('shows real resource scope, native versions, source times and current task anchors', () => {
    showDetail(); expect(screen.getByRole('heading', { name: 'worker-1' })).toBeInTheDocument();
    expect(screen.getByText('/srv/workspaces/runtime')).toBeInTheDocument(); expect(screen.getAllByText(/32 logical processors/)).toHaveLength(2);
    expect(screen.getByText('#1 SMP PREEMPT')).toBeInTheDocument(); expect(screen.getByText('x86_64')).toBeInTheDocument(); expect(screen.getByText('0.9.9-private')).toBeInTheDocument(); expect(screen.getByText('Not installed')).toBeInTheDocument();
    expect(screen.getAllByRole('meter')).toHaveLength(3); expect(screen.getByRole('meter', { name: 'CPU usage' })).toHaveAttribute('aria-valuenow', '34.25');
    expect(screen.getByRole('meter', { name: 'Working directory filesystem' })).toHaveClass('high');
    const link = screen.getByRole('link', { name: 'Build reliable workers' }); expect(link).toHaveAttribute('href', taskDetailUrl(id(2), id(3), { tab: 'overview', path: null }));
    expect(screen.getByText('Claude Code')).toBeInTheDocument(); expect(screen.getByText('Verifying')).toBeInTheDocument(); expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(document.querySelectorAll(`time[datetime="${report}"]`).length).toBeGreaterThan(5); expect(screen.getByText(/Resource sample/)).toBeInTheDocument();
    fireEvent.click(link, { ctrlKey: true }); expect(window.location.pathname).toBe('/projects');
    fireEvent.click(link); expect(window.location.pathname).toBe(`/projects/${id(2)}/tasks/${id(3)}`);
  });

  it('shows offline and retained inventory timestamps without presenting old tasks as current', () => {
    detailState = shown({ ...detail(), lastReportedAt: new Date(now - 3600_000).toISOString(), taskObservationState: 'stale' });
    showDetail(); expect(screen.getByText('offline').closest('.worker-status-badge')).toHaveClass('offline'); expect(screen.getByRole('status')).toHaveTextContent('last reported snapshot');
    expect(screen.getByRole('heading', { name: /Task snapshot/ })).toBeInTheDocument(); expect(screen.getByText('The latest report retains an earlier task observation.')).toBeInTheDocument();
    expect(document.querySelector('time[datetime="2026-10-29T11:59:30Z"]')).toBeInTheDocument();
  });

  it('distinguishes no task inventory from a genuinely empty observation', () => {
    detailState = shown({ ...detail(), taskObservationState: 'unavailable', activeTaskCount: null, taskObservedAt: null, inventoryObservedAt: null, tasks: [] });
    const view = showDetail(); expect(screen.getByText('Task information awaiting synchronization')).toBeInTheDocument(); expect(screen.queryByText('No tasks currently in progress')).toBeNull(); expect(screen.queryByRole('table')).toBeNull();
    detailState = shown({ ...detail(), activeTaskCount: 0, tasks: [] }); view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />);
    expect(screen.getByText('No tasks currently in progress')).toBeInTheDocument(); expect(screen.getByText('0', { selector: '.worker-count-badge' })).toBeInTheDocument();
  });

  it('keeps absent and failed software distinct and exposes collection errors without invented values', () => {
    const worker = detail(); detailState = shown({ ...worker, telemetry: { ...worker.telemetry,
      cpu: { state: 'error', checkedAt: report, code: 'invalid_sample' }, memory: { state: 'error', checkedAt: report, code: 'permission_denied' }, disk: { state: 'error', checkedAt: report, code: 'timeout' }, os: { state: 'error', checkedAt: report, code: 'io_error' },
      versions: { ...worker.telemetry.versions, herdr: { state: 'not_running', checkedAt: report }, codex: { state: 'error', checkedAt: report, code: 'command_failed' } },
    } });
    showDetail(); expect(screen.getByText('Not running')).toBeInTheDocument(); expect(screen.getByText('Not installed')).toBeInTheDocument(); expect(screen.getByText('Detection failed')).toBeInTheDocument(); expect(screen.getAllByText('Collection failed')).toHaveLength(6); expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('The version command failed.')).toBeInTheDocument(); expect(screen.queryByText(/logical processors/)).toBeNull();
  });

  it('renders actual zero capacities without dividing by zero or manufacturing a utilization percentage', () => {
    const worker = detail(); detailState = shown({ ...worker, telemetry: { ...worker.telemetry, cpu: { ...worker.telemetry.cpu, value: { ...worker.telemetry.cpu.value, logicalProcessors: 1 } }, memory: { state: 'ok', checkedAt: report, value: { usedBytes: 0, totalBytes: 0 } }, disk: { state: 'ok', checkedAt: report, value: { availableBytes: 0, totalBytes: 0 } } } });
    showDetail(); expect(screen.getAllByText(/1 logical processor/)).toHaveLength(2); expect(screen.getAllByRole('meter')).toHaveLength(1); expect(screen.getByText('0 B total memory')).toBeInTheDocument(); expect(screen.getByText('0 B total capacity')).toBeInTheDocument(); expect(document.body).not.toHaveTextContent('NaN'); expect(document.body).not.toHaveTextContent('Infinity');
  });

  it('removes expired or unavailable details and offers a retry and real return link', () => {
    detailState = { ...shown(), serverMilliseconds: Date.parse(report) + 72 * 3600_000 };
    const view = showDetail(); expect(screen.getByRole('heading', { name: 'worker-1' })).toBeInTheDocument();
    detailState = { ...detailState, serverMilliseconds: Date.parse(report) + 72 * 3600_000 + 1 };
    view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />); expect(screen.queryByText('/srv/workspaces/runtime')).toBeNull(); expect(screen.getByText('Worker unavailable')).toBeInTheDocument();
    detailState = { ...detailState, snapshot: null, serverMilliseconds: null, status: 'unavailable' };
    view.rerender(<WorkerDetailPage userId="00000000-0000-4000-8000-000000000001" workerId={id(1)} readEnabled />); expect(screen.getByText('Worker unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(refresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('link', { name: '← Back to my Workers' })); expect(window.location.pathname).toBe('/workers');
  });

  it('translates software, task status and phase while preserving user content and task focus', () => {
    const view = showDetail(); const task = screen.getByRole('link', { name: 'Build reliable workers' }); task.focus(); view.setLocale('zh-CN');
    expect(screen.getByRole('heading', { name: '软件版本' })).toBeInTheDocument(); expect(screen.getByText('未安装')).toBeInTheDocument(); expect(screen.getByText('验证中')).toBeInTheDocument(); expect(screen.getByText('进行中')).toBeInTheDocument(); expect(task).toHaveFocus(); expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('在线')).toBeInTheDocument(); expect(refresh).not.toHaveBeenCalled();
  });
});

it('formats byte magnitudes and relative time only from the supplied server observation', () => {
  expect(formatWorkerBytes(0, 'en')).toBe('0 B'); expect(formatWorkerBytes(1024, 'en')).toBe('1 KiB'); expect(formatWorkerBytes(Number.MAX_SAFE_INTEGER, 'en')).toBe('8 PiB');
  for (const [milliseconds, expected] of [[20_000, '20 seconds ago'], [60_000, '1 minute ago'], [3600_000, '1 hour ago'], [86400_000, 'yesterday']] as const) expect(formatWorkerRelative(new Date(now - milliseconds).toISOString(), now, 'en')).toBe(expected);
  expect(formatWorkerRelative(new Date(now + 20_000).toISOString(), now, 'en')).toBe('in 20 seconds');
});

it.each([
  { locale: 'zh-CN', online: true, status: '在线', confirmed: '在线 · 上次确认' },
  { locale: 'zh-CN', online: false, status: '离线', confirmed: '离线 · 上次确认' },
  { locale: 'en', online: true, status: 'online', confirmed: 'online · last confirmed' },
  { locale: 'en', online: false, status: 'offline', confirmed: 'offline · last confirmed' },
] as const)('renders $locale $status and reserves its last-confirmed label without duplicating text', ({ locale, online, status, confirmed }) => {
  const view = renderWithLocale(<WorkerStatusBadge online={online} />, { locale });
  const label = screen.getByText(status), badge = label.closest('.worker-status-badge');
  expect(badge).toHaveClass(online ? 'online' : 'offline');
  expect(badge).toHaveTextContent(new RegExp(`^${status}$`));
  expect(label.parentElement).toHaveAttribute('data-confirmed-label', confirmed);
  expect(screen.queryByText(confirmed)).toBeNull();
  view.rerender(<WorkerStatusBadge online={online} stale />);
  expect(screen.getByText(confirmed)).toBe(label);
  expect(label.parentElement).toHaveAttribute('data-confirmed-label', confirmed);
  expect(badge).toHaveTextContent(new RegExp(`^${confirmed}$`));
});
