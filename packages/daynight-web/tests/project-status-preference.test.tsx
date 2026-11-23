import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ALL_TASK_STATUSES, equalTaskStatuses, matchesTaskStatus, normalizeTaskStatuses } from '../src/features/projects/task-status-filter';
import { useProjectStatusFilter } from '../src/features/projects/useProjectViewPreferences';

const project = 'project';
const otherProject = 'other-project';
const viewer = 'viewer';
const otherUser = 'other-user';
const key = (p = project, u = viewer) => `daynight:task-status-filter:${JSON.stringify([p, u])}`;

describe('project status preferences', () => {
  it('uses a fixed order for membership and equality', () => {
    expect(normalizeTaskStatuses(['done', 'todo', 'done'])).toEqual(['todo', 'done']);
    expect(equalTaskStatuses(['todo', 'done'], ['done', 'todo'])).toBe(true);
    expect(equalTaskStatuses(['todo'], [])).toBe(false);
    expect(matchesTaskStatus(['todo', 'done'], 'done')).toBe(true);
    expect(matchesTaskStatus([], 'todo')).toBe(false);
  });

  it('restores empty and nonempty selections by account and project without writing on load', () => {
    localStorage.setItem(key(otherProject, viewer), '["done","todo"]');
    localStorage.setItem(key(project, otherUser), '[]');
    const { result, rerender, unmount } = renderHook(({ p, u }) => useProjectStatusFilter(p, u), {
      initialProps: { p: project, u: viewer },
    });
    expect(result.current.filter).toEqual(ALL_TASK_STATUSES);
    expect(localStorage.getItem(key())).toBeNull();
    act(() => result.current.onFilterChange(['done', 'todo', 'done']));
    expect(localStorage.getItem(key())).toBe('["todo","done"]');
    const unchanged = result.current.filter;
    act(() => result.current.onFilterChange(['done', 'todo']));
    expect(result.current.filter).toBe(unchanged);
    const staleSave = result.current.onFilterChange;
    rerender({ p: otherProject, u: viewer });
    expect(result.current.filter).toEqual(['todo', 'done']);
    act(() => staleSave([]));
    expect(localStorage.getItem(key())).toBe('["todo","done"]');
    rerender({ p: project, u: otherUser });
    expect(result.current.filter).toEqual([]);
    rerender({ p: project, u: viewer });
    expect(result.current.filter).toEqual(['todo', 'done']);
    act(() => result.current.onFilterChange([]));
    unmount();
    expect(renderHook(() => useProjectStatusFilter(project, viewer)).result.current.filter).toEqual([]);
    expect(localStorage.getItem(key())).toBe('[]');
  });

  it.each(['{', 'null', '{}', '"todo"', '["unknown"]', '["todo","todo"]', '[null]', '[1]'])('rejects invalid stored value %s without replacing it', (saved) => {
    localStorage.setItem(key(), saved);
    const { result } = renderHook(() => useProjectStatusFilter(project, viewer));
    expect(result.current.filter).toEqual(ALL_TASK_STATUSES);
    expect(result.current.issue?.kind).toBe('invalid');
    expect(localStorage.getItem(key())).toBe(saved);
    act(() => result.current.onFilterChange([]));
    expect(result.current.issue).toBeNull();
    expect(localStorage.getItem(key())).toBe('[]');
  });

  it('allows filtering after a read failure and clears the error after a successful save', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw new Error('read'); });
    const { result } = renderHook(() => useProjectStatusFilter(project, viewer));
    expect(result.current.filter).toEqual(ALL_TASK_STATUSES);
    expect(result.current.issue?.kind).toBe('read');
    act(() => result.current.onFilterChange(['todo']));
    expect(result.current.filter).toEqual(['todo']);
    expect(result.current.issue).toBeNull();
  });

  it('applies session changes when saving fails and clears the error after a successful save', () => {
    localStorage.setItem(key(), '["done"]');
    const { result } = renderHook(() => useProjectStatusFilter(project, viewer));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('write'); });
    act(() => result.current.onFilterChange([]));
    expect(result.current.filter).toEqual([]);
    expect(result.current.issue?.kind).toBe('write');
    expect(localStorage.getItem(key())).toBe('["done"]');
    act(() => result.current.onFilterChange([]));
    expect(result.current.issue).toBeNull();
    expect(localStorage.getItem(key())).toBe('[]');
  });
});
