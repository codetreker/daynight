import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantTaskCreate } from '../src/features/bots/AssistantTaskCreate';
import { renderWithLocale } from './helpers/renderWithLocale';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { BOT_TIME, botDefinition, botId } from './helpers/bots';
import { invalidateAuthRequests } from '../src/api/client';
import type { CreateAssistantTaskInput } from '../src/api/assistant-tasks';

let account = 600;
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); invalidateAuthRequests(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const storageKey = (userId: string) => `daynight:assistant-task-create:${userId}:ordinary`;
const response = (userId: string, value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': userId } });
const taskResponse = (userId: string, input: CreateAssistantTaskInput) => response(userId, {
  id: input.id, ownerUserId: userId, name: input.name, purpose: input.purpose, scope: input.scope, application: input.application ?? '', kind: input.kind, takeover: input.takeover, trigger: input.trigger ?? null,
  state: 'active', version: '1', manualVersion: '1', claimGeneration: '0', claimState: 'unowned', holderBotId: null, credentialOperationId: null, claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME,
});
function context(userId = botId(++account)) {
  const scope = createTaskCacheScope({ userId, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  return { userId, scope, close: vi.fn(), created: vi.fn() };
}
function mount(owner: ReturnType<typeof context>) {
  return renderWithLocale(<TaskCacheProvider scope={owner.scope}><AssistantTaskCreate watchdog={false} bots={[botDefinition(1)]} enabled onClose={owner.close} onCreated={owner.created} /></TaskCacheProvider>, { locale: 'en' });
}
function fill() {
  for (const [label, value] of [['Name', 'Coordination'], ['Purpose', 'Review outcomes'], ['Scope', 'My work'], ['Initial manual', 'Inspect before acting']] as const) fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Create assistant task' }));
}
it('retains the original unknown creation across closing and checks that ID without another POST', async () => {
  const owner = context(); let input!: CreateAssistantTaskInput;
  const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') { input = JSON.parse(String(options.body)); throw new TypeError('response lost'); }
    return taskResponse(owner.userId, input);
  }); vi.stubGlobal('fetch', fetch);
  const first = mount(owner); fill();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());
  expect(JSON.parse(sessionStorage.getItem(storageKey(owner.userId))!).input.id).toBe(input.id);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(owner.close).toHaveBeenCalledOnce(); first.unmount();
  mount(owner);
  expect(screen.getByText(input.id)).toBeVisible(); expect(screen.getByRole('button', { name: 'Create assistant task' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check current result' })); await screen.findByText(/Current data was read/);
  expect(fetch.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  expect(fetch.mock.calls.at(-1)![0]).toBe(`/api/v1/assistant-tasks/${input.id}`);
  expect(owner.created).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current result' }));
  expect(owner.created).toHaveBeenCalledWith(input.id);
});
it('restores a persisted original request after reload and does not report a definite 404 as creation', async () => {
  const owner = context(), id = botId(690);
  sessionStorage.setItem(storageKey(owner.userId), JSON.stringify({ kind: 'ordinary', input: { id, name: 'Persisted draft', purpose: 'Review', scope: 'My work', kind: 'once', takeover: 'manual', manual: { body: 'Original manual', rules: [] } } }));
  const fetch = vi.fn(async (_url: string) => response(owner.userId, { error: { code: 'not_found', message: 'Not found', requestId: 'original-creation-read' } }, 404)); vi.stubGlobal('fetch', fetch);
  mount(owner);
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Persisted draft'); expect(screen.getByText(id)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Check current result' })); await screen.findByText('The change was not accepted.');
  expect(owner.created).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current result' }));
  expect(owner.created).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: 'Create assistant task' })).toBeEnabled();
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![0]).toBe(`/api/v1/assistant-tasks/${id}`);
});
it('blocks closing an in-flight creation and fences its late result after navigation', async () => {
  const owner = context(); let input!: CreateAssistantTaskInput, finish!: (value: Response) => void;
  const fetch = vi.fn(async (_url: string, options?: RequestInit) => { input = JSON.parse(String(options?.body)); return new Promise<Response>(resolve => { finish = resolve; }); }); vi.stubGlobal('fetch', fetch);
  const view = mount(owner); fill(); await waitFor(() => expect(finish).toBeDefined());
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled(); fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true })); expect(owner.close).not.toHaveBeenCalled();
  view.unmount(); const other = context(); mount(other);
  await act(async () => finish(taskResponse(owner.userId, input)));
  expect(owner.created).not.toHaveBeenCalled(); expect(other.created).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  expect(sessionStorage.getItem(storageKey(owner.userId))).toBeNull();
});

it('clears a formerly observed creation target when a later check returns 404', async () => {
  const owner = context();
  const input: CreateAssistantTaskInput = { id: botId(691), name: 'Pending', purpose: 'Review', scope: 'My work', kind: 'once', takeover: 'manual', manual: { body: 'Observe facts', rules: [] } };
  sessionStorage.setItem(storageKey(owner.userId), JSON.stringify({ kind: 'ordinary', input }));
  const fetch = vi.fn().mockResolvedValueOnce(taskResponse(owner.userId, input)).mockResolvedValueOnce(response(owner.userId, { error: { code: 'not_found', message: 'Not found', requestId: 'later-read' } }, 404)); vi.stubGlobal('fetch', fetch);
  mount(owner);
  fireEvent.click(screen.getByRole('button', { name: 'Check current result' })); await screen.findByText(/Current data was read/);
  fireEvent.click(screen.getByRole('button', { name: 'Check current result' })); await screen.findByText('The change was not accepted.');
  fireEvent.click(screen.getByRole('button', { name: 'I reviewed the current result' }));
  expect(owner.created).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(2);
});
