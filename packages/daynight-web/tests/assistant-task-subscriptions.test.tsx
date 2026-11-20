import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantTask } from '../src/api/assistant-tasks';
import { invalidateAuthRequests } from '../src/api/client';
import type { Team } from '../src/api/teams';
import type { Project } from '../src/api/types';
import { AssistantTaskSubscriptions, canSelfSubscribe, targetsAnyInbox, targetsInbox } from '../src/features/bots/AssistantTaskSubscriptions';
import { createTaskCacheScope, TaskCacheProvider } from '../src/features/task-cache/TaskCacheProvider';
import { renderWithLocale } from './helpers/renderWithLocale';
import { BOT_TIME, BOT_USER, botError, botId, botResponse } from './helpers/bots';

const directories = vi.hoisted(() => ({ projects: [] as unknown[], teams: [] as unknown[], expansion: true }));
vi.mock('../src/api/client', async original => ({ ...await original<typeof import('../src/api/client')>(), listProjects: vi.fn(async () => ({ items: directories.projects, nextCursor: null })) }));
vi.mock('../src/api/webhooks', async original => ({ ...await original<typeof import('../src/api/webhooks')>(), getWebhookCatalog: vi.fn(async () => ({ items: [], service: { configurationExpansionAvailable: directories.expansion, dispatchEnabled: true } })) }));
vi.mock('../src/api/teams', async original => ({ ...await original<typeof import('../src/api/teams')>(), listTeams: vi.fn(async () => ({ items: directories.teams, nextCursor: null })) }));

const origin = 'https://daynight.example', taskId = botId(70), inboxId = botId(71), teamId = botId(72);
const inboxUrl = `${origin}/api/v1/assistant-task-inbox/${inboxId}`;
const alpha = botId(73), beta = botId(74), personalId = botId(75), otherId = botId(76), teamEndpointId = botId(77), subscriptionId = botId(78);
const task: AssistantTask = { id: taskId, ownerUserId: BOT_USER, name: 'Release watcher', purpose: '', scope: '', application: '', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null, version: '3', manualVersion: '1', claimGeneration: '0', claimState: 'unowned', holderBotId: null, credentialOperationId: null, claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME };
const project = (id: string, name: string) => ({ id, name } as Project);
const team = { id: teamId, kind: 'ordinary', name: 'Ops' } as Team;
const personal = { kind: 'personal', id: BOT_USER };
type Subscription = { id: string; projectId: string; projectName: string | null; eventTypes: string[]; eligibility: 'eligible' };
const endpoint = (id: string, url: string, subscriptions: Subscription[], enabled = true, version = '4') => ({
  id, owner: personal, lifecycle: 'active', configVersion: version, deletedAt: null, name: `Endpoint ${id.slice(-2)}`, enabled, destinationRevision: '2',
  destination: { kind: 'http', adapterVersion: '1', url, displayUrl: url }, signing: { scheme: 'standard-webhooks-v1', activeKeyId: botId(79), overlapUntil: null },
  subscriptions, capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: BOT_TIME, updatedAt: BOT_TIME,
});
const summary = (value: ReturnType<typeof endpoint>, owner: { kind: string; id: string } = personal) => ({ id: value.id, owner, name: value.name, enabled: value.enabled, configVersion: value.configVersion, destination: value.destination, projectCount: value.subscriptions.length, eventTypeCount: 1, lastAttemptAt: null, lastResult: null });
const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

