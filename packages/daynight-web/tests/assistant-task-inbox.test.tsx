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
  return { state, writes };
}
function mount(onChanged = vi.fn(async () => undefined)) {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const view = (props: { readonly task: AssistantTask; readonly enabled: boolean }) => <TaskCacheProvider scope={scope}><AssistantTaskInbox task={props.task} enabled={props.enabled} disabled={false} onChanged={onChanged} /></TaskCacheProvider>;
  const { rerender } = renderWithLocale(view({ task, enabled: true }), { locale: 'en' });
  mounted.rerender = props => rerender(view(props));
  return onChanged;
}
const mounted: { rerender: (props: { readonly task: AssistantTask; readonly enabled: boolean }) => void } = { rerender: () => undefined };

it('routes the inbox tab of an assistant task', () => {
  expect(parseAuthRoute(`/bots/tasks/${taskId}`, '?tab=inbox')).toEqual({ kind: 'assistantTask', taskId, tab: 'inbox' });
});

it('enables the inbox, shows the token once and the token-free URL with copy actions', async () => {
  const s = server(off), changed = mount();
  const writeText = vi.fn(async () => undefined); vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  fireEvent.click(await screen.findByRole('button', { name: 'Enable inbox' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.path).toBe(`/api/v1/assistant-tasks/${taskId}/inbox/enable`);
  expect(s.writes[0]!.input).toEqual({ operationId: expect.any(String), ifVersion: '7' });
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

it('rotates with overlap by default and only immediately while an overlap token is still valid', async () => {
  const s = server(on); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Rotate token' }));
  let dialog = screen.getByRole('dialog', { name: 'Rotate inbox token' });
  expect(within(dialog).getByRole('radio', { name: /Keep the previous token/ })).toBeChecked();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(s.writes.at(-1)?.input).toEqual({ operationId: expect.any(String), ifVersion: '7', mode: 'overlap' }));
  expect(await screen.findByText(rotated)).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await screen.findByText('Previous token valid until');
  await waitFor(() => expect(screen.getAllByRole('time')).toHaveLength(3));
  fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
  dialog = screen.getByRole('dialog', { name: 'Rotate inbox token' });
  expect(within(dialog).getByRole('radio', { name: /Keep the previous token/ })).toBeDisabled();
  expect(within(dialog).getByRole('radio', { name: /Revoke the previous token now/ })).toBeChecked();
  expect(within(dialog).getByText(/still in its overlap period/)).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(s.writes.at(-1)?.input).toMatchObject({ mode: 'immediate' }));
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
  expect(screen.queryByText(/assistant-task-inbox/)).toBeNull();
});

it('keeps the inbox state on refused writes and reports read failures', async () => {
  const s = server(on); mount();
  vi.mocked(fetch).mockImplementationOnce(async () => botError(500, 'internal'));
  expect(await screen.findByText('Could not load the inbox.')).toBeVisible();
  s.state.inbox = on;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: 'Rotate token' })).toBeVisible();
});

