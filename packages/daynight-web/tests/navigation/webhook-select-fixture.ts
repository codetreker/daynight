import type { Page } from '@playwright/test';

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const userId = id(1), teamId = id(2), now = '2026-11-08T00:00:00Z';
const user = { id: userId, name: 'Alice', email: null, emailVerified: null, avatarUrl: null, personalTeam: { id: id(10), kind: 'personal', name: null } };
const catalog = {
  items: ['task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted'].map(key => ({ key, wireType: `cc.daynight.${key}.v1`, schemaVersion: 1, resourceKind: 'project' })),
  service: { configurationExpansionAvailable: true, dispatchEnabled: false },
  limits: { policyVersion: '1', requestBytes: 262144, payloadBytes: 65536, maxAutomaticAttempts: 8, automaticWindowSeconds: 86400, maxManualOperations: 3, payloadRetentionSeconds: 2592000, operationMaxAgeSeconds: 300, operationFutureSkewSeconds: 60 },
};

export async function install(page: Page, locale: 'en' | 'zh-CN') {
  const requests: { owner: string; query: string; enabled: string | null; cursor: string | null }[] = [];
  const unexpected: string[] = [];
  const deliveryQueries: string[] = [];
  await page.addInitScript(value => localStorage.setItem('daynight.web.locale', value), locale);
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let body: unknown;
    if (path === '/api/v1/me') body = user;
    else if (path === '/api/v1/auth/providers') body = { providers: ['github'] };
    else if (path === '/api/v1/webhook-event-types') body = catalog;
    else if (path === '/api/v1/teams') body = { items: [{ id: teamId, kind: 'ordinary', name: 'A very long engineering team name used to exercise the selector', version: 1, createdAt: now, updatedAt: now, membership: { teamId, userId, role: 'admin', version: 1, createdAt: now, updatedAt: now } }], nextCursor: null };
    else if (path === '/api/v1/projects') body = { items: [id(4)].map(project => ({ id: project, name: 'A very long project name used to exercise the selection field', ownership: { teamId, version: 1 }, repoUrl: 'https://example.test/repo.git', settings: { version: 1, executionWarningMinutes: 60 }, createdAt: now, updatedAt: now })), nextCursor: null };
    else if (path === '/api/v1/me/webhooks' || path === `/api/v1/teams/${teamId}/webhooks`) {
      const owner = path.includes('/teams/') ? 'team' : 'personal';
      const q = url.searchParams.get('q') ?? '', enabled = url.searchParams.get('enabled'), cursor = url.searchParams.get('cursor');
      requests.push({ owner, query: q, enabled, cursor });
      const values = [true, false, true].map((active, i) => ({ id: id(i + 20), owner: { kind: owner, id: owner === 'team' ? teamId : userId }, name: `Long receiver endpoint ${i} for search and layout`, enabled: active, configVersion: '1', destination: { kind: 'http', adapterVersion: '1', url: null, displayUrl: `https://receiver.example/very/long/path/${i}` }, projectCount: 1, eventTypeCount: 1, lastAttemptAt: null, lastResult: null }))
        .filter(item => (q === '' || item.name.includes(q) || item.destination.displayUrl.includes(q)) && (enabled === null || String(item.enabled) === enabled));
      const start = Number(cursor ?? 0);
      body = { items: values.slice(start, start + 2), nextCursor: start + 2 < values.length ? String(start + 2) : null };
    } else if (path.endsWith('/deliveries')) {
      deliveryQueries.push(url.search);
      body = { items: [], nextCursor: null, historyMayBeIncomplete: true, retention: { payloadRetentionSeconds: 604800, metadataRetentionSeconds: 2592000 } };
    } else if (/^\/api\/v1\/(?:me|teams\/[^/]+)\/webhooks\/[^/]+$/.test(path)) {
      const owner = path.includes('/teams/') ? { kind: 'team', id: teamId } : { kind: 'personal', id: userId };
      body = { id: path.split('/').at(-1), owner, lifecycle: 'active', configVersion: '1', deletedAt: null, name: 'Long receiver endpoint 0 for search and layout', enabled: true, destinationRevision: '1', destination: { kind: 'http', adapterVersion: '1', url: 'https://receiver.example/very/long/path/0', displayUrl: 'https://receiver.example/very/long/path/0' }, signing: { scheme: 'standard-webhooks-v1', activeKeyId: id(6), overlapUntil: null }, subscriptions: [{ id: id(7), projectId: id(3), projectName: 'Project one', eventTypes: ['task.created'], eligibility: 'eligible' }], capabilities: { manage: true, readSecret: true, redeliver: true }, createdAt: now, updatedAt: now };
    } else { unexpected.push(`${request.method()} ${path}`); body = {}; }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Daynight-User-ID': userId }, body: JSON.stringify(body) });
  });
  return { requests, deliveryQueries, unexpected };
}
