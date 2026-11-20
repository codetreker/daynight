import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { type AssistantTask, type AssistantTaskInbox as Inbox, assistantTaskInboxUrl, enableAssistantTaskInbox, getAssistantTaskInbox } from '../src/api/assistant-tasks';
import { invalidateAuthRequests } from '../src/api/client';
import { parseAuthRoute } from '../src/app/router';
import { AssistantTaskInbox } from '../src/features/bots/AssistantTaskInbox';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, BOT_USER, botError, botId, botResponse } from './helpers/bots';

const directories = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), listProjects: vi.fn(async () => ({ items: directories.projects, nextCursor: null })) }));

const taskId = botId(90), inboxId = botId(91), operationId = botId(92);
const token = `dnib_${'A'.repeat(43)}`, rotated = `dnib_${'B'.repeat(43)}`;
const task: AssistantTask = { id: taskId, ownerUserId: BOT_USER, name: 'Inbox task', purpose: '', scope: '', application: '', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null, version: '7', manualVersion: '1', claimGeneration: '0', claimState: 'unowned', holderBotId: null, credentialOperationId: null, claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME };
const off: Inbox = { inboxId: null, enabled: false, createdAt: null, rotatedAt: null, overlapUntil: null, suppressedCount: '0' };
const on: Inbox = { inboxId, enabled: true, createdAt: BOT_TIME, rotatedAt: null, overlapUntil: null, suppressedCount: '3' };
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); invalidateAuthRequests(); vi.unstubAllGlobals(); directories.projects = []; });

const receipt = (kind: string, inbox: Inbox, id: string, issued?: string | null) => ({
  operation: { operationId: id, kind, taskId, requestFingerprint: 'a'.repeat(64), admittedAt: BOT_TIME, resultingVersion: '8' }, inbox, ...(issued === undefined ? {} : { token: issued }),
});
function server(initial: Inbox) {
  const state = { inbox: initial }, writes: { path: string; input: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (options?.method === 'POST') {
      const input = JSON.parse(String(options.body)) as Record<string, unknown>; writes.push({ path, input });
      const kind = path.split('/').at(-1)!, id = String(input.operationId);
      if (kind === 'enable') { state.inbox = on; return botResponse(receipt('inbox_enable', on, id, token)); }
      if (kind === 'rotate') { state.inbox = { ...on, rotatedAt: BOT_TIME, ...(input.mode === 'overlap' ? { overlapUntil: '2026-11-05T12:00:00Z' } : {}) }; return botResponse(receipt(`inbox_rotate_${String(input.mode)}`, state.inbox, id, rotated)); }
      state.inbox = off; return botResponse(receipt('inbox_disable', off, id));
    }
    if (path === `/api/v1/assistant-tasks/${taskId}/inbox`) return botResponse(state.inbox);
    if (path === '/api/v1/me/webhooks?limit=100') return botResponse({ items: [], nextCursor: null });
    return botError(404, 'not_found');
  });
  vi.stubGlobal('fetch', fetch);
  return { state, writes, fetch };
}
const mounted: { rerender: (props: { readonly task: AssistantTask }) => void } = { rerender: () => undefined };
function mount(onChanged = vi.fn(async () => undefined)) {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const view = (props: { readonly task: AssistantTask }) => <TaskCacheProvider scope={scope}><AssistantTaskInbox task={props.task} enabled disabled={false} onChanged={onChanged} /></TaskCacheProvider>;
  const { rerender } = renderWithLocale(view({ task }), { locale: 'en' });
  mounted.rerender = props => rerender(view(props));
  return onChanged;
}

it('routes the inbox tab of an assistant task', () => {
  expect(parseAuthRoute(`/bots/tasks/${taskId}`, '?tab=inbox')).toEqual({ kind: 'assistantTask', taskId, tab: 'inbox' });
});

