import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantTask } from '../src/api/assistant-tasks';
import { invalidateAuthRequests } from '../src/api/client';
import type { Project } from '../src/api/types';
import { AssistantTaskSubscriptions, targetsInbox } from '../src/features/bots/AssistantTaskSubscriptions';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, BOT_USER, botError, botId, botResponse } from './helpers/bots';

const directories = vi.hoisted(() => ({ projects: [] as unknown[] }));
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), listProjects: vi.fn(async () => ({ items: directories.projects, nextCursor: null })) }));

const origin = 'https://daynight.example', taskId = botId(70), inboxId = botId(71);
const inboxUrl = `${origin}/api/v1/assistant-task-inbox/${inboxId}`;
const alpha = botId(73), beta = botId(74), personalId = botId(75), otherId = botId(76), subscriptionId = botId(78);
const task: AssistantTask = { id: taskId, ownerUserId: BOT_USER, name: 'Release watcher', purpose: '', scope: '', application: '', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null, version: '3', manualVersion: '1', claimGeneration: '0', claimState: 'unowned', holderBotId: null, credentialOperationId: null, claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME };
const project = (id: string, name: string) => ({ id, name } as Project);
const personal = { kind: 'personal', id: BOT_USER };
type Subscription = { id: string; projectId: string; projectName: string | null; eventTypes: string[]; eligibility: 'eligible' | 'confirmation_required' };
const endpoint = (id: string, url: string, subscriptions: Subscription[], enabled = true, version = '4') => ({
  id, owner: personal, lifecycle: 'active', configVersion: version, deletedAt: null, name: `Endpoint ${id.slice(-2)}`, enabled, destinationRevision: '2',
  destination: { kind: 'http', adapterVersion: '1', url, displayUrl: url }, signing: { scheme: 'standard-webhooks-v1', activeKeyId: botId(79), overlapUntil: null },
  subscriptions, capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: BOT_TIME, updatedAt: BOT_TIME,
});
const summary = (value: ReturnType<typeof endpoint>) => ({ id: value.id, owner: personal, name: value.name, enabled: value.enabled, configVersion: value.configVersion, destination: value.destination, projectCount: value.subscriptions.length, eventTypeCount: 1, lastAttemptAt: null, lastResult: null });
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const alphaCreated = (): Subscription => ({ id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created'], eligibility: 'eligible' });

function server(initial: ReturnType<typeof endpoint>[] = []) {
  const state = { personal: [...initial] }, writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url), method = options?.method ?? 'GET';
    if (method !== 'GET') {
      const text = String(options?.body), body = JSON.parse(text) as Record<string, unknown>;
      writes.push({ method, path, body });
      const create = method === 'POST', endpointId = create ? botId(80) : path.split('/').at(-1)!;
      const before = state.personal.find(item => item.id === endpointId);
      const after = create
        ? endpoint(endpointId, inboxUrl, (body.subscriptions as Subscription[]).map((item, index) => ({ ...item, id: botId(90 + index), projectName: null, eligibility: 'eligible' as const })), true, '1')
        : { ...before!, configVersion: String(Number(before!.configVersion) + 1), ...(body.subscriptions === undefined ? {} : { subscriptions: (body.subscriptions as Subscription[]).map((item, index) => ({ ...item, id: item.id ?? botId(95 + index), projectName: null, eligibility: 'eligible' as const })) }) };
      state.personal = [...state.personal.filter(item => item.id !== endpointId), after];
      const operation = { operationId: body.operationId, kind: create ? 'endpoint.create' : 'endpoint.patch', issuedAt: body.issuedAt, requestSha256: await sha256(text), actorUserId: BOT_USER, owner: personal, endpointId, effect: 'applied', configVersionAfter: after.configVersion, destinationRevisionAfter: create ? '1' : '2', deliveryId: null, generationAfter: null, keyId: null, overlapUntil: null, recordedAt: BOT_TIME, expiresAt: '2026-12-04T12:00:00Z' };
      return botResponse({ operation, endpoint: after }, BOT_USER, create ? 201 : 200);
    }
    if (path === '/api/v1/me/webhooks?limit=100') return botResponse({ items: state.personal.map(summary), nextCursor: null });
    const found = state.personal.find(item => path === `/api/v1/me/webhooks/${item.id}`);
    return found ? botResponse(found) : botError(404, 'not_found');
  });
  vi.stubGlobal('fetch', fetch);
  return { state, writes, fetch };
}
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
function mount(named: AssistantTask = task) {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const panel = (active: boolean) => <TaskCacheProvider scope={scope}><AssistantTaskSubscriptions task={named} inboxId={inboxId} active={active} serviceOrigin={origin} /></TaskCacheProvider>;
  const view = renderWithLocale(panel(true), { locale: 'en' });
  return { setActive: (active: boolean) => view.rerender(panel(active)) };
}
beforeEach(() => { directories.projects = [project(alpha, 'Alpha'), project(beta, 'Beta')]; sessionStorage.clear(); });
/** Event checkboxes are bound to one project and appear only while that project is checked. */
const eventsOf = (projectName: string) => within(screen.getByRole('group', { name: `Event types for ${projectName}` }));
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); invalidateAuthRequests(); vi.unstubAllGlobals(); });

