import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { personalTeamPage } from '../helpers/team';
import { directAccessFixture, fixtureTaskEpoch, taskSyncFixture, taskSyncQuery, TEST_VIEWER_ID } from '../helpers/taskSync';
import type { TaskSessionSnapshot } from '../helpers/session';
import { stringifyWireJson } from '../helpers/wireJson';

const source: TaskSessionSnapshot = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const projectId = source.identity.projectId, taskId = source.identity.taskId;
const deleting = '00000000-0000-4000-8000-000000000003';
const teamId = '00000000-0000-4000-8000-000000000701';
const personal = { id: teamId, kind: 'personal', name: null };
const time = '2026-10-22T10:00:00Z';
const root = `/api/v1/projects/${projectId}/tasks/${taskId}`;

test('a collapsed deletion result reserves space for the task Session composer', async ({ page }) => {
  const pending = Promise.withResolvers<void>(); let dispatched = false;
  const snapshot: TaskSessionSnapshot = { ...source, lastEventSeq: '0', lastTimelineSeq: '0', lifecycle: 'active', activity: 'idle', connectionState: 'connected', currentTurnId: null,
    operations: { canSend: true, canCancel: false, canRespond: false } };
  const worker = { claimId: source.claimId, state: 'active', userId: TEST_VIEWER_ID, workerId: source.identity.workerId,
    machine: { id: source.identity.controllerId, name: 'Worker' }, platform: 'macos', agent: 'codex', agentControlMode: 'web', worktreeId: source.identity.worktreeId,
    phase: 'executing', herdr: null, nativeSessionId: 'native-thread', claimedAt: time };
  const detail = detailFixture(projectId, taskId, { title: 'Other task', status: 'in_progress', ready: false, properties: { worker } });
  const graph = graphFixture([detail]);
  const deletedProject = { id: deleting, name: 'Project', repoUrl: 'https://example.com/repo', createdAt: time, updatedAt: time,
    ownership: { teamId, version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 } };
  const access = (id: string) => ({ ...directAccessFixture(id, TEST_VIEWER_ID, 'admin'), teamRole: 'admin' as const, canTransfer: true });
  await page.routeWebSocket('**/channel*', socket => socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: TEST_VIEWER_ID, snapshot, cursor: 'zero' })));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams') return send(personalTeamPage(TEST_VIEWER_ID));
    if (path === `/api/v1/teams/${teamId}`) return send(personalTeamPage(TEST_VIEWER_ID).items[0]);
    if (path === '/api/v1/projects') return send({ items: [deletedProject], nextCursor: null });
    if (path === `/api/v1/projects/${deleting}` && request.method() === 'DELETE') { dispatched = true; await pending.promise; return route.abort('failed'); }
    if (path === `/api/v1/projects/${deleting}`) return send(deletedProject);
    if (path === `/api/v1/projects/${deleting}/access`) return send(access(deleting));
    if (path === `/api/v1/projects/${deleting}/deletion-preview`) return send({ observedAt: time, project: { id: deleting, name: 'Project', repoUrl: deletedProject.repoUrl, ownerTeam: personal }, summary: { taskCount: 0, unfinishedTaskCount: 0, attachmentCount: 0 }, activeClaims: [], nextCursor: null });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { actorAccess: access(projectId), query: taskSyncQuery(url), versionForTask: () => detail.version, propertiesForTask: () => detail.properties }));
    if (path === `/api/v1/projects/${projectId}/access`) return send(access(projectId));
    if (path === root) return route.fulfill({ status: 200, body: stringifyWireJson(detail), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID, 'Daynight-Task-Epoch': fixtureTaskEpoch(projectId) } });
    if (path === `${root}/sessions/current`) return send({ status: 'registered', session: snapshot });
    if (path === `${root}/steps`) return send({ projectId, taskId, version: detail.version, steps: [] });
    if (path === `${root}/sessions/${snapshot.sessionId}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (path === `${root}/sessions` || path.endsWith('/attachments')) return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'missing' } }, 404);
  });
  await page.goto(`/projects/${deleting}/settings`);
  await page.getByRole('button', { name: 'Delete project', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete this project?' });
  await dialog.getByLabel('Enter the project name to confirm').fill('Project');
  await dialog.getByRole('button', { name: 'Confirm deletion' }).click();
  await expect.poll(() => dispatched).toBe(true);
  await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, `/projects/${projectId}/tasks/${taskId}?tab=session`);
  await expect(page.locator('.session-composer textarea')).toBeVisible();
  pending.resolve();
  await expect(page.getByText(/project deletion result is unknown/i)).toBeVisible();
  const toggle = page.locator('.standalone-deletion-toggle');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const assertSpace = async () => {
    const result = await page.evaluate(() => {
      const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
      const composer = rect('.session-composer'), slot = rect('.standalone-deletion-slot'), button = rect('.standalone-deletion-toggle');
      return { composer, slot, button, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(result.composer.bottom).toBeLessThanOrEqual(result.slot.top + 1);
    expect(result.button.right).toBeLessThanOrEqual(result.width);
    expect(result.button.bottom).toBeLessThanOrEqual(result.height);
    expect(result.overflow).toBe(false);
    await expect(page.locator('.session-composer textarea')).toBeEnabled();
  };
  for (const width of [320, 375, 768]) { await page.setViewportSize({ width, height: 720 }); await assertSpace(); }
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await assertSpace();
  await page.locator('.session-fullscreen-toggle').click();
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'true');
  await assertSpace();
  await page.getByRole('button', { name: 'Show deletion results' }).focus();
  await page.keyboard.press('Enter'); await expect(page.getByText(/project deletion result is unknown/i)).toBeVisible();
  const lastResult = page.getByRole('link', { name: 'Return to projects' });
  await lastResult.focus(); await page.keyboard.press('Tab');
  expect(await page.locator('.task-agent-session').evaluate(root => root.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab'); await expect(lastResult).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.session-fullscreen-toggle')).toBeFocused();
  await page.getByRole('tab', { name: 'Steps' }).click();
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill('Other task draft');
  await lastResult.click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await expect(page.locator('.standalone-deletion-slot')).toHaveAttribute('inert');
  await confirmation.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.standalone-deletion-slot')).not.toHaveAttribute('inert');
  await expect(lastResult).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue('Other task draft');
});
