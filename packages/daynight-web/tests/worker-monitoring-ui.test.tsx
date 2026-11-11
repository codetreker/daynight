import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import type { WorkerMonitoringDetail, WorkerMonitoringItem } from '../src/api/worker-monitoring';
import { taskDetailUrl } from '../src/app/router';
import { MonitoringCard, WorkerMonitoring } from '../src/features/workers/WorkerMonitoring';
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

it('renders real capacity and cleanup details and preserves an expanded failure during background reads', () => {
  const view = renderWithLocale(<WorkerMonitoring state={state()} readEnabled />, { locale: 'en' });
  expect(screen.getByText('2 / 2')).toBeInTheDocument(); expect(screen.getByText(/Cleanup occupies capacity/)).toBeInTheDocument();
  const issue = screen.getByText('Cleanup · Worktree removal', { selector: 'summary strong' }).closest('details')!;
  fireEvent.click(issue.querySelector('summary')!); expect(issue).toHaveAttribute('open');
  expect(within(issue).getAllByText('A required command failed.')).toHaveLength(2);
  expect(within(issue).getByRole('link', { name: 'Private task' })).toHaveAttribute('href', taskDetailUrl(id(1), id(2), { tab: 'overview', path: null }));
  view.rerender(<WorkerMonitoring state={{ ...state(), refreshing: true }} readEnabled />);
  expect(issue).toHaveAttribute('open'); expect(screen.getByText('Cleanup · Worktree removal', { selector: 'summary strong' }).closest('details')).toBe(issue);
  const restricted: WorkerMonitoringDetail = { ...detail, permissionProjection: 'restricted', data: { ...detail.data, admission: { ...detail.data.admission, coverage: 'partial', reasons: [] }, reservations: [], activities: [], currentFailures: [], lastRecovery: null } };
  view.rerender(<WorkerMonitoring state={state(restricted)} readEnabled />);
  expect(screen.getByText('Some task details are not visible.')).toBeInTheDocument(); expect(screen.queryByText('Private task')).toBeNull();
  expect(screen.queryByText('A required command failed.')).toBeNull(); expect(screen.getByText('No visible activities in this observation.')).toBeInTheDocument();
  expect(screen.getByText('No visible failures in this observation.')).toBeInTheDocument(); expect(screen.getByText('No visible recovery in this observation.')).toBeInTheDocument(); expect(screen.getByText('2 / 2')).toBeInTheDocument();
});

it('shows worktree locations only on their failure and withdraws them with restricted details', () => {
  const withPath: WorkerMonitoringDetail = { ...detail, data: { ...detail.data, currentFailures: [{ ...detail.data.currentFailures[0]!, worktree: { kind: 'project-relative', path: '../retained/工作 区' } }] } };
  const view = renderWithLocale(<WorkerMonitoring state={state(withPath)} readEnabled />, { locale: 'en' });
  const issue = screen.getByText('Cleanup · Worktree removal', { selector: 'summary strong' }).closest('details')!;
  fireEvent.click(issue.querySelector('summary')!);
  expect(within(issue).getByText('Worktree path').nextElementSibling?.querySelector('code')).toHaveTextContent('../retained/工作 区');
  expect(screen.queryAllByText('../retained/工作 区')).toHaveLength(1);
  view.setLocale('zh-CN'); expect(within(issue).getByText('工作区路径')).toBeInTheDocument();
  view.rerender(<WorkerMonitoring state={state({ ...withPath, permissionProjection: 'restricted', data: { ...withPath.data, currentFailures: [] } })} readEnabled />);
  expect(screen.queryByText('../retained/工作 区')).toBeNull();
  view.rerender(<WorkerMonitoring state={state()} readEnabled />);
  expect(screen.queryByText('工作区路径')).toBeNull();
});