it('matches endpoint targets by origin and exact inbox path', () => {
  expect(targetsInbox(`${inboxUrl}?trace=1`, inboxUrl)).toBe(true);
  // The public route and its target check require the exact inbox path.
  expect(targetsInbox(`${inboxUrl}/`, inboxUrl)).toBe(false);
  expect(targetsInbox(`https://other.example/api/v1/assistant-task-inbox/${inboxId}`, inboxUrl)).toBe(false);
  expect(targetsInbox(`${origin}/api/v1/assistant-task-inbox/${botId(1)}`, inboxUrl)).toBe(false);
  expect(targetsInbox(null, inboxUrl)).toBe(false);
  expect(targetsInbox('::', inboxUrl)).toBe(false);
});

it('creates a personal endpoint targeting the token-free inbox URL with per-project event types', async () => {
  const s = server([endpoint(otherId, 'https://receiver.example/hook', [])]); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Create subscription' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Select at least one project and at least one event type for each selected project.');
  expect(s.writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  // A checked project without event types is not silently dropped from the submitted list.
  expect(screen.getByRole('alert')).toHaveTextContent('at least one event type for each selected project');
  expect(s.writes).toHaveLength(0);
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task deleted' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Discussion message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'POST', path: '/api/v1/me/webhooks', body: {
    expectedUserId: BOT_USER, name: 'Assistant inbox · Release watcher', enabled: true,
    destination: { kind: 'http', adapterVersion: '1', configuration: { url: inboxUrl } },
    subscriptions: [{ id: null, projectId: alpha, eventTypes: ['task.created'] }, { id: null, projectId: beta, eventTypes: ['task.deleted', 'task.thread_posted'] }],
  } });
  expect(JSON.stringify(s.writes[0]!.body)).not.toContain('dnib_');
  expect(await screen.findByRole('link', { name: 'Manage on the Webhooks page' })).toHaveAttribute('href', `/webhooks?owner=personal&endpointId=${botId(80)}`);
  expect(screen.getByText('Endpoint 80')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Save subscription' })).toBeEnabled();
});

