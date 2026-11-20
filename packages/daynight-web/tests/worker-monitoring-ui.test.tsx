import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { WorkerMonitoringDetail, WorkerMonitoringItem } from '../src/api/worker-monitoring';
import { taskDetailUrl } from '../src/app/router';
import { MonitoringCard, WorkerMonitoring, WorkerMonitoringTime } from '../src/features/workers/WorkerMonitoring';
import type { WorkerReadState } from '../src/features/workers/useWorkerObservation';
import { renderWithLocale } from './helpers/renderWithLocale';

const id = (n: number) => `0000000${n}-1111-4111-8111-111111111111`;
const receivedAt = '2026-11-09T12:00:00Z';
const time = Date.parse(receivedAt);
const scope = { kind: 'claim' as const, projectId: id(1), taskId: id(2), claimId: id(3) };
const association = { kind: 'task' as const, projectName: 'Private project', title: 'Private task' };
const detail: WorkerMonitoringDetail = { observedAt: receivedAt, state: 'available', revision: id(4), runId: id(5), sequence: '1', receivedAt, expiresAt: '2026-11-09T13:00:00Z', detailCoverage: 'complete', permissionProjection: 'current', data: {
  runId: id(5), sequence: '1', capturedAt: receivedAt, lifecycle: 'running',
  scheduler: { phase: 'waiting-poll', coverage: 'complete', cycleId: null, lastCompletedAt: receivedAt, lastSuccessfulAt: receivedAt, lastOutcome: 'completed', nextPollAt: null },
  capacity: { observedAt: receivedAt, quality: 'current', limit: 2, occupied: 2, available: 0, detailCoverage: 'complete' },
  admission: { observedAt: receivedAt, coverage: 'complete', reasons: [{ code: 'cleanup-capacity-blocked', scope: { kind: 'worker' }, association: null, observedAt: receivedAt, nextAttemptAt: null }] }, reservations: [{ reservationId: id(7), scope, association, roles: ['cleanup'], occupied: true, observedAt: receivedAt }],
  activities: [{ kind: 'cleanup', phase: 'worktree-removal', operationId: id(6), status: 'waiting', scope, association, startedAt: receivedAt, lastProgressAt: null, elapsedMs: 1000, deadlineAt: null, waitReason: 'retry-backoff', nextAttemptAt: receivedAt }],
  currentFailures: [{ operationId: id(6), component: 'cleanup', phase: 'worktree-removal', scope, association, error: { type: 'operation', code: 'command-failed', cause: 'A required command failed.', causeTruncated: false }, firstObservedAt: receivedAt, lastObservedAt: receivedAt, occurrencesInRun: 3, retryState: 'scheduled', nextAttemptAt: receivedAt }],
  lastRecovery: null, detailCoverage: 'complete', delivery: { lastSucceededAt: receivedAt, lastFailure: null },
} };
const state = (snapshot: WorkerMonitoringDetail | null = detail, now: number | null = time): WorkerReadState<WorkerMonitoringDetail> => ({ snapshot, status: 'ready', refreshing: false, error: null, stale: false, serverMilliseconds: now, refresh: vi.fn() });

