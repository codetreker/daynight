import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { navigate } from '../src/app/router';
import { subscribeUnauthorized } from '../src/api/client';
import { createLocaleRender } from './helpers/renderWithLocale';
import { personalTeamPage } from './helpers/team';
import { BOT_USER, botDefaults, botError, botId, botResponse } from './helpers/bots';

const render = createLocaleRender('en');
const sessionId = botId(31);

afterEach(() => { vi.useRealTimers(); sessionStorage.clear(); localStorage.clear(); });

it.each([['/bots', BOT_USER], [`/test-sessions/${sessionId}`, botId(99)]])('aborts the real deletion GET on leaving %s and suppresses its late 401', async (path, owner) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  window.history.replaceState(null, '', path);
  sessionStorage.setItem(`daynight.bot.deletions:${owner}`, JSON.stringify([{
    id: botId(), name: 'Pending assistant', sessionId, workerId: botId(20),
    request: { deletionId: botId(90), ifVersion: '1' }, result: null, phase: 'unknown', rejected: false,
  }]));
  const responses: PromiseWithResolvers<Response>[] = [], signals: AbortSignal[] = [];
  const response = (body: unknown) => botResponse(body, owner);
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/v1/me') return response({ personalTeam: { id: '00000000-0000-4000-8000-000000000701', kind: 'personal', name: null }, id: owner, name: 'Owner', email: 'owner@example.com', emailVerified: true, avatarUrl: null });
    if (url === `/api/v1/me/bots/${botId()}` && (!init?.method || init.method === 'GET')) {
      signals.push(init!.signal as AbortSignal); const response = Promise.withResolvers<Response>(); responses.push(response); return response.promise;
    }
    if (url.startsWith('/api/v1/teams?')) return response(personalTeamPage(owner));
    if (url.startsWith('/api/v1/projects?')) return response({ items: [], nextCursor: null });
    if (url.includes('/defaults')) return response(botDefaults());
    if (url.startsWith('/api/v1/me/bots?') || url.startsWith('/api/v1/assistant-tasks?')) return response({ items: [], nextCursor: null, observedAt: '2026-11-13T00:00:00Z' });
    if (url === '/api/v1/auth/providers') return response({ providers: ['github'] });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const unauthorized = vi.fn(), unsubscribe = subscribeUnauthorized(unauthorized);
  try {
    render(<AuthenticatedApp />);
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]!.aborted).toBe(false);
    await act(async () => { responses[0]!.resolve(botError(500, 'failure', owner)); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check deletion' })).toBeEnabled());
    await act(async () => { vi.advanceTimersByTime(5_000); });
    await waitFor(() => expect(signals).toHaveLength(2));
    act(() => navigate('/projects'));
    await waitFor(() => expect(window.location.pathname).toBe('/projects'));
    expect(signals[1]!.aborted).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(`daynight.bot.deletions:${owner}`)!)).toMatchObject([{ id: botId(), sessionId, phase: 'unknown' }]);
    await act(async () => { responses[1]!.resolve(botError(401, 'unauthenticated', owner)); });
    expect(unauthorized).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/projects');
    expect(screen.getByRole('button', { name: /^Account menu:/ })).toBeVisible();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    expect(signals).toHaveLength(2);
    act(() => navigate(path));
    expect(await screen.findByText('Pending assistant')).toBeVisible();
    await waitFor(() => expect(signals).toHaveLength(3));
    expect(signals[2]!.aborted).toBe(false);
  } finally { unsubscribe(); }
});
