import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserNavigation, type DirtyDraft } from '../src/app/navigation';
import { myTasksHistory } from '../src/app/page-history';

let owner: BrowserNavigation;
beforeEach(() => { owner = new BrowserNavigation(window); });
afterEach(() => owner.dispose());
const scope = () => ({ identity: {}, projectId: 'project', taskId: 'task' });
const draft = (overrides: Partial<DirtyDraft> = {}): DirtyDraft => ({ scope: scope(), isDirty: () => true, discard: vi.fn(), survives: () => false, ...overrides });
const arrival = (state: unknown, path: string) => {
  window.history.replaceState(state, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
};

describe('window navigation admission', () => {
  it('restores only the current overview reading after rebuilding the window owner', () => {
    const user = '00000000-0000-4000-8000-000000000001';
    const project = '10000000-0000-4000-8000-000000000001';
    const task = '20000000-0000-4000-8000-000000000001';
    const reading = myTasksHistory(user, { projectPages: { [project]: 2 }, detail: { projectId: project, id: task, navigation: { tab: 'discussion', path: null }, goalChildren: null } });
    owner.navigate('/my-tasks');
    owner.setView(reading);
    const previous = history.state;
    const length = history.length;
    owner.dispose();
    owner = new BrowserNavigation(window);
    expect(owner.snapshot().view).toEqual(reading);
    expect(history.length).toBe(length);
    expect(history.state.__daynightNavigation.session).not.toBe(previous.__daynightNavigation.session);
    expect(history.state.__daynightNavigation.entryId).not.toBe(previous.__daynightNavigation.entryId);
    const current = owner.snapshot();
    arrival(previous, '/my-tasks');
    expect(owner.snapshot().entryId).toBeNull();
    expect(owner.snapshot().view).toBeUndefined();
    expect(current.entryId).not.toBeNull();
  });

  it('does not restore copied overview state at another URL or malformed readings', () => {
    const user = '00000000-0000-4000-8000-000000000001';
    const reading = myTasksHistory(user, { projectPages: {}, detail: null });
    owner.navigate('/my-tasks'); owner.setView(reading);
    const previous = history.state;
    owner.dispose();
    history.replaceState(previous, '', '/my-tasks?other=1');
    owner = new BrowserNavigation(window);
    expect(owner.snapshot().view).toBeUndefined();
    owner.dispose();
    const bad = { ...previous, __daynightNavigation: { ...previous.__daynightNavigation, view: { ...reading, selection: { ...reading.selection, draft: 'private' } } } };
    history.replaceState(bad, '', '/my-tasks');
    owner = new BrowserNavigation(window);
    expect(owner.snapshot().view).toBeUndefined();
  });
  it('initializes without adding an entry and preserves other history state fields on writes', () => {
    owner.dispose();
    window.history.replaceState({ reader: { offset: 7 } }, '', '/projects');
    const length = history.length;
    owner = new BrowserNavigation(window);
    expect(history.length).toBe(length);
    owner.navigate('/account');
    expect(history.state.reader).toEqual({ offset: 7 });
    const first = history.state.__daynightNavigation;
    owner.navigate('/invitations', true);
    expect(history.state.__daynightNavigation.index).toBe(first.index);
    expect(history.length).toBe(length + 1);
  });

  it('keeps URL validation in memory and replaces a consumed fragment without losing its index', () => {
    owner.navigate('/invitations#synthetic-invitation');
    const marker = history.state.__daynightNavigation;
    expect(Object.keys(marker).sort()).toEqual(['entryId', 'index', 'session']);
    const length = history.length;
    owner.clearFragment();
    expect(location.hash).toBe('');
    expect(owner.snapshot()).toEqual({ pathname: '/invitations', search: '', hash: '', entryId: marker.entryId, view: undefined });
    expect(history.state.__daynightNavigation).toEqual(marker);
    expect(history.length).toBe(length);
    const replace = vi.spyOn(history, 'replaceState');
    owner.clearFragment();
    expect(replace).not.toHaveBeenCalled();
    owner.register(draft());
    arrival(marker, '/invitations');
    expect(owner.decision()).toBeNull();
    arrival(marker, '/invitations#synthetic-invitation');
    expect(owner.decision()).toBeNull();
    expect(owner.snapshot().hash).toBe('#synthetic-invitation');
  });

  it.each([null, { reader: { offset: 7 } }])('keeps native fragment cleanup unindexed and preserves foreign state %j', (state) => {
    owner.navigate('/invitations');
    const previous = history.state.__daynightNavigation;
    const copied = state === null ? null : { ...state, __daynightNavigation: previous };
    owner.register(draft());
    arrival(copied, '/invitations#synthetic-native-invitation');
    owner.clearFragment();
    expect(owner.snapshot().hash).toBe('');
    expect(history.state).toEqual(state);
    owner.navigate('/account');
    expect(owner.decision()).not.toBeNull();
    owner.confirm();
    expect(history.state.__daynightNavigation.session).not.toBe(previous.session);
    expect(history.state.__daynightNavigation.index).toBe(0);
  });

  it('cancels before changing URL or history and reads current dirty state', () => {
    let dirty = true;
    const registration = draft({ isDirty: () => dirty });
    owner.register(registration);
    const notify = vi.fn(); owner.subscribe(notify);
    const length = history.length;
    owner.navigate('/account');
    expect(owner.decision()).not.toBeNull();
    expect(location.pathname).toBe('/projects');
    owner.cancel(); owner.cancel();
    expect(history.length).toBe(length);
    expect(registration.discard).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    dirty = false;
    owner.navigate('/account');
    expect(notify).toHaveBeenCalledOnce();
  });

  it('confirms one target once, retaining registration for later input and admitting nested routes', () => {
    const registration = draft(); owner.register(registration);
    const action = vi.fn(() => owner.navigate('/account'));
    owner.requestAction(action);
    owner.requestAction(vi.fn());
    owner.confirm(); owner.confirm();
    expect(action).toHaveBeenCalledOnce();
    expect(registration.discard).toHaveBeenCalledOnce();
    expect(owner.snapshot().pathname).toBe('/account');
    expect(owner.decision()).toBeNull();
    owner.navigate('/projects');
    expect(owner.decision()).not.toBeNull();
  });

  it('keeps surviving draft registrations on same-task changes and guards replace', () => {
    const registration = draft({ survives: (url) => url.pathname === '/account' });
    owner.register(registration);
    owner.navigate('/account?tab=overview');
    expect(owner.decision()).toBeNull();
    const length = history.length;
    owner.navigate('/projects', true);
    expect(owner.snapshot().pathname).toBe('/account');
    owner.confirm();
    expect(history.length).toBe(length);
    expect(owner.snapshot().pathname).toBe('/projects');
  });

  it('retains the mounted route during consecutive traversals and adopts only the latest target', () => {
    const origin = history.state;
    owner.navigate('/account'); const first = history.state;
    owner.navigate('/invitations');
    let dirty = true;
    const registration = draft({ isDirty: () => dirty, discard: () => { dirty = false; } });
    owner.register(registration);
    const notify = vi.fn(); owner.subscribe(notify);
    arrival(first, '/account');
    arrival(origin, '/projects');
    expect(owner.snapshot().pathname).toBe('/invitations');
    expect(notify).not.toHaveBeenCalled();
    owner.confirm();
    expect(owner.snapshot().pathname).toBe('/projects');
    expect(notify).toHaveBeenCalledOnce();
    expect(dirty).toBe(false);
  });

  it('consumes recovery traversal, keeps input and releases navigation after restoring the origin', () => {
    const start = history.state;
    owner.navigate('/account'); const original = history.state;
    owner.register(draft());
    const go = vi.spyOn(history, 'go').mockImplementation(() => {});
    arrival(start, '/projects');
    owner.cancel();
    expect(go).toHaveBeenLastCalledWith(1);
    owner.navigate('/invitations');
    expect(owner.decision()).toBeNull();
    arrival(original, '/account');
    expect(owner.snapshot().pathname).toBe('/account');
    expect(owner.decision()).toBeNull();
    owner.navigate('/invitations');
    expect(owner.decision()).not.toBeNull();
  });

  it('runs the keep-editing continuation only after history restoration, while its draft remains live', () => {
    const start = history.state;
    owner.navigate('/account'); const original = history.state;
    const unregister = owner.register(draft());
    vi.spyOn(history, 'go').mockImplementation(() => {});
    const continuation = vi.fn(() => owner.navigate('/account?editing=1'));
    arrival(start, '/projects'); owner.cancelAndRestore(continuation);
    expect(continuation).not.toHaveBeenCalled();
    arrival(original, '/account');
    expect(continuation).toHaveBeenCalledOnce();
    expect(owner.decision()).not.toBeNull();
    owner.cancel();
    arrival(start, '/projects'); owner.cancelAndRestore(continuation);
    unregister();
    arrival(original, '/account');
    expect(continuation).toHaveBeenCalledOnce();
  });

  it('dismisses the choice without discard when traversal returns to the surviving scope', () => {
    const start = history.state;
    owner.navigate('/account'); const original = history.state;
    const registration = draft({ survives: (url) => url.pathname === '/account' }); owner.register(registration);
    arrival(start, '/projects');
    expect(owner.decision()).not.toBeNull();
    arrival(original, '/account');
    expect(owner.decision()).toBeNull();
    expect(registration.discard).not.toHaveBeenCalled();
  });

  it('uses native behavior for unindexed entries and starts a fresh segment only on an application write', () => {
    const old = history.state;
    const registration = draft(); owner.register(registration);
    arrival(null, '/account#native');
    expect(history.state).toBeNull();
    expect(owner.snapshot()).toEqual({ pathname: '/account', search: '', hash: '#native', entryId: null, view: undefined });
    owner.navigate('/invitations'); owner.confirm();
    expect(history.state.__daynightNavigation.session).not.toBe(old.__daynightNavigation.session);
    expect(history.state.__daynightNavigation.index).toBe(0);
    arrival(old, '/projects');
    expect(owner.decision()).toBeNull();
    expect(owner.snapshot().pathname).toBe('/projects');
  });

  it('does not trust copied fragment markers or invalid indexes', () => {
    const initial = history.state;
    owner.register(draft());
    arrival(initial, '/projects#native');
    expect(owner.decision()).toBeNull();
    expect(history.state).toBe(initial);
    arrival({ __daynightNavigation: { ...initial.__daynightNavigation, index: 1.5 } }, '/account');
    expect(owner.snapshot().pathname).toBe('/account');
    arrival({ __daynightNavigation: { ...initial.__daynightNavigation, index: 99 } }, '/projects');
    expect(owner.decision()).toBeNull();
    expect(owner.snapshot().pathname).toBe('/projects');
  });

  it('publishes same-URL reading entries, preserves their identity on replacement and deduplicates choices', () => {
    const profile = { version: 1 as const, userId: 'user', pageKey: 'account' as const, selection: { tab: 'profile' as const } };
    const tokens = { ...profile, selection: { tab: 'tokens' as const } };
    owner.navigate('/account');
    const length = history.length;
    const initialId = owner.snapshot().entryId;
    const notify = vi.fn(), commit = vi.fn(); owner.subscribe(notify);
    owner.setView(profile, { replace: true });
    const source = history.state;
    expect(history.length).toBe(length);
    expect(owner.snapshot()).toMatchObject({ entryId: initialId, view: profile });
    owner.setView(tokens, { onCommit: commit });
    const destination = history.state;
    expect(history.length).toBe(length + 1);
    expect(owner.snapshot().entryId).not.toBe(initialId);
    expect(owner.snapshot().view).toEqual(tokens);
    expect(commit).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledTimes(2);
    owner.setView({ ...tokens, selection: { ...tokens.selection } }, { onCommit: commit });
    owner.navigate('/account');
    expect(history.length).toBe(length + 1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    arrival(source, '/account');
    expect(owner.snapshot().view).toEqual(profile);
    arrival(destination, '/account');
    expect(owner.snapshot().view).toEqual(tokens);
    expect(notify).toHaveBeenCalledTimes(4);
  });

  it('admits reading targets through draft protection and does not commit on cancel', () => {
    const profile = { version: 1 as const, userId: 'user', pageKey: 'account' as const, selection: { tab: 'profile' as const } };
    const tokens = { ...profile, selection: { tab: 'tokens' as const } };
    owner.navigate('/account'); owner.setView(profile, { replace: true });
    const current = owner.snapshot();
    const survives = vi.fn((_url: URL, view?: unknown) => view === profile);
    const registration = draft({ survives }); owner.register(registration);
    const commit = vi.fn();
    owner.setView(tokens, { onCommit: commit });
    expect(survives).toHaveBeenCalledWith(expect.any(URL), tokens);
    expect(owner.snapshot()).toBe(current);
    expect(commit).not.toHaveBeenCalled();
    owner.cancel();
    expect(owner.snapshot()).toBe(current);
    owner.setView(tokens, { onCommit: commit }); owner.confirm();
    expect(registration.discard).toHaveBeenCalledOnce();
    expect(owner.snapshot().view).toEqual(tokens);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('passes the destination payload to guards during traversal and optional routed navigation', () => {
    const profile = { version: 1 as const, userId: 'user', pageKey: 'account' as const, selection: { tab: 'profile' as const } };
    const tokens = { ...profile, selection: { tab: 'tokens' as const } };
    owner.navigate('/account'); owner.setView(profile, { replace: true });
    const source = history.state;
    owner.setView(tokens);
    const registration = draft({ survives: vi.fn((_url, view) => view === tokens) }); owner.register(registration);
    arrival(source, '/account');
    expect(registration.survives).toHaveBeenCalledWith(expect.any(URL), profile, source.__daynightNavigation.entryId);
    expect(owner.snapshot().view).toEqual(tokens);
    expect(owner.decision()).not.toBeNull();
    owner.confirm();
    expect(owner.snapshot().view).toEqual(profile);
    owner.navigate('/projects', false, tokens);
    expect(registration.survives).toHaveBeenLastCalledWith(expect.any(URL), tokens);
    expect(owner.snapshot().view).toEqual(tokens);
    owner.navigate('/invitations');
    owner.confirm();
    expect(owner.snapshot().view).toBeUndefined();
  });

  it('exposes malformed recognized payloads and preserves them during fragment cleanup', () => {
    owner.navigate('/account#fragment');
    const marker = history.state.__daynightNavigation;
    const bad = { ...history.state, __daynightNavigation: { ...marker, view: { version: 1, selection: 'bad' } } };
    const notify = vi.fn(); owner.subscribe(notify);
    arrival(bad, '/account#fragment');
    expect(owner.snapshot().view).toEqual(bad.__daynightNavigation.view);
    expect(notify).toHaveBeenCalledOnce();
    owner.clearFragment();
    expect(history.state.__daynightNavigation.view).toEqual(bad.__daynightNavigation.view);
    expect(owner.snapshot().entryId).toBe(marker.entryId);
  });

  it('unregisters without discarding, revokes the precise identity and never executes a retired action', () => {
    const first = draft(); const second = draft();
    const release = owner.register(first); owner.register(second);
    release();
    expect(first.discard).not.toHaveBeenCalled();
    const action = vi.fn(); owner.requestAction(action);
    owner.retireScope({ ...second.scope, identity: {} });
    expect(owner.decision()).not.toBeNull();
    owner.retireScope(second.scope); owner.confirm();
    expect(second.discard).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
    expect(owner.decision()).toBeNull();
  });

  it('retires only the addressed Worker configuration in the same authenticated identity', () => {
    const identity = {};
    const first = draft({ scope: { kind: 'worker-configuration', identity, workerId: 'first' } });
    const second = draft({ scope: { kind: 'worker-configuration', identity, workerId: 'second' } });
    const task = draft({ scope: { identity, projectId: 'first', taskId: 'first' } });
    owner.register(first); owner.register(second); owner.register(task);
    owner.retireScope({ kind: 'worker-configuration', identity: {}, workerId: 'first' });
    expect(first.discard).not.toHaveBeenCalled();
    owner.retireScope(first.scope);
    expect(first.discard).toHaveBeenCalledOnce(); expect(second.discard).not.toHaveBeenCalled(); expect(task.discard).not.toHaveBeenCalled();
    owner.retireScope(task.scope);
    expect(task.discard).toHaveBeenCalledOnce(); expect(second.discard).not.toHaveBeenCalled();
    owner.navigate('/account'); owner.confirm(); expect(second.discard).toHaveBeenCalledOnce();
  });

  it('retires synchronously on abort and refuses already retired registrations', () => {
    const controller = new AbortController();
    const registration = draft({ signal: controller.signal });
    owner.register(registration);
    owner.requestAction(vi.fn());
    controller.abort();
    expect(registration.discard).toHaveBeenCalledOnce();
    expect(owner.decision()).toBeNull();
    const retired = draft({ signal: controller.signal });
    owner.register(retired)();
    expect(retired.discard).toHaveBeenCalledOnce();
    owner.navigate('/account');
    expect(owner.decision()).toBeNull();
  });

  it('invalidates an unregistered owner without inferring a history or discard decision', () => {
    const original = history.state;
    owner.navigate('/account');
    const registration = draft();
    const unregister = owner.register(registration);
    const go = vi.spyOn(history, 'go');
    arrival(original, '/projects');
    unregister(); owner.confirm();
    expect(owner.decision()).toBeNull();
    expect(registration.discard).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(owner.snapshot().pathname).toBe('/account');
  });

  it('asks the browser to protect whole-document departure only for dirty live scopes', () => {
    const release = owner.register(draft());
    const blocked = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    release();
    const allowed = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(allowed);
    expect(allowed.defaultPrevented).toBe(false);
    expect(() => owner.navigate('https://elsewhere.invalid')).toThrow();
  });
});
