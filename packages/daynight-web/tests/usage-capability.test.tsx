import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { usageMetricKeys } from '../src/api/usage';
import { TaskUsagePanel } from '../src/features/usage/TaskUsagePanel';
import { useTaskUsage } from '../src/features/usage/useTaskUsage';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
const unavailable = () => reply({ error: { code: 'unavailable', requestId: 'usage.1' } }, 503);

const Probe = () => {
  const state = useTaskUsage(project, task);
  return <><output>{state.capability}</output><span>{state.error === null ? 'no error' : 'error'}</span><button onClick={state.retry}>Retry</button></>;
};

it('exposes capability as soon as negotiation succeeds, independent of a failing summary', async () => {
  let finishSummary!: (response: Response) => void;
  const summary = new Promise<Response>(resolve => { finishSummary = resolve; });
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : summary);
  vi.stubGlobal('fetch', fetch);
  renderWithLocale(<Probe />, { locale: 'en', taskCache: true });
  expect(screen.getByText('pending')).toBeVisible();
  await screen.findByText('available');
  finishSummary(unavailable());
  await screen.findByText('error');
  expect(screen.getByText('available')).toBeVisible();
});

it('distinguishes unsupported service from a recoverable capability failure', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(new Response('not found', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  renderWithLocale(<Probe />, { locale: 'en', taskCache: true });
  await screen.findByText('error', { selector: 'output' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('unsupported');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('keeps negotiated support through a temporary recheck failure and revokes it on unsupported', async () => {
  const fetch = vi.fn(async (url: string) => url.endsWith('capabilities') ? reply({ protocol: 'daynight.usage.v1' }) : unavailable());
  vi.stubGlobal('fetch', fetch);
  renderWithLocale(<Probe />, { locale: 'en', taskCache: true });
  await screen.findByText('error', { selector: 'span' });
  expect(screen.getByText('available')).toBeVisible();
  fetch.mockImplementation(async () => unavailable());
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  expect(screen.getByText('available')).toBeVisible();
  fetch.mockImplementation(async () => new Response('not found', { status: 404 }));
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('unsupported');
});

it.each([401, 403, 404])('clears records when summary access is denied (%i), ignores late responses, and reloads after access returns', async status => {
  const now = '2026-11-18T00:00:00Z';
  const recordId = '20000000-0000-4000-8000-000000000002';
  const metrics = Object.fromEntries([...usageMetricKeys, 'providerTotalTokens'].map(key => [key, null]));
  const page = reply({ items: [{ id: recordId, recordKind: 'execution_state', sessionId: task, stateId: null, executionGeneration: '1', provider: 'private-provider', model: 'private-model', sourceKey: null, profileId: 'test', providerVersion: '1', collectionState: 'complete', metrics, reasonCodes: [], observedAt: now, updatedAt: now }], nextCursor: null, snapshotToken: 'snap', observedAt: now });
  const summary = reply({ items: [{ taskId: task, summary: { metrics: Object.fromEntries(usageMetricKeys.map(key => [key, { known: null, contributingRecords: '0', unknownRecords: '1' }])), scope: 'registered_web_executions', completeness: 'partial', reasonCodes: [], coverage: { executions: '1', supportedExecutions: '1', collectingExecutions: '0', completeExecutions: '0', partialExecutions: '1', unsupportedExecutions: '0', unavailableExecutions: '0', unregisteredExecutions: '0' }, measurementRecords: '0', lastMeasuredAt: null, observedAt: now, etag: 'etag' } }] });
  let denySummary!: (response: Response) => void, finishOldRecords!: (response: Response) => void, restoreSummary!: (response: Response) => void;
  const firstSummary = new Promise<Response>(resolve => { denySummary = resolve; });
  const oldRecords = new Promise<Response>(resolve => { finishOldRecords = resolve; });
  const nextSummary = new Promise<Response>(resolve => { restoreSummary = resolve; });
  let summaries = 0, records = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('capabilities')) return reply({ protocol: 'daynight.usage.v1' });
    if (url.endsWith('task-summaries')) return ++summaries === 1 ? firstSummary : nextSummary;
    if (url.includes('/records?')) return ++records === 1 ? oldRecords : page.clone();
    throw new Error(`Unexpected request: ${url}`);
  }));
  renderWithLocale(<TaskUsagePanel projectId={project} taskId={task} active />, { locale: 'en', taskCache: true });
  await waitFor(() => expect(records).toBe(1));
  await act(async () => { denySummary(reply({ error: { code: 'denied', requestId: 'usage.2' } }, status)); });
  await screen.findByRole('alert');
  await act(async () => { finishOldRecords(page.clone()); });
  expect(screen.queryByText('private-provider · private-model')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(summaries).toBe(2));
  expect(records).toBe(1);
  await act(async () => { restoreSummary(summary); });
  await screen.findByText('private-provider · private-model');
  expect(records).toBe(2);
});

it.each([401, 403])('keeps records closed after capability access denial (%i) until task access is restored', async status => {
  let resolveSummary!: (response: Response) => void;
  const delayedSummary = new Promise<Response>(resolve => { resolveSummary = resolve; });
  let capabilities = 0, summaries = 0, records = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('capabilities')) return ++capabilities === 1 ? reply({ error: { code: 'denied', requestId: 'usage.3' } }, status) : reply({ protocol: 'daynight.usage.v1' });
    if (url.endsWith('task-summaries')) { summaries++; return delayedSummary; }
    if (url.includes('/records?')) { records++; return reply({ items: [], nextCursor: null, snapshotToken: 'snap', observedAt: '2026-11-18T00:00:00Z' }); }
    throw new Error(`Unexpected request: ${url}`);
  }));
  renderWithLocale(<TaskUsagePanel projectId={project} taskId={task} active />, { locale: 'en', taskCache: true });
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(summaries).toBe(1));
  expect(records).toBe(0);
  await act(async () => { resolveSummary(reply({ error: { code: 'denied', requestId: 'usage.4' } }, 403)); });
  expect(screen.getByRole('alert')).toHaveTextContent('Usage unavailable');
  expect(records).toBe(0);
  expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
});
