import { useSyncExternalStore } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantTaskPendingStrip } from '../src/features/bots/AssistantTaskPendingStrip';
import { AssistantTaskDetail } from '../src/features/bots/AssistantTaskDetail';
import { browserNavigation } from '../src/app/navigation';
import { parseAuthRoute } from '../src/app/router';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, BOT_USER, botDefinition, botId, botResponse, botError } from './helpers/bots';
import type { AssistantTask } from '../src/api/assistant-tasks';
import { invalidateAuthRequests } from '../src/api/client';

const taskId = botId(80), openItem = botId(81), closedItem = botId(82), escalationId = botId(83);
const task: AssistantTask = { id: taskId, ownerUserId: BOT_USER, name: 'Coordination', purpose: '', scope: '', application: '', kind: 'once', state: 'active', takeover: 'manual', trigger: null, version: '7', manualVersion: '1', claimGeneration: '1', claimState: 'active', holderBotId: botId(1), credentialOperationId: botId(90), claimedAt: BOT_TIME, renewedAt: BOT_TIME, leaseUntil: '2099-01-01T00:00:00Z', observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME };
const manual = { taskId, version: '1', body: 'Inspect the result.', rules: [], source: 'initial', proposalId: null, createdAt: BOT_TIME };
const item = (id: string, state: 'open' | 'closed') => ({ id, taskId, key: state === 'open' ? 'Unresolved session' : 'Resolved session', episode: '1', state, category: 'stalled', followerBotId: botId(1), appState: {}, version: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME });
const event = (id: string, itemId: string, type: 'escalation' | 'result_unknown') => ({ id, taskId, targetBotId: botId(1), type, payload: { itemId, text: type === 'escalation' ? 'The session still needs a decision.' : 'The send result is unknown.' }, state: 'delivered', attention: true, createdAt: BOT_TIME, deliveredAt: BOT_TIME, seenAt: BOT_TIME, ackOperationId: botId(91) });
const proposal = { id: botId(88), taskId, baseVersion: '1', body: 'Proposed manual', rules: [], reason: 'Two successes', evidenceRecords: [], authorBotId: botId(1), widens: false, status: 'pending', decisionNote: '', createdAt: BOT_TIME, decidedAt: null };
const paged = (items: unknown[]) => ({ items, nextCursor: null, observedAt: BOT_TIME });
afterEach(() => { invalidateAuthRequests(); vi.unstubAllGlobals(); });
function install() {
  const state = { failEvents: false, closed: false, followerBotId: botId(1) };
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method && options.method !== 'GET') throw new Error('Pending presentation must not mutate events');
    const path = String(url).split('?')[0]!;
    if (path === `/api/v1/assistant-tasks/${taskId}`) return botResponse(task);
    if (path.endsWith('/manual')) return botResponse(manual);
    if (path.endsWith('/manual/versions')) return botResponse(paged([manual]));
    if (path.endsWith('/proposals')) return botResponse(paged([proposal]));
    if (path.endsWith('/events')) return state.failEvents ? botError(503, 'unavailable') : botResponse(paged([event(escalationId, openItem, 'escalation'), event(botId(84), closedItem, 'result_unknown')]));
    if (path.endsWith('/items')) return botResponse(paged([{ ...item(openItem, state.closed ? 'closed' : 'open'), followerBotId: state.followerBotId }, item(closedItem, 'closed')]));
    if (path.endsWith('/records') || path.endsWith('/appendix')) return botResponse(paged([]));
    throw new Error(`Unexpected read ${path}`);
  }); vi.stubGlobal('fetch', fetch);
  return { state, fetch };
}
function RoutedPending() {
  const navigation = browserNavigation(), location = useSyncExternalStore(navigation.subscribe, navigation.snapshot), route = parseAuthRoute(location.pathname, location.search);
  return route.kind === 'assistantTask'
    ? <AssistantTaskDetail taskId={route.taskId} tab={route.tab} {...(route.eventId ? { eventId: route.eventId } : {})} enabled bots={[botDefinition(1)]} onChanged={() => {}} />
    : <AssistantTaskPendingStrip botId={botId(1)} tasks={[task]} enabled />;
}
it('retains seen unresolved escalations, hides closed-item events and focuses the event reached from the strip', async () => {
  const f = install();
  renderWithLocale(<RoutedPending />, { locale: 'en', taskCache: { viewerId: BOT_USER } });
  const escalation = await screen.findByRole('button', { name: 'Coordination · Escalation' });
  expect(screen.queryByRole('button', { name: /Result unknown/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Coordination · Pending proposals (1)' })).toBeVisible();
  fireEvent.click(escalation);
  expect(browserNavigation().snapshot().search).toBe(`?tab=records&eventId=${escalationId}`);
  const text = await screen.findByText('The session still needs a decision.');
  await waitFor(() => expect(text.closest('article')).toHaveFocus());
  expect(screen.queryByText('The send result is unknown.')).toBeNull();
  expect(f.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
it('keeps failures recoverable instead of presenting a failed pending read as an empty result', async () => {
  const f = install(); f.state.failEvents = true;
  renderWithLocale(<AssistantTaskPendingStrip botId={botId(1)} tasks={[task]} enabled />, { locale: 'en', taskCache: { viewerId: BOT_USER } });
  const retry = await screen.findByRole('button', { name: /Could not load assistant tasks.*Retry/ });
  f.state.failEvents = false; fireEvent.click(retry);
  await screen.findByRole('button', { name: 'Coordination · Escalation' });
});
it('excludes work owned by another assistant', async () => {
  const f = install();
  renderWithLocale(<AssistantTaskPendingStrip botId={botId(2)} tasks={[task]} enabled />, { locale: 'en', taskCache: { viewerId: BOT_USER } });
  expect(screen.queryByRole('button')).toBeNull(); expect(f.fetch).not.toHaveBeenCalled();
});

it('moves unresolved decisions to the new holder even when delivery targeted the previous assistant', async () => {
  const f = install();
  const transferred: AssistantTask = { ...task, holderBotId: botId(2), claimGeneration: '2', claimState: 'pending', credentialOperationId: null };
  const view = renderWithLocale(<AssistantTaskPendingStrip botId={botId(1)} tasks={[task]} enabled />, { locale: 'en', taskCache: { viewerId: BOT_USER } });
  await screen.findByRole('button', { name: 'Coordination · Escalation' });
  f.state.followerBotId = botId(2);
  view.rerender(<AssistantTaskPendingStrip botId={botId(1)} tasks={[transferred]} enabled />);
  expect(screen.queryByRole('button', { name: 'Coordination · Escalation' })).toBeNull();
  view.rerender(<AssistantTaskPendingStrip botId={botId(2)} tasks={[transferred]} enabled />);
  const escalation = await screen.findByRole('button', { name: 'Coordination · Escalation' });
  expect(screen.queryByRole('button', { name: /Result unknown/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Coordination · Pending proposals (1)' })).toBeVisible();
  fireEvent.click(escalation);
  expect(browserNavigation().snapshot().search).toBe(`?tab=records&eventId=${escalationId}`);
  f.state.closed = true;
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Coordination · Escalation' })).toBeNull());
  expect(f.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