it.each(['en', 'zh-CN'] as const)('omits diagnostic panels and their data in %s', locale => {
  const hiddenScope = { ...scope, claimId: id(8) };
  const hiddenAssociation = { ...association, title: 'Diagnostic-only task' };
  const snapshot: WorkerMonitoringDetail = { ...detail, data: { ...detail.data,
    capacity: { ...detail.data.capacity!, limit: 6, occupied: 6, breakdown: { active: 1, retained: 5 } },
    admission: { ...detail.data.admission, reasons: [detail.data.admission.reasons[0]!, { ...detail.data.admission.reasons[0]!, code: 'claim-unconfirmed', scope, association: { ...association, title: 'Admission task' } }] },
    currentFailures: [{ ...detail.data.currentFailures[0]!, scope: hiddenScope, association: hiddenAssociation,
      component: 'resources', phase: 'resource-observation', retryState: 'manual', nextAttemptAt: null,
      worktree: { kind: 'project-relative', path: '.worktrees/daynight/hidden' },
      error: { type: 'operation', code: 'ownership-unconfirmed', cause: 'Retained resource ownership is unconfirmed; automatic cleanup is unsafe.', causeTruncated: false } }],
    lastRecovery: { operationId: id(9), component: 'execution', scope: hiddenScope, association: hiddenAssociation, observedAt: receivedAt, explanation: 'The operation recovered.', explanationTruncated: false },
    delivery: { lastSucceededAt: receivedAt, lastFailure: { observedAt: receivedAt, phase: 'write', error: detail.data.currentFailures[0]!.error, requestId: id(9) } },
  } };
  const view = renderWithLocale(<><WorkerMonitoringTime state={state(snapshot)} /><WorkerMonitoring state={state(snapshot)} readEnabled /></>, { locale });
  const assertAbsent = () => {
    for (const name of ['Current failures', 'Most recent recovery', 'Monitoring delivery', '当前异常', '最近恢复', '监控上报']) expect(screen.queryByRole('heading', { name })).toBeNull();
    for (const value of ['Diagnostic-only task', hiddenScope.claimId, '.worktrees/daynight/hidden', id(9), 'daynight worker resources recover', 'No current failures reported.', 'No recovery reported.', 'No visible failures in this observation.', 'No visible recovery in this observation.', '未报告当前异常。', '未报告恢复。', '本次观测没有可见异常。', '本次观测没有可见恢复摘要。']) expect(screen.queryByText(value, { exact: false })).toBeNull();
    expect(view.container.querySelectorAll('.monitoring-content > section')).toHaveLength(1);
    expect(view.container.querySelector('.monitoring-issue, .monitoring-delivery')).toBeNull();
  };
  assertAbsent();
  expect(screen.getByText('6 / 6')).toBeInTheDocument();
  expect(screen.getByText(locale === 'en' ? 'Active task occupancy' : '活动任务占用').nextElementSibling).toHaveTextContent('1');
  expect(screen.getByText(locale === 'en' ? 'Retained resource occupancy' : '保留资源占用').nextElementSibling).toHaveTextContent('5');
  expect(screen.getByRole('heading', { name: locale === 'en' ? 'Admission reasons' : '准入原因' }).parentElement).toHaveTextContent(locale === 'en' ? 'Cleanup occupies capacity' : '清理占用容量');
  for (const name of ['Private task', 'Admission task']) expect(screen.getByRole('link', { name })).toHaveAttribute('href', taskDetailUrl(id(1), id(2), { tab: 'overview', path: null }));
  expect(view.container.querySelector('.monitoring-time')).toHaveTextContent(locale === 'en' ? 'Captured' : '采集时间');
  const empty = { ...snapshot, data: { ...snapshot.data, currentFailures: [], lastRecovery: null, delivery: { lastSucceededAt: null, lastFailure: null } } };
  view.rerender(<><WorkerMonitoringTime state={state(empty)} /><WorkerMonitoring state={state(empty)} readEnabled /></>); assertAbsent();
  view.rerender(<><WorkerMonitoringTime state={state({ ...empty, permissionProjection: 'restricted', detailCoverage: 'partial' })} /><WorkerMonitoring state={state({ ...empty, permissionProjection: 'restricted', detailCoverage: 'partial' })} readEnabled /></>); assertAbsent();
  expect(screen.getByText(locale === 'en' ? 'Some task details are not visible.' : '部分任务详情不可见。')).toBeInTheDocument();
});

