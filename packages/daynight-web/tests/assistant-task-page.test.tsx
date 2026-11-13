import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotsPage } from '../src/features/bots/BotsPage';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, BOT_USER, botDefinition, botDefaults, botId, botResponse, botError } from './helpers/bots';
import { mockWideAssistantWorkspace } from './helpers/assistant-ui';
import type { AssistantTask } from '../src/api/assistant-tasks';
import { invalidateAuthRequests } from '../src/api/client';

vi.mock('../src/features/bots/BotSessionHost', () => ({ useBotSessionCache: () => cache, BotSessionHost: () => <section data-testid="retained-session" /> }));
const emptyPanes = Object.freeze([]);
const cache = { snapshot: () => emptyPanes, suspendActions: vi.fn(), invalidateBot: vi.fn(), blockBot: vi.fn(), unblockBot: vi.fn(), isBlocked: () => false, isRevoked: () => false, subscribe: () => () => {}, guardSnapshot: () => 0 };
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
const taskId = botId(80), appendixId = botId(81), proposalId = botId(82);
const baseTask = (): AssistantTask => ({ id: taskId, ownerUserId: BOT_USER, name: 'Coordination task', purpose: 'Review outcomes', scope: 'Assigned work', application: '', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null, version: '7', manualVersion: '1', claimGeneration: '0', claimState: 'unowned', holderBotId: null, credentialOperationId: null, claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME });
const manual = { taskId, version: '1', body: 'Inspect the actual outcome.', rules: [], source: 'initial', proposalId: null, createdAt: BOT_TIME };
const appendix = { id: appendixId, taskId, text: 'Original appendix note', sourceRecords: [], authorBotId: botId(1), state: 'active', version: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME };
const proposal = { id: proposalId, taskId, baseVersion: '1', body: 'An improved manual', rules: [], reason: 'Two successes', evidenceRecords: [], authorBotId: botId(1), widens: false, status: 'pending', decisionNote: '', createdAt: BOT_TIME, decidedAt: null };
const page = (items: unknown[]) => ({ items, nextCursor: null, observedAt: BOT_TIME });
beforeEach(mockWideAssistantWorkspace);
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); invalidateAuthRequests(); vi.unstubAllGlobals(); });
function fixture() {
  const state = { task: baseTask(), appendix: { ...appendix }, manual: { ...manual }, histories: [{ ...manual }], proposals: [{ ...proposal }], tasks: true };
  const writes: { path: string; input: Record<string, unknown> }[] = [];
  let write: ((path: string, input: Record<string, unknown>) => Promise<Response>) | null = null;
  const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url).split('?')[0]!;
    if (options?.method && options.method !== 'GET') {
      const input = JSON.parse(String(options.body)) as Record<string, unknown>; writes.push({ path, input });
      if (!write) throw new Error('Unexpected mutation');
      return write(path, input);
    }
    if (path === '/api/v1/me/bots/defaults') return botResponse(botDefaults());
    if (path === '/api/v1/me/bots') return botResponse({ items: [botDefinition(1)], nextCursor: null });
    if (path === '/api/v1/assistant-tasks') return botResponse(page(state.tasks ? [state.task] : []));
    if (path === `/api/v1/assistant-tasks/${taskId}`) return botResponse(state.task);
    if (path.endsWith('/manual')) return botResponse(state.manual);
    if (path.endsWith('/manual/versions')) return botResponse(page(state.histories));
    if (path.endsWith('/appendix')) return botResponse(page([state.appendix]));
    if (path.endsWith('/proposals')) return botResponse(page(state.proposals));
    if (path.endsWith('/items') || path.endsWith('/records') || path.endsWith('/events') || path.endsWith('/assistant-task-events')) return botResponse(page([]));
    return botError(404, 'not_found');
  });
  vi.stubGlobal('fetch', fetch);
  return { state, writes, fetch, setWrite: (next: NonNullable<typeof write>) => { write = next; } };
}
function mount(task: string | null = taskId) {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const node = (id: string | null, taskTab: 'manual' | 'records' | 'proposals' = 'manual') => <TaskCacheProvider scope={scope}><BotsPage botId={null} taskId={id} taskTab={taskTab} readEnabled /></TaskCacheProvider>;
  const view = renderWithLocale(node(task), { locale: 'en' });
  return { ...view, select: (id: string | null, tab: 'manual' | 'records' | 'proposals' = 'manual') => view.rerender(node(id, tab)) };
}
it.each([['active', 'Responsible'], ['paused', 'Paused'], ['expired', 'Claim expired'], ['unowned', 'Unassigned']] as const)('shows %s task registration without inferring monitoring availability', async (state, label) => {
  const f = fixture();
  if (state !== 'unowned') f.state.task = { ...f.state.task, state: state === 'paused' ? 'paused' : 'active', claimState: state === 'expired' ? 'expired' : 'active', holderBotId: botId(1), claimGeneration: '1', credentialOperationId: botId(83), claimedAt: BOT_TIME, renewedAt: BOT_TIME, leaseUntil: state === 'expired' ? BOT_TIME : '2099-01-01T00:00:00Z' };
  mount(); const detail = await screen.findByRole('region', { name: 'Coordination task' });
  expect(within(detail).getAllByText(label)[0]!).toBeVisible();
  expect(within(detail).getAllByText('Inspect the actual outcome.')[0]!).toBeVisible();
  expect(f.writes).toEqual([]);
});
it('shows empty task and record states separately and retains long manual content', async () => {
  const f = fixture(); f.state.tasks = false;
  const view = mount(null); await screen.findByText('No assistant tasks yet');
  f.state.manual.body = 'Long content '.repeat(400);
  view.select(taskId, 'records'); await screen.findByText('No work records yet');
  view.select(taskId); expect(screen.getByText(/^Long content/)).toHaveTextContent('Long content '.repeat(400).trim());
  expect(f.writes).toEqual([]);
});
it('rereads a conflict without replaying the appendix write or rebasing the retained draft', async () => {
  const f = fixture(); f.setWrite(async () => { f.state.task = { ...f.state.task, version: '8' }; f.state.appendix = { ...f.state.appendix, text: 'Concurrent appendix', version: '2' }; return botError(409, 'version_conflict'); });
  mount(); await screen.findByRole('region', { name: 'Coordination task' });
  fireEvent.click(screen.getByRole('button', { name: /Notes \/ appendix/ })); fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Preserved draft' } }); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/This task changed\. The latest/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Preserved draft');
  expect(f.writes).toEqual([{ path: `/api/v1/assistant-tasks/${taskId}/appendix/${appendixId}`, input: { ifVersion: '7', text: 'Preserved draft', sourceRecords: [] } }]);
});
it('keeps an unknown write fenced across navigation and checks it with reads only', async () => {
  const f = fixture(); f.setWrite(async () => { throw new TypeError('response lost'); });
  const view = mount(); await screen.findByRole('region', { name: 'Coordination task' });
  fireEvent.click(screen.getByRole('button', { name: 'Pause' })); await screen.findByText(/The write result is unknown/);
  view.select(null); view.select(taskId); await screen.findByText(/The write result is unknown/);
  expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check current result' })); await screen.findByText(/Current data was read/);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]!.input).toEqual({ ifVersion: '7', state: 'paused' });
  fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current result' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled());
});

