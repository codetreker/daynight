import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, invalidateAuthRequests, pauseAuthRequests } from '../src/api/client';
import type { BrowserSession, BrowserSessionPage } from '../src/api/browser-sessions';
import type { CurrentUser } from '../src/api/auth';
import { BrowserSessionsPanel } from '../src/features/management/BrowserSessionsPanel';
import { renderWithLocale } from './helpers/renderWithLocale';

const user: CurrentUser = { id: '00000000-0000-4000-8000-000000000001', name: 'User', email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: '00000000-0000-4000-8000-000000000002', kind: 'personal', name: null } };
const row = (id: string, browser: BrowserSession['browser'], os: BrowserSession['os']): BrowserSession => ({ id, browser, os, createdAt: '2026-11-20T09:00:00Z', lastUsedAt: null, expiresAt: '2026-11-28T09:00:00Z' });
const current = row('00000000-0000-4000-8000-000000000003', 'Chrome', 'Linux');
const other = row('00000000-0000-4000-8000-000000000004', 'Firefox', 'Windows');
const third = row('00000000-0000-4000-8000-000000000005', null, null);
const first: BrowserSessionPage = { userId: user.id, current, items: [other], nextCursor: 'cursor-1' };
const deferred = <T,>() => Promise.withResolvers<T>();
const setup = (locale: 'en' | 'zh-CN' = 'en', initial: BrowserSessionPage = first) => {
  const transport = { list: vi.fn().mockResolvedValue(initial), get: vi.fn().mockResolvedValue(other), revoke: vi.fn().mockResolvedValue(undefined) };
  const props = { user, visible: true, onIdentityMismatch: vi.fn(), onSignOut: vi.fn(), transport };
  const view = renderWithLocale(<BrowserSessionsPanel {...props} />, { locale });
  return { ...view, transport, props };
};
const open = async () => { const button = screen.getByRole('button', { name: 'End session: Firefox · Windows' }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); };
const confirm = () => fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'End session' }));
afterEach(() => { invalidateAuthRequests(); sessionStorage.clear(); vi.restoreAllMocks(); });

