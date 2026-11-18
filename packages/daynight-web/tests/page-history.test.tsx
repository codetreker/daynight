import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/app/navigation';
import { emptyMyTasksReading, emptyResourceReading, myTasksHistory, projectHistory, readMyTasksHistory, readProjectHistory, readResourceHistory, readWorkerHistory, resourceHistory, workerHistory, type MyTasksReading, type ProjectReading, type ResourcePageReading } from '../src/app/page-history';
import { useMyTasksHistory, useProjectHistory, useResourceHistory, useWorkerHistory } from '../src/app/use-page-history';
import { createTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';

const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const arrival = (state: unknown, path = '/account') => act(() => {
  history.replaceState(state, '', path);
  dispatchEvent(new PopStateEvent('popstate', { state }));
});

describe('standalone resource reading history', () => {
  const project = '10000000-0000-4000-8000-000000000001';
  const root = '20000000-0000-4000-8000-000000000001';
  const child = '20000000-0000-4000-8000-000000000002';
  const path = `/projects/${project}/tasks/${root}`;
  const selection: ResourcePageReading = {
    goalChildren: { graphRootId: child, task: { id: child, navigation: { tab: 'attachments', path: 'docs/notes.md' } } },
    externalGoal: { id: root, witness: child, navigation: { tab: 'overview', path: null }, goalChildren: null },
  };

  it('validates the matching resource selection and isolates identities and page keys', () => {
    const state = resourceHistory(user, project, root, selection);
    expect(readResourceHistory(undefined, user, project, root)).toBeNull();
    expect(readResourceHistory(state, user, project, root)).toEqual(selection);
    expect(readResourceHistory(state, other, project, root)).toBeNull();
    expect(readResourceHistory(state, user, project, child)).toBeNull();
    expect(readResourceHistory(workerHistory(user, '00000000-0000-4000-8000-000000000011', 'configuration'), user, project, root)).toBeNull();
    for (const bad of [
      { ...state, selection: { ...selection, draft: 'secret' } },
      { ...state, selection: { ...selection, goalChildren: { ...selection.goalChildren, graphRootId: 'bad' } } },
      { ...state, selection: { ...selection, goalChildren: { graphRootId: null, task: { id: child, navigation: { tab: 'bad', path: null } } } } },
      { ...state, selection: { ...selection, goalChildren: { graphRootId: null, task: { id: child, navigation: { tab: 'attachments', path: '../secret' } } } } },
      { ...state, selection: { ...selection, externalGoal: { ...selection.externalGoal, witness: 'bad' } } },
    ]) expect(() => readResourceHistory(bad, user, project, root)).toThrow('Invalid resource navigation state.');
  });

  it('restores a description selection on an external Goal', () => {
    const description = { ...selection, externalGoal: { ...selection.externalGoal!, navigation: { tab: 'description', path: null } } } as const;
    const state = resourceHistory(user, project, root, description);
    expect(readResourceHistory(state, user, project, root)).toEqual(description);
  });

  it('initializes URL entries before pushing nested selections and restores the source', () => {
    history.replaceState(null, '', path);
    const navigation = browserNavigation();
    const { result } = renderHook(() => useResourceHistory(user, project, root, true));
    expect(navigation.snapshot().view).toEqual(resourceHistory(user, project, root, emptyResourceReading()));
    act(() => navigation.navigate(`${path}?tab=discussion`));
    const source = history.state;
    expect(navigation.snapshot().view).toEqual(resourceHistory(user, project, root, emptyResourceReading()));
    const length = history.length;
    act(() => result.current.select(selection));
    expect(history.length).toBe(length + 1);
    const nested = history.state;
    act(() => result.current.select(selection));
    expect(history.length).toBe(length + 1);
    arrival(source, `${path}?tab=discussion`);
    expect(result.current.selection).toEqual(emptyResourceReading());
    arrival(nested, `${path}?tab=discussion`);
    expect(result.current.selection).toEqual(selection);
  });

  it('isolates retained native selections and refuses malformed matching payloads', () => {
    history.replaceState(null, '', path);
    const navigation = browserNavigation();
    const { result, rerender } = renderHook(({ identity }) => useResourceHistory(identity, project, root, true), { initialProps: { identity: user } });
    act(() => result.current.select(selection));
    act(() => { history.pushState({ foreign: true }, '', `${path}#native`); dispatchEvent(new PopStateEvent('popstate')); });
    expect(result.current.selection).toEqual(selection);
    expect(navigation.snapshot().entryId).toBeNull();
    rerender({ identity: other });
    expect(result.current.selection).toEqual(emptyResourceReading());
    expect(history.state).toEqual({ foreign: true });
    act(() => navigation.navigate(path));
    const state = { ...history.state, __daynightNavigation: { ...history.state.__daynightNavigation, view: { ...resourceHistory(other, project, root, emptyResourceReading()), selection: { goalChildren: 'bad', externalGoal: null } } } };
    arrival(state, path);
    expect(result.current.error).toBe(true);
    act(() => result.current.select(selection));
    expect(history.state).toEqual(state);
  });

  it('retains nested readers on same-resource URL changes but resets on a new visit', () => {
    history.replaceState(null, '', path);
    const navigation = browserNavigation();
    const { result } = renderHook(() => useResourceHistory(user, project, root, true));
    act(() => result.current.select(selection));
    act(() => navigation.navigate(`${path}?tab=discussion`));
    expect(result.current.selection).toEqual(selection);
    expect(navigation.snapshot().view).toEqual(resourceHistory(user, project, root, selection));
    act(() => navigation.navigate('/projects'));
    act(() => navigation.navigate(path));
    expect(result.current.selection).toEqual(emptyResourceReading());
    expect(navigation.snapshot().view).toEqual(resourceHistory(user, project, root, emptyResourceReading()));
  });

  it('does not requalify old entries after project access is retired', () => {
    history.replaceState(null, '', path);
    const navigation = browserNavigation();
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useResourceHistory(user, project, root, true, scope));
      act(() => result.current.select(selection));
      const old = history.state;
      act(() => result.current.select({ ...selection, externalGoal: null }));
      act(() => scope.suspendProject(project));
      expect(result.current.selection).toEqual(emptyResourceReading());
      act(() => result.current.select(selection));
      expect(result.current.selection).toEqual(selection);
      arrival(old, path);
      expect(result.current.selection).toEqual(emptyResourceReading());
      expect(navigation.snapshot().view).toEqual(resourceHistory(user, project, root, emptyResourceReading()));
      unmount();
    } finally { scope.dispose(); }
  });
});