it('edits the personal endpoint targeting the inbox with its loaded version and without changing its enabled state', async () => {
  const s = server([endpoint(otherId, `${inboxUrl}/`, []), endpoint(personalId, `${inboxUrl}?source=daynight`, [alphaCreated()])]); mount();
  expect(await screen.findByRole('checkbox', { name: 'Alpha' })).toBeChecked();
  expect(screen.queryByText(`Endpoint ${otherId.slice(-2)}`)).toBeNull();
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' })).toBeChecked();
  expect(screen.queryByRole('group', { name: 'Event types for Beta' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'PATCH', path: `/api/v1/me/webhooks/${personalId}`, body: { ifVersion: '4', subscriptions: [
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.created', 'task.paused'] },
    { id: null, projectId: beta, eventTypes: ['task.created'] },
  ] } });
  expect(s.writes[0]!.body).not.toHaveProperty('enabled');
});

it('preserves per-project event selections and applies only the changed events', async () => {
  const linked = endpoint(personalId, inboxUrl, [alphaCreated(), { id: botId(84), projectId: beta, projectName: 'Beta', eventTypes: ['task.deleted'], eligibility: 'eligible' }]);
  const s = server([linked]); mount();
  await screen.findByRole('button', { name: 'Save subscription' });
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task deleted' })).not.toBeChecked();
  expect(eventsOf('Beta').getByRole('checkbox', { name: 'Task deleted' })).toBeChecked();
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  expect(screen.getByRole('alert')).toHaveTextContent('at least one event type for each selected project');
  expect(s.writes).toHaveLength(0);
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.paused'] },
    { id: botId(84), projectId: beta, eventTypes: ['task.deleted', 'task.paused'] },
  ]);
});

