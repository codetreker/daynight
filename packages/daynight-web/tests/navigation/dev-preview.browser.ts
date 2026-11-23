import { expect, test } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const goalId = '00000000-0000-4000-8000-000000000042';
const personalId = '00000000-0000-4000-8000-000000000701';
const time = '2026-10-22T10:00:00Z';

test('ordinary Vite entry renders Task and Goal attachments with their own origins', async ({ page }) => {
  const task = detailFixture(projectId, taskId, { title: 'Development Task', description: '[Task file](index.html)' });
  const goal = detailFixture(projectId, goalId, { type: 'goal', title: 'Development Goal', description: '[Goal file](index.html)', ready: false });
  const graph = graphFixture([task, goal]);
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, ...extra } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}`) return send(graph.project);
    if (path === `/api/v1/projects/${projectId}/access`) return send(directAccessFixture(projectId));
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { query: taskSyncQuery(url), versionForTask: () => 1n, propertiesForTask: () => ({ pullRequests: [] }) }));
    const detail = [task, goal].find(item => path === `/api/v1/projects/${projectId}/tasks/${item.id}`);
    if (detail !== undefined) return send(detail, 200, { 'Daynight-Task-Epoch': taskSyncEpoch(projectId) });
    if (path.endsWith('/attachments') || path.endsWith('/sessions')) return send({ items: [], nextCursor: null });
    if (path.endsWith('/thread/messages')) return send({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'fixture' } }, 404);
  });
  for (const [id, label] of [[taskId, 'Task file'], [goalId, 'Goal file']] as const) {
    await page.goto(`/projects/${projectId}/tasks/${id}`);
    await expect(page.getByRole('link', { name: label })).toHaveAttribute('href', `http://${id}.preview.daynight.localhost:8787/api/v1/projects/${projectId}/tasks/${id}/preview/index.html`);
  }
});