beforeEach(() => { history.replaceState(null, '', '/account'); });
afterEach(() => { cleanup(); browserNavigation().dispose(); vi.restoreAllMocks(); });

describe('personal overview reading history', () => {
  const project = '10000000-0000-4000-8000-000000000001';
  const root = '20000000-0000-4000-8000-000000000001';
  const child = '20000000-0000-4000-8000-000000000002';
  const selection: MyTasksReading = { projectPages: { [project]: 2 }, detail: { projectId: project, id: root,
    navigation: { tab: 'attachments', path: 'docs/readme.md' },
    goalChildren: { graphRootId: child, task: { id: child, navigation: { tab: 'session', path: null } } } } };

  it('accepts only identity-bound positions and rejects malformed or private data', () => {
    const state = myTasksHistory(user, selection);
    expect(readMyTasksHistory(state, user)).toEqual(selection);
    expect(readMyTasksHistory(state, other)).toBeNull();
    expect(readMyTasksHistory(workerHistory(user, '00000000-0000-4000-8000-000000000011', 'overview'), user)).toBeNull();
    for (const bad of [
      { ...selection, draft: 'secret' }, { ...selection, projectPages: { [project]: 0 } },
      { ...selection, projectPages: { bad: 2 } }, { ...selection, projectPages: { [project]: 1.5 } },
      { ...selection, detail: { ...selection.detail, snapshot: {} } },
      { ...selection, detail: { ...selection.detail, navigation: { tab: 'attachments', path: '../private' } } },
    ]) expect(() => readMyTasksHistory({ ...state, selection: bad }, user)).toThrow('Invalid my-tasks navigation state.');
  });

  it('restores history and prevents retired project entries from restoring readers', () => {
    history.replaceState(null, '', '/my-tasks');
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useMyTasksHistory(user, true, scope));
      expect(result.current.selection).toEqual(emptyMyTasksReading());
      act(() => result.current.select(selection));
      const saved = history.state;
      act(() => result.current.select({ ...selection, detail: null }));
      arrival(saved, '/my-tasks');
      expect(result.current.selection).toEqual(selection);
      act(() => scope.suspendProject(project));
      expect(result.current.selection).toEqual({ ...selection, detail: null });
      arrival(saved, '/my-tasks');
      expect(result.current.selection).toEqual({ ...selection, detail: null });
      unmount();
    } finally { scope.dispose(); }
  });

  it('accepts a restored entry under the same identity and refuses another identity', () => {
    history.replaceState(null, '', '/my-tasks');
    const navigation = browserNavigation();
    act(() => navigation.setView(myTasksHistory(user, selection), { replace: true }));
    navigation.dispose();
    const rebuilt = browserNavigation();
    expect(rebuilt.snapshot().view).toEqual(myTasksHistory(user, selection));
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useMyTasksHistory(user, true, scope));
      expect(result.current.selection).toEqual(selection);
      unmount();
    } finally { scope.dispose(); }
    const otherScope = createTaskCacheScope({ userId: other, onIdentityMismatch: vi.fn() });
    try {
      const { result } = renderHook(() => useMyTasksHistory(other, true, otherScope));
      expect(result.current.selection).toEqual(emptyMyTasksReading());
    } finally { otherScope.dispose(); }
  });

  it('does not requalify a rebuilt entry after observed project retirement', () => {
    history.replaceState(null, '', '/my-tasks');
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useMyTasksHistory(user, true, scope));
      act(() => result.current.select(selection));
      const old = history.state;
      act(() => scope.suspendProject(project));
      unmount();
      browserNavigation().dispose();
      history.replaceState(old, '', '/my-tasks');
      const restored = renderHook(() => useMyTasksHistory(user, true, scope));
      expect(restored.result.current.selection).toEqual({ ...selection, detail: null });
      restored.unmount();
    } finally { scope.dispose(); }
  });
});