it('retains the last observation on read failure and retries', () => {
  const refresh = vi.fn();
  const failed = { ...state(), status: 'error' as const, error: new ApiError('server', 503, 'unavailable', 'request-123'), refresh };
  renderWithLocale(<><WorkerMonitoringTime state={failed} /><WorkerMonitoring state={failed} readEnabled /></>, { locale: 'en' });
  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('Runtime monitoring could not be updated');
  expect(alert).toHaveTextContent('The last confirmed observation remains visible.');
  expect(alert).toHaveTextContent('request-123');
  expect(screen.getByText('2 / 2')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Private task' })).toBeInTheDocument();
  expect(document.querySelector('.monitoring-time')).toHaveTextContent('Captured');
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' })); expect(refresh).toHaveBeenCalledOnce();
});

it('distinguishes loading, absent, read error, stale and expiry at their boundaries', () => {
  const refresh = vi.fn();
  const failed = { ...state(null, null), status: 'error' as const, error: new ApiError('network'), refresh };
  const content = (observation: Parameters<typeof WorkerMonitoring>[0]['state']) => <><WorkerMonitoringTime state={observation} /><WorkerMonitoring state={observation} readEnabled /></>;
  const view = renderWithLocale(content({ ...state(null, null), status: 'loading' }), { locale: 'en' });
  expect(screen.getByRole('heading', { name: 'Loading runtime monitoring' })).toBeInTheDocument();
  view.rerender(content(failed));
  expect(screen.getByRole('alert')).toHaveTextContent('Runtime monitoring could not be updated'); expect(screen.queryByText('No recent runtime observation')).toBeNull();
  expect(document.querySelector('.monitoring-time')).toBeNull();
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })); expect(refresh).toHaveBeenCalledOnce();
  view.rerender(content(state(detail, time + 89_999))); expect(screen.queryByText(/Runtime observation is stale/)).toBeNull();
  expect(document.querySelector('.monitoring-time')).toHaveTextContent('Received');
  view.rerender(content(state(detail, time + 90_000))); expect(screen.getByText(/Runtime observation is stale/)).toBeInTheDocument();
  view.rerender(content(state(detail, time + 3_599_999))); expect(screen.getByText('2 / 2')).toBeInTheDocument();
  expect(document.querySelector('.monitoring-time')).toHaveTextContent('Captured');
  view.rerender(content(state(detail, time + 3_600_000))); expect(screen.getByText('Runtime observation expired')).toBeInTheDocument(); expect(screen.queryByText('2 / 2')).toBeNull();
  expect(document.querySelector('.monitoring-time')).toBeNull();
  const absent: WorkerMonitoringDetail = { observedAt: receivedAt, state: 'absent', revision: null, runId: null, sequence: null, receivedAt: null, expiresAt: null, data: null, detailCoverage: 'complete', permissionProjection: 'current' };
  view.rerender(content(state(absent))); expect(screen.getByText('No recent runtime observation')).toBeInTheDocument();
  view.rerender(content({ ...state(absent), expired: true })); expect(screen.getByText('Runtime observation expired')).toBeInTheDocument();
});

const summary: Extract<WorkerMonitoringItem, { state: 'available' }> = { workerId: id(1), state: 'available', revision: id(4), receivedAt, expiresAt: '2026-11-09T13:00:00Z', summary: {
  capturedAt: receivedAt, lifecycle: 'running', scheduler: { phase: 'waiting-poll', coverage: 'complete', lastSuccessfulAt: receivedAt, nextPollAt: null },
  capacity: { observedAt: receivedAt, quality: 'current', limit: 2, occupied: 2, available: 0 }, detailCoverage: 'complete', admission: { observedAt: receivedAt, coverage: 'complete', reasonCodes: ['cleanup-capacity-blocked'], permissionProjection: 'current' },
} };