it('checks an unknown inbox write against the inbox operation receipt', async () => {
  server(off); mount();
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  vi.mocked(fetch).mockImplementationOnce(async () => { throw new TypeError('network'); });
  fireEvent.click(enable);
  fireEvent.click(await screen.findByRole('button', { name: 'Check current result' }));
  expect(await screen.findByText(/No receipt was found for this request/)).toBeVisible();
  expect(screen.getByText(/Current data was read/)).toBeVisible();
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
  expect(urls.some(url => url.startsWith(`/api/v1/assistant-tasks/${taskId}/inbox-operations/`))).toBe(true);
  expect(urls.some(url => url.includes('/claim-operations/'))).toBe(false);
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

it('submits the confirmed task version and requires a new confirmation after the task changes', async () => {
  const s = server(on); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Disable inbox' }));
  mounted.rerender({ task: { ...task, version: '8' }, enabled: true });
  const dialog = screen.getByRole('dialog', { name: 'Disable inbox' });
  expect(within(dialog).getByRole('alert')).toHaveTextContent(/changed after you opened this confirmation/);
  expect(within(dialog).getByRole('button', { name: 'Disable inbox' })).toBeDisabled();
  fireEvent.submit(within(dialog).getByRole('button', { name: 'Disable inbox' }).closest('form')!);
  expect(s.writes).toEqual([]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  mounted.rerender({ task: { ...task, version: '8' }, enabled: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate token' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
  mounted.rerender({ task: { ...task, version: '8' }, enabled: true });
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Rotate inbox token' })).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(s.writes.at(-1)?.input).toEqual({ operationId: expect.any(String), ifVersion: '8', mode: 'overlap' }));
});

it('pairs the submitted version with the displayed inbox instead of a newer independently loaded task version', async () => {
  const s = server(on); mount();
  await screen.findByRole('button', { name: 'Disable inbox' });
  const replacement = botId(93);
  let respond!: () => void;
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementationOnce((url, options) => new Promise(resolve => { respond = () => resolve(original(url, options)); }));
  s.state.inbox = { ...on, inboxId: replacement };
  mounted.rerender({ task: { ...task, version: '9' }, enabled: true });
  expect(screen.getByText(assistantTaskInboxUrl(inboxId))).toBeVisible();
  expect(screen.getByRole('button', { name: 'Disable inbox' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Rotate token' })).toBeDisabled();
  await waitFor(() => expect(respond).toBeDefined());
  respond();
  expect(await screen.findByText(assistantTaskInboxUrl(replacement))).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Disable inbox' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Disable inbox' })).getByRole('button', { name: 'Disable inbox' }));
  await waitFor(() => expect(s.writes.at(-1)?.input).toEqual({ operationId: expect.any(String), ifVersion: '9' }));
});

it('keeps a token issued while the inbox tab was hidden', async () => {
  server(off); const changed = mount();
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  let respond!: () => void;
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementationOnce((url, options) => new Promise(resolve => { respond = () => resolve(original(url, options)); }));
  fireEvent.click(enable);
  await waitFor(() => expect(respond).toBeDefined());
  mounted.rerender({ task, enabled: false });
  respond();
  await waitFor(() => expect(changed).toHaveBeenCalled());
  mounted.rerender({ task, enabled: true });
  expect(within(await screen.findByRole('group', { name: 'New token' })).getByText(token)).toBeVisible();
});

it('reports a confirmed inbox receipt and explains that its token cannot be recovered', async () => {
  const s = server(off); mount();
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    const path = String(url);
    if (options?.method === 'POST') { await original(url, options); throw new TypeError('network'); }
    if (path.startsWith(`/api/v1/assistant-tasks/${taskId}/inbox-operations/`)) return botResponse(receipt('inbox_enable', on, String(s.writes[0]!.input.operationId)));
    return original(url, options);
  });
  fireEvent.click(enable);
  fireEvent.click(await screen.findByRole('button', { name: 'Check current result' }));
  expect(await screen.findByText(/receipt confirms this request was applied/)).toBeVisible();
  expect(screen.getByText(/its receipt cannot return it/)).toBeVisible();
  expect(screen.queryByText(/No receipt was found/)).toBeNull();
  expect(screen.queryByRole('group', { name: 'New token' })).toBeNull();
});

it('shows the issued token without waiting for the task detail refresh', async () => {
  server(off); mount(vi.fn(() => new Promise<undefined>(() => undefined)));
  fireEvent.click(await screen.findByRole('button', { name: 'Enable inbox' }));
  expect(within(await screen.findByRole('group', { name: 'New token' })).getByText(token)).toBeVisible();
});

it('retires the token once a later snapshot shows its credential rotated, replaced or disabled', async () => {
  const s = server(off); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Enable inbox' }));
  await screen.findByRole('group', { name: 'New token' });
  mounted.rerender({ task: { ...task, version: '8' }, enabled: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate token' })).toBeEnabled());
  expect(screen.getByRole('group', { name: 'New token' })).toBeVisible();
  s.state.inbox = { ...on, rotatedAt: '2026-11-05T12:00:00Z' };
  mounted.rerender({ task: { ...task, version: '9' }, enabled: true });
  await waitFor(() => expect(screen.queryByRole('group', { name: 'New token' })).toBeNull());
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
  s.state.inbox = { ...on, inboxId: replacement };
  mounted.rerender({ task: { ...task, version: '9' }, enabled: true });
  expect(await screen.findByText(assistantTaskInboxUrl(replacement))).toBeVisible();
  // The form for the previous inbox is gone before the new inbox's subscription is read.
  expect(screen.queryByRole('checkbox', { name: 'Alpha' })).toBeNull();
  release();
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Alpha' })).not.toBeChecked());
  expect(screen.queryByRole('group', { name: 'Event types for Alpha' })).toBeNull();
});

it('retires the token when an inbox read started after issuance shows a replacement while the task version lags', async () => {
  const s = server(off); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Enable inbox' }));
  await screen.findByRole('group', { name: 'New token' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate token' })).toBeVisible());
  expect(screen.getByRole('group', { name: 'New token' })).toBeVisible();
  // Another tab disabled and re-enabled the inbox; the task detail read still reports the version before the issuing write.
  s.state.inbox = { ...on, inboxId: botId(94) };
  fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByText(assistantTaskInboxUrl(botId(94)))).toBeVisible();
  await waitFor(() => expect(screen.queryByRole('group', { name: 'New token' })).toBeNull());
  expect(screen.queryByText(token)).toBeNull();
});

it('publishes a confirmed receipt when the following task refresh fails and reports it as a read failure', async () => {
  const s = server(off); mount(vi.fn(async () => { throw botError(500, 'internal'); }));
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') { await original(url, options); throw new TypeError('network'); }
    if (String(url).startsWith(`/api/v1/assistant-tasks/${taskId}/inbox-operations/`)) return botResponse(receipt('inbox_rotate_immediate', on, String(s.writes[0]!.input.operationId)));
    return original(url, options);
  });
  fireEvent.click(enable);
  fireEvent.click(await screen.findByRole('button', { name: 'Check current result' }));
  expect(await screen.findByText('The receipt confirms this request was applied.')).toBeVisible();
  expect(screen.getByText(/its receipt cannot return it/)).toBeVisible();
  expect(screen.getByText(/Could not read the current result/)).toBeVisible();
  expect(screen.queryByText('The change was not accepted.')).toBeNull();
  expect(screen.getByRole('button', { name: 'I reviewed the current result' })).toBeEnabled();
});

it('publishes a confirmed receipt while the following task refresh stalls and keeps new writes blocked until it settles', async () => {
  let settle: (() => void) | null = null, stall = false;
  const s = server(off); mount(vi.fn(async () => { if (stall) await new Promise<void>(resolve => { settle = resolve; }); }));
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') { await original(url, options); throw new TypeError('network'); }
    if (String(url).startsWith(`/api/v1/assistant-tasks/${taskId}/inbox-operations/`)) return botResponse(receipt('inbox_rotate_immediate', on, String(s.writes[0]!.input.operationId)));
    return original(url, options);
  });
  fireEvent.click(enable);
  const check = await screen.findByRole('button', { name: 'Check current result' });
  stall = true;
  fireEvent.click(check);
  expect(await screen.findByText('The receipt confirms this request was applied.')).toBeVisible();
  expect(screen.getByText(/its receipt cannot return it/)).toBeVisible();
  expect(settle).not.toBeNull();
  expect(check).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current result' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Check current result' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Rotate token' })).toBeDisabled();
  settle!();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Rotate token' })).toBeEnabled());
});

it('offers the acknowledgement of a missing receipt only after a fresh inbox snapshot is shown', async () => {
  const s = server(off); mount();
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  const original = vi.mocked(fetch).getMockImplementation()!;
  let respond: (() => void) | null = null, fail = false;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (options?.method === 'POST') { await original(url, options); throw new TypeError('network'); }
    if (String(url) === `/api/v1/assistant-tasks/${taskId}/inbox` && s.writes.length > 0) {
      if (fail) return botError(500, 'internal');
      await new Promise<void>(resolve => { respond = resolve; });
    }
    return original(url, options);
  });
  fireEvent.click(enable);
  fireEvent.click(await screen.findByRole('button', { name: 'Check current result' }));
  await waitFor(() => expect(respond).not.toBeNull());
  expect(screen.queryByRole('button', { name: 'I reviewed the current result' })).toBeNull();
  expect(screen.queryByText(/No receipt was found/)).toBeNull();
  respond!();
  expect(await screen.findByRole('button', { name: 'I reviewed the current result' })).toBeVisible();
  expect(screen.getByText(assistantTaskInboxUrl(inboxId))).toBeVisible();
  fail = true;
  fireEvent.click(screen.getByRole('button', { name: 'Check current result' }));
  expect(await screen.findByText(/Could not read the current result/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'I reviewed the current result' })).toBeNull();
});

