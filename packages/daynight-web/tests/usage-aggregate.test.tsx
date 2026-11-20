import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getUsageAggregate, parseUsageAggregate } from '../src/api/usage-aggregate';
import { UsageAggregatePanel, UsageAggregateDisclosure } from '../src/features/usage-aggregate/UsageAggregatePanel';
import { renderWithLocale } from './helpers/renderWithLocale';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const secondTask = '20000000-0000-4000-8000-000000000002';
const user = '30000000-0000-4000-8000-000000000001';
const account = { session: { status: 'authenticated', user: { id: user }, generation: 1 }, requireAccountRefresh: vi.fn() };
vi.mock('../src/app/AccountSessionProvider', () => ({ useOptionalAccountSession: () => account }));
const timestamp = '2026-11-18T12:00:00Z';
const summary = () => ({
  metrics: Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'].map(key => [key, { known: key === 'outputTokens' ? '9007199254740993' : null, contributingRecords: key === 'outputTokens' ? '1' : '0', unknownRecords: key === 'outputTokens' ? '0' : '1' }])),
  scope: 'registered_executions', completeness: 'partial', reasonCodes: ['metric_unavailable'],
  coverage: { executions: '2', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '1', unsupportedExecutions: '0', unavailableExecutions: '0', unregisteredExecutions: '1' },
  measurementRecords: '1', lastMeasuredAt: timestamp, observedAt: timestamp, etag: 'summary-revision',
});
const aggregate = () => ({
  scope: 'goal', scopeId: task, membershipPolicy: 'current_members_excludes_deleted', membershipRevision: 'membership-revision', summary: summary(),
  members: { total: '2', withKnownUsage: '1', complete: '0', collecting: '0', partial: '1', unsupported: '0', unavailable: '0', noData: '1', restricted: '0' },
  missingMembers: [{ taskId: task, title: 'Partial task', completeness: 'partial', reasonCodes: ['metric_unavailable'], summaryUrl: '/unused' }],
  nextMembersCursor: 'next-page', observedAt: timestamp,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': user } });
const failure = (code: string, status: number) => response({ error: { code, requestId: 'request-1' } }, status);
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('preserves exact integer strings and rejects a different scope or invalid member coverage', () => {
  expect(parseUsageAggregate(aggregate(), 'goal', task).summary.metrics.outputTokens.known).toBe('9007199254740993');
  expect(() => parseUsageAggregate(aggregate(), 'chain', task)).toThrow();
  expect(() => parseUsageAggregate({ ...aggregate(), scopeId: secondTask }, 'goal', task)).toThrow();
  expect(() => parseUsageAggregate({ ...aggregate(), members: { ...aggregate().members, total: '3' } }, 'goal', task)).toThrow();
  expect(() => parseUsageAggregate({ ...aggregate(), members: { ...aggregate().members, total: 2 } }, 'goal', task)).toThrow();
  expect(() => parseUsageAggregate({ ...aggregate(), members: { ...aggregate().members, restricted: '1' } }, 'goal', task)).toThrow();
  expect(() => parseUsageAggregate({ ...aggregate(), missingMembers: Array(101).fill(aggregate().missingMembers[0]) }, 'goal', task)).toThrow();
});

it('binds aggregate reads to authenticated principal and encodes the cursor', async () => {
  const fetcher = vi.fn().mockResolvedValue(response(aggregate()));
  vi.stubGlobal('fetch', fetcher);
  const admission = { userId: user, onPrincipalMismatch: vi.fn() };
  await getUsageAggregate(project, 'goal', task, 'cursor+/?', new AbortController().signal, admission);
  expect(fetcher.mock.calls[0]![0]).toBe(`/api/projects/${project}/usage/v1/aggregates/goal/${task}?cursor=cursor%2B%2F%3F`);
  fetcher.mockResolvedValue(new Response(JSON.stringify(aggregate()), { headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': secondTask } }));
  await expect(getUsageAggregate(project, 'goal', task, null, new AbortController().signal, admission)).rejects.toMatchObject({ code: 'principal_mismatch' });
  expect(admission.onPrincipalMismatch).toHaveBeenCalledOnce();
});

it('loads bounded member pages, keeps the exact server aggregate, and opens an incomplete task', async () => {
  const page2 = { ...aggregate(), missingMembers: [{ taskId: secondTask, title: 'Unknown task', completeness: 'no_data', reasonCodes: ['legacy_unknown'] }], nextMembersCursor: null };
  const fetcher = vi.fn(async (url: string) => response(url.includes('/capabilities') ? { protocol: 'daynight.usage.v1' } : url.includes('?cursor=') ? page2 : aggregate()));
  vi.stubGlobal('fetch', fetcher);
  const open = vi.fn();
  renderWithLocale(<UsageAggregatePanel projectId={project} scope="goal" scopeId={task} onOpenTask={open} />, { locale: 'en' });
  await screen.findByText('Partial task');
  expect(screen.getByText('9,007,199,254,740,993', { exact: false })).toBeVisible();
  expect(screen.getByText('Unknown usage').nextElementSibling).toHaveTextContent('1');
  fireEvent.click(screen.getByRole('button', { name: 'Load more incomplete tasks' }));
  await screen.findByText('Unknown task');
  expect(screen.getByRole('button', { name: 'Partial task' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Load more incomplete tasks' })).toBeNull();
  const button = screen.getByRole('button', { name: 'Unknown task' });
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith(secondTask, button);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/aggregates/'))).toHaveLength(2);
});

it('does not append a changed page and recovers by refreshing the first page', async () => {
  const fetcher = vi.fn(async (url: string) => url.includes('/capabilities') ? response({ protocol: 'daynight.usage.v1' }) : url.includes('?cursor=') ? failure('reset_required', 409) : response(aggregate()));
  vi.stubGlobal('fetch', fetcher);
  renderWithLocale(<UsageAggregatePanel projectId={project} scope="goal" scopeId={task} onOpenTask={vi.fn()} />, { locale: 'en' });
  await screen.findByText('Partial task');
  fireEvent.click(screen.getByRole('button', { name: 'Load more incomplete tasks' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Load more incomplete tasks' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/aggregates/') && !url.includes('?'))).toHaveLength(2);
});

it('removes previously displayed member details after permission loss', async () => {
  let forbidden = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/capabilities') ? response({ protocol: 'daynight.usage.v1' }) : forbidden ? failure('aggregate_scope_restricted', 403) : response(aggregate())));
  renderWithLocale(<UsageAggregatePanel projectId={project} scope="goal" scopeId={task} onOpenTask={vi.fn()} />, { locale: 'zh-CN' });
  await screen.findByText('Partial task');
  forbidden = true;
  fireEvent.click(screen.getByRole('button', { name: '刷新用量' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('Partial task')).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent('没有权限');
});

it('fetches graph aggregates only after expansion and distinguishes capability refusal from a failed read', async () => {
  const fetcher = vi.fn().mockResolvedValue(failure('not_found', 404));
  vi.stubGlobal('fetch', fetcher);
  renderWithLocale(<UsageAggregateDisclosure projectId={project} scope="chain" scopeId={task} onOpenTask={vi.fn()} />, { locale: 'en' });
  expect(fetcher).not.toHaveBeenCalled();
  const disclosure = screen.getByText('Token usage').closest('details')!;
  disclosure.open = true;
  fireEvent(disclosure, new Event('toggle'));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('does not support usage');
  expect(fetcher).toHaveBeenCalledOnce();
});
