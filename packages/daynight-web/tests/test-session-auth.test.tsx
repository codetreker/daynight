import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { createLocaleRender } from './helpers/renderWithLocale';
const render = createLocaleRender('en');
const owner = '00000009-1111-4111-8111-111111111111';
const sessionId = '00000001-1111-4111-8111-111111111111';
const path = `/test-sessions/${sessionId}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': owner } });
it.each([path, '/test-sessions'])('shows login for the protected Test URL %s without requesting sessions and retains the login destination', async (targetPath) => {
  window.history.replaceState(null, '', targetPath);
  const fetch = vi.fn(async (url: string) => url === '/api/v1/me' ? json({ error: { code: 'unauthenticated', message: 'Login required', requestId: 'request' } }, 401) : json({ providers: ['github'] }));
  vi.stubGlobal('fetch', fetch);
  const login = vi.fn(); render(<AuthenticatedApp navigateToLogin={login} />);
  fireEvent.click(await screen.findByRole('button', { name: /GitHub/ }));
  const target = new URL(login.mock.calls[0]![0], window.location.origin);
  expect(target.searchParams.get('returnPath')).toBe(targetPath);
  expect(fetch.mock.calls.some(([url]) => url.includes('/test-sessions'))).toBe(false);
});
it('renders the shared session after authentication and removes it on sign-out', async () => {
  window.history.replaceState(null, '', path); vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const original = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const { claimId: _claim, ...base } = original;
  const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = original.identity;
  const snapshot = { ...base, sessionId, testExecutionId: '00000010-1111-4111-8111-111111111111', identity: { ...identity, ownerUserId: owner }, lastEventSeq: '0', initialInputState: 'not_required' };
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null; onclose = null; onerror = null;
    close = vi.fn();
    constructor() { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: owner, snapshot, cursor: 'zero' }) })); }
  }
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/v1/me') return json({ id: owner, name: 'Owner', email: 'owner@example.com', emailVerified: true, avatarUrl: null });
    if (url === `/api/v1/test-sessions/${sessionId}`) return json({ session: snapshot });
    if (url.includes('/timeline?')) return json({ sessionId, historyEpoch: snapshot.historyEpoch, items: [{ kind: 'assistant_message', entryId: '00000012-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Private test conversation' }] }], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (url.endsWith('/commands')) throw new Error('lost acknowledgement');
    if (url === '/api/v1/auth/logout') return new Response(null, { status: 204 });
    if (url === '/api/v1/auth/providers') return json({ providers: ['github'] });
    if (url === '/api/v1/projects') return json({ items: [], nextCursor: null });
    throw new Error(`Unexpected request ${url}`);
  }));
  render(<AuthenticatedApp />);
  expect(await screen.findByRole('heading', { name: 'Test Session' })).toBeVisible();
  expect(await screen.findByText('Private test conversation')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Uncertain input' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Unable to connect to the server. Please try again.');
  expect(Object.keys(window.sessionStorage).some(key => key.includes(sessionId))).toBe(true);
  const closedDraft = `daynight:session-draft:${owner}:closed-session`;
  window.sessionStorage.setItem(closedDraft, 'private draft from another page');
  const otherDraft = 'daynight:session-draft:another-principal:closed-session';
  window.sessionStorage.setItem(otherDraft, 'other principal');
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
  await waitFor(() => expect(screen.queryByText('Private test conversation')).toBeNull());
  expect(Object.keys(window.sessionStorage).filter(key => key.includes(sessionId))).toEqual([]);
  expect(window.sessionStorage.getItem(closedDraft)).toBeNull();
  expect(window.sessionStorage.getItem(otherDraft)).toBe('other principal');
  window.sessionStorage.removeItem(otherDraft);
});

function focusSession() {
  window.history.replaceState(null, '', path);
  window.sessionStorage.clear();
  let focused = true, visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const original = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const { claimId: _claim, ...base } = original;
  const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = original.identity;
  const snapshot = { ...base, sessionId, testExecutionId: '00000010-1111-4111-8111-111111111111', identity: { ...identity, ownerUserId: owner }, lastEventSeq: '0', initialInputState: 'not_required' };
  const sockets: Socket[] = [];
  class Socket {
    onmessage: ((event: { data: string }) => void) | null = null; onclose = null; onerror = null;
    close = vi.fn();
    constructor() {
      sockets.push(this);
      queueMicrotask(() => this.receive({ protocol: snapshot.protocol, type: 'snapshot', userId: owner, snapshot, cursor: 'zero' }));
    }
    receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  vi.stubGlobal('WebSocket', Socket);
  let meCalls = 0, principal = owner;
  const identityCheck = Promise.withResolvers<Response>();
  const user = (id: string, name: string) => ({ id, name, email: `${name}@example.com`, emailVerified: true, avatarUrl: null });
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': principal } });
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/v1/me') return ++meCalls === 1 ? response(user(owner, 'Owner')) : identityCheck.promise;
    if (url === `/api/v1/test-sessions/${sessionId}`) return principal === owner ? response({ session: snapshot }) : response({ error: { code: 'forbidden', message: 'Unavailable', requestId: 'request' } }, 403);
    if (url.includes('/timeline?')) return response({ sessionId, historyEpoch: snapshot.historyEpoch, items: [{ kind: 'assistant_message', entryId: '00000012-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Private focus conversation' }] }], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (url === '/api/v1/auth/providers') return response({ providers: ['github'] });
    if (url === '/api/v1/projects') return response({ items: [], nextCursor: null });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const leave = (hidden: boolean) => {
    focused = false; fireEvent(window, new Event('blur'));
    if (hidden) { visibility = 'hidden'; fireEvent(document, new Event('visibilitychange')); }
  };
  const returnToPage = (order: 'focus' | 'focus-first' | 'visibility-first') => {
    if (order === 'visibility-first') { visibility = 'visible'; fireEvent(document, new Event('visibilitychange')); }
    focused = true; fireEvent(window, new Event('focus'));
    if (order === 'focus-first') { visibility = 'visible'; fireEvent(document, new Event('visibilitychange')); }
  };
  const finish = (outcome: 'same' | 'changed' | 'expired') => {
    if (outcome === 'changed') principal = '00000019-1111-4111-8111-111111111111';
    identityCheck.resolve(outcome === 'expired'
      ? response({ error: { code: 'unauthenticated', message: 'Expired', requestId: 'request' } }, 401)
      : response(user(principal, outcome === 'changed' ? 'Other' : 'Owner')));
  };
  return { sockets, fetcher, leave, returnToPage, finish, meCalls: () => meCalls, stream: () => sockets[0]!.receive({ protocol: snapshot.protocol, type: 'event', cursor: 'one', event: { protocol: snapshot.protocol, sessionId, testExecutionId: snapshot.testExecutionId, executionGeneration: snapshot.executionGeneration, connectionEpoch: snapshot.connectionEpoch, historyEpoch: snapshot.historyEpoch, eventSeq: '1', kind: 'timeline_upsert', payload: { kind: 'assistant_message', entryId: '00000013-1111-4111-8111-111111111111', entrySeq: '2', revision: '1', content: [{ type: 'text', text: 'Buffered focus update' }] } } }) };
}

it.each(['focus', 'focus-first', 'visibility-first'] as const)('reuses a Test Session through delayed same-account verification (%s)', async order => {
  const f = focusSession(); render(<AuthenticatedApp />);
  await screen.findByText('Private focus conversation');
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(textbox, { target: { value: 'Unsent focus draft' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  const timeline = document.querySelector('.session-timeline')!;
  f.leave(order !== 'focus');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  act(() => f.stream());
  expect(f.sockets[0]!.close).not.toHaveBeenCalled();
  expect(screen.queryByText('Buffered focus update')).toBeNull();
  f.returnToPage(order);
  await waitFor(() => expect(f.meCalls()).toBe(2));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(textbox);
  expect(textbox).toHaveValue('Unsent focus draft');
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.keyDown(textbox, { key: 'Enter' });
  expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('/commands'))).toBe(false);
  expect(screen.queryByText('Restoring session')).toBeNull();
  expect(f.sockets[0]!.close).not.toHaveBeenCalled();
  await act(async () => f.finish('same'));
  await screen.findByText('Buffered focus update');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(textbox);
  expect(textbox).toHaveValue('Unsent focus draft');
  expect(document.querySelector('.session-timeline')).toBe(timeline);
  expect(screen.queryByText('Restoring session')).toBeNull();
  expect(f.sockets).toHaveLength(1);
  expect(f.sockets[0]!.close).not.toHaveBeenCalled();
  expect(f.fetcher.mock.calls.filter(([url]) => url.includes('/timeline?'))).toHaveLength(1);
  expect(f.fetcher.mock.calls.filter(([url]) => url === `/api/v1/test-sessions/${sessionId}`)).toHaveLength(1);
});

it.each(['changed', 'expired'] as const)('clears the retained Test Session when foreground verification is %s', async outcome => {
  const f = focusSession(); render(<AuthenticatedApp />);
  await screen.findByText('Private focus conversation');
  const textbox = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(textbox, { target: { value: 'Private retained draft' } });
  expect(Object.keys(window.sessionStorage).some(key => key.startsWith(`daynight:session-draft:${owner}:`))).toBe(true);
  f.leave(true);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  act(() => f.stream());
  f.returnToPage('visibility-first');
  await waitFor(() => expect(f.meCalls()).toBe(2));
  expect(screen.queryByText('Buffered focus update')).toBeNull();
  await act(async () => f.finish(outcome));
  await waitFor(() => expect(screen.queryByText('Private focus conversation')).toBeNull());
  expect(screen.queryByText('Buffered focus update')).toBeNull();
  expect(textbox.isConnected).toBe(false);
  expect(f.sockets[0]!.close).toHaveBeenCalled();
  expect(Object.keys(window.sessionStorage).filter(key => key.startsWith(`daynight:session-draft:${owner}:`))).toEqual([]);
  if (outcome === 'changed') expect(await screen.findByRole('link', { name: 'Account settings: Other' })).toBeVisible();
  else expect(await screen.findByRole('button', { name: /GitHub/ })).toBeVisible();
});