function server(initial: { personal?: ReturnType<typeof endpoint>[]; team?: ReturnType<typeof endpoint>[] } = {}) {
  const state = { personal: [...initial.personal ?? []], team: [...initial.team ?? []] }, writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url), method = options?.method ?? 'GET';
    if (method !== 'GET') {
      const text = String(options?.body), body = JSON.parse(text) as Record<string, unknown>;
      writes.push({ method, path, body });
      const create = method === 'POST', endpointId = create ? botId(80) : path.split('/').at(-1)!;
      const before = state.personal.find(item => item.id === endpointId);
      const kind = create ? 'endpoint.create' : method === 'PATCH' ? 'endpoint.patch' : 'endpoint.delete';
      const after = create
        ? endpoint(endpointId, inboxUrl, (body.subscriptions as Subscription[]).map((item, index) => ({ ...item, id: botId(90 + index), projectName: null, eligibility: 'eligible' as const })), true, '1')
        : { ...before!, configVersion: String(Number(before!.configVersion) + 1), ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }) };
      if (method === 'DELETE') state.personal = state.personal.filter(item => item.id !== endpointId);
      else state.personal = [...state.personal.filter(item => item.id !== endpointId), after];
      const operation = { operationId: body.operationId, kind, issuedAt: body.issuedAt, requestSha256: await sha256(text), actorUserId: BOT_USER, owner: personal, endpointId, effect: 'applied', configVersionAfter: after.configVersion, destinationRevisionAfter: create ? '1' : '2', deliveryId: null, generationAfter: null, keyId: null, overlapUntil: null, recordedAt: BOT_TIME, expiresAt: '2026-12-04T12:00:00Z' };
      const view = method === 'DELETE' ? { id: endpointId, owner: personal, lifecycle: 'deleted', configVersion: after.configVersion, deletedAt: BOT_TIME } : after;
      return botResponse({ operation, endpoint: view }, BOT_USER, create ? 201 : 200);
    }
    if (path === '/api/v1/me/webhooks?limit=100') return botResponse({ items: state.personal.map(item => summary(item)), nextCursor: null });
    if (path === `/api/v1/teams/${teamId}/webhooks?limit=100`) return botResponse({ items: state.team.map(item => summary(item, { kind: 'team', id: teamId })), nextCursor: null });
    const found = state.personal.find(item => path === `/api/v1/me/webhooks/${item.id}`);
    return found ? botResponse(found) : botError(404, 'not_found');
  });
  vi.stubGlobal('fetch', fetch);
  return { state, writes, fetch };
}
const scopes: ReturnType<typeof createTaskCacheScope>[] = [];
function mount(props: Partial<{ inboxId: string | null; inboxEnabled: boolean; serviceOrigin: string }> = {}) {
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  renderWithLocale(<TaskCacheProvider scope={scope}><AssistantTaskSubscriptions task={task} inboxId={inboxId} inboxEnabled active serviceOrigin={origin} {...props} /></TaskCacheProvider>, { locale: 'en' });
}
beforeEach(() => { directories.projects = [project(alpha, 'Alpha'), project(beta, 'Beta')]; directories.teams = []; directories.expansion = true; sessionStorage.clear(); });
/** Event checkboxes are bound to one project and appear only while that project is checked. */
const eventsOf = (projectName: string) => within(screen.getByRole('group', { name: `Event types for ${projectName}` }));
afterEach(() => { scopes.splice(0).forEach(scope => scope.dispose()); invalidateAuthRequests(); vi.unstubAllGlobals(); });

it('only offers self-subscription on public HTTPS origins and matches targets by origin and path', () => {
  expect(canSelfSubscribe(origin)).toBe(true);
  for (const value of ['http://daynight.example', 'https://localhost:8443', 'https://app.localhost', 'https://127.0.0.1', 'https://[::1]', 'not a url']) expect(canSelfSubscribe(value)).toBe(false);
  expect(targetsInbox(`${inboxUrl}?trace=1`, inboxUrl)).toBe(true);
  // The public route and its target check require the exact inbox path.
  expect(targetsInbox(`${inboxUrl}/`, inboxUrl)).toBe(false);
  expect(targetsInbox(`https://other.example/api/v1/assistant-task-inbox/${inboxId}`, inboxUrl)).toBe(false);
  expect(targetsInbox(`${origin}/api/v1/assistant-task-inbox/${botId(1)}`, inboxUrl)).toBe(false);
  expect(targetsInbox(null, inboxUrl)).toBe(false);
  expect(targetsInbox('::', inboxUrl)).toBe(false);
});