it.each([
  ['different-volume', 'On a different drive or share.', '位于不同磁盘或共享位置。'],
  ['invalid-path', 'The path is invalid.', '路径无效。'],
  ['limit-exceeded', 'The path exceeds the reporting limit.', '路径超出上报限额。'],
] as const)('localizes unavailable worktree reason %s', (reason, english, chinese) => {
  const snapshot: WorkerMonitoringDetail = { ...detail, data: { ...detail.data, currentFailures: [{ ...detail.data.currentFailures[0]!, worktree: { kind: 'unavailable', reason } }] } };
  const view = renderWithLocale(<WorkerMonitoring state={state(snapshot)} readEnabled />, { locale: 'en' });
  expect(screen.getByText('Worktree path').nextElementSibling).toHaveTextContent(english);
  view.setLocale('zh-CN'); expect(screen.getByText('工作区路径').nextElementSibling).toHaveTextContent(chinese);
});

it('distinguishes loading, absent, read error, stale and expiry at their boundaries', () => {
  const refresh = vi.fn();
  const failed = { ...state(null, null), status: 'error' as const, error: new ApiError('network'), refresh };
  const view = renderWithLocale(<WorkerMonitoring state={failed} readEnabled />, { locale: 'en' });
  expect(screen.getByRole('alert')).toHaveTextContent('Runtime monitoring could not be updated'); expect(screen.queryByText('No recent runtime observation')).toBeNull();
  fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' })); expect(refresh).toHaveBeenCalledOnce();
  view.rerender(<WorkerMonitoring state={state(detail, time + 89_999)} readEnabled />); expect(screen.queryByText(/Runtime observation is stale/)).toBeNull();
  view.rerender(<WorkerMonitoring state={state(detail, time + 90_000)} readEnabled />); expect(screen.getByText(/Runtime observation is stale/)).toBeInTheDocument();
  view.rerender(<WorkerMonitoring state={state(detail, time + 3_599_999)} readEnabled />); expect(screen.getByText('2 / 2')).toBeInTheDocument();
  view.rerender(<WorkerMonitoring state={state(detail, time + 3_600_000)} readEnabled />); expect(screen.getByText('Runtime observation expired')).toBeInTheDocument(); expect(screen.queryByText('2 / 2')).toBeNull();
  const absent: WorkerMonitoringDetail = { observedAt: receivedAt, state: 'absent', revision: null, runId: null, sequence: null, receivedAt: null, expiresAt: null, data: null, detailCoverage: 'complete', permissionProjection: 'current' };
  view.rerender(<WorkerMonitoring state={state(absent)} readEnabled />); expect(screen.getByText('No recent runtime observation')).toBeInTheDocument();
  view.rerender(<WorkerMonitoring state={{ ...state(absent), expired: true }} readEnabled />); expect(screen.getByText('Runtime observation expired')).toBeInTheDocument();
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

it('marks capacity responsibility truncation even with a nonempty list', () => {
  const partial: WorkerMonitoringDetail = { ...detail, data: { ...detail.data, capacity: { ...detail.data.capacity!, detailCoverage: 'partial' } } };
  renderWithLocale(<WorkerMonitoring state={state(partial)} readEnabled />, { locale: 'en' });
  expect(screen.getByText('Some details were omitted.')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Private task' }).length).toBeGreaterThan(0);
});

it.each([['completed', 'Completed', '已完成'], ['failed', 'Failed', '失败'], ['cancelled', 'Cancelled', '已取消'], [null, 'Not observed', '尚未观测']] as const)('shows the actual scheduler result %s in both languages', (outcome, english, chinese) => {
  const snapshot: WorkerMonitoringDetail = { ...detail, data: { ...detail.data, scheduler: { ...detail.data.scheduler, lastOutcome: outcome } } };
  const view = renderWithLocale(<WorkerMonitoring state={state(snapshot)} readEnabled />, { locale: 'en' });
  const result = screen.getByText('Last check result').nextElementSibling; expect(result).toHaveTextContent(english);
  view.setLocale('zh-CN'); expect(screen.getByText('最近检查结果').nextElementSibling).toHaveTextContent(chinese);
});
