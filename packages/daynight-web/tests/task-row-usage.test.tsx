import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usageMetricKeys } from '../src/api/usage';
import { ClockInputProvider } from '../src/features/task-execution/TaskExecutionClock';
import { TaskRow, type TaskRowModel } from '../src/features/task-row/TaskRow';
import { TaskUsageSummary } from '../src/features/usage/UsageSummaryView';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const now = '2026-11-18T00:00:00Z';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
const summary = (completeness: string, known: string | null) => ({
  metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: key === 'outputTokens' ? known : null, contributingRecords: known !== null && key === 'outputTokens' ? '1' : '0', unknownRecords: '0' }])),
  scope: 'registered_web_executions', completeness, reasonCodes: [], coverage: { executions: '1', supportedExecutions: '0', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '0', unsupportedExecutions: '1', unavailableExecutions: '0', unregisteredExecutions: '0' }, measurementRecords: known === null ? '0' : '1', lastMeasuredAt: null, observedAt: now, etag: 'etag',
});
const base: TaskRowModel = { id: task, title: 'A task', createdAt: now, status: 'todo', assignedTo: null, tags: [], allowAgents: false, requiredPlatform: null, ready: true, blocked: false, startedAt: null, completedAt: null, cancelledAt: null, paused: false, worker: { kind: 'none' }, session: null };
const row = (model: TaskRowModel, active = true) => <ClockInputProvider input={{ observedAt: now, receivedMonotonic: 0, warningMinutes: 1 }}><ul><TaskRow projectId={project} model={model} tagsActive={active} href={`/projects/${project}/tasks/${task}`} instanceId="row" assignee={null} onOpenTask={() => {}} /></ul></ClockInputProvider>;

it.each(['todo', 'in_progress', 'done'] as const)('places only service-unsupported text before the %s status in both languages', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  const view = renderWithLocale(row({ ...base, status, ready: status === 'todo' }), { locale: 'en', taskCache: true });
  const hint = await screen.findByText('No LLM usage');
  const statusGroup = hint.closest('.task-row-status')!;
  expect(hint.nextElementSibling).toHaveClass('root-status');
  expect(statusGroup.closest('.task-row')!.querySelector('.task-usage-summary')).toBeNull();
  expect(within(statusGroup as HTMLElement).queryByRole('alert')).toBeNull();
  expect(screen.queryByText('This service does not support usage')).toBeNull();
  if (status === 'todo') expect(statusGroup).toHaveTextContent('No LLM usageTo doReady');
  view.setLocale('zh-CN');
  expect(screen.getByText('无LLM用量').nextElementSibling).toHaveClass('root-status');
});

it('retains loading, exact summary, no-data and provider-unsupported readings with usage links', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>(r => { resolve = r; });
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : pending);
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base), { locale: 'en', taskCache: true });
  expect(screen.getByText('Loading usage…')).toBeVisible();
  resolve(reply({ items: [{ taskId: task, summary: summary('unsupported', '9007199254740993') }] }));
  await screen.findByText('9,007,199,254,740,993');
  expect(screen.getByText(/Unsupported$/)).toBeVisible();
  expect(screen.queryByText('No LLM usage')).toBeNull();
  expect(screen.getByRole('link', { name: /Known Output/ })).toHaveAttribute('href', expect.stringContaining('tab=usage'));
  view.unmount();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : reply({ items: [{ taskId: task, summary: summary('no_data', null) }] })));
  renderWithLocale(row(base), { locale: 'en', taskCache: true });
  expect(await screen.findByText(/No data$/)).toBeVisible();
  expect(screen.queryByText('No LLM usage')).toBeNull();
});

it('keeps ordinary errors and retries, while Detail retains its service-unsupported explanation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(reply({ error: { code: 'unavailable', requestId: 'usage.1' } }, 503))
    .mockResolvedValueOnce(reply({ protocol: 'daynight.usage.v1' }))
    .mockResolvedValueOnce(reply({ items: [{ taskId: task, summary: summary('partial', '42') }] }));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base), { locale: 'en', taskCache: true });
  expect(await screen.findByRole('alert')).toHaveTextContent('Usage unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('42');
  expect(screen.queryByRole('alert')).toBeNull();
  view.unmount();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
  renderWithLocale(<TaskUsageSummary projectId={project} taskId={task} />, { locale: 'en', taskCache: true });
  expect(await screen.findByText('This service does not support usage')).toBeVisible();
});

it('does not request usage for an inactive row until activated', async () => {
  const fetch = vi.fn(async () => new Response('not found', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  const view = renderWithLocale(row(base, false), { locale: 'en', taskCache: true });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(fetch).not.toHaveBeenCalled();
  view.rerender(row(base));
  await waitFor(() => expect(screen.getByText('No LLM usage')).toBeVisible());
});