it('explains that a localhost deployment cannot subscribe its own inbox', () => {
  const s = server(); mount({ serviceOrigin: 'http://localhost:5173' });
  expect(screen.getByText(/cannot subscribe to events from this deployment/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Create subscription' })).toBeNull();
  expect(s.fetch).not.toHaveBeenCalled();
});

it('creates a personal endpoint targeting the token-free inbox URL', async () => {
  const s = server({ personal: [endpoint(otherId, 'https://receiver.example/hook', [])] }); mount();
  expect(await screen.findByText('No Webhook endpoint targets this inbox yet.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Select at least one project and at least one event type for each selected project.');
  expect(s.writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  expect(screen.getByRole('alert')).toHaveTextContent('at least one event type for each selected project');
  expect(s.writes).toHaveLength(0);
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task status changed' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Discussion message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'POST', path: '/api/v1/me/webhooks', body: {
    expectedUserId: BOT_USER, name: 'Assistant inbox · Release watcher', enabled: true,
    destination: { kind: 'http', adapterVersion: '1', configuration: { url: inboxUrl } },
    subscriptions: [{ id: null, projectId: beta, eventTypes: ['task.status_changed', 'task.thread_posted'] }],
  } });
  expect(JSON.stringify(s.writes[0]!.body)).not.toContain('dnib_');
  const list = await screen.findByRole('list');
  expect(within(list).getByText('Endpoint 80')).toBeVisible();
  expect(within(list).getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/webhooks?owner=personal&endpointId=${botId(80)}`);
  expect(screen.getByRole('button', { name: 'Save subscription' })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeChecked();
});

it('updates the linked personal endpoint and warns about Team endpoints targeting the inbox', async () => {
  directories.teams = [team];
  const linked = endpoint(personalId, `${inboxUrl}?source=daynight`, [{ id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created'], eligibility: 'eligible' }]);
  const s = server({ personal: [linked, endpoint(otherId, `${inboxUrl}/`, [])], team: [endpoint(teamEndpointId, inboxUrl, []), endpoint(botId(81), 'https://receiver.example/team', [])] }); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('A Team endpoint targets this inbox.');
  expect(screen.getByText(/Team · Ops · Enabled/)).toBeVisible();
  expect(screen.queryByText('Endpoint 81')).toBeNull();
  expect(screen.queryByText(`Endpoint ${otherId.slice(-2)}`)).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Alpha' })).toBeChecked();
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' })).toBeChecked();
  expect(screen.queryByRole('group', { name: 'Event types for Beta' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'PATCH', path: `/api/v1/me/webhooks/${personalId}`, body: { ifVersion: '4', subscriptions: [
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.created', 'task.paused'] },
    { id: null, projectId: beta, eventTypes: ['task.created', 'task.paused'] },
  ] } });
  expect(s.writes[0]!.body).not.toHaveProperty('enabled');
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
});

it('drops an endpoint whose detail no longer targets this inbox after its summary did', async () => {
  // Another tab retargets the endpoint to a different inbox between the list read and the detail read.
  const otherInbox = `${origin}/api/v1/assistant-task-inbox/${botId(82)}`;
  const retargeted = endpoint(personalId, otherInbox, [{ id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created'], eligibility: 'eligible' }]);
  const s = server({ personal: [retargeted] });
  const serve = s.fetch.getMockImplementation()!;
  s.fetch.mockImplementation(async (url, options) => String(url) === '/api/v1/me/webhooks?limit=100' && (options?.method ?? 'GET') === 'GET'
    ? botResponse({ items: [summary({ ...retargeted, destination: { ...retargeted.destination, url: inboxUrl, displayUrl: inboxUrl } })], nextCursor: null })
    : serve(url, options));
  mount();
  expect(await screen.findByText('No Webhook endpoint targets this inbox yet.')).toBeVisible();
  expect(screen.queryByText(`Endpoint ${personalId.slice(-2)}`)).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Alpha' })).not.toBeChecked();
  expect(screen.getByRole('button', { name: 'Create subscription' })).toBeEnabled();
  expect(s.writes).toHaveLength(0);
});

it('preserves per-project event selections and applies only the changed events', async () => {
  const linked = endpoint(personalId, inboxUrl, [
    { id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created'], eligibility: 'eligible' },
    { id: botId(84), projectId: beta, projectName: 'Beta', eventTypes: ['task.deleted'], eligibility: 'eligible' },
  ]);
  const s = server({ personal: [linked] }); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.created'] },
    { id: botId(84), projectId: beta, eventTypes: ['task.deleted'] },
  ]);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save subscription' })).toBeEnabled());
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task deleted' })).not.toBeChecked();
  expect(eventsOf('Beta').getByRole('checkbox', { name: 'Task deleted' })).toBeChecked();
  // A project still checked without events is not silently dropped from the replacement list.
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  expect(screen.getByRole('alert')).toHaveTextContent('at least one event type for each selected project');
  expect(s.writes).toHaveLength(1);
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]!.body.subscriptions).toEqual([
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.paused'] },
    { id: botId(84), projectId: beta, eventTypes: ['task.deleted', 'task.paused'] },
  ]);
});

it('keeps every independent subscription of a project when saving', async () => {
  const second = botId(85);
  const linked = endpoint(personalId, inboxUrl, [
    { id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created'], eligibility: 'eligible' },
    { id: second, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.deleted'], eligibility: 'eligible' },
  ]);
  const s = server({ personal: [linked] }); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Save subscription' }));
  expect(screen.getAllByRole('checkbox', { name: 'Alpha' })).toHaveLength(1);
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.created'] },
    { id: second, projectId: alpha, eventTypes: ['task.deleted'] },
  ]);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save subscription' })).toBeEnabled());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]!.body.subscriptions).toEqual([
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.created', 'task.paused'] },
    { id: second, projectId: alpha, eventTypes: ['task.deleted'] },
  ]);
});

it('keeps a draft bound to its starting endpoint version when a reload finds a concurrent change', async () => {
  const linked = endpoint(personalId, inboxUrl, [{ id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created'], eligibility: 'eligible' }]);
  const s = server({ personal: [linked] });
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const view = (active: boolean) => <TaskCacheProvider scope={scope}><AssistantTaskSubscriptions task={task} inboxId={inboxId} inboxEnabled active={active} serviceOrigin={origin} /></TaskCacheProvider>;
  const { rerender } = renderWithLocale(view(true), { locale: 'en' });
  await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  // The user leaves the Inbox tab while another browser tab adds a Beta subscription to the same endpoint.
  rerender(view(false));
  s.state.personal = [{ ...linked, configVersion: '5', subscriptions: [...linked.subscriptions, { id: botId(84), projectId: beta, projectName: 'Beta', eventTypes: ['task.deleted'], eligibility: 'eligible' }] }];
  rerender(view(true));
  expect(await screen.findByRole('alert')).toHaveTextContent('This subscription changed elsewhere');
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save subscription' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('button', { name: 'Save subscription' }).closest('form')!);
  expect(s.writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeChecked();
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' })).not.toBeChecked();
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'PATCH', body: { ifVersion: '5', subscriptions: [
    { id: subscriptionId, projectId: alpha, eventTypes: ['task.created', 'task.paused'] },
    { id: botId(84), projectId: beta, eventTypes: ['task.deleted', 'task.paused'] },
  ] } });
});

it('does not turn a create draft into an edit of an endpoint created elsewhere', async () => {
  const s = server();
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const view = (active: boolean) => <TaskCacheProvider scope={scope}><AssistantTaskSubscriptions task={task} inboxId={inboxId} inboxEnabled active={active} serviceOrigin={origin} /></TaskCacheProvider>;
  const { rerender } = renderWithLocale(view(true), { locale: 'en' });
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  rerender(view(false));
  s.state.personal = [endpoint(personalId, inboxUrl, [{ id: subscriptionId, projectId: beta, projectName: 'Beta', eventTypes: ['task.deleted'], eligibility: 'eligible' }])];
  rerender(view(true));
  expect(await screen.findByRole('alert')).toHaveTextContent('This subscription changed elsewhere');
  expect(screen.getByRole('button', { name: 'Create subscription' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('button', { name: 'Create subscription' }).closest('form')!);
  expect(s.writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
  expect(screen.getByRole('button', { name: 'Save subscription' })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeChecked();
});

it('adopts a created endpoint while the directory refresh fails', async () => {
  const s = server(); mount();
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  const original = s.fetch.getMockImplementation()!;
  // Reads start failing once the create is sent, after the pre-submit check of existing targets.
  let failing = false;
  s.fetch.mockImplementation(async (url, options) => {
    if ((options?.method ?? 'GET') === 'POST') failing = true;
    return failing && (options?.method ?? 'GET') === 'GET' && String(url).startsWith('/api/v1/me/webhooks') ? botError(500, 'internal') : original(url, options);
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  expect(await screen.findByText('Could not load Webhook subscriptions.')).toBeVisible();
  expect(s.writes).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Create subscription' })).toBeNull();
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]).toMatchObject({ method: 'PATCH', path: `/api/v1/me/webhooks/${botId(80)}`, body: { ifVersion: '1' } });
});

it('adopts a create confirmed by a manual operation check while the directory refresh fails', async () => {
  const s = server(); mount();
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  const original = s.fetch.getMockImplementation()!;
  let receipt: unknown = null, lookups = 0, directoryFails = false;
  s.fetch.mockImplementation(async (url, options) => {
    const path = String(url), method = options?.method ?? 'GET';
    if (method === 'POST') { directoryFails = true; receipt = (await (await original(url, options)).json() as { operation: unknown }).operation; throw new TypeError('Response lost'); }
    if (path.startsWith('/api/v1/me/webhooks/operations/')) return lookups++ === 0 ? botError(500, 'internal') : botResponse(receipt);
    if (directoryFails && path.startsWith('/api/v1/me/webhooks')) return botError(500, 'internal');
    return original(url, options);
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Check operation' }));
  expect(await screen.findByText('Could not load Webhook subscriptions.')).toBeVisible();
  expect(lookups).toBe(2);
  expect(screen.getByRole('button', { name: 'Create subscription' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('button', { name: 'Create subscription' }).closest('form')!);
  expect(s.writes).toHaveLength(1);
  directoryFails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  const save = await screen.findByRole('button', { name: 'Save subscription' });
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(save);
  await waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]).toMatchObject({ method: 'PATCH', path: `/api/v1/me/webhooks/${botId(80)}`, body: { ifVersion: '1' } });
});

it('releases a recovered create that belongs to another inbox without blocking this inbox', async () => {
  const s = server(); mount();
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  const original = s.fetch.getMockImplementation()!;
  let receipt: unknown = null, lookupFails = true;
  s.fetch.mockImplementation(async (url, options) => {
    const path = String(url), method = options?.method ?? 'GET';
    if (method === 'POST') { receipt = (await (await original(url, options)).json() as { operation: unknown }).operation; throw new TypeError('Response lost'); }
    if (path.startsWith('/api/v1/me/webhooks/operations/')) return lookupFails ? botError(500, 'internal') : botResponse(receipt);
    return original(url, options);
  });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  await screen.findByRole('button', { name: 'Check operation' });
  cleanup();
  lookupFails = false;
  const otherInbox = botId(81);
  mount({ inboxId: otherInbox });
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  fireEvent.click(await screen.findByRole('button', { name: 'Check operation' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Check operation' })).toBeNull());
  await waitFor(() => expect(s.fetch).toHaveBeenCalledWith(`/api/v1/me/webhooks/${botId(80)}`, expect.anything()));
  const create = await screen.findByRole('button', { name: 'Create subscription' });
  await waitFor(() => expect(create).toBeEnabled());
  expect(screen.getByText('No Webhook endpoint targets this inbox yet.')).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
  fireEvent.click(eventsOf('Beta').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(create);
  await waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]).toMatchObject({ method: 'POST', body: { destination: { configuration: { url: `${origin}/api/v1/assistant-task-inbox/${otherInbox}` } } } });
});

it('keeps edits rejected for a version conflict and blocks resubmission until they are discarded', async () => {
  const linked = endpoint(personalId, inboxUrl, [{ id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created'], eligibility: 'eligible' }]);
  const s = server({ personal: [linked] }); mount();
  await screen.findByRole('checkbox', { name: 'Alpha' });
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  // Another client changes the endpoint while this tab stays open; the panel does not reload before saving.
  s.state.personal = [{ ...linked, configVersion: '5', subscriptions: [...linked.subscriptions, { id: botId(84), projectId: beta, projectName: 'Beta', eventTypes: ['task.deleted'], eligibility: 'eligible' }] }];
  s.fetch.mockImplementationOnce(async () => botError(409, 'version_conflict'));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  expect(await screen.findByText(/This subscription changed elsewhere/)).toBeVisible();
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save subscription' })).toBeDisabled();
  const requests = s.fetch.mock.calls.length;
  fireEvent.submit(screen.getByRole('button', { name: 'Save subscription' }).closest('form')!);
  await Promise.resolve();
  expect(s.fetch.mock.calls.slice(requests).filter(([, options]) => (options?.method ?? 'GET') !== 'GET')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Beta' })).toBeChecked());
  expect(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'PATCH', body: { ifVersion: '5' } });
});

it('turns a create into a conflict when an endpoint for this inbox appeared after the directory was read', async () => {
  const s = server(); mount();
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  // A second tab created the endpoint without this panel reloading in between.
  s.state.personal = [endpoint(personalId, inboxUrl, [{ id: subscriptionId, projectId: beta, projectName: 'Beta', eventTypes: ['task.deleted'], eligibility: 'eligible' }])];
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  expect(await screen.findByText(/This subscription changed elsewhere/)).toBeVisible();
  expect(s.writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits' }));
  expect(await screen.findByRole('button', { name: 'Save subscription' })).toBeEnabled();
});

it('warns when several personal endpoints target the inbox', async () => {
  server({ personal: [endpoint(personalId, inboxUrl, []), endpoint(otherId, inboxUrl, [])] }); mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Several personal endpoints target this inbox');
});

it('releases a created endpoint once a refresh finds it deleted elsewhere', async () => {
  const s = server();
  const scope = createTaskCacheScope({ userId: BOT_USER, onIdentityMismatch: vi.fn() }); scopes.push(scope);
  const view = (active: boolean) => <TaskCacheProvider scope={scope}><AssistantTaskSubscriptions task={task} inboxId={inboxId} inboxEnabled active={active} serviceOrigin={origin} /></TaskCacheProvider>;
  const { rerender } = renderWithLocale(view(true), { locale: 'en' });
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  expect(await screen.findByText('Endpoint 80')).toBeVisible();
  rerender(view(false));
  s.state.personal = [];
  rerender(view(true));
  expect(await screen.findByText('No Webhook endpoint targets this inbox yet.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create subscription' })).toBeEnabled();
});

it('applies the catalog expansion gate before submitting while keeping removals available', async () => {
  directories.expansion = false;
  const linked = endpoint(personalId, inboxUrl, [
    { id: subscriptionId, projectId: alpha, projectName: 'Alpha', eventTypes: ['task.created', 'task.deleted'], eligibility: 'eligible' },
  ]);
  const s = server({ personal: [linked] }); mount();
  expect(await screen.findByText(/Webhook changes that add deliveries are temporarily unavailable/)).toBeVisible();
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  expect(s.writes).toHaveLength(0);
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task paused' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task deleted' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save subscription' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]!.body.subscriptions).toEqual([{ id: subscriptionId, projectId: alpha, eventTypes: ['task.created'] }]);
});

it('does not offer creation while the catalog blocks expansion', async () => {
  directories.expansion = false;
  const s = server(); mount();
  expect(await screen.findByRole('button', { name: 'Create subscription' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.submit(screen.getByRole('button', { name: 'Create subscription' }).closest('form')!);
  await Promise.resolve();
  expect(s.writes).toHaveLength(0);
});

it('prompts to pause or delete endpoints that still target a disabled inbox', async () => {
  const s = server({ personal: [endpoint(personalId, inboxUrl, []), endpoint(otherId, inboxUrl, [], false)] });
  mount({ inboxEnabled: false });
  expect(await screen.findByRole('alert')).toHaveTextContent('The inbox is disabled.');
  expect(screen.queryByRole('button', { name: /subscription/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(s.writes).toHaveLength(1));
  expect(s.writes[0]).toMatchObject({ method: 'PATCH', path: `/api/v1/me/webhooks/${personalId}`, body: { ifVersion: '4', enabled: false } });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull());
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]!);
  await waitFor(() => expect(s.writes).toHaveLength(2));
  expect(s.writes[1]!.method).toBe('DELETE');
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1));
});

it('lists endpoints aimed at any inbox of this site when the disabled inbox id is unknown', async () => {
  const elsewhere = `${origin}/api/v1/assistant-task-inbox/${botId(81)}/`;
  server({ personal: [endpoint(personalId, inboxUrl, []), endpoint(otherId, elsewhere, [], false), endpoint(botId(82), 'https://hooks.example/api/v1/assistant-task-inbox/x', [])], team: [endpoint(teamEndpointId, inboxUrl, [])] });
  directories.teams = [team];
  mount({ inboxId: null, inboxEnabled: false });
  expect(await screen.findByRole('alert')).toHaveTextContent('These personal endpoints target an assistant inbox on this site');
  const list = screen.getByRole('list');
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  // Without a verified inbox id these may be other tasks' working endpoints; they are only opened, never acted on here.
  expect(within(list).queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(within(list).queryByRole('button', { name: 'Pause' })).toBeNull();
  expect(within(list).getAllByRole('link', { name: 'Open' })).toHaveLength(2);
  expect(within(list).getByText(elsewhere)).toBeVisible();
  expect(within(list).getByText(inboxUrl)).toBeVisible();
  expect(screen.queryByText(/Team endpoint/)).toBeNull();
  expect(targetsAnyInbox(elsewhere, origin)).toBe(true);
  expect(targetsAnyInbox(`${origin}/api/v1/assistant-task-inbox/`, origin)).toBe(false);
  expect(targetsAnyInbox('not a url', origin)).toBe(false);
  expect(targetsAnyInbox(null, origin)).toBe(false);
});

it('renders nothing for a disabled inbox with an unknown id and no endpoint to clean up', async () => {
  const s = server({ personal: [endpoint(personalId, 'https://hooks.example/receive', [])] });
  mount({ inboxId: null, inboxEnabled: false });
  await waitFor(() => expect(s.fetch).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.queryByRole('heading', { name: 'Daynight event subscription' })).toBeNull();
});

it('renders nothing before an inbox has ever been enabled while it is still enabled without an id', () => {
  mount({ inboxId: null, inboxEnabled: true });
  expect(screen.queryByRole('heading', { name: 'Daynight event subscription' })).toBeNull();
});

it('shows a rejected Webhook change and a failed directory read with retry', async () => {
  const s = server(); mount();
  await screen.findByText('No Webhook endpoint targets this inbox yet.');
  s.fetch.mockImplementationOnce(async () => botError(422, 'invalid_destination'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
  fireEvent.click(eventsOf('Alpha').getByRole('checkbox', { name: 'Task created' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create subscription' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The Webhook request failed. invalid_destination');
  expect(screen.getByRole('checkbox', { name: 'Alpha' })).toBeChecked();
});

it('retries a failed subscription read', async () => {
  const s = server();
  s.fetch.mockImplementationOnce(async () => botError(500, 'internal'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Webhook subscriptions.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('No Webhook endpoint targets this inbox yet.')).toBeVisible();
});
