import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/app/navigation';
import { accountHistory, emptyMyTasksReading, emptyResourceReading, myTasksHistory, projectHistory, readAccountHistory, readMyTasksHistory, readProjectHistory, readResourceHistory, readWorkerHistory, resourceHistory, workerHistory, type MyTasksReading, type ProjectReading, type ResourcePageReading } from '../src/app/page-history';
import { useAccountHistory, useMyTasksHistory, useProjectHistory, useResourceHistory, useWorkerHistory } from '../src/app/use-page-history';
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
    expect(readResourceHistory(accountHistory(user, 'tokens'), user, project, root)).toBeNull();
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
    expect(readMyTasksHistory(accountHistory(user, 'profile'), user)).toBeNull();
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
      arrival(source, path); expect(result.current.selection).toEqual(initial);
      arrival(destination, path); expect(result.current.selection).toEqual(selection);
      expect(committed).toHaveBeenCalledTimes(1);
      const tags = { ...selection, section: 'tags', projectGraphWitness: null, detail: null } as const;
      act(() => result.current.select(tags));
      const tagsDestination = history.state;
      arrival(destination, path); expect(result.current.selection).toEqual(selection);
      arrival(tagsDestination, path); expect(result.current.selection).toEqual(tags);
      act(() => result.current.select({ ...selection, detail: null }));
      act(() => scope.suspendProject(project));
      expect(result.current.selection.detail).toBeNull();
      arrival(destination, path); expect(result.current.selection.detail).toBeNull();
      unmount();
    } finally { scope.dispose(); }
  });
});

describe('account reading history', () => {
  it('validates recognized state and isolates account and page scope', () => {
    expect(readAccountHistory(undefined, user)).toBeNull();
    expect(readAccountHistory(accountHistory(user, 'tokens'), user)).toBe('tokens');
    expect(readAccountHistory(accountHistory(other, 'prompt'), user)).toBeNull();
    expect(readAccountHistory({ ...accountHistory(user, 'prompt'), pageKey: 'worker' }, user)).toBeNull();
    for (const bad of [null, {}, { ...accountHistory(user, 'tokens'), version: 2 },
      { ...accountHistory(user, 'tokens'), userId: 'invalid' },
      { ...accountHistory(user, 'tokens'), selection: { tab: 'unknown' } },
      { ...accountHistory(user, 'tokens'), selection: { tab: 'tokens', draft: 'secret' } }]) {
      expect(() => readAccountHistory(bad, user)).toThrow();
    }
  });

  it('initializes each controlled visit and restores same-URL selections without duplicate entries', () => {
    const navigation = browserNavigation(), length = history.length;
    const { result } = renderHook(() => useAccountHistory(user, true));
    expect(result.current.tab).toBe('profile');
    expect(navigation.snapshot().view).toEqual(accountHistory(user, 'profile'));
    expect(history.length).toBe(length);
    const profile = history.state;
    act(() => result.current.select('tokens'));
    const tokens = history.state;
    expect(result.current.tab).toBe('tokens');
    expect(history.length).toBe(length + 1);
    act(() => result.current.select('tokens'));
    expect(history.length).toBe(length + 1);
    arrival(profile);
    expect(result.current.tab).toBe('profile');
    arrival(tokens);
    expect(result.current.tab).toBe('tokens');
    act(() => navigation.navigate('/projects'));
    act(() => navigation.navigate('/account'));
    expect(result.current.tab).toBe('profile');
    expect(navigation.snapshot().view).toEqual(accountHistory(user, 'profile'));
  });

  it('keeps hidden owners from reading or overwriting another page or identity', () => {
    const navigation = browserNavigation();
    const { result, rerender } = renderHook(({ active, identity }) => useAccountHistory(identity, active), { initialProps: { active: true, identity: user } });
    act(() => result.current.select('prompt'));
    rerender({ active: false, identity: user });
    act(() => navigation.navigate('/projects', false, accountHistory(other, 'tokens')));
    const foreign = navigation.snapshot().view;
    act(() => result.current.select('profile'));
    expect(result.current.tab).toBe('prompt');
    expect(navigation.snapshot().view).toEqual(foreign);
    rerender({ active: true, identity: user });
    expect(navigation.snapshot().view).toEqual(foreign);
    act(() => navigation.navigate('/account', false, accountHistory(other, 'tokens')));
    expect(result.current.tab).toBe('profile');
    expect(navigation.snapshot().view).toEqual(accountHistory(user, 'profile'));
  });

  it('keeps the selection on a native unnumbered same-page entry without writing it', () => {
    const navigation = browserNavigation();
    const { result } = renderHook(() => useAccountHistory(user, true));
    act(() => result.current.select('prompt'));
    const replace = vi.spyOn(history, 'replaceState');
    act(() => { history.pushState({ foreign: true }, '', '/account#native'); dispatchEvent(new PopStateEvent('popstate')); });
    expect(result.current.tab).toBe('prompt');
    expect(navigation.snapshot().entryId).toBeNull();
    expect(history.state).toEqual({ foreign: true });
    expect(replace).not.toHaveBeenCalled();
  });

  it('resets the retained selection when the authenticated identity changes on a native entry', () => {
    const { result, rerender } = renderHook(({ identity }) => useAccountHistory(identity, true), { initialProps: { identity: user } });
    act(() => result.current.select('prompt'));
    act(() => { history.pushState(null, '', '/account#native'); dispatchEvent(new PopStateEvent('popstate')); });
    expect(result.current.tab).toBe('prompt');
    rerender({ identity: other });
    expect(result.current.tab).toBe('profile');
    expect(history.state).toBeNull();
  });

  it('exposes malformed recognized state and does not replace it or accept a selection', () => {
    const navigation = browserNavigation();
    const { result } = renderHook(() => useAccountHistory(user, true));
    const state = { ...history.state, __daynightNavigation: { ...history.state.__daynightNavigation, view: { ...accountHistory(user, 'tokens'), selection: { tab: 'bad' } } } };
    arrival(state);
    expect(result.current.error).toBe(true);
    act(() => result.current.select('prompt'));
    expect(navigation.snapshot().view).toEqual(state.__daynightNavigation.view);
    expect(history.state).toEqual(state);
  });
});


describe('Worker reading history', () => {
  const worker = '00000000-0000-4000-8000-000000000011';
  const otherWorker = '00000000-0000-4000-8000-000000000012';
  const path = `/workers/${worker}`;
  it('validates the current Worker selection and isolates identity and resource', () => {
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
    act(() => result.current.select('configuration'));
    const configuration = history.state;
    expect(result.current.section).toBe('configuration');
    act(() => result.current.select('configuration'));
    expect(history.length).toBe(length + 1);
    act(() => result.current.select('prompt'));
    const prompt = history.state;
    expect(result.current.section).toBe('prompt');
    act(() => result.current.select('prompt'));
    expect(history.length).toBe(length + 2);
    arrival(configuration, path); expect(result.current.section).toBe('configuration');
    arrival(overview, path); expect(result.current.section).toBe('overview');
    arrival(configuration, path); expect(result.current.section).toBe('configuration');
    arrival(prompt, path); expect(result.current.section).toBe('prompt');
    rerender({ identity: user, active: false });
    act(() => navigation.navigate('/account', false, accountHistory(user, 'tokens')));
    act(() => result.current.select('overview'));
    expect(navigation.snapshot().view).toEqual(accountHistory(user, 'tokens'));
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