it('keeps phase and capacity while omitting diagnostics at the age and expiry boundaries', () => {
  const view = renderWithLocale(<MonitoringCard item={summary} now={time} />, { locale: 'zh-CN' });
  const card = view.container.querySelector('.monitoring-card-state')!;
  expect(card).toHaveTextContent('等待下次检查执行名额: 2 / 2 已占用');
  expect(card.children).toHaveLength(2); expect(card.querySelector('time')).toBeNull();
  expect(card).not.toHaveTextContent('清理占用容量'); expect(card).not.toHaveTextContent('收到时间');
  view.rerender(<MonitoringCard item={summary} now={time + 90_000} />);
  expect(card).not.toHaveTextContent('运行观测已陈旧'); expect(card.children).toHaveLength(2);
  view.rerender(<MonitoringCard item={{ ...summary, summary: { ...summary.summary, capacity: { ...summary.summary.capacity!, quality: 'stale' } } }} now={time + 90_000} />);
  expect(card).toHaveTextContent('运行观测已陈旧'); expect(card.children).toHaveLength(2);
  view.rerender(<MonitoringCard item={{ ...summary, summary: { ...summary.summary, capacity: null } }} now={time + 3_599_999} />);
  expect(card).toHaveTextContent('尚未观测到容量。'); expect(card.children).toHaveLength(2);
  view.rerender(<MonitoringCard item={summary} now={time + 3_600_000} />); expect(screen.getByText('运行观测已过期')).toBeInTheDocument();
  view.rerender(<MonitoringCard item={summary} now={null} />); expect(screen.getByText('未知')).toBeInTheDocument();
  view.rerender(<MonitoringCard item={null} now={time} />); expect(screen.getByText('运行监控: 未知')).toBeInTheDocument();
  const absent: WorkerMonitoringItem = { workerId: id(1), state: 'absent', revision: null, receivedAt: null, expiresAt: null, summary: null };
  view.rerender(<MonitoringCard item={absent} now={time} />); expect(screen.getByText('没有近期运行观测')).toBeInTheDocument();
  view.rerender(<MonitoringCard item={absent} now={time} expired />); expect(screen.getByText('运行观测已过期')).toBeInTheDocument();
});

it.each([
  ['configuration-unavailable', 'Configuration unavailable', '配置不可用'], ['configuration-incomplete', 'Configuration incomplete', '配置不完整'],
  ['inventory-unavailable', 'Inventory unavailable', '资源清单不可用'], ['project-unavailable', 'Project unavailable', '项目不可用'],
  ['project-preparation-failed', 'Project preparation failed', '项目准备失败'], ['resource-observation-unavailable', 'Resource observation unavailable', '资源观测不可用'],
  ['capacity-full', 'Capacity full', '容量已满'], ['cleanup-capacity-blocked', 'Cleanup occupies capacity', '清理占用容量'],
  ['no-projects-selected', 'No projects selected', '未选择项目'], ['no-ready-tasks', 'No ready tasks', '没有就绪任务'],
  ['claim-unconfirmed', 'Claim unconfirmed', '领取结果未确认'], ['retained-resource-conflict', 'Retained resource conflict', '保留资源冲突'],
  ['stopping', 'Stopping', '正在停止'],
] as const)('omits reason %s from the summary but localizes it in detail', (code, english, chinese) => {
  const item: WorkerMonitoringItem = { ...summary, summary: { ...summary.summary, admission: { ...summary.summary.admission, reasonCodes: [code] } } };
  const snapshot: WorkerMonitoringDetail = { ...detail, data: { ...detail.data, admission: { ...detail.data.admission, reasons: [{ ...detail.data.admission.reasons[0]!, code }] } } };
  const view = renderWithLocale(<MonitoringCard item={item} now={time} />, { locale: 'en' });
  expect(screen.queryByText(english)).toBeNull(); expect(view.container.querySelector('time')).toBeNull();
  view.setLocale('zh-CN'); expect(screen.queryByText(chinese)).toBeNull();
  view.rerender(<WorkerMonitoring state={state(snapshot)} readEnabled />);
  expect(screen.getByRole('heading', { name: '准入原因' }).parentElement).toHaveTextContent(chinese);
  view.setLocale('en'); expect(screen.getByRole('heading', { name: 'Admission reasons' }).parentElement).toHaveTextContent(english);
});

