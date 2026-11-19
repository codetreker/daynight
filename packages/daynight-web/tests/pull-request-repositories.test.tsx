import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invalidateAuthRequests } from '../src/api/client';
import { usePullRequestRepositories } from '../src/features/pull-requests/usePullRequestRepositories';
import { prProjectId, prResponse, prUserId } from './pull-requests-fixtures';

afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('loads every source, defaults to current and retains a historical selection across refresh and disconnect', async () => {
  let current: string | null = '5';
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input, 'https://test');
    const second = url.searchParams.get('cursor') === 'next';
    return prResponse({ currentRepositoryId: current, items: second ? [{ repositoryId: '5', fullName: 'o/new' }] : [{ repositoryId: '4', fullName: 'o/old' }], nextCursor: second ? null : 'next' });
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequestRepositories({ userId: prUserId, projectId: prProjectId, active: true, canRead: true, onPrincipalMismatch: vi.fn() }));
  await waitFor(() => expect(result.current.loaded).toBe(true));
  expect(result.current.repositories.map(item => item.repositoryId)).toEqual(['4', '5']);
  expect(result.current.repositoryId).toBe('5');
  act(() => result.current.setRepositoryId('4'));
  current = null;
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.currentRepositoryId).toBeNull());
  expect(result.current.repositoryId).toBe('4');
  expect(fetch.mock.calls.some(([input]) => new URL(input, 'https://test').searchParams.get('cursor') === 'next')).toBe(true);
});

it('exposes an initial directory failure and allows retry without issuing an implicit PR read', async () => {
  let fail = true;
  const fetch = vi.fn(async (input: string) => {
    expect(new URL(input, 'https://test').pathname).toContain('/pull-request-repositories');
    if (fail) throw new TypeError('network');
    return prResponse({ currentRepositoryId: null, items: [{ repositoryId: '4', fullName: 'o/old' }], nextCursor: null });
  });
  vi.stubGlobal('fetch', fetch);
  const { result } = renderHook(() => usePullRequestRepositories({ userId: prUserId, projectId: prProjectId, active: true, canRead: true, onPrincipalMismatch: vi.fn() }));
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.repositoryId).toBeNull();
  fail = false; act(() => result.current.retry());
  await waitFor(() => expect(result.current.repositoryId).toBe('4'));
  expect(result.current.error).toBeNull();
});
