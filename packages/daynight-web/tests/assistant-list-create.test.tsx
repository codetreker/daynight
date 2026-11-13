vi.mock('../src/api/assistant-tasks', async original => ({ ...await original<typeof import('../src/api/assistant-tasks')>(), listAssistantTasks: async () => ({items:[],nextCursor:null,observedAt:'2026-11-13T00:00:00Z'}) }));
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { pauseAuthRequests } from '../src/api/client';
import type { CreateBotInput } from '../src/api/bots';
import * as router from '../src/app/router';
import { BotsPage } from '../src/features/bots/BotsPage';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { assistantCreateSubmit, assistantNameInput, expandAssistantAdvancedSettings, openAssistantCreation } from './helpers/assistant-ui';
import { BOT_USER, botDefaults, botDefinition, botError, botId, botResponse } from './helpers/bots';
import { renderWithLocale } from './helpers/renderWithLocale';

const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => scopes.splice(0).forEach(scope => scope.dispose()));

// Keep the production page, form, API parsing and admission logic together.
// These unbound definitions do not start a Session or require a native provider.
function mount(locale: 'en' | 'zh-CN' = 'en') {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() });
  scopes.push(scope);
  const node = (enabled: boolean) => <TaskCacheProvider scope={scope}><BotsPage botId={null} readEnabled={enabled} /></TaskCacheProvider>;
  const view = renderWithLocale(node(true), { locale });
  return { ...view, setEnabled: (enabled: boolean) => view.rerender(node(enabled)) };
}
function fixture(items = [botDefinition(1), botDefinition(2)]) {
  const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    const path = String(url);
    if (options?.method && options.method !== 'GET') throw new Error(`Unexpected write: ${options.method} ${path}`);
    if (path === '/api/v1/me/bots/defaults') return botResponse(botDefaults());
    if (path === '/api/v1/me/bots?limit=100') return botResponse({ items, nextCursor: null });
    return botError(404, 'not_found');
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const writes = (fetch: ReturnType<typeof fixture>) => fetch.mock.calls.filter(([url, options]) => options?.method === 'POST' && !String(url).endsWith('/readonly/requests'));
const listLinks = () => within(screen.getByRole('list', {name: /Your assistants|你的助手/})).queryAllByRole('link');

it('searches names without reordering or fetching, and distinguishes no matches from no assistants in both languages', async () => {
  const first = { ...botDefinition(1), name: 'Zulu 助手' }, second = { ...botDefinition(2), name: 'Alpha Helper' };
  const fetch = fixture([first, second]);
  const view = mount();
  await screen.findByRole('link', { name: /Alpha Helper/ });
  expect(listLinks().map(link => link.getAttribute('href'))).toEqual([`/bots/${first.id}`, `/bots/${second.id}`]);
  const calls = fetch.mock.calls.length;
  const search = screen.getByRole('searchbox', { name: 'Search assistants or tasks' });
  fireEvent.change(search, { target: { value: 'hELper' } });
  expect(listLinks()).toHaveLength(1);
  expect(listLinks()[0]).toHaveAttribute('href', `/bots/${second.id}`);
  fireEvent.change(search, { target: { value: 'missing' } });
  expect(screen.getByText('No matching assistants')).toBeVisible();
  expect(screen.queryByText('No assistants yet')).toBeNull();
  view.setLocale('zh-CN');
  expect(screen.getByRole('searchbox', { name: '搜索助手或助手任务' })).toBe(search);
  expect(search).toHaveValue('missing');
  expect(screen.getByText('没有匹配的助手')).toBeVisible();
  fireEvent.change(search, { target: { value: '助手' } });
  expect(listLinks()).toHaveLength(1);
  expect(listLinks()[0]).toHaveAttribute('href', `/bots/${first.id}`);
  fireEvent.change(search, { target: { value: '' } });
  expect(listLinks().map(link => link.getAttribute('href'))).toEqual([`/bots/${first.id}`, `/bots/${second.id}`]);
  expect(fetch).toHaveBeenCalledTimes(calls);
});

it.each(['en', 'zh-CN'] as const)('opens a name dialog from the zero-assistant state and returns focus on cancel (%s)', async locale => {
  const fetch = fixture([]);
  mount(locale);
  await screen.findByText(locale === 'en' ? 'No assistants yet' : '还没有助手');
  expect(screen.queryByRole('textbox')).toBeNull();
  const opener = openAssistantCreation();
  const name = assistantNameInput();
  expect(name).toHaveFocus();
  expect(screen.getByRole('dialog', { name: locale === 'en' ? 'Create assistant' : '创建助手' })).toBeVisible();
  expect(screen.getByRole('searchbox')).toBeEnabled();
  expect(screen.getByLabelText('Worker')).not.toBeVisible();
  expandAssistantAdvancedSettings();
  expect(screen.getByRole('combobox', { name: 'Worker' })).toBeVisible();
  expect(screen.getByRole('textbox', { name: locale === 'en' ? 'Working directory' : '工作目录' })).toBeVisible();
  fireEvent.change(name, { target: { value: 'Draft 名称' } });
  fireEvent.click(screen.getByRole('button', { name: locale === 'en' ? 'Cancel' : '取消' }));
  expect(opener).toHaveFocus();
  expect(screen.queryByRole('form')).toBeNull();
  expect(writes(fetch)).toHaveLength(0);
});

it('retains the old complete list through a failed second refresh page and replaces it atomically on retry', async () => {
  const fetch = fixture();
  mount();
  await screen.findByRole('link', { name: /Assistant 2/ });
  const old = listLinks();
  const next = Promise.withResolvers<Response>();
  const replacement = botDefinition(3);
  fetch.mockImplementation(async url => {
    if (String(url).includes('/defaults')) return botResponse(botDefaults());
    if (String(url).includes('cursor=next')) return next.promise;
    return botResponse({ items: [replacement], nextCursor: 'next' });
  });
  const refresh = screen.getByRole('button', { name: 'Refresh' });
  fireEvent.click(refresh);
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('cursor=next'))).toBe(true));
  expect(refresh).toBeDisabled();
  expect(refresh).toHaveAttribute('aria-busy', 'true');
  expect(listLinks()).toEqual(old);
  expect(screen.queryByRole('link', { name: /Assistant 3/ })).toBeNull();
  const calls = fetch.mock.calls.length;
  fireEvent.click(refresh);
  expect(fetch).toHaveBeenCalledTimes(calls);
  await act(async () => next.resolve(botError(503, 'unavailable')));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Could not load assistants.');
  expect(listLinks()).toEqual(old);
  expect(screen.queryByText('No assistants yet')).toBeNull();
  expect(refresh).toBeEnabled();
  fetch.mockImplementation(async () => botResponse({ items: [replacement], nextCursor: null }));
  fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await screen.findByRole('link', { name: /Assistant 3/ });
  expect(listLinks()).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(writes(fetch)).toHaveLength(0);
});