it('publishes a late unknown result to the remounted task and keeps its mutation gate closed', async () => {
  const f = fixture(); let fail!: (reason: unknown) => void;
  f.setWrite(async () => new Promise<Response>((_resolve, reject) => { fail = reject; }));
  const view = mount(); await screen.findByRole('region', { name: 'Coordination task' });
  fireEvent.click(screen.getByRole('button', { name: 'Pause' })); await waitFor(() => expect(fail).toBeDefined());
  view.select(null); view.select(taskId); await screen.findByRole('region', { name: 'Coordination task' });
  expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
  await act(async () => fail(new TypeError('response lost after navigation')));
  await screen.findByText(/The write result is unknown/);
  expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Check current result' })).toBeEnabled();
  expect(f.writes).toHaveLength(1);
});

it.each(['transfer', 'release'] as const)('checks an unknown %s receipt and current task before an explicit new decision', async operation => {
  const f = fixture();
  if (operation === 'release') f.state.task = { ...f.state.task, holderBotId: botId(1), claimGeneration: '1', claimState: 'active', credentialOperationId: botId(83), claimedAt: BOT_TIME, renewedAt: BOT_TIME, leaseUntil: '2099-01-01T00:00:00Z' };
  f.setWrite(async () => { throw new TypeError('claim response lost'); });
  mount(); await screen.findByRole('region', { name: 'Coordination task' });
  fireEvent.click(screen.getByRole('button', { name: operation === 'release' ? 'Release' : 'Assign assistant' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(screen.getAllByText(/The write result is unknown/).length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  const before = f.fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Check current result' }));
  await screen.findByText(/Current data was read/);
  expect(screen.queryByText('The change was not accepted.')).toBeNull();
  expect(f.writes).toHaveLength(1);
  const original = f.writes[0]!;
  expect(original.path).toBe(`/api/v1/assistant-tasks/${taskId}/${operation}`);
  const reads = f.fetch.mock.calls.slice(before).map(([url]) => String(url));
  expect(reads[0]).toBe(`/api/v1/assistant-tasks/${taskId}/claim-operations/${original.input.operationId}`);
  expect(reads).toContain(`/api/v1/assistant-tasks/${taskId}`);
  fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current result' }));
  await waitFor(() => expect(screen.getByRole('button', { name: operation === 'release' ? 'Release' : 'Assign assistant' })).toBeEnabled());
  expect(f.writes).toHaveLength(1);
});

it('keeps task controls available and displays application JSON numbers without rounding', async () => {
  const f = fixture(), original = f.fetch.getMockImplementation()!;
  const raw = (value: unknown) => new Response(JSON.stringify(value).replaceAll('"raw-number"', '9007199254740993'), { headers: botResponse({}).headers });
  const itemId = botId(95);
  f.fetch.mockImplementation(async (url, options) => {
    const path = String(url).split('?')[0]!;
    if (path.endsWith('/manual')) return raw({ ...manual, rules: { externalId: 'raw-number' } });
    if (path.endsWith('/manual/versions')) return raw(page([{ ...manual, rules: { externalId: 'raw-number' } }]));
    if (path.endsWith('/items')) return raw(page([{ id: itemId, taskId, key: 'Large external identity', episode: '1', state: 'open', category: '', followerBotId: null, appState: { externalId: 'raw-number' }, version: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME }]));
    if (path.endsWith('/records')) return raw(page([{ id: botId(96), taskId, itemId, author: 'system', authorBotId: null, kind: 'fact', text: 'External evidence', refs: { externalId: 'raw-number' }, createdAt: BOT_TIME }]));
    return original(url, options);
  });
  const view = mount();
  const detail = await screen.findByRole('region', { name: 'Coordination task' });
  expect(within(detail).getByRole('button', { name: 'Pause' })).toBeEnabled();
  expect(within(detail).getAllByText(/"externalId": 9007199254740993/)[0]).toBeVisible();
  view.select(taskId, 'records');
  await screen.findByText('External evidence');
  const records = screen.getByRole('region', { name: 'Work records' });
  fireEvent.click(within(records).getByText('References'));
  expect(within(records).getByText(/"externalId": 9007199254740993/)).toBeVisible();
  expect(screen.queryByText(/9007199254740992/)).toBeNull();
  expect(f.writes).toEqual([]);
});

it('keeps Bot attention outstanding while the task detail hides its conversation', async () => {
  const f = fixture(), original = f.fetch.getMockImplementation()!;
  const bot = { ...botDefinition(1), attentionCount: 1 };
  f.fetch.mockImplementation(async (url, options) => {
    const path = String(url).split('?')[0];
    if (path === `/api/v1/bots/${bot.id}/attention/seen`) { bot.attentionCount = 0; return botResponse({ targetBotId: bot.id }); }
    if (path === '/api/v1/me/bots') return botResponse({ items: [bot], nextCursor: null });
    if (path === `/api/v1/me/bots/${bot.id}`) return botResponse(bot);
    return original(url, options);
  });
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const node = (selectedTask: string | null) => <TaskCacheProvider scope={scope}><BotsPage botId={bot.id} taskId={selectedTask} readEnabled /></TaskCacheProvider>;
  const view = renderWithLocale(node(taskId), { locale: 'en' });
  await screen.findByRole('region', { name: 'Coordination task' });
  expect(screen.getByTestId('retained-session')).not.toBeVisible();
  expect(screen.getByLabelText('1 items need your attention')).toBeVisible();
  expect(f.fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  view.rerender(node(null));
  await waitFor(() => expect(screen.queryByLabelText('1 items need your attention')).toBeNull());
  expect(screen.getByTestId('retained-session')).toBeVisible();
  expect(f.fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
});
