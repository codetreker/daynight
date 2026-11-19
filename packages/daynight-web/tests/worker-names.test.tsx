import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api/client';
import * as aliases from '../src/api/worker-alias';
import { useWorkerNames } from '../src/features/worker-names/useWorkerNames';
import { renderWithLocale } from './helpers/renderWithLocale';

vi.mock('../src/api/worker-alias', async original => ({ ...await original<typeof aliases>(), getWorkerAlias: vi.fn() }));
const userId = '00000000-0000-4000-8000-000000000001';
const otherUser = '00000000-0000-4000-8000-000000000002';
const workerId = '00000000-0000-4000-8000-000000000003';
const otherWorker = '00000000-0000-4000-8000-000000000004';
const Name = ({ owner = userId, worker = workerId, detailed = false }: { owner?: string; worker?: string; detailed?: boolean }) => {
  const names = useWorkerNames([{ userId: owner, workerId: worker }]);
  return <p>{names.name(owner, worker, 'HISTORICAL HOST', detailed)}</p>;
};
afterEach(() => vi.useRealTimers());

it('shares one polling lifetime across consumers mounted in different batches', async () => {
  vi.useFakeTimers();
  const mock = vi.mocked(aliases.getWorkerAlias).mockResolvedValue({ value: 'Shared', version: '1' });
  const view = renderWithLocale(<><Name />{null}</>, { locale: 'en', taskCache: { viewerId: userId } });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  view.rerender(<><Name /><Name detailed /></>);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(mock).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(mock).toHaveBeenCalledTimes(2);
});

it('deduplicates readers and preserves the historical hostname and other-account boundary', async () => {
  vi.mocked(aliases.getWorkerAlias).mockResolvedValue({ value: '办公室', version: '2' });
  renderWithLocale(<><Name /><Name detailed /><Name owner={otherUser} /></>, { locale: 'zh-CN', taskCache: { viewerId: userId } });
  expect(screen.getAllByText('HISTORICAL HOST')).toHaveLength(3);
  await screen.findByText('办公室 · HISTORICAL HOST');
  expect(screen.getByText('办公室')).toBeVisible();
  expect(screen.getByText('HISTORICAL HOST')).toBeVisible();
  expect(aliases.getWorkerAlias).toHaveBeenCalledTimes(1);
  expect(aliases.getWorkerAlias).toHaveBeenCalledWith(workerId, expect.any(AbortSignal), expect.objectContaining({ userId }));
});

it('refreshes modifications and clearing, keeps known metadata on failure, and rejects older versions', async () => {
  vi.useFakeTimers();
  const mock = vi.mocked(aliases.getWorkerAlias).mockResolvedValue({ value: 'First', version: '2' });
  renderWithLocale(<Name detailed />, { locale: 'en', taskCache: { viewerId: userId } });
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText('First · HISTORICAL HOST')).toBeVisible();
  mock.mockResolvedValue({ value: 'Changed', version: '3' });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('Changed · HISTORICAL HOST')).toBeVisible();
  mock.mockResolvedValue({ value: 'Old', version: '2' });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('Changed · HISTORICAL HOST')).toBeVisible();
  mock.mockRejectedValue(new ApiError('network'));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('Changed · HISTORICAL HOST')).toBeVisible();
  mock.mockResolvedValue({ value: null, version: '4' });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('HISTORICAL HOST')).toBeVisible();
  mock.mockResolvedValue({ value: 'Restored', version: '5' });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('Restored · HISTORICAL HOST')).toBeVisible();
  mock.mockRejectedValue(new ApiError('server', 404, 'not_found'));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(screen.getByText('HISTORICAL HOST')).toBeVisible();
});

it('aborts unused reads and fences delayed results when changing Workers', async () => {
  const old = Promise.withResolvers<aliases.WorkerAlias>();
  const mock = vi.mocked(aliases.getWorkerAlias).mockImplementation(async worker => worker === workerId ? old.promise : { value: 'Second', version: '1' });
  const view = renderWithLocale(<Name />, { locale: 'en', taskCache: { viewerId: userId } });
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
  const signal = mock.mock.calls[0]![1];
  view.rerender(<Name worker={otherWorker} />);
  await screen.findByText('Second');
  expect(signal.aborted).toBe(true);
  await act(async () => { old.resolve({ value: 'Wrong', version: '8' }); await old.promise; });
  expect(screen.queryByText('Wrong')).toBeNull();
});
