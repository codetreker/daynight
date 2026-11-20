import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { getTaskUsageRecords, getTaskUsageSummaries, getUsageCapabilities, parseUsageSummary, usageMetricKeys } from '../src/api/usage';
import { formatGraphTokens, TaskNodeUsageSummary, TaskUsageSummary, UsageProjectProvider, UsageSummaryView } from '../src/features/usage/UsageSummaryView';
import { TaskUsagePanel } from '../src/features/usage/TaskUsagePanel';
import { TaskDetailPanels } from '../src/features/task-detail/TaskDetailPanels';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const now = '2026-11-18T00:00:00Z';
const admission = { userId: TEST_VIEWER_ID, onPrincipalMismatch: vi.fn() };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
const summary = (completeness = 'partial') => ({ metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: key === 'outputTokens' ? '9007199254740993' : null, contributingRecords: key === 'outputTokens' ? '1' : '0', unknownRecords: key === 'outputTokens' ? '0' : '1' }])), scope: 'registered_web_executions', completeness, reasonCodes: ['native_recovery_gap'], coverage: { executions: '2', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '1', unsupportedExecutions: '1', unavailableExecutions: '0', unregisteredExecutions: '0' }, measurementRecords: '1', lastMeasuredAt: now, observedAt: now, etag: 'etag' });
const signal = () => new AbortController().signal;

it('omits graph usage without a project context', () => {
  const view = renderWithLocale(<TaskNodeUsageSummary taskId={task} />, { locale: 'en' });
  expect(view.container).toBeEmptyDOMElement();
});

it.each(['failure', 'unsupported', 'no_data', 'unknown'] as const)('omits graph usage during loading and for %s without a reading', async mode => {
  let release!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { release = resolve; });
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? (mode === 'unsupported' ? response : reply({ protocol: 'daynight.usage.v1' })) : response);
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(<UsageProjectProvider projectId={project}><TaskNodeUsageSummary taskId={task} /><TaskUsageSummary projectId={project} taskId={task} compact /></UsageProjectProvider>, { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(view.container.querySelector('.task-node-usage')).toBeNull();
  const data = summary(mode === 'no_data' ? 'no_data' : 'partial');
  data.metrics.outputTokens!.known = null;
  if (mode === 'no_data') data.measurementRecords = '0';
  release(mode === 'unsupported' ? new Response('Not found', { status: 404 }) : mode === 'failure' ? reply({ error: { code: 'unavailable', requestId: 'usage.1' } }, 503) : reply({ items: [{ taskId: task, summary: data }] }));
  if (mode === 'unsupported') await screen.findByText('This service does not support usage');
  else if (mode === 'failure') await screen.findByRole('button', { name: 'Retry' });
  else await waitFor(() => expect(view.container.querySelector('.usage-summary-compact')).toHaveTextContent('Token usage: Unknown'));
  expect(view.container.querySelector('.task-node-usage')).toBeNull();
});