describe('Project reading history', () => {
  const project = '10000000-0000-4000-8000-000000000001';
  const root = '20000000-0000-4000-8000-000000000001';
  const child = '20000000-0000-4000-8000-000000000002';
  const path = `/projects/${project}`;
  const defaults = { section: 'overview', view: 'chains' } as const;
  const selection: ProjectReading = { section: 'tasks', view: 'chains', projectGraphWitness: root,
    detail: { id: root, source: 'summary', insideProjectGraph: true, navigation: { tab: 'overview', path: null },
      goalChildren: { graphRootId: child, task: { id: child, navigation: { tab: 'attachments', path: 'docs/readme.md' } } } } };

  it('validates matching selections and isolates identity and project', () => {
    const state = projectHistory(user, project, selection);
    expect(readProjectHistory(state, user, project)).toEqual(selection);
    const tags = { ...selection, section: 'tags', projectGraphWitness: null, detail: null } as const;
    expect(readProjectHistory(projectHistory(user, project, tags), user, project)).toEqual(tags);
    expect(readProjectHistory(state, other, project)).toBeNull();
    expect(readProjectHistory(state, user, root)).toBeNull();
    const prs = { ...selection, section: 'prs', projectGraphWitness: null, detail: null } as const;
    expect(readProjectHistory(projectHistory(user, project, prs), user, project)).toEqual(prs);
    for (const bad of [
      { ...selection, view: 'invalid' }, { ...selection, projectGraphWitness: 'bad' },
      { ...selection, detail: { ...selection.detail, revision: 1 } },
      { ...selection, detail: { ...selection.detail, insideProjectGraph: 'yes' } },
      { ...selection, detail: { ...selection.detail, goalChildren: { graphRootId: null, task: { id: child, navigation: { tab: 'attachments', path: '../secret' } } } } },
    ]) expect(() => readProjectHistory({ ...state, selection: bad }, user, project)).toThrow('Invalid project navigation state.');
  });

  it('restores a Goal description selection in project history', () => {
    const description = { ...selection, detail: { ...selection.detail!, navigation: { tab: 'description', path: null } } } as const;
    expect(readProjectHistory(projectHistory(user, project, description), user, project)).toEqual(description);
  });

  it.each(['overview', 'tasks', 'prs', 'tags'] as const)('uses explicit %s over the preferred section on first render', section => {
    history.replaceState(null, '', `${path}?other=retained&tab=${section}`);
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    const renders: string[] = [];
    try {
      const length = history.length;
      const { result, unmount } = renderHook(() => {
        const history = useProjectHistory(user, project, true, { section: 'tags', view: 'chains' }, scope);
        renders.push(history.selection.section); return history;
      });
      expect(renders.every(value => value === section)).toBe(true);
      expect(result.current.selection).toEqual({ section, view: 'chains', projectGraphWitness: null, detail: null });
      expect(location.search).toBe(`?other=retained&tab=${section}`);
      expect(history.length).toBe(length);
      unmount();
    } finally { scope.dispose(); }
  });

  it('normalizes a bare URL with the admitted same-document reading and preserves pending fragment and query', () => {
    history.replaceState(null, '', `${path}?tab=tasks`);
    const navigation = browserNavigation();
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const first = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      act(() => first.result.current.select(selection));
      first.unmount();
      act(() => navigation.setView(projectHistory(user, project, selection), { to: `${path}?other=retained#chain=${root}`, replace: true }));
      const length = history.length, entryId = navigation.snapshot().entryId;
      const replace = vi.spyOn(history, 'replaceState');
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      expect(result.current.selection).toEqual(selection);
      expect(location.search).toBe('?other=retained&tab=tasks');
      expect(location.hash).toBe(`#chain=${root}`);
      expect(navigation.snapshot().entryId).toBe(entryId);
      expect(history.length).toBe(length);
      expect(replace).toHaveBeenCalledOnce();
      unmount();
    } finally { scope.dispose(); }
  });

  it('takes explicit URL over conflicting reading, retaining a matching reading but dropping incompatible nested resources', () => {
    history.replaceState(null, '', `${path}?tab=tasks`);
    const navigation = browserNavigation();
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      act(() => result.current.select(selection));
      expect(result.current.selection).toEqual(selection);
      const length = history.length;
      act(() => navigation.setView(projectHistory(user, project, selection), { to: `${path}?tab=prs`, replace: true }));
      const expected = { ...defaults, section: 'prs', projectGraphWitness: null, detail: null } as const;
      expect(result.current.selection).toEqual(expected);
      expect(navigation.snapshot().view).toEqual(projectHistory(user, project, expected));
      expect(history.length).toBe(length);
      unmount();
    } finally { scope.dispose(); }
  });

  it('keeps URL and reading unchanged when a draft blocks a section change and commits both after confirmation', () => {
    history.replaceState(null, '', `${path}?tab=tasks`);
    const navigation = browserNavigation();
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      const before = navigation.snapshot(), length = history.length, commit = vi.fn(), discard = vi.fn();
      const release = navigation.register({ scope: { identity: {}, projectId: project, taskId: root }, isDirty: () => true, discard, survives: () => false });
      const next = { ...result.current.selection, section: 'prs' } as const;
      act(() => result.current.select(next, false, commit));
      expect(navigation.snapshot()).toBe(before);
      expect(location.search).toBe('?tab=tasks');
      act(() => navigation.cancel());
      expect(history.length).toBe(length); expect(commit).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
      act(() => result.current.select(next, false, commit));
      act(() => navigation.confirm());
      expect(location.search).toBe('?tab=prs'); expect(result.current.selection).toEqual(next);
      expect(navigation.snapshot().view).toEqual(projectHistory(user, project, next));
      expect(history.length).toBe(length + 1); expect(commit).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledOnce();
      release(); unmount();
    } finally { scope.dispose(); }
  });

  it('consumes an unindexed native fragment without numbering it or retiring earlier application entries', () => {
    history.replaceState(null, '', `${path}?tab=prs`);
    const navigation = browserNavigation();
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      const old = history.state, oldId = navigation.snapshot().entryId;
      act(() => { history.pushState({ foreign: { offset: 7 }, __daynightNavigation: old.__daynightNavigation }, '', `${path}?tab=prs#chain=${root}`); dispatchEvent(new PopStateEvent('popstate')); });
      expect(navigation.snapshot().entryId).toBeNull();
      const length = history.length, before = navigation.snapshot(), committed = vi.fn(), discard = vi.fn();
      const release = navigation.register({ scope: { identity: {}, projectId: project, taskId: root }, isDirty: () => true, discard, survives: () => false });
      const next = { ...selection, detail: null };
      const replace = vi.spyOn(history, 'replaceState');
      act(() => result.current.select(next, false, committed, true));
      expect(navigation.snapshot()).toBe(before); expect(location.hash).toBe(`#chain=${root}`);
      act(() => navigation.cancel());
      expect(replace).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
      act(() => result.current.select(next, false, committed, true));
      act(() => navigation.confirm());
      expect(replace).toHaveBeenCalledOnce(); expect(history.length).toBe(length);
      expect(location.search).toBe('?tab=tasks'); expect(location.hash).toBe('');
      expect(history.state).toEqual({ foreign: { offset: 7 } });
      expect(navigation.snapshot()).toMatchObject({ entryId: null, view: projectHistory(user, project, next) });
      expect(result.current.selection).toEqual(next);
      expect(discard).toHaveBeenCalledOnce(); expect(committed).toHaveBeenCalledOnce();
      release();
      arrival(old, `${path}?tab=prs`);
      expect(navigation.snapshot().entryId).toBe(oldId);
      expect(result.current.selection.section).toBe('prs');
      unmount();
    } finally { scope.dispose(); }
  });

  it('consumes a native chain query only after the draft decision and preserves unrelated state', () => {
    history.replaceState(null, '', `${path}?tab=tasks&other=kept&chain=${root}#task=${root}`);
    const navigation = browserNavigation();
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      act(() => { history.pushState({ foreign: true }, '', `${path}?tab=tasks&other=kept&chain=${root}#task=${root}`); dispatchEvent(new PopStateEvent('popstate')); });
      const length = history.length, discard = vi.fn(), commit = vi.fn();
      const release = navigation.register({ scope: { identity: {}, projectId: project, taskId: root }, isDirty: () => true, discard, survives: () => false });
      const next = { ...selection, detail: null };
      act(() => result.current.select(next, false, commit, 'chain'));
      expect(location.search).toContain(`chain=${root}`); expect(commit).not.toHaveBeenCalled();
      act(() => navigation.confirm());
      expect(location.search).toBe('?tab=tasks&other=kept'); expect(location.hash).toBe('');
      expect(history.length).toBe(length); expect(history.state).toEqual({ foreign: true });
      expect(navigation.snapshot()).toMatchObject({ entryId: null, view: projectHistory(user, project, next) });
      expect(discard).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledOnce();
      release(); unmount();
    } finally { scope.dispose(); }
  });

  it.each(['history', 'access'] as const)('never revives a native fragment reading after %s retirement and rerender', kind => {
    history.replaceState(null, '', `${path}?tab=prs`);
    const navigation = browserNavigation();
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    const subscribe = scope.subscribe.bind(scope);
    const listeners = new Set<Parameters<typeof scope.subscribe>[0]>();
    vi.spyOn(scope, 'subscribe').mockImplementation(listener => { listeners.add(listener); const stop = subscribe(listener); return () => { listeners.delete(listener); stop(); }; });
    try {
      const { result, rerender, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      act(() => { history.pushState({ foreign: true }, '', `${path}?tab=prs#chain=${root}`); dispatchEvent(new PopStateEvent('popstate')); });
      act(() => result.current.select(selection, false, undefined, true));
      expect(result.current.selection).toEqual(selection);
      act(() => {
        if (kind === 'access') scope.suspendProject(project);
        else for (const listener of listeners) listener({ projectId: project, historyChanged: true });
      });
      expect(result.current.selection).toEqual({ ...defaults, section: 'tasks', projectGraphWitness: null, detail: null });
      rerender(); rerender();
      expect(result.current.selection).toEqual({ ...defaults, section: 'tasks', projectGraphWitness: null, detail: null });
      unmount();
    } finally { scope.dispose(); }
  });

  it('initializes, traverses and deduplicates without replaying commit callbacks', () => {
    history.replaceState(null, '', path);
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    try {
      const navigation = browserNavigation(), length = history.length, committed = vi.fn();
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope));
      const initial = result.current.selection;
      expect(navigation.snapshot().view).toEqual(projectHistory(user, project, initial));
      const source = history.state;
      act(() => result.current.select(selection, false, committed));
      const destination = history.state;
      expect(history.length).toBe(length + 1);
      expect(committed).toHaveBeenCalledTimes(1);
      act(() => result.current.select(selection, false, committed));
      expect(history.length).toBe(length + 1);
      arrival(source, `${path}?tab=overview`); expect(result.current.selection).toEqual(initial);
      arrival(destination, `${path}?tab=tasks`); expect(result.current.selection).toEqual(selection);
      expect(committed).toHaveBeenCalledTimes(1);
      const tags = { ...selection, section: 'tags', projectGraphWitness: null, detail: null } as const;
      act(() => result.current.select(tags));
      const tagsDestination = history.state;
      arrival(destination, `${path}?tab=tasks`); expect(result.current.selection).toEqual(selection);
      arrival(tagsDestination, `${path}?tab=tags`); expect(result.current.selection).toEqual(tags);
      act(() => result.current.select({ ...selection, detail: null }));
      act(() => scope.suspendProject(project));
      expect(result.current.selection.detail).toBeNull();
      arrival(destination, `${path}?tab=tasks`); expect(result.current.selection.detail).toBeNull();
      unmount();
    } finally { scope.dispose(); }
  });

  it('carries only the currently displayed Goal through content retirement on the same render', () => {
    history.replaceState(null, '', path);
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    const subscribe = scope.subscribe.bind(scope);
    const listeners = new Set<Parameters<typeof scope.subscribe>[0]>();
    vi.spyOn(scope, 'subscribe').mockImplementation(listener => { listeners.add(listener); const stop = subscribe(listener); return () => { listeners.delete(listener); stop(); }; });
    const retire = () => { for (const listener of listeners) listener({ projectId: project, historyChanged: true }); };
    const goal = { ...selection, view: 'goals' } as const;
    const carried = { ...goal, detail: null };
    const renders: ProjectReading[] = [];
    try {
      const { result, unmount } = renderHook(() => {
        const value = useProjectHistory(user, project, true, defaults, scope, id => id === root);
        renders.push(value.selection); return value;
      });
      act(() => result.current.select(goal));
      const old = history.state;
      act(() => result.current.select({ ...goal, detail: { ...goal.detail!, id: child } }));
      const start = renders.length;
      act(retire);
      expect(renders.slice(start)).not.toHaveLength(0);
      expect(renders.slice(start).every(value => value.projectGraphWitness === root && value.detail === null)).toBe(true);
      expect(result.current.selection).toEqual(carried);
      expect(browserNavigation().snapshot().view).toEqual(projectHistory(user, project, carried));
      arrival(old, `${path}?tab=tasks`);
      expect(result.current.selection).toEqual({ ...defaults, section: 'tasks', projectGraphWitness: null, detail: null });
      unmount();
    } finally { scope.dispose(); }
  });

  it.each(['access-first', 'history-first', 'combined'])('never carries a Goal across access retirement (%s)', order => {
    history.replaceState(null, '', path);
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    const subscribe = scope.subscribe.bind(scope);
    const listeners = new Set<Parameters<typeof scope.subscribe>[0]>();
    vi.spyOn(scope, 'subscribe').mockImplementation(listener => { listeners.add(listener); const stop = subscribe(listener); return () => { listeners.delete(listener); stop(); }; });
    const emit = (event: Parameters<Parameters<typeof scope.subscribe>[0]>[0]) => { for (const listener of listeners) listener(event); };
    try {
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope, id => id === root));
      act(() => result.current.select({ ...selection, view: 'goals' }));
      act(() => {
        if (order === 'combined') emit({ projectId: project, accessRevoked: true, historyChanged: true });
        else if (order === 'access-first') { scope.suspendProject(project); emit({ projectId: project, historyChanged: true }); }
        else { emit({ projectId: project, historyChanged: true }); scope.suspendProject(project); }
      });
      expect(result.current.selection).toEqual({ ...defaults, section: 'tasks', projectGraphWitness: null, detail: null });
      unmount();
    } finally { scope.dispose(); }
  });

  it('respects a same-entry close and later admitted navigation during retirement', () => {
    history.replaceState(null, '', path);
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    const subscribe = scope.subscribe.bind(scope);
    const listeners = new Set<Parameters<typeof scope.subscribe>[0]>();
    vi.spyOn(scope, 'subscribe').mockImplementation(listener => { listeners.add(listener); const stop = subscribe(listener); return () => { listeners.delete(listener); stop(); }; });
    const retire = () => { for (const listener of listeners) listener({ projectId: project, historyChanged: true }); };
    const goal = { ...selection, view: 'goals', detail: null } as const;
    try {
      const { result, unmount } = renderHook(() => useProjectHistory(user, project, true, defaults, scope, id => id === root));
      act(() => result.current.select(goal));
      act(() => { result.current.select({ ...goal, projectGraphWitness: null }, true); retire(); });
      expect(result.current.selection.projectGraphWitness).toBeNull();
      act(() => result.current.select(goal));
      act(retire);
      expect(result.current.selection).toEqual(goal);
      act(() => result.current.select({ ...goal, section: 'overview', projectGraphWitness: null }));
      expect(result.current.selection.section).toBe('overview');
      act(retire);
      expect(result.current.selection.projectGraphWitness).toBeNull();
      unmount();
    } finally { scope.dispose(); }
  });

  it('does not carry an undisplayed Goal or across a scope or identity change', () => {
    history.replaceState(null, '', path);
    const scope = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    const replacement = createTaskCacheScope({ userId: user, onIdentityMismatch: vi.fn() });
    const subscribe = scope.subscribe.bind(scope);
    const listeners = new Set<Parameters<typeof scope.subscribe>[0]>();
    vi.spyOn(scope, 'subscribe').mockImplementation(listener => { listeners.add(listener); const stop = subscribe(listener); return () => { listeners.delete(listener); stop(); }; });
    try {
      const { result, rerender, unmount } = renderHook(({ cache, identity, displayed }) => useProjectHistory(identity, project, true, defaults, cache, () => displayed),
        { initialProps: { cache: scope, identity: user, displayed: false } });
      act(() => result.current.select({ ...selection, view: 'goals' }));
      act(() => { for (const listener of listeners) listener({ projectId: project, historyChanged: true }); });
      expect(result.current.selection.projectGraphWitness).toBeNull();
      rerender({ cache: scope, identity: user, displayed: true });
      act(() => result.current.select({ ...selection, view: 'goals' }));
      rerender({ cache: replacement, identity: user, displayed: true });
      expect(result.current.selection.projectGraphWitness).toBeNull();
      rerender({ cache: replacement, identity: other, displayed: true });
      expect(result.current.selection.projectGraphWitness).toBeNull();
      unmount();
    } finally { scope.dispose(); replacement.dispose(); }
  });
});

