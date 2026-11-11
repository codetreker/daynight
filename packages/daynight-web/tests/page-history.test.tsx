import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/app/navigation';
import { accountHistory, readAccountHistory } from '../src/app/page-history';
import { useAccountHistory } from '../src/app/use-page-history';

const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const arrival = (state: unknown, path = '/account') => act(() => {
  history.replaceState(state, '', path);
  dispatchEvent(new PopStateEvent('popstate', { state }));
});

beforeEach(() => { history.replaceState(null, '', '/account'); });
afterEach(() => { cleanup(); browserNavigation().dispose(); vi.restoreAllMocks(); });

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
