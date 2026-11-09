import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useProjectAssigneeFilter } from '../src/features/projects/useProjectViewPreferences';

const project = '00000000-0000-4000-8000-000000000100';
const otherProject = '00000000-0000-4000-8000-000000000101';
const viewer = '00000000-0000-4000-8000-000000000201';
const otherUser = '00000000-0000-4000-8000-000000000202';
const key = (p = project, u = viewer) => `daynight:task-assignee-filter:${JSON.stringify([p, u])}`;

describe('project assignee preferences', () => {
  it('restores each project and account independently, including after identity changes while mounted', () => {
    const { result, rerender, unmount } = renderHook(({ p, u }) => useProjectAssigneeFilter(p, u), {
      initialProps: { p: project, u: viewer },
    });
    expect(result.current.filter).toEqual({ kind: 'all' });
    expect(localStorage.getItem(key())).toBeNull();
    act(() => result.current.onFilterChange({ kind: 'me' }));
    expect(JSON.parse(localStorage.getItem(key())!)).toEqual({ kind: 'me' });
    rerender({ p: otherProject, u: viewer });
    expect(result.current.filter).toEqual({ kind: 'all' });
    act(() => result.current.onFilterChange({ kind: 'unassigned' }));
    rerender({ p: project, u: otherUser });
    expect(result.current.filter).toEqual({ kind: 'all' });
    act(() => result.current.onFilterChange({ kind: 'user', userId: otherUser }));
    rerender({ p: project, u: viewer });
    expect(result.current.filter).toEqual({ kind: 'me' });
    act(() => result.current.onFilterChange({ kind: 'all' }));
    unmount();
    expect(renderHook(() => useProjectAssigneeFilter(project, viewer)).result.current.filter).toEqual({ kind: 'all' });
    expect(JSON.parse(localStorage.getItem(key())!)).toEqual({ kind: 'all' });
    expect(JSON.parse(localStorage.getItem(key(otherProject, viewer))!)).toEqual({ kind: 'unassigned' });
    expect(JSON.parse(localStorage.getItem(key(project, otherUser))!)).toEqual({ kind: 'user', userId: otherUser });
  });

  it.each([
    '{', 'null', '[]', '"me"', '{}', '{"kind":"unknown"}', '{"kind":"me","userId":"x"}',
    '{"kind":"user"}', '{"kind":"user","userId":""}', '{"kind":"user","userId":42}',
    '{"kind":"user","userId":"not-a-uuid"}', `{"kind":"user","userId":"${otherUser}","extra":true}`,
  ])('rejects invalid stored union value %s', (saved) => {
    localStorage.setItem(key(), saved);
    const { result } = renderHook(() => useProjectAssigneeFilter(project, viewer));
    expect(result.current.filter).toEqual({ kind: 'all' });
    expect(result.current.issue?.kind).toBe('invalid');
    expect(localStorage.getItem(key())).toBe(saved);
    act(() => result.current.onFilterChange({ kind: 'unassigned' }));
    expect(result.current.filter).toEqual({ kind: 'unassigned' });
    expect(JSON.parse(localStorage.getItem(key())!)).toEqual({ kind: 'unassigned' });
  });

  it('continues operating when storage reads fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('read'); });
    const { result } = renderHook(() => useProjectAssigneeFilter(project, viewer));
    expect(result.current.filter).toEqual({ kind: 'all' });
    expect(result.current.issue?.kind).toBe('read');
    act(() => result.current.onFilterChange({ kind: 'me' }));
    expect(result.current.filter).toEqual({ kind: 'me' });
  });

  it('reports an unsuccessful write while applying the session filter, and recovers after a successful write', () => {
    localStorage.setItem(key(), JSON.stringify({ kind: 'unassigned' }));
    const { result } = renderHook(() => useProjectAssigneeFilter(project, viewer));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('write'); });
    act(() => result.current.onFilterChange({ kind: 'me' }));
    expect(result.current.filter).toEqual({ kind: 'me' });
    expect(result.current.issue?.kind).toBe('write');
    expect(JSON.parse(localStorage.getItem(key())!)).toEqual({ kind: 'unassigned' });
    act(() => result.current.onFilterChange({ kind: 'all' }));
    expect(result.current.issue).toBeNull();
    expect(JSON.parse(localStorage.getItem(key())!)).toEqual({ kind: 'all' });
  });
});
