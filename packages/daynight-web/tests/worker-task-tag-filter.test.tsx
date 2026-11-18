import { webcrypto } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWorkerTaskTagFilter, taskTagFilterDigest, taskTagFilterSemantics } from '../src/api/worker-task-tag-filter';
import { useTaskTagFilterObservation } from '../src/features/workers/configuration/useTaskTagFilterObservation';

afterEach(() => vi.unstubAllGlobals());
describe('Worker task tag filters', () => {
  it.each([
    [['URGENT', 'Backend', 'backend', ' urgent '], 'any', 'd6b8862fae28deb5524520e92b0c2252f54a3d6607ea333c47c6ba91b99816f2'],
    [[], 'all', 'f394e6e6411d7ce2e190d62c0ec2bf0b03248a80ccbc81665757f672f28da1b4'],
    [['<>&', 'html'], 'any', '7d57ff477191df9dee039686b3fd0b5b08760c8c59a038d2c61f951f4ac8e7d0'],
    [['a"b', 'a\\b'], 'all', '8bd5284adbc84a702f90b9083eaa6052b1c94077529dd16d621259803f0f854b'],
    [['后端', '紧急'], 'any', '66b4554122a75ae7c8bf7ff9906ce07d841c4a2392a1d07b041cd6de84e3f0ed'],
    [['𐀀', '', '😀', 'a'], 'all', '66f47f2cf0f7735832daa25f2ab12ed6dd6e16e20ac5ab52dbc552fd6b36f56c'],
    [['É'], 'any', 'b3b98251fee79ee896b3ed60eb8745f31796009ca8e31f2356a26f36186bad59'],
    [['é'], 'any', 'f4c47b9a36cdc0d6ca7fff7292dabdbe2a7e76de600bf080fa109e7e89954f02'],
    [['é'], 'any', '307fbb6c5220ab4ca91a4a9e5d3de6733d175d7934cb72b2133631370c6e5c13'],
    [[' Ab C ', 'backend'], 'any', '41957b95de93facb7581788d9da48b8c5e5250bd0c49d7c0842df4f8d69e0088'],
  ] as const)('matches server digest vectors', async (names, match, expected) => {
    vi.stubGlobal('crypto', webcrypto);
    expect(await taskTagFilterDigest(taskTagFilterSemantics({ names, match }))).toBe(expected);
  });
  it.each([null, { names: null, match: 'any' }, { names: [' '], match: 'any' }, { names: ['a\u2028b'], match: 'all' }, { names: ['😀'.repeat(65)], match: 'any' }, { names: ['\ud800'], match: 'any' }, { names: [], match: 'other' }])('rejects invalid input', value => {
    expect(() => parseWorkerTaskTagFilter(value)).toThrow();
  });
  it('isolates late results across targets, workers and principals, and reports failures', async () => {
    const pending: Array<ReturnType<typeof Promise.withResolvers<ArrayBuffer>>> = [];
    vi.stubGlobal('crypto', { subtle: { digest: () => { const result = Promise.withResolvers<ArrayBuffer>(); pending.push(result); return result.promise; } } });
    const one = {}, two = {}, a = { names: ['a'], match: 'any' as const }, b = { names: ['b'], match: 'any' as const };
    const { result, rerender } = renderHook(({ principal, worker, filter }) => useTaskTagFilterObservation(principal, worker, filter), { initialProps: { principal: one, worker: 'one', filter: a } });
    rerender({ principal: one, worker: 'one', filter: b });
    await act(async () => pending[0]!.resolve(new Uint8Array(32).buffer));
    expect(result.current.state).toBe('checking');
    await act(async () => pending[1]!.resolve(new Uint8Array(32).fill(1).buffer));
    expect(result.current).toEqual({ state: 'ready', digest: '01'.repeat(32) });
    rerender({ principal: one, worker: 'two', filter: b });
    expect(result.current.state).toBe('checking');
    rerender({ principal: two, worker: 'two', filter: b });
    await act(async () => pending[2]!.resolve(new Uint8Array(32).buffer));
    expect(result.current.state).toBe('checking');
    await act(async () => pending[3]!.reject(new Error('digest failed')));
    await waitFor(() => expect(result.current.state).toBe('error'));
  });
});

it('keeps the Worker failure visible while digest checking fails', async () => {
  const { renderWithLocale } = await import('./helpers/renderWithLocale');
  const { ConfigurationTaskTagFeedback, taskTagApplicationState } = await import('../src/features/workers/configuration/ConfigurationFeedback');
  const { configurationResource, configurationValue } = await import('./helpers/worker-configuration');
  const { WORKER_TIME } = await import('./helpers/workers');
  const filter = { names: ['backend'], match: 'any' as const };
  const failure = { code: 'io_error' as const, category: 'storage' as const, phase: 'persist' as const, occurredAt: WORKER_TIME };
  const resource = { ...configurationResource('1', { ...configurationValue(), taskTagFilter: filter }), observationRevision: '1', observation: { baseRevision: '0', desiredRevision: '1', reportedAt: WORKER_TIME, items: [{ key: { kind: 'taskTagFilter' as const }, targetRevision: '1', appliedValue: 'a'.repeat(64), state: 'error' as const, error: failure, lastFailure: null, nextAttemptAt: null }] } };
  const { container, rerender } = renderWithLocale(<ConfigurationTaskTagFeedback resource={resource} filter={filter} digest={{ state: 'checking' }} />, { locale: 'en' });
  expect(container).toHaveTextContent('Failed'); expect(container).toHaveTextContent('Checking'); expect(container).toHaveTextContent('Storage or I/O error');
  rerender(<ConfigurationTaskTagFeedback resource={resource} filter={filter} digest={{ state: 'error' }} />);
  expect(container).toHaveTextContent('Failed'); expect(container).toHaveTextContent('Unable to check application');
  expect(container).not.toHaveTextContent('a'.repeat(64));
  expect(taskTagApplicationState(resource, { state: 'error' })).toBe('error');
  for (const phase of ['pending', 'applying'] as const) {
    const running = { ...resource, observation: { ...resource.observation, items: [{ ...resource.observation.items[0]!, state: phase, error: null }] } };
    rerender(<ConfigurationTaskTagFeedback resource={running} filter={filter} digest={{ state: 'error' }} />);
    expect(container.querySelector('.status-chip')).toHaveTextContent(phase === 'applying' ? 'Applying' : 'Awaiting application');
    expect(container).toHaveTextContent('Unable to check application');
    expect(taskTagApplicationState(running, { state: 'error' })).toBe('error');
  }
});