it('keeps startup failure distinct from Worker observation failure in compact selectable rows', async () => {
  const failed = { ...botDefinition(2), startupResult: { state: 'failed' as const, code: 'invalid_cwd' } };
  const fetch = fixture([botDefinition(1), failed]);
  const defaults = botDefaults();
  const offline = { ...defaults, workerId: null, configuration: null, reason: 'no_available_worker', workers: [{ ...defaults.workers[0], state: 'offline', reason: 'offline', configuration: null }] };
  fetch.mockImplementation(async url => String(url).includes('/defaults') ? botResponse(offline) : botResponse({ items: [botDefinition(1), failed], nextCursor: null }));
  mount();
  const row = await screen.findByRole('link', { name: /Assistant 2.*Startup failed.*Worker offline/ });
  expect(row).toHaveAttribute('href', `/bots/${failed.id}`);
  expect(screen.getByRole('link', { name: /Assistant 1/ })).toHaveTextContent('Starting');
  expect(within(screen.getByRole('list', {name: /Your assistants|你的助手/})).queryByText('Machine 20')).toBeNull();
  expect(within(screen.getByRole('list', {name: /Your assistants|你的助手/})).queryByText('/ordinary/directory')).toBeNull();
  fetch.mockImplementation(async url => String(url).includes('/defaults') ? botError(503, 'unavailable') : botResponse({ items: [botDefinition(1), failed], nextCursor: null }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert');
  expect(row).toHaveTextContent('Startup failed');
  expect(row).toHaveTextContent('Worker status unknown');
  expect(row).not.toHaveTextContent('Worker offline');
  expect(listLinks()).toHaveLength(2);
});

it('submits only the name and original ID through the real API, then checks the same unknown ID after reopening', async () => {
  const fetch = fixture([]), navigate = vi.spyOn(router, 'navigate');
  const posted: CreateBotInput[] = [];
  const checked: string[] = [];
  let found = false;
  fetch.mockImplementation(async (url, options) => {
    const path = String(url);
    if (options?.method === 'POST' && !String(url).endsWith('/readonly/requests')) {
      expect(path).toBe('/api/v1/me/bots');
      posted.push(JSON.parse(String(options.body)) as CreateBotInput);
      throw new TypeError('Response lost after dispatch');
    }
    if (path.endsWith('/defaults')) return botResponse(botDefaults());
    if (path.includes('?')) return botResponse({ items: [], nextCursor: null });
    checked.push(path);
    return found ? botResponse({ ...botDefinition(), id: posted[0]!.id, name: 'Only 名称' }) : botError(404, 'not_found');
  });
  const view = mount();
  await screen.findByText('No assistants yet');
  openAssistantCreation();
  fireEvent.change(assistantNameInput(), { target: { value: '　Only 名称　' } });
  await waitFor(() => expect(assistantCreateSubmit()).toBeEnabled());
  fireEvent.click(assistantCreateSubmit());
  await screen.findByRole('button', { name: 'Check creation' });
  expect(posted).toEqual([{ id: expect.any(String), name: 'Only 名称' }]);
  const original = posted[0]!.id;
  expect(original).toMatch(/^[a-f0-9-]{36}$/);
  expect(screen.getByText(original)).toBeVisible();
  view.setLocale('zh-CN');
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  const opener = openAssistantCreation();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '核对创建结果' }));
  await screen.findByRole('alert');
  expect(screen.getByText(original)).toBeVisible();
  expect(navigate).not.toHaveBeenCalled();
  found = true;
  fireEvent.click(screen.getByRole('button', { name: '核对创建结果' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(`/bots/${original}`));
  expect(checked).toEqual([`/api/v1/me/bots/${original}`, `/api/v1/me/bots/${original}`]);
  expect(writes(fetch)).toHaveLength(1);
  expect(screen.queryByRole('form')).toBeNull();
  expect(opener).toBeEnabled();
});

it('preserves the form, selection and explicit request through authentication pause and language switching', async () => {
  const fetch = fixture([]), navigate = vi.spyOn(router, 'navigate');
  const posted: CreateBotInput[] = [];
  fetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST' && !String(url).endsWith('/readonly/requests')) {
      const input = JSON.parse(String(options.body)) as CreateBotInput;
      posted.push(input);
      return botResponse({ ...botDefinition(), id: input.id, name: input.name, requestedOverrides: input.overrides, resolvedConfiguration: { ...botDefaults().configuration, cwd: '/chosen/directory', provider: 'claude' } });
    }
    return String(url).includes('/defaults') ? botResponse(botDefaults()) : botResponse({ items: [], nextCursor: null });
  });
  const view = mount();
  await screen.findByText('No assistants yet');
  openAssistantCreation();
  await waitFor(() => expect(assistantCreateSubmit()).toBeEnabled());
  const name = assistantNameInput() as HTMLInputElement;
  fireEvent.change(name, { target: { value: 'Preserved 助手' } });
  expandAssistantAdvancedSettings();
  const cwd = screen.getByRole('textbox', { name: 'Working directory' });
  fireEvent.change(cwd, { target: { value: '/chosen/directory' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
  name.focus(); name.setSelectionRange(2, 5);
  const resume = pauseAuthRequests();
  try {
    view.setEnabled(false);
    view.setLocale('zh-CN');
    expect(assistantNameInput()).toBe(name);
    expect(name).toHaveFocus();
    expect([name.selectionStart, name.selectionEnd]).toEqual([2, 5]);
    expect(screen.getByRole('textbox', { name: '工作目录' })).toBe(cwd);
    expect(cwd).toHaveValue('/chosen/directory');
    expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue('claude');
    expect(assistantCreateSubmit()).toBeDisabled();
    fireEvent.submit(name.form!);
    await act(async () => {});
    expect(writes(fetch)).toHaveLength(0);
  } finally { resume(); }
  view.setEnabled(true);
  await waitFor(() => expect(assistantCreateSubmit()).toBeEnabled());
  fireEvent.click(assistantCreateSubmit());
  await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
  expect(posted).toEqual([{ id: expect.any(String), name: 'Preserved 助手', overrides: { workerId: botId(20), cwd: '/chosen/directory', provider: 'claude' } }]);
  expect(writes(fetch)).toHaveLength(1);
  expect(navigate).toHaveBeenCalledWith(`/bots/${posted[0]!.id}`);
});

it('restores an unknown creation into a fresh scope and blocks its check during an authentication pause', async () => {
  const fetch = fixture([]);
  let original = '';
  const checked: string[] = [];
  fetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST' && !String(url).endsWith('/readonly/requests')) {
      original = (JSON.parse(String(options.body)) as CreateBotInput).id;
      throw new TypeError('Response lost');
    }
    if (String(url).includes('/defaults')) return botResponse(botDefaults());
    if (String(url).includes('?')) return botResponse({ items: [], nextCursor: null });
    checked.push(String(url));
    return botError(404, 'not_found');
  });
  const first = mount();
  await screen.findByText('No assistants yet');
  openAssistantCreation();
  fireEvent.change(assistantNameInput(), { target: { value: 'Unconfirmed' } });
  await waitFor(() => expect(assistantCreateSubmit()).toBeEnabled());
  fireEvent.click(assistantCreateSubmit());
  await screen.findByRole('button', { name: 'Check creation' });
  first.unmount();
  const restored = mount();
  await screen.findByText('No assistants yet');
  openAssistantCreation();
  expect(screen.getByText(original)).toBeVisible();
  expect(screen.queryByRole('textbox')).toBeNull();
  const check = screen.getByRole('button', { name: 'Check creation' });
  expect(check).toHaveFocus();
  const resume = pauseAuthRequests();
  try {
    restored.setEnabled(false);
    expect(check).toBeDisabled();
    fireEvent.click(check);
    await act(async () => {});
    expect(checked).toEqual([]);
  } finally { resume(); }
  restored.setEnabled(true);
  await waitFor(() => expect(check).toBeEnabled());
  fireEvent.click(check);
  await screen.findByRole('alert');
  expect(checked).toEqual([`/api/v1/me/bots/${original}`]);
  expect(writes(fetch)).toHaveLength(1);
  expect(screen.getByText(original)).toBeVisible();
});

it('shows unavailable Worker defaults in the creation dialog without losing its editable name', async () => {
  const fetch = fixture([]);
  fetch.mockImplementation(async url => String(url).includes('/defaults')
    ? botResponse({ ...botDefaults(), workerId: null, configuration: null, reason: 'no_available_worker', workers: [] })
    : botResponse({ items: [], nextCursor: null }));
  mount();
  await screen.findByText('No assistants yet');
  openAssistantCreation();
  fireEvent.change(assistantNameInput(), { target: { value: 'Waiting helper' } });
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('No available Worker. Connect a Worker that supports assistant hosting.');
  expect(assistantNameInput()).toHaveValue('Waiting helper');
  expect(assistantNameInput()).toBeEnabled();
  expect(assistantCreateSubmit()).toBeDisabled();
  fireEvent.submit((assistantNameInput() as HTMLInputElement).form!);
  await act(async () => {});
  expect(writes(fetch)).toHaveLength(0);
});
