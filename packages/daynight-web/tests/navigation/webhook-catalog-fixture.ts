import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import { botAttentionHeaders, botDefaults } from '../helpers/bots';
import { webhookCatalog } from '../helpers/webhooks';
import { id, now, userId } from './webhook-select-fixture';

export const projectId = id(4), taskId = id(70), inboxId = id(71), normalId = id(20), inboxEndpointId = id(21);
const personalId = id(10), owner = { kind: 'personal', id: userId }, inboxKey = `assistant-task-inbox:${inboxId}`;
type Subscription = { id: string | null; projectId: string; eventTypes: string[] };
const subscription = (events: string[]) => ({ id: id(7), projectId, projectName: 'Alpha', eventTypes: events, eligibility: 'eligible' });
const endpoint = (endpointId: string, inbox: boolean, events: string[]) => ({
  id: endpointId, owner, clientKey: inbox ? inboxKey : null, lifecycle: 'active', configVersion: '1', deletedAt: null,
  name: inbox ? 'Inbox receiver' : 'Ordinary receiver', enabled: true, destinationRevision: '1',
  destination: { kind: 'http', adapterVersion: '1', url: 'https://receiver.example/hook', displayUrl: 'https://receiver.example/hook' },
  signing: { scheme: 'standard-webhooks-v1', activeKeyId: id(6), overlapUntil: null },
  subscriptions: [subscription(events)], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now,
});

export async function installCatalog(page: Page, includeSteps: boolean, existingInbox = true) {
  let endpoints = [endpoint(normalId, false, ['task.created']), ...(existingInbox ? [endpoint(inboxEndpointId, true, ['task.created'])] : [])];
  const writes: { method: string; path: string; body: Record<string, unknown> }[] = [], unexpected: string[] = [];
  const task = { id: taskId, ownerUserId: userId, name: 'Catalog watcher', purpose: '', scope: '', application: '', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null, version: '3', manualVersion: '1', claimGeneration: '0', claimState: 'unowned', holderBotId: null, credentialOperationId: null, claimedAt: null, renewedAt: null, leaseUntil: null, observedAt: now, createdAt: now, updatedAt: now };
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': userId, ...botAttentionHeaders(request.headers(), status) } });
    const paged = (items: unknown[]) => ({ items, nextCursor: null, observedAt: now });
    if (request.method() !== 'GET') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: request.method(), path, body });
      const create = request.method() === 'POST', endpointId = create ? id(100 + writes.length) : path.split('/').at(-1)!;
      const before = endpoints.find(item => item.id === endpointId);
      const after = create ? { ...endpoint(endpointId, body.clientKey === inboxKey, []), name: String(body.name), clientKey: typeof body.clientKey === 'string' ? body.clientKey : null } : { ...before!, configVersion: String(Number(before!.configVersion) + 1) };
      if (body.subscriptions !== undefined) after.subscriptions = (body.subscriptions as Subscription[]).map((item, index) => ({ ...item, id: item.id ?? id(200 + index), projectName: 'Alpha', eligibility: 'eligible' }));
      endpoints = [...endpoints.filter(item => item.id !== endpointId), after];
      const operation = { operationId: body.operationId, kind: create ? 'endpoint.create' : 'endpoint.patch', issuedAt: body.issuedAt, requestSha256: createHash('sha256').update(request.postData()!).digest('hex'), actorUserId: userId, owner, endpointId, effect: 'applied', configVersionAfter: after.configVersion, destinationRevisionAfter: '1', deliveryId: null, generationAfter: null, keyId: null, overlapUntil: null, recordedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() };
      return send({ operation, endpoint: after }, create ? 201 : 200);
    }
    if (path === '/api/v1/me') return send({ id: userId, name: 'Alice', email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: personalId, kind: 'personal', name: null } });
    if (path === '/api/v1/auth/providers') return send({ providers: ['github'] });
    if (path === '/api/v1/webhook-event-types') return send(webhookCatalog(includeSteps));
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/projects') return send({ items: [{ id: projectId, name: 'Alpha', ownership: { teamId: personalId, version: 1 }, repoUrl: 'https://example.test/repo.git', settings: { version: 1, executionWarningMinutes: 60 }, createdAt: now, updatedAt: now }], nextCursor: null });
    if (path === '/api/v1/me/webhooks') {
      const key = url.searchParams.get('clientKey');
      return send({ items: endpoints.filter(item => key === null || item.clientKey === key).map(item => ({ id: item.id, owner, clientKey: item.clientKey, name: item.name, enabled: item.enabled, configVersion: item.configVersion, destination: item.destination, projectCount: item.subscriptions.length, eventTypeCount: new Set(item.subscriptions.flatMap(sub => sub.eventTypes)).size, lastAttemptAt: null, lastResult: null })), nextCursor: null });
    }
    const found = endpoints.find(item => path === `/api/v1/me/webhooks/${item.id}`);
    if (found) return send(found);
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/assistant-tasks') return send(paged([task]));
    if (path === `/api/v1/assistant-tasks/${taskId}`) return send(task);
    if (path === `/api/v1/assistant-tasks/${taskId}/inbox`) return send({ inboxId, enabled: true, createdAt: now, rotatedAt: null, overlapUntil: null, suppressedCount: '0' });
    if (path.endsWith('/manual')) return send({ taskId, version: '1', body: 'Observe events.', rules: [], source: 'initial', proposalId: null, createdAt: now });
    if (['/manual/versions', '/proposals', '/items', '/records', '/appendix', '/events'].some(suffix => path.endsWith(suffix)) || path === '/api/v1/assistant-task-events') return send(paged([]));
    unexpected.push(`${request.method()} ${path}`);
    return send({ error: { code: 'not_found', message: 'Unexpected fixture request', requestId: 'catalog-fixture' } }, 404);
  });
  return { writes, unexpected };
}
