import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TaskUsagePanel } from '../src/features/usage/TaskUsagePanel';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID } from './helpers/taskSync';

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });

it('shows only the neutral unsupported state and never requests records', async () => {
  const fetch = vi.fn(async (_url: string) => new Response('404 page not found', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  renderWithLocale(<TaskUsagePanel projectId={project} taskId={task} active />, { locale: 'en', taskCache: true });
  expect(await screen.findAllByText('This service does not support usage')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /Retry|Filter|Refresh|page/ })).toBeNull();
  expect(screen.queryByLabelText('View')).toBeNull();
  expect(fetch.mock.calls.every(([url]) => String(url).endsWith('capabilities'))).toBe(true);
});

it('starts records after capability negotiation without waiting for the summary, and submits filters by keyboard', async () => {
  let finishCapability!: (response: Response) => void;
  const capability = new Promise<Response>(resolve => { finishCapability = resolve; });
  const fetch = vi.fn((url: string) => {
    if (url.endsWith('capabilities')) return capability;
    if (url.endsWith('task-summaries')) return new Promise<Response>(() => {});
    return Promise.resolve(reply({ items: [], nextCursor: null, snapshotToken: 'snap', observedAt: '2026-11-18T00:00:00Z' }));
  });
  vi.stubGlobal('fetch', fetch);
  renderWithLocale(<TaskUsagePanel projectId={project} taskId={task} active />, { locale: 'en', taskCache: true });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByLabelText('View')).toBeNull();
  finishCapability(reply({ protocol: 'daynight.usage.v1' }));
  await screen.findByText('No measurements; unknown does not mean zero.');
  expect(fetch.mock.calls.some(([url]) => url.includes('/records?'))).toBe(true);
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'copilot' } });
  fireEvent.submit(screen.getByLabelText('Provider').closest('form')!);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('provider=copilot'))).toBe(true));
});