it('lets the owner check and acknowledge a confirmed receipt while the inbox read fails', async () => {
  const s = server(off); mount();
  const enable = await screen.findByRole('button', { name: 'Enable inbox' });
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    const path = String(url);
    if (options?.method === 'POST') { await original(url, options); throw new TypeError('network'); }
    if (path === `/api/v1/assistant-tasks/${taskId}/inbox`) return botError(500, 'internal');
    if (path.startsWith(`/api/v1/assistant-tasks/${taskId}/inbox-operations/`)) return botResponse(receipt('inbox_enable', on, String(s.writes[0]!.input.operationId)));
    return original(url, options);
  });
  fireEvent.click(enable);
  const check = await screen.findByRole('button', { name: 'Check current result' });
  fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByText('Could not load the inbox.')).toBeVisible();
  expect(check).toBeEnabled();
  fireEvent.click(check);
  expect(await screen.findByText('The receipt confirms this request was applied.')).toBeVisible();
  const reviewed = screen.getByRole('button', { name: 'I reviewed the current result' });
  expect(reviewed).toBeEnabled();
  fireEvent.click(reviewed);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Check current result' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Enable inbox' })).toBeDisabled();
});

it('closes the confirmation when a rotation outcome is unknown so recovery happens beside the inbox', async () => {
  server(on); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Rotate token' }));
  const dialog = screen.getByRole('dialog', { name: 'Rotate inbox token' });
  vi.mocked(fetch).mockImplementationOnce(async () => { throw new TypeError('network'); });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('button', { name: 'Check current result' })).toBeVisible();
  expect(screen.getByText(assistantTaskInboxUrl(inboxId))).toBeVisible();
});
