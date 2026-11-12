import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as sessions from '../src/api/sessions';
import { pauseAuthRequests } from '../src/api/client';
import { getBotDeletionCoordinator } from '../src/features/bots/deletion-coordinator';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { TaskSessionClient } from '../src/features/task-agent-session/client';
import { TestSessionPage } from '../src/features/task-agent-session/TestSessionPage';
import { createLocaleRender } from './helpers/renderWithLocale';
import { botFixture } from './helpers/bot-session';
import { botDefinition, botError, botId, botResponse, BOT_USER } from './helpers/bots';

const render = createLocaleRender('en');
const createTestSessionApi = sessions.createTestSessionApi;
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); sessionStorage.clear(); });
function fixture() {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const coordinator = getBotDeletionCoordinator(scope);
  const f = botFixture({ ownerUserId: BOT_USER, botId: botId(), sessionId: botId(31), testExecutionId: botId(41) });
  const other = botFixture({ ownerUserId: BOT_USER, botId: botId(2), sessionId: botId(32), testExecutionId: botId(42) });
  const bot = { ...botDefinition(), sessionId: f.binding.sessionId, testExecutionId: f.binding.testExecutionId, roleConfiguration: { instructions: 'Assistant', revision: '1', digest: 'a'.repeat(64) } };
  const api = vi.spyOn(sessions, 'createTestSessionApi').mockImplementation(id => id === f.binding.sessionId ? f.api : other.api);
  const start = vi.spyOn(TaskSessionClient.prototype, 'start');
  const element = (id = f.binding.sessionId, owner = scope) => <TaskCacheProvider scope={owner}><TestSessionPage sessionId={id} /></TaskCacheProvider>;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'DELETE' ? botError(500, 'failure') : botResponse(bot));
  vi.stubGlobal('fetch', fetcher);
  return { ...f, other, scope, coordinator, bot, apiFactory: api, start, element, fetcher };
}

it('blocks an old URL before creating a client after an unknown DELETE, including restored navigation', async () => {
  const f = fixture(); await f.coordinator.begin(f.bot);
  expect(f.coordinator.snapshot()[0]!.phase).toBe('unknown');
  const view = render(f.element());
  expect(f.apiFactory).not.toHaveBeenCalled(); expect(screen.queryByRole('textbox')).toBeNull();
  const restored = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(restored);
  view.rerender(f.element(f.binding.sessionId, restored));
  expect(f.apiFactory).not.toHaveBeenCalled(); expect(screen.queryByText(`Message ${f.binding.botId}`)).toBeNull();
  view.rerender(f.element(f.other.binding.sessionId));
  await screen.findByText(`Message ${f.other.binding.botId}`);
  expect(f.other.api.current).toHaveBeenCalled(); expect(f.api.current).not.toHaveBeenCalled();
});

it('stops the independent Session synchronously on account pause and keeps its draft', async () => {
  const f = fixture(); const view = render(f.element());
  await screen.findByText(`Message ${f.binding.botId}`);
  const client = f.start.mock.contexts[0] as TaskSessionClient;
  act(() => client.setDraft('local draft'));
  let resume = () => {};
  try {
    act(() => { resume = pauseAuthRequests(); expect(f.channel.close).toHaveBeenCalledOnce(); });
    expect(screen.getByText(`Message ${f.binding.botId}`)).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('local draft');
    expect(f.api.command).not.toHaveBeenCalled();
  } finally { resume(); view.unmount(); }
});

