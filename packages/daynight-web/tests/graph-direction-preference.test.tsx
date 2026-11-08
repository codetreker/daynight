import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useGraphDirection } from '../src/features/projects/useProjectViewPreferences';

const key = (project: string, root: string) => `daynight:graph-direction:${JSON.stringify([project, root])}`;

describe('graph direction preferences', () => {
  it('defaults to horizontal and restores each project and goal independently', () => {
    const { result, rerender, unmount } = renderHook(({ project, root }) => useGraphDirection(project, root), {
      initialProps: { project: 'project-a', root: 'goal-a' },
    });
    expect(result.current.direction).toBe('horizontal');
    expect(window.localStorage.length).toBe(0);
    act(() => result.current.onDirectionChange('vertical'));
    expect(window.localStorage.getItem(key('project-a', 'goal-a'))).toBe('"vertical"');
    rerender({ project: 'project-a', root: 'goal-b' });
    expect(result.current.direction).toBe('horizontal');
    rerender({ project: 'project-b', root: 'goal-a' });
    expect(result.current.direction).toBe('horizontal');
    rerender({ project: 'project-a', root: 'goal-a' });
    expect(result.current.direction).toBe('vertical');
    act(() => result.current.onDirectionChange('horizontal'));
    unmount();
    const reopened = renderHook(() => useGraphDirection('project-a', 'goal-a'));
    expect(reopened.result.current.direction).toBe('horizontal');
    expect(window.localStorage.getItem(key('project-a', 'goal-a'))).toBe('"horizontal"');
  });

  it('keeps identifiers containing delimiters distinct', () => {
    const { result, rerender } = renderHook(({ project, root }) => useGraphDirection(project, root), {
      initialProps: { project: 'a:b', root: 'c' },
    });
    act(() => result.current.onDirectionChange('vertical'));
    rerender({ project: 'a', root: 'b:c' });
    expect(result.current.direction).toBe('horizontal');
  });

  it.each(['invalid JSON', '"diagonal"', 'null', 'true'])('reports invalid stored value %s and uses horizontal', (saved) => {
    window.localStorage.setItem(key('p', 'g'), saved);
    const { result } = renderHook(() => useGraphDirection('p', 'g'));
    expect(result.current.direction).toBe('horizontal');
    expect(result.current.issue?.kind).toBe('invalid');
    act(() => result.current.onDirectionChange('vertical'));
    expect(result.current.direction).toBe('vertical');
    expect(window.localStorage.getItem(key('p', 'g'))).toBe('"vertical"');
  });

  it('reports read failures while allowing the current graph to change', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('read'); });
    const { result } = renderHook(() => useGraphDirection('p', 'g'));
    expect(result.current.direction).toBe('horizontal');
    expect(result.current.issue?.kind).toBe('read');
    act(() => result.current.onDirectionChange('vertical'));
    expect(result.current.direction).toBe('vertical');
    expect(result.current.issue?.kind).toBe('read');
  });

  it('reports write failures while changing the current graph and clears them after a successful write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('write'); });
    const { result } = renderHook(() => useGraphDirection('p', 'g'));
    act(() => result.current.onDirectionChange('vertical'));
    expect(result.current.direction).toBe('vertical');
    expect(result.current.issue?.kind).toBe('write');
    act(() => result.current.onDirectionChange('horizontal'));
    expect(result.current.direction).toBe('horizontal');
    expect(result.current.issue).toBeNull();
    expect(setItem).toHaveBeenCalledTimes(2);
  });
});