describe('browser sessions panel', () => {
  it.each(['en', 'zh-CN'] as const)('shows loading, current and paginated rows in %s', async locale => {
    const pending = deferred<BrowserSessionPage>();
    const transport = { list: vi.fn((_signal, _user, _mismatch, cursor) => Promise.resolve(cursor ? { ...first, items: [third], nextCursor: null } : first)).mockReturnValueOnce(pending.promise), get: vi.fn(), revoke: vi.fn() };
    renderWithLocale(<BrowserSessionsPanel user={user} visible onIdentityMismatch={vi.fn()} onSignOut={vi.fn()} transport={transport} />, { locale });
    expect(screen.getByRole('status')).toHaveTextContent(locale === 'en' ? 'Loading browser logins' : '正在加载浏览器登录');
    await act(async () => pending.resolve(first));
    expect(screen.getByText(locale === 'en' ? 'Current browser' : '当前浏览器')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Load more' : '加载更多' }));
    expect(await screen.findByText(locale === 'en' ? 'Unknown browser' : '未知浏览器')).toBeInTheDocument();
    expect(screen.getByText('Firefox')).toBeInTheDocument();
    expect(transport.list).toHaveBeenCalledWith(expect.any(AbortSignal), user.id, expect.any(Function), 'cursor-1');
    expect(screen.queryByRole('button', { name: locale === 'en' ? 'Load more' : '加载更多' })).toBeNull();
  });

  it('allows cancel and Escape with focus restoration and signs out through the existing callback', async () => {
    const { transport, props } = setup();
    const opener = await screen.findByRole('button', { name: 'End session: Firefox · Windows' });
    opener.focus(); fireEvent.click(opener);
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(opener).toHaveFocus();
    fireEvent.click(opener); fireEvent.keyDown(document, { key: 'Escape' });
    expect(opener).toHaveFocus(); expect(transport.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); expect(props.onSignOut).toHaveBeenCalledOnce();
  });

  it('prevents duplicate submissions, binds the caller identity and removes only a confirmed target', async () => {
    const pending = deferred<void>(), { transport } = setup();
    transport.revoke.mockImplementationOnce((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
    await screen.findByText('Firefox'); await open(); confirm();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Ending…' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Ending…' }));
    await waitFor(() => expect(transport.revoke).toHaveBeenCalledTimes(1));
    expect(transport.revoke).toHaveBeenCalledWith(other.id, { expectedUserId: user.id, expectedSessionId: current.id }, expect.any(AbortSignal), expect.any(Function), expect.any(Function));
    await act(async () => pending.resolve());
    await screen.findByText('Browser session ended.');
    expect(screen.queryByText('Firefox')).toBeNull(); expect(screen.getByText('Chrome')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Browser logins' })).toHaveFocus();
  });

  it('reconciles an unknown outcome by reading the target, without repeating the write', async () => {
    const { transport } = setup();
    transport.revoke.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    transport.get.mockRejectedValueOnce(new ApiError('server', 404, 'not_found'));
    await screen.findByText('Firefox'); await open(); confirm();
    expect(await screen.findByText(/The result is unknown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    expect(await screen.findByText(/target is no longer active/)).toBeInTheDocument();
    expect(transport.revoke).toHaveBeenCalledTimes(1); expect(transport.get).toHaveBeenCalledOnce();
    expect(screen.queryByText('Firefox')).toBeNull();
  });

  it('keeps the active target on unknown outcome and supports retrying a failed reconciliation', async () => {
    const { transport } = setup();
    transport.revoke.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); throw new ApiError('network'); });
    transport.get.mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(other);
    await screen.findByText('Firefox'); await open(); confirm();
    await screen.findByText(/The result is unknown/);
    fireEvent.click(screen.getByRole('button', { name: 'Read current state' }));
    await screen.findByText('The operation could not be completed. Please try again.');
    expect(screen.getByText('Firefox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/target is still active/)).toBeInTheDocument();
    expect(transport.get).toHaveBeenCalledTimes(2); expect(transport.revoke).toHaveBeenCalledOnce();
  });

  it('retains the list on refresh failure and retries', async () => {
    const { transport } = setup();
    await screen.findByText('Firefox');
    transport.list.mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(first);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('alert'); expect(screen.getByText('Firefox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('discards late account responses and replaces the list for the new account', async () => {
    const pending = deferred<BrowserSessionPage>();
    const { props, transport, rerender } = setup();
    await screen.findByText('Firefox');
    transport.list.mockReturnValueOnce(pending.promise);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(3));
    const newUser = { ...user, id: '00000000-0000-4000-8000-000000000006' };
    transport.list.mockResolvedValue({ userId: newUser.id, current: third, items: [], nextCursor: null });
    rerender(<BrowserSessionsPanel {...props} user={newUser} />);
    await screen.findByText('Unknown browser');
    await act(async () => pending.resolve(first));
    expect(screen.queryByText('Firefox')).toBeNull(); expect(screen.getByText('No other browser logins.')).toBeInTheDocument();
  });

  it('does not publish an old revoke result when the same account changed its current session', async () => {
    const { transport } = setup();
    transport.revoke.mockImplementationOnce(async (_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); });
    await screen.findByText('Firefox');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    transport.list.mockResolvedValueOnce({ ...first, current: third, items: [other], nextCursor: null });
    await open(); confirm();
    expect(await screen.findByText(/current browser login changed/)).toBeInTheDocument();
    expect(screen.getByText('Firefox')).toBeInTheDocument();
    expect(screen.queryByText('Browser session ended.')).toBeNull();
  });

  it('discards an initial response from the former session after the same account signs in again', async () => {
    const pending = deferred<BrowserSessionPage>();
    const replacement = { ...first, current: third, items: [], nextCursor: null };
    const transport = { list: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(replacement), get: vi.fn(), revoke: vi.fn() };
    renderWithLocale(<BrowserSessionsPanel user={user} visible onIdentityMismatch={vi.fn()} onSignOut={vi.fn()} transport={transport} />, { locale: 'en' });
    await act(async () => pending.resolve(first));
    expect(await screen.findByText('Unknown browser')).toBeInTheDocument();
    expect(screen.queryByText('Firefox')).toBeNull();
    expect(screen.getByText(/current browser login changed/)).toBeInTheDocument();
  });

  it('refreshes all loaded pages and retains focus on the refresh action', async () => {
    const second = { ...first, items: [third], nextCursor: null };
    const transport = { list: vi.fn((_signal, _user, _mismatch, cursor) => Promise.resolve(cursor ? second : first)), get: vi.fn(), revoke: vi.fn() };
    renderWithLocale(<BrowserSessionsPanel user={user} visible onIdentityMismatch={vi.fn()} onSignOut={vi.fn()} transport={transport} />, { locale: 'en' });
    await screen.findByText('Firefox');
    const more = screen.getByRole('button', { name: 'Load more' }); await waitFor(() => expect(more).toBeEnabled()); fireEvent.click(more);
    await screen.findByText('Unknown browser');
    const refresh = screen.getByRole('button', { name: 'Refresh' }); await waitFor(() => expect(refresh).toBeEnabled()); refresh.focus(); fireEvent.click(refresh);
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(7));
    await waitFor(() => expect(refresh).toBeEnabled());
    expect(screen.getByText('Firefox')).toBeInTheDocument(); expect(screen.getByText('Unknown browser')).toBeInTheDocument();
    expect(refresh).toHaveFocus();
  });


  it('shows an initial read failure instead of an empty list and retries', async () => {
    const transport = { list: vi.fn().mockRejectedValueOnce(new ApiError('network')).mockResolvedValue(first), get: vi.fn(), revoke: vi.fn() };
    renderWithLocale(<BrowserSessionsPanel user={user} visible onIdentityMismatch={vi.fn()} onSignOut={vi.fn()} transport={transport} />, { locale: 'en' });
    await screen.findByRole('alert');
    expect(screen.queryByText('No other browser logins.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Firefox')).toBeInTheDocument();
  });


  it('restores the new session’s pending reconciliation when a refresh observes a same-account session change', async () => {
    const { transport } = setup();
    await screen.findByText('Firefox');
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    sessionStorage.setItem(`daynight.browserSessionRecovery.${user.id}`, JSON.stringify({ sessionId: third.id, targetId: other.id }));
    const replacement = { ...first, current: third, items: [other], nextCursor: null };
    transport.list.mockResolvedValue(replacement);
    fireEvent.click(refresh);
    await screen.findByText(/current browser login changed/);
    expect(screen.getByText(/The result is unknown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End session: Firefox · Windows' })).toBeDisabled();
    expect(transport.revoke).not.toHaveBeenCalled();
  });


  it('restores the new session’s pending reconciliation when a late revoke observes the session change', async () => {
    const pending = deferred<void>();
    const { transport } = setup();
    await screen.findByText('Firefox'); await open();
    transport.revoke.mockImplementationOnce((_id, _input, _signal, _mismatch, dispatch) => { dispatch?.(); return pending.promise; });
    confirm(); await waitFor(() => expect(transport.revoke).toHaveBeenCalledOnce());
    sessionStorage.setItem(`daynight.browserSessionRecovery.${user.id}`, JSON.stringify({ sessionId: third.id, targetId: other.id }));
    transport.list.mockResolvedValue({ ...first, current: third, items: [other], nextCursor: null });
    await act(async () => pending.resolve());
    await screen.findByText(/current browser login changed/);
    expect(screen.getByText(/The result is unknown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End session: Firefox · Windows' })).toBeDisabled();
    expect(transport.revoke).toHaveBeenCalledOnce();
  });


  it('does not queue a revoke submitted while identity verification is paused', async () => {
    const { transport } = setup();
    await screen.findByText('Firefox'); await open();
    const resume = pauseAuthRequests();
    try {
      confirm();
      const dialog = screen.getByRole('dialog');
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled());
      expect(transport.revoke).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(sessionStorage.getItem(`daynight.browserSessionRecovery.${user.id}`)).toBeNull();
    } finally { resume(); }
    await act(async () => {});
    expect(transport.revoke).not.toHaveBeenCalled();
  });

  it('cancels a not-yet-dispatched revoke when identity verification pauses', async () => {
    const { transport } = setup();
    await screen.findByText('Firefox'); await open();
    const dispatched = vi.fn();
    transport.revoke.mockImplementationOnce(async (_id, _input, signal, _mismatch, onDispatch) => { signal.throwIfAborted(); dispatched(); onDispatch?.(); });
    let resume!: () => void;
    act(() => { confirm(); resume = pauseAuthRequests(); });
    try {
      const dialog = screen.getByRole('dialog');
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled());
      expect(dispatched).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(sessionStorage.getItem(`daynight.browserSessionRecovery.${user.id}`)).toBeNull();
    } finally { resume(); }
    await act(async () => {});
    expect(dispatched).not.toHaveBeenCalled();
  });


  it('retains an unknown outcome when identity verification aborts a dispatched revoke', async () => {
    const { transport } = setup();
    transport.revoke.mockImplementationOnce((_id, _input, signal, _mismatch, onDispatch) => new Promise<void>((_resolve, reject) => {
      signal.throwIfAborted(); onDispatch?.();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await screen.findByText('Firefox'); await open(); confirm();
    await waitFor(() => expect(transport.revoke).toHaveBeenCalledOnce());
    const resume = pauseAuthRequests();
    try {
      await screen.findByText(/The result is unknown/);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(`daynight.browserSessionRecovery.${user.id}`)!)).toEqual({ sessionId: current.id, targetId: other.id });
      expect(screen.getByRole('button', { name: 'End session: Firefox · Windows' })).toBeDisabled();
      expect(transport.get).not.toHaveBeenCalled();
    } finally { resume(); }
    await act(async () => {});
    expect(transport.revoke).toHaveBeenCalledOnce(); expect(transport.get).not.toHaveBeenCalled();
    expect(screen.getByText(/The result is unknown/)).toBeInTheDocument();
  });

});