it.each([false, true])('closes a live old-URL client and restores drafts after definite rejection (identity pause=%s)', async paused => {
  const f = fixture(), response = Promise.withResolvers<Response>();
  f.fetcher.mockImplementation(async (_url, init) => init?.method === 'DELETE' ? response.promise : botResponse(f.bot));
  render(f.element()); await screen.findByText(`Message ${f.binding.botId}`);
  const client = f.start.mock.contexts[0] as TaskSessionClient;
  act(() => client.setDraft('retained draft'));
  vi.mocked(f.api.command).mockRejectedValue(new Error('receipt unknown'));
  await act(async () => { await expect(client.send('retained draft')).rejects.toThrow(); });
  const keys = Object.keys(sessionStorage).filter(key => key.includes(f.binding.sessionId));
  expect(keys.some(key => key.includes('session-operations'))).toBe(true);
  let operation!: Promise<void>;
  act(() => { operation = f.coordinator.begin(f.bot); expect(f.channel.close).toHaveBeenCalled(); });
  expect(screen.queryByText(`Message ${f.binding.botId}`)).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
  const calls = [f.api.current, f.api.timeline, f.api.command, f.api.resource, f.api.operation].map(fn => vi.mocked(fn).mock.calls.length);
  await expect(client.send('late')).rejects.toThrow();
  await expect(client.resource(botId(70), new AbortController().signal)).rejects.toThrow();
  await client.loadOlder(); await client.checkOperation(botId(80)); client.refresh(); client.setDraft('late draft');
  expect([f.api.current, f.api.timeline, f.api.command, f.api.resource, f.api.operation].map(fn => vi.mocked(fn).mock.calls.length)).toEqual(calls);
  expect(keys.every(key => sessionStorage.getItem(key) !== null)).toBe(true);
  await waitFor(() => expect(f.fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true));
  const resume = paused ? pauseAuthRequests() : () => {};
  try {
    await act(async () => { response.resolve(botError(409, 'version_conflict')); await operation; });
    if (paused) {
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(f.coordinator.sessionAdmission(f.binding.sessionId)).toBe('blocked');
      resume(); await act(async () => { await f.coordinator.check(f.bot.id); });
    }
  } finally { resume(); }
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('retained draft'));
  expect(f.api.command).toHaveBeenCalledOnce();
  expect(f.start.mock.contexts.some(value => value !== client)).toBe(true);
});

it('learns a newly registered Session identity from an active observation without releasing the deletion barrier', async () => {
  const f = fixture(); await f.coordinator.begin(botDefinition());
  expect(f.coordinator.snapshot()[0]!.sessionId).toBe(f.binding.sessionId);
  render(f.element()); expect(f.apiFactory).not.toHaveBeenCalled(); expect(screen.queryByRole('textbox')).toBeNull();
});

it('does not replace a known Session identity with a conflicting active observation', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (_url, init) => init?.method === 'DELETE' ? botError(409, 'version_conflict') : botResponse({ ...f.bot, sessionId: f.other.binding.sessionId }));
  await f.coordinator.begin(f.bot);
  expect(f.coordinator.snapshot()[0]).toMatchObject({ phase: 'unknown', sessionId: f.binding.sessionId, error: { kind: 'protocol' } });
  expect(f.coordinator.sessionAdmission(f.binding.sessionId)).toBe('blocked');
});

it('clears only the revoked independent Session storage and never restores its old URL', async () => {
  const f = fixture(); render(f.element()); await screen.findByText(`Message ${f.binding.botId}`);
  const client = f.start.mock.contexts[0] as TaskSessionClient;
  act(() => client.setDraft('delete this draft'));
  vi.mocked(f.api.command).mockRejectedValue(new Error('receipt unknown'));
  await act(async () => { await expect(client.send('delete this draft')).rejects.toThrow(); });
  const keys = Object.keys(sessionStorage).filter(key => key.includes(f.binding.sessionId));
  const unrelated = [`daynight:session-draft:${BOT_USER}:test:${f.other.binding.sessionId}:test:other`, `daynight:session-draft:${BOT_USER}:task:other`];
  for (const key of unrelated) sessionStorage.setItem(key, 'keep');
  await act(async () => { await f.coordinator.begin(f.bot); });
  expect(keys.every(key => sessionStorage.getItem(key) !== null)).toBe(true);
  act(() => f.coordinator.observe({ id: f.bot.id, workerId: f.bot.workerId, version: '2', deletion: { deletionId: f.coordinator.snapshot()[0]!.request!.deletionId, requestedVersion: '1', workerCleanup: { state: 'completed', code: null }, serverCleanup: { state: 'completed', code: null } } }));
  expect(f.coordinator.sessionAdmission(f.binding.sessionId)).toBe('revoked');
  expect(keys.every(key => sessionStorage.getItem(key) === null)).toBe(true);
  expect(unrelated.map(key => sessionStorage.getItem(key))).toEqual(['keep', 'keep']);
  await act(async () => { await f.coordinator.check(f.bot.id); });
  expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByText(`Message ${f.binding.botId}`)).toBeNull();
  expect(f.apiFactory).toHaveBeenCalledOnce();
});

