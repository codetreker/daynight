import { expect, test, type Page } from '@playwright/test';
import { detailFixture, graphFixture } from '../helpers/taskDetail';
import { directAccessFixture, taskSyncFixture, taskSyncQuery, TEST_PROFILE_VERSION, TEST_VIEWER_ID } from '../helpers/taskSync';
import { stringifyWireJson } from '../helpers/wireJson';

const projectId = '00000000-0000-4000-8000-000000000031';
const taskId = '00000000-0000-4000-8000-000000000041';
const personalId = '00000000-0000-4000-8000-000000000011';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-20T09:00:00Z';
const ownerName = 'Claim owner '.repeat(16) + 'complete';
const account = `${'account'.repeat(24)}@example.com`;
const machine = 'Machine-'.repeat(24) + 'complete';
const description = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}: the reading panel remains accessible.`).join('\n\n');
const content = '# Claim reader\n\n' + 'The attachment remains readable.\n\n'.repeat(60);

async function install(page: Page, state: 'active' | 'released') {
  const worker = { claimId: id(2), state, userId: TEST_VIEWER_ID, workerId: id(4), machine: { id: id(5), name: machine }, platform: 'linux', agent: 'codex', agentControlMode: 'herdr', worktreeId: id(6), phase: 'executing', herdr: null, nativeSessionId: null, claimedAt: time };
  const task = detailFixture(projectId, taskId, { title: 'Claim reading allocation', description, version: 5n, status: state === 'active' ? 'in_progress' : 'todo', ready: state !== 'active', startedAt: time, allowAgents: true, assignedTo: TEST_VIEWER_ID, properties: { worker } });
  const graph = graphFixture([task]), access = directAccessFixture(projectId, TEST_VIEWER_ID, 'admin');
  const writes: string[] = [];
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'en'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${path}`);
    const send = (body: unknown, status = 200) => route.fulfill({ status, body: stringifyWireJson(body), headers: { 'Content-Type': 'application/json', 'Daynight-User-ID': TEST_VIEWER_ID } });
    const base = `/api/v1/projects/${projectId}/tasks/${taskId}`;
    if (path === '/api/v1/me') return send({ id: TEST_VIEWER_ID, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/projects') return send({ items: [graph.project], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { teamId: personalId, userId: TEST_VIEWER_ID, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
    if (path === `/api/v1/projects/${projectId}/access`) return send(access);
    if (path === `/api/v1/projects/${projectId}/members`) return send({ actorAccess: access, items: [{ inheritedFrom: null, userId: TEST_VIEWER_ID, profile: { name: ownerName, email: account, avatarUrl: null }, effectiveRole: 'admin', directGrant: access.directGrant }] });
    if (path === `/api/v1/projects/${projectId}/task-assignees`) return send({ items: [{ userId: TEST_VIEWER_ID, name: ownerName, avatarUrl: null, version: TEST_PROFILE_VERSION, hasProjectAccess: true }], unresolvedUserIds: [] });
    if (path === `/api/v1/projects/${projectId}/task-sync`) return send(taskSyncFixture(graph, { actorAccess: access, query: taskSyncQuery(url), versionForTask: () => task.version, propertiesForTask: () => task.properties }));
    if (path === base) return send(task);
    if (path === `${base}/attachments`) return send({ items: [{ path: 'guide.md', contentType: 'text/markdown', sizeBytes: content.length, createdAt: time, updatedAt: time }], nextCursor: null });
    if (path === `${base}/attachments/files/guide.md`) return route.fulfill({ body: content, headers: { 'Content-Type': 'text/markdown', 'Daynight-User-ID': TEST_VIEWER_ID } });
    if (path === `${base}/sessions`) return send({ items: [], nextCursor: null });
    if (path === `${base}/sessions/current`) return send({ status: 'not_registered', claimId: worker.claimId, agentControlMode: 'herdr' });
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  return writes;
}

for (const state of ['active', 'released'] as const) for (const mode of ['dialog', 'page'] as const) {
  test(`${state} claim retains readable content at 320x240 in ${mode}`, async ({ page }) => {
    const writes = await install(page, state);
    if (mode === 'page') await page.goto(`/projects/${projectId}/tasks/${taskId}`);
    else {
      await page.goto(`/projects/${projectId}`);
      await page.locator('#project-section-tab-tasks').click();
      await page.getByRole('tab', { name: 'Standalone tasks', exact: true }).click();
      await page.locator(`#standalone-task-${taskId}`).click();
    }
    const root = page.locator(mode === 'page' ? '.task-detail-page' : '.task-detail-dialog');
    const heading = root.getByRole('region', { name: 'Task settings and claim', exact: true });
    await expect(heading.locator('.task-claim-owner strong')).toHaveText(ownerName);
    await expect(heading.locator('.task-claim-account')).toHaveText(account);
    await expect(heading.locator('.task-claim-execution > span').first()).toContainText(machine);
    await page.setViewportSize({ width: 320, height: 240 });
    for (const fullscreen of [false, true]) {
      if (fullscreen) await root.locator('.task-detail-fullscreen-toggle').click();
      await root.getByRole('tab', { name: 'Overview', exact: true }).click();
      const overview = root.locator('.task-detail-panel-overview');
      expect(await overview.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(32);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const selector of ['.task-claim-owner strong', '.task-claim-account', '.task-claim-execution > span:first-child']) for (const edge of ['start', 'end'] as const) {
        expect(await heading.evaluate((region, args) => {
          const element = region.querySelector(args.selector)!; const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const texts: Node[] = []; let node: Node | null;
          while ((node = walker.nextNode()) !== null) if (node.textContent!.trim() && !node.parentElement!.closest('.task-claim-label')) texts.push(node);
          const text = args.edge === 'start' ? texts[0]! : texts.at(-1)!; const length = text.textContent!.length; const range = document.createRange();
          range.setStart(text, args.edge === 'start' ? 0 : length - 1); range.setEnd(text, args.edge === 'start' ? 1 : length);
          let bounds = range.getBoundingClientRect(); let viewport = region.getBoundingClientRect();
          region.scrollTop += args.edge === 'start' ? bounds.top - viewport.top - 4 : bounds.bottom - viewport.bottom + 4;
          bounds = range.getBoundingClientRect(); viewport = region.getBoundingClientRect();
          return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
        }, { selector, edge }), `${selector} ${edge}`).toBe(true);
      }
      const withdraw = heading.getByRole('button', { name: 'Force withdraw', exact: true });
      await root.getByRole('tab', { name: 'Overview', exact: true }).focus();
      await heading.evaluate(element => { element.scrollTop = 0; });
      await page.keyboard.press('Shift+Tab'); await expect(withdraw).toBeFocused();
      expect(await withdraw.evaluate(element => { const bounds = element.getBoundingClientRect(), region = element.closest('.task-detail-heading')!.getBoundingClientRect(); return bounds.top >= region.top - 1 && bounds.bottom <= region.bottom + 1; })).toBe(true);
      await overview.evaluate(element => { element.scrollTop = element.scrollHeight; });
      expect(await overview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await root.getByRole('tab', { name: 'Attachments', exact: true }).click();
      await root.getByRole('button', { name: /^guide\.md/ }).click();
      const preview = root.locator('.attachment-preview-body');
      await expect(preview.locator('.attachment-markdown')).toContainText('The attachment remains readable.');
      expect(await preview.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(18);
      await preview.evaluate(element => { element.scrollTop = element.scrollHeight; });
      expect(await preview.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      if (fullscreen) await root.locator('.task-detail-fullscreen-toggle').click();
    }
    expect(writes).toEqual([]);
  });
}
