import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usageMetricKeys, type UsageMetricKey } from '../src/api/usage';
import { ClockInputProvider } from '../src/features/task-execution/TaskExecutionClock';
import { TaskRow, type TaskRowModel } from '../src/features/task-row/TaskRow';
import { TaskUsageSummary } from '../src/features/usage/UsageSummaryView';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const now = '2026-11-18T00:00:00Z';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
const summary = (completeness: string, known: Partial<Record<UsageMetricKey, string>> = {}) => ({
  metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: known[key] ?? null, contributingRecords: known[key] === undefined ? '0' : '1', unknownRecords: '0' }])),
  scope: 'registered_web_executions', completeness, reasonCodes: [], coverage: { executions: '1', supportedExecutions: '0', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '0', unsupportedExecutions: '1', unavailableExecutions: '0', unregisteredExecutions: '0' }, measurementRecords: Object.keys(known).length === 0 ? '0' : '1', lastMeasuredAt: null, observedAt: now, etag: 'etag',
});
const batch = (value: ReturnType<typeof summary>) => reply({ items: [{ taskId: task, summary: value }] });
const base: TaskRowModel = { id: task, title: 'A task', createdAt: now, status: 'todo', assignedTo: null, tags: [], allowAgents: false, requiredPlatform: null, ready: true, blocked: false, startedAt: null, completedAt: null, cancelledAt: null, paused: false, worker: { kind: 'none' }, session: null };
const row = (model: TaskRowModel, active = true) => <ClockInputProvider input={{ observedAt: now, receivedMonotonic: 0, warningMinutes: 1 }}><ul><TaskRow projectId={project} model={model} tagsActive={active} href={`/projects/${project}/tasks/${task}`} instanceId="row" assignee={null} onOpenTask={() => {}} /></ul></ClockInputProvider>;
const expectNoUsage = (container: HTMLElement) => {
  expect(container.querySelector('.task-usage-summary')).toBeNull();
  expect(container.querySelector('.task-row-usage-unsupported')).toBeNull();
  expect(screen.queryByText(/No LLM usage|无LLM用量|Loading usage|读取用量|Usage unavailable|用量暂不可用/)).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: /Retry|重试/ })).toBeNull();
};

it.each(['todo', 'in_progress', 'done'] as const)('omits unsupported usage beside the %s status in both languages', async status => {
  const fetch = vi.fn(async () => new Response('not found', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row({ ...base, status, ready: status === 'todo' }), { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expectNoUsage(view.container);
  expect(view.container.querySelector('.root-status')).toHaveTextContent({ todo: 'To do', in_progress: 'In progress', done: 'Done' }[status]);
  view.setLocale('zh-CN');
  expectNoUsage(view.container);
});

it.each(['no_data', 'unsupported', 'unavailable', 'unregistered', 'collecting', 'partial', 'complete'])('omits a %s summary with no known metrics', async state => {
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : batch(summary(state)));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base), { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expectNoUsage(view.container);
  view.setLocale('zh-CN');
  expectNoUsage(view.container);
});

it('omits a partial summary with only known cache and reasoning metrics', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : batch(summary('partial', { cacheReadTokens: '2', reasoningTokens: '3' })));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base), { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expectNoUsage(view.container);
});

it('has no loading placeholder and displays an exact partial summary when it arrives', async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : pending.promise);
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base), { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expectNoUsage(view.container);
  await act(async () => pending.resolve(batch(summary('partial', { outputTokens: '9007199254740993' }))));
  const link = screen.getByRole('link', { name: 'Known Output: 9,007,199,254,740,993 · Partial' });
  expect(link).toHaveAttribute('href', expect.stringContaining('tab=usage'));
  view.setLocale('zh-CN');
  expect(screen.getByRole('link', { name: '已知输出: 9,007,199,254,740,993 · 部分' })).toBeVisible();
});

it.each([
  [{ totalTokens: '0', outputTokens: '7', inputTokens: '8' }, 'Total: 0 · Complete'],
  [{ outputTokens: '0', inputTokens: '8' }, 'Output: 0 · Complete'],
  [{ inputTokens: '0' }, 'Input: 0 · Complete'],
] as const)('keeps known zero and metric priority for %j', async (known, label) => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : batch(summary('complete', known))));
  renderWithLocale(row(base), { locale: 'en', taskCache: true });
  expect(await screen.findByRole('link', { name: label })).toHaveAttribute('href', `/projects/${project}/tasks/${task}?tab=usage`);
});

it.each(['capabilities', 'task-summaries'])('omits an uncached %s failure and its retry control', async failure => {
  const fetch = vi.fn(async (url: string) => failure === 'capabilities' || url.endsWith('task-summaries') ? reply({ error: { code: 'unavailable', requestId: 'usage.1' } }, 503) : reply({ protocol: 'daynight.usage.v1' }));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base), { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(failure === 'capabilities' ? 1 : 2));
  expectNoUsage(view.container);
});

it('retains the numeric summary on refresh failure while Detail exposes diagnostics and retry', async () => {
  let failed = false;
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : failed ? reply({ error: { code: 'unavailable', requestId: 'usage.2' } }, 503) : batch(summary('partial', { outputTokens: '42' })));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(<>{row(base)}<div data-testid="detail"><TaskUsageSummary projectId={project} taskId={task} compact /></div></>, { locale: 'en', taskCache: true });
  await waitFor(() => expect(screen.getAllByText('42')).toHaveLength(2));
  failed = true;
  fireEvent(document, new Event('visibilitychange'));
  const detail = within(screen.getByTestId('detail'));
  expect(await detail.findByRole('alert')).toHaveTextContent('Usage unavailable');
  const taskRow = view.container.querySelector('.task-row')!;
  expect(taskRow.querySelector('.usage-summary-link')).toHaveTextContent('Known Output: 42 · Partial');
  expect(within(taskRow as HTMLElement).queryByRole('alert')).toBeNull();
  expect(within(taskRow as HTMLElement).queryByRole('button', { name: 'Retry' })).toBeNull();
  failed = false;
  fireEvent.click(detail.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(detail.queryByRole('alert')).toBeNull());
});

it('preserves the service-unsupported explanation in Detail', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  renderWithLocale(<TaskUsageSummary projectId={project} taskId={task} />, { locale: 'en', taskCache: true });
  expect(await screen.findByText('This service does not support usage')).toBeVisible();
});

it('does not request usage for an inactive row until activated', async () => {
  const fetch = vi.fn(async () => new Response('not found', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base, false), { locale: 'en', taskCache: true });
  await act(async () => {});
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(row(base));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expectNoUsage(view.container);
});