it.each(['current', 'timeline'] as const)('discards a late independent %s response after synchronous deletion blocking', async kind => {
  const f = fixture(), current = Promise.withResolvers<Awaited<ReturnType<sessions.SessionApi['current']>>>(), timeline = Promise.withResolvers<typeof f.page>();
  if (kind === 'current') vi.mocked(f.api.current).mockReturnValue(current.promise);
  else vi.mocked(f.api.timeline).mockReturnValue(timeline.promise);
  render(f.element()); await waitFor(() => expect(f.api[kind]).toHaveBeenCalled());
  const client = f.start.mock.contexts[0] as TaskSessionClient;
  await act(async () => { await f.coordinator.begin(f.bot); });
  await act(async () => { current.resolve({ status: 'registered', session: f.snapshot() }); timeline.resolve(f.page); });
  expect(client.snapshot().state.entries).toEqual([]); expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText(`Message ${f.binding.botId}`)).toBeNull();
  if (kind === 'current') { expect(f.api.channel).not.toHaveBeenCalled(); expect(f.api.timeline).not.toHaveBeenCalled(); }
});

it('aborts in-flight resources and input acknowledgements without publishing their late results', async () => {
  const f = fixture(), resource = Promise.withResolvers<Blob>(), command = Promise.withResolvers<never>();
  const resourceId = botId(70);
  vi.mocked(f.api.timeline).mockResolvedValue({ ...f.page, resources: [{ resourceId, status: 'available', name: 'output.txt', mediaType: 'text/plain', byteLength: '4', sha256: 'a'.repeat(64), error: null }] });
  vi.mocked(f.api.resource).mockReturnValue(resource.promise);
  vi.mocked(f.api.command).mockReturnValue(command.promise);
  render(f.element()); await screen.findByText(`Message ${f.binding.botId}`);
  const client = f.start.mock.contexts[0] as TaskSessionClient;
  let loaded!: Promise<unknown>, sent!: Promise<unknown>;
  act(() => {
    client.setDraft('in flight');
    loaded = client.resource(resourceId, new AbortController().signal).catch(error => error);
    sent = client.send('in flight').catch(error => error);
  });
  await waitFor(() => { expect(f.api.resource).toHaveBeenCalledOnce(); expect(f.api.command).toHaveBeenCalledOnce(); });
  await act(async () => { await f.coordinator.begin(f.bot); });
  expect(vi.mocked(f.api.resource).mock.calls[0]![2].aborted).toBe(true);
  await act(async () => { resource.resolve(new Blob(['late'])); command.reject(new Error('late acknowledgement')); await Promise.all([loaded, sent]); });
  expect(await loaded).toBeInstanceOf(Error); expect(await sent).toBeInstanceOf(Error);
  expect(client.snapshot().state.entries).toEqual([]); expect(client.snapshot().state.operations.size).toBe(0);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(Object.keys(sessionStorage).some(key => key.includes('session-operations') && key.includes(f.binding.sessionId))).toBe(true);
});

it('aborts a current request waiting for identity before its transport dispatch', async () => {
  const f = fixture(); let resume: (() => void) | undefined;
  const transport = createTestSessionApi(f.binding.sessionId, BOT_USER, vi.fn());
  f.apiFactory.mockReturnValue({ ...f.api, current: signal => { resume = pauseAuthRequests(); return transport.current(signal); } });
  render(f.element());
  await waitFor(() => expect(resume).toBeDefined());
  let operation!: Promise<void>;
  act(() => { resume!(); operation = f.coordinator.begin(f.bot); });
  await act(async () => { await operation; });
  expect(f.fetcher.mock.calls.some(([url]) => url.includes('/test-sessions/'))).toBe(false);
  expect(f.api.timeline).not.toHaveBeenCalled(); expect(f.api.channel).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
});