it('renders graph readings in priority order, retains them on transient failure and recovers after access loss', async () => {
  let state: 'known' | 'failure' | 'revoked' | 'output' | 'zero' = 'known';
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('capabilities')) return reply({ protocol: 'daynight.usage.v1' });
    if (state === 'failure' || state === 'revoked') return reply({ error: { code: 'unavailable', requestId: 'usage.1' } }, state === 'failure' ? 503 : 403);
    const data = summary();
    if (state === 'zero') { data.metrics.outputTokens!.known = null; data.metrics.inputTokens!.known = '0'; }
    else if (state === 'known') { data.metrics.totalTokens!.known = '12345'; }
    return reply({ items: [{ taskId: task, summary: data }] });
  });
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(<UsageProjectProvider projectId={project}><TaskNodeUsageSummary taskId={task} /></UsageProjectProvider>, { locale: 'en', taskCache: true });
  await waitFor(() => expect(view.container.querySelector('.task-node-usage')).toHaveTextContent('Token 12.3K'));
  const refresh = async (next: typeof state) => {
    state = next;
    const calls = fetch.mock.calls.length;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(calls + 2));
  };
  expect(view.container.querySelector('.task-node-usage')).toHaveAttribute('title', 'Known Total: 12,345 · Partial');
  await refresh('failure');
  expect(view.container.querySelector('.task-node-usage')).toHaveTextContent('Token 12.3K');
  await refresh('revoked');
  await waitFor(() => expect(view.container.querySelector('.task-node-usage')).toBeNull());
  await refresh('output');
  await waitFor(() => expect(view.container.querySelector('.task-node-usage')).toHaveTextContent('Token ≥1,000T'));
  expect(view.container.querySelector('.task-node-usage')).toHaveAttribute('title', 'Known Output: 9,007,199,254,740,993 · Partial');
  await refresh('zero');
  await waitFor(() => expect(view.container.querySelector('.task-node-usage')).toHaveTextContent('Token 0'));
  view.setLocale('zh-CN');
  expect(view.container.querySelector('.task-node-usage')).toHaveAttribute('title', '已知输入: 0 · 部分');
});

it.each([
  ['0', '0'], ['999', '999'], ['1000', '1K'], ['56780', '56.8K'],
  ['999949', '999.9K'], ['999950', '1M'], ['1000000000', '1B'],
  ['1000000000000', '1T'], ['999999999999999', '1,000T'],
  ['1000000000000000', '≥1,000T'], ['999999999999999999999999999999', '≥1,000T'],
])('abbreviates graph token integer %s as %s', (value, expected) => {
  expect(formatGraphTokens(value)).toBe(expected);
});

it('preserves exact decimal strings and rejects unsafe number and leading-zero metrics', () => {
  expect(parseUsageSummary(summary()).metrics.outputTokens.known).toBe('9007199254740993');
  const numeric = summary(); numeric.metrics.outputTokens!.known = 9007199254740992 as unknown as string;
  expect(() => parseUsageSummary(numeric)).toThrow();
  const leading = summary(); leading.metrics.outputTokens!.known = '01';
  expect(() => parseUsageSummary(leading)).toThrow();
});

it('keeps null distinct from known zero and displays exact values in both languages', () => {
  const data = summary(); data.metrics.inputTokens!.known = '0';
  const view = renderWithLocale(<UsageSummaryView summary={parseUsageSummary(data)} />, { locale: 'en' });
  expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
  expect(screen.getByText('0')).toBeVisible();
  expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  expect(screen.getByText('Native recovery records are incomplete')).toBeVisible();
  view.setLocale('zh-CN');
  expect(screen.getByText('原生恢复记录存在缺口')).toBeVisible();
  expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
});

it.each([['unsupported', 'Unsupported'], ['unavailable', 'Unavailable'], ['no_data', 'No data'], ['collecting', 'Collecting'], ['complete', 'Complete']])('labels %s explicitly', (state, label) => {
  renderWithLocale(<UsageSummaryView summary={parseUsageSummary(summary(state))} compact />, { locale: 'en' });
  expect(screen.getByText(new RegExp(` · ${label}$`))).toBeVisible();
});

it('batches cards in request order and shares a single summary request', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('capabilities')) return reply({ protocol: 'daynight.usage.v1' });
    const body = JSON.parse(String(init?.body)) as { taskIds: string[] };
    return reply({ items: body.taskIds.map(taskId => ({ taskId, summary: summary() })), observedAt: now, etag: 'batch' });
  });
  vi.stubGlobal('fetch', fetch);
  renderWithLocale(<><TaskUsageSummary projectId={project} taskId={task} compact /><TaskUsageSummary projectId={project} taskId={other} compact /></>, { locale: 'en', taskCache: true });
  await waitFor(() => expect(screen.getAllByText('9,007,199,254,740,993')).toHaveLength(2));
  const batch = fetch.mock.calls.filter(([url]) => url.endsWith('task-summaries'));
  expect(batch).toHaveLength(1);
  expect(JSON.parse(String(batch[0]![1]?.body))).toEqual({ taskIds: [task, other] });
});

