import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createSessionDisplayPreferenceStore, type SessionDisplayBinding } from '../src/features/task-agent-session/display-preference';
import { useSessionDisplayPreference } from '../src/features/task-agent-session/useSessionDisplayPreference';

const binding = { userId: 'account-a', sessionId: 'session-a' };
const key = 'daynight.web.session.display.v1:["account-a","session-a"]';
function fixture(saved?: string) {
  const values = new Map(saved === undefined ? [] : [[key, saved]]);
  const storage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { values.set(name, value); }),
  };
  const getStorage = vi.fn(() => storage);
  return { values, storage, getStorage, preferences: createSessionDisplayPreferenceStore(getStorage) };
}

describe('Session display preference persistence', () => {
  it('uses Conversation for an absent preference without writing an implicit choice', () => {
    const { preferences, storage } = fixture();
    const store = preferences.get(binding);
    expect(store.getSnapshot()).toEqual({ mode: 'conversation', issue: null });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(key);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(['"standard"', ' "standard" ', '"conversation"'])('restores valid JSON %s without rewriting it', saved => {
    const { preferences, storage } = fixture(saved);
    expect(preferences.get(binding).getSnapshot()).toEqual({ mode: JSON.parse(saved), issue: null });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(['', 'standard', '"STANDARD"', '"unknown"', '{}', '[]', 'null', 'true', '1'])('marks invalid JSON or enum %j and lets retry replace it', saved => {
    const { preferences, storage, values } = fixture(saved);
    const store = preferences.get(binding);
    expect(store.getSnapshot()).toEqual({ mode: 'conversation', issue: { kind: 'invalid' } });
    expect(storage.setItem).not.toHaveBeenCalled();
    store.retrySave();
    expect(values.get(key)).toBe('"conversation"');
    expect(store.getSnapshot().issue).toBeNull();
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });

  it.each(['access', 'read'] as const)('reports %s failures without retaining thrown objects and retries the current default', failure => {
    const data = fixture('"standard"');
    const secret = { message: 'do not retain storage error payloads' };
    if (failure === 'access') data.getStorage.mockImplementationOnce(() => { throw secret; });
    else data.storage.getItem.mockImplementationOnce(() => { throw secret; });
    const store = data.preferences.get(binding);
    expect(store.getSnapshot()).toEqual({ mode: 'conversation', issue: { kind: 'read' } });
    const reads = data.storage.getItem.mock.calls.length;
    store.retrySave();
    expect(data.values.get(key)).toBe('"conversation"');
    expect(store.getSnapshot().issue).toBeNull();
    expect(data.storage.getItem).toHaveBeenCalledTimes(reads);
  });

  it('persists explicit choices and restores them in a new page store', () => {
    const { preferences, storage, getStorage, values } = fixture();
    preferences.get(binding).setMode('standard');
    expect(values.get(key)).toBe('"standard"');
    const nextPage = createSessionDisplayPreferenceStore(getStorage);
    expect(nextPage.get(binding).getSnapshot()).toEqual({ mode: 'standard', issue: null });
    nextPage.get(binding).setMode('conversation');
    expect(storage.setItem).toHaveBeenLastCalledWith(key, '"conversation"');
    expect(createSessionDisplayPreferenceStore(getStorage).get(binding).getSnapshot().mode).toBe('conversation');
  });

  it.each(['access', 'write'] as const)('retains memory choices on %s save failure and retries without reading stale storage', failure => {
    const data = fixture('"conversation"');
    const store = data.preferences.get(binding);
    let failing = true;
    if (failure === 'access') data.getStorage.mockImplementation(() => { if (failing) throw Error('denied'); return data.storage; });
    else data.storage.setItem.mockImplementation((name, value) => {
      expect(store.getSnapshot().mode).toBe(JSON.parse(value));
      if (failing) throw Error('full');
      data.values.set(name, value);
    });
    store.setMode('standard');
    expect(store.getSnapshot()).toEqual({ mode: 'standard', issue: { kind: 'write' } });
    expect(data.values.get(key)).toBe('"conversation"');
    const failed = store.getSnapshot();
    store.retrySave();
    expect(store.getSnapshot()).toBe(failed);
    failing = false;
    store.retrySave();
    expect(store.getSnapshot()).toEqual({ mode: 'standard', issue: null });
    expect(data.values.get(key)).toBe('"standard"');
    expect(data.storage.getItem).toHaveBeenCalledTimes(1);
  });

  it('retries the latest selection after several failed choices', () => {
    const data = fixture('"standard"');
    const store = data.preferences.get(binding);
    data.storage.setItem.mockImplementation(() => { throw Error('full'); });
    store.setMode('conversation');
    store.setMode('standard');
    store.setMode('conversation');
    data.storage.setItem.mockImplementation((name, value) => { data.values.set(name, value); });
    store.retrySave();
    expect(data.values.get(key)).toBe('"conversation"');
    expect(store.getSnapshot()).toEqual({ mode: 'conversation', issue: null });
  });

  it('keeps the same snapshot and does not notify or save on reselection', () => {
    const { preferences, storage } = fixture();
    const store = preferences.get(binding);
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);
    const before = store.getSnapshot();
    store.setMode('conversation');
    store.retrySave();
    expect(store.getSnapshot()).toBe(before);
    expect(changed).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    storage.setItem.mockImplementation(() => { throw Error('full'); });
    store.setMode('standard');
    const failed = store.getSnapshot();
    store.setMode('standard');
    expect(store.getSnapshot()).toBe(failed);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('isolates accounts and Sessions, including separator and JSON characters', () => {
    const { preferences, values } = fixture();
    preferences.get(binding).setMode('standard');
    expect(preferences.get({ ...binding, userId: 'account-b' }).getSnapshot().mode).toBe('conversation');
    expect(preferences.get({ ...binding, sessionId: 'session-b' }).getSnapshot().mode).toBe('conversation');
    const a = preferences.get({ userId: 'a:b', sessionId: 'c' });
    const b = preferences.get({ userId: 'a', sessionId: 'b:c' });
    a.setMode('standard');
    expect(b.getSnapshot().mode).toBe('conversation');
    preferences.get({ userId: 'a"', sessionId: '[b]' }).setMode('standard');
    expect([...values.keys()]).toEqual([key, 'daynight.web.session.display.v1:["a:b","c"]', 'daynight.web.session.display.v1:["a\\\"","[b]"]']);
    expect(preferences.get({ ...binding })).toBe(preferences.get(binding));
    const otherAccount = preferences.get({ ...binding, userId: 'account-b' });
    const otherSession = preferences.get({ ...binding, sessionId: 'session-b' });
    expect(otherAccount.getSnapshot()).not.toBe(otherSession.getSnapshot());
  });

  it('uses an inert null binding without even accessing storage', () => {
    const { preferences, getStorage } = fixture();
    const store = preferences.get(null);
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    store.setMode('standard');
    store.retrySave();
    unsubscribe();
    expect(store.getSnapshot()).toEqual({ mode: 'conversation', issue: null });
    expect(getStorage).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('releases subscribers while retaining an unsaved page choice', () => {
    const { preferences, storage } = fixture();
    const store = preferences.get(binding);
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(first);
    const unsubscribeSecond = store.subscribe(second);
    storage.setItem.mockImplementation(() => { throw Error('full'); });
    store.setMode('standard');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeFirst();
    store.setMode('conversation');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
    store.setMode('standard');
    expect(second).toHaveBeenCalledTimes(2);
    expect(preferences.get({ ...binding }).getSnapshot()).toEqual({ mode: 'standard', issue: { kind: 'write' } });
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });
});

describe('useSessionDisplayPreference', () => {
  it('shares page consumers and retains the unsaved choice through StrictMode remounts', () => {
    const { preferences, storage } = fixture();
    const first = renderHook(() => useSessionDisplayPreference(binding, preferences), { wrapper: StrictMode });
    const second = renderHook(() => useSessionDisplayPreference({ ...binding }, preferences));
    storage.setItem.mockImplementation(() => { throw Error('full'); });
    act(() => first.result.current.setMode('standard'));
    expect(second.result.current.mode).toBe('standard');
    expect(second.result.current.issue).toEqual({ kind: 'write' });
    first.unmount();
    second.unmount();
    const remount = renderHook(() => useSessionDisplayPreference(binding, preferences));
    expect(remount.result.current.mode).toBe('standard');
    storage.setItem.mockImplementation(() => {});
    act(() => remount.result.current.retrySave());
    expect(remount.result.current.issue).toBeNull();
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });

  it('selects the new identity on its first render and releases old and unmounted subscriptions', () => {
    const { preferences, storage } = fixture('"standard"');
    const old = preferences.get(binding);
    const releases: ReturnType<typeof vi.fn>[] = [];
    const subscribe = old.subscribe;
    vi.spyOn(old, 'subscribe').mockImplementation(listener => {
      const release = vi.fn(subscribe(listener));
      releases.push(release);
      return release;
    });
    const frames: string[] = [];
    const hook = renderHook(({ identity }: { identity: SessionDisplayBinding }) => {
      const value = useSessionDisplayPreference(identity, preferences);
      frames.push(value.mode);
      return value;
    }, { initialProps: { identity: binding as SessionDisplayBinding } });
    frames.length = 0;
    hook.rerender({ identity: { ...binding, userId: 'account-b' } });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(mode => mode === 'conversation')).toBe(true);
    expect(releases.every(release => release.mock.calls.length === 1)).toBe(true);
    act(() => old.setMode('conversation'));
    expect(hook.result.current.mode).toBe('conversation');
    frames.length = 0;
    hook.rerender({ identity: null });
    expect(frames.every(mode => mode === 'conversation')).toBe(true);
    const reads = storage.getItem.mock.calls.length;
    const writes = storage.setItem.mock.calls.length;
    act(() => { hook.result.current.setMode('standard'); hook.result.current.retrySave(); });
    expect(storage.getItem).toHaveBeenCalledTimes(reads);
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
    hook.rerender({ identity: binding });
    hook.unmount();
    expect(releases.every(release => release.mock.calls.length === 1)).toBe(true);
  });

  it('keeps preference and actions stable across reconnect, epoch and archive renders', () => {
    const { preferences, storage } = fixture();
    const hook = renderHook(({ epoch, archived }: { epoch: number; archived: boolean }) => {
      void epoch; void archived;
      return useSessionDisplayPreference({ ...binding }, preferences);
    }, { initialProps: { epoch: 1, archived: false } });
    act(() => hook.result.current.setMode('standard'));
    const actions = hook.result.current;
    hook.rerender({ epoch: 2, archived: true });
    expect(hook.result.current.mode).toBe('standard');
    expect(hook.result.current.setMode).toBe(actions.setMode);
    expect(hook.result.current.retrySave).toBe(actions.retrySave);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('uses browser storage only for a bound identity with the default page registry', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const hook = renderHook(({ identity }: { identity: SessionDisplayBinding }) => useSessionDisplayPreference(identity),
      { initialProps: { identity: null as SessionDisplayBinding } });
    expect(getItem).not.toHaveBeenCalled();
    hook.rerender({ identity: { userId: 'isolated-test-account', sessionId: 'isolated-test-session' } });
    act(() => hook.result.current.setMode('standard'));
    expect(setItem).toHaveBeenCalledExactlyOnceWith('daynight.web.session.display.v1:["isolated-test-account","isolated-test-session"]', '"standard"');
  });
});