it('enables the inbox, shows the token from the response and the token-free URL with copy actions', async () => {
  const s = server(off), changed = mount();
  const writeText = vi.fn(async () => undefined); vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  fireEvent.click(await screen.findByRole('button', { name: 'Enable inbox' }));
  await waitFor(() => expect(s.writes).toEqual([{ path: `/api/v1/assistant-tasks/${taskId}/inbox/enable`, input: { operationId: expect.any(String), ifVersion: '7' } }]));
  const issued = await screen.findByRole('group', { name: 'New token' });
  expect(within(issued).getByText(token)).toBeVisible();
  expect(changed).toHaveBeenCalled();
  const url = `${location.origin}/api/v1/assistant-task-inbox/${inboxId}`;
  expect(await screen.findByText(url)).toBeVisible();
  expect(url).not.toContain('dnib_');
  expect(screen.getByText('3')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Copy inbox URL' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
  expect(await screen.findByText('Inbox URL copied.')).toBeVisible();
  fireEvent.click(within(issued).getByRole('button', { name: 'Copy token' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(token));
  fireEvent.click(screen.getByRole('button', { name: 'I have saved the token' }));
  expect(screen.queryByText(token)).toBeNull();
});

it('disables inputs while a request is pending', async () => {
  const s = server(off); let settle!: () => void;
  mount(vi.fn(() => new Promise<undefined>(resolve => { settle = () => resolve(undefined); })));
  fireEvent.click(await screen.findByRole('button', { name: 'Enable inbox' }));
  expect(await screen.findByText(token)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Rotate token' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Disable inbox' })).toBeDisabled();
  settle();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate token' })).toBeEnabled());
  expect(s.writes).toHaveLength(1);
});

it('rotates with the chosen mode and shows a server refusal as returned', async () => {
  const s = server(on); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Rotate token' }));
  let dialog = screen.getByRole('dialog', { name: 'Rotate inbox token' });
  expect(within(dialog).getByRole('radio', { name: /Keep the previous token/ })).toBeChecked();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(s.writes.at(-1)?.input).toEqual({ operationId: expect.any(String), ifVersion: '7', mode: 'overlap' }));
  expect(await screen.findByText(rotated)).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(screen.getAllByRole('time')).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
  dialog = screen.getByRole('dialog', { name: 'Rotate inbox token' });
  fireEvent.click(within(dialog).getByRole('radio', { name: /Revoke the previous token now/ }));
  vi.mocked(fetch).mockImplementationOnce(async () => botError(409, 'inbox_overlap_active'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  expect(await screen.findByText('The request was not applied.')).toBeVisible();
  expect(screen.getByText('inbox_overlap_active')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
});

it('requires confirmation before disabling and offers enabling again', async () => {
  const s = server(on); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Disable inbox' }));
  let dialog = screen.getByRole('dialog', { name: 'Disable inbox' });
  expect(within(dialog).getByText(/stops accepting messages permanently/)).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(s.writes).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Disable inbox' }));
  dialog = screen.getByRole('dialog', { name: 'Disable inbox' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Disable inbox' }));
  await waitFor(() => expect(s.writes).toEqual([{ path: `/api/v1/assistant-tasks/${taskId}/inbox/disable`, input: { operationId: expect.any(String), ifVersion: '7' } }]));
  expect(await screen.findByRole('button', { name: 'Enable inbox' })).toBeVisible();
});

it('submits the version observed when the confirmation opened and offers Reload on a version conflict', async () => {
  const s = server(on), changed = mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Disable inbox' }));
  mounted.rerender({ task: { ...task, version: '8' } });
  vi.mocked(fetch).mockImplementationOnce(async (url, options) => { s.writes.push({ path: String(url), input: JSON.parse(String(options?.body)) as Record<string, unknown> }); return botError(409, 'version_conflict'); });
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Disable inbox' })).getByRole('button', { name: 'Disable inbox' }));
  await waitFor(() => expect(s.writes).toEqual([{ path: `/api/v1/assistant-tasks/${taskId}/inbox/disable`, input: { operationId: expect.any(String), ifVersion: '7' } }]));
  expect(await screen.findByText(/This task changed since you loaded it/)).toBeVisible();
  expect(screen.getByText('version_conflict')).toBeVisible();
  const reads = s.fetch.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(screen.queryByText(/This task changed since you loaded it/)).toBeNull();
  expect(changed).toHaveBeenCalled();
  await waitFor(() => expect(s.fetch.mock.calls.length).toBeGreaterThan(reads));
  fireEvent.click(screen.getByRole('button', { name: 'Disable inbox' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Disable inbox' })).getByRole('button', { name: 'Disable inbox' }));
  await waitFor(() => expect(s.writes.at(-1)?.input).toEqual({ operationId: expect.any(String), ifVersion: '8' }));
});

it('hides an issued token once the displayed inbox ID changes', async () => {
  const s = server(off); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Enable inbox' }));
  expect(await screen.findByText(token)).toBeVisible();
  s.state.inbox = { ...on, inboxId: botId(93) };
  fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Rotate inbox token' })).getByRole('button', { name: 'Cancel' }));
  vi.mocked(fetch).mockImplementationOnce(async () => botError(409, 'version_conflict'));
  fireEvent.click(screen.getByRole('button', { name: 'Disable inbox' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Disable inbox' })).getByRole('button', { name: 'Disable inbox' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
  expect(await screen.findByText(assistantTaskInboxUrl(botId(93)))).toBeVisible();
  expect(screen.queryByText(token)).toBeNull();
});

it('remounts the subscription panel with a fresh form when the inbox id changes', async () => {
  directories.projects = [{ id: botId(95), name: 'Alpha' }];
  const s = server(on); mount();
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Alpha' }));
  expect(screen.getByRole('group', { name: 'Event types for Alpha' })).toBeVisible();
  const replacement = botId(93), serve = vi.mocked(fetch).getMockImplementation()!;
  let release = () => undefined as void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(fetch).mockImplementation(async (url, options) => { if (String(url) === '/api/v1/me/webhooks?limit=100') await held; return serve(url, options); });
  vi.mocked(fetch).mockImplementationOnce(async () => botError(409, 'version_conflict'));
  s.state.inbox = { ...on, inboxId: replacement };
  fireEvent.click(screen.getByRole('button', { name: 'Disable inbox' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Disable inbox' })).getByRole('button', { name: 'Disable inbox' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));
  expect(await screen.findByText(assistantTaskInboxUrl(replacement))).toBeVisible();
  // The form for the previous inbox is gone before the new inbox's subscription is read.
  expect(screen.queryByRole('checkbox', { name: 'Alpha' })).toBeNull();
  release();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Alpha' })).not.toBeChecked());
  expect(screen.queryByRole('group', { name: 'Event types for Alpha' })).toBeNull();
});

it('reports inbox read failures with a retry', async () => {
  const s = server(on); mount();
  vi.mocked(fetch).mockImplementationOnce(async () => botError(500, 'internal'));
  expect(await screen.findByText('Could not load the inbox.')).toBeVisible();
  s.state.inbox = on;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: 'Rotate token' })).toBeVisible();
});

it('checks an unknown write once against the original inbox operation receipt', async () => {
  const s = server(off); mount();
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  vi.mocked(fetch).mockImplementationOnce(async (_url, options) => { s.writes.push({ path: 'enable', input: JSON.parse(String(options?.body)) as Record<string, unknown> }); throw new TypeError('network'); });
  fireEvent.click(enable);
  expect(await screen.findByText('The result of this request is unknown.')).toBeVisible();
  const id = String(s.writes[0]!.input.operationId);
  vi.mocked(fetch).mockImplementationOnce(async () => botError(404, 'not_found'));
  fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
  expect(await screen.findByText('The server has no record of this request.')).toBeVisible();
  vi.mocked(fetch).mockImplementationOnce(async () => botResponse(receipt('inbox_enable', on, id)));
  fireEvent.click(screen.getByRole('button', { name: 'Check original operation' }));
  expect(await screen.findByText(/The server applied this request/)).toBeVisible();
  expect(screen.getByText(/cannot be shown again/)).toBeVisible();
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter(url => url.includes('-operations/'));
  expect(urls).toEqual([`/api/v1/assistant-tasks/${taskId}/inbox-operations/${id}`, `/api/v1/assistant-tasks/${taskId}/inbox-operations/${id}`]);
});

it('validates inbox payloads and rejects malformed tokens or inconsistent state', async () => {
  const admission = { userId: BOT_USER, onPrincipalMismatch: vi.fn() }, signal = new AbortController().signal;
  vi.stubGlobal('fetch', vi.fn(async () => botResponse({ ...off, enabled: true })));
  await expect(getAssistantTaskInbox(taskId, signal, admission)).rejects.toMatchObject({ kind: 'protocol' });
  vi.stubGlobal('fetch', vi.fn(async () => botResponse(receipt('inbox_enable', on, operationId, 'leaked-secret'))));
  await expect(enableAssistantTaskInbox(taskId, { operationId, ifVersion: '7' }, signal, admission)).rejects.toMatchObject({ name: 'AssistantTaskWriteUnknown' });
  vi.stubGlobal('fetch', vi.fn(async () => botResponse(receipt('inbox_enable', on, operationId, null))));
  await expect(enableAssistantTaskInbox(taskId, { operationId, ifVersion: '7' }, signal, admission)).resolves.toMatchObject({ token: null, inbox: on });
  expect(assistantTaskInboxUrl(inboxId, 'https://daynight.example')).toBe(`https://daynight.example/api/v1/assistant-task-inbox/${inboxId}`);
});