it('does not subscribe a retained inactive card until it becomes active', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : reply({ items: [{ taskId: task, summary: summary() }] }));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(<TaskUsageSummary projectId={project} taskId={task} active={false} />, { locale: 'en', taskCache: true });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(<TaskUsageSummary projectId={project} taskId={task} active />);
  await screen.findByText('9,007,199,254,740,993');
});

it('clears scheduled work and polling while hidden, then refreshes once on visibility recovery', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : reply({ items: [{ taskId: task, summary: summary() }] }));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(<TaskUsageSummary projectId={project} taskId={task} compact />, { locale: 'en', taskCache: true });
  try {
    expect(vi.getTimerCount()).toBe(2);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('task-summaries'))).toHaveLength(1);
    expect(screen.getByText('9,007,199,254,740,993')).toBeVisible();
    expect(vi.getTimerCount()).toBe(1);
    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('task-summaries'))).toHaveLength(2);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally { view.unmount(); visibility.mockRestore(); vi.useRealTimers(); }
});

it('rejects a batch with a different task selection', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ items: [{ taskId: other, summary: summary() }] })));
  await expect(getTaskUsageSummaries(project, [task], signal(), admission)).rejects.toMatchObject({ kind: 'protocol' });
});

it('treats capabilities 404 as unsupported and 503 as recoverable server failure', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response('404 page not found', { status: 404 })).mockResolvedValueOnce(reply({ error: { code: 'unavailable', requestId: 'usage.2' } }, 503));
  vi.stubGlobal('fetch', fetch);
  await expect(getUsageCapabilities(signal(), admission)).rejects.toMatchObject({ code: 'usage_unsupported' });
  await expect(getUsageCapabilities(signal(), admission)).rejects.toMatchObject({ code: 'unavailable', status: 503 });
});

it('bounds a hanging capabilities read and exposes a retry', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })));
  vi.stubGlobal('fetch', fetch);
  renderWithLocale(<TaskUsageSummary projectId={project} taskId={task} compact />, { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  deadline.abort(new DOMException('Deadline exceeded', 'TimeoutError'));
  await screen.findByRole('button', { name: 'Retry' });
  expect(timeout).toHaveBeenCalledWith(15_000);
  timeout.mockRestore();
});

it('preserves displayed records after a later page fails', async () => {
  const metrics = Object.fromEntries([...usageMetricKeys, 'providerTotalTokens'].map(key => [key, key === 'outputTokens' ? '9007199254740993' : null]));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('capabilities')) return reply({ protocol: 'daynight.usage.v1' });
    if (url.endsWith('task-summaries')) return reply({ items: [{ taskId: task, summary: summary() }] });
    if (url.includes('cursor=')) return reply({ error: { code: 'reset_required', requestId: 'usage.5' } }, 409);
    return reply({ items: [{ id: other, recordKind: 'measurement', sessionId: task, stateId: null, executionGeneration: '1', provider: 'copilot', model: 'exact-model', sourceKey: 'event-1', profileId: 'test-profile', providerVersion: '1', aggregationRole: 'counted', finality: 'final', disposition: 'active', metrics, reasonCodes: [], observedAt: now, updatedAt: now }], nextCursor: 'next', snapshotToken: 'snapshot', observedAt: now });
  }));
  renderWithLocale(<TaskUsagePanel projectId={project} taskId={task} active />, { locale: 'en', taskCache: true });
  await screen.findByRole('heading', { name: 'copilot · exact-model' });
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText('Usage records changed. Read again from the first page.');
  expect(screen.getByRole('heading', { name: 'copilot · exact-model' })).toBeVisible();
});