describe('Worker reading history', () => {
  const worker = '00000000-0000-4000-8000-000000000011';
  const otherWorker = '00000000-0000-4000-8000-000000000012';
  const path = `/workers/${worker}`;
  it('validates the current Worker selection and isolates identity and resource', () => {
    expect(readWorkerHistory(workerHistory(user, worker, 'system'), user, worker)).toBe('system');
    expect(readWorkerHistory(workerHistory(user, worker, 'configuration'), user, worker)).toBe('configuration');
    expect(readWorkerHistory(workerHistory(user, worker, 'prompt'), user, worker)).toBe('prompt');
    expect(readWorkerHistory(workerHistory(other, worker, 'configuration'), user, worker)).toBeNull();
    expect(readWorkerHistory(workerHistory(user, otherWorker, 'configuration'), user, worker)).toBeNull();
    for (const selection of [{ workerId: otherWorker, section: 'overview' }, { workerId: worker, section: 'bad' }, { workerId: worker, section: 'overview', draft: 'secret' }]) {
      expect(() => readWorkerHistory({ ...workerHistory(user, worker, 'overview'), selection }, user, worker)).toThrow();
    }
  });
  it('opens a directly restored prompt selection', () => {
    const navigation = browserNavigation();
    act(() => navigation.navigate(path, false, workerHistory(user, worker, 'prompt')));
    const { result } = renderHook(() => useWorkerHistory(user, worker, true));
    expect(result.current.section).toBe('prompt');
    expect(result.current.error).toBe(false);
  });
  it('initializes, traverses and deduplicates while inactive owners cannot overwrite another page', () => {
    history.replaceState(null, '', path);
    const navigation = browserNavigation(), length = history.length;
    const { result, rerender } = renderHook(({ identity, active }) => useWorkerHistory(identity, worker, active), { initialProps: { identity: user, active: true } });
    expect(navigation.snapshot().view).toEqual(workerHistory(user, worker, 'overview'));
    const overview = history.state;
    act(() => result.current.select('system'));
    const system = history.state;
    expect(result.current.section).toBe('system');
    act(() => result.current.select('system'));
    expect(history.length).toBe(length + 1);
    act(() => result.current.select('configuration'));
    const configuration = history.state;
    expect(result.current.section).toBe('configuration');
    act(() => result.current.select('configuration'));
    expect(history.length).toBe(length + 2);
    act(() => result.current.select('prompt'));
    const prompt = history.state;
    expect(result.current.section).toBe('prompt');
    act(() => result.current.select('prompt'));
    expect(history.length).toBe(length + 3);
    arrival(configuration, path); expect(result.current.section).toBe('configuration');
    arrival(system, path); expect(result.current.section).toBe('system');
    arrival(overview, path); expect(result.current.section).toBe('overview');
    arrival(configuration, path); expect(result.current.section).toBe('configuration');
    arrival(prompt, path); expect(result.current.section).toBe('prompt');
    rerender({ identity: user, active: false });
    act(() => navigation.navigate('/account', false, workerHistory(user, '00000000-0000-4000-8000-000000000011', 'configuration')));
    act(() => result.current.select('overview'));
    expect(navigation.snapshot().view).toEqual(workerHistory(user, '00000000-0000-4000-8000-000000000011', 'configuration'));
    rerender({ identity: other, active: true });
    act(() => navigation.navigate(path, false, workerHistory(user, worker, 'configuration')));
    expect(result.current.section).toBe('overview');
    expect(navigation.snapshot().view).toEqual(workerHistory(other, worker, 'overview'));
  });
  it('retains a native selection without writing and exposes invalid current state', () => {
    history.replaceState(null, '', path);
    const navigation = browserNavigation();
    const { result } = renderHook(() => useWorkerHistory(user, worker, true));
    act(() => result.current.select('configuration'));
    const state = history.state;
    act(() => { history.pushState({ foreign: true }, '', `${path}#native`); dispatchEvent(new PopStateEvent('popstate')); });
    expect(result.current.section).toBe('configuration'); expect(history.state).toEqual({ foreign: true });
    const bad = { ...state, __daynightNavigation: { ...state.__daynightNavigation, view: { ...workerHistory(user, worker, 'configuration'), selection: { workerId: worker, section: 'invalid' } } } };
    arrival(bad, path); expect(result.current.error).toBe(true);
    act(() => result.current.select('overview')); expect(navigation.snapshot().view).toEqual(bad.__daynightNavigation.view);
  });
});