it('omits reason and timestamps for empty, partial, restricted and withdrawn admission', () => {
  const view = renderWithLocale(<MonitoringCard item={{ ...summary, summary: { ...summary.summary, admission: { ...summary.summary.admission, reasonCodes: [] } } }} now={time} />, { locale: 'en' });
  const card = view.container.querySelector('.monitoring-card-state')!;
  const assertSummary = () => {
    expect(card).toHaveTextContent('Waiting for next check'); expect(card).toHaveTextContent('2 / 2 occupied');
    expect(card.children).toHaveLength(2); expect(card.querySelector('time')).toBeNull();
    expect(card).not.toHaveTextContent(/Admission|Received|No ready tasks|Some reasons/);
  };
  assertSummary();
  view.rerender(<MonitoringCard item={{ ...summary, summary: { ...summary.summary, admission: { ...summary.summary.admission, coverage: 'partial', reasonCodes: ['no-ready-tasks'] } } }} now={time} />); assertSummary();
  view.rerender(<MonitoringCard item={{ ...summary, summary: { ...summary.summary, admission: { ...summary.summary.admission, permissionProjection: 'restricted' } } }} now={time} />); assertSummary();
  view.rerender(<MonitoringCard item={{ ...summary, summary: { ...summary.summary, admission: null } }} now={time} />); assertSummary();
});

it('retains the general truncation notice when reservations are nonempty', () => {
  const partial: WorkerMonitoringDetail = { ...detail, data: { ...detail.data, capacity: { ...detail.data.capacity!, detailCoverage: 'partial' } } };
  renderWithLocale(<WorkerMonitoring state={state(partial)} readEnabled />, { locale: 'en' });
  expect(screen.getByText('Some details were omitted.')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Private task' }).length).toBeGreaterThan(0);
  expect(screen.queryByRole('heading', { name: 'Capacity responsibilities' })).toBeNull();
});

it.each(['en', 'zh-CN'] as const)('omits reservation sections for empty, populated and restricted partial observations in %s', locale => {
  const name = locale === 'en' ? 'Capacity responsibilities' : '容量责任';
  const reservationOnly = { ...detail.data.reservations[0]!, association: { ...association, title: 'Reservation-only task' } };
  const view = renderWithLocale(<WorkerMonitoring state={state({ ...detail, data: { ...detail.data, reservations: [reservationOnly] } })} readEnabled />, { locale });
  const assertAbsent = () => {
    expect(screen.queryByRole('heading', { name })).toBeNull();
    expect(screen.queryByText('Reservation-only task')).toBeNull();
    expect(view.container.querySelector('.monitoring-reservations')).toBeNull();
  };
  assertAbsent();
  view.rerender(<WorkerMonitoring state={state({ ...detail, data: { ...detail.data, reservations: [] } })} readEnabled />);
  assertAbsent();
  view.rerender(<WorkerMonitoring state={state({ ...detail, permissionProjection: 'restricted', detailCoverage: 'partial', data: { ...detail.data, reservations: [reservationOnly] } })} readEnabled />);
  assertAbsent();
  expect(screen.getByText(locale === 'en' ? 'Some task details are not visible.' : '部分任务详情不可见。')).toBeInTheDocument();
  expect(screen.getByText(locale === 'en' ? 'Some details were omitted.' : '部分详情已省略。')).toBeInTheDocument();
});

it.each([['completed', 'Completed', '已完成'], ['failed', 'Failed', '失败'], ['cancelled', 'Cancelled', '已取消'], [null, 'Not observed', '尚未观测']] as const)('shows the actual scheduler result %s in both languages', (outcome, english, chinese) => {
  const snapshot: WorkerMonitoringDetail = { ...detail, data: { ...detail.data, scheduler: { ...detail.data.scheduler, lastOutcome: outcome } } };
  const view = renderWithLocale(<WorkerMonitoring state={state(snapshot)} readEnabled />, { locale: 'en' });
  const result = screen.getByText('Last check result').nextElementSibling; expect(result).toHaveTextContent(english);
  view.setLocale('zh-CN'); expect(screen.getByText('最近检查结果').nextElementSibling).toHaveTextContent(chinese);
});