it.each(['filters', 'execution sources'] as const)('preserves %s when refreshing a later records page', async mode => {
  const queries: URLSearchParams[] = [];
  const metrics = Object.fromEntries([...usageMetricKeys, 'providerTotalTokens'].map(key => [key, null]));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('capabilities')) return reply({ protocol: 'daynight.usage.v1' });
    if (url.endsWith('task-summaries')) return reply({ items: [{ taskId: task, summary: summary() }] });
    queries.push(new URL(url, 'https://daynight.test').searchParams);
    return reply({ items: [{ id: other, recordKind: 'execution_state', sessionId: task, stateId: null, executionGeneration: '1', provider: 'copilot', model: 'exact-model', sourceKey: null, profileId: 'test-profile', providerVersion: '1', collectionState: 'complete', metrics, reasonCodes: [], observedAt: now, updatedAt: now }], nextCursor: 'next', snapshotToken: 'snapshot', observedAt: now });
  }));
  renderWithLocale(<TaskUsagePanel projectId={project} taskId={task} active />, { locale: 'en', taskCache: true });
  await screen.findByRole('heading', { name: 'copilot · exact-model' });
  if (mode === 'execution sources') {
    fireEvent.click(screen.getByRole('button', { name: 'View execution sources' }));
  } else {
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'copilot' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'exact-model' } });
    fireEvent.change(screen.getByLabelText('Execution State ID'), { target: { value: other } });
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
  }
  await waitFor(() => expect(queries).toHaveLength(2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next page' })).toBeEnabled());
  const expected = mode === 'execution sources'
    ? { limit: '50', kind: 'measurement', stateId: other }
    : { limit: '50', kind: 'execution_state', provider: 'copilot', model: 'exact-model', stateId: other };
  expect(Object.fromEntries(queries[1]!)).toEqual(expected);
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  await waitFor(() => expect(queries).toHaveLength(3));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  expect(Object.fromEntries(queries[2]!)).toEqual({ ...expected, cursor: 'next' });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(queries).toHaveLength(4));
  expect(Object.fromEntries(queries[3]!)).toEqual(expected);
  await waitFor(() => expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled());
});

it('retains the native reset fault and sends a bounded records query', async () => {
  const fetch = vi.fn(async (_url: string) => reply({ error: { code: 'reset_required', requestId: 'usage.3' } }, 409));
  vi.stubGlobal('fetch', fetch);
  await expect(getTaskUsageRecords(project, task, { kind: 'measurement', model: 'gpt a', cursor: 'old' }, signal(), admission)).rejects.toMatchObject({ code: 'reset_required' });
  expect(fetch.mock.calls[0]![0]).toContain('limit=50&kind=measurement&model=gpt+a&cursor=old');
});

it('keeps usage on a keyboard navigable tab', () => {
  renderWithLocale(<TaskDetailPanels overview={<p>Overview body</p>} attachments={null} usage={<p>Usage body</p>} />, { locale: 'en' });
  const overview = screen.getByRole('tab', { name: 'Overview' });
  fireEvent.keyDown(overview, { key: 'End' });
  expect(screen.getByRole('tab', { name: 'Usage' })).toHaveFocus();
  expect(screen.getByText('Usage body')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Usage' }), { key: 'Home' });
  expect(overview).toHaveFocus();
});

it('recovers a changed records collection from its first page', async () => {
  let records = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('capabilities')) return reply({ protocol: 'daynight.usage.v1' });
    if (url.endsWith('task-summaries')) return reply({ items: [{ taskId: task, summary: summary() }] });
    if (url.includes('/records?')) {
      records++;
      if (records === 1) return reply({ error: { code: 'reset_required', requestId: 'usage.4' } }, 409);
      return reply({ items: [], nextCursor: null, snapshotToken: 'snap', observedAt: now });
    }
    throw new Error(String(init));
  }));
  renderWithLocale(<TaskUsagePanel projectId={project} taskId={task} active />, { locale: 'en', taskCache: true });
  await screen.findByText('Usage records changed. Read again from the first page.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(records).toBe(2));
  expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
});