it('keeps every independent subscription of a project when saving', async () => {
  const second = botId(85);
  const s = server([endpoint(personalId, inboxUrl, [alphaCreated(), { id: second, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.deleted'], eligibility: 'eligible' }])]); mount();
  await screen.findByRole('button', { name: 'Save subscription' });
  expect(screen.getAllByRole('checkbox', { name: 'Alpha' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.created', 'task.paused'] },
    { id: second, projectId: alpha, eventTypes: ['task.deleted'] },
  ]);
});

it('keeps projects the endpoint subscribes to outside the accessible list in the form and the submission', async () => {
  directories.projects = [project(beta, 'Beta')];
  const s = server([endpoint(personalId, inboxUrl, [{ ...alphaCreated(), projectName: null }, { id: botId(84), projectId: beta, projectName: 'Beta', eventTypes: ['task.created'], eligibility: 'eligible' }])]); mount();
  expect(await screen.findByRole('checkbox', { name: alpha })).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([{ id: subscriptionId, projectId: alpha, eventTypes: ['task.created'] }, { id: botId(84), projectId: beta, eventTypes: ['task.created'] }]);
});

it('reports a version conflict and discards the edits only when the user reloads', async () => {
  const linked = endpoint(personalId, inboxUrl, [alphaCreated()]);
  const s = server([linked]); mount();
  await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  s.state.personal = [{ ...linked, configVersion: '5', subscriptions: [...linked.subscriptions, { id: botId(84), projectId: beta, projectName: 'Beta', eventTypes: ['task.deleted'], eligibility: 'eligible' }] }];
  s.fetch.mockImplementationOnce(async () => botError(409, 'version_conflict'));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This subscription changed elsewhere, so your change was not saved.');
  // Nothing is merged or reloaded behind the user's back.
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Beta' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeChecked());
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' })).not.toBeChecked();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'PATCH', body: { ifVersion: '5' } });
});

it('keeps the edits and a pending conflict when the panel becomes active again', async () => {
  const linked = endpoint(personalId, inboxUrl, [alphaCreated()]);
  const s = server([linked]); const view = mount();
  await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  s.state.personal = [{ ...linked, configVersion: '5' }];
  s.fetch.mockImplementationOnce(async () => botError(409, 'version_conflict'));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('This subscription changed elsewhere');
  const reads = s.fetch.mock.calls.length;
  view.setActive(false); view.setActive(true);
  await Promise.resolve();
  expect(s.fetch).toHaveBeenCalledTimes(reads);
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' })).toBeChecked();
  expect(screen.getByRole('alert')).toHaveTextContent('This subscription changed elsewhere');
});

it('releases a create refused for Webhook maintenance and keeps the edits', async () => {
  const s = server(); mount();
  await screen.findByRole('button', { name: 'Create subscription' });
  s.fetch.mockImplementationOnce(async () => botError(503, 'webhooks_unavailable'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The Webhook request failed. webhooks_unavailable');
  expect(screen.queryByRole('button', { name: 'Check operation' })).toBeNull();
  expect(s.fetch.mock.calls.some(([url]) => String(url).includes('/operations/'))).toBe(false);
  expect(sessionStorage.length).toBe(0);
  expect(screen.getByRole('checkbox', { name: 'Alpha' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([{ id: null, projectId: alpha, eventTypes: ['task.created'] }]);
});

it('shows the service error code as returned and keeps the edits', async () => {
  const s = server([endpoint(personalId, inboxUrl, [alphaCreated()])]); mount();
  await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task created' }));
  s.fetch.mockImplementationOnce(async () => botError(422, 'webhook_project_ineligible'));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The Webhook request failed. webhook_project_ineligible');
  expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([{ id: subscriptionId, projectId: alpha, eventTypes: ['task.created'] }]);
});

it('checks an unknown create outcome by its operation and then loads the created endpoint', async () => {
  const s = server(); mount();
  await screen.findByRole('button', { name: 'Create subscription' });
  const original = s.fetch.getMockImplementation()!;
  let receipt: unknown = null, lookups = 0;
  s.fetch.mockImplementation(async (url, options) => {
    const path = String(url), method = options?.method ?? 'GET';
    if (method === 'POST') { receipt = (await (await original(url, options)).json() as { operation: unknown }).operation; throw new TypeError('Response lost'); }
    if (path.startsWith('/api/v1/me/webhooks/operations/')) return lookups++ === 0 ? botError(500, 'internal') : botResponse(receipt);
    return original(url, options);
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check operation' }));
  const save = await screen.findByRole('button', { name: 'Save subscription' });
  expect(lookups).toBe(2);
  expect(s.writes).toHaveLength(1);
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(save);
  await waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]).toMatchObject({ method: 'PATCH', path: `/api/v1/me/webhooks/${botId(80)}`, body: { ifVersion: '1' } });
});

it('retries a failed subscription read', async () => {
  const s = server();
  s.fetch.mockImplementationOnce(async () => botError(500, 'internal'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Webhook subscriptions.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: 'Create subscription' })).toBeEnabled();
});

it('disables the form while a save is pending', async () => {
  const s = server([endpoint(personalId, inboxUrl, [alphaCreated()])]); mount();
  await screen.findByRole('checkbox', { name: 'Alpha' });
  const serve = s.fetch.getMockImplementation()!;
  let release = () => undefined as void;
  const held = new Promise<void>(resolve => { release = resolve; });
  s.fetch.mockImplementation(async (url, options) => { if ((options?.method ?? 'GET') === 'PATCH') await held; return serve(url, options); });
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task deleted' })).toBeDisabled());
  expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save subscription' })).toBeDisabled();
  release();
  await waitFor(() => expect(s.writes).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeEnabled());
});

it('keeps a paused endpoint paused on save and leaves resuming to the Webhooks page', async () => {
  const s = server([endpoint(personalId, inboxUrl, [{ ...alphaCreated(), eventTypes: ['task.created', 'task.deleted'] }], false)]); mount();
  expect(await screen.findByText(/This endpoint is paused/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /Resume|Pause|Delete|Confirm scope/ })).toBeNull();
  expect(screen.getByRole('link', { name: 'Manage on the Webhooks page' })).toHaveAttribute('href', `/webhooks?owner=personal&endpointId=${personalId}`);
  expect(screen.getByRole('link', { name: 'Open Webhooks' })).toHaveAttribute('href', '/webhooks?owner=personal');
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task deleted' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body).not.toHaveProperty('enabled');
  expect(await screen.findByText(/This endpoint is paused/)).toBeVisible();
});

it('truncates the generated endpoint name on code point boundaries', async () => {
  const s = server(); mount({ ...task, name: `${'a'.repeat(81)}\u{1F680}` });
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  const name = String(s.writes[0]!.body.name);
  expect(name).toBe(`Assistant inbox · ${'a'.repeat(81)}\u{1F680}`);
  expect([...name]).toHaveLength(100);
  expect(name.isWellFormed()).toBe(true);
});
