import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { getAssistantTaskMetrics, type AssistantTaskMetrics as Metrics } from '../src/api/assistant-tasks';
import { AssistantTaskMetrics, formatResolution } from '../src/features/bots/AssistantTaskMetrics';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, botId } from './helpers/bots';

vi.mock(import('../src/api/assistant-tasks'), async importOriginal => ({ ...await importOriginal(), getAssistantTaskMetrics: vi.fn() }));
const taskId = botId(30);
const metrics: Metrics = { observedAt: BOT_TIME, windowStart: '2026-10-05T12:00:00Z', windowEnd: BOT_TIME, actionCount: 12, outcomes: { effective: 7, ineffective: 2, inconclusive: 1 }, escalationCount: 3, resultUnknownCount: 1, closureCount: 5, untimedClosureCount: 2, averageResolutionMs: 3 * 3_600_000, recurringItemCount: 4 };
const tile = (region: HTMLElement, label: string) => within(region).getByText(label, { selector: 'dt' }).nextElementSibling;
beforeEach(() => vi.mocked(getAssistantTaskMetrics).mockReset());

it('shows every 30-day metric with the excluded untimed closures', async () => {
  vi.mocked(getAssistantTaskMetrics).mockResolvedValue(metrics);
  renderWithLocale(<AssistantTaskMetrics taskId={taskId} enabled />, { locale: 'en', taskCache: true });
  const region = await screen.findByRole('region', { name: 'Last 30 days' });
  expect(await within(region).findByText('Actions', { selector: 'dt' })).toBeVisible();
  for (const [label, value] of [['Actions', '12'], ['Effective', '7'], ['Ineffective', '2'], ['Inconclusive', '1'], ['Escalations', '3'], ['Results unknown', '1'], ['Closures', '5'], ['Average resolution', '3 hr'], ['Recurring items', '4']] as const)
    expect(tile(region, label)).toHaveTextContent(value);
  expect(within(region).getByText('2 closures without a recorded open time are excluded from the average.')).toBeVisible();
  expect(vi.mocked(getAssistantTaskMetrics).mock.calls[0]![0]).toBe(taskId);
});

it('shows a dash without an average and omits the untimed note when every closure is timed', async () => {
  vi.mocked(getAssistantTaskMetrics).mockResolvedValue({ ...metrics, closureCount: 0, untimedClosureCount: 0, averageResolutionMs: null });
  renderWithLocale(<AssistantTaskMetrics taskId={taskId} enabled />, { locale: 'zh-CN', taskCache: true });
  const region = await screen.findByRole('region', { name: '最近 30 天' });
  expect(await within(region).findByText('平均解决时长', { selector: 'dt' })).toBeVisible();
  expect(tile(region, '平均解决时长')).toHaveTextContent('—');
  expect(within(region).queryByText(/未计入平均时长/)).toBeNull();
});

it('reports a failed read and retries it', async () => {
  vi.mocked(getAssistantTaskMetrics).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(metrics);
  renderWithLocale(<AssistantTaskMetrics taskId={taskId} enabled />, { locale: 'en', taskCache: true });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Could not load the 30-day metrics.');
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Actions', { selector: 'dt' })).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not read while disabled', () => {
  renderWithLocale(<AssistantTaskMetrics taskId={taskId} enabled={false} />, { locale: 'en', taskCache: true });
  expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  expect(getAssistantTaskMetrics).not.toHaveBeenCalled();
});

it('formats resolution in minutes, hours or days', () => {
  expect(formatResolution(90_000, 'en')).toBe('1.5 min');
  expect(formatResolution(5_400_000, 'en')).toBe('1.5 hr');
  expect(formatResolution(2.5 * 86_400_000, 'en')).toBe('2.5 days');
});
